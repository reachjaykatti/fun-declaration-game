import express from 'express';
import setupSession from "./src/middleware/session.js";
import dotenv from 'dotenv';
import helmet from 'helmet';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Routes and middleware
import profileRoutes from './src/routes/profile.js';
import { initDb } from './src/config/db.js';
import authRoutes from './src/routes/auth.js';
import adminRoutes from './src/routes/admin.js';
import seriesRoutes from './src/routes/series.js';
import dashboardRoutes from './src/routes/dashboard.js';
import { ensureAuthenticated } from './src/middleware/auth.js';

// Determine directory (ESM-safe)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config();

// Read labels.json
const labelsPath = path.join(__dirname, 'src/config/labels.json');
let labels = {};
try {
  labels = JSON.parse(fs.readFileSync(labelsPath, 'utf8'));
} catch (err) {
  console.error('⚠️ Failed to read labels.json:', err.message);
}

const app = express();
app.use(helmet());

// Views
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Make labels available globally in EJS
app.locals.labels = labels;

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Body parsing
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));

// Previous URL capture
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
// ✅ SESSION SETUP
// ================================
setupSession(app);

// ================================
// ✅ DATABASE INIT
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
  res.locals.currentUser = req.session?.user || null;
  next();
});

// Simple request logger
app.use((req, res, next) => {
  console.log(`[REQ] ${req.method} ${req.path}`);
  next();
});

// ================================
// ✅ ROUTES
// ================================
app.get('/', (req, res) => res.redirect('/login'));
app.use('/', profileRoutes);
app.use('/', authRoutes);
app.use('/admin', ensureAuthenticated, adminRoutes);
app.use('/series', ensureAuthenticated, seriesRoutes);
app.use('/dashboard', ensureAuthenticated, dashboardRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).render('404', { title: 'Not Found' });
});

// Health check (Render)
app.get("/healthz", (req, res) => res.status(200).send("ok"));

// Session validation
app.use((req, res, next) => {
  if (req.session?.user && !req.session.user.id) {
    console.log("⚠️ Invalid session detected, clearing cookie");
    req.session.destroy(() => {});
  }
  next();
});

// Server start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Travel Plan app running on port ${PORT}`);
});
