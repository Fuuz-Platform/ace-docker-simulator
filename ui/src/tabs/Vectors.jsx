import React, { useState } from 'react';
import { usePoll } from '../lib/usePoll.js';
import { hist, orch, describeError } from '../lib/api.js';
import { Bars } from '../components/Chart.jsx';

/* ACE side of the house: the vector index and the semantic-similarity probe.
   Kept read-only on purpose — matching decisions are written by run-ace.js with a MatchingRun and a
   decision-event trail behind them. A console that could quietly bind an asset would sidestep that
   audit trail, so it does not offer to. */

export default function Vectors() {
  const idx = usePoll(() => hist.indexStatus(), []);
  const health = usePoll(() => orch.health(), []);
  const [q, setQ] = useState('motor temperature on the capper');
  const [hits, setHits] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function search() {
    setBusy(true); setErr(null);
    try { setHits(await orch.similar(q, 8)); }
    catch (e) { setErr(describeError(e)); setHits(null); }
    finally { setBusy(false); }
  }

  const s = idx.data && idx.data.indexStatus;
  const rows = (hits && (hits.hits || hits.results || [])) || [];

  return (
    <>
      <div className="grid cols-4">
        <div className="tile"><div className="tile-label">Index</div>
          <div className="tile-value" style={{ fontSize: 19 }}>{s ? s.name : '—'}</div>
          <div className="tile-note">{s ? s.status : idx.error || 'querying…'}</div></div>
        <div className="tile"><div className="tile-label">Queryable</div>
          <div className="tile-value" style={{ fontSize: 19 }}>
            <span className="status"><span className={'dot ' + (s && s.queryable ? 's-good' : 's-warning')} />
            {s ? (s.queryable ? 'Yes' : 'Building') : '—'}</span></div>
          <div className="tile-note">mongot must have finished indexing</div></div>
        <div className="tile"><div className="tile-label">Vectors</div>
          <div className="tile-value">{s ? Number(s.count).toLocaleString() : '—'}</div>
          <div className="tile-note">embedded candidates</div></div>
        <div className="tile"><div className="tile-label">Dimensions</div>
          <div className="tile-value">{s ? s.dims : '—'}</div>
          <div className="tile-note">{(health.data && health.data.config && health.data.config.embedModel) || 'embedding model'}</div></div>
      </div>

      <div className="card">
        <div className="card-head"><div className="card-title">Semantic search</div>
          <div className="spacer" /><div className="card-sub">embeds the phrase, then $vectorSearch</div></div>
        <div className="card-body">
          <div className="row">
            <input type="text" value={q} onChange={e => setQ(e.target.value)} style={{ flex: 1, minWidth: 260 }}
                   onKeyDown={e => e.key === 'Enter' && search()} />
            <button className="btn primary" onClick={search} disabled={busy}>{busy ? 'Searching…' : 'Search'}</button>
          </div>
          {err && <div className="err" style={{ marginTop: 10 }}>{err}</div>}
          {rows.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <Bars rows={rows.slice(0, 8).map(h => ({
                label: h.tag || h.text || h.externalKeyPath || h.id || '(unnamed)',
                value: Math.round((h.score || 0) * 1000) / 1000
              }))} />
            </div>
          )}
          {hits && !rows.length && <div className="empty">no matches returned</div>}
        </div>
      </div>
    </>
  );
}
