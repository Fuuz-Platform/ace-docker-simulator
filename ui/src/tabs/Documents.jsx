import React, { useState, useContext, useCallback, useEffect } from 'react';
import { RefreshContext } from '../App.jsx';
import { docs } from '../lib/api.js';

/* DOCUMENTS — the unstructured feed.
 *
 * The tab exists to make one thing legible: where a drawing is in a three-step journey, and which
 * step broke when it did. Push, read, stage are shown as separate states rather than a spinner and
 * a result, because "the extraction is wrong" and "the file never reached Fuuz" need different
 * fixes and a single progress bar hides which one happened.
 *
 * Tags are shown BEFORE anything is staged. A vision model reading a drawing is the one step in
 * this pipeline a person should eyeball, and staging 40 misread tags is far more annoying to undo
 * than glancing at them first.
 */

const STEPS = [
  { key: 'inFuuz',  label: 'in Fuuz',   done: d => !!d.fuuzFileId,
    hint: d => d.fuuzFileId ? 'fileId ' + d.fuuzFileId : 'not pushed yet' },
  { key: 'read',    label: 'read',      done: d => !!d.extraction,
    hint: d => d.extraction ? d.extraction.tags.length + ' tags in ' + d.extraction.ms + ' ms' : 'not read yet' },
  { key: 'staged',  label: 'staged',    done: d => !!d.staged,
    hint: d => d.staged ? d.staged.count + ' candidates' : 'no candidates yet' }
];

function Pill({ on, children, title }) {
  return <span className={'pill' + (on ? ' ok' : '')} title={title}>{children}</span>;
}

export default function Documents() {
  const { tick } = useContext(RefreshContext);
  const [state, setState] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null);
  const [open, setOpen] = useState(null);
  const [note, setNote] = useState(null);

  const reload = useCallback(async () => {
    try { setState(await docs.list()); setErr(null); }
    catch (e) { setErr(e.message); }
  }, []);
  useEffect(() => { reload(); }, [reload, tick]);

  const act = async (label, fn) => {
    setBusy(label); setNote(null);
    try { const r = await fn(); setNote(r); await reload(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(null); }
  };

  /* Read the file in the browser and hand the bytes over as base64 — the console never needs a
     multipart parser and the drop directory stays the path for anything bulk. */
  const onFiles = async fileList => {
    for (const f of Array.from(fileList)) {
      const b64 = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result).split(',')[1]);
        r.onerror = () => rej(new Error('could not read ' + f.name));
        r.readAsDataURL(f);
      });
      await act('upload ' + f.name, () => docs.upload(f.name, b64));
    }
  };

  const list = (state && state.docs) || [];

  return (
    <div className="tab">
      <div className="row between">
        <div>
          <h2>Documents</h2>
          <div className="muted small">
            Unstructured feed. A drawing is pushed into the Fuuz <code>File</code> model, read by a
            vision model, and staged as <code>EntityMatchCandidate</code> rows — the same input the
            structured feeds produce, so match, approve and bridge are shared rather than rebuilt.
          </div>
        </div>
        <div className="row">
          <button disabled={!!busy} onClick={() => act('scan', docs.scan)}>
            {busy === 'scan' ? 'scanning…' : 'Scan drop folder'}
          </button>
          <label className="btn">
            Add files…
            <input type="file" multiple style={{ display: 'none' }}
                   onChange={e => { onFiles(e.target.files); e.target.value = ''; }} />
          </label>
        </div>
      </div>

      {state && (
        <div className="muted small mono" style={{ marginTop: 8 }}>
          drop <code>{state.dropDir}</code> · vision <code>{state.visionModel}</code> ·
          stages as <code>{state.externalSystem}</code> → <code>{state.destinationModel}</code>
        </div>
      )}

      {err && <div className="error" onClick={() => setErr(null)}>{err} <span className="muted">(click to dismiss)</span></div>}

      <div
        className="dropzone"
        onDragOver={e => e.preventDefault()}
        onDrop={e => { e.preventDefault(); onFiles(e.dataTransfer.files); }}
      >
        Drop drawings here — PNG or JPEG. A vision model cannot read an SVG or a PDF; render to PNG first.
      </div>

      {!list.length && <div className="muted" style={{ marginTop: 16 }}>No documents yet.</div>}

      <table style={{ marginTop: 12 }}>
        <thead>
          <tr><th>Document</th><th>Type</th><th>Size</th><th>Progress</th><th>Tags</th><th /></tr>
        </thead>
        <tbody>
          {list.map(d => (
            <React.Fragment key={d.id}>
              <tr>
                <td>
                  <div className="mono">{d.name}</div>
                  <div className="muted small">{d.source}{d.seenAs.length > 1 ? ' · also ' + d.seenAs.slice(1).join(', ') : ''}</div>
                </td>
                <td>
                  <span className={d.visionReady ? '' : 'warn'} title={d.visionReady ? '' : 'not readable by a vision model'}>
                    {d.mimeType}
                  </span>
                </td>
                <td className="mono">{(d.bytes / 1024).toFixed(0)} KB</td>
                <td>
                  <div className="row">
                    {STEPS.map(s => <Pill key={s.key} on={s.done(d)} title={s.hint(d)}>{s.label}</Pill>)}
                  </div>
                </td>
                <td className="mono">
                  {d.extraction ? d.extraction.equipment + ' eq / ' + d.extraction.instruments + ' inst' : '—'}
                </td>
                <td className="num">
                  <div className="row">
                    <button disabled={!!busy || !d.visionReady}
                            title={d.visionReady ? 'push, read and stage' : 'render to PNG first'}
                            onClick={() => act('run ' + d.id, () => docs.pipeline(d.id))}>
                      {busy === 'run ' + d.id ? 'running…' : 'Run'}
                    </button>
                    <button className="ghost" onClick={() => setOpen(open === d.id ? null : d.id)}>
                      {open === d.id ? 'hide' : 'details'}
                    </button>
                  </div>
                </td>
              </tr>
              {open === d.id && (
                <tr className="detail">
                  <td colSpan={6}>
                    <div className="row small">
                      <span>sha <code className="mono">{d.sha}</code></span>
                      <span>added {new Date(d.addedAt).toLocaleString()}</span>
                      {d.fuuzFileId && <span>fileId <code className="mono">{d.fuuzFileId}</code></span>}
                      {d.extraction && <span>model <code className="mono">{d.extraction.model}</code></span>}
                    </div>
                    <div className="row" style={{ marginTop: 8 }}>
                      <button className="ghost" disabled={!!busy || !!d.fuuzFileId}
                              onClick={() => act('push ' + d.id, () => docs.push(d.id))}>1 · Push to Fuuz</button>
                      <button className="ghost" disabled={!!busy || !d.fuuzFileId}
                              onClick={() => act('extract ' + d.id, () => docs.extract(d.id))}>2 · Read with vision</button>
                      <button className="ghost" disabled={!!busy || !d.extraction}
                              onClick={() => act('stage ' + d.id, () => docs.stage(d.id))}>3 · Stage candidates</button>
                    </div>
                    {d.extraction && (
                      <table style={{ marginTop: 10 }}>
                        <thead><tr><th>Tag</th><th>Kind</th><th>Function</th><th>On equipment</th><th>Confidence</th></tr></thead>
                        <tbody>
                          {d.extraction.tags.map((t, i) => (
                            <tr key={i}>
                              <td className="mono">{t.tag}</td>
                              <td>{t.kind}</td>
                              <td className="muted">{t.function || '—'}</td>
                              <td className="mono muted">{t.onEquipmentTag || '—'}</td>
                              <td className="mono">{t.confidence === null ? '—' : t.confidence.toFixed(2)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </td>
                </tr>
              )}
            </React.Fragment>
          ))}
        </tbody>
      </table>

      {note && (
        <pre className="note" style={{ marginTop: 12 }}>{JSON.stringify(note, null, 1)}</pre>
      )}
    </div>
  );
}
