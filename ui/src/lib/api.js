/* One place that knows how to reach the services.
 *
 * Every call goes through a same-origin /api/* path — Vite proxies it in dev, nginx proxies it in
 * Docker. That keeps CORS out of the picture entirely and means the app has no idea whether the
 * historian is on localhost or inside a compose network.
 */

async function json(path, opts) {
  const res = await fetch(path, Object.assign({ headers: { 'content-type': 'application/json' } }, opts));
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (e) { /* keep the raw text for the error */ }
  if (!res.ok) {
    /* An OPTIONAL service that is simply not running answers as an nginx gateway error carrying a
       full HTML error page. Rendering that raw made a not-started service look like a crash: the
       console greeted every default `docker compose up` with a red card full of markup. Detect the
       shape and report absence as absence — the flag lets callers style it as "off", not "broken". */
    const gatewayDown = (res.status === 502 || res.status === 503 || res.status === 504);
    if (gatewayDown && /^\s*<(!doctype|html)/i.test(text)) {
      const err = new Error('not running');
      err.offline = true;
      throw err;
    }
    const detail = (body && (body.error || body.message)) || text.slice(0, 200) || res.statusText;
    const err = new Error('HTTP ' + res.status + ' — ' + detail);
    err.offline = gatewayDown;
    throw err;
  }
  return body;
}

/* ── simulator control API ─────────────────────────────────────────────────────────────────── */
export const sim = {
  state:  () => json('/api/sim/state'),
  params: () => json('/api/sim/params'),
  faults: () => json('/api/sim/faults'),
  setParams: p => json('/api/sim/params', { method: 'POST', body: JSON.stringify(p) }),
  setFault: (unit, fault, holdMs) =>
    json('/api/sim/fault', { method: 'POST', body: JSON.stringify({ unit, fault, holdMs }) })
};

/* ── orchestrator ──────────────────────────────────────────────────────────────────────────── */
export const orch = {
  health: () => json('/api/orch/health'),
  /* The route reads `q`, not `text`. Sending the wrong key was silent: the handler defaults to
     'chiller vibration', so every search returned plausible results for a query nobody typed. */
  similar: (q, limit) => json('/api/orch/similar', { method: 'POST', body: JSON.stringify({ q, limit }) })
};

/* ── edge gateway latency harness ──────────────────────────────────────────────────────────────
   Driven through the orchestrator rather than from the browser. The measurement has to be taken
   from something on the same network as the gateway, not from whatever laptop the console happens
   to be open on — a client's wifi would otherwise be reported as gateway latency. `last` exists so
   opening the tab shows the previous run's numbers instead of an empty panel or an unasked-for
   sweep. */
export const latency = {
  scenarios: () => json('/api/orch/latency/scenarios'),
  last:      () => json('/api/orch/latency/last'),
  /* A full sweep takes minutes, well past any sensible fetch timeout default, so the caller owns
     the wait and the tab shows a running state throughout. */
  run: opts => json('/api/orch/latency/run', { method: 'POST', body: JSON.stringify(opts || {}) })
};

/* ── the handshake cell in the simulator ───────────────────────────────────────────────────────
   Separate from `sim` because it is a different kind of thing: the plant free-runs and is sampled,
   the cell waits to be answered. Its cycle log is the PLC-side evidence for every handshake number
   the latency tab reports. */
export const handshake = {
  state:  () => json('/api/sim/handshake/state'),
  cycles: (limit) => json('/api/sim/handshake/cycles?limit=' + (limit || 50)),
  /* The click time is stamped HERE, in the browser, and sent along — it is the only stamp in the
     whole timeline the cell cannot take for itself, and it is the one a person actually experiences.
     Everything downstream is measured by the cell and the flow. */
  fire:   () => json('/api/sim/handshake/fire', {
    method: 'POST',
    body: JSON.stringify({ source: 'console', clickedAt: Date.now() })
  }),
  clear:  () => json('/api/sim/handshake/clear', { method: 'POST', body: '{}' }),
  reset:  () => json('/api/sim/handshake/reset', { method: 'POST', body: '{}' }),
  config: p => json('/api/sim/handshake/config', { method: 'POST', body: JSON.stringify(p || {}) })
};

/* ── inference runtime ─────────────────────────────────────────────────────────────────────────
   Straight to the model runtime's OpenAI-compatible surface, deliberately NOT through the
   orchestrator. The question this answers is "what is actually loaded and how fast is it", and
   routing that through the service under test would let a healthy orchestrator mask a dead model —
   or an env var mask a model that is not really there. */
export const inference = {
  models: () => json('/api/models/models'),
  /* Round-trip N strings and report the per-string cost. The runtime reports what it IS; only a
     real call reports what it DOES, which is the number that decides whether 10k tags is a coffee
     break or an afternoon. */
  probe: async (model, n) => {
    const count = n || 16;
    const input = Array.from({ length: count }, (_, i) => 'passage: Plant/AREA/UNIT-' + i + '/MotorTemp');
    const started = Date.now();
    const res = await fetch('/api/models/embeddings', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, input })
    });
    const body = await res.json().catch(() => ({}));
    const ms = Date.now() - started;
    if (!res.ok || !body.data) {
      throw new Error((body.error && (body.error.message || body.error)) || ('HTTP ' + res.status));
    }
    return { ms, count, perString: ms / count, dims: (body.data[0] || {}).embedding.length };
  }
};

/* ── device gateway flow relay ─────────────────────────────────────────────
   Triggers an edge data flow on demand instead of waiting for its five-minute cron.

   Deliberately does NOT throw on a non-2xx. The gateway answers with the flow's own payload on
   success and its error object on failure, and the error object is the more useful of the two while
   this is being debugged — throwing it away to raise a generic Error would discard exactly the
   detail worth reading. */
export const edge = {
  trigger: async (path, payload) => {
    const started = Date.now();
    const res = await fetch('/api/edge/' + String(path).replace(/^\//, ''), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload || {})
    });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; }
    catch (e) { body = { raw: text.slice(0, 4000) }; }
    return { ok: res.ok, status: res.status, ms: Date.now() - started, body };
  }
};

/* ── historian + vectors (GraphQL) ─────────────────────────────────────────────────────────── */
export async function gql(query, variables) {
  const body = await json('/api/hist/graphql', { method: 'POST', body: JSON.stringify({ query, variables }) });
  if (body && body.errors && body.errors.length) { throw new Error(body.errors.map(e => e.message).join('; ')); }
  return body && body.data;
}

export const hist = {
  status: () => gql('{ historianStatus { name status queryable count } }'),
  tagMasters: (first) => gql(`query($n:Int){ tagMasters(first:$n){ tagPath tagType unit engLow engHigh interpolation dataType deadband scanRateMs } }`, { n: first || 400 }),
  /* includeBad defaults FALSE at the call sites that trend, and TRUE where the point is to see
     outages — a trend that silently drops Bad samples hides exactly the thing worth seeing. */
  raw: (tagPath, fromIso, toIso, includeBad, limit) =>
    gql(`query($t:String!,$f:String,$to:String,$b:Boolean,$l:Int){
           rawSamples(tagPath:$t, fromIso:$f, toIso:$to, includeBad:$b, limit:$l){
             occurredAt v valueBool valueString quality qualityGood latencyMs }
         }`, { t: tagPath, f: fromIso, to: toIso, b: !!includeBad, l: limit || 500 }),
  aggregate: (tagPaths, fromIso, toIso) =>
    gql(`query($t:[String!],$f:String!,$to:String!){
           histAggregate(tagPaths:$t, fromIso:$f, toIso:$to){
             tagPath tagType samples goodSamples uncertainSamples badSamples usableSamples
             coverageMs min max stdDev p05 p50 p95 p99
             arithmeticAvg timeWeightedAvg preferredAvg first last delta transitions onFraction
           }
         }`, { t: tagPaths, f: fromIso, to: toIso }),
  pendingRollups: (first) =>
    gql(`query($n:Int){ tagAggregates(pickedUp:false, first:$n){ edges { node {
           id tagPath windowStart windowEnd count min max avg isMonotonic changeRatio pickedUp } } } }`,
        { n: first || 50 }),
  harvestStatus: () => gql(`{ harvestStatus { pending collected total lastCollectedAt lastCollectedBy oldestPendingAt newestPendingAt } }`),
  /* What is on disk and how long it stays — the numbers a purge decision needs in front of it. */
  storage: () => gql('{ storageStatus { name kind ttlDays docs storageMB } }'),
  /* Scoped rather than one wipe-everything call. Raw samples regenerate in minutes; rollups are the
     only record of a window once its samples expire. Those should not be one button. */
  purge: (scope) => gql(`mutation($s:String!){ purgeHistorian(scope:$s, confirm:true){
      scope dropped rebuilt docsBefore docsAfter freedMB } }`, { s: scope }),
  indexStatus: () => gql('{ indexStatus { name status queryable dims count } }')
};

/* Small helper so every tab reports failure the same way instead of each inventing a shape. */
export function describeError(e) {
  const m = String((e && e.message) || e);
  /* An optional service that was never started is not a fault. Say so plainly and point at the
     command that starts it, rather than reporting a gateway error the reader has to decode. */
  if (e && e.offline) { return 'not running — optional, start with: docker compose --profile fuuz up -d'; }
  if (/Failed to fetch|NetworkError|ECONNREFUSED/i.test(m)) { return 'service unreachable — is the container running?'; }
  return m;
}

/* ── documents (unstructured feed) ─────────────────────────────────────────────────────────────
   Steps are separate calls as well as one pipeline call, because when an extraction looks wrong
   the useful question is which step produced the wrong thing. */
export const docs = {
  list:    () => json('/api/orch/docs'),
  scan:    () => json('/api/orch/docs/scan', { method: 'POST', body: '{}' }),
  upload:  (name, contentBase64) => json('/api/orch/docs/upload', { method: 'POST', body: JSON.stringify({ name, contentBase64 }) }),
  push:    id => json('/api/orch/docs/push', { method: 'POST', body: JSON.stringify({ id }) }),
  extract: (id, instruction) => json('/api/orch/docs/extract', { method: 'POST', body: JSON.stringify({ id, instruction }) }),
  stage:   (id, drawing) => json('/api/orch/docs/stage', { method: 'POST', body: JSON.stringify({ id, drawing }) }),
  pipeline: id => json('/api/orch/docs/pipeline', { method: 'POST', body: JSON.stringify({ id }) })
};
