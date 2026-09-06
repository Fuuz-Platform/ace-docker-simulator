/*
 * ACE documents — the local half of unstructured ingest.
 *
 * THE PROBLEM THIS SOLVES. A P&ID lives on somebody's laptop. A Fuuz flow runs in Fuuz's cloud. The
 * flow cannot reach the laptop, and punching a hole through the network so it could would be a bad
 * trade for a file that is a few hundred kilobytes.
 *
 * So the file goes TO the platform rather than the platform coming to the file: the console takes
 * the bytes locally, writes them into the Fuuz `File` model, and hands the flow a `fileId`. From
 * that point the flow reads the file the way it reads anything else — `retrieveFileContent(where:
 * {id}, encoding: "base64")` — with no dependency on where the bytes came from. Contract verified
 * end to end against a live tenant before this was written: createFile with base64 content, read
 * back byte-identical.
 *
 * "Grab files locally" is therefore two paths into the same registry:
 *   - a DROP DIRECTORY the console scans, which is what you want for a folder of drawings;
 *   - a direct upload from the browser, which is what you want for one file you are holding.
 *
 * Local state is deliberately a plain JSON file, not a database. This is a pilot console; the
 * durable record of a document is the Fuuz File it becomes, and anything the registry loses can be
 * rebuilt by rescanning the drop directory.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DROP_DIR = process.env.ACE_DROP_DIR || '/data/drop';
const STATE_FILE = process.env.ACE_DOCS_STATE || '/data/docs.json';

/* Vision models take images. A PDF or a raw SVG is not one, and pretending otherwise produces a
   confident answer about a file the model never actually saw — so the type is recorded and the
   extract step refuses what it cannot read, rather than guessing. */
const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
  '.txt': 'text/plain', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values',
  '.json': 'application/json', '.xml': 'application/xml',
  '.md': 'text/markdown', '.log': 'text/plain', '.yaml': 'text/yaml', '.yml': 'text/yaml'
};
const VISION_READY = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function load() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch (e) { return { docs: {} }; }
}
function save(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
}

/* Content hash, not filename+mtime. A drawing that gets re-exported under the same name is a new
   document; the same drawing copied to a second folder is not. Only the bytes can tell those
   apart, and getting it wrong means either duplicate candidates or a silently skipped revision. */
const hashOf = buf => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);

function register(name, buf, source) {
  const state = load();
  const ext = path.extname(name).toLowerCase();
  const mimeType = MIME[ext] || 'application/octet-stream';
  const sha = hashOf(buf);
  const existing = Object.values(state.docs).find(d => d.sha === sha);
  if (existing) {
    /* Same bytes already known. Record where else it turned up rather than creating a twin. */
    if (!existing.seenAs.includes(name)) { existing.seenAs.push(name); save(state); }
    return { doc: existing, duplicate: true };
  }
  const doc = {
    id: sha, sha, name, seenAs: [name], source, mimeType, bytes: buf.length,
    visionReady: VISION_READY.has(mimeType),
    addedAt: new Date().toISOString(),
    fuuzFileId: null, pushedAt: null,
    extraction: null, staged: null
  };
  state.docs[doc.id] = doc;
  save(state);
  return { doc, duplicate: false };
}

/* The drop directory is a SCAN, not a watcher. A watcher fires while a large file is still being
   copied and hashes a truncated read; scanning on demand means the console only ever sees files
   that were finished before someone pressed the button. */
function scanDrop() {
  let names = [];
  try { names = fs.readdirSync(DROP_DIR); }
  catch (e) { return { dir: DROP_DIR, error: 'drop directory not readable: ' + e.code, added: 0, duplicates: 0, docs: [] }; }
  let added = 0, duplicates = 0;
  const docs = [];
  for (const n of names) {
    const full = path.join(DROP_DIR, n);
    let st;
    try { st = fs.statSync(full); } catch (e) { continue; }
    if (!st.isFile() || n.startsWith('.')) { continue; }
    const r = register(n, fs.readFileSync(full), 'drop:' + n);
    r.duplicate ? duplicates++ : added++;
    docs.push(r.doc);
  }
  return { dir: DROP_DIR, added, duplicates, total: docs.length, docs };
}

const list = () => Object.values(load().docs).sort((a, b) => b.addedAt.localeCompare(a.addedAt));
const get = id => load().docs[id] || null;

function patch(id, fields) {
  const state = load();
  if (!state.docs[id]) { return null; }
  Object.assign(state.docs[id], fields);
  save(state);
  return state.docs[id];
}

/* Bytes are re-read from disk for drop files and cached inline for browser uploads — a drop file
   is the user's own copy and re-reading it keeps one source of truth on disk. */
function bytes(doc) {
  if (doc.inlineBase64) { return Buffer.from(doc.inlineBase64, 'base64'); }
  const full = path.join(DROP_DIR, doc.name);
  return fs.readFileSync(full);
}

module.exports = { DROP_DIR, STATE_FILE, MIME, VISION_READY, register, scanDrop, list, get, patch, bytes };
