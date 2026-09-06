import React from 'react';
import { usePoll } from '../lib/usePoll.js';
import { sim, orch, hist } from '../lib/api.js';
import { Bars } from '../components/Chart.jsx';

/* The "is anything on fire" tab. One row of service states, then the few numbers that say whether
   the pipeline is actually moving. Each service is polled independently so a dead one shows as
   down rather than taking the page with it. */

function Health({ label, state, detail }) {
  const cls = state === 'up' ? 's-good' : state === 'degraded' ? 's-warning' : state === 'down' ? 's-critical' : 's-idle';
  const word = state === 'up' ? 'Up' : state === 'degraded' ? 'Degraded' : state === 'down' ? 'Down'
             : state === 'idle' ? 'Off' : 'Unknown';
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="status" style={{ marginTop: 8, fontSize: 15 }}>
        <span className={'dot ' + cls} /><strong>{word}</strong>
      </div>
      <div className="tile-note">{detail || ' '}</div>
    </div>
  );
}

export default function Overview() {
  const simQ = usePoll(() => sim.state(), []);
  const orchQ = usePoll(() => orch.health(), []);
  const histQ = usePoll(() => hist.status(), []);
  const idxQ = usePoll(() => hist.indexStatus(), []);

  const checks = (orchQ.data && orchQ.data.checks) || [];
  const failing = checks.filter(c => !c.ok);

  const faults = {};
  ((simQ.data && simQ.data.units) || []).forEach(u => { faults[u.fault] = (faults[u.fault] || 0) + 1; });
  const faultRows = Object.keys(faults).sort().map(k => ({
    label: k, value: faults[k],
    color: k === 'NONE' ? 'var(--good)' : k === 'COMMS' ? 'var(--critical)' : 'var(--warning)'
  }));

  return (
    <>
      <div className="grid cols-4">
        <Health label="Simulator" state={simQ.error ? 'down' : simQ.data ? 'up' : 'unknown'}
                detail={simQ.data ? `${simQ.data.tagCount} tags · ${simQ.data.tickMs}ms tick${simQ.data.paused ? ' · PAUSED' : ''}` : simQ.error} />
        <Health label="Orchestrator"
                state={orchQ.error ? (/^not running/.test(orchQ.error) ? 'idle' : 'down')
                       : !checks.length ? 'unknown' : failing.length ? 'degraded' : 'up'}
                detail={orchQ.error || (failing.length ? failing.map(c => c.name).join(', ') + ' failing' : checks.length + ' checks passing')} />
        <Health label="Historian" state={histQ.error ? 'down' : histQ.data ? 'up' : 'unknown'}
                detail={histQ.error || (histQ.data && histQ.data.historianStatus
                  ? Number(histQ.data.historianStatus.count || 0).toLocaleString() + ' samples' : '')} />
        <Health label="Vector index"
                state={idxQ.error ? 'down' : idxQ.data && idxQ.data.indexStatus
                  ? (idxQ.data.indexStatus.queryable ? 'up' : 'degraded') : 'unknown'}
                detail={idxQ.error || (idxQ.data && idxQ.data.indexStatus
                  ? `${idxQ.data.indexStatus.status} · ${idxQ.data.indexStatus.count} vectors · ${idxQ.data.indexStatus.dims}d` : '')} />
      </div>

      <div className="grid cols-2">
        <div className="card">
          <div className="card-head">
            <div className="card-title">Orchestrator checks</div>
            <div className="spacer" />
            <div className="card-sub">{orchQ.at ? new Date(orchQ.at).toLocaleTimeString() : ''}</div>
          </div>
          <div className="card-body">
            {orchQ.error && <div className="err">{orchQ.error}</div>}
            {!orchQ.error && !checks.length && <div className="empty">no checks reported</div>}
            {!!checks.length && (
              <table>
                <thead><tr><th>Check</th><th>State</th><th className="num">ms</th><th>Detail</th></tr></thead>
                <tbody>
                  {checks.map(c => (
                    <tr key={c.name}>
                      <td>{c.name}</td>
                      <td><span className="status"><span className={'dot ' + (c.ok ? 's-good' : 's-critical')} />{c.ok ? 'OK' : 'FAIL'}</span></td>
                      <td className="num">{c.ms}</td>
                      <td className="muted">{c.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-head"><div className="card-title">Plant conditions</div>
            <div className="spacer" /><div className="card-sub">units by fault state</div></div>
          <div className="card-body">
            {simQ.error && <div className="err">{simQ.error}</div>}
            {!simQ.error && !faultRows.length && <div className="empty">simulator not reporting</div>}
            {!!faultRows.length && <Bars rows={faultRows} />}
          </div>
        </div>
      </div>
    </>
  );
}
