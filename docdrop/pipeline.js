/*
 * ACE documents — push to Fuuz, read with a vision model, stage candidates.
 *
 * This is the unstructured feed described in archive/PID-PIPELINE.md, and it deliberately stops at
 * the same place the structured feeds stop: a PENDING `EntityMatchCandidate`. Everything downstream
 * — match, guard, approve, bridge — already exists and is proven, so a drawing joins the pipeline
 * as just another source rather than getting a parallel one of its own.
 *
 *     local file ──▶ Fuuz File (createFile)        the flow's handle: a fileId
 *                     │
 *                     ▼
 *              vision model  ──▶ strict JSON tags
 *                     │
 *                     ▼
 *          EntityMatchCandidate (PENDING) ──▶ existing matcher
 *
 * WHY THE MODEL CANNOT INVENT A TARGET. It is asked for TAGS AS DRAWN, never for a match. It has no
 * knowledge of what exists in the tenant, so the worst it can do is misread a label — and a
 * misread label simply fails to match, which is visible. The decision about what a tag corresponds
 * to belongs to the matcher, which can only choose among real records. That separation is the
 * whole reason vision is safe to use here.
 *
 * The same steps exist as a Fuuz flow (platform/flows/ctxPidExtract.json). This runs them locally
 * because the platform's flow-execution worker is down; the shapes are kept identical so switching
 * over is a change of caller, not a rewrite.
 */
'use strict';
const path = require('path');
const store = require('./store');
const parsers = require('./parsers');
const { gql } = require(path.join(__dirname, '..', 'platform', 'fuuz-api'));

/* NO FALLBACK TO LLM_MODEL, deliberately. That default is a text-only model, and a text-only model
   handed an image block does not refuse — it answers from the prompt alone and invents plausible
   tags for a drawing it never received. A missing vision model must be a loud failure, so this
   names a VLM that has to be pulled on purpose. */
const VISION_MODEL = process.env.VISION_MODEL || 'docker.io/ai/qwen2.5-vl';
const VISION_URL = process.env.VISION_URL || process.env.LLM_URL || 'http://model-runner.docker.internal/engines/v1';
/* Bearer key for that endpoint — LM Studio can require one. Empty for Docker Model Runner. */
const VISION_API_KEY = process.env.VISION_API_KEY || process.env.LLM_API_KEY || '';
const visionAuth = () => (VISION_API_KEY ? { Authorization: 'Bearer ' + VISION_API_KEY } : {});
const EXTERNAL_SYSTEM = process.env.DOC_EXTERNAL_SYSTEM || 'PID-DWG';
const DEST_MODEL = process.env.DOC_DEST_MODEL || 'WorkUnit';

/* The contract the model must answer in. Stated as a refusal ("return [] if you cannot read it")
   because the failure we actually care about is a model that invents plausible tags for an image it
   could not resolve — an empty answer is recoverable, a fabricated one is not. */
const SYSTEM_PROMPT = [
  'You read process and instrumentation diagrams (P&IDs) and engineering drawings.',
  'Return ONLY a JSON array. No prose, no markdown fence, no explanation.',
  'Each element: {"tag": string, "kind": "equipment"|"instrument", "function": string|null,',
  '"onEquipmentTag": string|null, "confidence": number between 0 and 1}.',
  'Transcribe tags EXACTLY as drawn — do not normalise, expand or correct them.',
  'kind is "instrument" for a bubble (TT, PT, FT, LT, VT, KQI and similar), "equipment" otherwise.',
  'onEquipmentTag is the equipment tag an instrument is mounted on, or null if it is not clear.',
  'Do not guess at anything illegible. If you cannot read the drawing at all, return [].'
].join(' ');

/* Preflight: is the configured model actually loaded? The runtime answers a model-not-found with an
   HTTP error, which is survivable — but the failure worth preventing is someone pointing
   VISION_MODEL at a text model that happily returns tag-shaped fiction. Checking the catalogue lets
   the console say WHICH model is missing instead of surfacing a 404 from a chat endpoint. */
async function visionModelStatus() {
  try {
    const res = await fetch(VISION_URL.replace(/\/$/, '') + '/models', { method: 'GET', headers: visionAuth() });
    if (!res.ok) { return { reachable: false, detail: 'HTTP ' + res.status }; }
    const body = await res.json();
    const ids = (body.data || []).map(m => String(m.id));
    const loaded = ids.some(id => id === VISION_MODEL || id.split(':')[0] === VISION_MODEL);
    return { reachable: true, loaded, model: VISION_MODEL, available: ids };
  } catch (e) {
    return { reachable: false, detail: String(e.message).slice(0, 160) };
  }
}

async function openaiVision(dataUrl, instruction) {
  const res = await fetch(VISION_URL.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' }, visionAuth()),
    body: JSON.stringify({
      model: VISION_MODEL,
      temperature: 0,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'text', text: instruction || 'Extract every equipment and instrument tag on this drawing.' }
        ] }
      ]
    })
  });
  const text = await res.text();
  if (!res.ok) { throw new Error('vision HTTP ' + res.status + ' — ' + text.slice(0, 200)); }
  const body = JSON.parse(text);
  return ((body.choices || [])[0] || {}).message ? body.choices[0].message.content : '';
}

/* Models wrap JSON in prose and fences however often you ask them not to. Salvaging the array is
   worth doing; ACCEPTING prose as data is not, so anything that is not an array of tag-shaped
   objects is a failure with the raw reply attached rather than a silent empty result. */
function parseTags(raw) {
  let s = String(raw || '').trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
  if (fence) { s = fence[1].trim(); }
  const start = s.indexOf('['), end = s.lastIndexOf(']');
  if (start !== -1 && end > start) { s = s.slice(start, end + 1); }
  let arr;
  try { arr = JSON.parse(s); } catch (e) { throw new Error('vision reply was not JSON: ' + String(raw).slice(0, 200)); }
  if (!Array.isArray(arr)) { throw new Error('vision reply was not a JSON array'); }
  const out = [];
  for (const t of arr) {
    if (!t || typeof t.tag !== 'string' || !t.tag.trim()) { continue; }
    out.push({
      tag: t.tag.trim(),
      kind: t.kind === 'instrument' ? 'instrument' : 'equipment',
      function: typeof t.function === 'string' && t.function.trim() ? t.function.trim() : null,
      onEquipmentTag: typeof t.onEquipmentTag === 'string' && t.onEquipmentTag.trim() ? t.onEquipmentTag.trim() : null,
      confidence: typeof t.confidence === 'number' ? Math.max(0, Math.min(1, t.confidence)) : null
    });
  }
  /* Same tag drawn twice is one tag. */
  const seen = new Set();
  return out.filter(t => { const k = t.kind + ':' + t.tag; if (seen.has(k)) { return false; } seen.add(k); return true; });
}

/* ── reference data ────────────────────────────────────────────────────────────────────────────
 * Staging fails outright without these — externalSystemId and externalEntityTypeId are enforced
 * references, so the FIRST candidate is rejected with "invalid reference id" rather than a thousand
 * rows landing under a system nobody registered. That is the behaviour we want; it just means the
 * rows have to exist first, so seeding is part of the feature rather than a setup note in a README.
 *
 * PID_EQUIP and INSTRUMENT are separate types on purpose. An equipment call-out on a drawing
 * resolves by its tag alone; an instrument bubble only resolves through the equipment it is mounted
 * on, so the matcher needs to tell them apart to pick the right strategy.
 */
const SEED = {
  externalSystem: {
    id: EXTERNAL_SYSTEM, code: EXTERNAL_SYSTEM, name: 'Engineering drawings / P&IDs',
    description: 'Tags read off engineering drawings by a vision model. One "record" is a call-out on a sheet, not a row in a system of record.',
    externalSystemTypeId: 'OTHER', active: true
  },
  entityTypes: [
    { id: 'PID_EQUIP', code: 'PID_EQUIP', name: 'P&ID equipment call-out',
      description: 'An equipment tag printed on a drawing. Resolves against a unit by tag.', active: true },
    { id: 'INSTRUMENT', code: 'INSTRUMENT', name: 'Field instrument bubble',
      description: 'An instrument bubble on a drawing (TT, PT, FT, LT, VT, KQI...). Resolves through the equipment it is mounted on plus its function, not by its own tag.', active: true }
  ]
};

/** Idempotent — safe to call before every run, and cheaper than explaining the failure. */
async function seedReferenceData(tenant) {
  const out = { externalSystem: null, entityTypes: [] };
  const es = await gql(tenant, 'mutation($p:[ExternalSystemUpsertPayloadInput!]!){ upsertExternalSystem(payload:$p){ id } }',
    { p: [{ where: { id: SEED.externalSystem.id }, create: SEED.externalSystem,
            update: { name: SEED.externalSystem.name, description: SEED.externalSystem.description } }] }, { tolerant: true });
  if (es.errors) { throw new Error('seed ExternalSystem: ' + es.errors.map(e => e.message).join(' | ').slice(0, 220)); }
  out.externalSystem = es.data.upsertExternalSystem[0].id;
  for (const t of SEED.entityTypes) {
    const r = await gql(tenant, 'mutation($p:[ExternalEntityTypeUpsertPayloadInput!]!){ upsertExternalEntityType(payload:$p){ id } }',
      { p: [{ where: { id: t.id }, create: t, update: { name: t.name, description: t.description } }] }, { tolerant: true });
    if (r.errors) { throw new Error('seed ExternalEntityType ' + t.id + ': ' + r.errors.map(e => e.message).join(' | ').slice(0, 220)); }
    out.entityTypes.push(r.data.upsertExternalEntityType[0].id);
  }
  return out;
}

/* ── steps ─────────────────────────────────────────────────────────────────────────────────── */

/** Local bytes -> a Fuuz File. This is the handoff: after it, a flow needs nothing but the id. */
async function pushToFuuz(tenant, doc) {
  const buf = store.bytes(doc);
  const r = await gql(tenant, 'mutation($p:[FileCreatePayloadInput!]!){ createFile(payload:$p){ id name mimeType } }',
    { p: [{ create: { name: doc.name, encoding: 'base64', mimeType: doc.mimeType, content: buf.toString('base64') } }] },
    { tolerant: true });
  if (r.errors) { throw new Error('createFile: ' + r.errors.map(e => e.message).join(' | ').slice(0, 250)); }
  const f = r.data.createFile[0];
  return store.patch(doc.id, { fuuzFileId: f.id, pushedAt: new Date().toISOString() });
}

/** Read the drawing. Deliberately reads the bytes BACK from Fuuz, so this exercises the exact path
 *  the flow will take rather than a shortcut only the console can use. */
async function extract(tenant, doc, instruction) {
  if (!doc.fuuzFileId) { throw new Error('push the document to Fuuz first — the flow works from a fileId'); }
  if (!doc.visionReady) {
    throw new Error('mimeType ' + doc.mimeType + ' is not something a vision model can read. ' +
      'Render it to PNG first — an SVG or PDF handed to a vision model produces a confident answer about an image it never saw.');
  }
  const c = await gql(tenant, 'query($w:FileWhereUniqueInput!){ retrieveFileContent(where:$w, encoding:"base64"){ mimeType content } }',
    { w: { id: doc.fuuzFileId } }, { tolerant: true });
  if (c.errors) { throw new Error('retrieveFileContent: ' + c.errors.map(e => e.message).join(' | ').slice(0, 250)); }
  const n = c.data.retrieveFileContent;
  const dataUrl = 'data:' + (n.mimeType || doc.mimeType) + ';base64,' + n.content;

  const status = await visionModelStatus();
  if (!status.reachable) {
    throw new Error('vision runtime unreachable at ' + VISION_URL + ' — ' + status.detail);
  }
  if (!status.loaded) {
    throw new Error('vision model "' + VISION_MODEL + '" is not loaded. Available: ' +
      (status.available.join(', ') || 'none') + '. Pull one with `docker model pull ' + VISION_MODEL +
      '` — do NOT point VISION_MODEL at a text-only model, which will answer without seeing the image.');
  }

  const started = Date.now();
  const raw = await openaiVision(dataUrl, instruction);
  const tags = parseTags(raw);
  const extraction = {
    at: new Date().toISOString(), model: VISION_MODEL, ms: Date.now() - started,
    tags, equipment: tags.filter(t => t.kind === 'equipment').length,
    instruments: tags.filter(t => t.kind === 'instrument').length
  };
  return store.patch(doc.id, { extraction });
}

/** Tags -> PENDING candidates. Nothing here decides anything; it hands the matcher its input. */
async function stage(tenant, doc, drawing) {
  if (!doc.extraction || !doc.extraction.tags.length) { throw new Error('nothing extracted yet'); }
  const dwg = drawing || doc.name.replace(/\.[^.]+$/, '');
  const rows = doc.extraction.tags.map(t => {
    const typeId = t.kind === 'instrument' ? 'INSTRUMENT' : 'PID_EQUIP';
    const externalId = dwg + ':' + t.tag;
    const create = {
      externalSystemId: EXTERNAL_SYSTEM,
      externalEntityTypeId: typeId,
      destinationModelId: DEST_MODEL,
      externalId,
      externalLabel: t.tag,
      /* The drawing and the mounting relationship are what let an instrument bubble resolve at all —
         a bare "TT-6002" matches nothing, "TT-6002 on HOU-UTL-CHL-002" matches one unit. */
      rawMetadata: { drawing: dwg, fileId: doc.fuuzFileId, function: t.function,
                     onEquipmentTag: t.onEquipmentTag, visionConfidence: t.confidence },
      matchStatusId: 'PENDING',
      dedupeKey: EXTERNAL_SYSTEM + ':' + typeId + ':' + dwg + ':' + t.tag
    };
    return { where: { dedupeKey: create.dedupeKey }, create, update: { rawMetadata: create.rawMetadata } };
  });
  const r = await gql(tenant,
    'mutation($p:[EntityMatchCandidateUpsertPayloadInput!]!){ upsertEntityMatchCandidate(payload:$p){ id externalId } }',
    { p: rows }, { tolerant: true });
  if (r.errors) { throw new Error('stage: ' + r.errors.map(e => e.message).join(' | ').slice(0, 300)); }
  const staged = { at: new Date().toISOString(), drawing: dwg, count: r.data.upsertEntityMatchCandidate.length };
  return store.patch(doc.id, { staged });
}

/* ── deconstruct: the same three steps aceFileParse.json performs, run locally ─────────────────
 * Reads the bytes BACK from Fuuz and parses them with the SAME module the flow inlines, so the two
 * cannot drift. This is what runs today; the flow is what runs when the engine returns.
 *
 * Deliberately independent of the vision path. Parsing extracts what a file states about itself —
 * exact, free, instant. Vision is for scanned rasters where nothing is stated. Running parse first
 * means a vector P&ID never needs a model at all.
 */
async function deconstruct(tenant, fileId) {
  const c = await gql(tenant, 'query($w:FileWhereUniqueInput!){ retrieveFileContent(where:$w, encoding:"base64"){ id name mimeType encoding content } }',
    { w: { id: fileId } }, { tolerant: true });
  if (c.errors) { throw new Error('retrieveFileContent: ' + c.errors.map(e => e.message).join(' | ').slice(0, 200)); }
  const f = c.data.retrieveFileContent;
  const bytes = Buffer.from(f.content, 'base64');

  let r;
  try { r = parsers.parse(bytes, f.name, f.mimeType); }
  catch (e) { r = { ok: false, parser: 'error', parserVersion: parsers.PARSER_VERSION, reason: String(e.message).slice(0, 300), metadata: {}, promoted: {} }; }

  const p = r.promoted || {};
  const nn = v => (v === undefined ? null : v);
  const row = {
    fileId: f.id, fileName: f.name, mimeType: f.mimeType, sizeBytes: bytes.length,
    sha256: require('crypto').createHash('sha256').update(bytes).digest('hex'),
    parser: r.parser, parserVersion: r.parserVersion,
    status: r.ok ? 'parsed' : (r.parser === 'binary' ? 'unsupported' : 'failed'),
    error: r.ok ? null : r.reason,
    parsedAt: new Date().toISOString(),
    title: nn(p.title), textPreview: nn(p.textPreview), rowCount: nn(p.rowCount),
    columnCount: nn(p.columnCount), pageCount: nn(p.pageCount),
    widthPx: nn(p.widthPx), heightPx: nn(p.heightPx), tagCount: nn(p.tagCount),
    metadata: r.metadata || {}
  };
  const update = Object.assign({}, row); delete update.fileId;
  const w = await gql(tenant, 'mutation($p:[AceFileAssetUpsertPayloadInput!]!){ upsertAceFileAsset(payload:$p){ id fileId parser status } }',
    { p: [{ where: { fileId: row.fileId }, create: row, update }] }, { tolerant: true });
  if (w.errors) { throw new Error('upsertAceFileAsset: ' + w.errors.map(e => e.message).join(' | ').slice(0, 250)); }
  return { asset: w.data.upsertAceFileAsset[0], row };
}

/** Every File with no metadata row yet — what the scheduled flow would drain. */
async function deconstructBacklog(tenant, limit) {
  const q = await gql(tenant, '{ file(orderBy:[{createdAt:ASC}], first:200){ edges{ node{ id name } } } aceFileAsset(first:500){ edges{ node{ fileId } } } }', {}, { tolerant: true });
  if (q.errors) { throw new Error(q.errors.map(e => e.message).join(' | ').slice(0, 200)); }
  const known = new Set(q.data.aceFileAsset.edges.map(e => e.node.fileId));
  const todo = q.data.file.edges.map(e => e.node).filter(n => !known.has(n.id)).slice(0, limit || 25);
  const done = [];
  for (const f of todo) {
    try { const r = await deconstruct(tenant, f.id); done.push({ fileId: f.id, name: f.name, parser: r.row.parser, status: r.row.status, tagCount: r.row.tagCount }); }
    catch (e) { done.push({ fileId: f.id, name: f.name, error: String(e.message).slice(0, 200) }); }
  }
  return { pending: q.data.file.edges.length - known.size, processed: done.length, results: done };
}

module.exports = { pushToFuuz, extract, stage, parseTags, visionModelStatus, seedReferenceData, SEED,
                   deconstruct, deconstructBacklog, SYSTEM_PROMPT,
                   VISION_MODEL, VISION_URL, EXTERNAL_SYSTEM, DEST_MODEL };
