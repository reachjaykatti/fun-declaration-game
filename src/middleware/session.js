// src/middleware/session.js
import session from "express-session";
import SQLiteStoreFactory from "connect-sqlite3";
import path from "path";
import fs from "fs";

const SQLiteStore = SQLiteStoreFactory(session);

const isRender = process.env.RENDER === "true" || process.env.NODE_ENV === "production";
const persistentDir = "/opt/render/project/data";
const localDir = path.join(process.cwd(), "data");

// ensure session directory exists
const sessionDir = isRender ? persistentDir : localDir;
if (!fs.existsSync(sessionDir)) {
  fs.mkdirSync(sessionDir, { recursive: true });
  console.log("📁 Created session directory:", sessionDir);
}

const store = new SQLiteStore({
  db: "sessions.db",
  dir: sessionDir,
  concurrentDB: true,
});

export default function setupSession(app) {
  app.use(
    session({
      store,
      secret: process.env.SESSION_SECRET || "fun-game-secret",
      resave: false,
      saveUninitialized: false,
      cookie: {
        maxAge: 7 * 24 * 60 * 60 * 1000, // 1 week
        secure: false, // change to true if you enable HTTPS-only cookies
      },
    })
  );

  console.log("✅ Session store initialized at:", path.join(sessionDir, "sessions.db"));
}
