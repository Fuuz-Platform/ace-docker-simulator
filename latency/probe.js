#!/usr/bin/env node
/*
 * probe.js — what does the Fuuz edge gateway actually cost?
 *
 * WHAT THIS IS FOR. "Is the gateway fast enough" is never answerable in the abstract; it is
 * answerable against a line's cycle time. So every number here is measured against a control that
 * has no Fuuz in it, and the report says what the gateway ADDS rather than what it took. A client
 * can point at their own PLC handshake budget and see immediately whether it fits.
 *
 * THE LEGS, smallest to largest — each one contains the one above it, so subtracting is meaningful:
 *
 *   floor          HTTP in, response out. Two nodes, no device, no cloud. Gateway overhead alone.
 *   httpDevice     + one call to a local HTTP service through an HTTPClient device.
 *   opcuaRead      + one OPC UA Read of N tags through an opcuaClient device. Swept over N.
 *   opcuaWrite     + a write back.
 *   handshake      the whole PLC pattern: flag raised, N tags collected, acknowledgement written,
 *                  TIMED BY THE PLC ITSELF rather than by the client that drove it.
 *
 * And the controls, which are the reason any of the above means anything:
 *
 *   baselineRead   the same OPC UA Read, same server, from a plain node-opcua session with no
 *                  gateway in the path (ace-bridge holds one open).
 *   baselineWatch  an OPC UA subscription on the trigger tag, reporting the gap between the value's
 *                  source timestamp and the notification arriving. This is the DETECTION floor: no
 *                  flow can beat it, because it is set by the subscription's sampling interval.
 *   directHttp     the same local HTTP service called directly.
 *   cloudFlow      the same tenant's CLOUD flow engine, for scale. (On this tenant it does not
 *                  answer at all — reported as such, not quietly omitted.)
 *
 * MEASUREMENT RULES, applied everywhere:
 *   - Client-side timing uses hrtime around the whole call. Gateway-side stamps come from $millis()
 *     inside the flow. Both are reported; neither is derived from the other, so a disagreement is
 *     visible instead of averaged away.
 *   - The first samples of a run are kept separately as `cold`, never mixed into the percentiles.
 *     A connection being established is a real cost, but it is not the steady-state cost, and one
 *     cold sample in twenty moves a p95 more than anything the gateway does.
 *   - Percentiles are reported from p50 to p99 with the sample count beside them. A p99 over 20
 *     samples is one sample; saying so is the difference between a measurement and a claim.
 */
'use strict';

const IN_CONTAINER = require('fs').existsSync('/.dockerenv');
const HOST = IN_CONTAINER ? 'host.docker.internal' : 'localhost';

const CFG = {
  edge:   process.env.EDGE_URL   || 'http://' + HOST + ':5510',
  sim:    process.env.SIM_URL    || 'http://' + HOST + ':4841',
  bridge: process.env.BRIDGE_URL || (IN_CONTAINER ? 'http://ace-bridge:4842' : 'http://localhost:4842'),
  hist:   process.env.HIST_URL   || (IN_CONTAINER ? 'http://ace-graphql:8098' : 'http://localhost:8098'),
  tenant: process.env.FUUZ_TENANT_KEY || 'enterprise'
};

const HANDSHAKE = {
  productionComplete: 'ns=1;s=LINE1/CELL01/ProductionComplete',
  dataCollected:      'ns=1;s=LINE1/CELL01/DataCollected',
  batchId:            'ns=1;s=LINE1/CELL01/BatchId',
  result:             i => 'ns=1;s=LINE1/CELL01/Result_' + (i < 10 ? '0' : '') + i
};
/* Plant tags, used when a sweep needs more nodes than the handshake cell freezes. Kept as a
   generator rather than a list so a sweep size can never silently exceed what exists. */
const PLANT_UNITS = ['PKG/CAP-001', 'PKG/CP-002', 'PKG/FIL-003', 'PKG/PAL-001',
                     'UTL/CHL-002', 'UTL/CMP-001', 'UTL/PMP-003', 'UTL/BLR-001'];
const PLANT_SIGNALS = ['Running', 'Faulted', 'MotorTemp', 'Speed', 'Vibration',
                       'Pressure', 'GoodCount', 'RejectCount', 'SpeedSP', 'Mode', 'BatchId'];
function plantTags(n) {
  const out = [];
  for (const u of PLANT_UNITS) {
    for (const s of PLANT_SIGNALS) { if (out.length < n) { out.push('ns=1;s=' + u + '/' + s); } }
  }
  return out;
}

/* ── plumbing ─────────────────────────────────────────────────────────────────────────────── */

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function timedFetch(url, opts, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs || 30000);
  const t = process.hrtime.bigint();
  try {
    const res = await fetch(url, { ...opts, signal: ctl.signal });
    const text = await res.text();
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (e) { body = { _raw: text.slice(0, 400) }; }
    return { ok: res.ok, status: res.status, ms, body };
  } catch (e) {
    return { ok: false, status: 0, ms: Number(process.hrtime.bigint() - t) / 1e6,
             body: null, error: String(e.message).slice(0, 200) };
  } finally { clearTimeout(timer); }
}

const post = (base, path, payload, timeoutMs) => timedFetch(base + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {})
}, timeoutMs);
const get = (base, path, timeoutMs) => timedFetch(base + path, { method: 'GET' }, timeoutMs);

/* ── statistics ───────────────────────────────────────────────────────────────────────────── */

function pct(sorted, p) {
  if (!sorted.length) { return null; }
  /* Nearest-rank. With 20 samples there is no honest interpolation to do, and a rank keeps every
     reported figure an actually-observed value rather than a computed one. */
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

function stats(values) {
  const v = values.filter(x => typeof x === 'number' && Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (!v.length) { return { n: 0 }; }
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) * (b - mean), 0) / v.length);
  const r = x => x === null ? null : Math.round(x * 100) / 100;
  return { n: v.length, min: r(v[0]), p50: r(pct(v, 50)), p90: r(pct(v, 90)), p95: r(pct(v, 95)),
           p99: r(pct(v, 99)), max: r(v[v.length - 1]), mean: r(mean), sd: r(sd) };
}

/* ── scenarios ────────────────────────────────────────────────────────────────────────────── */

const S = {};

S.floor = {
  label: 'Edge flow floor',
  detail: 'Request in, response out. Two nodes, no device, no cloud call. This is the gateway\'s own overhead and the baseline every other edge number sits on top of.',
  control: null,
  async run({ iterations, warmup }) {
    const client = [], inGateway = [], cold = [];
    for (let i = 0; i < iterations + warmup; i++) {
      const t0 = Date.now();
      const r = await post(CFG.edge, '/echo', { seq: i, tSent: t0 });
      if (!r.ok || !r.body || r.body.SUCCESS !== true) {
        return { error: r.error || 'echo failed: HTTP ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 200) };
      }
      if (i < warmup) { cold.push(r.ms); continue; }
      client.push(r.ms);
      /* tEnter is stamped by the response node; the client's own clock brackets it. The difference
         is transport plus the gateway's HTTP layer — not something either side can see alone. */
      if (typeof r.body.tEnter === 'number') { inGateway.push(r.body.tEnter - t0); }
    }
    return { series: { clientRoundTrip: stats(client), coldStart: stats(cold) }, cold, raw: { client } };
  }
};

S.httpDevice = {
  label: 'HTTP device call',
  detail: 'Edge flow calling a local HTTP service through an HTTPClient device. This is the shape every REST integration at the edge takes — a local MES, a scale, a printer.',
  control: 'directHttp',
  async run({ iterations, warmup }) {
    const client = [], inFlow = [], call = [], cold = [];
    for (let i = 0; i < iterations + warmup; i++) {
      const r = await post(CFG.edge, '/httpdev', { seq: i, path: '/health' });
      if (!r.ok || !r.body || r.body.SUCCESS !== true) {
        return { error: r.error || 'httpdev failed: ' + JSON.stringify(r.body).slice(0, 200) };
      }
      if (i < warmup) { cold.push(r.ms); continue; }
      client.push(r.ms);
      inFlow.push(r.body.ms.inFlow);
      call.push(r.body.ms.call);
    }
    return { series: { clientRoundTrip: stats(client), deviceCall: stats(call), inFlow: stats(inFlow),
                       coldStart: stats(cold) }, raw: { client, call } };
  }
};

S.directHttp = {
  label: 'Local HTTP service, direct',
  detail: 'The same service the HTTP device calls, called directly with no gateway in the path. The control for httpDevice.',
  control: null,
  async run({ iterations, warmup }) {
    const direct = [], cold = [];
    for (let i = 0; i < iterations + warmup; i++) {
      const r = await get(CFG.hist, '/health');
      if (!r.ok) { return { error: r.error || 'historian health failed: HTTP ' + r.status }; }
      if (i < warmup) { cold.push(r.ms); continue; }
      direct.push(r.ms);
    }
    return { series: { direct: stats(direct), coldStart: stats(cold) }, raw: { direct } };
  }
};

S.opcuaRead = {
  label: 'OPC UA read through the gateway',
  detail: 'An edge flow reading N tags from the PLC through an opcuaClient device, swept over N so the fixed cost and the per-tag cost separate.',
  control: 'baselineRead',
  async run({ iterations, warmup, sweep }) {
    const bySize = {};
    for (const n of sweep) {
      const tags = plantTags(n);
      if (tags.length < n) { bySize[n] = { error: 'only ' + tags.length + ' plant tags exist' }; continue; }
      const client = [], read = [], inFlow = [];
      let returned = null, failed = null;
      for (let i = 0; i < iterations + warmup; i++) {
        const r = await post(CFG.edge, '/probe', { seq: i, tags });
        if (!r.ok || !r.body || r.body.SUCCESS !== true) {
          failed = r.error || JSON.stringify(r.body).slice(0, 200); break;
        }
        if (i < warmup) { continue; }
        client.push(r.ms);
        read.push(r.body.ms.read);
        inFlow.push(r.body.ms.inFlow);
        returned = r.body.tagsReturned;
      }
      bySize[n] = failed ? { error: failed }
        : { tags: n, tagsReturned: returned,
            series: { clientRoundTrip: stats(client), read: stats(read), inFlow: stats(inFlow) },
            raw: { read } };
    }
    return { bySize };
  }
};

S.baselineRead = {
  label: 'OPC UA read, no gateway',
  detail: 'The same Read service call to the same server from a plain OPC UA session. The control for opcuaRead: the difference between the two is what the gateway adds.',
  control: null,
  async run({ iterations, sweep }) {
    const bySize = {};
    for (const n of sweep) {
      const nodeIds = plantTags(n);
      if (nodeIds.length < n) { bySize[n] = { error: 'only ' + nodeIds.length + ' plant tags exist' }; continue; }
      const r = await post(CFG.bridge, '/baseline/read', { nodeIds, iterations });
      bySize[n] = (!r.ok || !r.body || !r.body.samplesMs)
        ? { error: r.error || 'bridge baseline unavailable: HTTP ' + r.status }
        : { tags: n, series: { direct: stats(r.body.samplesMs) }, raw: { direct: r.body.samplesMs } };
    }
    return { bySize };
  }
};

S.opcuaWrite = {
  label: 'OPC UA write through the gateway',
  detail: 'A read followed by a write back to the PLC — the acknowledgement half of a handshake, measured on its own.',
  control: null,
  async run({ iterations, warmup }) {
    const client = [], write = [], read = [];
    for (let i = 0; i < iterations + warmup; i++) {
      const r = await post(CFG.edge, '/probe', {
        seq: i,
        tags: [HANDSHAKE.productionComplete],
        /* Writing DataCollected with a sequence number no cycle is waiting on is deliberately
           inert: the cell only acknowledges a MATCHING number, so this measures the write leg
           without silently closing a handshake and corrupting the handshake scenario's data. */
        write: [{ nodeId: HANDSHAKE.dataCollected, value: -1, dataType: 'Int32' }]
      });
      if (!r.ok || !r.body || r.body.SUCCESS !== true) {
        return { error: r.error || JSON.stringify(r.body).slice(0, 200) };
      }
      if (i < warmup) { continue; }
      client.push(r.ms); write.push(r.body.ms.write); read.push(r.body.ms.read);
    }
    return { series: { clientRoundTrip: stats(client), write: stats(write), read: stats(read) },
             raw: { write } };
  }
};

S.baselineWatch = {
  label: 'OPC UA subscription detection floor',
  detail: 'A monitored item on the trigger tag: the gap between the value\'s own source timestamp and the notification arriving. No flow can detect a tag change faster than this, because the subscription decides it.',
  control: null,
  async run({ iterations, samplingMs }) {
    const ms = samplingMs || 250;
    /* Arm first, then drive changes. Asking for the watcher creates it, so a first call that
       returns nothing is expected rather than a failure. */
    const armed = await post(CFG.bridge, '/baseline/watch', { nodeId: HANDSHAKE.productionComplete, samplingMs: ms });
    if (!armed.ok) { return { error: armed.error || 'bridge watch unavailable: HTTP ' + armed.status }; }
    await sleep(Math.max(500, ms * 2));
    const since = Date.now();
    for (let i = 0; i < iterations; i++) {
      await post(CFG.sim, '/handshake/fire', { source: 'watch-probe' });
      await sleep(Math.max(120, ms + 80));
      /* Clear the flag so the next fire is a genuine value CHANGE — and clear, not reset: reset
         takes the sequence counter back to zero, so every fire would raise the same 1, the value
         would never change, and a healthy subscription would report nothing and look broken. */
      await post(CFG.sim, '/handshake/clear', {});
      /* Both the raise and the clear have to survive a full sampling window. A subscription
         reports the value it SAMPLED, not every value that existed: raise and clear inside one
         window coalesce into one notification, which reads as lost notifications when it is really
         the probe outrunning the sampler it is measuring. */
      await sleep(ms + 100);
    }
    await sleep(Math.max(400, ms + 200));
    const r = await post(CFG.bridge, '/baseline/watch', { nodeId: HANDSHAKE.productionComplete, samplingMs: ms, sinceMs: since });
    if (!r.ok || !r.body) { return { error: r.error || 'watch read failed' }; }
    const lags = (r.body.events || []).map(e => e.noticeLagMs).filter(x => typeof x === 'number');
    /* Each iteration raises the flag and clears it, so a healthy subscription yields two
       notifications per iteration. Reporting expected beside observed makes coalescing visible
       instead of leaving a thin sample set looking like a full one. */
    return { samplingMs: ms, notifications: (r.body.events || []).length,
             notificationsExpected: iterations * 2,
             series: { notificationLag: stats(lags) }, raw: { lags },
             note: 'Fewer notifications than edges driven is normal and not loss: a subscription reports the value it SAMPLED, so a raise and a clear falling inside one sampling window arrive as one notification. The lag distribution is what this scenario measures; the counts are shown so a thin sample set is never mistaken for a full one.' };
  }
};

S.handshake = {
  label: 'PLC production-complete handshake',
  detail: 'The whole pattern in one edge flow: the cell raises a completion flag, the flow reads it, routes on it, reads back every result tag and writes the acknowledgement. Timed by the CELL, not by the client that drove it — this is what the PLC waits.',
  control: 'baselineWatch',
  async run({ iterations, warmup, resultTags }) {
    const n = resultTags || 40;
    const cfg = await post(CFG.sim, '/handshake/config', { resultTags: n });
    if (!cfg.ok) { return { error: cfg.error || 'cannot configure handshake cell: HTTP ' + cfg.status }; }
    await post(CFG.sim, '/handshake/reset', {});

    const rows = [];
    for (let i = 0; i < iterations + warmup; i++) {
      const fired = await post(CFG.sim, '/handshake/fire', { source: 'latency-harness' });
      if (!fired.ok || !fired.body) { return { error: 'fire failed: ' + (fired.error || fired.status) }; }
      const seq = fired.body.fired;

      /* The collector is the PRODUCTION-SHAPED flow, not the parameterised probe: it is told
         nothing but the result-tag count, and reads the flag, routes on it, collects and
         acknowledges by itself. Driving the probe flow here instead would let the harness choose
         what the gateway reads, and the measurement would partly be of the test script.

         In production the trigger is the tag change itself; here the harness plays that part, so
         the FLOW's cost is measured without the trigger's cost folded in. The detection leg is
         measured separately by baselineWatch and reported beside it — added together they are the
         production number, and keeping them apart is what shows which half to fix. */
      const r = await post(CFG.edge, '/handshake', { resultTags: n });
      if (!r.ok || !r.body || r.body.SUCCESS !== true) {
        return { error: r.error || JSON.stringify(r.body).slice(0, 200) };
      }
      if (r.body.action !== 'collected') {
        return { error: 'flow routed to "' + r.body.action + '" for sequence ' + seq +
                 ' — the completion flag was not seen, so nothing was collected' };
      }
      if (r.body.complete === false) {
        return { error: 'flow collected ' + r.body.resultTagsGot + ' of ' + r.body.resultTagsAsked + ' result tags' };
      }
      rows.push({ warm: i >= warmup, seq: r.body.seq, clientMs: r.ms,
                  flow: { read: r.body.ms.readFlag + r.body.ms.collect,
                          write: r.body.ms.acknowledge, inFlow: r.body.ms.total } });
      await sleep(40);
    }

    /* What the CELL saw. The flow's own opinion of how long it took is a claim; the cell's record
       is evidence, and it is the only place the collection can be checked for completeness. */
    const cyc = await get(CFG.sim, '/handshake/cycles?limit=' + (iterations + warmup));
    const cycles = ((cyc.body || {}).cycles || []).filter(c => c.complete);
    const bySeq = {};
    cycles.forEach(c => { bySeq[c.seq] = c; });
    const warm = rows.filter(r => r.warm && bySeq[r.seq]);

    const plc = warm.map(r => bySeq[r.seq]);
    const incomplete = plc.filter(c => !c.collectedAll);

    return {
      resultTags: n,
      cyclesMeasured: warm.length,
      /* A cycle where the collector did not fetch every frozen result is not a fast cycle, it is a
         wrong one. Surfaced as a count, never filtered out of the statistics silently. */
      incompleteCollections: incomplete.length,
      readAmplification: plc.length ? Math.round((plc.reduce((a, c) => a + c.reads, 0) /
        plc.reduce((a, c) => a + c.distinctTagsRead, 0)) * 100) / 100 : null,
      series: {
        plcTotal:       stats(plc.map(c => c.ms.total)),
        plcDetect:      stats(plc.map(c => c.ms.detect)),
        plcCollect:     stats(plc.map(c => c.ms.collect)),
        plcAcknowledge: stats(plc.map(c => c.ms.acknowledge)),
        flowRead:       stats(warm.map(r => r.flow.read)),
        flowWrite:      stats(warm.map(r => r.flow.write)),
        flowTotal:      stats(warm.map(r => r.flow.inFlow)),
        clientRoundTrip: stats(warm.map(r => r.clientMs))
      },
      raw: { plcTotal: plc.map(c => c.ms.total), flowTotal: warm.map(r => r.flow.inFlow) },
      note: 'plcDetect here is the harness\'s own scheduling, NOT the gateway: in this scenario the harness plays the trigger. Read it together with baselineWatch, which measures what a real subscription-driven detection costs.'
    };
  }
};

S.tagTriggered = {
  label: 'Tag-triggered handshake (nothing calls the flow)',
  detail: 'The real thing. The cell raises the flag and NOTHING pokes the gateway — a DeviceSubscription on that one tag wakes edgePlcHandshakeTopic, which reads the flag, routes, collects every result tag and writes the acknowledgement. The harness only fires the flag and then reads what the cell recorded.',
  control: 'baselineWatch',
  async run({ iterations, warmup, resultTags, spacingMs }) {
    const n = resultTags || 40;
    const gap = spacingMs || 3000;
    const cfg = await post(CFG.sim, '/handshake/config', { resultTags: n });
    if (!cfg.ok) { return { error: cfg.error || 'cannot configure handshake cell: HTTP ' + cfg.status }; }
    await post(CFG.sim, '/handshake/reset', {});

    for (let i = 0; i < iterations + warmup; i++) {
      const fired = await post(CFG.sim, '/handshake/fire', { source: 'tag-triggered' });
      if (!fired.ok) { return { error: 'fire failed: ' + (fired.error || fired.status) }; }
      /* Spacing, not polling. Waiting for each cycle to close would be faster but would make the
         harness a participant again — and the whole point of this scenario is that nothing on this
         side touches the gateway between raising the flag and reading the log. */
      await sleep(gap);
    }

    const cyc = await get(CFG.sim, '/handshake/cycles?limit=' + (iterations + warmup));
    const all = ((cyc.body || {}).cycles || []).slice().reverse();   /* oldest first */
    const warm = all.slice(warmup);
    const done = warm.filter(c => c.complete);
    if (!done.length) {
      return { error: 'no cycle completed — the flow did not wake. Check that edgePlcHandshakeTopic ' +
                      'is bound to the gateway and that the DeviceSubscription still exists.' };
    }
    const incomplete = done.filter(c => !c.collectedAll);

    return {
      resultTags: n,
      cyclesFired: warm.length,
      cyclesCompleted: done.length,
      /* A cycle the flow never answered is the failure this scenario exists to catch, and it is
         reported as a count rather than filtered out of the statistics. */
      cyclesAbandoned: warm.length - done.length,
      incompleteCollections: incomplete.length,
      readAmplification: Math.round((done.reduce((a, c) => a + c.reads, 0) /
        done.reduce((a, c) => a + c.distinctTagsRead, 0)) * 100) / 100,
      series: {
        total:       stats(done.map(c => c.ms.total)),
        detect:      stats(done.map(c => c.ms.detect)),
        collect:     stats(done.map(c => c.ms.collect)),
        acknowledge: stats(done.map(c => c.ms.acknowledge))
      },
      raw: { total: done.map(c => c.ms.total), detect: done.map(c => c.ms.detect) },
      note: 'Here `detect` IS the gateway: OPC UA monitored item, driver publish, local queue, flow start, first read. Nothing in this scenario is the harness\'s scheduling.'
    };
  }
};

S.cloudFlow = {
  label: 'Cloud flow execution',
  detail: 'The same tenant\'s cloud flow engine, for scale against the edge numbers.',
  control: null,
  async run({ cloudTimeoutMs }) {
    let executeFlow, SERVERS;
    try { ({ executeFlow, SERVERS } = require('../platform/fuuz-api')); }
    catch (e) { return { skipped: 'fuuz-api not resolvable from here: ' + e.message }; }
    const tenant = SERVERS[CFG.tenant] || CFG.tenant;
    const t = Date.now();
    const timeout = cloudTimeoutMs || 25000;
    const result = await Promise.race([
      executeFlow(tenant, 'ctxPing', {}).then(r => ({ ok: true, r })).catch(e => ({ ok: false, e })),
      sleep(timeout).then(() => ({ timedOut: true }))
    ]);
    const ms = Date.now() - t;
    if (result.timedOut) {
      return { unavailable: true, ms,
               error: 'cloud flow execution did not answer within ' + timeout + ' ms — the tenant\'s flow-execution worker accepts and queues the request and nothing runs it. Edge flows are pulled and run by the gateway, so they are unaffected.' };
    }
    if (!result.ok) { return { unavailable: true, ms, error: String(result.e.message).slice(0, 300) }; }
    return { series: { cloudRoundTrip: stats([ms]) }, note: 'single execution' };
  }
};

/* ── runner ───────────────────────────────────────────────────────────────────────────────── */

const ORDER = ['floor', 'httpDevice', 'directHttp', 'opcuaRead', 'baselineRead',
               'opcuaWrite', 'baselineWatch', 'handshake', 'tagTriggered', 'cloudFlow'];

function scenarios() {
  return ORDER.map(id => ({ id, label: S[id].label, detail: S[id].detail, control: S[id].control }));
}

async function preflight() {
  const checks = {};
  const probes = [
    ['edge', () => get(CFG.edge, '/', 4000)],
    ['sim', () => get(CFG.sim, '/handshake/state', 4000)],
    ['bridge', () => get(CFG.bridge, '/health', 4000)],
    ['historian', () => get(CFG.hist, '/health', 4000)]
  ];
  for (const [name, fn] of probes) {
    const r = await fn();
    /* The edge trigger answers 404 on / — it only knows its configured paths. Reachable is what is
       being checked, so a 404 is a pass and a connection error is not. */
    checks[name] = { reachable: r.status > 0, status: r.status, ms: Math.round(r.ms * 100) / 100,
                     error: r.error || null };
  }
  return checks;
}

async function run(opts) {
  /* Undefined keys are STRIPPED before merging, not passed through. A caller that names an option
     it does not set — which any HTTP wrapper reading fields off a request body does — would
     otherwise overwrite the default with undefined, and `iterations + warmup` becomes NaN, and
     every loop runs zero times and reports n=0 rather than failing. Silent empty results are the
     worst outcome available here, so the merge refuses to produce them. */
  const given = {};
  Object.entries(opts || {}).forEach(([k, v]) => { if (v !== undefined && v !== null) { given[k] = v; } });
  const o = Object.assign({
    only: null, iterations: 20, warmup: 3, resultTags: 40,
    sweep: [1, 5, 10, 20, 40, 80], samplingMs: 250, cloudTimeoutMs: 25000
  }, given);
  const ids = o.only && o.only.length ? ORDER.filter(id => o.only.indexOf(id) !== -1) : ORDER;

  const startedAt = new Date().toISOString();
  const health = await preflight();
  const results = {};
  for (const id of ids) {
    const t = Date.now();
    try { results[id] = await S[id].run(o); }
    catch (e) { results[id] = { error: String(e.message).slice(0, 300) }; }
    results[id].label = S[id].label;
    results[id].detail = S[id].detail;
    results[id].control = S[id].control;
    results[id].elapsedMs = Date.now() - t;
  }
  return { startedAt, finishedAt: new Date().toISOString(), config: { ...CFG, ...o }, health,
           results, verdict: verdict(results) };
}

/* The one paragraph a client actually reads. Built from the numbers rather than written, so it
   cannot drift away from them. */
function verdict(r) {
  const out = [];
  const p50 = (id, series) => {
    const s = r[id] && r[id].series && r[id].series[series];
    return s && s.n ? s.p50 : null;
  };
  const floor = p50('floor', 'clientRoundTrip');
  if (floor !== null) { out.push('Edge flow floor ' + floor + ' ms round trip.'); }

  const gw40 = r.opcuaRead && r.opcuaRead.bySize && r.opcuaRead.bySize[40];
  const bl40 = r.baselineRead && r.baselineRead.bySize && r.baselineRead.bySize[40];
  if (gw40 && gw40.series && bl40 && bl40.series) {
    const g = gw40.series.read.p50, b = bl40.series.direct.p50;
    out.push('40-tag OPC UA read: ' + g + ' ms through the gateway vs ' + b +
      ' ms direct — the gateway adds ' + Math.round((g - b) * 10) / 10 + ' ms.');
  }
  const hs = r.handshake;
  if (hs && hs.series && hs.series.plcTotal && hs.series.plcTotal.n) {
    out.push('PLC handshake over ' + hs.resultTags + ' result tags: p50 ' + hs.series.plcTotal.p50 +
      ' ms, p95 ' + hs.series.plcTotal.p95 + ' ms as measured by the cell.');
    if (hs.incompleteCollections) {
      out.push('WARNING: ' + hs.incompleteCollections + ' cycle(s) did not collect every result tag.');
    }
  }
  const tt = r.tagTriggered;
  if (tt && tt.series && tt.series.total && tt.series.total.n) {
    out.push('Tag-triggered handshake, nothing calling the flow: p50 ' + tt.series.total.p50 +
      ' ms end to end — of which ' + tt.series.detect.p50 + ' ms is the gateway noticing the tag changed and ' +
      (tt.series.total.p50 - tt.series.detect.p50) + ' ms is all the work.');
    if (tt.cyclesAbandoned) {
      out.push('WARNING: ' + tt.cyclesAbandoned + ' of ' + tt.cyclesFired +
        ' raised flags were never answered by the flow.');
    }
  }
  const bw = r.baselineWatch;
  if (bw && bw.series && bw.series.notificationLag && bw.series.notificationLag.n) {
    out.push('Subscription detection floor at ' + bw.samplingMs + ' ms sampling: p50 ' +
      bw.series.notificationLag.p50 + ' ms — add this to the handshake figure for the real trigger-driven number.');
  }
  if (r.cloudFlow && r.cloudFlow.unavailable) {
    out.push('Cloud flow execution on this tenant did not answer (' + r.cloudFlow.ms + ' ms); edge flows are unaffected because the gateway runs them locally.');
  }
  return out;
}

module.exports = { run, scenarios, stats, preflight, CFG, HANDSHAKE, plantTags };

/* ── CLI ──────────────────────────────────────────────────────────────────────────────────── */
if (require.main === module) {
  const arg = (f, d) => { const i = process.argv.indexOf(f); return i === -1 ? d : process.argv[i + 1]; };
  const only = arg('--only', null);
  const opts = {
    only: only ? only.split(',') : null,
    iterations: parseInt(arg('--iterations', '20'), 10),
    warmup: parseInt(arg('--warmup', '3'), 10),
    resultTags: parseInt(arg('--result-tags', '40'), 10),
    sweep: arg('--sweep', '1,5,10,20,40,80').split(',').map(Number)
  };
  const asJson = process.argv.indexOf('--json') !== -1;

  run(opts).then(out => {
    if (asJson) { console.log(JSON.stringify(out, null, 2)); return; }
    console.log('\nFuuz edge gateway latency — ' + out.startedAt);
    console.log('  edge=' + CFG.edge + '  sim=' + CFG.sim + '  bridge=' + CFG.bridge);
    console.log('  reachable: ' + Object.entries(out.health)
      .map(([k, v]) => k + '=' + (v.reachable ? 'yes' : 'NO')).join(' '));

    const line = (name, s) => {
      if (!s || !s.n) { return; }
      console.log('    ' + name.padEnd(22) + 'n=' + String(s.n).padEnd(5) +
        'p50 ' + String(s.p50).padStart(8) + '   p95 ' + String(s.p95).padStart(8) +
        '   max ' + String(s.max).padStart(8) + '   (ms)');
    };
    for (const id of Object.keys(out.results)) {
      const r = out.results[id];
      console.log('\n  ' + id + ' — ' + r.label);
      if (r.error) { console.log('    ERROR: ' + r.error); continue; }
      if (r.skipped) { console.log('    skipped: ' + r.skipped); continue; }
      if (r.unavailable) { console.log('    unavailable: ' + r.error); continue; }
      if (r.bySize) {
        for (const n of Object.keys(r.bySize)) {
          const b = r.bySize[n];
          if (b.error) { console.log('    ' + n + ' tags: ERROR ' + b.error); continue; }
          console.log('    ' + String(n).padStart(3) + ' tags:');
          Object.entries(b.series).forEach(([k, s]) => line('  ' + k, s));
        }
        continue;
      }
      if (r.series) { Object.entries(r.series).forEach(([k, s]) => line(k, s)); }
      if (r.incompleteCollections) { console.log('    INCOMPLETE COLLECTIONS: ' + r.incompleteCollections); }
      if (r.readAmplification && r.readAmplification !== 1) {
        console.log('    read amplification: ' + r.readAmplification + 'x (reads per distinct tag)');
      }
      if (r.notifications !== undefined) {
        console.log('    notifications: ' + r.notifications + ' observed of ' + r.notificationsExpected + ' expected');
      }
    }
    console.log('\n  VERDICT');
    out.verdict.forEach(v => console.log('    - ' + v));
    console.log('');
  }).catch(e => { console.error('FATAL ' + e.message); process.exit(1); });
}
