export const SESSION_FSM_STATES = Object.freeze({
  NEW: "NEW",
  PLAN_DRAFT: "PLAN_DRAFT",
  AWAITING_CLARIFICATION: "AWAITING_CLARIFICATION",
  AWAITING_INTENT_CONFIRMATION: "AWAITING_INTENT_CONFIRMATION",
  RESULT: "RESULT",
  COMPLETE: "COMPLETE"
});

function text(value) {
  return typeof value === "string" ? value : "";
}

export function deriveSessionState(session) {
  const status = text(session?.status);
  const phase = text(session?.phase);
  const planStatus = text(session?.plan_status);
  const intentChangeStatus = text(session?.intent_change_status);

  if (status === "complete") return SESSION_FSM_STATES.COMPLETE;
  if (status !== "active") return SESSION_FSM_STATES.NEW;
  if (phase === "result") return SESSION_FSM_STATES.RESULT;
  if (phase !== "plan") return SESSION_FSM_STATES.NEW;
  if (planStatus === "awaiting_clarification") {
    if (intentChangeStatus === "pending") {
      return SESSION_FSM_STATES.AWAITING_INTENT_CONFIRMATION;
    }
    return SESSION_FSM_STATES.AWAITING_CLARIFICATION;
  }
  return SESSION_FSM_STATES.PLAN_DRAFT;
}

export function validateSessionInvariants(session) {
  const status = text(session?.status);
  const phase = text(session?.phase);
  const planStatus = text(session?.plan_status);
  const planText = text(session?.plan_text).trim();
  const intentChangeStatus = text(session?.intent_change_status);
  const intentCandidate = text(session?.intent_candidate).trim();

  if (status === "complete") {
    if (phase !== "result") {
      throw new Error("FSM invariant failed: complete session must have phase=result.");
    }
    if (planStatus !== "executed") {
      throw new Error(
        "FSM invariant failed: complete session must have plan_status=executed."
      );
    }
  }

  if (planStatus === "awaiting_clarification") {
    if (phase !== "plan") {
      throw new Error(
        "FSM invariant failed: awaiting_clarification requires phase=plan."
      );
    }
    if (!planText) {
      throw new Error(
        "FSM invariant failed: awaiting_clarification requires non-empty plan_text."
      );
    }
  }

  if (intentChangeStatus === "pending") {
    if (planStatus !== "awaiting_clarification") {
      throw new Error(
        "FSM invariant failed: intent pending requires awaiting_clarification."
      );
    }
    if (!intentCandidate) {
      throw new Error(
        "FSM invariant failed: intent pending requires non-empty intent_candidate."
      );
    }
  }
}

function toPlanQuestions(session, turnResult) {
  if (Array.isArray(turnResult?.planQuestions)) {
    return JSON.stringify(turnResult.planQuestions);
  }
  return session?.plan_questions || null;
}

export function reduceSessionAfterTurn({
  session,
  turnResult,
  nextHistory,
  nextTrace,
  turnNumber,
  now,
  fallbackIntentOrigin,
  fallbackIntentAnchor
}) {
  const from = deriveSessionState(session);
  const event =
    turnResult?.effectiveMode === "result"
      ? "RESULT_READY"
      : turnResult?.skipPlanPersist
      ? "PLAN_RESET"
      : "PLAN_READY";

  const updates = {
    chat_history: JSON.stringify(nextHistory),
    trace_json: JSON.stringify(nextTrace, null, 2),
    turn_count: turnNumber,
    intent_origin: turnResult?.intentOrigin || fallbackIntentOrigin || null,
    intent_anchor: turnResult?.intentAnchor || fallbackIntentAnchor || null,
    intent_candidate: turnResult?.intentCandidate || null,
    intent_candidate_confidence: turnResult?.intentCandidateConfidence ?? null,
    intent_change_status:
      turnResult?.intentChangeStatus === "pending" ? "pending" : "none",
    updated_at: now
  };

  if (event === "RESULT_READY") {
    updates.status = "complete";
    updates.phase = "result";
    updates.plan_status = "executed";
  } else if (event === "PLAN_RESET") {
    updates.phase = "plan";
    updates.plan_text = null;
    updates.plan_questions = null;
    updates.plan_status = null;
  } else {
    updates.phase = "plan";
    updates.plan_text = turnResult?.planText || session?.plan_text || null;
    updates.plan_questions = toPlanQuestions(session, turnResult);
    updates.plan_status = "awaiting_clarification";
  }

  const merged = { ...session, ...updates };
  validateSessionInvariants(merged);
  const to = deriveSessionState(merged);

  const expected =
    event === "RESULT_READY"
      ? SESSION_FSM_STATES.COMPLETE
      : event === "PLAN_RESET"
      ? SESSION_FSM_STATES.PLAN_DRAFT
      : updates.intent_change_status === "pending"
      ? SESSION_FSM_STATES.AWAITING_INTENT_CONFIRMATION
      : SESSION_FSM_STATES.AWAITING_CLARIFICATION;

  if (to !== expected) {
    throw new Error(
      `FSM transition failed: ${from} --${event}--> ${to} (expected ${expected}).`
    );
  }

  return {
    updates,
    transition: { from, event, to }
  };
}
