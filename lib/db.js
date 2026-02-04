import fs from "fs";
import path from "path";
import Database from "better-sqlite3";

export function initDb(dbPath) {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      username_key TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      status TEXT NOT NULL,
      phase TEXT NOT NULL,
      turn_count INTEGER NOT NULL,
      chat_history TEXT NOT NULL,
      trace_json TEXT NOT NULL,
      root_span TEXT NOT NULL,
      root_span_id TEXT,
      root_span_span_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS sessions_user_created
      ON sessions(user_id, created_at DESC);
  `);
  const columns = db.prepare("PRAGMA table_info(sessions)").all();
  const ensureColumn = (name, type) => {
    if (!columns.some((col) => col.name === name)) {
      db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${type}`);
    }
  };
  ensureColumn("root_span_id", "TEXT");
  ensureColumn("root_span_span_id", "TEXT");
  ensureColumn("plan_text", "TEXT");
  ensureColumn("plan_questions", "TEXT");
  ensureColumn("plan_status", "TEXT");
  return db;
}

export function createUser(db, { username, usernameKey, createdAt }) {
  const stmt = db.prepare(
    "INSERT INTO users (username, username_key, created_at) VALUES (?, ?, ?)"
  );
  const info = stmt.run(username, usernameKey, createdAt);
  return getUserById(db, info.lastInsertRowid);
}

export function getUserById(db, id) {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) || null;
}

export function getUserByUsernameKey(db, usernameKey) {
  return (
    db.prepare("SELECT * FROM users WHERE username_key = ?").get(usernameKey) ||
    null
  );
}

export function getUserByUsername(db, username) {
  return db.prepare("SELECT * FROM users WHERE username = ?").get(username) || null;
}

export function createSession(db, session) {
  const stmt = db.prepare(`
    INSERT INTO sessions (
      id, user_id, username, status, phase, turn_count,
      chat_history, trace_json, root_span, root_span_id, root_span_span_id,
      plan_text, plan_questions, plan_status,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    session.id,
    session.user_id,
    session.username,
    session.status,
    session.phase,
    session.turn_count,
    session.chat_history,
    session.trace_json,
    session.root_span,
    session.root_span_id,
    session.root_span_span_id,
    session.plan_text ?? null,
    session.plan_questions ?? null,
    session.plan_status ?? null,
    session.created_at,
    session.updated_at
  );
  return getSessionById(db, session.id);
}

export function getSessionById(db, id) {
  return db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) || null;
}

export function getActiveSessionForUser(db, userId) {
  return (
    db
      .prepare(
        "SELECT * FROM sessions WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1"
      )
      .get(userId) || null
  );
}

export function updateSession(db, id, updates) {
  const fields = Object.keys(updates);
  if (fields.length === 0) return getSessionById(db, id);
  const setClause = fields.map((f) => `${f} = ?`).join(", ");
  const values = fields.map((f) => updates[f]);
  const stmt = db.prepare(`UPDATE sessions SET ${setClause} WHERE id = ?`);
  stmt.run(...values, id);
  return getSessionById(db, id);
}

export function listSessionsForUser(db, userId, limit = 50) {
  return db
    .prepare(
      "SELECT id, username, status, phase, turn_count, created_at, updated_at FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?"
    )
    .all(userId, limit);
}

export function pruneSessions(db, userId, keep = 50) {
  const ids = db
    .prepare(
      "SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?"
    )
    .all(userId, keep)
    .map((row) => row.id);
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(
    `DELETE FROM sessions WHERE user_id = ? AND id NOT IN (${placeholders})`
  ).run(userId, ...ids);
}
