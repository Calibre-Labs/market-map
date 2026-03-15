function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function createTrace({
  sessionId,
  username,
  tabId,
  createdAt,
  rootSpan,
  rootSpanId,
  rootSpanSpanId
}) {
  return {
    version: 2,
    session_id: sessionId,
    username,
    tab_id: tabId || null,
    created_at: createdAt,
    braintrust: {
      root_span: rootSpan,
      root_span_id: rootSpanId,
      root_span_span_id: rootSpanSpanId
    },
    turns: []
  };
}

export function addTurnToTrace(trace, turn) {
  return {
    ...trace,
    turns: [...trace.turns, turn]
  };
}

export function isSpanExportString(value) {
  if (typeof value !== "string") return false;
  const idx = value.indexOf(":");
  if (idx <= 0) return false;
  const prefix = value.slice(0, idx);
  return /^[0-9]+$/.test(prefix);
}

export function attachBraintrustCircuitBreaker(logger, {
  errorWindowMs = 60000,
  errorThreshold = 3
} = {}) {
  const state = logger?.loggingState;
  const bgLogger = state?.bgLogger?.();
  if (!bgLogger) return;
  let errorCount = 0;
  let errorWindowStart = 0;
  let disabled = false;
  bgLogger.onFlushError = (err) => {
    const now = Date.now();
    if (!errorWindowStart || now - errorWindowStart > errorWindowMs) {
      errorWindowStart = now;
      errorCount = 0;
    }
    errorCount += 1;
    if (!disabled && errorCount >= errorThreshold) {
      disabled = true;
      state.disable();
      // eslint-disable-next-line no-console
      console.warn(
        `Braintrust logging disabled after ${errorCount} errors in ${errorWindowMs}ms.`,
        err
      );
    }
  };
}

export function createEnsureRootParent(logger, db, updateSession) {
  return async function ensureRootParent(session) {
    if (session.root_span_id && session.root_span_span_id) {
      return {
        rootSpanId: session.root_span_id,
        spanId: session.root_span_span_id
      };
    }

    const rootSpanHandle = logger.startSpan({
      name: `Session ${session.id}`,
      type: "trace"
    });
    const exported = await rootSpanHandle.export();
    const rootSpanId = rootSpanHandle.rootSpanId;
    const spanId = rootSpanHandle.spanId;
    rootSpanHandle.end();

    updateSession(db, session.id, {
      root_span: exported,
      root_span_id: rootSpanId,
      root_span_span_id: spanId,
      updated_at: Date.now()
    });

    const trace = parseJson(session.trace_json, null);
    if (trace) {
      trace.braintrust = {
        root_span: exported,
        root_span_id: rootSpanId,
        root_span_span_id: spanId
      };
      updateSession(db, session.id, {
        trace_json: JSON.stringify(trace, null, 2),
        updated_at: Date.now()
      });
    }

    return { rootSpanId, spanId };
  };
}
