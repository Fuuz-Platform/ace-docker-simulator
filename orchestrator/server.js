#!/usr/bin/env node
/*
 * ACE orchestrator — the pilot runtime.
 *
 * This is what runs the ACE pipeline against a LIVE Fuuz tenant while the platform's flow-execution
 * worker is down. It is deliberately the same shape the flows will take, so productionising later is
 * a port rather than a redesign:
 *
 *     Fuuz data API  ──▶ profiles + targets + candidates      (query)
 *                        ├─▶ ACE-CORE match kernel   (BIND: signal -> asset)
 *                        ├─▶ ACE-CORE classify kernel (BIND: what it measures)
 *                        ├─▶ TEI embeddings ──▶ Qdrant        (Tier-2 recall lane)
 *                        └─▶ chat LLM                          (Tier-3, ambiguous band only)
 *                    ──▶ proposals written back                (mutate)
 *
 * Governance carried over from the spec, unchanged:
 *   - the LLM only sees what Tier 1 could not resolve, and may only choose among supplied
 *     candidates or answer null — it can never invent a target;
 *   - embeddings generate candidates and contribute a feature, they never decide;
 *   - nothing auto-commits unless the profile's autoApproveTiers says so (empty in the pilot).
 */
'use strict';
const http = require('http');
const path = require('path');
const matcher = require(path.join(__dirname, '..', 'core', 'kernel', 'ace-match.js'));
const docStore = require(path.join(__dirname, '..', 'docdrop', 'store.js'));
const docPipe = require(path.join(__dirname, '..', 'docdrop', 'pipeline.js'));
const classifier = require(path.join(__dirname, '..', 'core', 'kernel', 'ace-classify-signal.js'));
const latency = require(path.join(__dirname, '..', 'latency', 'probe.js'));
const { gql } = require(path.join(__dirname, '..', 'platform', 'fuuz-api'));

const PORT = parseInt(process.env.PORT || '8099', 10);
const TENANT = process.env.FUUZ_TENANT || '';   // no default: set FUUZ_TENANT in .env
/* Defaults name Docker Model Runner, not a compose service. The ace-inference container was
   removed once `docker model` proved faster (6.4 vs 20.9 ms/string) AND host-GPU-backed, so a
   default pointing at it would now fail with a DNS error rather than a useful one. */
const EMBED_URL = process.env.EMBED_URL || 'http://model-runner.docker.internal/engines/v1';
const EMBED_API = process.env.EMBED_API || 'openai';      /* openai | tei */
const EMBED_MODEL = process.env.EMBED_MODEL || 'huggingface.co/ggml-org/bge-m3-q8_0-gguf';
/* Vectors live in MongoDB behind a Fuuz-shaped GraphQL API — same edges/node + where/_eq + upsert
   payload conventions as the live platform, so this code ports to Fuuz unchanged. */
const VECTOR_GQL = process.env.VECTOR_GRAPHQL_URL || 'http://ace-graphql:8098/graphql';
const LLM_URL = process.env.LLM_URL || 'http://model-runner.docker.internal/engines/v1';
const LLM_MODEL = process.env.LLM_MODEL || 'docker.io/ai/qwen3';
/* Bearer key for the OpenAI-compatible inference endpoints. Docker Model Runner needs none, but
   LM Studio can now be started with an API key required, and it answers an unauthenticated call
   with a 401 that looks nothing like a model problem. Sent only to the inference hosts — never to
   the Fuuz data API or the vector GraphQL, which carry their own credentials. Separate embed key
   because the two lanes can point at different servers; it falls back to the chat key. */
const LLM_API_KEY = process.env.LLM_API_KEY || '';
const EMBED_API_KEY = process.env.EMBED_API_KEY || LLM_API_KEY;
const bearer = (key) => (key ? { Authorization: 'Bearer ' + key } : {});
/* 'prompt' = ask for JSON and validate in code (spec §6.1's actual requirement);
   'schema'  = rely on provider-side constrained decoding.
   Default is 'prompt' because constrained decoding is NOT portable: LM Studio + a reasoning model
   (qwen3.6) returns EMPTY content under response_format json_schema strict — it emits its reasoning
   block and stops. The same call without response_format answers correctly. Validate-in-code is what
   the spec asks for anyway ("schema-validated in the flow; invalid JSON -> one retry -> FAILED"). */
const LLM_STRUCTURED = process.env.LLM_STRUCTURED || 'prompt';
const COLLECTION = 'ace_signals';
const VEC_DIMS = parseInt(process.env.EMBED_DIMS || '1024', 10);

/* ─────────────────────────── tiny fetch helpers ─────────────────────────── */
async function jfetch(url, opts, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs || 30000);
  try {
    const r = await fetch(url, Object.assign({ signal: ctl.signal }, opts || {}));
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch (e) { body = text; }
    if (!r.ok) { throw new Error(r.status + ' ' + String(text).slice(0, 200)); }
    return body;
  } finally { clearTimeout(t); }
}
const post = (url, obj, ms, headers) => jfetch(url, {
  method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
  body: JSON.stringify(obj)
}, ms);

/* ─────────────────────────── inference lane ─────────────────────────── */

/* e5 requires asymmetric prefixes; skipping them measurably degrades ranking (Appendix C, V-VEC-6).
   Stored strings are passages, probes are queries. Never "simplify" these away. */
async function embed(texts, kind) {
  if (!texts.length) { return []; }
  const prefix = kind === 'query' ? 'query: ' : 'passage: ';
  const out = [];
  for (let i = 0; i < texts.length; i += 64) {          /* batch — the spec's 64-128 guidance */
    const batch = texts.slice(i, i + 64).map(t => prefix + t);
    if (EMBED_API === 'tei') {
      const res = await post(EMBED_URL + '/embed', { inputs: batch, truncate: true }, 180000, bearer(EMBED_API_KEY));
      for (const v of res) { out.push(v); }
    } else {
      /* OpenAI-compatible: Ollama and LM Studio both speak this, so the seam is identical */
      const res = await post(EMBED_URL + '/embeddings', { model: EMBED_MODEL, input: batch }, 180000, bearer(EMBED_API_KEY));
      for (const d of (res.data || [])) { out.push(d.embedding); }
    }
  }
  return out;
}

async function vgql(query, variables, ms) {
  const r = await post(VECTOR_GQL, { query: query, variables: variables || {} }, ms || 60000);
  if (r.errors) { throw new Error('vector graphql: ' + JSON.stringify(r.errors).slice(0, 300)); }
  return r.data;
}

async function ensureCollection() {
  const d = await vgql('{ indexStatus { name status queryable dims count } }', {}, 20000);
  const s = d.indexStatus;
  return s.name + ' ' + s.status + (s.queryable ? ' (queryable)' : ' (not yet queryable)') +
         ' dims=' + s.dims + ' docs=' + s.count;
}

/* ─────────────────────────── Fuuz data lane ─────────────────────────── */
async function loadContext() {
  const q = await gql(TENANT, `{
    profiles: ctxProfile(where:{active:{_eq:true}}, first:20){ edges { node {
      id profileType externalSystemId destinationModelId identityFields contextFields facetFields
      textFields codeFacetPattern tokenizer aliases weights thresholds tiers scope autoApproveTiers
      vetoOnFacetMismatch siblingMinGroup siblingMinAgreement minAffixLength classificationRules
      scopeVocabulary guards maxBlockShare maxPairsPerCandidate } } }
    measurementTypes: measurementType(where:{active:{_eq:true}}, first:500){ edges { node { id name category defaultUom defaultRole } } }
    workUnit(first:2000){ edges { node { id code name area { code name } } } }
    candidates: entityMatchCandidate(where:{externalSystemId:{_eq:"IGNITION"}}, first:2000){
      edges { node { id externalId externalLabel externalKeyPath rawMetadata matchStatusId } } }
  }`);
  const d = q.data;
  return {
    match: d.profiles.edges.map(e => e.node).find(p => p.profileType === 'MATCH'),
    classify: d.profiles.edges.map(e => e.node).find(p => p.profileType === 'CLASSIFY'),
    measurementTypes: d.measurementTypes.edges.map(e => e.node),
    targets: d.workUnit.edges.map(e => {
      const n = e.node, f = { code: n.code, name: n.name };
      if (n.area) { f.areaCode = n.area.code; f.areaName = n.area.name; }
      return { id: n.id, fields: f };
    }),
    candidates: d.candidates.edges.map(e => e.node)
  };
}

/* ─────────────────────────── Tier 3: the LLM, on leftovers only ─────────────────────────── */
async function adjudicate(candidate, shortlist) {
  const system = 'You are an industrial tag-to-asset adjudicator. Decide which asset a control-system '
    + 'tag belongs to, using ONLY the evidence given. You MUST either choose one assetCode from the '
    + 'supplied candidate list or answer null. Never invent an asset code. '
    + 'Answering null is the CORRECT answer whenever the evidence does not clearly favour one '
    + 'candidate — a deterministic pass already failed to resolve this tag, so weak candidates are '
    + 'expected and a low heuristic score is a reason to decline, not a reason to pick the least bad '
    + 'option. Do not treat "highest of several weak scores" as evidence. Reply with JSON only.';
  const user = JSON.stringify({
    tagPath: (candidate.rawMetadata || {}).tagPath || candidate.externalId,
    label: candidate.externalLabel,
    engUnit: (candidate.rawMetadata || {}).engUnit,
    dataType: (candidate.rawMetadata || {}).dataType,
    candidates: shortlist.map(s => ({ assetCode: s.targetCode || s.targetId, heuristicScore: s.score }))
  });
  const SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['assetCode', 'confidence', 'rationale'],
    properties: { assetCode: { type: ['string', 'null'] }, confidence: { type: 'number' }, rationale: { type: 'string' } }
  };
  const allowed = shortlist.map(s => s.targetCode || s.targetId);

  function validate(v) {
    if (v === null || typeof v !== 'object') { return 'not an object'; }
    if (!('assetCode' in v)) { return 'missing assetCode'; }
    if (v.assetCode !== null && typeof v.assetCode !== 'string') { return 'assetCode must be string or null'; }
    /* assetCode is the decision; a model that omits confidence/rationale is answering, not failing.
       Default them and flag the omission rather than burning a retry on cosmetics. */
    if (typeof v.confidence !== 'number') { v.confidence = null; v._omitted = (v._omitted || []).concat('confidence'); }
    if (typeof v.rationale !== 'string') { v.rationale = ''; v._omitted = (v._omitted || []).concat('rationale'); }
    /* hallucination guard: the answer must be one of the options we supplied */
    if (v.assetCode && allowed.indexOf(v.assetCode) === -1) { return 'invented asset ' + v.assetCode; }
    return null;
  }

  async function ask(extraNote) {
    const body = {
      /* 3000, not 600. Reasoning models (qwen3.6) spend the budget in `reasoning` and emit EMPTY
         content if it runs out — and they run out on exactly the AMBIGUOUS cases Tier 3 exists for.
         At 600 this model answered the easy case and returned nothing on both hard ones. */
      model: LLM_MODEL, temperature: 0, max_tokens: parseInt(process.env.LLM_MAX_TOKENS || '3000', 10),
      messages: [
        { role: 'system', content: system + (extraNote ? ('\n\nYour previous reply was rejected: ' + extraNote + '. Reply with valid JSON only.') : '') },
        { role: 'user', content: user }
      ]
    };
    if (LLM_STRUCTURED === 'schema') {
      body.response_format = { type: 'json_schema', json_schema: { name: 'ace_ot_verdict', strict: true, schema: SCHEMA } };
    }
    const res = await post(LLM_URL + '/chat/completions', body, 180000, bearer(LLM_API_KEY));
    const msg = ((res.choices || [])[0] || {}).message || {};
    /* reasoning models put their chain in `reasoning`; only `content` is the answer */
    let raw = String(msg.content || '').trim();
    const fence = raw.match(/\{[\s\S]*\}/);
    if (fence) { raw = fence[0]; }
    try { return { verdict: JSON.parse(raw) }; }
    catch (e) { return { parseError: 'unparseable JSON', raw: raw.slice(0, 200) }; }
  }

  /* one retry with the error appended, then FAILED — never guess-parse (spec §6.1) */
  let a = await ask(null);
  let err = a.parseError || validate(a.verdict);
  if (err) {
    a = await ask(err);
    err = a.parseError || validate(a.verdict);
    if (err) { return { status: 'FAILED', error: err, raw: a.raw }; }
  }
  return Object.assign({ status: 'OK' }, a.verdict);
}

/* ─────────────────────────── historian ───────────────────────────
 * Generates plausible history for each discovered tag from its OWN configuration — dataType,
 * engLow/engHigh, valueSource — never from ground truth. That distinction matters: the classifier
 * is allowed to see what a PLC would actually emit, not what the answer key says the tag is.
 * This is what makes the two-wave design testable for real: wave 1 is name+UOM, wave 2 reads here. */
function synthSeries(meta, n, startMs, stepMs) {
  const dt = String(meta.dataType || '');
  const lo = typeof meta.engLow === 'number' ? meta.engLow : 0;
  const hi = typeof meta.engHigh === 'number' ? meta.engHigh : 100;
  const isInt = dt.toUpperCase().indexOf('INT') === 0;
  const isBool = dt.toUpperCase().indexOf('BOOL') === 0;
  const flat = meta.valueSource === 'memory';
  const out = [];
  let counter = Math.floor(Math.random() * 1000);
  let state = 1;
  for (let i = 0; i < n; i++) {
    let v;
    if (isBool) { if (Math.random() < 0.04) { state = 1 - state; } v = state; }
    else if (isInt && hi >= 10000) { counter += Math.floor(Math.random() * 3); v = counter; }   /* tally */
    else if (isInt) { v = Math.round(lo + Math.random() * Math.max(1, (hi - lo)) * 0.9); }       /* enum-ish */
    else if (flat) { v = Math.round((lo + (hi - lo) * 0.65) * 100) / 100; }                      /* setpoint */
    else { v = Math.round((lo + Math.random() * (hi - lo)) * 100) / 100; }
    out.push({ v: v, occurredAt: new Date(startMs + i * stepMs).toISOString() });
  }
  return out;
}

/* ─────────────────────────── routes ─────────────────────────── */
const routes = {};

routes['GET /health'] = async () => {
  const probe = async (name, fn) => {
    const t0 = Date.now();
    try { const v = await fn(); return { name, ok: true, ms: Date.now() - t0, detail: v }; }
    catch (e) { return { name, ok: false, ms: Date.now() - t0, error: String(e.message).slice(0, 140) }; }
  };
  return {
    tenant: TENANT,
    /* Report which models and endpoints are actually configured. A dashboard that hardcodes
       "bge-m3 via LM Studio" in a label is asserting something that was true on the day it was
       written — this stack has already moved its embedder between hosts once, and the label would
       have silently lied. Say what is running instead. */
    config: { embedModel: EMBED_MODEL, embedUrl: EMBED_URL, llmModel: LLM_MODEL, llmUrl: LLM_URL,
              /* whether a key is being sent, never the key itself — a 401 from an auth-enabled
                 LM Studio is otherwise indistinguishable from a model that failed to load */
              llmAuth: LLM_API_KEY ? 'bearer' : 'none', embedAuth: EMBED_API_KEY ? 'bearer' : 'none' },
    checks: await Promise.all([
      probe('fuuz-data-api', async () => {
        const r = await gql(TENANT, '{ workUnit(first:1){ edges { node { id } } } }');
        return r.data.workUnit.edges.length + ' workUnit reachable';
      }),
      probe('embeddings', async () => {
        const v = await embed(['health probe'], 'query');
        return 'dims=' + (v[0] || []).length + ' · ' + EMBED_MODEL;
      }),
      probe('vectors(mongo)', async () => await ensureCollection()),
      probe('llm', async () => {
        const m = await jfetch(LLM_URL + '/models', { headers: bearer(LLM_API_KEY) }, 8000);
        return 'models=' + ((m.data || []).length) + ' · ' + LLM_MODEL;
      })
    ])
  };
};

/* Tier-1 only: the deterministic pass over whatever is PENDING. */
routes['POST /match'] = async (body) => {
  const ctx = await loadContext();
  const pending = ctx.candidates.filter(c => c.matchStatusId === 'PENDING');
  const out = matcher.ctxMatch({ profile: ctx.match, targets: ctx.targets, candidates: pending });
  return { scanned: pending.length, summary: out.summary,
           sample: out.results.slice(0, 5).map(r => ({ id: r.externalId, band: r.band, decision: r.decision,
             target: r.targetCode, conf: r.confidence, method: r.method, tier: r.tier })) };
};

routes['POST /classify'] = async (body) => {
  const withValues = !!(body && body.withValues);
  const ctx = await loadContext();
  const vocab = Object.assign({ id: ctx.classify.id, measurementTypes: ctx.measurementTypes },
                              ctx.classify.classificationRules || {});
  const subs = ctx.candidates.map(c => {
    const m = c.rawMetadata || {};
    return { id: c.id, name: m.tagPath || c.externalId, uom: m.engUnit, dataType: m.dataType,
             engLow: m.engLow, engHigh: m.engHigh, valueSource: m.valueSource, typeId: m.typeId };
  });
  /* WAVE 2: pull behaviour from the historian. The stats are computed IN MongoDB by
     $setWindowFields, so the client never streams raw history — which is the only version of this
     that survives a real tag estate. */
  let statsCovered = 0;
  if (withValues) {
    const paths = subs.map(x => x.name);
    const d = await vgql('query($p:[String!]){ valueStats(tagPaths:$p){ tagPath samples distinctCount min max isBoolean isMonotonic changeRatio } }',
      { p: paths }, 180000);
    const byPath = {};
    for (const r of d.valueStats) { byPath[r.tagPath] = r; }
    for (const sub of subs) {
      const st = byPath[sub.name];
      if (st) { sub.valueStats = st; statsCovered++; }
    }
  }
  const out = classifier.ctxClassify({ vocabulary: vocab, subscriptions: subs });
  return { scanned: subs.length, wave: withValues ? 'WITH_VALUES' : 'NAME_ONLY',
           statsCovered: statsCovered, summary: out.summary };
};

/* Embed every candidate's tag path and upsert into Qdrant — the Tier-2 recall lane. */
routes['POST /embed'] = async () => {
  await ensureCollection();
  const ctx = await loadContext();
  const texts = ctx.candidates.map(c => (c.rawMetadata || {}).tagPath || c.externalId);
  const vectors = await embed(texts, 'passage');
  /* Fuuz upsert convention: payload array of {where, create, update}, id create-only. */
  const rows = ctx.candidates.map((c, i) => ({
    where: { id: c.id },
    create: { id: c.id, candidateId: c.id, tagPath: texts[i], label: c.externalLabel,
              status: c.matchStatusId, source: 'IGNITION', model: EMBED_MODEL,
              dims: (vectors[i] || []).length, embedding: vectors[i] },
    update: { tagPath: texts[i], label: c.externalLabel, status: c.matchStatusId,
              model: EMBED_MODEL, dims: (vectors[i] || []).length, embedding: vectors[i] }
  }));
  const M = 'mutation($p:[AceVectorUpsertPayloadInput!]!){ upsertAceVector(payload:$p){ id } }';
  let written = 0;
  for (let i = 0; i < rows.length; i += 50) {
    const d = await vgql(M, { p: rows.slice(i, i + 50) }, 180000);
    written += d.upsertAceVector.length;
  }
  return { embedded: written, dims: (vectors[0] || []).length, store: 'mongodb/$vectorSearch',
           index: await ensureCollection() };
};

routes['POST /historian/seed'] = async (body) => {
  const per = (body && body.samplesPerTag) || 300;
  const ctx = await loadContext();
  const now = Date.now();
  let written = 0;
  for (const c of ctx.candidates) {
    const m = c.rawMetadata || {};
    const tagPath = m.tagPath || c.externalId;
    const rows = synthSeries(m, per, now - per * 5000, 5000)
      .map(r => ({ tagPath: tagPath, v: r.v, occurredAt: r.occurredAt }));
    for (let i = 0; i < rows.length; i += 300) {
      const d = await vgql('mutation($p:[TagValueInput!]!){ recordTagValues(payload:$p) }',
        { p: rows.slice(i, i + 300) }, 120000);
      written += d.recordTagValues;
    }
  }
  const st = await vgql('{ historianStatus { name status count } }', {}, 20000);
  return { tags: ctx.candidates.length, samplesWritten: written, historian: st.historianStatus };
};

/* Nearest-neighbour probe — proves the lane end to end and is the exemplar retrieval the LLM uses. */
routes['POST /similar'] = async (body) => {
  const q = (body && body.q) || 'chiller vibration';
  const v = (await embed([q], 'query'))[0];
  const d = await vgql(
    'query($v:[Float!]!,$n:Int){ vectorSearch(vector:$v, limit:$n){ edges { score node { tagPath label status } } } }',
    { v: v, n: (body && body.limit) || 5 }, 60000);
  return { query: q, store: 'mongodb/$vectorSearch',
           hits: d.vectorSearch.edges.map(e => ({ score: Math.round(e.score * 1000) / 1000, tag: e.node.tagPath })) };
};


/* ─────────────────────────── unstructured documents ───────────────────────────
 * The third feed source. Structured feeds (generators, ERP/CMMS/historian) stage candidates; so
 * does this one, and then stops — match/guard/approve/bridge are shared, not duplicated.
 *
 * The file crosses to Fuuz FIRST and everything after works from a fileId, because a flow in Fuuz's
 * cloud cannot read a laptop. See docs/pipeline.js.
 */
routes['GET /docs'] = async () => ({
  dropDir: docStore.DROP_DIR,
  visionModel: docPipe.VISION_MODEL,
  visionUrl: docPipe.VISION_URL,
  vision: await docPipe.visionModelStatus(),
  externalSystem: docPipe.EXTERNAL_SYSTEM,
  destinationModel: docPipe.DEST_MODEL,
  docs: docStore.list()
});

routes['POST /docs/scan'] = async () => docStore.scanDrop();

/* Idempotent. Called automatically before staging, and exposed so the console can show whether the
   tenant is ready before anyone uploads anything. */
routes['POST /docs/seed'] = async () => docPipe.seedReferenceData(TENANT);

/* Browser upload. base64 in the body rather than multipart: these are drawings, the console is a
   pilot tool, and one encoding path is easier to keep honest than two. */
routes['POST /docs/upload'] = async (body) => {
  if (!body || !body.name || !body.contentBase64) { throw new Error('name and contentBase64 are required'); }
  const buf = Buffer.from(body.contentBase64, 'base64');
  if (!buf.length) { throw new Error('contentBase64 decoded to zero bytes'); }
  const { doc, duplicate } = docStore.register(body.name, buf, 'upload');
  if (!duplicate) { docStore.patch(doc.id, { inlineBase64: body.contentBase64 }); }
  return { duplicate, doc: docStore.get(doc.id) };
};

routes['POST /docs/push'] = async (body) => {
  const doc = docStore.get(body && body.id);
  if (!doc) { throw new Error('unknown document id'); }
  return { doc: await docPipe.pushToFuuz(TENANT, doc) };
};

/* Deconstruct: bytes -> AceFileAsset. The same parsers the flow inlines, so the console and the
   flow can never report different metadata for the same file. */
routes['POST /docs/deconstruct'] = async (body) => {
  if (body && body.fileId) { return docPipe.deconstruct(TENANT, body.fileId); }
  const doc = docStore.get(body && body.id);
  if (!doc) { throw new Error('pass a fileId, or an id of a document already pushed to Fuuz'); }
  if (!doc.fuuzFileId) { throw new Error('push the document to Fuuz first'); }
  const r = await docPipe.deconstruct(TENANT, doc.fuuzFileId);
  docStore.patch(doc.id, { parsed: { at: r.row.parsedAt, parser: r.row.parser, status: r.row.status, tagCount: r.row.tagCount } });
  return r;
};

/* What a schedule would drain: every File with no metadata row. */
routes['POST /docs/deconstruct-backlog'] = async (body) => docPipe.deconstructBacklog(TENANT, body && body.limit);

routes['POST /docs/extract'] = async (body) => {
  const doc = docStore.get(body && body.id);
  if (!doc) { throw new Error('unknown document id'); }
  return { doc: await docPipe.extract(TENANT, doc, body && body.instruction) };
};

routes['POST /docs/stage'] = async (body) => {
  const doc = docStore.get(body && body.id);
  if (!doc) { throw new Error('unknown document id'); }
  /* Seed first: externalSystemId is an ENFORCED reference, so without PID-DWG the first candidate
     is rejected outright. Seeding is idempotent and costs two upserts. */
  await docPipe.seedReferenceData(TENANT);
  return { doc: await docPipe.stage(TENANT, doc, body && body.drawing) };
};

/* All three, for one document. Steps are still individually callable because when an extraction
   looks wrong the question is always WHICH step produced the wrong thing. */
routes['POST /docs/pipeline'] = async (body) => {
  const doc0 = docStore.get(body && body.id);
  if (!doc0) { throw new Error('unknown document id'); }
  const steps = [];
  let doc = doc0;
  try {
    if (!doc.fuuzFileId) { doc = await docPipe.pushToFuuz(TENANT, doc); steps.push({ step: 'push', fileId: doc.fuuzFileId }); }
    else { steps.push({ step: 'push', skipped: 'already in Fuuz', fileId: doc.fuuzFileId }); }
    doc = await docPipe.extract(TENANT, doc, body && body.instruction);
    steps.push({ step: 'extract', tags: doc.extraction.tags.length, equipment: doc.extraction.equipment,
                 instruments: doc.extraction.instruments, ms: doc.extraction.ms });
    await docPipe.seedReferenceData(TENANT);
    steps.push({ step: 'seed', externalSystem: docPipe.EXTERNAL_SYSTEM });
    doc = await docPipe.stage(TENANT, doc, body && body.drawing);
    steps.push({ step: 'stage', candidates: doc.staged.count, drawing: doc.staged.drawing });
  } catch (e) {
    steps.push({ step: 'FAILED', error: String(e.message).slice(0, 300) });
  }
  return { id: doc0.id, steps, doc: docStore.get(doc0.id) };
};

/* ── edge gateway latency ────────────────────────────────────────────────────────────────────
   The harness is a plain module so it runs identically from a terminal and from here; this is a
   thin wrapper, not a second implementation. A run is held in memory so the console can render the
   last result without re-running it — a client watching a demo should not have to wait through a
   sweep to see the numbers again, and re-running on every page load would make the numbers move
   for no reason. */
let lastLatencyRun = null;
let latencyInFlight = null;

routes['GET /latency/scenarios'] = async () => ({
  scenarios: latency.scenarios(), config: latency.CFG, health: await latency.preflight()
});

routes['GET /latency/last'] = async () => lastLatencyRun || { empty: true };

routes['POST /latency/run'] = async (body) => {
  /* One run at a time. Two concurrent sweeps would contend for the same gateway, the same OPC UA
     session and the same handshake cell, and both would report inflated numbers that look like a
     slow gateway rather than like a harness measuring itself. */
  if (latencyInFlight) { return { busy: true, message: 'a latency run is already in progress' }; }
  latencyInFlight = latency.run({
    only: body && body.only,
    iterations: body && body.iterations,
    warmup: body && body.warmup,
    resultTags: body && body.resultTags,
    sweep: body && body.sweep,
    samplingMs: body && body.samplingMs
  });
  try { lastLatencyRun = await latencyInFlight; return lastLatencyRun; }
  finally { latencyInFlight = null; }
};

/* The full pilot pass: Tier 1, then Tier 3 on the leftovers only. */
routes['POST /pipeline'] = async (body) => {
  const useLlm = !(body && body.skipLlm);
  const ctx = await loadContext();
  const pending = ctx.candidates.filter(c => c.matchStatusId === 'PENDING');
  const out = matcher.ctxMatch({ profile: ctx.match, targets: ctx.targets, candidates: pending });

  /* GOVERNANCE: only the AMBIGUOUS band reaches the model.
     NO_MATCH means Tier 1 REJECTED the candidate — forwarding it would let the LLM overturn a
     rejection, which is precisely what the spec's bright line forbids ("the LLM promotes or demotes
     heuristic candidates; it never mints, and it can never override a HARD rule"). Learned the hard
     way: the first cut forwarded anything with alternatives, and the model cheerfully bound
     decommissioned `Filler_91` decoys to live assets at 0.84 confidence. The guardrail is not in the
     model, it is in what you route to it. */
  const reviewFloor = ((ctx.match.thresholds || {}).review) || 0.55;
  const leftovers = [];
  const withheld = { rejectedByTier1: 0, nothingToAdjudicate: 0 };
  out.results.forEach((r, i) => {
    if (r.band !== 'LLM') { if (r.band === 'NO_MATCH') { withheld.rejectedByTier1++; } return; }
    const best = (r.alternatives || [])[0];
    if (!best || (best.score != null && best.score < reviewFloor)) { withheld.nothingToAdjudicate++; return; }
    leftovers.push({ candidate: pending[i], result: r });
  });

  const adjudicated = [];
  if (useLlm) {
    for (const L of leftovers.slice(0, (body && body.llmLimit) || 10)) {
      try { adjudicated.push({ id: L.candidate.externalId, verdict: await adjudicate(L.candidate, L.result.alternatives || []) }); }
      catch (e) { adjudicated.push({ id: L.candidate.externalId, error: String(e.message).slice(0, 140) }); }
    }
  }
  return { tier1: out.summary, withheldFromLlm: withheld,
           leftoversForLlm: leftovers.length, adjudicated: adjudicated };
};

/* ─────────────────────────── server ─────────────────────────── */
const server = http.createServer((req, res) => {
  let bodyRaw = '';
  req.on('data', c => { bodyRaw += c; });
  req.on('end', async () => {
    const key = req.method + ' ' + req.url.split('?')[0];
    const handler = routes[key];
    res.setHeader('Content-Type', 'application/json');
    if (!handler) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: 'no route', available: Object.keys(routes) }, null, 1));
    }
    try {
      const parsed = bodyRaw ? JSON.parse(bodyRaw) : {};
      const out = await handler(parsed);
      res.end(JSON.stringify(out, null, 1));
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(e.message).slice(0, 400) }, null, 1));
    }
  });
});
server.listen(PORT, () => {
  console.log('ACE orchestrator on :' + PORT + '  tenant=' + TENANT);
  console.log('  embed   ' + EMBED_URL + '\n  vectors ' + VECTOR_GQL + ' (mongo)\n  llm     ' + LLM_URL + ' (' + LLM_MODEL + ')');
  console.log('  routes: ' + Object.keys(routes).join(' | '));
});
