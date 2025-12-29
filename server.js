const express = require('express');
const setupSession = require("./src/middleware/session.js");
const SQLiteStoreFactory = require('connect-sqlite3');
const dotenv = require('dotenv');
const helmet = require('helmet');
const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');

const profileRoutes = require('./src/routes/profile.js');
const { initDb } = require('./src/config/db.js');
const authRoutes = require('./src/routes/auth.js');
const adminRoutes = require('./src/routes/admin.js');
const seriesRoutes = require('./src/routes/series.js');
const dashboardRoutes = require('./src/routes/dashboard.js');
const { ensureAuthenticated } = require('./src/middleware/auth.js');

// find your current directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


// Read labels.json manually
const labelsPath = path.join(__dirname, 'src/config/labels.json');
const labels = JSON.parse(fs.readFileSync(labelsPath, 'utf8'));

dotenv.config();

const app = express();
app.use(helmet());

//use of profile routes
app.use('/', profileRoutes);

// Views (EJS)
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// 🆕 Make labels available to all EJS templates
app.locals.labels = labels || {};

// Static
app.use('/public', express.static(path.join(__dirname, 'public')));

// Body parsing
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));

// Capture previous URL (same-origin only) for Back link
app.use((req, res, next) => {
  const ref = req.get('Referer') || '';
  let sameOriginRef = '';
  try {
    const r = new URL(ref);
    if (r.origin === `${req.protocol}://${req.get('host')}`) {
      sameOriginRef = r.pathname + r.search + r.hash;
    }
  } catch (e) {}
  res.locals.prevUrl = sameOriginRef;
  next();
});


// ================================
// ✅ SESSION SETUP (Persistent Disk)
// ================================
setupSession(app);

// ================================
// DB init
// ================================
await initDb();

// No-cache headers
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Surrogate-Control', 'no-store');
  next();
});

// Inject user into views
app.use((req, res, next) => {
  res.locals.currentUser = (req.session && req.session.user) ? req.session.user : null;
  next();
});

// Simple request logger
app.use((req, res, next) => {
  console.log('[REQ]', req.method, req.path);
  next();
});

// Routes
app.get('/', (req, res) => res.redirect('/login'));
app.use('/', authRoutes);
app.use('/admin', ensureAuthenticated, adminRoutes);
app.use('/series', ensureAuthenticated, seriesRoutes);
app.use('/dashboard', ensureAuthenticated, dashboardRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).render('404', { title: 'Not Found' });
});

// =======================================
// 🔍 Health check for Render load balancer
// =======================================
app.get("/healthz", (req, res) => res.status(200).send("ok"));

// =======================================
// 🧹 Session validation on every request
// =======================================
app.use((req, res, next) => {
  // if session exists but DB user no longer valid, clear cookie
  if (req.session?.user && !req.session.user.id) {
    console.log("⚠️ Invalid session detected, clearing cookie");
    req.session.destroy(() => {});
  }
  next();
});

// Start server
const PORT = process.env.PORT || 3000;
//import "./src/utils/backupToGitHub.js";
app.listen(PORT, () => {
  console.log(`TRAVEL PLAN app running on http://localhost:${PORT}`);
});
