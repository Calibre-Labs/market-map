import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveSessionState,
  reduceSessionAfterTurn,
  SESSION_FSM_STATES,
  validateSessionInvariants
} from "../lib/fsm.js";

function makeSession(overrides = {}) {
  return {
    id: "session-1",
    status: "active",
    phase: "plan",
    plan_status: null,
    plan_text: null,
    plan_questions: null,
    intent_change_status: "none",
    intent_candidate: null,
    chat_history: "[]",
    trace_json: "{}",
    turn_count: 0,
    ...overrides
  };
}

test("deriveSessionState maps persisted fields to FSM states", () => {
  assert.equal(deriveSessionState(makeSession()), SESSION_FSM_STATES.PLAN_DRAFT);
  assert.equal(
    deriveSessionState(
      makeSession({
        plan_status: "awaiting_clarification",
        plan_text: "Plan text"
      })
    ),
    SESSION_FSM_STATES.AWAITING_CLARIFICATION
  );
  assert.equal(
    deriveSessionState(
      makeSession({
        plan_status: "awaiting_clarification",
        plan_text: "Plan text",
        intent_change_status: "pending"
      })
    ),
    SESSION_FSM_STATES.AWAITING_INTENT_CONFIRMATION
  );
  assert.equal(
    deriveSessionState(makeSession({ phase: "result" })),
    SESSION_FSM_STATES.RESULT
  );
  assert.equal(
    deriveSessionState(
      makeSession({ status: "complete", phase: "result", plan_status: "executed" })
    ),
    SESSION_FSM_STATES.COMPLETE
  );
});

test("validateSessionInvariants catches invalid persisted combinations", () => {
  assert.throws(() =>
    validateSessionInvariants(
      makeSession({
        status: "complete",
        phase: "plan",
        plan_status: "executed"
      })
    )
  );
  assert.throws(() =>
    validateSessionInvariants(
      makeSession({
        plan_status: "awaiting_clarification",
        plan_text: "",
        phase: "plan"
      })
    )
  );
  assert.throws(() =>
    validateSessionInvariants(
      makeSession({
        plan_status: "awaiting_clarification",
        plan_text: "Plan",
        intent_change_status: "pending",
        intent_candidate: ""
      })
    )
  );
});

test("reduceSessionAfterTurn RESULT_READY marks session complete", () => {
  const session = makeSession({
    plan_status: "awaiting_clarification",
    plan_text: "Plan text"
  });
  const result = reduceSessionAfterTurn({
    session,
    turnResult: {
      effectiveMode: "result",
      response: "final output",
      intentOrigin: "crm software",
      intentAnchor: "crm software"
    },
    nextHistory: [{ role: "user", content: "crm software" }],
    nextTrace: { turns: [] },
    turnNumber: 1,
    now: 1000,
    fallbackIntentOrigin: "crm software",
    fallbackIntentAnchor: "crm software"
  });

  assert.equal(result.transition.event, "RESULT_READY");
  assert.equal(result.transition.to, SESSION_FSM_STATES.COMPLETE);
  assert.equal(result.updates.status, "complete");
  assert.equal(result.updates.phase, "result");
  assert.equal(result.updates.plan_status, "executed");
});

test("reduceSessionAfterTurn PLAN_READY persists awaiting clarification", () => {
  const session = makeSession({ plan_text: "Old plan" });
  const result = reduceSessionAfterTurn({
    session,
    turnResult: {
      effectiveMode: "plan",
      planText: "New plan",
      planQuestions: ["A or B?"],
      intentOrigin: "healthcare software",
      intentAnchor: "healthcare software",
      intentChangeStatus: "none"
    },
    nextHistory: [{ role: "user", content: "healthcare software" }],
    nextTrace: { turns: [] },
    turnNumber: 2,
    now: 2000,
    fallbackIntentOrigin: "healthcare software",
    fallbackIntentAnchor: "healthcare software"
  });

  assert.equal(result.transition.event, "PLAN_READY");
  assert.equal(result.transition.to, SESSION_FSM_STATES.AWAITING_CLARIFICATION);
  assert.equal(result.updates.phase, "plan");
  assert.equal(result.updates.plan_status, "awaiting_clarification");
  assert.equal(result.updates.plan_text, "New plan");
  assert.equal(result.updates.plan_questions, JSON.stringify(["A or B?"]));
});

test("reduceSessionAfterTurn PLAN_READY with pending intent goes to intent confirmation", () => {
  const session = makeSession({ plan_text: "Current plan" });
  const result = reduceSessionAfterTurn({
    session,
    turnResult: {
      effectiveMode: "plan",
      planText: "Current plan",
      planQuestions: ["Keep A or switch B?"],
      intentOrigin: "healthcare software",
      intentAnchor: "healthcare software",
      intentCandidate: "finance software",
      intentCandidateConfidence: 0.6,
      intentChangeStatus: "pending"
    },
    nextHistory: [{ role: "user", content: "finance" }],
    nextTrace: { turns: [] },
    turnNumber: 3,
    now: 3000,
    fallbackIntentOrigin: "healthcare software",
    fallbackIntentAnchor: "healthcare software"
  });

  assert.equal(result.transition.event, "PLAN_READY");
  assert.equal(
    result.transition.to,
    SESSION_FSM_STATES.AWAITING_INTENT_CONFIRMATION
  );
  assert.equal(result.updates.intent_change_status, "pending");
  assert.equal(result.updates.intent_candidate, "finance software");
});

test("reduceSessionAfterTurn PLAN_READY enforces non-empty plan invariant", () => {
  const session = makeSession({ plan_text: null });
  assert.throws(() =>
    reduceSessionAfterTurn({
      session,
      turnResult: {
        effectiveMode: "plan",
        planText: null,
        planQuestions: [],
        intentOrigin: "crm software",
        intentAnchor: "crm software"
      },
      nextHistory: [{ role: "user", content: "crm software" }],
      nextTrace: { turns: [] },
      turnNumber: 4,
      now: 4000,
      fallbackIntentOrigin: "crm software",
      fallbackIntentAnchor: "crm software"
    })
  );
});
