// App↔Overseer bridge client. When this app runs embedded in Overseer's App
// view, `window.OverseerBridge` lets it read/write its own DataStorage records
// through the host — the host holds the write credential, this app never does.
// Standalone (opened directly, not in an iframe) `embedded` is false and the
// app falls back to localStorage.
(function () {
  const PREFIX = "overseer:";
  const pending = new Map();
  let seq = 0;

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.overseerBridgeResponse !== true) return;
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    clearTimeout(entry.timer);
    if (data.ok) entry.resolve(data.result);
    else entry.reject(new Error(data.error || "Overseer bridge error"));
  });

  function call(type, payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = "req-" + ++seq;
      const timer = setTimeout(() => {
        if (pending.delete(id))
          reject(new Error("Overseer bridge timeout: " + type));
      }, timeoutMs || 8000);
      pending.set(id, { resolve, reject, timer });
      window.parent.postMessage(
        { type: PREFIX + type, id: id, payload: payload },
        "*",
      );
    });
  }

  window.OverseerBridge = {
    embedded: window.parent && window.parent !== window,
    queryData: (payload) => call("data.query", payload),
    putData: (payload) => call("data.put", payload),
    deleteData: (payload) => call("data.delete", payload),
    // The records of every live-data source this project is subscribed to.
    readLiveData: () => call("live-data.read", undefined),
    // Run the opportunity-analysis job (web search + LLM). Slow, so allow 90s.
    runOpportunities: () =>
      call("analysis.run-opportunities", undefined, 90000),
  };
})();
