#!/usr/bin/env node
/*
 * ace-loadgen — high-frequency historian write load.
 *
 * WHY THIS AND NOT THE BRIDGE. The OPC UA bridge exists for FIDELITY: real subscriptions, real
 * status codes, deadband/exception reporting, one sample per genuine change. It tops out around
 * tens of samples/sec because that is what 88 tags on a 1 s scan legitimately produce.
 *
 * This exists for VOLUME. It writes straight to MongoDB with unordered bulk inserts and no GraphQL
 * hop, because a per-sample JSON round trip is the bottleneck long before Mongo is — which is also
 * how real collectors work: they speak the storage protocol, not a public API.
 *
 * Run both together. The bridge proves the semantics; the loadgen proves the storage holds up.
 *
 *   TAGS=5000 RATE=5000 docker compose up -d ace-loadgen
 */
'use strict';
const { MongoClient } = require('mongodb');

const MONGO_URL = process.env.MONGO_URL || 'mongodb://ace-mongo:27017/?directConnection=true';
const DB_NAME = process.env.MONGO_DB || 'ace';
const TS_COLL = 'tagValue';
const MASTER_COLL = 'tagMaster';

const TAGS = parseInt(process.env.TAGS || '2000', 10);          /* distinct tags to simulate */
const RATE = parseInt(process.env.RATE || '2000', 10);          /* target samples per second */
const BATCH_MS = parseInt(process.env.BATCH_MS || '250', 10);   /* write cadence */
const REGISTER_MASTER = process.env.REGISTER_MASTER !== 'false';

/* Deterministic so a restart reproduces the same synthetic plant. */
let seed = 0x7f4a7c15;
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };

const AREAS = ['PKG', 'UTL', 'BLD', 'FIL', 'MIX', 'CUR', 'INS', 'SHP'];
const KINDS = [
  { n: 'Temp',      t: 'PROCESS',  u: 'degF', lo: 60,  hi: 220 },
  { n: 'Pressure',  t: 'PROCESS',  u: 'psi',  lo: 0,   hi: 150 },
  { n: 'Speed',     t: 'PROCESS',  u: 'RPM',  lo: 0,   hi: 1800 },
  { n: 'Flow',      t: 'PROCESS',  u: 'gpm',  lo: 0,   hi: 500 },
  { n: 'Vibration', t: 'PROCESS',  u: 'mm/s', lo: 0,   hi: 12 },
  { n: 'Level',     t: 'PROCESS',  u: 'pct',  lo: 0,   hi: 100 },
  { n: 'Amps',      t: 'PROCESS',  u: 'A',    lo: 0,   hi: 60 },
  { n: 'Running',   t: 'DISCRETE', u: '',     lo: 0,   hi: 1 },
  { n: 'Faulted',   t: 'DISCRETE', u: '',     lo: 0,   hi: 1 },
  { n: 'Count',     t: 'COUNTER',  u: 'ea',   lo: 0,   hi: 1000000 }
];

/* OPC UA status codes — the mix a real plant produces. */
const SC = { GOOD: 0, UNCERTAIN_LAST_USABLE: 0x40900000, BAD_NOT_CONNECTED: 0x808A0000, BAD_OUT_OF_RANGE: 0x803C0000 };

const tags = [];
for (let i = 0; i < TAGS; i++) {
  const kind = KINDS[i % KINDS.length];
  const area = AREAS[Math.floor(i / KINDS.length) % AREAS.length];
  const unit = String(1 + Math.floor(i / (KINDS.length * AREAS.length))).padStart(3, '0');
  tags.push({
    tagPath: `Plant/${area}/${kind.n.toUpperCase().slice(0, 3)}-${unit}/${kind.n}`,
    kind, value: kind.t === 'COUNTER' ? 0 : kind.lo + rnd() * (kind.hi - kind.lo),
    fault: 'NONE', faultUntil: 0
  });
}

let written = 0, batches = 0, errors = 0;
const t0 = Date.now();

function nextSample(tag, now) {
  /* ~2% of tags are in a degraded state at any moment, drifting independently. */
  if (now > tag.faultUntil) {
    const r = rnd();
    tag.fault = r < 0.010 ? 'COMMS' : (r < 0.020 ? 'STALE' : 'NONE');
    tag.faultUntil = now + (tag.fault === 'NONE' ? 30000 + rnd() * 120000 : 5000 + rnd() * 25000);
  }
  const k = tag.kind;
  let q = SC.GOOD;
  if (tag.fault === 'COMMS') { q = SC.BAD_NOT_CONNECTED; }
  else if (tag.fault === 'STALE') { q = SC.UNCERTAIN_LAST_USABLE; }
  else if (k.t === 'COUNTER') { tag.value += Math.floor(rnd() * 3); }
  else if (k.t === 'DISCRETE') { if (rnd() < 0.02) { tag.value = tag.value > 0.5 ? 0 : 1; } }
  else {
    tag.value += (rnd() - 0.5) * (k.hi - k.lo) * 0.03;
    if (rnd() < 0.0015) { tag.value = k.hi * 1.3; q = SC.BAD_OUT_OF_RANGE; }   /* spike out of range */
    if (tag.value < k.lo) { tag.value = k.lo; }
    if (tag.value > k.hi * 1.3) { tag.value = k.hi; }
  }
  const v = k.t === 'PROCESS' ? Math.round(tag.value * 100) / 100 : Math.round(tag.value);
  const doc = { ts: new Date(now), rt: new Date(), meta: { tagPath: tag.tagPath, tagType: k.t }, q, v };
  if (k.t === 'DISCRETE') { doc.vb = v > 0.5; }
  return doc;
}

(async () => {
  const client = new MongoClient(MONGO_URL, { maxPoolSize: 20 });
  await client.connect();
  const db = client.db(DB_NAME);
  const coll = db.collection(TS_COLL);
  console.log(`[loadgen] ${TAGS} tags, target ${RATE}/s, batching every ${BATCH_MS}ms`);

  if (REGISTER_MASTER) {
    const ops = tags.map(t => ({
      updateOne: {
        filter: { tagPath: t.tagPath },
        update: { $set: {
          tagPath: t.tagPath, tagType: t.kind.t, unit: t.kind.u,
          engLow: t.kind.lo, engHigh: t.kind.hi, deadband: 0, deadbandType: 'NONE',
          interpolation: (t.kind.t === 'PROCESS' || t.kind.t === 'COUNTER') ? 'CONTINUOUS' : 'STEPPED',
          dataType: t.kind.t === 'PROCESS' ? 'Double' : 'Int32', source: 'loadgen'
        } }, upsert: true
      }
    }));
    for (let i = 0; i < ops.length; i += 1000) {
      await db.collection(MASTER_COLL).bulkWrite(ops.slice(i, i + 1000), { ordered: false });
    }
    console.log('[loadgen] tag master registered: ' + tags.length);
  }

  const perBatch = Math.max(1, Math.round(RATE * BATCH_MS / 1000));
  let cursor = 0;
  let inFlight = 0;

  setInterval(async () => {
    if (inFlight > 4) { return; }        /* back-pressure: never queue unbounded writes */
    const now = Date.now();
    const docs = new Array(perBatch);
    for (let i = 0; i < perBatch; i++) {
      const tag = tags[cursor++ % tags.length];
      docs[i] = nextSample(tag, now);
    }
    inFlight++;
    try {
      /* unordered + writeConcern w:1 — the collector-grade write path */
      await coll.insertMany(docs, { ordered: false, writeConcern: { w: 1 } });
      written += docs.length;
      batches++;
    } catch (e) {
      errors++;
      if (errors % 20 === 1) { console.error('[loadgen] insert error: ' + String(e.message).slice(0, 140)); }
    } finally { inFlight--; }
  }, BATCH_MS);

  setInterval(() => {
    const secs = (Date.now() - t0) / 1000;
    console.log(`[loadgen] ${written.toLocaleString()} samples in ${Math.round(secs)}s = ` +
      `${Math.round(written / secs).toLocaleString()}/s sustained  (batches ${batches}, errors ${errors})`);
  }, 30000);
})().catch(e => { console.error('[loadgen] FATAL ' + e.message); process.exit(1); });
