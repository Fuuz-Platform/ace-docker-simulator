import { useState, useEffect, useContext, useCallback } from 'react';
import { RefreshContext } from '../App.jsx';
import { describeError } from './api.js';

/* Every tab loads data the same way: run `fn` now, re-run on the global tick, keep the LAST good
 * value visible while a refresh is in flight, and surface errors without blanking the panel.
 *
 * Keeping stale data on screen during an error matters on a monitoring console — a panel that goes
 * empty the moment a poll fails tells you less than one showing the last known state next to a
 * clear error.
 */
export function usePoll(fn, deps = []) {
  const { tick } = useContext(RefreshContext);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [at, setAt] = useState(null);

  const run = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    Promise.resolve()
      .then(fn)
      .then(d => { if (!cancelled) { setData(d); setError(null); setAt(Date.now()); } })
      .catch(e => { if (!cancelled) { setError(describeError(e)); } })
      .finally(() => { if (!cancelled) { setLoading(false); } });
    return () => { cancelled = true; };
  }, deps);                                     // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(run, [run, tick]);
  return { data, error, loading, at, reload: run };
}
