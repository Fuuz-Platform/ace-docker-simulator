/*
 * handshake.js — a PLC production-complete cell, and the stopwatch that times it.
 *
 * THE PATTERN THIS MODELS. A line finishes a part. The PLC raises one tag — a sequence number on
 * `ProductionComplete` — and then waits. Something upstream is supposed to notice, come back and
 * read the few dozen tags that describe what was just produced, and finally write the same sequence
 * number to `DataCollected` to say "I have it all". Only then does the PLC clear the flag and let
 * the next part through. Every MES integration has this handshake in it somewhere, and the number
 * that decides whether the line runs at rate is the time between raising the flag and seeing the
 * acknowledgement.
 *
 * WHY THE STOPWATCH LIVES HERE AND NOT IN THE HARNESS. A client asking "how fast is the gateway"
 * is really asking "how long does my PLC wait". Only the PLC can answer that: it owns both ends of
 * the interval. So the simulator records t0 when it raises the flag, records the moment each result
 * tag is first read, and records the ack write when it lands — three timestamps from ONE clock, no
 * skew to correct and nothing inferred. The harness's own numbers are kept alongside as a
 * cross-check, never as the source.
 *
 * The reads are recorded by the tag getters themselves, which is the only way to see the collection
 * as the PLC sees it: not "the flow says it read 40 tags" but "40 tags were actually fetched from
 * me, the first at +18 ms and the last at +34 ms". A flow that quietly reads 39 of them cannot hide.
 */
'use strict';

const AREA = 'LINE1';
const CELL = 'CELL01';
const MAX_CYCLES = 500;                    /* ring buffer; a demo left running must not grow forever */

/* Result tags are generated rather than listed. A client wanting to know the cost of THEIR payload
   size sets resultTags and re-reads the sweep — 12 tags and 60 tags are the same code path. */
const DEFAULT_RESULT_TAGS = 40;
const MAX_RESULT_TAGS = 200;

function build({ ns, plantFolder, DataType, Variant, DataValue, StatusCodes }) {
  const state = {
    ProductionComplete: 0,
    DataCollected: 0,
    BatchId: '',
    PartCount: 0,
    CycleMs: 0
  };
  const results = {};                       /* Result_01 -> number */
  const cfg = { resultTags: DEFAULT_RESULT_TAGS, autoMs: 0 };
  const cycles = [];
  let current = null;                       /* the cycle awaiting acknowledgement, if any */
  let seq = 0;
  let autoTimer = null;

  const pad = n => (n < 10 ? '0' : '') + n;
  const resultName = i => 'Result_' + pad(i);
  const nodeIdFor = name => 'ns=1;s=' + AREA + '/' + CELL + '/' + name;

  /* Every read of a result tag is a data point about the collection, so it is recorded at the
     getter rather than counted anywhere else. `seen` is per-cycle, so re-reading the same tag twice
     shows up as reads=41 on 40 distinct tags — which is a real defect worth being able to see. */
  function noteResultRead(name) {
    if (!current) { return; }
    const now = Date.now();
    if (current.tFirstRead === null) { current.tFirstRead = now; }
    current.tLastRead = now;
    current.reads++;
    current.tagsRead[name] = (current.tagsRead[name] || 0) + 1;
  }

  const cell = ns.addObject({ organizedBy: plantFolder, browseName: CELL, description: 'Production cell ' + CELL });

  /* ── the handshake pair ────────────────────────────────────────────────────────────────────
     Both are readable AND writable. ProductionComplete is writable so a client can drive a cycle
     without the control API — some clients will want to prove the loop from their own tooling —
     and DataCollected is writable because that write IS the acknowledgement being measured. */
  function addRw(name, dataType, get, set, description) {
    return ns.addVariable({
      componentOf: cell, browseName: name, nodeId: 's=' + AREA + '/' + CELL + '/' + name,
      dataType, description,
      accessLevel: 'CurrentRead | CurrentWrite',
      userAccessLevel: 'CurrentRead | CurrentWrite',
      value: {
        timestamped_get: () => new DataValue({
          value: new Variant({ dataType: DataType[dataType], value: get() }),
          statusCode: StatusCodes.Good,
          sourceTimestamp: new Date()
        }),
        set: variant => { set(variant.value); return StatusCodes.Good; }
      }
    });
  }

  addRw('ProductionComplete', 'Int32',
    () => state.ProductionComplete,
    v => { state.ProductionComplete = Number(v) || 0; if (state.ProductionComplete > 0) { open(state.ProductionComplete, 'plc-write'); } },
    'Rises to the batch sequence number when a part completes. Cleared by the PLC once DataCollected matches.');

  /* The acknowledgement. Writing the sequence number here closes the cycle — that write is the end
     of the interval every other number in this module is measured against. */
  addRw('DataCollected', 'Int32',
    () => state.DataCollected,
    v => { state.DataCollected = Number(v) || 0; ack(state.DataCollected); },
    'Written by the collector with the sequence number it has finished collecting. This is the acknowledgement.');

  addRw('BatchId', 'String', () => state.BatchId, v => { state.BatchId = String(v); },
    'Batch identifier for the completed part.');

  ns.addVariable({
    componentOf: cell, browseName: 'PartCount', nodeId: nodeIdFor('PartCount').replace('ns=1;', ''),
    dataType: 'Int32', description: 'Parts completed since start.',
    value: { timestamped_get: () => new DataValue({
      value: new Variant({ dataType: DataType.Int32, value: state.PartCount }),
      statusCode: StatusCodes.Good, sourceTimestamp: new Date() }) }
  });

  ns.addVariable({
    componentOf: cell, browseName: 'CycleMs', nodeId: 's=' + AREA + '/' + CELL + '/CycleMs',
    dataType: 'Int32', description: 'Measured handshake time of the last completed cycle, in milliseconds.',
    value: { timestamped_get: () => new DataValue({
      value: new Variant({ dataType: DataType.Int32, value: state.CycleMs }),
      statusCode: StatusCodes.Good, sourceTimestamp: new Date() }) }
  });

  /* ── the production results ───────────────────────────────────────────────────────────────
     Created once at MAX_RESULT_TAGS and left in the address space. Adding and removing nodes
     between runs would invalidate any subscription or browse cache a client is holding, and the
     cost of an unread node is zero — cfg.resultTags decides how many the PLC FREEZES per cycle and
     how many the harness asks for, not how many exist. */
  for (let i = 1; i <= MAX_RESULT_TAGS; i++) {
    const name = resultName(i);
    results[name] = 0;
    ns.addVariable({
      componentOf: cell, browseName: name, nodeId: 's=' + AREA + '/' + CELL + '/' + name,
      dataType: 'Double', description: 'Production result ' + i + ' for the completed part.',
      value: { timestamped_get: () => {
        noteResultRead(name);
        return new DataValue({
          value: new Variant({ dataType: DataType.Double, value: results[name] }),
          statusCode: StatusCodes.Good, sourceTimestamp: new Date()
        });
      } }
    });
  }

  /* ── cycle lifecycle ──────────────────────────────────────────────────────────────────────── */
  function open(n, source, clickedAt) {
    /* A cycle already waiting is not overwritten silently: it is closed as abandoned and kept, so a
       demo that fires faster than the collector can answer shows up as abandoned cycles rather than
       as a suspiciously clean average. */
    if (current) { current.abandoned = true; close(current); }
    state.ProductionComplete = n;
    state.BatchId = 'B' + String(100000 + n);
    for (let i = 1; i <= MAX_RESULT_TAGS; i++) {
      results[resultName(i)] = i <= cfg.resultTags ? Math.round((Math.random() * 1000) * 100) / 100 : 0;
    }
    current = {
      seq: n, source: source || 'api', batchId: state.BatchId,
      resultTags: cfg.resultTags,
      /* clickedAt is the CALLER'S clock, and it is the only stamp here that is. Everything else is
         taken by this process. Every machine involved is the same physical host, so the arithmetic
         holds — but the field is named for its origin so that stops being an assumption the moment
         this runs somewhere the clocks differ. */
      clickedAt: clickedAt || null,
      t0: Date.now(), tFirstRead: null, tLastRead: null, tAck: null,
      reads: 0, tagsRead: {}, abandoned: false,
      /* Filled in later by the flow itself, which is the only party that knows when it woke up.
         Until it reports, a cycle is honest about not knowing. */
      trace: null
    };
    return current;
  }

  /* The flow's own stamps, posted back after it has finished. This is what makes "value picked up"
     measurable at all: the cell knows when it raised the flag and when tags were fetched, but only
     the flow knows when it was HANDED the notification — the gap between those two is the gateway's
     detection path, and without this call it can only be inferred from the first read. */
  function trace(t) {
    const n = Number(t.seq);
    const c = (current && current.seq === n) ? current : cycles.slice().reverse().find(x => x.seq === n);
    if (!c) { return { matched: false, seq: n, reason: 'no cycle with that sequence number' }; }
    const num = v => (v === undefined || v === null || Number.isNaN(Number(v)) ? null : Number(v));
    c.trace = {
      flowStart: num(t.flowStart), afterFlagRead: num(t.afterFlagRead),
      afterCollect: num(t.afterCollect), afterAck: num(t.afterAck),
      reportedAt: Date.now(), flowId: t.flowId || null
    };
    return { matched: true, seq: n };
  }

  function ack(n) {
    if (!current || n !== current.seq) { return; }
    current.tAck = Date.now();
    state.PartCount++;
    state.CycleMs = current.tAck - current.t0;
    /* The PLC drops the flag only on a matching acknowledgement — the whole point of the pattern.
       An unmatched write leaves the flag up, which is exactly what a real line would do. */
    state.ProductionComplete = 0;
    close(current);
    current = null;
  }

  function close(c) {
    c.closedAt = Date.now();
    cycles.push(c);
    if (cycles.length > MAX_CYCLES) { cycles.splice(0, cycles.length - MAX_CYCLES); }
  }

  /* Derived timings are computed on read, not stored, so a cycle still in flight reports what it
     knows so far instead of nulls that have to be special-cased by every consumer. */
  /* ── the transaction timeline ──────────────────────────────────────────────────────────────
     One row per thing that happened, in the order it happened, each with the duration of the step
     that ENDED at it. Two rules make it trustworthy rather than decorative:

     `by` names who stamped it, so a reader can see that the interesting number — the gap between
     the flag going up and the flow waking — is measured by two different parties and is therefore
     not something either of them could have flattered.

     A step whose end stamp is missing is emitted with a null duration rather than dropped. A
     timeline that silently omits the step that did not happen is how a half-finished transaction
     comes to look like a fast one. */
  function timeline(c) {
    const t = c.trace || {};
    const steps = [
      { key: 'request', label: 'Button clicked → PLC raised the flag',
        at: c.t0, from: c.clickedAt, by: 'caller + cell',
        detail: 'the control API call that stands in for the PLC completing a part' },
      { key: 'pickup', label: 'Flag raised → gateway picked the change up',
        at: t.flowStart, from: c.t0, by: 'cell + flow',
        detail: 'OPC UA monitored item, driver publish, local queue, flow started' },
      { key: 'readFlag', label: 'Flow read the completion flag',
        at: t.afterFlagRead, from: t.flowStart, by: 'flow',
        detail: 'one OPC UA read: ProductionComplete and BatchId' },
      { key: 'collect', label: 'Flow read ' + c.resultTags + ' result tags',
        at: t.afterCollect, from: t.afterFlagRead, by: 'flow',
        detail: 'one OPC UA read for the whole payload' },
      /* The write leg ends where the PLC SEES it, not where the flow finishes waiting. The cell
         stamps tAck inside the OPC UA write handler, so it lands strictly before the flow's own
         afterAck — measuring flow-to-flow reported this as negative time, which was the boundary
         being drawn in the wrong place rather than a clock problem. The moment the line is free to
         move is the one the line observed. */
      { key: 'acknowledge', label: 'Flow wrote the acknowledgement tag — PLC saw it',
        at: c.tAck, from: t.afterCollect, by: 'flow → cell',
        detail: 'one OPC UA write: DataCollected = sequence number. This is the moment the line is free to move.' },
      { key: 'settle', label: 'Write call returned to the flow',
        at: t.afterAck, from: c.tAck, by: 'cell → flow',
        detail: 'the driver carrying the acknowledgement back — after the line already moved on' }
    ];
    return steps.map(s => {
      const ms = (s.at === null || s.at === undefined || s.from === null || s.from === undefined)
        ? null : s.at - s.from;
      return {
        key: s.key, label: s.label, detail: s.detail, by: s.by,
        at: s.at === undefined ? null : s.at,
        ms,
        /* A negative step is never rounded to zero or dropped. It means two parties disagree about
           the order of events, which is either a boundary drawn in the wrong place or clocks that
           are not what this assumes — both worth seeing immediately rather than discovering later
           in an average. */
        suspect: ms !== null && ms < 0
      };
    });
  }

  function view(c) {
    const distinct = Object.keys(c.tagsRead).length;
    const steps = timeline(c);
    const known = steps.filter(s => s.ms !== null).reduce((a, s) => a + s.ms, 0);
    return {
      seq: c.seq, batchId: c.batchId, source: c.source, resultTags: c.resultTags,
      clickedAt: c.clickedAt,
      t0: c.t0, tFirstRead: c.tFirstRead, tLastRead: c.tLastRead, tAck: c.tAck,
      complete: c.tAck !== null, abandoned: c.abandoned,
      reads: c.reads, distinctTagsRead: distinct,
      /* the tag list is only complete if the collector fetched every result the PLC froze */
      collectedAll: distinct >= c.resultTags,
      trace: c.trace,
      timeline: steps,
      /* Accounted-for time vs the wall clock. If these diverge, time is being spent somewhere the
         timeline does not name, and that is worth seeing rather than rounding away. */
      accountedMs: known,
      /* Measured against the LAST stamp in the timeline, not against tAck. The write-return step
         lands after the PLC already moved on, so comparing to tAck made the accounting look 8 ms
         short when nothing was missing — an error in the check, which would have been read as an
         error in the thing being checked. */
      unaccountedMs: (() => {
        const ends = steps.map(s => s.at).filter(a => typeof a === 'number');
        if (!ends.length || c.clickedAt === null || c.clickedAt === undefined) { return null; }
        return (Math.max.apply(null, ends) - c.clickedAt) - known;
      })(),
      ms: {
        /* PLC raises the flag -> first tag actually fetched. Detection: subscription notification,
           routing, and the flow reaching its first read. This is the number that surprises people. */
        detect: c.tFirstRead === null ? null : c.tFirstRead - c.t0,
        /* first fetch -> last fetch. The cost of the payload itself. */
        collect: c.tFirstRead === null || c.tLastRead === null ? null : c.tLastRead - c.tFirstRead,
        /* last fetch -> acknowledgement lands. The write leg. */
        acknowledge: c.tAck === null || c.tLastRead === null ? null : c.tAck - c.tLastRead,
        /* what the PLC waited, start to finish. Everything else is a breakdown of this. */
        total: c.tAck === null ? null : c.tAck - c.t0
      }
    };
  }

  function setAuto(ms) {
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
    cfg.autoMs = Math.max(0, Number(ms) || 0);
    if (cfg.autoMs > 0) {
      autoTimer = setInterval(() => { seq++; open(seq, 'auto'); }, cfg.autoMs);
      /* A demo left in auto mode with nothing collecting would fill the buffer with abandoned
         cycles. That is the honest picture, so it is allowed — and it is visible as such. */
    }
  }

  /* ── control surface, mounted by the simulator's http listener ─────────────────────────── */
  const routes = {
    'GET /handshake/state': () => ({
      area: AREA, cell: CELL,
      config: { resultTags: cfg.resultTags, maxResultTags: MAX_RESULT_TAGS, autoMs: cfg.autoMs },
      tags: {
        productionComplete: nodeIdFor('ProductionComplete'),
        dataCollected: nodeIdFor('DataCollected'),
        batchId: nodeIdFor('BatchId'),
        cycleMs: nodeIdFor('CycleMs'),
        results: Array.from({ length: cfg.resultTags }, (_, i) => nodeIdFor(resultName(i + 1)))
      },
      values: { ...state },
      inFlight: current ? view(current) : null,
      cycleCount: cycles.length
    }),

    'GET /handshake/cycles': q => {
      const limit = Math.min(MAX_CYCLES, Math.max(1, parseInt(q.get('limit') || '50', 10)));
      const rows = cycles.slice(-limit).map(view).reverse();
      return { count: rows.length, cycles: rows, inFlight: current ? view(current) : null };
    },

    /* Fire one cycle and return immediately. The caller then collects and acknowledges; the cycle
       is read back from /handshake/cycles once it closes. Deliberately NOT a blocking call that
       waits for the ack — a blocking call would put the harness's own scheduling inside the
       measured interval. */
    'POST /handshake/fire': body => {
      seq++;
      const c = open(seq, body && body.source ? String(body.source) : 'api',
        body && body.clickedAt ? Number(body.clickedAt) : null);
      return { fired: c.seq, batchId: c.batchId, t0: c.t0, resultTags: c.resultTags,
               clickedAt: c.clickedAt, productionCompleteNodeId: nodeIdFor('ProductionComplete') };
    },

    /* Posted by the flow once it has finished, through an HTTPClient device. Deliberately the LAST
       thing the flow does: it is instrumentation, and instrumentation that runs inside the interval
       it measures is measuring itself. */
    'POST /handshake/trace': body => trace(body || {}),

    'POST /handshake/config': body => {
      if (body.resultTags != null) {
        cfg.resultTags = Math.min(MAX_RESULT_TAGS, Math.max(1, parseInt(body.resultTags, 10) || DEFAULT_RESULT_TAGS));
      }
      if (body.autoMs != null) { setAuto(body.autoMs); }
      return { resultTags: cfg.resultTags, autoMs: cfg.autoMs, maxResultTags: MAX_RESULT_TAGS };
    },

    /* Drop the flag WITHOUT resetting the sequence counter. A probe that wants to see repeated
       notifications has to make the tag actually change; re-firing after a full reset re-uses
       sequence 1 every time, the value never changes, and a correctly-working subscription looks
       like one that is losing notifications. */
    'POST /handshake/clear': () => {
      if (current) { current.abandoned = true; close(current); current = null; }
      state.ProductionComplete = 0;
      return { cleared: true, nextSeq: seq + 1 };
    },

    'POST /handshake/reset': () => {
      cycles.length = 0; current = null; seq = 0;
      state.ProductionComplete = 0; state.DataCollected = 0; state.PartCount = 0; state.CycleMs = 0;
      setAuto(0);
      return { reset: true };
    }
  };

  return { routes, nodeIdFor, resultName, get cfg() { return cfg; } };
}

module.exports = { build, AREA, CELL, DEFAULT_RESULT_TAGS, MAX_RESULT_TAGS };
