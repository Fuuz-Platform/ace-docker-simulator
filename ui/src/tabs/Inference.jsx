import React, { useState } from 'react';
import { usePoll } from '../lib/usePoll.js';
import { inference, orch, describeError } from '../lib/api.js';
import { fmt } from '../components/Chart.jsx';

/* What is actually serving the models, and how fast is it.
 *
 * Two independent sources, on purpose:
 *   - the ORCHESTRATOR says which model it is configured to call (an env var, i.e. an intention)
 *   - the RUNTIME says which models exist, with the parameter count and quantization it actually
 *     loaded (a fact)
 * Showing only the first is how a stack ends up confidently reporting a model that was never
 * pulled. Where the two disagree this tab says so, because that mismatch is the failure it exists
 * to catch.
 *
 * The latency probe is here because inference performance on this project is not a detail — a
 * containerised CPU embedder and a Metal-backed one differ by an order of magnitude, and the whole
 * question "can we embed 10k tags" is answered by one number that only a real call produces.
 */

/* Judged against the measured runtimes on this project: Metal ≈ 6 ms/string, CPU container ≈ 21. */
function speedVerdict(perString) {
  if (perString == null) { return null; }
  if (perString <= 10) { return { cls: 's-good', label: 'GPU-class' }; }
  if (perString <= 60) { return { cls: 's-warning', label: 'usable' }; }
  return { cls: 's-critical', label: 'CPU-bound' };
}

/* 10k tags is the pilot's real corpus size, and it is the unit the decision is actually made in. */
function project(perString) {
  const s = (perString * 10000) / 1000;
  return s < 90 ? Math.round(s) + ' s' : (s / 60).toFixed(1) + ' min';
}

export default function Inference() {
  const models = usePoll(() => inference.models(), []);
  const health = usePoll(() => orch.health(), []);
  const [probe, setProbe] = useState({});
  const [busy, setBusy] = useState(null);

  const cfg = (health.data && health.data.config) || {};
  const list = (models.data && models.data.data) || [];
  const checks = (health.data && health.data.checks) || [];

  /* Strip the :latest the runtime appends — an id that differs only by tag is the same model, and
     flagging that as a mismatch would cry wolf. */
  const bare = s => String(s || '').replace(/:latest$/, '');
  const configured = new Set([bare(cfg.embedModel), bare(cfg.llmModel)].filter(Boolean));
  const present = new Set(list.map(m => bare(m.id)));
  const missing = [...configured].filter(id => !present.has(id));

  async function runProbe(id) {
    setBusy(id);
    try {
      /* awaited BEFORE the updater runs — the setState callback is not async, and awaiting inside
         it is a build error rather than a runtime one */
      const result = await inference.probe(id, 16);
      setProbe(p => ({ ...p, [id]: result }));
    } catch (e) {
      setProbe(p => ({ ...p, [id]: { error: describeError(e) } }));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="card">
        <div className="card-head">
          <div className="card-title">Serving</div>
          <div className="spacer" />
          <div className="card-sub mono">{cfg.embedUrl || '—'}</div>
        </div>
        <div className="card-body">
          <div className="row" style={{ gap: 28, flexWrap: 'wrap' }}>
            <div className="tile">
              <div className="tile-label">Embedding model</div>
              <div className="tile-value mono" style={{ fontSize: 14 }}>{bare(cfg.embedModel) || '—'}</div>
              <div className="tile-note">what the orchestrator calls</div>
            </div>
            <div className="tile">
              <div className="tile-label">Chat model</div>
              <div className="tile-value mono" style={{ fontSize: 14 }}>{bare(cfg.llmModel) || '—'}</div>
              <div className="tile-note">{cfg.llmUrl === cfg.embedUrl ? 'same runtime' : cfg.llmUrl}</div>
            </div>
            <div className="tile">
              <div className="tile-label">Models loaded</div>
              <div className="tile-value">{models.error ? '—' : list.length}</div>
              <div className="tile-note">reported by the runtime itself</div>
            </div>
          </div>

          {!!missing.length && (
            <div className="tile-note" style={{ marginTop: 12, color: 'var(--critical)' }}>
              Configured but NOT present in the runtime: <span className="mono">{missing.join(', ')}</span>.
              Calls to it will fail no matter how healthy everything else looks.
            </div>
          )}
          {models.error && (
            <div className="tile-note" style={{ marginTop: 12, color: 'var(--critical)' }}>
              runtime unreachable — {describeError(models.error)}
            </div>
          )}

          <div className="row" style={{ gap: 18, marginTop: 14, flexWrap: 'wrap' }}>
            {checks.filter(c => c.name === 'embeddings' || c.name === 'llm').map(c => (
              <span key={c.name} className="status">
                <span className={'dot ' + (c.ok ? 's-good' : 's-critical')} />
                {c.name} · {c.ms} ms
                <span className="muted" style={{ marginLeft: 6 }}>{c.detail}</span>
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div className="card-title">Models in the runtime</div>
          <div className="spacer" />
          <div className="card-sub">probe measures a real 16-string embed, not a claim</div>
        </div>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Model</th><th>Architecture</th><th className="num">Parameters</th>
                <th>Quantization</th><th className="num">Context</th><th className="num">Size</th>
                <th>Used for</th><th className="num">ms / string</th><th className="num">10k tags</th><th />
              </tr>
            </thead>
            <tbody>
              {list.map(m => {
                const d = m.dmr || {};
                const p = probe[m.id];
                const v = p && !p.error ? speedVerdict(p.perString) : null;
                const roles = [
                  bare(cfg.embedModel) === bare(m.id) ? 'embeddings' : null,
                  bare(cfg.llmModel) === bare(m.id) ? 'chat' : null
                ].filter(Boolean);
                return (
                  <tr key={m.id}>
                    <td className="mono" style={{ fontSize: 12 }}>{bare(m.id)}</td>
                    <td className="muted">{d.architecture || '—'}</td>
                    <td className="num">{d.parameters || '—'}</td>
                    <td className="muted">{d.quantization || '—'}</td>
                    <td className="num">{d.context_window ? d.context_window.toLocaleString() : '—'}</td>
                    <td className="num muted">{d.size || '—'}</td>
                    <td>{roles.length
                      ? roles.map(r => <span key={r} className="status" style={{ marginRight: 8 }}>
                          <span className="dot s-good" />{r}</span>)
                      : <span className="muted">idle</span>}</td>
                    <td className="num">
                      {p && p.error ? <span style={{ color: 'var(--critical)' }}>failed</span>
                        : p ? <>{fmt(p.perString)} {v && <span className={'dot ' + v.cls} title={v.label} />}</>
                        : <span className="muted">—</span>}
                    </td>
                    <td className="num muted">{p && !p.error ? project(p.perString) : '—'}</td>
                    <td>
                      <button className="btn" disabled={busy === m.id} onClick={() => runProbe(m.id)}>
                        {busy === m.id ? 'probing…' : 'probe'}
                      </button>
                    </td>
                  </tr>
                );
              })}
              {!list.length && !models.error && (
                <tr><td colSpan={10} className="muted">no models pulled into the runtime yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="card-body">
          <div className="tile-note">
            A chat model probed as an embedder will fail — that is expected and the row says so
            rather than hiding it. The projection assumes the same batch size throughout, which is
            how the bulk embed actually runs.
          </div>
        </div>
      </div>
    </>
  );
}
