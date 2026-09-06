import React, { useState, useEffect, useCallback } from 'react';
import { hist, describeError } from '../lib/api.js';

/* LOCAL STORE — what is on disk, how long it stays, and how to clear it.
 *
 * WHY THIS PANEL EXISTS. The local historian fills up quietly. 17 million raw samples and 743 MB
 * accumulated here before anyone looked, and the reason nobody looked is that nothing showed the
 * number. A retention policy you cannot see is a retention policy you do not have.
 *
 * WHY PURGE IS SCOPED RATHER THAN ONE BUTTON. Raw samples regenerate from the simulator in minutes,
 * so dropping them costs nothing. Rollups do not regenerate: once a window's samples expire, the
 * rollup is the only record that window ever happened — that is the entire reason it is computed.
 * The tag master is what every rollup and candidate refers to by tagPath. Making those one
 * undifferentiated "wipe" would price the cheap action and the expensive one identically.
 *
 * WHY IT ASKS TWICE. Not ceremony: the first click names what will go and how much, because "purge
 * 17,443,603 samples / 743 MB" is a different decision from "purge".
 */

const SCOPES = [
  { id: 'raw', label: 'Raw samples', coll: 'tagValue',
    blurb: 'Every collected sample. Regenerates from the simulator within minutes.' },
  { id: 'aggregates', label: 'Rollups', coll: 'tagAggregate',
    blurb: 'Windowed statistics. NOT recoverable — once the samples behind a window expire, this is the only record it existed.' },
  { id: 'master', label: 'Tag registry', coll: 'tagMaster',
    blurb: 'One row per tag. Rollups and candidates refer to these by tagPath; clearing it orphans those references.' },
  { id: 'vectors', label: 'Vectors', coll: 'aceVector',
    blurb: 'Embeddings and their search index. Re-embedding is a minutes-long job, not a free one.' },
  { id: 'all', label: 'Everything', coll: null,
    blurb: 'All four. The local store returns to the state of a fresh stack.' }
];

const n = v => (v === null || v === undefined ? '—' : Number(v).toLocaleString());

export default function Storage() {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const [confirming, setConfirming] = useState(null);
  const [busy, setBusy] = useState(null);
  const [result, setResult] = useState(null);

  const load = useCallback(async () => {
    try { const d = await hist.storage(); setRows(d.storageStatus); setErr(null); }
    catch (e) { setErr(describeError ? describeError(e) : e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const byName = Object.fromEntries((rows || []).map(r => [r.name, r]));
  const totals = (rows || []).reduce((a, r) => ({ docs: a.docs + r.docs, mb: a.mb + r.storageMB }), { docs: 0, mb: 0 });

  const scopeStats = s => {
    if (s.id === 'all') { return totals; }
    const r = byName[s.coll];
    return { docs: r ? r.docs : 0, mb: r ? r.storageMB : 0 };
  };

  const purge = async scope => {
    setBusy(scope); setConfirming(null); setResult(null);
    try {
      const d = await hist.purge(scope);
      setResult(d.purgeHistorian);
      await load();
    } catch (e) { setErr(describeError ? describeError(e) : e.message); }
    finally { setBusy(null); }
  };

  return (
    <div className="card">
      <div className="card-head">
        <div className="card-title">Local store</div>
        <div className="card-sub">
          what is on disk and how long it stays. Only raw samples expire automatically —
          everything else grows until it is cleared here.
        </div>
      </div>
      <div className="card-body">
        {err && <div className="err" onClick={() => setErr(null)}>{err} <span className="muted">(click to dismiss)</span></div>}

        <table>
          <thead>
            <tr><th>Collection</th><th>Kind</th><th>Retention</th><th className="num">Documents</th><th className="num">Size</th></tr>
          </thead>
          <tbody>
            {(rows || []).map(r => (
              <tr key={r.name}>
                <td className="mono">{r.name}</td>
                <td className="muted">{r.kind}</td>
                <td className={r.ttlDays === null ? 'warn' : ''}>
                  {r.ttlDays === null
                    ? <span title="nothing removes these automatically">never expires</span>
                    : r.ttlDays + ' days'}
                </td>
                <td className="num">{n(r.docs)}</td>
                <td className="num">{r.storageMB.toFixed(1)} MB</td>
              </tr>
            ))}
            {rows && (
              <tr>
                <td colSpan={3}><strong>Total</strong></td>
                <td className="num"><strong>{n(totals.docs)}</strong></td>
                <td className="num"><strong>{totals.mb.toFixed(1)} MB</strong></td>
              </tr>
            )}
            {!rows && <tr><td colSpan={5} className="muted">reading…</td></tr>}
          </tbody>
        </table>

        <div className="card-sub" style={{ marginTop: 14, marginBottom: 6 }}>
          Clearing is immediate and cannot be undone. Each scope names what it takes.
        </div>

        <table>
          <tbody>
            {SCOPES.map(s => {
              const st = scopeStats(s);
              const armed = confirming === s.id;
              return (
                <tr key={s.id}>
                  <td style={{ width: '18%' }}><strong>{s.label}</strong>
                    {s.coll && <div className="muted mono small">{s.coll}</div>}</td>
                  <td className="muted small">{s.blurb}</td>
                  <td className="num" style={{ width: '18%' }}>
                    {n(st.docs)} docs<br /><span className="muted">{st.mb.toFixed(1)} MB</span>
                  </td>
                  <td className="num" style={{ width: '22%' }}>
                    {armed ? (
                      <div className="row" style={{ justifyContent: 'flex-end' }}>
                        <button className="btn danger" disabled={!!busy} onClick={() => purge(s.id)}>
                          Delete {n(st.docs)} docs
                        </button>
                        <button className="btn" disabled={!!busy} onClick={() => setConfirming(null)}>Cancel</button>
                      </div>
                    ) : (
                      <button className="btn" disabled={!!busy || !st.docs}
                              title={st.docs ? '' : 'already empty'}
                              onClick={() => { setConfirming(s.id); setResult(null); }}>
                        {busy === s.id ? 'clearing…' : 'Clear'}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {result && (
          <div className="ok" style={{ marginTop: 12 }}>
            Cleared <strong>{result.scope}</strong> — dropped {result.dropped.join(', ') || 'nothing'},
            {' '}{n(result.docsBefore)} documents removed, {result.freedMB.toFixed(1)} MB freed.
            {result.docsAfter > 0 && <> {n(result.docsAfter)} document(s) already written since.</>}
            {result.rebuilt && result.rebuilt.length > 0 &&
              <div className="muted small">rebuilt — {result.rebuilt.join(' · ')}</div>}
          </div>
        )}
      </div>
    </div>
  );
}
