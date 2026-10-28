/** Poll the snapshot while the panel is mounted. Writes refresh immediately. */
function useSnapshot() {
  const [state, setState] = React.useState({ phase: 'loading', snapshot: null, error: null });
  const lastVersion = React.useRef(null);
  const load = React.useCallback(async () => {
    try {
      const body = await apiGet('/snapshot');
      // Skip identical documents: re-rendering the whole panel every poll was
      // what reset in-progress form state before, and it wastes main-thread time.
      const version = body && typeof body.version === 'number' ? body.version : null;
      if (version !== null && lastVersion.current === version) return;
      lastVersion.current = version;
      setState({ phase: 'ready', snapshot: body.data, error: null });
    } catch (error) {
      setState((previous) => ({ phase: previous.snapshot ? 'ready' : 'error', snapshot: previous.snapshot, error: String(error.message || error) }));
    }
  }, []);
  React.useEffect(() => {
    let live = true;
    void load();
    const timer = setInterval(() => { if (live && document.visibilityState !== 'hidden') void load(); }, POLL_MS);
    return () => { live = false; clearInterval(timer); };
  }, [load]);
  return { state, reload: load };
}
