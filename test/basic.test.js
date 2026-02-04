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
  listSessionsForUser,
  pruneSessions
} from "../lib/db.js";
import {
  normalizeBaseName,
  generateUniqueUsername,
  inferCategory
} from "../lib/username.js";

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
      created_at: createdAt + idx,
      updated_at: createdAt + idx
    });
  });

  const list = listSessionsForUser(db, user.id, 2);
  assert.equal(list.length, 2);

  pruneSessions(db, user.id, 1);
  const listAfter = listSessionsForUser(db, user.id, 5);
  assert.equal(listAfter.length, 1);
});
