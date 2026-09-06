/*
 * historian.js — process + discrete historian semantics on MongoDB time-series.
 *
 * What separates a historian from a table of numbers, and what this implements:
 *
 *  1. QUALITY ON EVERY SAMPLE. OPC UA status codes (Good 0 / Uncertain 0x40000000 / Bad 0x80000000).
 *     Bad samples are STORED — losing them hides comms failures — but are excluded from aggregates.
 *     A historian that silently drops bad data cannot answer "was this reading trustworthy".
 *
 *  2. TWO TIMESTAMPS. `ts` is the source (device) time and drives the time-series index; `rt` is
 *     receive time. The difference is late arrival, which is real: store-and-forward buffers on a
 *     gateway replay hours-old samples after a WAN outage, out of order.
 *
 *  3. TYPED VALUES. Process data is float; discrete is bool/int; batch context is string; state
 *     machines are enum. One column per storage class (`v`/`vb`/`vs`) rather than coercing
 *     everything to double, because "Running=1" and "Speed=1.0" are not the same kind of fact.
 *
 *  4. INTERPOLATION MODE PER TAG. Continuous tags interpolate linearly between samples; discrete
 *     tags are STEP functions and holding the previous value is the only correct reading. Applying
 *     linear interpolation to a state signal invents states that never happened.
 *
 *  5. TIME-WEIGHTED AGGREGATES. Historian samples are irregular (exception-based), so a plain
 *     arithmetic mean over-weights whatever happened to be sampled often. Continuous tags get a
 *     time-weighted average; discrete tags get state DURATIONS and transition counts, which is the
 *     question actually asked of them ("how long was it running?").
 *
 *  6. A TAG MASTER. Units, ranges, deadband, scan rate, interpolation and digital-state maps are
 *     properties of the tag, not of each sample.
 *
 *  7. EXCEPTION / DEADBAND REPORTING. Real historians store on change beyond a deadband, not every
 *     scan. Deadband config lives on the tag; the collector honours it.
 */
'use strict';

/* OPC UA status code families — the values a real collector reports. */
const Q = {
  GOOD: 0,
  UNCERTAIN: 0x40000000,
  UNCERTAIN_LAST_USABLE: 0x40900000,   /* stale: device stopped updating */
  UNCERTAIN_SENSOR_CAL: 0x40930000,    /* sensor out of calibration */
  BAD: 0x80000000,
  BAD_NOT_CONNECTED: 0x808A0000,       /* comms loss */
  BAD_DEVICE_FAILURE: 0x808B0000,
  BAD_OUT_OF_RANGE: 0x803C0000
};
/* Numeric thresholds rather than bitmasks: status codes arrive over GraphQL as Float, and Mongo's
   $bitAnd rejects doubles outright ("only supports int and long operands"). The OPC UA severity
   field is the top two bits, so >= 0x80000000 is Bad and >= 0x40000000 is Uncertain — a plain
   comparison expresses that exactly and survives the type round-trip. */
const BAD_FLOOR = 0x80000000;        /* 2147483648 */
const UNCERTAIN_FLOOR = 0x40000000;  /* 1073741824 */
const isGood = q => (q === undefined || q === null) ? true : q < UNCERTAIN_FLOOR;
const isBad = q => (q || 0) >= BAD_FLOOR;

const TAG_TYPES = ['PROCESS', 'DISCRETE', 'STRING', 'ENUM', 'COUNTER'];
const INTERPOLATION = { PROCESS: 'CONTINUOUS', COUNTER: 'CONTINUOUS', DISCRETE: 'STEPPED', ENUM: 'STEPPED', STRING: 'STEPPED' };

/* ── collections ─────────────────────────────────────────────────────────────────────────── */
async function ensure(db, TS, MASTER, AGG) {
  const existing = await db.listCollections({ name: TS }).toArray();
  let tsStatus;
  if (!existing.length) {
    await db.createCollection(TS, {
      timeseries: { timeField: 'ts', metaField: 'meta', granularity: 'seconds' },
      expireAfterSeconds: 60 * 60 * 24 * 365
    });
    tsStatus = 'created (timeseries, 365d)';
  } else {
    tsStatus = existing[0].type === 'timeseries' ? 'exists (timeseries)' : 'exists (WRONG TYPE)';
  }
  await db.collection(MASTER).createIndex({ tagPath: 1 }, { unique: true });
  await db.collection(AGG).createIndex({ pickedUpAt: 1, windowStart: 1 });
  await db.collection(AGG).createIndex({ tagPath: 1, windowStart: 1 });
  return tsStatus;
}

/* ── writes ──────────────────────────────────────────────────────────────────────────────── */
/* Samples carry their own quality and source timestamp. `rt` is stamped here because receive time
   is a property of ingestion, never of the device. */
function toDocs(payload) {
  const rt = new Date();
  return payload.map(p => {
    const meta = { tagPath: p.tagPath, tagType: p.tagType || 'PROCESS' };
    /* force integer: GraphQL Float would otherwise persist a double and make the field
       type-unstable between writers */
    const doc = { ts: new Date(p.occurredAt), rt: rt, meta: meta,
                  q: Math.round(p.quality == null ? Q.GOOD : p.quality) };
    if (p.valueString !== undefined && p.valueString !== null) { doc.vs = p.valueString; }
    else if (p.valueBool !== undefined && p.valueBool !== null) { doc.vb = p.valueBool; doc.v = p.valueBool ? 1 : 0; }
    else { doc.v = p.v; }
    if (p.seq != null) { doc.seq = p.seq; }
    return doc;
  });
}

/* ── reads ───────────────────────────────────────────────────────────────────────────────── */
/* Raw window, optionally including bad quality. A historian shows you the bad samples when you ask
   for raw data — that is how you diagnose an outage. */
async function raw(db, TS, { tagPath, fromIso, toIso, includeBad, limit }) {
  const q = { 'meta.tagPath': tagPath };
  if (fromIso || toIso) {
    q.ts = {};
    if (fromIso) { q.ts.$gte = new Date(fromIso); }
    if (toIso) { q.ts.$lt = new Date(toIso); }
  }
  if (!includeBad) { q.q = { $lt: BAD_FLOOR }; }
  const docs = await db.collection(TS).find(q).sort({ ts: 1 }).limit(limit || 1000).toArray();
  return docs.map(d => ({
    tagPath: d.meta.tagPath, tagType: d.meta.tagType,
    v: d.v == null ? null : d.v, valueBool: d.vb == null ? null : d.vb, valueString: d.vs || null,
    quality: d.q, qualityGood: isGood(d.q),
    occurredAt: d.ts.toISOString(), receivedAt: d.rt ? d.rt.toISOString() : null,
    latencyMs: d.rt ? (d.rt.getTime() - d.ts.getTime()) : null
  }));
}

/* Value AT a point in time — the single most-used historian read, and the one where interpolation
   mode matters. STEPPED holds the last good value; CONTINUOUS interpolates between neighbours. */
async function atTime(db, TS, MASTER, { tagPath, atIso }) {
  const at = new Date(atIso);
  const master = await db.collection(MASTER).findOne({ tagPath });
  const mode = (master && master.interpolation) || 'STEPPED';
  const before = await db.collection(TS).find({ 'meta.tagPath': tagPath, ts: { $lte: at }, q: { $lt: BAD_FLOOR } })
    .sort({ ts: -1 }).limit(1).toArray();
  if (!before.length) { return null; }
  if (mode === 'STEPPED') {
    const b = before[0];
    return { tagPath, v: b.v, valueString: b.vs || null, quality: b.q, method: 'STEPPED',
             occurredAt: b.ts.toISOString(), atIso };
  }
  const after = await db.collection(TS).find({ 'meta.tagPath': tagPath, ts: { $gt: at }, q: { $lt: BAD_FLOOR } })
    .sort({ ts: 1 }).limit(1).toArray();
  if (!after.length) {
    return { tagPath, v: before[0].v, quality: before[0].q, method: 'HELD_LAST', occurredAt: before[0].ts.toISOString(), atIso };
  }
  const b = before[0], a = after[0];
  const span = a.ts.getTime() - b.ts.getTime();
  const frac = span === 0 ? 0 : (at.getTime() - b.ts.getTime()) / span;
  return { tagPath, v: b.v + (a.v - b.v) * frac, quality: Math.max(b.q, a.q),
           method: 'INTERPOLATED', occurredAt: at.toISOString(), atIso };
}

/* ── aggregates ──────────────────────────────────────────────────────────────────────────── */
/*
 * The distinction that makes this a historian rather than a GROUP BY:
 *   CONTINUOUS -> time-weighted mean, because samples are irregular. Each sample is weighted by how
 *                 long it was the current value, so a burst of samples during a transient does not
 *                 drag the average.
 *   STEPPED    -> state durations and transition counts. "Average" of a state code is meaningless;
 *                 "running 82% of the window, 4 transitions" is the answer people want.
 * Bad-quality samples are excluded from BOTH, and counted separately so the coverage is visible.
 *
 * WHY THE PIPELINE IS SHARED. `histAggregate` answers a question about the edge; `runAggregation`
 * builds the rollups that get shipped to the cloud and become the ONLY surviving record of the
 * window. If those two computed their statistics separately they would drift, and the drift would
 * be invisible — the cloud copy would disagree with the edge it came from and neither would be
 * obviously wrong. So there is exactly one definition of the arithmetic, below, and two callers.
 *
 * WHY SO MANY FIELDS. Raw samples are on a 365-day TTL at the edge; the rollup is forever. Any
 * statistic not computed here is not merely missing from the cloud, it is unrecoverable once the
 * window ages out. Percentiles, spread and quality coverage cost one pass now and cannot be
 * reconstructed later from min/max/avg, so they are computed now.
 */

/* Quantile grid. A 5% grid plus p99 reconstructs the whole distribution curve, and the six named
   percentiles are just indices into it — one accumulator, not seven. p99 is on the grid because
   process alarms are written against it far more often than against p95. */
const P_GRID = [0, 0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50,
                0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90, 0.95, 0.99, 1];
const P_IX = { p05: 1, p25: 5, p50: 10, p75: 15, p95: 19, p99: 20 };
const at = (field, i) => ({ $arrayElemAt: [field, i] });

/*
 * The one definition of the window arithmetic. `to` is needed separately from the match because the
 * last sample in a window is in force until the window CLOSES, not until the next sample — without
 * clipping to `to`, time-weighting silently drops the tail of every window.
 */
function statsStages(match, to) {
  return [
    { $match: match },
    { $setWindowFields: { partitionBy: '$meta.tagPath', sortBy: { ts: 1 },
        output: {
          nextTs: { $shift: { output: '$ts', by: 1 } },
          prevV: { $shift: { output: '$v', by: -1 } }
        } } },
    { $addFields: {
        q0: { $ifNull: ['$q', 0] },
        /* duration this sample was in force, clipped to the window end */
        durMs: { $subtract: [{ $min: [{ $ifNull: ['$nextTs', to] }, to] }, '$ts'] }
    } },
    { $addFields: {
        /* THREE quality states, not two. OPC UA distinguishes Uncertain (stale, out of calibration)
           from Bad (no reading at all). Uncertain values are real numbers and belong in the
           statistics; Bad ones do not. Folding them together would either discard usable data or
           poison the mean, so `usable` drives the maths and the three counts are reported
           separately — and they add up to `samples`, which is how you audit them. */
        usable: { $lt: ['$q0', BAD_FLOOR] },
        isGoodQ: { $lt: ['$q0', UNCERTAIN_FLOOR] },
        isUncertainQ: { $and: [{ $gte: ['$q0', UNCERTAIN_FLOOR] }, { $lt: ['$q0', BAD_FLOOR] }] }
    } },
    /* Null out unusable values ONCE. Every numeric accumulator below reads `uv`, and Mongo's
       statistical accumulators ignore nulls, so bad samples cannot leak into a single one of them. */
    { $addFields: { uv: { $cond: ['$usable', '$v', null] } } },
    { $group: {
        _id: '$meta.tagPath',
        tagType: { $first: '$meta.tagType' },
        samples: { $sum: 1 },
        goodSamples: { $sum: { $cond: ['$isGoodQ', 1, 0] } },
        uncertainSamples: { $sum: { $cond: ['$isUncertainQ', 1, 0] } },
        badSamples: { $sum: { $cond: ['$usable', 0, 1] } },
        usableSamples: { $sum: { $cond: ['$usable', 1, 0] } },

        min: { $min: '$uv' }, max: { $max: '$uv' }, arithmeticAvg: { $avg: '$uv' },
        stdDev: { $stdDevPop: '$uv' },
        pct: { $percentile: { input: '$uv', p: P_GRID, method: 'approximate' } },

        weightedSum: { $sum: { $cond: ['$usable', { $multiply: ['$v', '$durMs'] }, 0] } },
        weightMs: { $sum: { $cond: ['$usable', '$durMs', 0] } },

        /* Endpoints of the window, explicitly ordered. Sorting on `usable` FIRST parks bad samples
           at the far end of the ordering, so $top is the earliest USABLE sample and $bottom the
           latest — the boundary values a trend has to join to the neighbouring windows. Relying on
           $first/$last instead would depend on $group preserving the upstream sort, which is not a
           guarantee, and would happily return the value of a comms failure. */
        firstUsable: { $top: { sortBy: { usable: -1, ts: 1 }, output: ['$v', '$ts'] } },
        lastUsable: { $bottom: { sortBy: { usable: 1, ts: 1 }, output: ['$v', '$ts'] } },

        transitions: { $sum: { $cond: [{ $and: ['$usable', { $ne: ['$prevV', null] }, { $ne: ['$v', '$prevV'] }] }, 1, 0] } },
        onMs: { $sum: { $cond: [{ $and: ['$usable', { $eq: ['$v', 1] }] }, '$durMs', 0] } },
        offMs: { $sum: { $cond: [{ $and: ['$usable', { $eq: ['$v', 0] }] }, '$durMs', 0] } },
        decreases: { $sum: { $cond: [{ $and: ['$usable', { $ne: ['$prevV', null] }, { $lt: ['$v', '$prevV'] }] }, 1, 0] } },
        maxLatencyMs: { $max: { $subtract: ['$rt', '$ts'] } }
    } },
    { $addFields: { hasUsable: { $gt: ['$usableSamples', 0] } } },
    { $project: {
        _id: 0, tagPath: '$_id', tagType: 1,
        samples: 1, goodSamples: 1, uncertainSamples: 1, badSamples: 1, usableSamples: 1,

        min: 1, max: 1, arithmeticAvg: 1, stdDev: 1,
        p05: at('$pct', P_IX.p05), p25: at('$pct', P_IX.p25), p50: at('$pct', P_IX.p50),
        p75: at('$pct', P_IX.p75), p95: at('$pct', P_IX.p95), p99: at('$pct', P_IX.p99),
        quantiles: '$pct',

        timeWeightedAvg: { $cond: [{ $gt: ['$weightMs', 0] }, { $divide: ['$weightedSum', '$weightMs'] }, null] },
        coverageMs: '$weightMs',

        first: { $cond: ['$hasUsable', at('$firstUsable', 0), null] },
        last: { $cond: ['$hasUsable', at('$lastUsable', 0), null] },
        firstAt: { $cond: ['$hasUsable', at('$firstUsable', 1), null] },
        lastAt: { $cond: ['$hasUsable', at('$lastUsable', 1), null] },
        delta: { $cond: ['$hasUsable', { $subtract: [at('$lastUsable', 0), at('$firstUsable', 0)] }, null] },

        transitions: 1, onDurationMs: '$onMs', offDurationMs: '$offMs',
        onFraction: { $cond: [{ $gt: [{ $add: ['$onMs', '$offMs'] }, 0] },
                              { $divide: ['$onMs', { $add: ['$onMs', '$offMs'] }] }, null] },
        isMonotonic: { $eq: ['$decreases', 0] },
        changeRatio: { $cond: [{ $gt: ['$samples', 1] },
                               { $divide: ['$transitions', { $subtract: ['$samples', 1] }] }, 0] },
        maxLatencyMs: 1
    } }
  ];
}

/* Which average actually means something for this tag. A consumer must never have to guess, and
   guessing is exactly what it does when handed an unlabelled "avg" for a state signal. */
const avgMethodFor = tagType => (INTERPOLATION[tagType] === 'CONTINUOUS' ? 'timeWeightedAvg' : 'onFraction');

async function aggregate(db, TS, MASTER, { tagPaths, fromIso, toIso }) {
  const from = new Date(fromIso), to = new Date(toIso);
  const match = { ts: { $gte: from, $lt: to } };
  if (tagPaths && tagPaths.length) { match['meta.tagPath'] = { $in: tagPaths }; }

  const rows = await db.collection(TS).aggregate(statsStages(match, to), { allowDiskUse: true }).toArray();

  return rows.map(r => Object.assign(r, {
    firstAt: r.firstAt ? r.firstAt.toISOString() : null,
    lastAt: r.lastAt ? r.lastAt.toISOString() : null,
    windowStart: from.toISOString(), windowEnd: to.toISOString(),
    preferredAvg: avgMethodFor(r.tagType)
  }));
}

/*
 * The rollup job. Same arithmetic as above, persisted per (tag, window).
 *
 * The deterministic _id makes a re-run a no-op rather than a duplicate — the idempotency rule the
 * rest of ACE uses — and $setOnInsert guards the pickup flag so recomputing a window can never
 * silently un-collect something already shipped to the cloud.
 */
async function rollup(db, TS, AGG, { windowMinutes, endAt }) {
  const mins = windowMinutes || 5;
  const to = endAt ? new Date(endAt) : new Date();
  const from = new Date(to.getTime() - mins * 60000);
  const rows = await db.collection(TS)
    .aggregate(statsStages({ ts: { $gte: from, $lt: to } }, to), { allowDiskUse: true }).toArray();

  if (!rows.length) { return { windowStart: from, windowEnd: to, tags: 0, written: 0 }; }

  const bucket = from.toISOString();
  const ops = rows.map(r => {
    const set = Object.assign({}, r, {
      windowStart: from, windowEnd: to,
      /* the rollup carries the NAME of its own authoritative average, so a cloud consumer reading
         this row years from now does not have to know the tag-type rules to interpret it */
      avgMethod: avgMethodFor(r.tagType),
      /* `count`/`avg` are the original field names the harvest flow and the Fuuz model already
         speak. Kept as aliases rather than renamed, so adding statistics does not break the
         deployed flow — the shipped contract only ever grows. */
      count: r.samples, avg: r.arithmeticAvg
    });
    delete set.tagPath;
    return {
      updateOne: {
        filter: { _id: r.tagPath + '|' + bucket },
        update: { $set: Object.assign({ tagPath: r.tagPath }, set),
                  $setOnInsert: { createdAt: new Date(), pickedUpAt: null, pickedUpBy: null } },
        upsert: true
      }
    };
  });
  const res = await db.collection(AGG).bulkWrite(ops, { ordered: false });
  return { windowStart: from, windowEnd: to, tags: rows.length,
           written: (res.upsertedCount || 0) + (res.modifiedCount || 0) };
}

module.exports = { Q, isGood, isBad, TAG_TYPES, INTERPOLATION, ensure, toDocs, raw, atTime, aggregate, rollup, statsStages, avgMethodFor };
