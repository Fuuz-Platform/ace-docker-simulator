/*
 * fuuz-api.js — a direct GraphQL client for a Fuuz tenant.
 *
 * Schema authoring, seeding, verification, and running the ACE kernels against live tenant data
 * all go through the data API rather than through flow execution, which keeps this client small
 * and its failure modes obvious.
 *
 * Endpoint facts (probed, not assumed):
 *   POST https://<host>/application                          <- GraphQL. NOT /graphql.
 *   POST https://<host>/orchestration/executeFlow/<flowId>   <- flow execution
 *   Auth: a per-tenant JWT sent as Authorization + X-Fuuz-Tenant. Never printed.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

function loadServer(serverKey) {
  /* Container-friendly path first: explicit env beats reading the developer's ~/.claude.json,
     which does not exist inside an image and should not be mounted into one. */
  if (process.env.FUUZ_HOST && process.env.FUUZ_TOKEN) {
    return {
      host: process.env.FUUZ_HOST,
      headers: {
        Authorization: process.env.FUUZ_TOKEN.indexOf('Bearer ') === 0
          ? process.env.FUUZ_TOKEN : 'Bearer ' + process.env.FUUZ_TOKEN,
        'X-Fuuz-Tenant': process.env.FUUZ_TENANT || serverKey
      }
    };
  }
  const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
  const walk = (o, d) => {
    if (!o || typeof o !== 'object' || d > 5) return null;
    for (const k of Object.keys(o)) {
      if (k === 'mcpServers' && o[k] && o[k][serverKey]) return o[k][serverKey];
      const hit = walk(o[k], d + 1);
      if (hit) return hit;
    }
    return null;
  };
  const srv = walk(cfg, 0);
  if (!srv) throw new Error('server not found in ~/.claude.json: ' + serverKey);
  return { headers: srv.headers || {}, host: new URL(srv.url).host };
}

function post(srv, urlPath, bodyObj, timeoutMs) {
  const body = JSON.stringify(bodyObj);
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: srv.host, port: 443, method: 'POST', path: urlPath, timeout: timeoutMs || 90000,
      headers: Object.assign(
        { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        srv.headers)
    }, res => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error('HTTP ' + res.statusCode + ': ' + d.slice(0, 300))); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout after ' + (timeoutMs || 90000) + 'ms')); });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

/* 502/503/504 and socket resets are the platform being busy, not the request being wrong. Deploying
   a large model set regenerates the tenant's GraphQL schema after every model, and past ~600 models
   that regeneration outlasts the gateway timeout — a bare 504 that succeeds on the next attempt.
   Retrying here rather than in each caller means every script gets it. */
/* 403 is included deliberately and cautiously. A permission failure surfaces as a GraphQL error,
   not an HTTP 403 — an HTTP 403 during a long deploy run is the edge throttling sustained traffic,
   which is the same shape that got this project IP-banned scraping SAP. It is retried, but the
   caller sees it named so a genuine permission problem is not silently retried into oblivion. */
const retryable = e => /HTTP 50[234]|HTTP 403|ECONNRESET|socket hang up|ETIMEDOUT|EPIPE/i.test(String(e && e.message));
const napMs = n => Math.min(30000, 2000 * Math.pow(2, n));

/** GraphQL against the tenant data API. Throws on GraphQL errors unless tolerant. */
async function gql(serverKey, query, variables, opts) {
  const srv = typeof serverKey === 'string' ? loadServer(serverKey) : serverKey;
  const tries = (opts && opts.retries !== undefined) ? opts.retries : 5;
  let res, lastErr;
  for (let n = 0; n <= tries; n++) {
    try { res = await post(srv, '/application', { query, variables: variables || {} }); lastErr = null; break; }
    catch (e) {
      lastErr = e;
      if (!retryable(e) || n === tries) { throw e; }
      await new Promise(r => setTimeout(r, napMs(n)));
    }
  }
  if (lastErr) { throw lastErr; }
  if (res.errors && !(opts && opts.tolerant)) {
    throw new Error('GraphQL: ' + JSON.stringify(res.errors).slice(0, 600));
  }
  return res;
}

/** GraphQL against a NON-default API path. The platform exposes more than /application —
 *  /packageManagement carries exportPackageArchive, for one — and those are ordinary GraphQL
 *  endpoints that simply live elsewhere. Same retry behaviour as gql(). */
async function gqlAt(serverKey, apiPath, query, variables, opts) {
  const srv = typeof serverKey === 'string' ? loadServer(serverKey) : serverKey;
  const tries = (opts && opts.retries !== undefined) ? opts.retries : 5;
  let res, lastErr;
  for (let n = 0; n <= tries; n++) {
    try { res = await post(srv, apiPath, { query, variables: variables || {} }); lastErr = null; break; }
    catch (e) {
      lastErr = e;
      if (!retryable(e) || n === tries) { throw e; }
      await new Promise(r => setTimeout(r, napMs(n)));
    }
  }
  if (lastErr) { throw lastErr; }
  if (res.errors && !(opts && opts.tolerant)) {
    throw new Error('GraphQL: ' + JSON.stringify(res.errors).slice(0, 600));
  }
  return res;
}

/** Flow execution — kept for the day the engine returns. `ctxPing` is the green-light test. */
async function executeFlow(serverKey, flowId, payload, timeoutMs) {
  const srv = typeof serverKey === 'string' ? loadServer(serverKey) : serverKey;
  return post(srv, '/orchestration/executeFlow/' + flowId, payload || {}, timeoutMs || 25000);
}

/** Upsert helper. `id` is create-only, so it must never appear in the update half. */
function upsertPayload(rows, whereKey) {
  return rows.map(r => {
    const upd = Object.assign({}, r);
    delete upd.id;
    const where = {};
    where[whereKey || 'id'] = r[whereKey || 'id'];
    return { where, create: r, update: upd };
  });
}

/* Optional short aliases -> full tenant names, for callers that would rather not repeat a long
   identifier. Empty here: pass the tenant name itself and it is used as given. */
const SERVERS = {};

module.exports = { loadServer, gql, gqlAt, executeFlow, upsertPayload, SERVERS };
