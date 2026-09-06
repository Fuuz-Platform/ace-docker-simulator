import React, { useState, useMemo } from 'react';
import { usePoll } from '../lib/usePoll.js';
import { sim } from '../lib/api.js';
import { fmt } from '../components/Chart.jsx';

/* Broker-style namespace browser: Plant > Area > Asset > Tag.
 *
 * This is the equipment hierarchy the way a tag broker or an OPC UA client sees it, and it maps
 * onto the conventional manufacturing levels — enterprise/site above (one tenant, one plant here),
 * area, work unit, and the signals hanging off it. The tree is read from the simulator's live
 * address space rather than from a stored model, so what you browse is genuinely what a gateway
 * would discover, node ids and all.
 *
 * Creating an asset or a tag writes into the RUNNING OPC UA server. Two honest caveats are shown
 * in the UI rather than buried: collectors that subscribed to a fixed node list (the bridge, and
 * the Fuuz DeviceSubscription with its 88 explicit node ids) will not pick a new tag up until they
 * re-subscribe; and nothing here writes to Fuuz — the tenant is populated by the ACE staging and
 * matching scripts, which keep an audit trail this console deliberately does not bypass.
 */

const KINDS = [
  { id: 'analog',   label: 'Analog (Double + EU range)' },
  { id: 'counter',  label: 'Counter (Int32, monotonic)' },
  { id: 'bool',     label: 'Discrete (Boolean)' },
  { id: 'setpoint', label: 'Setpoint (Double)' },
  { id: 'enum',     label: 'Enum (Int32 + states)' },
  { id: 'string',   label: 'String (context tag)' }
];

function qualityClass(q) {
  return q === 'Good' ? 's-good' : q === 'Uncertain' ? 's-warning' : 's-critical';
}

export default function Plant() {
  const { data, error, reload } = usePoll(() => sim.state().then(() =>
    fetch('/api/sim/tree').then(r => r.json())), []);

  const [open, setOpen] = useState({});
  const [sel, setSel] = useState(null);            /* { area, asset, tag? } */
  const [form, setForm] = useState(null);          /* 'asset' | 'tag' */
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [filter, setFilter] = useState('');

  const areas = (data && data.areas) || [];
  const counts = useMemo(() => {
    let assets = 0, tags = 0, bad = 0;
    areas.forEach(a => a.assets.forEach(x => {
      assets++; tags += x.tags.length; bad += x.tags.filter(t => t.quality === 'Bad').length;
    }));
    return { areas: areas.length, assets, tags, bad };
  }, [areas]);

  const q = filter.trim().toLowerCase();
  const match = t => !q || t.path.toLowerCase().includes(q) || t.name.toLowerCase().includes(q);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    const f = new FormData(e.target);
    try {
      if (form === 'asset') {
        const r = await fetch('/api/sim/assets', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ area: f.get('area'), code: f.get('code'), kind: f.get('kind') })
        }).then(async res => { const b = await res.json(); if (!res.ok) { throw new Error(b.error); } return b; });
        setMsg(`created ${r.area}/${r.code} with ${r.tags} tags`);
      } else {
        const r = await fetch('/api/sim/tags', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            asset: f.get('asset'), name: f.get('name'), kind: f.get('kind'),
            unit: f.get('unit'), lo: f.get('lo'), hi: f.get('hi')
          })
        }).then(async res => { const b = await res.json(); if (!res.ok) { throw new Error(b.error); } return b; });
        setMsg(`created ${r.nodeId}`);
      }
      setForm(null); reload();
    } catch (err) { setMsg(String(err.message || err)); }
    finally { setBusy(false); }
  }

  const selectedTag = sel && sel.tag
    ? (areas.find(a => a.name === sel.area) || { assets: [] }).assets
        .find(x => x.code === sel.asset)?.tags.find(t => t.name === sel.tag)
    : null;
  const allAssets = areas.flatMap(a => a.assets.map(x => x.code));

  if (error) { return <div className="card"><div className="card-body err">{error}</div></div>; }
  if (!data) { return <div className="empty">reading the address space…</div>; }

  return (
    <>
      <div className="grid cols-4">
        <div className="tile"><div className="tile-label">Plant</div>
          <div className="tile-value" style={{ fontSize: 20 }}>{data.plant}</div>
          <div className="tile-note mono" style={{ fontSize: 11 }}>{data.endpoint}</div></div>
        <div className="tile"><div className="tile-label">Areas</div>
          <div className="tile-value">{counts.areas}</div>
          <div className="tile-note">second level of the hierarchy</div></div>
        <div className="tile"><div className="tile-label">Assets</div>
          <div className="tile-value">{counts.assets}</div>
          <div className="tile-note">work units carrying tags</div></div>
        <div className="tile"><div className="tile-label">Tags</div>
          <div className="tile-value">{counts.tags}</div>
          <div className="tile-note">{counts.bad ? counts.bad + ' currently bad quality' : 'all good quality'}</div></div>
      </div>

      <div className="card">
        <div className="card-body row">
          <input type="text" placeholder="filter tags by path or name…" value={filter}
                 onChange={e => setFilter(e.target.value)} style={{ flex: 1, minWidth: 220 }} />
          <button className="btn" onClick={() => { setForm('asset'); setMsg(null); }}>+ Asset</button>
          <button className="btn" onClick={() => { setForm('tag'); setMsg(null); }}>+ Tag</button>
          <button className="btn" onClick={() => setOpen(Object.fromEntries(areas.map(a => [a.name, true])))}>Expand all</button>
          <button className="btn" onClick={() => setOpen({})}>Collapse</button>
          {msg && <span className="muted" style={{ fontSize: 12 }}>{msg}</span>}
        </div>

        {form && (
          <form onSubmit={submit} className="card-body row" style={{ borderTop: '1px solid var(--border)', alignItems: 'flex-end' }}>
            {form === 'asset' ? (
              <>
                <div className="field"><label>Area</label>
                  <input name="area" required placeholder="MIX" list="area-list" style={{ width: 110 }} />
                  <datalist id="area-list">{areas.map(a => <option key={a.name} value={a.name} />)}</datalist></div>
                <div className="field"><label>Asset code</label>
                  <input name="code" required placeholder="MIX-002" style={{ width: 140 }} /></div>
                <div className="field"><label>Kind</label>
                  <input name="kind" placeholder="Mixer" style={{ width: 140 }} /></div>
                <span className="muted" style={{ fontSize: 12, maxWidth: 300 }}>
                  gets the full standard signal set
                </span>
              </>
            ) : (
              <>
                <div className="field"><label>Asset</label>
                  <select name="asset" required defaultValue={sel ? sel.asset : ''} style={{ width: 140 }}>
                    <option value="">choose…</option>
                    {allAssets.map(c => <option key={c} value={c}>{c}</option>)}
                  </select></div>
                <div className="field"><label>Tag name</label>
                  <input name="name" required placeholder="Viscosity" style={{ width: 150 }} /></div>
                <div className="field"><label>Kind</label>
                  <select name="kind" defaultValue="analog" style={{ width: 200 }}>
                    {KINDS.map(k => <option key={k.id} value={k.id}>{k.label}</option>)}
                  </select></div>
                <div className="field"><label>Unit</label>
                  <input name="unit" placeholder="cP" style={{ width: 80 }} /></div>
                <div className="field"><label>Low</label>
                  <input name="lo" type="number" defaultValue="0" style={{ width: 84 }} /></div>
                <div className="field"><label>High</label>
                  <input name="hi" type="number" defaultValue="100" style={{ width: 84 }} /></div>
              </>
            )}
            <button className="btn primary" type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create'}</button>
            <button className="btn" type="button" onClick={() => setForm(null)}>Cancel</button>
          </form>
        )}
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'minmax(340px, 1.4fr) minmax(280px, 1fr)' }}>
        <div className="card">
          <div className="card-head"><div className="card-title">Namespace</div>
            <div className="spacer" />
            <div className="card-sub">Plant › Area › Asset › Tag</div></div>
          <div className="scroll" style={{ maxHeight: 560, padding: '6px 0' }}>
            {areas.map(a => {
              const visible = a.assets.map(x => ({ ...x, tags: x.tags.filter(match) }))
                                      .filter(x => !q || x.tags.length);
              if (q && !visible.length) { return null; }
              const isOpen = open[a.name] !== false && (q ? true : !!open[a.name]);
              return (
                <div key={a.name}>
                  <div onClick={() => setOpen(o => ({ ...o, [a.name]: !o[a.name] }))}
                       style={{ padding: '7px 14px', cursor: 'pointer', display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span className="muted" style={{ width: 10 }}>{isOpen ? '▾' : '▸'}</span>
                    <strong>{a.name}</strong>
                    <span className="muted" style={{ fontSize: 12 }}>{a.assets.length} assets</span>
                  </div>
                  {isOpen && visible.map(x => (
                    <div key={x.code}>
                      <div onClick={() => { setOpen(o => ({ ...o, [a.name + '/' + x.code]: !o[a.name + '/' + x.code] })); setSel({ area: a.name, asset: x.code }); }}
                           style={{ padding: '6px 14px 6px 34px', cursor: 'pointer', display: 'flex', gap: 8, alignItems: 'center',
                                    background: sel && sel.asset === x.code && !sel.tag ? 'var(--surface-2)' : undefined }}>
                        <span className="muted" style={{ width: 10 }}>{open[a.name + '/' + x.code] || q ? '▾' : '▸'}</span>
                        <span>{x.code}</span>
                        <span className="muted" style={{ fontSize: 12 }}>{x.kind}</span>
                        {x.fault !== 'NONE' && (
                          <span className="status" style={{ marginLeft: 'auto' }}>
                            <span className={'dot ' + (x.fault === 'COMMS' ? 's-critical' : 's-warning')} />{x.fault}</span>
                        )}
                      </div>
                      {(open[a.name + '/' + x.code] || q) && x.tags.map(t => (
                        <div key={t.name} onClick={() => setSel({ area: a.name, asset: x.code, tag: t.name })}
                             style={{ padding: '5px 14px 5px 60px', cursor: 'pointer', display: 'flex', gap: 8, alignItems: 'center',
                                      background: sel && sel.tag === t.name && sel.asset === x.code ? 'var(--surface-2)' : undefined }}>
                          <span className={'dot ' + qualityClass(t.quality)} />
                          <span style={{ fontSize: 13 }}>{t.name}</span>
                          {t.custom && <span className="muted" style={{ fontSize: 10, border: '1px solid var(--border)', borderRadius: 3, padding: '0 4px' }}>custom</span>}
                          <span className="mono muted" style={{ marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }}>
                            {typeof t.value === 'number' ? fmt(t.value) : String(t.value)}{t.unit ? ' ' + t.unit : ''}
                          </span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>

        <div className="card">
          <div className="card-head"><div className="card-title">Details</div></div>
          <div className="card-body">
            {!sel && <div className="empty">select an asset or tag</div>}
            {sel && !selectedTag && (
              <table><tbody>
                <tr><td className="muted">Area</td><td>{sel.area}</td></tr>
                <tr><td className="muted">Asset</td><td><strong>{sel.asset}</strong></td></tr>
                <tr><td className="muted">Tags</td><td>
                  {(areas.find(a => a.name === sel.area)?.assets.find(x => x.code === sel.asset)?.tags.length) || 0}</td></tr>
                <tr><td className="muted">Path</td><td className="mono">Plant/{sel.area}/{sel.asset}</td></tr>
              </tbody></table>
            )}
            {selectedTag && (
              <table><tbody>
                <tr><td className="muted">Tag</td><td><strong>{selectedTag.name}</strong></td></tr>
                <tr><td className="muted">Value</td><td className="mono">
                  {typeof selectedTag.value === 'number' ? fmt(selectedTag.value) : String(selectedTag.value)}
                  {selectedTag.unit ? ' ' + selectedTag.unit : ''}</td></tr>
                <tr><td className="muted">Quality</td><td>
                  <span className="status"><span className={'dot ' + qualityClass(selectedTag.quality)} />{selectedTag.quality}</span></td></tr>
                <tr><td className="muted">Semantic type</td><td>{selectedTag.type}</td></tr>
                <tr><td className="muted">Data kind</td><td>{selectedTag.kind}</td></tr>
                <tr><td className="muted">EU range</td><td className="mono">{selectedTag.lo} – {selectedTag.hi}</td></tr>
                <tr><td className="muted">Browse path</td><td className="mono" style={{ wordBreak: 'break-all' }}>{selectedTag.path}</td></tr>
                <tr><td className="muted">Node id</td><td className="mono" style={{ wordBreak: 'break-all' }}>{selectedTag.nodeId}</td></tr>
              </tbody></table>
            )}
            <div className="tile-note" style={{ marginTop: 14, lineHeight: 1.5 }}>
              Creating here writes to the live OPC UA address space. Collectors that subscribed to a
              fixed node list — the bridge, and the Fuuz device subscription — only pick new tags up
              after they re-subscribe. Nothing here writes to Fuuz; the tenant is populated by the
              ACE staging and matching scripts, which keep an audit trail.
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
