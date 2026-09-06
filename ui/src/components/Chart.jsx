import React, { useState, useRef, useMemo } from 'react';

/* Charts are hand-rolled SVG rather than a charting library.
 *
 * Not for bundle size — because the spec these follow (2px strokes, >=8px hit targets, a crosshair
 * on every line chart, a legend whenever there are two or more series, direct labels, recessive
 * grid, a table view as the relief for low-contrast marks) is easier to satisfy exactly than to
 * coax out of a library's theming layer. Every rule below is deliberate.
 */

export const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)',
                       'var(--series-5)', 'var(--series-6)', 'var(--series-7)', 'var(--series-8)'];

const fmt = (v, digits) => {
  if (v == null || Number.isNaN(v)) { return '—'; }
  const a = Math.abs(v);
  if (a >= 1e6) { return (v / 1e6).toFixed(1) + 'M'; }
  if (a >= 1e4) { return (v / 1e3).toFixed(1) + 'k'; }
  return v.toFixed(digits == null ? (a < 10 ? 2 : 1) : digits);
};
const clockOf = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/* ── time-series line chart ────────────────────────────────────────────────────────────────── */
export function TimeSeries({ series, height = 260, yUnit = '', showTable = false }) {
  const [hover, setHover] = useState(null);
  const [table, setTable] = useState(false);
  const ref = useRef(null);

  const live = (series || []).filter(s => s.points && s.points.length);
  const geom = useMemo(() => {
    if (!live.length) { return null; }
    let tMin = Infinity, tMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    live.forEach(s => s.points.forEach(p => {
      if (p.t < tMin) { tMin = p.t; } if (p.t > tMax) { tMax = p.t; }
      if (p.v < vMin) { vMin = p.v; } if (p.v > vMax) { vMax = p.v; }
    }));
    if (vMin === vMax) { vMin -= 1; vMax += 1; }             /* a flat line still needs a band */
    const pad = (vMax - vMin) * 0.08;
    return { tMin, tMax, vMin: vMin - pad, vMax: vMax + pad };
  }, [live]);

  if (!live.length) { return <div className="empty">no data in range</div>; }

  const W = 1000, H = height, M = { t: 12, r: 62, b: 26, l: 52 };   /* right margin holds direct labels */
  const px = t => M.l + ((t - geom.tMin) / Math.max(1, geom.tMax - geom.tMin)) * (W - M.l - M.r);
  const py = v => M.t + (1 - (v - geom.vMin) / (geom.vMax - geom.vMin)) * (H - M.t - M.b);

  const ticks = 4;
  const yTicks = Array.from({ length: ticks + 1 }, (_, i) => geom.vMin + (i / ticks) * (geom.vMax - geom.vMin));
  const xTicks = Array.from({ length: 5 }, (_, i) => geom.tMin + (i / 4) * (geom.tMax - geom.tMin));

  function onMove(e) {
    const rect = ref.current.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * W;
    if (x < M.l || x > W - M.r) { return setHover(null); }
    const t = geom.tMin + ((x - M.l) / (W - M.l - M.r)) * (geom.tMax - geom.tMin);
    const rows = live.map((s, i) => {
      let best = null, bd = Infinity;
      s.points.forEach(p => { const d = Math.abs(p.t - t); if (d < bd) { bd = d; best = p; } });
      return { name: s.name, color: s.color || SERIES[i % 8], point: best };
    }).filter(r => r.point);
    if (!rows.length) { return setHover(null); }
    setHover({ x: px(rows[0].point.t), t: rows[0].point.t, rows });
  }

  return (
    <div>
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height, display: 'block' }}
           onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img">
        {/* recessive grid — hairlines, never competing with the data */}
        {yTicks.map((v, i) => (
          <g key={i}>
            <line x1={M.l} x2={W - M.r} y1={py(v)} y2={py(v)} stroke="var(--grid)" strokeWidth="1" />
            <text x={M.l - 8} y={py(v) + 4} textAnchor="end" fontSize="11"
                  fill="var(--text-muted)" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(v)}</text>
          </g>
        ))}
        <line x1={M.l} x2={W - M.r} y1={H - M.b} y2={H - M.b} stroke="var(--axis)" strokeWidth="1" />
        {xTicks.map((t, i) => (
          <text key={i} x={px(t)} y={H - M.b + 16} textAnchor="middle" fontSize="11"
                fill="var(--text-muted)" style={{ fontVariantNumeric: 'tabular-nums' }}>{clockOf(t)}</text>
        ))}

        {live.map((s, i) => {
          const color = s.color || SERIES[i % 8];
          const d = s.points.map((p, j) => (j ? 'L' : 'M') + px(p.t) + ' ' + py(p.v)).join(' ');
          const last = s.points[s.points.length - 1];
          return (
            <g key={s.name}>
              <path d={d} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
              {/* Bad-quality samples get a ringed marker: quality is never left to colour alone. */}
              {s.points.filter(p => p.bad).map((p, k) => (
                <circle key={k} cx={px(p.t)} cy={py(p.v)} r="4"
                        fill="var(--critical)" stroke="var(--surface-1)" strokeWidth="2" />
              ))}
              {/* direct label at the line end — identity without a legend round-trip */}
              {live.length <= 4 && (
                <text x={px(last.t) + 7} y={py(last.v) + 4} fontSize="11" fill="var(--text-secondary)">{s.name}</text>
              )}
            </g>
          );
        })}

        {hover && (
          <g pointerEvents="none">
            <line x1={hover.x} x2={hover.x} y1={M.t} y2={H - M.b} stroke="var(--text-muted)" strokeWidth="1" strokeDasharray="3 3" />
            {hover.rows.map((r, i) => (
              <circle key={i} cx={px(r.point.t)} cy={py(r.point.v)} r="4.5"
                      fill={r.color} stroke="var(--surface-1)" strokeWidth="2" />
            ))}
          </g>
        )}
      </svg>

      {hover && (
        <div className="mono" style={{
          border: '1px solid var(--border)', background: 'var(--surface-2)', borderRadius: 6,
          padding: '7px 10px', marginTop: 6, display: 'inline-block'
        }}>
          <div className="muted" style={{ marginBottom: 3 }}>{new Date(hover.t).toLocaleString()}</div>
          {hover.rows.map((r, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span className="dot" style={{ background: r.color }} />
              <span style={{ color: 'var(--text-secondary)' }}>{r.name}</span>
              <span style={{ marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }}>
                {fmt(r.point.v)}{yUnit ? ' ' + yUnit : ''}{r.point.bad ? '  BAD' : ''}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Legend whenever there are two or more series — identity is never colour alone. */}
      {live.length > 1 && (
        <div className="row" style={{ marginTop: 8, gap: 14 }}>
          {live.map((s, i) => (
            <span key={s.name} className="status">
              <span className="dot" style={{ background: s.color || SERIES[i % 8] }} />
              <span style={{ color: 'var(--text-secondary)' }}>{s.name}</span>
            </span>
          ))}
          {showTable && (
            <button className="btn" style={{ marginLeft: 'auto' }} onClick={() => setTable(t => !t)}>
              {table ? 'Hide' : 'Show'} table
            </button>
          )}
        </div>
      )}

      {table && (
        <div className="scroll" style={{ marginTop: 10 }}>
          <table>
            <thead><tr><th>Time</th>{live.map(s => <th key={s.name} className="num">{s.name}</th>)}</tr></thead>
            <tbody>
              {live[0].points.map((p, i) => (
                <tr key={i}>
                  <td className="mono">{clockOf(p.t)}</td>
                  {live.map(s => <td key={s.name} className="num">{fmt(s.points[i] && s.points[i].v)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ── horizontal bars, for counts by category ───────────────────────────────────────────────── */
export function Bars({ rows, unit = '' }) {
  const max = Math.max(1, ...rows.map(r => r.value));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      {rows.map((r, i) => (
        <div key={r.label} title={`${r.label}: ${r.value}${unit}`}>
          <div style={{ display: 'flex', fontSize: 12, marginBottom: 3 }}>
            <span style={{ color: 'var(--text-secondary)' }}>{r.label}</span>
            <span className="mono" style={{ marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }}>
              {r.value.toLocaleString()}{unit}
            </span>
          </div>
          {/* 4px rounded data-end, anchored to the baseline; track stays recessive */}
          <div style={{ height: 8, background: 'var(--grid)', borderRadius: 4 }}>
            <div style={{ width: (r.value / max) * 100 + '%', height: '100%',
                          background: r.color || SERIES[i % 8], borderRadius: 4 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── sparkline: shape only, no axes — never the primary read ───────────────────────────────── */
export function Spark({ points, color, width = 120, height = 28 }) {
  if (!points || points.length < 2) { return <span className="muted mono">—</span>; }
  const vs = points.map(p => p.v);
  const lo = Math.min(...vs), hi = Math.max(...vs), span = hi - lo || 1;
  const d = points.map((p, i) =>
    (i ? 'L' : 'M') + (i / (points.length - 1)) * width + ' ' + (height - ((p.v - lo) / span) * height)).join(' ');
  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      <path d={d} fill="none" stroke={color || 'var(--series-1)'} strokeWidth="2"
            strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export { fmt };
