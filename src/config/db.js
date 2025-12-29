// src/config/db.js
import sqlite3 from "sqlite3";
import dotenv from "dotenv";
import bcrypt from "bcrypt";
import path from "path";
import fs from "fs";

dotenv.config();
sqlite3.verbose();

// Detect environment
const isRender =
  process.env.RENDER === "true" || process.env.NODE_ENV === "production";

// Directories
const persistentDir = "/opt/render/project/data"; // Render’s permanent disk
const localDir = path.join(process.cwd(), "data");

// Choose correct path
const dbPath = isRender
  ? path.join(persistentDir, "app.db")
  : path.join(localDir, "app.db");

// Ensure directory exists
try {
  const targetDir = isRender ? persistentDir : localDir;
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
    console.log(`📁 Created data directory at: ${targetDir}`);
  }
} catch (err) {
  console.error("❌ Error creating data directory:", err);
}

let dbInstance = null;

// Promisified SQLite wrapper
function wrapDb(db) {
  return {
    run(sql, params = []) {
      return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
          if (err) return reject(err);
          resolve({ changes: this.changes, lastID: this.lastID });
        });
      });
    },
    get(sql, params = []) {
      return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
      });
    },
    all(sql, params = []) {
      return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
      });
    },
    exec(sql) {
      return new Promise((resolve, reject) => {
        db.exec(sql, (err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

// Lazy, safe connector
export async function getDb() {
  if (!dbInstance) {
    try {
      const native = new sqlite3.Database(dbPath, (err) => {
        if (err) console.error("❌ SQLite connection error:", err);
      });
      native.exec("PRAGMA foreign_keys = ON;");
      dbInstance = wrapDb(native);
      console.log("✅ SQLite connected at", dbPath);
    } catch (err) {
      console.error("❌ DB connection failed:", err);
    }
  }
  return dbInstance;
}

// Optional migration for schema evolution
async function ensureMatchesSchema(db) {
  const cols = await db.all(`PRAGMA table_info(matches);`);
  const names = cols.map((c) => c.name);

  if (!names.includes("cutoff_minutes_before")) {
    await db.run(
      `ALTER TABLE matches ADD COLUMN cutoff_minutes_before INTEGER NOT NULL DEFAULT 30;`
    );
    console.log("[Migration] Added matches.cutoff_minutes_before");
  }
  if (!names.includes("admin_declared_at")) {
    await db.run(`ALTER TABLE matches ADD COLUMN admin_declared_at TEXT;`);
    console.log("[Migration] Added matches.admin_declared_at");
  }
}

// Safe init with async fallback
export async function initDb() {
  // Precheck directory readiness
  const targetDir = path.dirname(dbPath);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const db = await getDb();

  if (process.env.RESET_DB_ON_START === "true") {
    try {
      if (fs.existsSync(dbPath)) {
        console.log("⚠️ Resetting DB on start");
        fs.unlinkSync(dbPath);
        dbInstance = null;
      }
    } catch (e) {
      console.error("DB reset failed:", e);
    }
  }

  // Safety: timeout in case Render file system is slow
  const timeout = (ms) => new Promise((r) => setTimeout(r, ms));
  await timeout(300); // small async pause to let FS settle

  const freshDb = await getDb();

  await freshDb.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS series (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      description TEXT,
      start_date_utc TEXT NOT NULL,
      end_date_utc TEXT,
      is_locked INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS series_members (
      series_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      joined_at TEXT NOT NULL,
      PRIMARY KEY (series_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      series_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      sport TEXT NOT NULL,
      team_a TEXT NOT NULL,
      team_b TEXT NOT NULL,
      start_time_utc TEXT NOT NULL,
      entry_points REAL NOT NULL DEFAULT 50,
      cutoff_minutes_before INTEGER NOT NULL DEFAULT 30,
      status TEXT NOT NULL DEFAULT 'scheduled',
      winner TEXT
    );

    CREATE TABLE IF NOT EXISTS predictions (
      match_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      predicted_team TEXT NOT NULL,
      predicted_at_utc TEXT NOT NULL,
      PRIMARY KEY (match_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS points_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      match_id INTEGER,
      series_id INTEGER,
      points REAL NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  await ensureMatchesSchema(freshDb);

  const count = await freshDb.get("SELECT COUNT(*) as c FROM users");
  if (!count || count.c === 0) {
    const username = process.env.BOOTSTRAP_ADMIN_USERNAME || "admin";
    const password = process.env.BOOTSTRAP_ADMIN_PASSWORD || "Admin@123";
    const displayName = "Admin";
    const hash = await bcrypt.hash(password, 10);
    const now = new Date().toISOString();

    await freshDb.run(
      "INSERT INTO users (username, password_hash, display_name, is_admin, created_at) VALUES (?,?,?,?,?)",
      [username, hash, displayName, 1, now]
    );
    console.log("✅ Admin user created");
  }

  console.log("✅ Database initialized successfully");
}
