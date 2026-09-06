import React, { useState, useEffect, useCallback } from 'react';
import Overview from './tabs/Overview.jsx';
import Plant from './tabs/Plant.jsx';
import Simulator from './tabs/Simulator.jsx';
import Historian from './tabs/Historian.jsx';
import Vectors from './tabs/Vectors.jsx';
import Inference from './tabs/Inference.jsx';
import Documents from './tabs/Documents.jsx';
import Gateway from './tabs/Gateway.jsx';
import Latency from './tabs/Latency.jsx';

/* THE TAB REGISTRY.
 *
 * Adding a service to the console is one entry here plus one file in tabs/. That is the whole
 * extension contract, and it is why the shell knows nothing about any particular service — no
 * switch statements, no per-service state in App. Each tab owns its own polling and its own
 * failure handling, so one dead container degrades one tab instead of blanking the console.
 */
const TABS = [
  { id: 'overview',  label: 'Overview',   component: Overview },
  { id: 'plant',     label: 'Plant',      component: Plant },
  { id: 'simulator', label: 'Simulator',  component: Simulator },
  { id: 'historian', label: 'Historian',  component: Historian },
  { id: 'vectors',   label: 'ACE / Vectors', component: Vectors },
  { id: 'inference', label: 'Inference',   component: Inference },
  { id: 'documents', label: 'Documents',   component: Documents },
  { id: 'gateway',   label: 'Gateway',    component: Gateway },
  { id: 'latency',   label: 'Edge Latency', component: Latency }
];

/* Poll interval is global so one control governs every tab's load on the services. */
export const RefreshContext = React.createContext({ tick: 0, intervalMs: 5000 });

export default function App() {
  const [active, setActive] = useState(() => (location.hash || '#overview').slice(1));
  const [theme, setTheme] = useState('dark');
  const [intervalMs, setIntervalMs] = useState(5000);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const onHash = () => setActive((location.hash || '#overview').slice(1));
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => { document.documentElement.setAttribute('data-theme', theme); }, [theme]);

  useEffect(() => {
    if (!intervalMs) { return undefined; }               /* 0 == paused */
    const h = setInterval(() => setTick(t => t + 1), intervalMs);
    return () => clearInterval(h);
  }, [intervalMs]);

  const go = useCallback(id => { location.hash = '#' + id; setActive(id); }, []);
  const current = TABS.find(t => t.id === active) || TABS[0];
  const Body = current.component;

  return (
    <div className="shell">
      <div className="topbar">
        <div className="brand">ACE<span>operations console</span></div>
        <div className="spacer" />
        <label className="status" title="How often every tab re-polls its service">
          <span className="muted">refresh</span>
          <select value={intervalMs} onChange={e => setIntervalMs(Number(e.target.value))}>
            <option value={0}>paused</option>
            <option value={2000}>2s</option>
            <option value={5000}>5s</option>
            <option value={15000}>15s</option>
            <option value={60000}>60s</option>
          </select>
        </label>
        <button className="btn" onClick={() => setTheme(t => (t === 'dark' ? 'light' : 'dark'))}>
          {theme === 'dark' ? 'Light' : 'Dark'}
        </button>
      </div>

      <div className="tabs" role="tablist">
        {TABS.map(t => (
          <button key={t.id} role="tab" aria-selected={t.id === current.id}
                  className="tab" onClick={() => go(t.id)}>{t.label}</button>
        ))}
      </div>

      <div className="content" role="tabpanel">
        <RefreshContext.Provider value={{ tick, intervalMs }}>
          <Body />
        </RefreshContext.Provider>
      </div>
    </div>
  );
}
