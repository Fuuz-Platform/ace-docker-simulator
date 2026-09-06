import React, { useState, useEffect, useRef } from 'react';
import { usePoll } from '../lib/usePoll.js';
import { sim } from '../lib/api.js';
import { Spark, fmt } from '../components/Chart.jsx';

/* The simulator publishes its own fault vocabulary at /faults. Hardcoding the list here would go
   stale the moment a condition is added to the simulator, and the dropdown would quietly offer a
   value the plant does not implement — or omit one it does. */

/* Watch the plant and change it.
 *
 * The value history is kept CLIENT-side: the control API reports the current value, not a series,
 * and adding a ring buffer to the simulator would duplicate the historian's job. So each poll
 * appends to an in-memory buffer, which is enough for the sparkline's "what is this doing right
 * now" question. Anything longer-range is the Historian tab, reading real stored samples.
 */
const HISTORY = 60;

export default function Simulator() {
  const { data, error, at } = usePoll(() => sim.state(), []);
  const faultList = usePoll(() => sim.faults(), []);
  const FAULTS = (faultList.data && faultList.data.available) || ['NONE'];
  const [pending, setPending] = useState(null);
  const [msg, setMsg] = useState(null);
  const [selected, setSelected] = useState(null);
  const hist = useRef({});                     /* "UNIT/Signal" -> [{t, v}] */

  useEffect(() => {
    if (!data) { return; }
    const t = Date.now();
    data.units.forEach(u => u.signals.forEach(s => {
      if (typeof s.value !== 'number') { return; }
      const k = u.code + '/' + s.name;
      const arr = hist.current[k] || (hist.current[k] = []);
      arr.push({ t, v: s.value });
      if (arr.length > HISTORY) { arr.shift(); }
    }));
  }, [data]);

  async function apply(patch) {
    setPending(patch); setMsg(null);
    try { await sim.setParams(patch); setMsg('applied'); }
    catch (e) { setMsg(String(e.message || e)); }
    finally { setPending(null); }
  }
  async function inject(unit, fault) {
    setMsg(null);
    try {
      await sim.setFault(unit, fault, fault === 'NONE' ? 0 : 600000);
      setMsg(fault === 'NONE' ? `${unit} released to the scheduler` : `${unit} pinned to ${fault}`);
    } catch (e) { setMsg(String(e.message || e)); }
  }

  if (error) { return <div className="card"><div className="card-body err">{error}</div></div>; }
  if (!data) { return <div className="empty">connecting to the simulator…</div>; }

  const unit = data.units.find(u => u.code === selected) || null;

  return (
    <>
      <div className="card">
        <div className="card-head">
          <div className="card-title">Plant controls</div>
          <div className="spacer" />
          <div className="card-sub mono">{data.endpoint}</div>
        </div>
        <div className="card-body">
          <div className="row" style={{ gap: 22, alignItems: 'flex-end' }}>
            <div className="field">
              <label htmlFor="tick">Tick interval — {data.tickMs} ms</label>
              <input id="tick" type="range" min="100" max="10000" step="100" value={data.tickMs}
                     style={{ width: 210 }}
                     onChange={e => apply({ tickMs: Number(e.target.value) })} />
            </div>
            <div className="field">
              <label htmlFor="fr">Fault rate — {(data.faultRate * 100).toFixed(0)}%</label>
              <input id="fr" type="range" min="0" max="1" step="0.05" value={data.faultRate}
                     style={{ width: 180 }}
                     onChange={e => apply({ faultRate: Number(e.target.value) })} />
            </div>
            <div className="field">
              <label htmlFor="nz">Noise — {data.noise.toFixed(2)}×</label>
              <input id="nz" type="range" min="0" max="5" step="0.1" value={data.noise}
                     style={{ width: 180 }}
                     onChange={e => apply({ noise: Number(e.target.value) })} />
            </div>
            <button className={'btn ' + (data.paused ? 'primary' : '')} disabled={!!pending}
                    onClick={() => apply({ paused: !data.paused })}>
              {data.paused ? 'Resume plant' : 'Pause plant'}
            </button>
            {msg && <span className="muted" style={{ fontSize: 12 }}>{msg}</span>}
          </div>
          <div className="tile-note" style={{ marginTop: 10 }}>
            {data.unitCount} units × {data.signalsPerUnit} signals = {data.tagCount} tags ·
            values update every {data.tickMs} ms · last read {at ? new Date(at).toLocaleTimeString() : '—'}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div className="card-title">Units</div>
          <div className="spacer" />
          <div className="card-sub">pin a condition to make a demo reproducible</div>
        </div>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Unit</th><th>Area</th><th>Kind</th><th>Condition</th>
                <th className="num">Bad</th><th className="num">Uncertain</th><th>Inject</th>
              </tr>
            </thead>
            <tbody>
              {data.units.map(u => {
                const bad = u.signals.filter(s => s.quality === 'Bad').length;
                const unc = u.signals.filter(s => s.quality === 'Uncertain').length;
                const cls = u.fault === 'NONE' ? 's-good' : u.fault === 'COMMS' ? 's-critical' : 's-warning';
                return (
                  <tr key={u.code} style={{ background: selected === u.code ? 'var(--surface-2)' : undefined, cursor: 'pointer' }}
                      onClick={() => setSelected(selected === u.code ? null : u.code)}>
                    <td><strong>{u.code}</strong></td>
                    <td className="muted">{u.area}</td>
                    <td className="muted">{u.kind}</td>
                    <td><span className="status"><span className={'dot ' + cls} />{u.fault}</span></td>
                    <td className="num">{bad || ''}</td>
                    <td className="num">{unc || ''}</td>
                    <td onClick={e => e.stopPropagation()}>
                      <select value="" onChange={e => e.target.value && inject(u.code, e.target.value)}>
                        <option value="">choose…</option>
                        {FAULTS.map(f => <option key={f} value={f}>{f === 'NONE' ? 'release' : f}</option>)}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {unit && (
        <div className="card">
          <div className="card-head">
            <div className="card-title">{unit.code} — live signals</div>
            <div className="spacer" />
            <div className="card-sub">client-side buffer, last {HISTORY} polls</div>
          </div>
          <div className="scroll">
            <table>
              <thead>
                <tr><th>Signal</th><th>Type</th><th className="num">Value</th><th>Unit</th>
                    <th>Quality</th><th className="num">Range</th><th>Recent</th></tr>
              </thead>
              <tbody>
                {unit.signals.map(s => {
                  const k = unit.code + '/' + s.name;
                  const cls = s.quality === 'Good' ? 's-good' : s.quality === 'Uncertain' ? 's-warning' : 's-critical';
                  return (
                    <tr key={s.name}>
                      <td>{s.name}</td>
                      <td className="muted">{s.type}</td>
                      <td className="num">{typeof s.value === 'number' ? fmt(s.value) : String(s.value)}</td>
                      <td className="muted">{s.unit || '—'}</td>
                      <td><span className="status"><span className={'dot ' + cls} />{s.quality}</span></td>
                      <td className="num muted">{s.lo}–{s.hi}</td>
                      <td><Spark points={hist.current[k] || []} color={s.quality === 'Good' ? 'var(--series-1)' : 'var(--warning)'} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
