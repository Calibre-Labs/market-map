import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import {
  initDb,
  createUser,
  getUserByUsernameKey,
  createSession,
  getActiveSessionForUserAndTab,
  getSessionById,
  listStaleActiveSessions,
  listSessionsForUser,
  pruneSessions
} from "../lib/db.js";
import {
  normalizeBaseName,
  generateUniqueUsername,
  inferCategory,
  inferIntentAnchorFromHistory,
  isAffirmative,
  isNegative
} from "../lib/username.js";
import { extractGroundingSources, parseIntentChangeDecision } from "../lib/agent.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "market-map-"));
const dbPath = path.join(tempDir, "test.sqlite");
const db = initDb(dbPath);

after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("normalizeBaseName and generateUniqueUsername", () => {
  assert.equal(normalizeBaseName(" Atlas !! "), "atlas");
  assert.equal(normalizeBaseName("  "), "");

  let calls = 0;
  const handle = generateUniqueUsername("Atlas", () => {
    calls += 1;
    return calls < 2;
  });

  assert.match(handle, /^atlas\d{3}$/);
  assert.ok(calls >= 2);

  const invalid = generateUniqueUsername("!!!", () => false);
  assert.equal(invalid, null);
});

test("inferCategory uses last user input for confirmations", () => {
  const history = [
    { role: "user", content: "CRM software" },
    { role: "assistant", content: "Plan details" }
  ];
  const inferred = inferCategory("yes", history);
  assert.equal(inferred, "CRM software");
});

test("inferIntentAnchorFromHistory keeps first meaningful user category", () => {
  const history = [
    { role: "user", content: "Life sciences cloud software" },
    { role: "assistant", content: "Plan details" },
    { role: "user", content: "yes" },
    { role: "assistant", content: "Final details" }
  ];
  assert.equal(
    inferIntentAnchorFromHistory(history),
    "Life sciences cloud software"
  );
});

test("isAffirmative and isNegative classify confirmation text", () => {
  assert.equal(isAffirmative("yes switch it"), true);
  assert.equal(isNegative("no keep current scope"), true);
  assert.equal(isAffirmative("maybe"), false);
  assert.equal(isNegative("maybe"), false);
});

test("db users + sessions + prune", () => {
  const createdAt = Date.now();
  const user = createUser(db, {
    username: "atlas123",
    usernameKey: "atlas123",
    createdAt
  });
  const found = getUserByUsernameKey(db, "atlas123");
  assert.equal(found.username, user.username);

  const sessionIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  sessionIds.forEach((id, idx) => {
    createSession(db, {
      id,
      user_id: user.id,
      username: user.username,
      status: "complete",
      phase: "result",
      turn_count: idx + 1,
      chat_history: JSON.stringify([]),
      trace_json: JSON.stringify({ session_id: id }),
      root_span: JSON.stringify({}),
      root_span_id: "root-span-id",
      root_span_span_id: "root-span-span-id",
      plan_text: null,
      plan_questions: null,
      plan_status: null,
      intent_origin: "CRM software",
      created_at: createdAt + idx,
      updated_at: createdAt + idx
    });
  });
  const oneSession = getSessionById(db, sessionIds[0]);
  assert.equal(oneSession.intent_origin, "CRM software");

  const list = listSessionsForUser(db, user.id, 2);
  assert.equal(list.length, 2);

  pruneSessions(db, user.id, 1);
  const listAfter = listSessionsForUser(db, user.id, 5);
  assert.equal(listAfter.length, 1);
});

test("db active session lookup is isolated by tab id", () => {
  const createdAt = Date.now() + 1000;
  const user = createUser(db, {
    username: `tabuser-${createdAt}`,
    usernameKey: `tabuser-${createdAt}`,
    createdAt
  });

  const tabA = "tab-a";
  const tabB = "tab-b";
  const sessionA = createSession(db, {
    id: crypto.randomUUID(),
    user_id: user.id,
    tab_id: tabA,
    username: user.username,
    status: "active",
    phase: "plan",
    turn_count: 1,
    chat_history: JSON.stringify([]),
    trace_json: JSON.stringify({ session_id: "a" }),
    root_span: JSON.stringify({}),
    root_span_id: "root-a",
    root_span_span_id: "span-a",
    plan_text: "Plan A",
    plan_questions: JSON.stringify(["A?"]),
    plan_status: "awaiting_clarification",
    intent_origin: "healthcare software",
    created_at: createdAt + 1,
    updated_at: createdAt + 1
  });
  const sessionB = createSession(db, {
    id: crypto.randomUUID(),
    user_id: user.id,
    tab_id: tabB,
    username: user.username,
    status: "active",
    phase: "plan",
    turn_count: 1,
    chat_history: JSON.stringify([]),
    trace_json: JSON.stringify({ session_id: "b" }),
    root_span: JSON.stringify({}),
    root_span_id: "root-b",
    root_span_span_id: "span-b",
    plan_text: "Plan B",
    plan_questions: JSON.stringify(["B?"]),
    plan_status: "awaiting_clarification",
    intent_origin: "finance software",
    created_at: createdAt + 2,
    updated_at: createdAt + 2
  });

  const foundA = getActiveSessionForUserAndTab(db, user.id, tabA);
  const foundB = getActiveSessionForUserAndTab(db, user.id, tabB);
  assert.equal(foundA.id, sessionA.id);
  assert.equal(foundB.id, sessionB.id);
});

test("db stale active session lookup uses updated_at cutoff", () => {
  const createdAt = Date.now() + 2000;
  const user = createUser(db, {
    username: `stale-${createdAt}`,
    usernameKey: `stale-${createdAt}`,
    createdAt
  });

  const stale = createSession(db, {
    id: crypto.randomUUID(),
    user_id: user.id,
    tab_id: "stale-tab",
    username: user.username,
    status: "active",
    phase: "plan",
    turn_count: 1,
    chat_history: JSON.stringify([]),
    trace_json: JSON.stringify({ session_id: "stale" }),
    root_span: JSON.stringify({}),
    root_span_id: "root-stale",
    root_span_span_id: "span-stale",
    plan_text: "Stale plan",
    plan_questions: JSON.stringify(["stale?"]),
    plan_status: "awaiting_clarification",
    intent_origin: "analytics software",
    created_at: createdAt,
    updated_at: createdAt
  });

  const fresh = createSession(db, {
    id: crypto.randomUUID(),
    user_id: user.id,
    tab_id: "fresh-tab",
    username: user.username,
    status: "active",
    phase: "plan",
    turn_count: 1,
    chat_history: JSON.stringify([]),
    trace_json: JSON.stringify({ session_id: "fresh" }),
    root_span: JSON.stringify({}),
    root_span_id: "root-fresh",
    root_span_span_id: "span-fresh",
    plan_text: "Fresh plan",
    plan_questions: JSON.stringify(["fresh?"]),
    plan_status: "awaiting_clarification",
    intent_origin: "hr software",
    created_at: createdAt + 1,
    updated_at: createdAt + 1000
  });

  createSession(db, {
    id: crypto.randomUUID(),
    user_id: user.id,
    tab_id: "done-tab",
    username: user.username,
    status: "complete",
    phase: "result",
    turn_count: 3,
    chat_history: JSON.stringify([]),
    trace_json: JSON.stringify({ session_id: "done" }),
    root_span: JSON.stringify({}),
    root_span_id: "root-done",
    root_span_span_id: "span-done",
    plan_text: null,
    plan_questions: null,
    plan_status: "executed",
    intent_origin: "crm software",
    created_at: createdAt + 2,
    updated_at: createdAt - 5000
  });

  const staleOnly = listStaleActiveSessions(db, createdAt + 100, 10);
  const ids = staleOnly.map((session) => session.id);

  assert.ok(ids.includes(stale.id));
  assert.ok(!ids.includes(fresh.id));
});

test("extractGroundingSources supports variant grounding shapes", () => {
  const grounding = {
    groundingChunks: [
      { web: { uri: "https://example.com/a", title: "A" } },
      { retrievedContext: { url: "https://example.com/b", name: "B" } },
      { source: { uri: "www.example.com/c", title: "C" } }
    ],
    sources: [{ url: "https://example.com/d", title: "D" }]
  };

  const sources = extractGroundingSources(grounding);
  const urls = sources.map((source) => source.url);

  assert.deepEqual(urls, [
    "https://example.com/a",
    "https://example.com/b",
    "https://www.example.com/c",
    "https://example.com/d"
  ]);
});

test("parseIntentChangeDecision handles valid and malformed output", () => {
  const parsed = parseIntentChangeDecision(
    `{"action":"replace","candidate_category":"Enterprise cloud software","confidence":0.82,"reason":"New category requested"}`
  );
  assert.deepEqual(parsed, {
    action: "replace",
    candidateCategory: "Enterprise cloud software",
    confidence: 0.82,
    reason: "New category requested"
  });

  const missingCandidate = parseIntentChangeDecision(
    `{"action":"replace","candidate_category":"","confidence":0.9,"reason":"switch"}`
  );
  assert.deepEqual(missingCandidate, {
    action: "unclear",
    candidateCategory: "",
    confidence: 0,
    reason: "switch"
  });

  const malformed = parseIntentChangeDecision("not-json");
  assert.deepEqual(malformed, {
    action: "unclear",
    candidateCategory: "",
    confidence: 0,
    reason: ""
  });
});
