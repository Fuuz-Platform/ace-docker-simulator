import React, { useState } from 'react';
import { usePoll } from '../lib/usePoll.js';
import { hist, edge, describeError } from '../lib/api.js';
import { fmt } from '../components/Chart.jsx';

/* Manual trigger for the edge harvest.
 *
 * The flow normally fires on its own cron inside the gateway, which is right for production and
 * useless for testing — you wait up to five minutes to learn whether a change worked. The gateway's
 * HTTP relay exposes the same flow on demand, so this button runs it now and shows the response
 * verbatim, including the error object. Verbatim matters: the interesting failures here have all
 * been buried inside a nested GraphQL error, and summarising them would have hidden every one. */
function TriggerPanel() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [batchSize, setBatchSize] = useState(25);

  async function run(path) {
    setBusy(true); setResult(null);
    try { setResult(await edge.trigger(path, { batchSize: Number(batchSize) })); }
    catch (e) { setResult({ ok: false, status: 0, ms: 0, body: { error: describeError(e) } }); }
    finally { setBusy(false); }
  }

  const failed = result && (!result.ok || (result.body && result.body.SUCCESS === false) || (result.body && result.body.error));

  return (
    <div className="card">
      <div className="card-head">
        <div className="card-title">Run the harvest now</div>
        <div className="spacer" />
        <div className="card-sub">runs the flow now via the gateway's HTTP relay, without waiting for its schedule</div>
      </div>
      <div className="card-body">
        <div className="row">
          <div className="field">
            <label htmlFor="bs">Batch size</label>
            <input id="bs" type="number" min="1" max="500" value={batchSize} style={{ width: 90 }}
                   onChange={e => setBatchSize(e.target.value)} />
          </div>
          <button className="btn primary" disabled={busy} onClick={() => run('harvest')}>
            {busy ? 'Running…' : 'Trigger harvest'}
          </button>
          <button className="btn" disabled={busy} onClick={() => run('smoke')}>Trigger smoke test</button>
          {result && (
            <span className="status" style={{ marginLeft: 4 }}>
              <span className={'dot ' + (failed ? 's-critical' : 's-good')} />
              HTTP {result.status} · {result.ms} ms
            </span>
          )}
        </div>

        {result && (
          <div style={{ marginTop: 12 }}>
            <div className="tile-label" style={{ marginBottom: 5 }}>
              {failed ? 'Flow reported a failure' : 'Flow response'}
            </div>
            <textarea readOnly rows={12} value={JSON.stringify(result.body, null, 2)}
                      style={{ width: '100%', color: failed ? 'var(--critical)' : 'var(--text-primary)' }} />
          </div>
        )}
      </div>
    </div>
  );
}

/* The edge hand-off: rollups the harvest flow has not collected yet.
 *
 * There is no live gateway feed here on purpose. The gateway is bound to a Fuuz tenant and reached
 * through it, not through this console — and the harvest flow that drains these rollups cannot run
 * while the platform's flow-execution worker is down. So this tab shows the QUEUE: if pending only
 * grows, nothing is draining it, which is exactly the symptom worth surfacing. */

/* How long ago, in words. A timestamp alone does not answer "is this thing running right now",
   which is the only question this tile exists to answer. */
function ago(iso) {
  if (!iso) { return null; }
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) { return Math.round(s) + 's ago'; }
  if (s < 5400) { return Math.round(s / 60) + 'm ago'; }
  if (s < 172800) { return Math.round(s / 3600) + 'h ago'; }
  return Math.round(s / 86400) + 'd ago';
}

export default function Gateway() {
  const pend = usePoll(() => hist.pendingRollups(60), []);
  const harvest = usePoll(() => hist.harvestStatus(), []);
  const edges = (pend.data && pend.data.tagAggregates && pend.data.tagAggregates.edges) || [];
  const rows = edges.map(e => e.node);

  /* Three states, decided by how recently anything was acknowledged. The cadence is five minutes,
     so a gap beyond ~12 means two runs were missed and something is wrong; beyond an hour it is
     not running at all. Reporting a hardcoded "Blocked" — as this tile used to — was wrong the
     moment the flow started working, and nobody would have noticed. */
  const hs = harvest.data && harvest.data.harvestStatus;
  const sinceMs = hs && hs.lastCollectedAt ? Date.now() - new Date(hs.lastCollectedAt).getTime() : null;
  const state = harvest.error
    ? { cls: 's-idle', word: 'Unknown', note: harvest.error }
    : !hs || sinceMs == null
      ? { cls: 's-critical', word: 'Never run', note: 'nothing has been acknowledged yet' }
      : sinceMs < 12 * 60e3
        ? { cls: 's-good', word: 'Running', note: 'last collected ' + ago(hs.lastCollectedAt) + ' by ' + (hs.lastCollectedBy || 'unknown') }
        : sinceMs < 60 * 60e3
          ? { cls: 's-warning', word: 'Stale', note: 'last collected ' + ago(hs.lastCollectedAt) + ' — cadence is 5m' }
          : { cls: 's-critical', word: 'Not running', note: 'last collected ' + ago(hs.lastCollectedAt) };

  return (
    <>
      <div className="grid cols-4">
        <div className="tile"><div className="tile-label">Rollups awaiting pickup</div>
          <div className="tile-value">{hs ? hs.pending.toLocaleString() : (pend.error ? '—' : '…')}</div>
          <div className="tile-note">{hs && hs.oldestPendingAt
            ? 'oldest ' + ago(hs.oldestPendingAt) : 'un-acknowledged 5-minute windows'}</div></div>

        {/* Derived from evidence, not asserted: a rollup only becomes "collected" when something
            acknowledged it, so a recent acknowledgement IS the harvest working. */}
        <div className="tile"><div className="tile-label">Harvest flow</div>
          <div className="tile-value" style={{ fontSize: 19 }}>
            <span className="status"><span className={'dot ' + state.cls} />{state.word}</span></div>
          <div className="tile-note">{state.note}</div></div>

        <div className="tile"><div className="tile-label">Rollups collected</div>
          <div className="tile-value">{hs ? hs.collected.toLocaleString() : '—'}</div>
          <div className="tile-note">{hs ? 'of ' + hs.total.toLocaleString() + ' total' : ''}</div></div>

        <div className="tile"><div className="tile-label">Delivery</div>
          <div className="tile-value" style={{ fontSize: 19 }}>At-least-once</div>
          <div className="tile-note">ack after landing; dedupe on tagPath|windowStart</div></div>
      </div>

      <TriggerPanel />

      <div className="card">
        <div className="card-head"><div className="card-title">Pending rollups</div>
          <div className="spacer" /><div className="card-sub">what the edge flow would collect next</div></div>
        <div className="scroll">
          {pend.error && <div className="card-body err">{pend.error}</div>}
          {!pend.error && !rows.length && <div className="empty">nothing pending — run an aggregation, or everything is collected</div>}
          {!!rows.length && (
            <table>
              <thead><tr><th>Tag</th><th>Window start</th><th className="num">Count</th>
                <th className="num">Min</th><th className="num">Max</th><th className="num">Avg</th>
                <th>Monotonic</th></tr></thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id}>
                    <td className="mono">{r.tagPath}</td>
                    <td className="mono muted">{new Date(r.windowStart).toLocaleString()}</td>
                    <td className="num">{r.count}</td>
                    <td className="num">{fmt(r.min)}</td>
                    <td className="num">{fmt(r.max)}</td>
                    <td className="num">{fmt(r.avg)}</td>
                    <td className="muted">{r.isMonotonic ? 'yes' : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}
