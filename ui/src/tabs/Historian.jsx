import React, { useState, useEffect } from 'react';
import { usePoll } from '../lib/usePoll.js';
import { hist, describeError } from '../lib/api.js';
import { TimeSeries, fmt } from '../components/Chart.jsx';
import Storage from '../components/Storage.jsx';

/* Query the time-series store and trend it.
 *
 * Two deliberate choices worth stating:
 *
 * 1. Bad-quality samples are INCLUDED by default and marked, not filtered. A trend that silently
 *    drops Bad points draws a clean line straight through a comms outage — which is the single
 *    most misleading thing a historian UI can do. The ringed red markers are the outage.
 * 2. Tags are picked from the tag master rather than typed. The master is the historian's own list
 *    of what exists, so the picker cannot ask for a tag that was never collected.
 */

const RANGES = [
  { id: '15m', label: 'Last 15 min', ms: 15 * 60e3 },
  { id: '1h',  label: 'Last hour',   ms: 60 * 60e3 },
  { id: '6h',  label: 'Last 6 hours', ms: 6 * 3600e3 },
  { id: '24h', label: 'Last 24 hours', ms: 24 * 3600e3 }
];

export default function Historian() {
  const masters = usePoll(() => hist.tagMasters(500), []);
  const status = usePoll(() => hist.status(), []);

  const [picked, setPicked] = useState([]);
  const [range, setRange] = useState('1h');
  const [includeBad, setIncludeBad] = useState(true);
  const [series, setSeries] = useState([]);
  const [agg, setAgg] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const tags = (masters.data && masters.data.tagMasters) || [];

  /* Default to something interesting rather than an empty chart on first open. */
  useEffect(() => {
    if (picked.length || !tags.length) { return; }
    const seed = tags.filter(t => /MotorTemp|Speed|Pressure/.test(t.tagPath)).slice(0, 2).map(t => t.tagPath);
    if (seed.length) { setPicked(seed); }
  }, [tags]);                                  // eslint-disable-line react-hooks/exhaustive-deps

  async function run() {
    if (!picked.length) { return; }
    setBusy(true); setErr(null);
    const ms = (RANGES.find(r => r.id === range) || RANGES[1]).ms;
    const toIso = new Date().toISOString();
    const fromIso = new Date(Date.now() - ms).toISOString();
    try {
      const loaded = [];
      for (const tag of picked) {
        const r = await hist.raw(tag, fromIso, toIso, includeBad, 600);
        const pts = (r.rawSamples || [])
          /* qualityGood is the historian's own verdict — use it rather than re-deriving the
             threshold here, so the chart and the store can never disagree about what is Bad. */
          .map(s => ({ t: new Date(s.occurredAt).getTime(),
                       v: typeof s.v === 'number' ? s.v
                          : (s.valueBool === true ? 1 : s.valueBool === false ? 0 : null),
                       bad: s.qualityGood === false }))
          .filter(p => p.v != null)
          .sort((a, b) => a.t - b.t);
        loaded.push({ name: tag.split('/').slice(-2).join('/'), points: pts });
      }
      setSeries(loaded);
      const a = await hist.aggregate(picked, fromIso, toIso);
      setAgg(a.histAggregate || []);
    } catch (e) { setErr(describeError(e)); }
    finally { setBusy(false); }
  }

  /* Re-query when the SELECTION changes too, not just the window. Without `picked` here the
     auto-seed above sets two tags and nothing ever fetches them, so the chart sits empty on first
     open — and clicking a tag appears to do nothing until you also touch a range button. */
  useEffect(() => { run(); }, [range, includeBad, picked.join('|')]);   // eslint-disable-line react-hooks/exhaustive-deps

  function toggle(tagPath) {
    setPicked(p => (p.includes(tagPath) ? p.filter(x => x !== tagPath) : p.length >= 4 ? p : p.concat(tagPath)));
  }

  const st = status.data && status.data.historianStatus;

  return (
    <>
      <div className="grid cols-4">
        <div className="tile"><div className="tile-label">Samples stored</div>
          <div className="tile-value">{st ? Number(st.count || 0).toLocaleString() : '—'}</div>
          <div className="tile-note">{st ? st.status : status.error || 'querying…'}</div></div>
        <div className="tile"><div className="tile-label">Tags in master</div>
          <div className="tile-value">{tags.length || '—'}</div>
          <div className="tile-note">registered by collectors</div></div>
        <div className="tile"><div className="tile-label">Selected</div>
          <div className="tile-value">{picked.length}<span className="muted" style={{ fontSize: 15 }}> / 4</span></div>
          <div className="tile-note">series on the chart</div></div>
        <div className="tile"><div className="tile-label">Window</div>
          <div className="tile-value" style={{ fontSize: 20 }}>{(RANGES.find(r => r.id === range) || {}).label}</div>
          <div className="tile-note">{includeBad ? 'bad quality shown' : 'good quality only'}</div></div>
      </div>

      {/* filters in one row above the chart */}
      <div className="card">
        <div className="card-body row">
          {RANGES.map(r => (
            <button key={r.id} className={'btn ' + (range === r.id ? 'primary' : '')}
                    onClick={() => setRange(r.id)}>{r.label}</button>
          ))}
          <label className="status" style={{ marginLeft: 8 }}>
            <input type="checkbox" checked={includeBad} onChange={e => setIncludeBad(e.target.checked)} />
            <span className="muted">include bad quality</span>
          </label>
          <div className="spacer" />
          <button className="btn primary" onClick={run} disabled={busy || !picked.length}>
            {busy ? 'Querying…' : 'Run query'}
          </button>
        </div>
      </div>

      {err && <div className="card"><div className="card-body err">{err}</div></div>}

      <div className="card">
        <div className="card-head">
          <div className="card-title">Trend</div>
          <div className="spacer" />
          <div className="card-sub">ringed red markers are Bad-quality samples</div>
        </div>
        <div className="card-body">
          {picked.length === 0 ? <div className="empty">pick a tag below</div>
            : <TimeSeries series={series} height={300} showTable />}
        </div>
      </div>

      {!!agg.length && (
        <div className="card">
          <div className="card-head"><div className="card-title">Aggregates over the window</div>
            <div className="spacer" />
            <div className="card-sub">the historian names which average is correct for each tag type</div></div>
          <div className="scroll">
            <table>
              <thead><tr><th>Tag</th><th className="num">Samples</th>
                <th className="num" title="Good / Uncertain / Bad — these sum to Samples">Quality</th>
                <th className="num" title="Share of the window covered by usable readings. Low coverage means a gap, not a measurement.">Coverage</th>
                <th className="num">Min</th><th className="num">p05</th><th className="num">p50</th>
                <th className="num">p95</th><th className="num">p99</th><th className="num">Max</th>
                <th className="num" title="Population standard deviation over the usable samples">σ</th>
                <th className="num">Arithmetic</th><th className="num">Time-wtd</th>
                <th>Preferred</th></tr></thead>
              <tbody>
                {agg.map(a => {
                  /* Coverage is the field that turns "we measured this" into "we measured this
                     WELL", so it is coloured rather than left as another number to scan past.
                     It is a FRACTION of the selected range, which is why the range length has to be
                     read back from the same table that drove the query. */
                  const windowMs = (RANGES.find(r => r.id === range) || RANGES[1]).ms;
                  const cov = a.coverageMs == null || !windowMs ? null : a.coverageMs / windowMs;
                  const covColour = cov == null ? undefined
                    : cov >= 0.95 ? 'var(--good)' : cov >= 0.75 ? 'var(--warning)' : 'var(--critical)';
                  return (
                    <tr key={a.tagPath}>
                      <td className="mono">{a.tagPath}</td>
                      <td className="num">{a.samples}</td>
                      <td className="num mono" style={{ fontSize: 12 }}>
                        {a.goodSamples}
                        <span className="muted"> / </span>
                        <span style={{ color: a.uncertainSamples ? 'var(--warning)' : undefined }}>{a.uncertainSamples}</span>
                        <span className="muted"> / </span>
                        <span style={{ color: a.badSamples ? 'var(--critical)' : undefined }}>{a.badSamples}</span>
                      </td>
                      <td className="num" style={{ color: covColour }}>{cov == null ? '—' : (cov * 100).toFixed(0) + '%'}</td>
                      <td className="num">{fmt(a.min)}</td>
                      <td className="num muted">{fmt(a.p05)}</td>
                      <td className="num">{fmt(a.p50)}</td>
                      <td className="num muted">{fmt(a.p95)}</td>
                      <td className="num muted">{fmt(a.p99)}</td>
                      <td className="num">{fmt(a.max)}</td>
                      <td className="num muted">{fmt(a.stdDev)}</td>
                      <td className="num">{fmt(a.arithmeticAvg)}</td>
                      <td className="num">{fmt(a.timeWeightedAvg)}</td>
                      <td className="muted">{a.preferredAvg}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <div className="card-title">Tag master</div>
          <div className="spacer" />
          <div className="card-sub">click to add or remove a series (max 4)</div>
        </div>
        <div className="scroll">
          {masters.error && <div className="card-body err">{masters.error}</div>}
          <table>
            <thead><tr><th>Tag</th><th>Type</th><th>Unit</th><th className="num">Range</th>
              <th>Interpolation</th><th className="num">Deadband</th><th className="num">Scan ms</th></tr></thead>
            <tbody>
              {tags.map(t => (
                <tr key={t.tagPath} onClick={() => toggle(t.tagPath)}
                    style={{ cursor: 'pointer', background: picked.includes(t.tagPath) ? 'var(--surface-2)' : undefined }}>
                  <td className="mono">
                    {picked.includes(t.tagPath) && <span className="dot s-good" style={{ marginRight: 7 }} />}
                    {t.tagPath}
                  </td>
                  <td className="muted">{t.tagType}</td>
                  <td className="muted">{t.unit || '—'}</td>
                  <td className="num muted">{t.engLow}–{t.engHigh}</td>
                  <td className="muted">{t.interpolation}</td>
                  <td className="num muted">{t.deadband}</td>
                  <td className="num muted">{t.scanRateMs || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Storage />
    </>
  );
}
