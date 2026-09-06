#!/usr/bin/env node
/*
 * ace-graphql — a Fuuz-shaped GraphQL API over MongoDB.
 *
 * WHY THIS EXISTS: Fuuz is MongoDB behind a GraphQL API. Standing up the same shape locally means
 * everything the orchestrator does against this service is the same code it will run against Fuuz —
 * the pilot stops being an approximation of the production topology and becomes a copy of it.
 *
 * The conventions below are copied deliberately from the live Fuuz API, not invented:
 *   query    model(where: {...}, first: N) { edges { node { ... } } }
 *   mutation upsertModel(payload: [{ where, create, update }]) { id }
 *   filters  _eq / _in  (NOT eq / in)
 *   `id` is create-only and must never appear in an update half
 * If any of those drift, code written here stops porting, which defeats the point.
 *
 * The one thing Fuuz does NOT have is `vectorSearch` — that is the capability we are evaluating.
 * It runs on MongoDB's own $vectorSearch (Community 8.2+ / Atlas Local via the mongot binary), so
 * vectors live next to the documents instead of in a sidecar store.
 */
'use strict';
const http = require('http');
const { MongoClient } = require('mongodb');
const { graphql, buildSchema } = require('graphql');
const H = require('./historian');

const PORT = parseInt(process.env.PORT || '8098', 10);
const MONGO_URL = process.env.MONGO_URL || 'mongodb://ace-mongo:27017/?directConnection=true';
const DB_NAME = process.env.MONGO_DB || 'ace';
const COLL = 'aceVector';
const TS_COLL = 'tagValue';        /* native time-series collection — the local historian */
const AGG_COLL = 'tagAggregate';
const MASTER_COLL = 'tagMaster';   /* regular collection — see the note on why it cannot be the TS one */
const INDEX = 'ace_vector_idx';
/* ── RETENTION ────────────────────────────────────────────────────────────────────────────────
 * ONE constant, ENFORCED on an existing collection rather than only at creation.
 *
 * That distinction is the whole point. expireAfterSeconds is a createCollection option: once the
 * collection exists, editing the number in code changes nothing. This file said 90 days and
 * historian.js said 365, and the collection actually running had FIVE — a value neither file
 * contains, left from whenever it was first created. Three numbers, none of them real.
 * ensureTimeseries now collMods the live TTL into line, so the source is the truth.
 *
 * WHY THE DEFAULT IS SMALL. Reconciling to 90 was the wrong direction and nearly the whole point of
 * the exercise inverted: this store is fed by a simulator, and it was MEASURED at ~120,000 samples
 * a minute — 173 million a day, 6.7 GB a day at the observed 42 bytes per document. So:
 *
 *     TTL      steady state
 *      2d       13 GB
 *      7d       47 GB
 *     30d      202 GB
 *     90d      606 GB      <- what "correcting" 5d to 90d would have produced
 *
 * The whole stack has already been OOM-killed once holding 743 MB. A local pilot historian wants
 * days, not months; the durable record is the ROLLUP, which is why tagAggregate has no TTL and is
 * three orders of magnitude smaller. Raise this only with the arithmetic above in view. */
const TS_TTL_DAYS = parseInt(process.env.HISTORIAN_TTL_DAYS || '3', 10);
const DIMS = parseInt(process.env.EMBED_DIMS || '1024', 10);

/* GUARD: a backtick inside this SDL terminates the template literal and node reports the useless
   "missing ) after argument list". Cost an hour once; never again. */
const SDL = `
  input StringFilter { _eq: String, _in: [String!] }
  input AceVectorWhereInput { id: StringFilter, candidateId: StringFilter, status: StringFilter, source: StringFilter }

  type AceVector {
    id: String!
    candidateId: String
    tagPath: String
    label: String
    status: String
    source: String
    model: String
    dims: Int
    embedding: [Float!]
  }
  type AceVectorEdge { node: AceVector!, score: Float }
  type AceVectorConnection { edges: [AceVectorEdge!]! }

  input AceVectorInput {
    id: String, candidateId: String, tagPath: String, label: String,
    status: String, source: String, model: String, dims: Int, embedding: [Float!]
  }
  input AceVectorUpsertPayloadInput { where: AceVectorWhereUniqueInput!, create: AceVectorInput!, update: AceVectorInput! }
  input AceVectorWhereUniqueInput { id: String! }

  """One historian sample. Mirrors the platform TagValue shape (tag + value + occurredAt)."""
  type TagValue { tagPath: String!, v: Float, occurredAt: String! }
  type TagValueEdge { node: TagValue! }
  type TagValueConnection { edges: [TagValueEdge!]! }
  input TagValueInput {
    tagPath: String!, occurredAt: String!,
    v: Float, valueBool: Boolean, valueString: String,
    tagType: String, quality: Float, seq: Int
  }
  type RawSample {
    tagPath: String!, tagType: String, v: Float, valueBool: Boolean, valueString: String,
    quality: Float!, qualityGood: Boolean!, occurredAt: String!, receivedAt: String, latencyMs: Float
  }
  type AtTimeResult { tagPath: String!, v: Float, valueString: String, quality: Float, method: String!, occurredAt: String, atIso: String }
  type TagMaster {
    tagPath: String!, tagType: String!, dataType: String, unit: String,
    engLow: Float, engHigh: Float, deadband: Float, deadbandType: String,
    interpolation: String!, scanRateMs: Int, digitalStates: String, description: String
  }
  input TagMasterInput {
    tagPath: String!, tagType: String!, dataType: String, unit: String,
    engLow: Float, engHigh: Float, deadband: Float, deadbandType: String,
    interpolation: String, scanRateMs: Int, digitalStates: String, description: String
  }
  """Historian aggregate. 'preferredAvg' names which figure is meaningful for this tag type —
  time-weighted mean for continuous signals, on-fraction for discrete ones.
  Quality is reported in three buckets because OPC UA has three: goodSamples + uncertainSamples +
  badSamples == samples, and usableSamples (good + uncertain) is the population every statistic
  here is computed over. 'quantiles' is the full 5% grid; p05..p99 are named entries in it."""
  type HistAggregate {
    tagPath: String!, tagType: String, windowStart: String!, windowEnd: String!,
    samples: Int!, goodSamples: Int!, uncertainSamples: Int!, badSamples: Int!, usableSamples: Int!,
    min: Float, max: Float, arithmeticAvg: Float, timeWeightedAvg: Float,
    stdDev: Float, p05: Float, p25: Float, p50: Float, p75: Float, p95: Float, p99: Float,
    quantiles: [Float],
    first: Float, last: Float, delta: Float, firstAt: String, lastAt: String,
    transitions: Int!, onDurationMs: Float, offDurationMs: Float, onFraction: Float,
    coverageMs: Float, isMonotonic: Boolean, changeRatio: Float, maxLatencyMs: Float,
    preferredAvg: String!
  }

  """Exactly the shape ace-classify-signal consumes as valueStats — computed in the database,
  not in the client, so a real historian can answer it at any scale."""
  type ValueStats {
    tagPath: String!, samples: Int!, distinctCount: Int!, min: Float, max: Float,
    isBoolean: Boolean!, isMonotonic: Boolean!, changeRatio: Float!
  }

  """A 5-minute rollup of one tag, and the record of whether anything has consumed it yet.
  Lives in a REGULAR collection, not the time-series one: MongoDB time-series collections are
  append-oriented and do not support the arbitrary field updates a pickup flag needs. Rollups are
  therefore derived documents — recomputable from tagValue at any time, and safely mutable.

  This is the ONLY thing that survives the trip to the cloud, and raw samples age out of the edge
  on a 365-day TTL. So the rollup carries everything that cannot be reconstructed from a mean:
  spread (stdDev), shape (the quantile grid), quality coverage, and the window's endpoint values.
  'count' and 'avg' are retained aliases of samples/arithmeticAvg so the deployed harvest flow keeps
  working — the shipped contract only ever grows.

  Everything past changeRatio is nullable on purpose. Rollups written before those statistics
  existed are still in the collection and still valid; reporting them as null says "this window was
  summarised by an older collector", which is true, where a non-null type would make reading an
  archived window an error."""
  type TagAggregate {
    id: String!, tagPath: String!, tagType: String, windowStart: String!, windowEnd: String!,
    count: Int!, min: Float, max: Float, avg: Float, first: Float, last: Float,
    isMonotonic: Boolean!, changeRatio: Float!,
    samples: Int, goodSamples: Int, uncertainSamples: Int, badSamples: Int, usableSamples: Int,
    arithmeticAvg: Float, timeWeightedAvg: Float, avgMethod: String, coverageMs: Float,
    stdDev: Float, p05: Float, p25: Float, p50: Float, p75: Float, p95: Float, p99: Float,
    quantiles: [Float],
    firstAt: String, lastAt: String, delta: Float,
    transitions: Int, onDurationMs: Float, offDurationMs: Float, onFraction: Float,
    maxLatencyMs: Float,
    createdAt: String!, pickedUp: Boolean!, pickedUpAt: String, pickedUpBy: String
  }
  type TagAggregateEdge { node: TagAggregate! }
  type TagAggregateConnection { edges: [TagAggregateEdge!]! }
  type AggregateRunResult { windowStart: String!, windowEnd: String!, tags: Int!, written: Int! }

  """Summary of the edge harvest, answered by the historian itself.
  The console cannot see the Fuuz tenant, so "is the harvest working" has to be answerable from
  this side of the link. It is: a rollup that has been acknowledged was collected by something, and
  the most recent acknowledgement says when that last happened and who did it."""
  type HarvestStatus {
    pending: Int!, collected: Int!, total: Int!,
    lastCollectedAt: String, lastCollectedBy: String,
    oldestPendingAt: String, newestPendingAt: String
  }
  type PickupResult { markedPickedUp: Int!, at: String! }

  type MutationResult { id: String! }
  type IndexStatus { name: String, status: String, queryable: Boolean, dims: Int, count: Int }
  """What is on disk and how long it stays. A null ttlDays means it is never expired automatically."""
  type CollectionStat { name: String!, kind: String!, ttlDays: Float, docs: Float!, storageMB: Float! }
  type PurgeResult { scope: String!, dropped: [String!]!, rebuilt: [String!]!, docsBefore: Float!, docsAfter: Float!, freedMB: Float! }

  type Query {
    aceVector(where: AceVectorWhereInput, first: Int): AceVectorConnection!
    """MongoDB $vectorSearch — the capability being evaluated. Returns Fuuz-shaped edges with a score."""
    vectorSearch(vector: [Float!]!, limit: Int, numCandidates: Int, status: String): AceVectorConnection!
    indexStatus: IndexStatus!
    tagValues(tagPath: String!, first: Int): TagValueConnection!
    """Behaviour summary per tag, computed by the historian itself."""
    valueStats(tagPaths: [String!], sinceIso: String): [ValueStats!]!
    historianStatus: IndexStatus!
    """Rollups awaiting collection. The edge flow polls this."""
    tagAggregates(pickedUp: Boolean, first: Int): TagAggregateConnection!
    """Raw samples including bad quality when asked — that is how outages are diagnosed."""
    rawSamples(tagPath: String!, fromIso: String, toIso: String, includeBad: Boolean, limit: Int): [RawSample!]!
    """Value at an instant, honouring the tag's interpolation mode (STEPPED vs CONTINUOUS)."""
    valueAtTime(tagPath: String!, atIso: String!): AtTimeResult
    """Process + discrete aggregates: time-weighted mean, state durations, quality coverage."""
    histAggregate(tagPaths: [String!], fromIso: String!, toIso: String!): [HistAggregate!]!
    tagMasters(first: Int): [TagMaster!]!
    """Every collection with its row count, size and retention — what the console shows before offering to wipe anything."""
    storageStatus: [CollectionStat!]!
    """Counts and last-pickup, so a dashboard can say whether the harvest is draining."""
    harvestStatus: HarvestStatus!
  }
  type Mutation {
    upsertAceVector(payload: [AceVectorUpsertPayloadInput!]!): [MutationResult!]!
    deleteAllAceVectors: Int!
    recordTagValues(payload: [TagValueInput!]!): Int!
    deleteAllTagValues: Int!
    """Roll up the trailing window. Idempotent per (tagPath, windowStart)."""
    runAggregation(windowMinutes: Int): AggregateRunResult!
    """Mark rollups as collected, so the next poll does not re-deliver them."""
    markPickedUp(ids: [String!]!, by: String): PickupResult!
    upsertTagMaster(payload: [TagMasterInput!]!): Int!
    """Wipe local historian data. scope: raw | aggregates | master | vectors | all. confirm must be true — this is not recoverable."""
    purgeHistorian(scope: String!, confirm: Boolean!): PurgeResult!
  }
`;
if (SDL.indexOf(String.fromCharCode(96)) !== -1) { throw new Error('SDL contains a backtick — it will break the template literal'); }
const schema = buildSchema(SDL);

let db = null;

/* Translate the Fuuz filter dialect into a Mongo query. Kept tiny and explicit so the mapping is
   obvious when the same thing has to be done for real models. */
function toMongo(where) {
  const q = {};
  for (const [field, f] of Object.entries(where || {})) {
    if (!f) { continue; }
    if (f._eq !== undefined) { q[field === 'id' ? '_id' : field] = f._eq; }
    else if (f._in !== undefined) { q[field === 'id' ? '_id' : field] = { $in: f._in }; }
  }
  return q;
}
const shape = d => d && Object.assign({}, d, { id: d._id, _id: undefined });
const aggShape = d => d && Object.assign({}, d, {
  id: d._id, _id: undefined,
  windowStart: d.windowStart.toISOString(), windowEnd: d.windowEnd.toISOString(),
  createdAt: d.createdAt ? d.createdAt.toISOString() : null,
  /* firstAt/lastAt are the sample timestamps at the window's edges — Dates in Mongo, ISO on the
     wire like every other instant this API returns. */
  firstAt: d.firstAt ? d.firstAt.toISOString() : null,
  lastAt: d.lastAt ? d.lastAt.toISOString() : null,
  pickedUp: !!d.pickedUpAt,
  pickedUpAt: d.pickedUpAt ? d.pickedUpAt.toISOString() : null
});

const root = {
  aceVector: async ({ where, first }) => {
    const docs = await db.collection(COLL).find(toMongo(where)).limit(first || 100).toArray();
    return { edges: docs.map(d => ({ node: shape(d) })) };
  },

  vectorSearch: async ({ vector, limit, numCandidates, status }) => {
    const stage = {
      $vectorSearch: {
        index: INDEX, path: 'embedding', queryVector: vector,
        numCandidates: numCandidates || Math.max(50, (limit || 5) * 20),
        limit: limit || 5
      }
    };
    if (status) { stage.$vectorSearch.filter = { status: status }; }
    const docs = await db.collection(COLL).aggregate([
      stage,
      { $addFields: { __score: { $meta: 'vectorSearchScore' } } },
      { $project: { embedding: 0 } }         /* never ship 1024 floats back by default */
    ]).toArray();
    return { edges: docs.map(d => ({ node: shape(d), score: d.__score })) };
  },

  indexStatus: async () => {
    const count = await db.collection(COLL).countDocuments();
    try {
      const idx = await db.collection(COLL).listSearchIndexes().toArray();
      const mine = idx.find(i => i.name === INDEX);
      return mine
        ? { name: mine.name, status: mine.status, queryable: !!mine.queryable, dims: DIMS, count }
        : { name: INDEX, status: 'MISSING', queryable: false, dims: DIMS, count };
    } catch (e) {
      return { name: INDEX, status: 'NO_SEARCH_SUPPORT: ' + String(e.message).slice(0, 80), queryable: false, dims: DIMS, count };
    }
  },

  upsertAceVector: async ({ payload }) => {
    const ops = payload.map(p => {
      const update = {};
      for (const [k, v] of Object.entries(p.update || {})) {
        if (k === 'id' || v === undefined || v === null) { continue; }   /* id is create-only, as in Fuuz */
        update[k] = v;
      }
      /* $setOnInsert may not touch any field $set touches — Mongo rejects the overlap outright
         ("would create a conflict at ..."). So insert-only keys are create minus update. */
      const insertOnly = { _id: p.where.id };
      for (const [k, v] of Object.entries(p.create || {})) {
        if (k === 'id' || k in update || v === undefined || v === null) { continue; }
        insertOnly[k] = v;
      }
      const doc = { $set: update };
      if (Object.keys(insertOnly).length > 1) { doc.$setOnInsert = insertOnly; }
      else { doc.$setOnInsert = { _id: p.where.id }; }
      return { updateOne: { filter: { _id: p.where.id }, update: doc, upsert: true } };
    });
    if (ops.length) { await db.collection(COLL).bulkWrite(ops, { ordered: false }); }
    return payload.map(p => ({ id: p.where.id }));
  },

  tagValues: async ({ tagPath, first }) => {
    const docs = await db.collection(TS_COLL)
      .find({ 'meta.tagPath': tagPath }).sort({ ts: 1 }).limit(first || 100).toArray();
    return { edges: docs.map(d => ({ node: { tagPath: d.meta.tagPath, v: d.v, occurredAt: d.ts.toISOString() } })) };
  },

  historianStatus: async () => {
    const count = await db.collection(TS_COLL).estimatedDocumentCount();
    const info = await db.listCollections({ name: TS_COLL }).toArray();
    const isTs = info.length && info[0].type === 'timeseries';
    return { name: TS_COLL, status: isTs ? 'TIMESERIES' : (info.length ? 'REGULAR' : 'MISSING'),
             queryable: !!info.length, dims: 0, count };
  },

  /* The behaviour lane, computed IN the database. $setWindowFields gives each sample its
     predecessor, which is what makes monotonicity and change-ratio expressible in one pass —
     the classifier needs exactly these fields and should never have to stream raw history. */
  valueStats: async ({ tagPaths, sinceIso }) => {
    const match = {};
    if (tagPaths && tagPaths.length) { match['meta.tagPath'] = { $in: tagPaths }; }
    if (sinceIso) { match.ts = { $gte: new Date(sinceIso) }; }
    const rows = await db.collection(TS_COLL).aggregate([
      { $match: match },
      { $setWindowFields: { partitionBy: '$meta.tagPath', sortBy: { ts: 1 },
          output: { prev: { $shift: { output: '$v', by: -1 } } } } },
      { $group: {
          _id: '$meta.tagPath',
          samples: { $sum: 1 },
          min: { $min: '$v' }, max: { $max: '$v' },
          distinct: { $addToSet: '$v' },
          decreases: { $sum: { $cond: [{ $and: [{ $ne: ['$prev', null] }, { $lt: ['$v', '$prev'] }] }, 1, 0] } },
          changes:   { $sum: { $cond: [{ $and: [{ $ne: ['$prev', null] }, { $ne: ['$v', '$prev'] }] }, 1, 0] } }
      } },
      { $project: {
          _id: 0, tagPath: '$_id', samples: 1, min: 1, max: 1,
          distinctCount: { $size: '$distinct' },
          isBoolean: { $and: [ { $lte: [{ $size: '$distinct' }, 2] },
                               { $setIsSubset: ['$distinct', [0, 1]] } ] },
          isMonotonic: { $eq: ['$decreases', 0] },
          changeRatio: { $cond: [{ $gt: ['$samples', 1] },
                                 { $divide: ['$changes', { $subtract: ['$samples', 1] }] }, 0] }
      } }
    ], { allowDiskUse: true }).toArray();
    return rows;
  },

  harvestStatus: async () => {
    const c = db.collection(AGG_COLL);
    const [pending, collected] = await Promise.all([
      c.countDocuments({ pickedUpAt: null }),
      c.countDocuments({ pickedUpAt: { $ne: null } })
    ]);
    /* Sorted lookups rather than scanning: these collections run to millions of rows and a
       dashboard polls this every few seconds. */
    const [last] = await c.find({ pickedUpAt: { $ne: null } }).sort({ pickedUpAt: -1 }).limit(1).toArray();
    const [oldest] = await c.find({ pickedUpAt: null }).sort({ windowStart: 1 }).limit(1).toArray();
    const [newest] = await c.find({ pickedUpAt: null }).sort({ windowStart: -1 }).limit(1).toArray();
    return {
      pending, collected, total: pending + collected,
      lastCollectedAt: last && last.pickedUpAt ? last.pickedUpAt.toISOString() : null,
      lastCollectedBy: last ? (last.pickedUpBy || null) : null,
      oldestPendingAt: oldest && oldest.windowStart ? new Date(oldest.windowStart).toISOString() : null,
      newestPendingAt: newest && newest.windowStart ? new Date(newest.windowStart).toISOString() : null
    };
  },

  tagAggregates: async ({ pickedUp, first }) => {
    const q = {};
    if (pickedUp === true) { q.pickedUpAt = { $ne: null }; }
    else if (pickedUp === false) { q.pickedUpAt = null; }
    const docs = await db.collection(AGG_COLL).find(q).sort({ windowStart: 1 }).limit(first || 500).toArray();
    return { edges: docs.map(d => ({ node: aggShape(d) })) };
  },

  /* The arithmetic lives in historian.js so this and histAggregate cannot drift — see the note
     there. This resolver's only job is the ISO round-trip at the API boundary. */
  runAggregation: async ({ windowMinutes }) => {
    const r = await H.rollup(db, TS_COLL, AGG_COLL, { windowMinutes });
    return { windowStart: r.windowStart.toISOString(), windowEnd: r.windowEnd.toISOString(),
             tags: r.tags, written: r.written };
  },

  markPickedUp: async ({ ids, by }) => {
    const at = new Date();
    const r = await db.collection(AGG_COLL).updateMany(
      { _id: { $in: ids }, pickedUpAt: null },        /* never re-stamp an already-collected rollup */
      { $set: { pickedUpAt: at, pickedUpBy: by || 'unknown' } }
    );
    return { markedPickedUp: r.modifiedCount, at: at.toISOString() };
  },

  recordTagValues: async ({ payload }) => {
    if (!payload.length) { return 0; }
    /* time-series collections are insert-only — no updates, no upserts, by design */
    const r = await db.collection(TS_COLL).insertMany(H.toDocs(payload), { ordered: false });
    return r.insertedCount;
  },

  rawSamples: async (a) => H.raw(db, TS_COLL, a),
  valueAtTime: async (a) => H.atTime(db, TS_COLL, MASTER_COLL, a),
  histAggregate: async (a) => H.aggregate(db, TS_COLL, MASTER_COLL, a),
  tagMasters: async ({ first }) => db.collection(MASTER_COLL).find({}).limit(first || 500).toArray(),
  upsertTagMaster: async ({ payload }) => {
    const ops = payload.map(t => ({
      updateOne: {
        filter: { tagPath: t.tagPath },
        update: { $set: Object.assign({}, t, {
          interpolation: t.interpolation || H.INTERPOLATION[t.tagType] || 'STEPPED'
        }) },
        upsert: true
      }
    }));
    const r = await db.collection(MASTER_COLL).bulkWrite(ops, { ordered: false });
    return (r.upsertedCount || 0) + (r.modifiedCount || 0);
  },

  deleteAllTagValues: async () => {
    try { await db.collection(TS_COLL).drop(); } catch (e) { /* absent */ }
    await ensureTimeseries();
    return 0;
  },

  storageStatus: async () => {
    const infos = await db.listCollections().toArray();
    const out = [];
    for (const c of infos) {
      if (c.name.indexOf('system.') === 0) { continue; }   /* buckets mirror their view; not separate data */
      let docs = 0, storageMB = 0;
      try { docs = await db.collection(c.name).countDocuments({}); } catch (e) { /* view or restricted */ }
      try {
        const st = await db.command({ collStats: c.name });
        storageMB = Math.round((st.storageSize || 0) / 1048576 * 10) / 10;
      } catch (e) { /* leave 0 */ }
      const ttl = c.options && c.options.expireAfterSeconds !== undefined ? c.options.expireAfterSeconds : null;
      out.push({ name: c.name, kind: c.type || 'collection',
                 ttlDays: ttl === null ? null : Math.round(ttl / 864 ) / 100, docs, storageMB });
    }
    return out.sort((a, b) => b.storageMB - a.storageMB);
  },

  /* Deliberately explicit about SCOPE rather than one "wipe everything" button.
   *
   * Raw samples regenerate in minutes from the simulator, so dropping them is cheap. Rollups do not:
   * they are the only record of a window once its samples expire, which is the entire reason they
   * exist. The tag registry is what every rollup and candidate refers to by tagPath. Offering one
   * undifferentiated wipe would make the cheap case and the expensive one the same click. */
  purgeHistorian: async ({ scope, confirm }) => {
    if (!confirm) { throw new Error('purgeHistorian requires confirm: true — this is not recoverable'); }
    const SCOPES = { raw: [TS_COLL], aggregates: [AGG_COLL], master: [MASTER_COLL], vectors: [COLL],
                     all: [TS_COLL, AGG_COLL, MASTER_COLL, COLL] };
    const targets = SCOPES[scope];
    if (!targets) { throw new Error('unknown scope "' + scope + '" — use raw | aggregates | master | vectors | all'); }

    const count = async n => { try { return await db.collection(n).countDocuments({}); } catch (e) { return 0; } };
    const sizeMB = async n => {
      try { const st = await db.command({ collStats: n }); return (st.storageSize || 0) / 1048576; } catch (e) { return 0; }
    };
    let before = 0, freed = 0;
    for (const n of targets) { before += await count(n); freed += await sizeMB(n); }

    /* DROP ONLY THE TIME-SERIES COLLECTION. A time-series collection does not reclaim space from
       deletes — the buckets stay — so deleting 17 million samples reports success and frees nothing.
       Everything else is a regular collection, where deleteMany empties it AND KEEPS ITS INDEXES.
       That difference matters: dropping aceVector destroyed its vector search index, and rebuilding
       it raced with the drop settling — listSearchIndexes kept returning the dead index, ensureIndex
       short-circuited on "already exists", and the purge cheerfully reported a rebuild that never
       happened. Not dropping it removes the race and the index entirely. */
    const dropped = [], emptied = [];
    for (const n of targets) {
      if (n === TS_COLL) {
        try { await db.collection(n).drop(); dropped.push(n); } catch (e) { /* already absent */ }
      } else {
        try { const r = await db.collection(n).deleteMany({}); emptied.push(n + ' (' + r.deletedCount + ')'); }
        catch (e) { /* absent */ }
      }
    }
    /* Only the TS collection needs recreating; its options and TTL do not survive a drop. */
    const rebuilt = [];
    if (targets.indexOf(TS_COLL) !== -1) { rebuilt.push('tagValue: ' + await ensureTimeseries()); }
    if (targets.indexOf(COLL) !== -1) { rebuilt.push('searchIndex: ' + await ensureIndex()); }

    let after = 0;
    for (const n of targets) { after += await count(n); }
    return { scope, dropped: dropped.concat(emptied), rebuilt,
             docsBefore: before, docsAfter: after, freedMB: Math.round(freed * 10) / 10 };
  },

  deleteAllAceVectors: async () => {
    const r = await db.collection(COLL).deleteMany({});
    return r.deletedCount;
  }
};

/* The search index must exist before $vectorSearch works, and it takes a moment to become
   queryable — surfaced through indexStatus rather than failing opaquely at query time. */
/* Native time-series collection — a core mongod storage type since 5.0, NOT a companion process
   like mongot. Columnar bucketed storage, automatic clustered index on (metaField, timeField). */
async function ensureTimeseries() {
  const want = 60 * 60 * 24 * TS_TTL_DAYS;
  const existing = await db.listCollections({ name: TS_COLL }).toArray();
  if (existing.length) {
    if (existing[0].type !== 'timeseries') { return 'exists (REGULAR — wrong type)'; }
    /* Bring a pre-existing collection into line with the constant. Without this the TTL is whatever
       it was on the day the collection was first created and the source is decoration — which is
       exactly how a file saying 90 days ended up fronting a collection expiring at 5. */
    const have = existing[0].options && existing[0].options.expireAfterSeconds;
    if (have !== want) {
      try {
        await db.command({ collMod: TS_COLL, expireAfterSeconds: want });
        return 'exists (timeseries, TTL corrected ' + (have === undefined ? 'none' : have / 86400 + 'd') +
               ' -> ' + TS_TTL_DAYS + 'd)';
      } catch (e) {
        return 'exists (timeseries, TTL ' + (have === undefined ? 'none' : have / 86400 + 'd') +
               ' — collMod failed: ' + String(e.message).slice(0, 80) + ')';
      }
    }
    return 'exists (timeseries, ' + TS_TTL_DAYS + 'd)';
  }
  await db.createCollection(TS_COLL, {
    timeseries: { timeField: 'ts', metaField: 'meta', granularity: 'seconds' },
    expireAfterSeconds: want
  });
  return 'created (timeseries, ' + TS_TTL_DAYS + 'd retention)';
}

async function ensureIndex() {
  const coll = db.collection(COLL);
  try { await db.createCollection(COLL); } catch (e) { /* exists */ }
  try {
    const existing = await coll.listSearchIndexes().toArray();
    if (existing.some(i => i.name === INDEX)) { return 'exists'; }
    await coll.createSearchIndex({
      name: INDEX, type: 'vectorSearch',
      definition: { fields: [
        { type: 'vector', path: 'embedding', numDimensions: DIMS, similarity: 'cosine' },
        { type: 'filter', path: 'status' }
      ] }
    });
    return 'created';
  } catch (e) { return 'unavailable: ' + String(e.message).slice(0, 120); }
}

(async () => {
  const client = new MongoClient(MONGO_URL);
  await client.connect();
  db = client.db(DB_NAME);
  console.log('mongo connected: ' + DB_NAME);
  console.log('search index: ' + (await ensureIndex()));
  console.log('historian   : ' + (await ensureTimeseries()));
  console.log('historian   : ' + (await H.ensure(db, TS_COLL, MASTER_COLL, AGG_COLL)));
  console.log('tag master  : ' + MASTER_COLL + '   aggregates: ' + AGG_COLL + ' (pickup-flagged)');

  http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      res.setHeader('Content-Type', 'application/json');

      /* A liveness answer on GET.
         Anything that monitors an HTTP endpoint probes it with a GET first — the Fuuz gateway's
         HTTPClient device does exactly that against its baseUrl, and a blanket 405 made a perfectly
         healthy historian look unreachable. A service that only speaks POST is hostile to every
         health checker, not just this one, so answer GET honestly instead of rejecting it. */
      if (req.method === 'GET' || req.method === 'HEAD') {
        res.statusCode = 200;
        return res.end(JSON.stringify({
          service: 'ace-graphql', status: 'ok',
          endpoints: { graphql: 'POST /graphql' },
          historian: 'mongodb time-series', at: new Date().toISOString()
        }));
      }

      /* CORS preflight, for anything calling this straight from a browser. */
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'access-control-allow-origin': '*',
                             'access-control-allow-headers': 'content-type',
                             'access-control-allow-methods': 'GET,POST,OPTIONS' });
        return res.end();
      }

      if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ error: 'POST /graphql' })); }
      try {
        const { query, variables } = JSON.parse(body || '{}');
        const out = await graphql({ schema, source: query, rootValue: root, variableValues: variables });
        res.end(JSON.stringify(out));
      } catch (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ errors: [{ message: String(e.message).slice(0, 300) }] }));
      }
    });
  }).listen(PORT, () => console.log('ace-graphql on :' + PORT + ' (POST /graphql)'));
})().catch(e => { console.error('FATAL ' + e.message); process.exit(1); });
