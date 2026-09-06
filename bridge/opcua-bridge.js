#!/usr/bin/env node
/*
 * ace-bridge — OPC UA subscription → Mongo historian.
 *
 * STAND-IN, NOT A REPLACEMENT. This does precisely what the Fuuz gateway's `nodeValues`
 * subscription will do once the `opcuaClient` driver is installed on the gateway: open a session to
 * the plant, monitor every node, and push each change into the historian. Same nodes, same node-id
 * strings, same target collection.
 *
 * It exists because the gateway currently reports `Driver opcuaClient not found` — only HTTPClient
 * is on disk, and drivers are pluggable packages the gateway does not fetch on demand. Rather than
 * leave the whole downstream chain unproven waiting on a UI install, the bridge occupies that leg so
 * the historian, the 5-minute aggregation, the pickup flags and the edge flow are all exercised for
 * real. When the driver lands, delete this container — nothing downstream changes.
 */
'use strict';
const { OPCUAClient, AttributeIds, TimestampsToReturn, MessageSecurityMode, SecurityPolicy } = require('node-opcua');

const ENDPOINT = process.env.OPCUA_ENDPOINT || 'opc.tcp://ace-sim:4840/UA/AceSim';
const GRAPHQL = process.env.VECTOR_GRAPHQL_URL || 'http://ace-graphql:8098/graphql';
const FLUSH_MS = parseInt(process.env.FLUSH_MS || '5000', 10);
const SAMPLING_MS = parseInt(process.env.SAMPLING_MS || '1000', 10);

const UNITS = [
  { area: 'PKG', code: 'CAP-001' }, { area: 'PKG', code: 'CP-002' },
  { area: 'PKG', code: 'FIL-003' }, { area: 'PKG', code: 'PAL-001' },
  { area: 'UTL', code: 'CHL-002' }, { area: 'UTL', code: 'CMP-001' },
  { area: 'UTL', code: 'PMP-003' }, { area: 'UTL', code: 'BLR-001' }
];
const SIGNALS = [
  { n: 'Running',     t: 'DISCRETE', u: '',     lo: 0,  hi: 1,       db: 0 },
  { n: 'Faulted',     t: 'DISCRETE', u: '',     lo: 0,  hi: 1,       db: 0 },
  { n: 'MotorTemp',   t: 'PROCESS',  u: 'degF', lo: 60, hi: 220,     db: 0.5 },
  { n: 'Speed',       t: 'PROCESS',  u: 'RPM',  lo: 0,  hi: 1800,    db: 5 },
  { n: 'Vibration',   t: 'PROCESS',  u: 'mm/s', lo: 0,  hi: 12,      db: 0.05 },
  { n: 'Pressure',    t: 'PROCESS',  u: 'psi',  lo: 0,  hi: 150,     db: 0.5 },
  { n: 'GoodCount',   t: 'COUNTER',  u: 'ea',   lo: 0,  hi: 1000000, db: 0 },
  { n: 'RejectCount', t: 'COUNTER',  u: 'ea',   lo: 0,  hi: 1000000, db: 0 },
  { n: 'SpeedSP',     t: 'PROCESS',  u: 'RPM',  lo: 0,  hi: 1800,    db: 1 },
  { n: 'Mode',        t: 'ENUM',     u: '',     lo: 0,  hi: 4,       db: 0 },
  { n: 'BatchId',     t: 'STRING',   u: '',     lo: 0,  hi: 0,       db: 0 }
];

/* Tag path shape mirrors what the gateway publishes, so historian rows are identical either way. */
const nodes = [];
for (const u of UNITS) {
  for (const s of SIGNALS) {
    nodes.push({ nodeId: `ns=1;s=${u.area}/${u.code}/${s.n}`, tagPath: `Plant/${u.area}/${u.code}/${s.n}`, sig: s });
  }
}

/* Deadband / exception reporting. A historian does not store every scan — it stores changes that
   exceed the tag's deadband, plus every quality transition (a Good->Bad edge is always significant
   even if the number did not move). Without this a 1 s scan writes 86,400 rows/tag/day of noise. */
const last = {};
function shouldStore(n, value, quality) {
  const prev = last[n.tagPath];
  if (!prev) { return true; }
  if (prev.quality !== quality) { return true; }            /* quality edges are never suppressed */
  if (typeof value === 'string') { return value !== prev.value; }
  if (n.sig.db === 0) { return value !== prev.value; }
  return Math.abs(value - prev.value) >= n.sig.db;
}

let buffer = [];
let written = 0;
let flushes = 0;

async function gqlPost(query, variables) {
  const r = await fetch(GRAPHQL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  const j = await r.json();
  if (j.errors) { throw new Error(JSON.stringify(j.errors).slice(0, 240)); }
  return j.data;
}

async function flush() {
  if (!buffer.length) { return; }
  const batch = buffer;
  buffer = [];
  try {
    const d = await gqlPost('mutation($p:[TagValueInput!]!){ recordTagValues(payload:$p) }', { p: batch });
    written += d.recordTagValues;
    flushes++;
    if (flushes % 12 === 1) {
      console.log(`[bridge] flushed ${d.recordTagValues} samples (total ${written}) from ${nodes.length} nodes`);
    }
  } catch (e) {
    /* never drop silently — put them back and let the next flush retry */
    buffer = batch.concat(buffer);
    console.error('[bridge] flush failed, ' + buffer.length + ' samples requeued: ' + String(e.message).slice(0, 160));
  }
}

(async () => {
  const client = OPCUAClient.create({
    endpointMustExist: false,
    securityMode: MessageSecurityMode.None,
    securityPolicy: SecurityPolicy.None,
    connectionStrategy: { initialDelay: 1000, maxRetry: 1000, maxDelay: 20000 }
  });
  client.on('backoff', (n, d) => console.log(`[bridge] retrying ${ENDPOINT} (attempt ${n}, ${d}ms)`));

  await client.connect(ENDPOINT);
  const session = await client.createSession();
  console.log('[bridge] connected: ' + ENDPOINT);

  const sub = await session.createSubscription2({
    requestedPublishingInterval: 1000, publishingEnabled: true,
    maxNotificationsPerPublish: 1000, requestedLifetimeCount: 1000, requestedMaxKeepAliveCount: 20
  });

  for (const n of nodes) {
    const mi = await sub.monitor(
      { nodeId: n.nodeId, attributeId: AttributeIds.Value },
      { samplingInterval: SAMPLING_MS, queueSize: 20, discardOldest: true },
      TimestampsToReturn.Both
    );
    mi.on('changed', dv => {
      const raw = dv.value.value;
      /* BAD SAMPLES ARE STORED, not dropped. Discarding them hides outages and makes the historian
         lie about coverage; the aggregate layer excludes them from maths instead. */
      const quality = dv.statusCode ? dv.statusCode.value : 0;
      const sample = { tagPath: n.tagPath, tagType: n.sig.t, quality: quality,
        occurredAt: (dv.sourceTimestamp || dv.serverTimestamp || new Date()).toISOString() };

      if (typeof raw === 'string') { sample.valueString = raw; }
      else if (typeof raw === 'boolean') { sample.valueBool = raw; sample.v = raw ? 1 : 0; }
      else {
        const num = Number(raw);
        if (Number.isNaN(num)) { return; }
        sample.v = num;
      }
      const cmp = sample.valueString !== undefined ? sample.valueString : sample.v;
      if (!shouldStore(n, cmp, quality)) { return; }
      last[n.tagPath] = { value: cmp, quality: quality };
      buffer.push(sample);
    });
  }
  /* Register the tag master so the historian knows each tag's units, range, deadband and — most
     importantly — its interpolation mode. */
  const masters = nodes.map(n => ({
    tagPath: n.tagPath, tagType: n.sig.t, unit: n.sig.u,
    engLow: n.sig.lo, engHigh: n.sig.hi, deadband: n.sig.db,
    deadbandType: n.sig.db > 0 ? 'ABSOLUTE' : 'NONE',
    interpolation: (n.sig.t === 'PROCESS' || n.sig.t === 'COUNTER') ? 'CONTINUOUS' : 'STEPPED',
    scanRateMs: SAMPLING_MS,
    dataType: n.sig.t === 'STRING' ? 'String' : (n.sig.t === 'PROCESS' ? 'Double' : 'Int32'),
    description: n.tagPath
  }));
  try {
    const d = await gqlPost('mutation($p:[TagMasterInput!]!){ upsertTagMaster(payload:$p) }', { p: masters });
    console.log('[bridge] tag master registered: ' + d.upsertTagMaster + ' tags');
  } catch (e) { console.error('[bridge] tag master failed: ' + String(e.message).slice(0, 160)); }

  console.log('[bridge] monitoring ' + nodes.length + ' nodes, deadband-filtered, flushing every ' + FLUSH_MS + 'ms');
  setInterval(flush, FLUSH_MS);

  /* ── the control for the latency work ─────────────────────────────────────────────────────
     A gateway latency number on its own means nothing: OPC UA itself costs something, and so does
     the simulator answering. This session is already open to the same server over the same
     protocol with no Fuuz in the path, so it is the honest baseline — subtract it and what is left
     is what the gateway adds.

     /baseline/read   one OPC UA Read service call for N nodes, timed at the client.
     /baseline/watch  a monitored item on one node with a chosen sampling interval, reporting the
                      gap between the value's sourceTimestamp and the notification arriving. That
                      is the DETECTION leg — the part of a tag-triggered handshake that no amount
                      of flow tuning can shorten, because it is set by the subscription. */
  const bhttp = require('http');
  const watchers = {};
  bhttp.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*',
                            'access-control-allow-headers': 'content-type',
                            'access-control-allow-methods': 'GET,POST,OPTIONS' });
      res.end(JSON.stringify(obj));
    };
    if (req.method === 'OPTIONS') { return send(204, {}); }

    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      let p = {};
      try { p = body ? JSON.parse(body) : {}; } catch (e) { return send(400, { error: 'bad JSON' }); }

      if (url.pathname === '/baseline/read') {
        const nodeIds = Array.isArray(p.nodeIds) && p.nodeIds.length
          ? p.nodeIds
          : nodes.slice(0, 40).map(n => n.nodeId);
        const iterations = Math.min(200, Math.max(1, parseInt(p.iterations, 10) || 20));
        const samples = [];
        try {
          for (let i = 0; i < iterations; i++) {
            const t = process.hrtime.bigint();
            /* ONE Read service call for all nodes — the same shape the gateway's driver issues, so
               the comparison is like-for-like rather than N single reads against one batch. */
            await session.read(nodeIds.map(id => ({ nodeId: id, attributeId: AttributeIds.Value })));
            samples.push(Number(process.hrtime.bigint() - t) / 1e6);
          }
        } catch (e) { return send(500, { error: String(e.message).slice(0, 300) }); }
        return send(200, { probe: 'opcua-direct-read', nodes: nodeIds.length, iterations, samplesMs: samples });
      }

      if (url.pathname === '/baseline/watch') {
        const nodeId = String(p.nodeId || 'ns=1;s=LINE1/CELL01/ProductionComplete');
        const samplingMs = Math.min(10000, Math.max(0, parseInt(p.samplingMs, 10) || 250));
        const key = nodeId + '@' + samplingMs;
        if (!watchers[key]) {
          try {
            /* Its own subscription, not the shared one: the publishing interval is half of what
               detection latency IS, and borrowing the historian's 1000 ms subscription would
               measure that choice instead of the one being asked about. */
            const wsub = await session.createSubscription2({
              requestedPublishingInterval: samplingMs, publishingEnabled: true,
              maxNotificationsPerPublish: 100, requestedLifetimeCount: 1000, requestedMaxKeepAliveCount: 20
            });
            const mi = await wsub.monitor(
              { nodeId, attributeId: AttributeIds.Value },
              { samplingInterval: samplingMs, queueSize: 10, discardOldest: true },
              TimestampsToReturn.Both
            );
            const w = { nodeId, samplingMs, events: [], lastValue: null };
            mi.on('changed', dv => {
              const src = dv.sourceTimestamp ? dv.sourceTimestamp.getTime() : null;
              w.lastValue = dv.value.value;
              w.events.push({ at: Date.now(), sourceTs: src, value: dv.value.value,
                              noticeLagMs: src === null ? null : Date.now() - src });
              if (w.events.length > 200) { w.events.splice(0, w.events.length - 200); }
            });
            watchers[key] = w;
          } catch (e) { return send(500, { error: String(e.message).slice(0, 300) }); }
        }
        const w = watchers[key];
        const since = parseInt(p.sinceMs || url.searchParams.get('sinceMs') || '0', 10);
        const events = since ? w.events.filter(e => e.at >= since) : w.events.slice(-50);
        return send(200, { probe: 'opcua-direct-watch', nodeId: w.nodeId, samplingMs: w.samplingMs,
                           lastValue: w.lastValue, eventCount: w.events.length, events });
      }

      /* Answer GET/HEAD on / so an HTTPClient device pointed here does not report DOWN — the
         gateway probes with a GET and a POST-only service looks dead to it. */
      if (url.pathname === '/' || url.pathname === '/health') {
        return send(200, { ok: true, service: 'ace-bridge', monitoring: nodes.length, endpoint: ENDPOINT });
      }
      send(404, { error: 'no route ' + req.method + ' ' + url.pathname });
    });
  }).listen(parseInt(process.env.CONTROL_PORT || '4842', 10), '0.0.0.0');
  console.log('[bridge] baseline control API on :' + (process.env.CONTROL_PORT || '4842'));

  const shutdown = async () => {
    console.log('[bridge] draining ' + buffer.length + ' buffered samples…');
    await flush();
    try { await session.close(); await client.disconnect(); } catch (e) { /* going down anyway */ }
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
})().catch(e => { console.error('[bridge] FATAL ' + e.message); process.exit(1); });
