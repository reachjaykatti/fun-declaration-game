console.log("✅ Admin planner route loaded into memory");
import { nowUtcISO } from '../utils/time.js';
import express from 'express';
import bcrypt from 'bcrypt';
import moment from 'moment-timezone';
import multer from 'multer';
import { getDb } from '../config/db.js';
import { ensureAdmin } from '../middleware/auth.js';
import { ensureAuthenticated } from '../middleware/auth.js';
import XLSX from 'xlsx';

const router = express.Router();
console.log("🧭 admin.js routes initialized");

router.get('/debug/sqlite-triggers', async (req, res) => {
  const db = await getDb();
  const rows = await db.all(`
    SELECT name, sql
    FROM sqlite_master
    WHERE type IN ('trigger', 'view')
      AND sql LIKE '%lower(%'
  `);
  res.json(rows);
});


// Multer for CSV/TSV uploads (kept in memory)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 } // 2 MB
});

router.use(ensureAdmin);
router.use(express.json());
// Users
router.get('/users/new', (req, res) => res.render('admin/user_new', { title: 'Add User' }));
router.post('/users/new', async (req, res) => {
  const { username, password, display_name, is_admin } = req.body;
  const bcrypt = (await import('bcrypt')).default;
  const db = await getDb();
  const hash = await bcrypt.hash(password, 10);
  try {
    await db.run('INSERT INTO users (username, password_hash, display_name, is_admin, created_at) VALUES (?,?,?,?,?)',
      [username, hash, display_name, is_admin ? 1 : 0, nowUtcISO()]);
    res.redirect('/admin/users/new');
  } catch (e) {
    res.render('admin/user_new', { title: 'Add User', error: 'Failed: ' + e.message });
  }
});

// List all users
router.get('/users', async (req, res) => {
  const db = await getDb();
  const users = await db.all(
    'SELECT id, username, display_name, is_admin FROM users ORDER BY created_at DESC'
  );

  res.render('admin/users', {
    title: 'Users',
    users
  });
});
// Show edit user page
router.get('/users/:id/edit', async (req, res) => {
  const db = await getDb();
  const user = await db.get(
    'SELECT id, username, display_name, is_admin FROM users WHERE id = ?',
    [req.params.id]
  );

  if (!user) return res.redirect('/admin/users');

  res.render('admin/edit-user', {
    title: 'Edit User',
    user
  });
});

// 🗑️ Delete User (Admin only, safe version)
router.post('/users/:id/delete', ensureAdmin, async (req, res) => {
  const db = await getDb();
  const userId = req.params.id;

  try {
    // Prevent deleting your own account
    if (req.session.user && req.session.user.id == userId) {
      const users = await db.all('SELECT id, username, display_name, is_admin FROM users ORDER BY created_at DESC');
      return res.render('admin/users', {
        title: 'Users',
        users,
        error: '⚠️ You cannot delete your own account.'
      });
    }

    console.log(`🗑️ Attempting to delete user ID: ${userId}`);

    // List of related tables that might contain user_id
    const tables = ['points_ledger', 'predictions', 'series_members', 'user_streaks'];

    for (const table of tables) {
      try {
        await db.run(`DELETE FROM ${table} WHERE user_id = ?`, [userId]);
        console.log(`✅ Cleaned from table: ${table}`);
      } catch (err) {
        console.log(`⚠️ Skipped table ${table}: ${err.message}`);
      }
    }

    // Delete user last
    await db.run('DELETE FROM users WHERE id = ?', [userId]);
    console.log(`✅ User ${userId} deleted successfully`);

    res.redirect('/admin/users');
  } catch (err) {
    console.error('❌ User delete failed:', err);
    res.status(500).send('Failed to delete user. ' + err.message);
  }
});


// Update user (name + password)
router.post('/users/:id/edit', async (req, res) => {
  const { display_name, new_password } = req.body;
  const db = await getDb();

  if (display_name && display_name.trim()) {
    await db.run(
      'UPDATE users SET display_name = ? WHERE id = ?',
      [display_name.trim(), req.params.id]
    );
  }

  if (new_password && new_password.length >= 6) {
    const hash = await bcrypt.hash(new_password, 10);
    await db.run(
      'UPDATE users SET password_hash = ? WHERE id = ?',
      [hash, req.params.id]
    );
  }

  res.redirect('/admin/users');
});

// Series create/edit/members/lock/delete
router.get('/series/new', (req, res) => res.render('admin/series_new', { title: 'New Series' }));
router.post('/series/new', async (req, res) => {
  const { name, description, start_date_utc, end_date_utc } = req.body;
  const db = await getDb();
  try {
    await db.run('INSERT INTO series (name, description, start_date_utc, end_date_utc, is_locked, created_by, created_at) VALUES (?,?,?,?,?,?,?)',
      [name, description, start_date_utc, end_date_utc || null, 0, req.session.user.id, nowUtcISO()]);
    res.redirect('/admin');
  } catch (e) {
    res.render('admin/series_new', { title: 'New Series', error: e.message });
  }
});
router.get('/series/:id/edit', async (req, res) => {
  const db = await getDb();
  const series = await db.get('SELECT * FROM series WHERE id = ?', [req.params.id]);
  res.render('admin/series_edit', { title: 'Edit Series', series });
});
router.post('/series/:id/edit', async (req, res) => {
  const { name, description, start_date_utc, end_date_utc } = req.body;
  const db = await getDb();
  try {
    await db.run('UPDATE series SET name = ?, description = ?, start_date_utc = ?, end_date_utc = ? WHERE id = ?',
      [name, description, start_date_utc, end_date_utc || null, req.params.id]);
    res.redirect('/admin');
  } catch (e) {
    const series = await db.get('SELECT * FROM series WHERE id = ?', [req.params.id]);
    res.render('admin/series_edit', { title: 'Edit Series', series, error: e.message });
  }
});
router.get('/series/:id/members', async (req, res) => {
  const db = await getDb();
  const series = await db.get('SELECT * FROM series WHERE id = ?', [req.params.id]);
  const users = await db.all('SELECT id, username, display_name FROM users ORDER BY username');
  const members = await db.all('SELECT u.id, u.username, u.display_name FROM series_members sm JOIN users u ON sm.user_id=u.id WHERE sm.series_id = ?', [req.params.id]);
  res.render('admin/series_members', { title: 'Series Members', series, users, members });
});
router.post('/series/:id/members/add', async (req, res) => {
  const db = await getDb();
  const { user_id } = req.body;
  try {
    await db.run('INSERT INTO series_members (series_id, user_id, joined_at) VALUES (?,?,?)', [req.params.id, user_id, nowUtcISO()]);
    res.redirect(`/admin/series/${req.params.id}/members`);
  } catch (e) { res.status(400).send(e.message); }
});
router.post('/series/:id/lock', async (req, res) => {
  const db = await getDb();
  await db.run('UPDATE series SET is_locked = 1 WHERE id = ?', [req.params.id]);
  res.redirect('/admin');
});
// =============================================
// 🧹 Delete Series + Cleanup Related Data
// =============================================
router.post('/series/:id/delete', async (req, res) => {
  const db = await getDb();
  const seriesId = req.params.id;

  try {
    // Find all matches linked to this series
    const matches = await db.all('SELECT id FROM matches WHERE series_id = ?', [seriesId]);
    const matchIds = matches.map(m => m.id);

    if (matchIds.length > 0) {
      await db.run(`DELETE FROM predictions WHERE match_id IN (${matchIds.map(() => '?').join(',')})`, matchIds);
      await db.run(`DELETE FROM points_ledger WHERE match_id IN (${matchIds.map(() => '?').join(',')})`, matchIds);
      await db.run(`DELETE FROM matches WHERE id IN (${matchIds.map(() => '?').join(',')})`, matchIds);
    }

    await db.run('DELETE FROM series_members WHERE series_id = ?', [seriesId]);
    await db.run('DELETE FROM points_ledger WHERE series_id = ?', [seriesId]);
    await db.run('DELETE FROM series WHERE id = ?', [seriesId]);

    console.log(`🧹 Series ${seriesId} and related data deleted successfully.`);

    // 🧠 Optional: cleanup orphaned streaks or old ledgers with no matching series
    await db.run(`
      DELETE FROM points_ledger
      WHERE series_id NOT IN (SELECT id FROM series)
    `);

    res.redirect('/admin');
  } catch (err) {
    console.error('❌ Error deleting series:', err);
    res.status(500).send('Failed to delete series and its related data.');
  }
});

// Matches: manage/create/edit

// === Admin: Manage Matches (series-wise) with IST/Cutoff + Admin declared dot ===
router.get('/series/:id/matches', async (req, res) => {
  const db = await getDb();
  const series = await db.get('SELECT * FROM series WHERE id = ?', [req.params.id]);
  const rawMatches = await db.all(
    'SELECT * FROM matches WHERE series_id = ? ORDER BY start_time_utc ASC',
    [req.params.id]
  );
  const nowMillis = Date.now();

  // Determine admin-as-player user id (prefer series.created_by, fallback to first is_admin=1)
  let adminUserId = (series && series.created_by) ? series.created_by : null;
  if (!adminUserId) {
    const adm = await db.get('SELECT id FROM users WHERE is_admin = 1 ORDER BY id LIMIT 1');
    adminUserId = adm ? adm.id : null;
  }

  // Build admin declared map
  let adminDeclaredMap = {};
  if (adminUserId && rawMatches.length > 0) {
    const ids = rawMatches.map(m => m.id).join(',');
    const aPreds = await db.all(
      'SELECT match_id FROM predictions WHERE user_id = ? AND match_id IN (' + ids + ')',
      [adminUserId]
    );
    for (let i = 0; i < aPreds.length; i++) {
      adminDeclaredMap[aPreds[i].match_id] = true;
    }
  }

  // ✅ Build matches array with computed times & labels
  const matches = rawMatches.map(function (m) {
    const startIstStr = moment.tz(m.start_time_utc, 'UTC').tz('Asia/Kolkata').format('YYYY-MM-DD HH:mm');

    const cutoffMinutes = (typeof m.cutoff_minutes_before === 'number' && !isNaN(m.cutoff_minutes_before))
      ? m.cutoff_minutes_before : 30;

    const startMillis = new Date(m.start_time_utc).getTime();
    const cutoffMillis = startMillis - cutoffMinutes * 60 * 1000;
    const cutoffIstStr = moment.tz(cutoffMillis, 'UTC').tz('Asia/Kolkata').format('YYYY-MM-DD HH:mm');

    let timeLeftLabel = '';
    if (nowMillis >= cutoffMillis) {
      timeLeftLabel = 'Cutoff closed';
    } else {
      const msLeft = cutoffMillis - nowMillis;
      const minsTotal = Math.floor(msLeft / (60 * 1000));
      const hours = Math.floor(minsTotal / 60);
      const mins = minsTotal % 60;
      timeLeftLabel = (hours > 0 ? (hours + 'h ') : '') + mins + 'm left';
    }

    return {
      ...m,
      startIstStr,
      cutoffIstStr,
      timeLeftLabel,
      adminDeclared: adminDeclaredMap[m.id] ? true : false
    };
  });

  // ✅ Group matches *after* building them
const grouped = {
  upcoming: matches.filter(m => m.status === 'scheduled'),
  ongoing: matches.filter(m => m.status === 'live'),
  completed: matches.filter(m => m.status === 'completed'),
  cancelled: matches.filter(m => m.status === 'cancelled'),
};

// ✅ Define labels before rendering
const labels = { declare: 'Plan', vs: 'OR' };

// ✅ Render grouped layout — ensure file name matches actual EJS file
try {
  res.render('admin/matches_manage', {
    title: 'Manage Travels',
    series,
    matches,
    grouped,
    labels
  });
} catch (err) {
  console.error("❌ Admin render failed:", err);
  res.status(500).send("Render error — check EJS template path or variable names.");
}
});
router.get('/series/:id/matches/new', async (req, res) => {
  const db = await getDb();
  const series = await db.get('SELECT * FROM series WHERE id = ?', [req.params.id]);
  res.render('admin/match_new', { title: 'New Match', series });
});
router.post('/series/:id/matches/new', async (req, res) => {
  const { name, sport, team_a, team_b, start_time_ist, start_time_utc, cutoff_minutes_before, entry_points } = req.body;
  const db = await getDb();
    // 🧩 Prevent duplicate travel names in same series
  const existing = await db.get(
    'SELECT id FROM matches WHERE series_id = ? AND LOWER(name) = LOWER(?)',
    [req.params.id, name.trim()]
  );
  if (existing) {
    return res.status(400).send(`
      <h3 style="color:red; font-family:sans-serif; padding:1rem;">
        ⚠️ A travel named "${name}" already exists in this series.<br>
        Please use a different name.
      </h3>
      <a href="/admin/series/${req.params.id}/matches" style="font-family:sans-serif;">← Back</a>
    `);
  }

  let startUtc = start_time_utc && start_time_utc.trim() ? start_time_utc.trim() : '';
  if (!startUtc && start_time_ist && start_time_ist.trim()) {
    // Accept both YYYY-MM-DD HH:mm AND DD-MM-YYYY HH:mm
    const istVal = start_time_ist.trim();
    let m = moment.tz(istVal, 'YYYY-MM-DD HH:mm', 'Asia/Kolkata', true);
    if (!m.isValid()) m = moment.tz(istVal, 'DD-MM-YYYY HH:mm', 'Asia/Kolkata', true);
    if (!m.isValid()) return res.status(400).send('Invalid IST format. Use YYYY-MM-DD HH:mm or DD-MM-YYYY HH:mm');
    startUtc = m.utc().toISOString();
  }
  if (!startUtc) return res.status(400).send('Start time required (IST or UTC)');

  await db.run('INSERT INTO matches (series_id, name, sport, team_a, team_b, start_time_utc, cutoff_minutes_before, entry_points, status) VALUES (?,?,?,?,?,?,?,?,?)',
    [req.params.id, name, sport, team_a, team_b, startUtc, cutoff_minutes_before || 30, entry_points || 50, 'scheduled']);
  res.redirect(`/admin/series/${req.params.id}/matches`);
});
// === Admin: Delete Match ===
router.post('/series/:seriesId/matches/:matchId/delete', async (req, res) => {
  const db = await getDb();

  await db.run('DELETE FROM matches WHERE id = ? AND series_id = ?', [
    req.params.matchId,
    req.params.seriesId
  ]);

  res.redirect(`/admin/series/${req.params.seriesId}/matches`);
});

// ✏️ Edit Travel (GET)
router.get('/series/:seriesId/matches/:matchId/edit', async (req, res) => {
  const db = await getDb();
  const match = await db.get(
    'SELECT * FROM matches WHERE id = ? AND series_id = ?',
    [req.params.matchId, req.params.seriesId]
  );
  if (!match) return res.status(404).send('Travel not found');

  const moment = (await import('moment-timezone')).default;
  const start_time_ist = match.start_time_utc
    ? moment.utc(match.start_time_utc).tz('Asia/Kolkata').format('YYYY-MM-DD HH:mm')
    : '';

  const series = await db.get('SELECT * FROM series WHERE id = ?', [req.params.seriesId]);

  res.render('admin/match_edit', {
    title: `Edit Travel: ${match.name}`,
    match: { ...match, start_time_ist },
    series
  });
});

// ✏️ Edit Match (POST)
router.post('/series/:seriesId/matches/:matchId/edit', async (req, res) => {
  try {
    const db = await getDb();
    const matchId = parseInt(req.params.matchId, 10);
    const body = req.body;

    // 🔍 Fetch existing record
    const existing = await db.get('SELECT * FROM matches WHERE id = ? AND series_id = ?', [
      matchId,
      req.params.seriesId
    ]);
    if (!existing) return res.status(404).send('Travel not found');

    let startUtc = body.start_time_utc?.trim() || '';

    // Convert IST → UTC if UTC missing
    if (!startUtc && body.start_time_ist?.trim()) {
      const m = moment.tz(body.start_time_ist.trim(), ['YYYY-MM-DD HH:mm', 'DD-MM-YYYY HH:mm'], 'Asia/Kolkata', true);
      if (!m.isValid()) return res.status(400).send('Invalid IST format.');
      startUtc = m.utc().toISOString();
    }

    if (!startUtc) return res.status(400).send('Start time required.');

    await db.run(
      `UPDATE matches SET
        name = ?, sport = ?, team_a = ?, team_b = ?, start_time_utc = ?, cutoff_minutes_before = ?, entry_points = ?, status = ?
       WHERE id = ?`,
      [
        body.name,
        body.sport,
        body.team_a,
        body.team_b,
        startUtc,
        body.cutoff_minutes_before,
        body.entry_points,
        body.status,
        matchId
      ]
    );

    res.redirect(`/admin/series/${req.params.seriesId}/matches`);
  } catch (err) {
    console.error('Error updating travel:', err);
    res.status(500).send('Update failed.');
  }
});

// -----------------------------
// ❌ Delete Match (Cascade Delete)
// -----------------------------
router.post('/matches/:matchId/delete', ensureAuthenticated, async (req, res) => {
  const db = await getDb();
  const matchId = req.params.matchId;

  try {
    await db.run('BEGIN TRANSACTION');
    await db.run('DELETE FROM points_ledger WHERE match_id = ?', [matchId]);
    await db.run('DELETE FROM predictions WHERE match_id = ?', [matchId]);
    await db.run('DELETE FROM matches WHERE id = ?', [matchId]);
    await db.run('COMMIT');
    console.log(`🗑️ Match ${matchId} deleted (with all linked data)`);
  } catch (err) {
    await db.run('ROLLBACK');
    console.error('❌ Delete failed:', err);
    return res.status(500).send('Database delete failed.');
  }

  res.redirect(`/admin/series/${req.body.series_id}/matches`);
});

// =========================
// ADMIN HOME
// =========================
router.get('/', async (req, res) => {
  const db = await getDb();
  const rawSeries = await db.all('SELECT * FROM series ORDER BY created_at DESC');

  const series = rawSeries.map(s => ({
    ...s,
    startIst: s.start_date_utc ? moment.tz(s.start_date_utc, 'UTC').tz('Asia/Kolkata').format('YYYY-MM-DD HH:mm') : '',
    endIst: s.end_date_utc ? moment.tz(s.end_date_utc, 'UTC').tz('Asia/Kolkata').format('YYYY-MM-DD HH:mm') : ''
  }));

  res.render('admin/home', { title: 'Admin', series });
});

// =========================
// BULK IMPORT – SUBMIT (EXCEL OR TEXT)
// =========================
// =========================
// BULK IMPORT – PAGE (GET)
// =========================
router.get('/series/:id/matches/bulk', async (req, res) => {
  try {
    const db = await getDb();
    const series = await db.get('SELECT * FROM series WHERE id = ?', [req.params.id]);

    if (!series) {
      console.warn(`⚠️ Series not found for id ${req.params.id}`);
      return res.status(404).render('404', { title: 'Series Not Found' });
    }

    // ✅ Try rendering and catch any EJS template issues
    try {
      res.render('admin/matches_bulk', {
        title: 'Bulk Import Matches',
        series,
        result: null,
        preview: null
      });
    } catch (renderErr) {
      console.error("❌ Failed to render matches_bulk.ejs:", renderErr);
      return res.status(500).send("Template render failed: " + renderErr.message);
    }

  } catch (err) {
    console.error("❌ Bulk Import page load failed:", err);
    return res.status(500).send("Server error: " + err.message);
  }
});

router.post('/series/:id/matches/bulk', upload.single('file'), async (req, res) => {
  const db = await getDb();
  console.log("📘 DB connection ready for bulk import");

  let ok = 0;
  let skipped = 0;
  const errors = [];
  let preview = null;

  try {
    let dataRows = [];

    // ✅ 1. If Excel file uploaded
    if (req.file) {
      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      dataRows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

      if (dataRows && dataRows.length > 0) {
        console.log("🔍 SAMPLE ROW STRUCTURE:", JSON.stringify(dataRows[0], null, 2));
      } else {
        console.log("⚠️ No rows found in Excel sheet");
      }

      // ✅ Normalize all row keys safely
      dataRows = dataRows.map(row => {
        const safeRow = {};
        Object.keys(row || {}).forEach(k => {
          let safeKey = '';
          try {
            if (typeof k === 'string') safeKey = k.trim().toLowerCase();
            else if (typeof k === 'number') safeKey = String(k).trim().toLowerCase();
            else safeKey = String(k || '').trim();
          } catch (err) {
            console.warn("⚠️ Key normalization issue:", k, err.message);
            safeKey = String(k || '').trim();
          }
          safeRow[safeKey] = row[k];
        });
        return safeRow;
      });

      // ✅ Normalize values
      dataRows = dataRows.map(row => {
        const safeRow = {};
        for (const key in row) {
          let val = row[key];
          if (val && typeof val === 'object') {
            if (Array.isArray(val.richText)) {
              val = val.richText.map(rt => rt.text || '').join('');
            } else if ('text' in val) {
              val = val.text;
            } else if ('v' in val) {
              val = val.v;
            } else {
              val = JSON.stringify(val);
            }
          }
          if (typeof val === 'number') val = String(val);
          if (typeof val !== 'string') val = '';
          safeRow[key] = val.trim();
        }
        return safeRow;
      });
    }

    // ✅ 2. If pasted text provided instead
    else if (req.body.text && req.body.text.trim()) {
      const lines = req.body.text.trim().split('\n').filter(l => l.trim());
      const headers = lines[0]
        .split(/[\t,]/)
        .map(h => (typeof h === 'string' ? h.trim().toLowerCase() : String(h || '').trim()));

      dataRows = lines.slice(1).map(line => {
        const cols = line.split(/[\t,]/);
        const obj = {};
        headers.forEach((h, i) => (obj[h] = cols[i] || ''));
        return obj;
      });
    }

    // ✅ Defensive check — must stay INSIDE this try block
    if (!dataRows.length) {
      res.json({
        ok: 0,
        skipped: 0,
        errors: ['No data found in upload or text input.']
      });
      return; // ✅ safe return INSIDE route
    }

    // ✅ 3. If only Preview requested
    if (req.body.preview) {
      preview = {
        headers: Object.keys(dataRows[0] || {}),
        rows: dataRows.slice(0, 5)
      };
      return res.render('admin/matches_bulk', {
        title: 'Bulk Import Preview',
        series: await db.get('SELECT * FROM series WHERE id = ?', [req.params.id]),
        result: null,
        preview
      });
    }

   // =========================
// 4️⃣ PROCESS IMPORT CLEANLY
// =========================
for (let i = 0; i < dataRows.length; i++) {
  const r = dataRows[i];

  try {
    // 🧹 Normalize and sanitize every field
    const normalizeValue = (val, fallback = '') => {
      if (val == null) return fallback;
      if (typeof val === 'object') {
        try {
          if (Array.isArray(val.richText))
            return val.richText.map(rt => rt.text || '').join('').trim();
          if ('text' in val) return String(val.text).trim();
          if ('v' in val) return String(val.v).trim();
          return JSON.stringify(val);
        } catch {
          return fallback;
        }
      }
      return String(val).trim();
    };

    // ✅ Extract clean fields
    const name = normalizeValue(r.name);
    const sport = normalizeValue(r.sport, 'Travels');
    const team_a = normalizeValue(r.team_a);
    const team_b = normalizeValue(r.team_b);
    let ist = normalizeValue(r.start_time_ist);
    const cutoff = parseInt(normalizeValue(r.cutoff_minutes_before) || 30, 10);
    const entry = parseFloat(normalizeValue(r.entry_points) || 50);

    console.log("✅ CLEANED ROW:", { name, team_a, team_b, ist });

    // 🕓 Convert Excel date serials → readable IST datetime
    if (!isNaN(ist) && ist !== '') {
      const jsDate = XLSX.SSF.parse_date_code(Number(ist));
      if (jsDate) {
        ist = moment.tz(
          `${jsDate.y}-${String(jsDate.m).padStart(2, '0')}-${String(jsDate.d).padStart(2, '0')} ${String(jsDate.H).padStart(2, '0')}:${String(jsDate.M).padStart(2, '0')}`,
          'Asia/Kolkata'
        ).format('YYYY-MM-DD HH:mm');
      }
    }

    if (!name || !team_a || !team_b || !ist) {
      skipped++;
      errors.push(`Row ${i + 2}: Missing required fields`);
      continue;
    }

    const m = moment.tz(
      ist,
      ['YYYY-MM-DD HH:mm', 'DD-MM-YYYY HH:mm'],
      'Asia/Kolkata',
      true
    );
    if (!m.isValid()) {
      skipped++;
      errors.push(`Row ${i + 2}: Invalid IST date/time`);
      continue;
    }

    // ✅ Safe insert
    const insertSQL = `
      INSERT INTO matches
        (series_id, name, sport, team_a, team_b, start_time_utc, cutoff_minutes_before, entry_points, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const insertParams = [
      req.params.id,
      String(name),
      String(sport),
      String(team_a),
      String(team_b),
      m.utc().toISOString(),
      Number(cutoff) || 30,
      Number(entry) || 50,
      'scheduled'
    ];

    await db.run(insertSQL, insertParams);
    ok++;
  } catch (err) {
    skipped++;
    errors.push(`Row ${i + 2}: ${err.message}`);
  }
}

res.json({ ok, skipped, errors });


} catch (err) { // ✅ closes outer try
  console.error('❌ Bulk import failed:', err);
  res.json({
    ok: 0,
    skipped: 0,
    errors: [err.message || 'Unexpected server error']
  });
}
});

// ==============================
// 🧭 ADMIN MATCH PLANNER VIEW (Modern Layout)
// ==============================
router.get('/series/:seriesId/matches/:matchId/planner', async (req, res) => {
  console.log("🧭 Loaded modern planner route for admin.js");
  try {
    const db = await getDb();
    const { seriesId, matchId } = req.params;

    const match = await db.get('SELECT * FROM matches WHERE id = ?', [matchId]);
    if (!match) return res.status(404).render('404', { title: 'Not Found' });

    const series = await db.get('SELECT * FROM series WHERE id = ?', [seriesId]);

    const preds = await db.all(`
      SELECT p.*, u.display_name
      FROM predictions p
      JOIN users u ON p.user_id = u.id
      WHERE p.match_id = ?
    `, [matchId]);

    const row = await db.get('SELECT COUNT(*) AS c FROM series_members WHERE series_id = ?', [seriesId]);
    const membersCount = row?.c || 0;

    const aCount = preds.filter(p => p.predicted_team === 'A').length;
    const bCount = preds.filter(p => p.predicted_team === 'B').length;

    const members = await db.all(`
      SELECT u.id, u.display_name 
      FROM series_members sm 
      JOIN users u ON sm.user_id = u.id 
      WHERE sm.series_id = ?
    `, [seriesId]);

    const votedIds = preds.map(p => p.user_id);
    const missedTravellers = members.filter(m => !votedIds.includes(m.id));

    const missed = Math.max(0, membersCount - (aCount + bCount));
    const entry = match.entry_points || 0;

    const cutoffMins = match.cutoff_minutes_before || 30;
    const cutoffTime = new Date(match.start_time_utc).getTime() - cutoffMins * 60000;
    const now = Date.now();
    const isCutoffOver = now >= cutoffTime;

    const probable = {
      A: {
        winners: aCount,
        losers: bCount + missed,
        totalPot: (bCount + missed) * entry,
        perPlanner: aCount > 0 ? ((bCount + missed) * entry) / aCount : 0
      },
      B: {
        winners: bCount,
        losers: aCount + missed,
        totalPot: (aCount + missed) * entry,
        perPlanner: bCount > 0 ? ((aCount + missed) * entry) / bCount : 0
      }
    };

    console.log("✅ Rendering match_planner with cutoff:", { isCutoffOver });
console.log("🧮 Probable check:", {
  isCutoffOver,
  probable,
  aCount,
  bCount,
  missed,
  entry
});
// ✅ Fetch users who haven’t declared yet
const notDeclared = await db.all(`
  SELECT u.display_name
  FROM users u
  JOIN series_members sm ON sm.user_id = u.id
  WHERE sm.series_id = ?
  AND u.id NOT IN (
    SELECT p.user_id FROM predictions p WHERE p.match_id = ?
  )
`, [seriesId, matchId]);

    res.render('admin/match_planner', {
      title: `Planner — ${match.name}`,
      match,
      series,
      preds,
      membersCountVal: membersCount,
      probable,
      aCount,
      bCount,
      missed,
      missedTravellers,
      isCutoffOver,
      labels: req.app.locals.labels || {},
      moment,
      notDeclared
    });

  } catch (err) {
    console.error('🔴 Error loading planner:', err);
    res.status(500).render('404', { title: 'Error Loading Planner' });
  }
});


// ==============================
// 🔄 RESET MATCH + LEDGER
// ==============================
router.post('/matches/:matchId/reset-ledger', async (req, res) => {
  const db = await getDb();
  const matchId = req.params.matchId;
  try {
    await db.run('DELETE FROM points_ledger WHERE match_id = ?', [matchId]);
    await db.run('UPDATE matches SET status = ?, winner = NULL, admin_declared_at = NULL WHERE id = ?', ['scheduled', matchId]);
    res.json({ success: true, message: 'Match reset successfully.' });
  } catch (e) {
    console.error('❌ Failed to reset match:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ==============================
// 🏁 DECLARE WINNER (AJAX-based, stays on same page)
// ==============================
router.post('/matches/:matchId/declare', async (req, res) => {
  try {
    const db = await getDb();
    const matchId = req.params.matchId;

    let { winner, washed_out } = req.is('application/json') ? req.body : req.body;
    washed_out = washed_out === true || washed_out === 'true';

    const match = await db.get('SELECT * FROM matches WHERE id = ?', [matchId]);
    if (!match) return res.json({ success: false, error: 'Match not found.' });

    // Prevent re-declare
    if (['completed', 'washed_out', 'cancelled'].includes(match.status)) {
      return res.json({ success: false, error: 'Already declared or closed.' });
    }

    // Normalize winner
    let winnerKey = null;
    if (winner === match.team_a) winnerKey = 'A';
    else if (winner === match.team_b) winnerKey = 'B';
    else winnerKey = winner;

    // Handle washed-out
    if (washed_out) {
      await db.run(
        'UPDATE matches SET status = ?, winner = NULL, admin_declared_at = ? WHERE id = ?',
        ['washed_out', nowUtcISO(), matchId]
      );
      return res.json({ success: true, message: 'Declared as washed out.' });
    }

    // Update match
    await db.run(
      'UPDATE matches SET status = ?, winner = ?, admin_declared_at = ? WHERE id = ?',
      ['completed', winnerKey, nowUtcISO(), matchId]
    );

    // Ledger update
    const preds = await db.all('SELECT * FROM predictions WHERE match_id = ?', [matchId]);
    const winnersPred = preds.filter(p => p.predicted_team === winnerKey).map(p => p.user_id);
    const losersPred = preds.filter(p => p.predicted_team !== winnerKey).map(p => p.user_id);

    const members = await db.all('SELECT user_id FROM series_members WHERE series_id = ?', [match.series_id]);
    const memberIds = members.map(m => m.user_id);
    const predictedIds = preds.map(p => p.user_id);
    const missedIds = memberIds.filter(id => !predictedIds.includes(id));

    const entry = match.entry_points;
    const losersTotal = losersPred.length + missedIds.length;
    const totalPot = losersTotal * entry;
    const perWinner = winnersPred.length > 0 ? totalPot / winnersPred.length : 0;
    const now = nowUtcISO();

    for (const uid of winnersPred)
      await db.run(
        'INSERT INTO points_ledger (user_id, match_id, series_id, points, reason, created_at) VALUES (?,?,?,?,?,?)',
        [uid, match.id, match.series_id, perWinner, `Win: ${match.name}`, now]
      );

    for (const uid of losersPred)
      await db.run(
        'INSERT INTO points_ledger (user_id, match_id, series_id, points, reason, created_at) VALUES (?,?,?,?,?,?)',
        [uid, match.id, match.series_id, -entry, `Loss: ${match.name}`, now]
      );

    for (const uid of missedIds)
      await db.run(
        'INSERT INTO points_ledger (user_id, match_id, series_id, points, reason, created_at) VALUES (?,?,?,?,?,?)',
        [uid, match.id, match.series_id, -entry, `Missed: ${match.name}`, now]
      );

    // ✅ Reload match for fresh status
    const updatedMatch = await db.get('SELECT status, winner FROM matches WHERE id = ?', [matchId]);

    return res.json({
      success: true,
      message: `${winner} declared successfully.`,
      status: updatedMatch.status,
      winner: updatedMatch.winner
    });

  } catch (err) {
    console.error('❌ Declare error:', err);
    return res.json({ success: false, error: err.message });
  }
});

import fs from 'fs';
import path from 'path';

// =========================
// DEBUG: Scan all source files for ".toLowerCase"
// =========================
router.get('/debug/scan-lowercase', async (req, res) => {
  const baseDir = path.resolve('./src');
  const results = [];

  function scanDir(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) scanDir(fullPath);
      else if (entry.name.endsWith('.js')) {
        const content = fs.readFileSync(fullPath, 'utf8');
        if (content.includes('toLowerCase')) {
          results.push({ file: fullPath, matches: (content.match(/toLowerCase/g) || []).length });
        }
      }
    }
  }

  scanDir(baseDir);
  res.json(results);
});


export default router;
