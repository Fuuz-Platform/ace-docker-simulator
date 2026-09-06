import React, { useState, useCallback } from 'react';
import { usePoll } from '../lib/usePoll.js';
import { latency, handshake, describeError } from '../lib/api.js';
import { Bars, fmt } from '../components/Chart.jsx';

/* Edge gateway latency — the client-facing panel.
 *
 * WHAT THIS TAB IS ARGUING. Not "the gateway is fast" — a number with nothing beside it cannot be
 * argued with or trusted. Every measured leg is shown next to a control that has no Fuuz in it, so
 * the claim on screen is always "the gateway ADDS this much", which is the only form of the number
 * a client can check against their own cycle time.
 *
 * The handshake demo is the centrepiece and it is deliberately manual: one button raises a
 * production-complete flag on a simulated PLC, and the cycle log underneath fills in with what the
 * CELL measured — not what the flow claimed. Watching a client read those two columns and find that
 * they agree does more than any summary statistic.
 */

/* Legs in the order they nest, each containing the one above. The control column is what makes the
   table readable as a subtraction rather than a list. */
const LEG_ORDER = [
  { id: 'floor',      series: 'clientRoundTrip', control: null,            controlSeries: null,
    what: 'Gateway overhead alone' },
  { id: 'httpDevice', series: 'deviceCall',      control: 'directHttp',    controlSeries: 'direct',
    what: 'One call to a local HTTP service' },
  { id: 'opcuaWrite', series: 'write',           control: null,            controlSeries: null,
    what: 'One tag written back to the PLC' }
];

function pill(ok, label) {
  return <span className="status"><span className={'dot ' + (ok ? 's-good' : 's-critical')} />{label}</span>;
}

function StatCells({ s }) {
  if (!s || !s.n) { return <><td className="mono muted">—</td><td className="mono muted">—</td><td className="mono muted">—</td></>; }
  return (
    <>
      <td className="mono">{fmt(s.p50)}</td>
      <td className="mono">{fmt(s.p95)}</td>
      <td className="mono muted">{s.n}</td>
    </>
  );
}

/* ── the headline: what the gateway adds, per leg ─────────────────────────────────────────── */
function LegTable({ results }) {
  if (!results) { return null; }
  const rows = LEG_ORDER.filter(l => results[l.id] && !results[l.id].error);
  if (!rows.length) { return <div className="empty">No leg measurements in this run.</div>; }

  return (
    <div className="scroll">
      <table>
        <thead>
          <tr>
            <th>Leg</th><th>What it measures</th>
            <th>p50</th><th>p95</th><th>n</th>
            <th>Control</th><th>Gateway adds</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(l => {
            const r = results[l.id];
            const s = r.series && r.series[l.series];
            const c = l.control && results[l.control] && results[l.control].series &&
                      results[l.control].series[l.controlSeries];
            const delta = s && s.n && c && c.n ? s.p50 - c.p50 : null;
            return (
              <tr key={l.id}>
                <td>{r.label}</td>
                <td className="muted">{l.what}</td>
                <StatCells s={s} />
                <td className="mono muted">{c && c.n ? fmt(c.p50) + ' ms' : '—'}</td>
                <td className="mono">{delta === null ? '—' : '+' + fmt(delta) + ' ms'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ── the tag sweep: fixed cost vs per-tag cost ────────────────────────────────────────────── */
function SweepPanel({ gw, baseline }) {
  if (!gw || !gw.bySize) { return null; }
  const sizes = Object.keys(gw.bySize).map(Number).sort((a, b) => a - b);
  const rows = sizes.map(n => {
    const g = gw.bySize[n], b = baseline && baseline.bySize && baseline.bySize[n];
    return {
      n,
      gw: g && g.series ? g.series.read.p50 : null,
      direct: b && b.series ? b.series.direct.p50 : null,
      error: g && g.error
    };
  });
  const usable = rows.filter(r => r.gw !== null);

  /* Two points are enough for a slope and the honest way to report it is the slope between the
     extremes actually measured, not a fit through them. If reading 80 tags costs the same as
     reading 1, the fixed cost dominates and batching more tags into one read is free — which is
     the practical conclusion a client needs, so it is stated rather than left to be inferred. */
  let perTag = null, fixed = null;
  if (usable.length >= 2) {
    const lo = usable[0], hi = usable[usable.length - 1];
    perTag = (hi.gw - lo.gw) / (hi.n - lo.n);
    fixed = lo.gw - perTag * lo.n;
  }

  return (
    <div className="card">
      <div className="card-head">
        <div className="card-title">Cost of reading N tags</div>
        <div className="spacer" />
        <div className="card-sub">through the gateway, against the same read with no gateway in the path</div>
      </div>
      <div className="card-body">
        {perTag !== null && (
          <div className="row" style={{ marginBottom: 12 }}>
            <div className="tile">
              <div className="tile-label">Fixed cost per read</div>
              <div className="tile-value">{fmt(Math.max(0, fixed))} ms</div>
              <div className="tile-note">paid once, whatever the tag count</div>
            </div>
            <div className="tile">
              <div className="tile-label">Marginal cost per tag</div>
              <div className="tile-value">{fmt(perTag, 3)} ms</div>
              <div className="tile-note">
                {perTag < 0.05
                  ? 'effectively free — batch the whole payload into one read'
                  : 'grows with payload; split large reads if the budget is tight'}
              </div>
            </div>
          </div>
        )}
        <div className="scroll">
          <table>
            <thead><tr><th>Tags</th><th>Through gateway (p50)</th><th>Direct OPC UA (p50)</th><th>Gateway adds</th></tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.n}>
                  <td className="mono">{r.n}</td>
                  <td className="mono">{r.error ? <span className="err">failed</span> : fmt(r.gw) + ' ms'}</td>
                  <td className="mono muted">{r.direct === null ? '—' : fmt(r.direct) + ' ms'}</td>
                  <td className="mono">{r.gw === null || r.direct === null ? '—' : '+' + fmt(r.gw - r.direct) + ' ms'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ── the handshake: the number a plant actually cares about ───────────────────────────────── */
function HandshakePanel({ hs, watch }) {
  if (!hs) { return null; }
  if (hs.error) { return <div className="card"><div className="card-body err">{hs.error}</div></div>; }
  const s = hs.series || {};
  const total = s.plcTotal;
  const detect = watch && watch.series && watch.series.notificationLag;

  const breakdown = [
    { label: 'Collect ' + hs.resultTags + ' result tags', value: (s.flowRead && s.flowRead.p50) || 0 },
    { label: 'Write the acknowledgement', value: (s.flowWrite && s.flowWrite.p50) || 0 }
  ];
  if (detect && detect.n) {
    breakdown.unshift({ label: 'Notice the flag changed (subscription)', value: detect.p50 });
  }

  return (
    <div className="card">
      <div className="card-head">
        <div className="card-title">PLC production-complete handshake</div>
        <div className="spacer" />
        <div className="card-sub">timed by the cell, not by the client that drove it</div>
      </div>
      <div className="card-body">
        <div className="row">
          <div className="tile">
            <div className="tile-label">What the PLC waited (p50)</div>
            <div className="tile-value">{total && total.n ? fmt(total.p50) + ' ms' : '—'}</div>
            <div className="tile-note">p95 {total && total.n ? fmt(total.p95) + ' ms' : '—'} over {hs.cyclesMeasured} cycles</div>
          </div>
          <div className="tile">
            <div className="tile-label">Result tags collected</div>
            <div className="tile-value">{hs.resultTags}</div>
            <div className="tile-note">
              {hs.incompleteCollections
                ? <span className="err">{hs.incompleteCollections} cycle(s) missed tags</span>
                : 'every cycle collected all of them'}
            </div>
          </div>
          {detect && detect.n ? (
            <div className="tile">
              <div className="tile-label">Trigger-driven total</div>
              <div className="tile-value">{fmt(total.p50 + detect.p50)} ms</div>
              <div className="tile-note">+{fmt(detect.p50)} ms to notice the flag at {watch.samplingMs} ms sampling</div>
            </div>
          ) : null}
          {hs.readAmplification && hs.readAmplification !== 1 ? (
            <div className="tile">
              <div className="tile-label">Read amplification</div>
              <div className="tile-value">{hs.readAmplification}&times;</div>
              <div className="tile-note">reads reaching the PLC per distinct tag asked for</div>
            </div>
          ) : null}
        </div>

        <div style={{ marginTop: 14 }}>
          <div className="tile-label" style={{ marginBottom: 7 }}>Where the time goes</div>
          <Bars rows={breakdown} unit=" ms" />
        </div>

        {hs.note && <div className="card-sub" style={{ marginTop: 12 }}>{hs.note}</div>}
      </div>
    </div>
  );
}

/* ── the closed loop: the PLC raises a flag and the gateway answers, unprompted ────────────── */
function TagTriggeredPanel({ tt, watch }) {
  if (!tt) { return null; }
  if (tt.error) {
    return (
      <div className="card">
        <div className="card-head"><div className="card-title">Tag-triggered handshake</div></div>
        <div className="card-body"><div className="err">{tt.error}</div></div>
      </div>
    );
  }
  const s = tt.series || {};
  const total = s.total, detect = s.detect;
  const work = total && detect && total.n ? total.p50 - detect.p50 : null;
  const floor = watch && watch.series && watch.series.notificationLag;

  return (
    <div className="card">
      <div className="card-head">
        <div className="card-title">Tag-triggered handshake</div>
        <div className="spacer" />
        <div className="card-sub">nothing calls the flow — the PLC raises a flag and the gateway answers</div>
      </div>
      <div className="card-body">
        <div className="row">
          <div className="tile">
            <div className="tile-label">Flag raised → acknowledged</div>
            <div className="tile-value">{total && total.n ? fmt(total.p50) + ' ms' : '—'}</div>
            <div className="tile-note">
              p95 {total && total.n ? fmt(total.p95) + ' ms' : '—'} over {tt.cyclesCompleted} cycles
            </div>
          </div>
          <div className="tile">
            <div className="tile-label">Noticing the change</div>
            <div className="tile-value">{detect && detect.n ? fmt(detect.p50) + ' ms' : '—'}</div>
            <div className="tile-note">
              {total && detect && detect.n
                ? Math.round((detect.p50 / total.p50) * 100) + '% of the whole cycle'
                : 'subscription → queue → flow start'}
            </div>
          </div>
          <div className="tile">
            <div className="tile-label">All the actual work</div>
            <div className="tile-value">{work === null ? '—' : fmt(work) + ' ms'}</div>
            <div className="tile-note">read {tt.resultTags} tags, route, write the acknowledgement</div>
          </div>
          <div className="tile">
            <div className="tile-label">Flags answered</div>
            <div className="tile-value">{tt.cyclesCompleted}/{tt.cyclesFired}</div>
            <div className="tile-note">
              {tt.cyclesAbandoned
                ? <span className="err">{tt.cyclesAbandoned} never answered</span>
                : (tt.incompleteCollections
                  ? <span className="err">{tt.incompleteCollections} missed tags</span>
                  : 'every flag answered, every tag collected')}
            </div>
          </div>
        </div>

        <div style={{ marginTop: 14 }}>
          <div className="tile-label" style={{ marginBottom: 7 }}>Where the time goes</div>
          <Bars rows={[
            { label: 'Notice the tag changed', value: (detect && detect.p50) || 0 },
            { label: 'Collect ' + tt.resultTags + ' result tags', value: (s.collect && s.collect.p50) || 0 },
            { label: 'Write the acknowledgement', value: (s.acknowledge && s.acknowledge.p50) || 0 }
          ]} unit=" ms" />
        </div>

        {/* The comparison that turns the headline into an action: a plain OPC UA client on the same
            server sees the same change far sooner, so the time is in the subscription pipeline and
            not in OPC UA or in the flow. */}
        {floor && floor.n ? (
          <div className="card-sub" style={{ marginTop: 12 }}>
            A plain OPC UA subscription on the same server sees the same change in {fmt(floor.p50)} ms.
            The gap is the gateway's own publish path, not OPC UA and not the flow — which is where
            to look if this needs to be faster.
          </div>
        ) : null}
        {tt.note && <div className="card-sub" style={{ marginTop: 8 }}>{tt.note}</div>}
      </div>
    </div>
  );
}

/* ── one transaction, every step, drawn to scale ──────────────────────────────────────────────
   A waterfall rather than a table of numbers, because the point this has to make in one glance is
   proportion: noticing the tag change is not one step among six, it is almost the whole bar. A
   column of milliseconds makes a reader do that arithmetic themselves, and most will not. */
const STEP_COLOR = {
  request:     'var(--series-6)',
  pickup:      'var(--series-2)',
  readFlag:    'var(--series-1)',
  collect:     'var(--series-3)',
  acknowledge: 'var(--series-4)',
  settle:      'var(--series-8)'
};

function Waterfall({ cycle }) {
  const steps = (cycle.timeline || []).filter(s => s.ms !== null);
  if (!steps.length) {
    return <div className="muted">No timeline yet — the flow has not reported its stamps for this cycle.</div>;
  }
  const total = steps.reduce((a, s) => a + Math.max(0, s.ms), 0) || 1;
  let cursor = 0;

  return (
    <div>
      {/* the whole transaction as one bar, each step to scale */}
      <div style={{ display: 'flex', height: 22, borderRadius: 4, overflow: 'hidden',
                    background: 'var(--grid)', marginBottom: 12 }}>
        {steps.map(s => (
          <div key={s.key} title={s.label + ' — ' + s.ms + ' ms'}
               style={{ width: (Math.max(0, s.ms) / total) * 100 + '%',
                        background: STEP_COLOR[s.key] || 'var(--series-1)' }} />
        ))}
      </div>

      <div className="scroll">
        <table>
          <thead>
            <tr><th>Step</th><th>Duration</th><th>Share</th><th>Elapsed</th><th>Measured by</th></tr>
          </thead>
          <tbody>
            {steps.map(s => {
              cursor += Math.max(0, s.ms);
              const share = (Math.max(0, s.ms) / total) * 100;
              return (
                <tr key={s.key}>
                  <td title={s.detail}>
                    <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 2,
                                   marginRight: 8, background: STEP_COLOR[s.key] || 'var(--series-1)' }} />
                    {s.label}
                  </td>
                  <td className="mono">
                    {s.ms} ms{s.suspect && <span className="err"> ⚠ out of order</span>}
                  </td>
                  <td className="mono muted">{share < 1 ? '<1' : Math.round(share)}%</td>
                  <td className="mono muted">{cursor} ms</td>
                  <td className="muted">{s.by}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="card-sub" style={{ marginTop: 10 }}>
        {cycle.accountedMs} ms accounted for
        {cycle.unaccountedMs !== null && cycle.unaccountedMs !== undefined
          ? <> · <span className={Math.abs(cycle.unaccountedMs) > 5 ? 'err' : 'muted'}>
              {cycle.unaccountedMs} ms unaccounted
            </span></>
          : null}
        {' '}· {cycle.distinctTagsRead}/{cycle.resultTags} tags collected
        {cycle.reads !== cycle.distinctTagsRead
          ? <> · <span className="err">{cycle.reads} reads reached the PLC for {cycle.distinctTagsRead} tags</span></>
          : null}
      </div>
    </div>
  );
}

/* ── every transaction, newest first ──────────────────────────────────────────────────────── */
function TransactionLog() {
  const [open, setOpen] = useState(null);
  const cycles = usePoll(() => handshake.cycles(25), []);
  const rows = (cycles.data && cycles.data.cycles) || [];
  const traced = rows.filter(r => r.timeline && r.timeline.some(s => s.ms !== null));

  const cell = (v, unit) => v === null || v === undefined
    ? <td className="mono muted">—</td>
    : <td className="mono">{v}{unit || ''}</td>;

  return (
    <div className="card">
      <div className="card-head">
        <div className="card-title">Transactions</div>
        <div className="spacer" />
        <div className="card-sub">every cycle, every step — click a row for the breakdown</div>
      </div>
      <div className="card-body">
        {cycles.error && <div className="err">{cycles.error}</div>}
        {rows.length === 0 && <div className="empty">No transactions yet — raise the flag below, or run the tag-triggered demo.</div>}

        {rows.length > 0 && (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>#</th><th>Batch</th><th>Source</th>
                  <th>Click→flag</th><th>Picked up</th><th>Read flag</th>
                  <th>Read tags</th><th>Wrote tag</th><th>Total</th><th>State</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(c => {
                  const byKey = {};
                  (c.timeline || []).forEach(s => { byKey[s.key] = s.ms; });
                  const isOpen = open === c.seq;
                  return (
                    <React.Fragment key={c.seq}>
                      <tr onClick={() => setOpen(isOpen ? null : c.seq)} style={{ cursor: 'pointer' }}>
                        <td className="mono">{isOpen ? '▾' : '▸'} {c.seq}</td>
                        <td className="mono muted">{c.batchId}</td>
                        <td className="muted">{c.source}</td>
                        {cell(byKey.request, ' ms')}
                        {cell(byKey.pickup, ' ms')}
                        {cell(byKey.readFlag, ' ms')}
                        {cell(byKey.collect, ' ms')}
                        {cell(byKey.acknowledge, ' ms')}
                        {cell(c.ms.total, ' ms')}
                        <td>
                          {c.complete
                            ? (c.collectedAll ? pill(true, 'complete') : pill(false, 'missed tags'))
                            : pill(false, 'abandoned')}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr>
                          <td colSpan={10} style={{ padding: '14px 10px 18px' }}>
                            <Waterfall cycle={c} />
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Said plainly rather than left to be discovered: only the tag-triggered flow reports its
            own stamps, so an HTTP-driven cycle has holes in the middle of its timeline. */}
        {rows.length > 0 && traced.length < rows.length && (
          <div className="card-sub" style={{ marginTop: 10 }}>
            {rows.length - traced.length} of {rows.length} transactions have no flow stamps. Only the
            tag-triggered flow reports them; cycles driven over HTTP show what the cell saw and leave
            the flow's internal steps blank rather than guessing at them.
          </div>
        )}
      </div>
    </div>
  );
}

/* ── live demo: fire one cycle and watch the cell's own log fill in ────────────────────────── */
function LiveCell() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const cycles = usePoll(() => handshake.cycles(12), []);
  const state = usePoll(() => handshake.state(), []);

  const act = useCallback(async fn => {
    setBusy(true); setErr(null);
    try { await fn(); await cycles.reload(); await state.reload(); }
    catch (e) { setErr(describeError(e)); }
    finally { setBusy(false); }
  }, [cycles, state]);

  const rows = (cycles.data && cycles.data.cycles) || [];
  const inFlight = cycles.data && cycles.data.inFlight;
  const st = state.data;

  return (
    <div className="card">
      <div className="card-head">
        <div className="card-title">Live cell</div>
        <div className="spacer" />
        <div className="card-sub">
          {st ? 'Plant/' + st.area + '/' + st.cell + ' · ' + st.config.resultTags + ' result tags' : '—'}
        </div>
      </div>
      <div className="card-body">
        <div className="row">
          <button className="btn primary" disabled={busy} onClick={() => act(handshake.fire)}>
            Raise production-complete
          </button>
          <button className="btn" disabled={busy} onClick={() => act(handshake.clear)}>Clear flag</button>
          <button className="btn" disabled={busy} onClick={() => act(handshake.reset)}>Reset log</button>
          {st && (
            <span className="status" style={{ marginLeft: 4 }}>
              <span className={'dot ' + (st.values.ProductionComplete ? 's-warning' : 's-idle')} />
              ProductionComplete = {st.values.ProductionComplete}
            </span>
          )}
          {inFlight && (
            <span className="status">
              <span className="dot s-warning" />waiting for acknowledgement of #{inFlight.seq}
            </span>
          )}
        </div>
        {err && <div className="err" style={{ marginTop: 8 }}>{err}</div>}

        {/* A raised flag with nothing collecting it is the normal state of this panel until a run
            is started, and saying so prevents it reading as a fault. */}
        <div className="card-sub" style={{ marginTop: 10 }}>
          Raising the flag by hand leaves it up: nothing is subscribed to collect it until a
          measurement run drives the flow. The cycle then shows as abandoned, which is exactly what a
          real line would report.
        </div>

        <div className="scroll" style={{ marginTop: 12 }}>
          <table>
            <thead>
              <tr><th>#</th><th>Batch</th><th>Source</th><th>Tags</th><th>Reads</th>
                  <th>Detect</th><th>Collect</th><th>Ack</th><th>Total</th><th>State</th></tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={10} className="muted">no cycles yet — raise the flag, or run a measurement</td></tr>
              )}
              {rows.map(c => (
                <tr key={c.seq}>
                  <td className="mono">{c.seq}</td>
                  <td className="mono muted">{c.batchId}</td>
                  <td className="muted">{c.source}</td>
                  <td className="mono">{c.distinctTagsRead}/{c.resultTags}</td>
                  <td className="mono muted">{c.reads}</td>
                  <td className="mono">{c.ms.detect === null ? '—' : c.ms.detect}</td>
                  <td className="mono">{c.ms.collect === null ? '—' : c.ms.collect}</td>
                  <td className="mono">{c.ms.acknowledge === null ? '—' : c.ms.acknowledge}</td>
                  <td className="mono">{c.ms.total === null ? '—' : c.ms.total + ' ms'}</td>
                  <td>
                    {c.complete
                      ? (c.collectedAll ? pill(true, 'complete') : pill(false, 'missed tags'))
                      : pill(false, 'abandoned')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ── the run control ──────────────────────────────────────────────────────────────────────── */
const PRESETS = [
  { id: 'quick', label: 'Quick check', detail: 'the three core legs, 10 samples each',
    opts: { only: ['floor', 'httpDevice', 'directHttp', 'opcuaRead', 'baselineRead'], iterations: 10, sweep: [1, 40] } },
  { id: 'tagTriggered', label: 'Tag-triggered demo', detail: 'the PLC raises a flag and the gateway answers, unprompted',
    opts: { only: ['tagTriggered', 'baselineWatch'], iterations: 10, warmup: 2, resultTags: 40 } },
  { id: 'handshake', label: 'Handshake (driven)', detail: 'the same work, triggered over HTTP, to separate the work from the trigger',
    opts: { only: ['handshake', 'opcuaWrite'], iterations: 15, resultTags: 40 } },
  { id: 'full', label: 'Full sweep', detail: 'every leg, every tag count, and the cloud comparison',
    opts: { iterations: 20, sweep: [1, 5, 10, 20, 40, 80], resultTags: 40 } }
];

export default function Latency() {
  const [running, setRunning] = useState(null);
  const [err, setErr] = useState(null);
  const [run, setRun] = useState(null);
  const [resultTags, setResultTags] = useState(40);

  const meta = usePoll(() => latency.scenarios(), []);
  /* The last run is fetched once rather than polled: it only changes when this tab causes it to,
     and re-fetching a megabyte of samples on the global tick would be pure waste. */
  const last = usePoll(() => latency.last(), []);
  const shown = run || (last.data && !last.data.empty ? last.data : null);

  const start = useCallback(async preset => {
    setRunning(preset.id); setErr(null);
    try {
      const out = await latency.run({ ...preset.opts, resultTags: Number(resultTags) });
      if (out.busy) { setErr(out.message); } else { setRun(out); }
    } catch (e) { setErr(describeError(e)); }
    finally { setRunning(null); }
  }, [resultTags]);

  const health = (shown && shown.health) || (meta.data && meta.data.health);
  const results = shown && shown.results;

  return (
    <div className="grid">
      <div className="card">
        <div className="card-head">
          <div className="card-title">Measure the edge gateway</div>
          <div className="spacer" />
          <div className="card-sub">run from the orchestrator, on the gateway's own network</div>
        </div>
        <div className="card-body">
          <div className="row">
            {PRESETS.map(p => (
              <button key={p.id} className={'btn ' + (p.id === 'tagTriggered' ? 'primary' : '')}
                      disabled={!!running} title={p.detail} onClick={() => start(p)}>
                {running === p.id ? 'Running…' : p.label}
              </button>
            ))}
            <div className="field">
              <label htmlFor="rt">Result tags</label>
              <input id="rt" type="number" min="1" max="200" value={resultTags} style={{ width: 80 }}
                     onChange={e => setResultTags(e.target.value)} />
            </div>
            <div className="spacer" />
            {health && (
              <span className="status">
                {Object.entries(health).map(([k, v]) => (
                  <span key={k} title={v.error || ('HTTP ' + v.status + ' in ' + v.ms + ' ms')}>
                    <span className={'dot ' + (v.reachable ? 's-good' : 's-critical')} />{k}&nbsp;
                  </span>
                ))}
              </span>
            )}
          </div>

          {running && (
            <div className="card-sub" style={{ marginTop: 10 }}>
              Measuring. A full sweep drives several hundred real reads through the gateway and takes
              a couple of minutes; the numbers below are the previous run until it finishes.
            </div>
          )}
          {err && <div className="err" style={{ marginTop: 8 }}>{err}</div>}

          {shown && shown.verdict && shown.verdict.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div className="tile-label" style={{ marginBottom: 6 }}>
                Findings — {new Date(shown.startedAt).toLocaleString()}
              </div>
              <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.65 }}>
                {shown.verdict.map((v, i) => (
                  <li key={i} className={/WARNING|did not/.test(v) ? 'err' : ''}>{v}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      {results && (
        <div className="card">
          <div className="card-head">
            <div className="card-title">What each leg costs</div>
            <div className="spacer" />
            <div className="card-sub">each leg contains the one above it, so the differences are the parts</div>
          </div>
          <div className="card-body"><LegTable results={results} /></div>
        </div>
      )}

      {results && results.tagTriggered && (
        <TagTriggeredPanel tt={results.tagTriggered} watch={results.baselineWatch} />
      )}

      {results && results.handshake && (
        <HandshakePanel hs={results.handshake} watch={results.baselineWatch} />
      )}

      {results && results.opcuaRead && (
        <SweepPanel gw={results.opcuaRead} baseline={results.baselineRead} />
      )}

      <TransactionLog />

      <LiveCell />

      {results && results.cloudFlow && results.cloudFlow.unavailable && (
        <div className="card">
          <div className="card-head"><div className="card-title">Cloud flow engine</div></div>
          <div className="card-body">
            <div className="err">{results.cloudFlow.error}</div>
            <div className="card-sub" style={{ marginTop: 8 }}>
              Shown because it is the contrast that matters: edge flows are pulled and executed by
              the gateway itself, so they keep running at single-digit milliseconds while the cloud
              engine is unavailable — and they would keep running with the internet unplugged.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
