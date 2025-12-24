import express from 'express';
import bcrypt from 'bcrypt';
import moment from 'moment-timezone';
import multer from 'multer';
import { getDb } from '../config/db.js';
import { ensureAdmin } from '../middleware/auth.js';
import { nowUtcISO } from '../utils/time.js';

// Multer for CSV/TSV uploads (kept in memory)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 } // 2 MB
});

const router = express.Router();
router.use(ensureAdmin);

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
router.post('/series/:id/delete', async (req, res) => {
  const db = await getDb();
  const sid = req.params.id;
  try {
    await db.run('DELETE FROM points_ledger WHERE series_id = ?', [sid]);
    await db.run('DELETE FROM series WHERE id = ?', [sid]); // cascades to matches & members
    res.redirect('/admin');
  } catch (e) {
    res.status(500).send('Failed to delete series: ' + e.message);
  }
});

// Matches: manage/create/edit

// === Admin: Manage Matches (series-wise) with IST/Cutoff + Admin declared dot ===
router.get('/series/:id/matches', async (req, res) => {
  const db = await getDb();
  const series = await db.get('SELECT * FROM series WHERE id = ?', [req.params.id]);
  const rawMatches = await db.all('SELECT * FROM matches WHERE series_id = ? ORDER BY start_time_utc ASC', [req.params.id]);

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

  const matches = rawMatches.map(function (m) {
    // Start (IST) — use imported moment, not require(...)
    const startIstStr = moment.tz(m.start_time_utc, 'UTC').tz('Asia/Kolkata').format('YYYY-MM-DD HH:mm');

    // Cutoff IST (start - cutoff)
    const cutoffMinutes = (typeof m.cutoff_minutes_before === 'number' && !isNaN(m.cutoff_minutes_before)) ? m.cutoff_minutes_before : 30;
    const startMillis   = new Date(m.start_time_utc).getTime();
    const cutoffMillis  = startMillis - cutoffMinutes * 60 * 1000;
    const cutoffIstStr  = moment.tz(cutoffMillis, 'UTC').tz('Asia/Kolkata').format('YYYY-MM-DD HH:mm');

    // Time left label
    let timeLeftLabel = '';
    if (nowMillis >= cutoffMillis) {
      timeLeftLabel = 'Cutoff closed';
    } else {
      const msLeft   = cutoffMillis - nowMillis;
      const minsTotal = Math.floor(msLeft / (60 * 1000));
      const hours     = Math.floor(minsTotal / 60);
      const mins      = minsTotal % 60;
      timeLeftLabel   = (hours > 0 ? (hours + 'h ') : '') + mins + 'm left';
    }

    return {
      ...m,
      startIstStr,
      cutoffIstStr,
      timeLeftLabel,
      adminDeclared: adminDeclaredMap[m.id] ? true : false
    };
  });

  res.render('admin/matches_manage', {
    title: `Manage Matches - ${series.name}`,
    series,
    matches
  });
});

router.get('/series/:id/matches/new', async (req, res) => {
  const db = await getDb();
  const series = await db.get('SELECT * FROM series WHERE id = ?', [req.params.id]);
  res.render('admin/match_new', { title: 'New Match', series });
});
router.post('/series/:id/matches/new', async (req, res) => {
  const { name, sport, team_a, team_b, start_time_ist, start_time_utc, cutoff_minutes_before, entry_points } = req.body;
  const db = await getDb();

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
router.get('/matches/:matchId/edit', async (req, res) => {
  const db = await getDb();
  const match = await db.get('SELECT * FROM matches WHERE id = ?', [req.params.matchId]);
  const series = await db.get('SELECT * FROM series WHERE id = ?', [match.series_id]);
  res.render('admin/match_edit', { title: 'Edit Match', match, series });
});
router.post('/matches/:matchId/edit', async (req, res) => {
  const db = await getDb();
  const { name, sport, team_a, team_b, start_time_ist, start_time_utc, cutoff_minutes_before, entry_points, status } = req.body;

  let startUtc = start_time_utc && start_time_utc.trim() ? start_time_utc.trim() : '';
  if (!startUtc && start_time_ist && start_time_ist.trim()) {
    const istVal = start_time_ist.trim();
    let m = moment.tz(istVal, 'YYYY-MM-DD HH:mm', 'Asia/Kolkata', true);
    if (!m.isValid()) m = moment.tz(istVal, 'DD-MM-YYYY HH:mm', 'Asia/Kolkata', true);
    if (!m.isValid()) return res.status(400).send('Invalid IST format. Use YYYY-MM-DD HH:mm or DD-MM-YYYY HH:mm');
    startUtc = m.utc().toISOString();
  }
  if (!startUtc) return res.status(400).send('Start time required (IST or UTC)');

  await db.run('UPDATE matches SET name=?, sport=?, team_a=?, team_b=?, start_time_utc=?, cutoff_minutes_before=?, entry_points=?, status=? WHERE id=?',
    [name, sport, team_a, team_b, startUtc, cutoff_minutes_before, entry_points, status, req.params.matchId]);
  const match = await db.get('SELECT * FROM matches WHERE id = ?', [req.params.matchId]);
  res.redirect(`/admin/series/${match.series_id}/matches`);
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
// BULK IMPORT – PAGE
// =========================
router.get('/series/:id/matches/bulk', async (req, res) => {
  const db = await getDb();
  const series = await db.get('SELECT * FROM series WHERE id = ?', [req.params.id]);
  if (!series) return res.status(404).render('404', { title: 'Not Found' });

  res.render('admin/matches_bulk', {
    title: 'Bulk Import Matches',
    series,
    result: null
  });
});

// =========================
// BULK IMPORT – TEMPLATE (TSV)
// =========================
router.get('/series/:id/matches/bulk/template', (req, res) => {
  const rows = [
    'name\tsport\tteam_a\tteam_b\tstart_time_ist\tcutoff_minutes_before\tentry_points',
    'Travel01\tTrain\tPuducherry\tTamilnadu\t24-12-2025 09:00\t30\t50'
  ];
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="matches_template.tsv"');
  res.send(rows.join('\n'));
});

// =========================
// BULK IMPORT – SUBMIT (TSV ONLY)
// =========================
router.post('/series/:id/matches/bulk', upload.single('file'), async (req, res) => {
  const db = await getDb();
  const series = await db.get('SELECT * FROM series WHERE id = ?', [req.params.id]);

  const raw =
    (req.file && req.file.buffer && req.file.buffer.toString('utf8')) ||
    (req.body.text || '');

  const lines = raw
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

  let ok = 0, skipped = 0, errors = [];

  for (let i = 0; i < lines.length; i++) {
    try {
      const cols = lines[i].split('\t').map(c => c.trim());
      if (cols.length < 7) {
        skipped++;
        errors.push(`Line ${i + 1}: Expected 7 columns`);
        continue;
      }

      const [name, sport, team_a, team_b, ist, cutoff, entry] = cols;

      const m = moment.tz(ist, ['YYYY-MM-DD HH:mm', 'DD-MM-YYYY HH:mm'], 'Asia/Kolkata', true);
      if (!m.isValid()) {
        skipped++;
        errors.push(`Line ${i + 1}: Invalid IST time`);
        continue;
      }

      await db.run(
        `INSERT INTO matches
         (series_id, name, sport, team_a, team_b, start_time_utc, cutoff_minutes_before, entry_points, status)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [
          req.params.id,
          name,
          sport || 'travel',
          team_a,
          team_b,
          m.utc().toISOString(),
          parseInt(cutoff || '30', 10),
          parseFloat(entry || '50'),
          'scheduled'
        ]
      );

      ok++;
    } catch (e) {
      skipped++;
      errors.push(`Line ${i + 1}: ${e.message}`);
    }
  });

  res.render('admin/matches_bulk', {
    title: 'Bulk Import Matches',
    series,
    result: { ok, skipped, errors }
  });
});

export default router;

  } catch (e) {
    console.error('Bulk POST error:', e);
    return res.status(500).render('404', { title: 'Not Found', message: 'Bulk import failed to load.' });
  }
});


// Robust CSV/TSV parser: coerces ALL values to strings safely (no ?? operator)
// === CSV / TSV Parser – Safe String Conversion ===
// === CSV / TSV Parser – Safe String Conversion (no ?? operators) ===
function parseBulk(text) {
  const lines = String(text || '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

  if (lines.length === 0) return [];

  // detect delimiter
  const delim =
    lines[0].includes('\t') ? '\t' :
    lines[0].includes(',')  ? ','  : '\t';

  // drop header if detected
  const first = lines[0].toLowerCase();
  const hasHeader = first.includes('start_time');

  const dataLines = hasHeader ? lines.slice(1) : lines;

  return dataLines.map((line, idx) => {
    const cols = line.split(delim).map(c => c.trim());
    return {
      __line: idx + 2,
      name: cols[0],
      sport: cols[1],
      team_a: cols[2],
      team_b: cols[3],
      start_time_ist: cols[4],
      cutoff_minutes_before: cols[5],
      entry_points: cols[6]
    };
  });
}


// Admin match view / reset / declare
router.get('/matches/:matchId', async (req, res) => {
  const db = await getDb();

  const match = await db.get('SELECT * FROM matches WHERE id = ?', [req.params.matchId]);
  if (!match) {
    return res.status(404).render('404', { title: 'Not Found' });
  }

  const series = await db.get('SELECT * FROM series WHERE id = ?', [match.series_id]);

  const preds = await db.all(
    `SELECT p.*, u.display_name
       FROM predictions p
       JOIN users u ON p.user_id = u.id
      WHERE p.match_id = ?`,
    [req.params.matchId]
  );

  const row = await db.get('SELECT COUNT(*) AS c FROM series_members WHERE series_id = ?', [match.series_id]);
  const membersCount = (row && typeof row.c === 'number') ? row.c : 0;

  const aCount = preds.filter(p => p.predicted_team === 'A').length;
  const bCount = preds.filter(p => p.predicted_team === 'B').length;
  const missed = Math.max(0, membersCount - (aCount + bCount));

  const entry = match.entry_points || 0;

  // Determine cutoff status
  const cutoffMins = match.cutoff_minutes_before || 30;
  const cutoffTime = moment.utc(match.start_time_utc).subtract(cutoffMins, 'minutes');
  const isCutoffOver = moment.utc().isAfter(cutoffTime);

  // 💡 Distinct pot and perPlanner calculations
  const probable = {
    A: {
      winners: aCount,
      losers: bCount + missed,
      totalPot: (bCount + missed ) * entry, // full pot size
      perPlanner: aCount > 0 ? ((bCount + missed ) * entry) / aCount : 0
    },
    B: {
      winners: bCount,
      losers: aCount + missed,
      totalPot: (aCount + missed ) * entry,
      perPlanner: bCount > 0 ? ((aCount + missed ) * entry) / bCount : 0
    }
  };

  res.render('admin/match_detail', {
    title: 'Travel Admin',
    match,
    series,
    preds,
    membersCountVal: membersCount,
    aCount,
    bCount,
    missed,
    probable,
    isCutoffOver,
    labels: req.app.locals.labels || {}
  });
});

router.post('/matches/:matchId/reset-ledger', async (req, res) => {
  const db = await getDb();
  const matchId = req.params.matchId;
  try {
    await db.run('DELETE FROM points_ledger WHERE match_id = ?', [matchId]);
    await db.run('UPDATE matches SET status = ?, winner = NULL, admin_declared_at = NULL WHERE id = ?', ['scheduled', matchId]);
    res.redirect(`/admin/matches/${matchId}`);
  } catch (e) {
    res.status(500).send('Failed to reset match: ' + e.message);
  }
});

router.post('/matches/:matchId/declare', async (req, res) => {
  const { winner, washed_out } = req.body;
  const db = await getDb();
  const match = await db.get('SELECT * FROM matches WHERE id = ?', [req.params.matchId]);
  const seriesId = match.series_id;

  if (match.status === 'completed' || match.status === 'washed_out') {
    return res.redirect(`/admin/matches/${req.params.matchId}`);
  }

  if (washed_out) {
    await db.run('UPDATE matches SET status = ?, winner = NULL, admin_declared_at = ? WHERE id = ?',
      ['washed_out', nowUtcISO(), req.params.matchId]);
    return res.redirect(`/admin/matches/${req.params.matchId}`);
  }

  await db.run('UPDATE matches SET status = ?, winner = ?, admin_declared_at = ? WHERE id = ?',
    ['completed', winner, nowUtcISO(), req.params.matchId]);

  const preds = await db.all('SELECT * FROM predictions WHERE match_id = ?', [req.params.matchId]);
  const winnersPred = preds.filter(p => p.predicted_team === winner).map(p => p.user_id);
  const losersPred = preds.filter(p => p.predicted_team !== winner).map(p => p.user_id);

  const membersRows = await db.all('SELECT user_id FROM series_members WHERE series_id = ?', [seriesId]);
  const memberIds = membersRows.map(r => r.user_id);
  const predictedIds = preds.map(p => p.user_id);
  const missedIds = memberIds.filter(id => predictedIds.indexOf(id) === -1);

  const entryPoints = match.entry_points;
  const losersTotal = losersPred.length + missedIds.length;
  const totalPot = losersTotal * entryPoints;
  const perWinner = winnersPred.length > 0 ? totalPot / winnersPred.length : 0;
  const now = nowUtcISO();

  for (const uid of winnersPred) {
    await db.run('INSERT INTO points_ledger (user_id, match_id, series_id, points, reason, created_at) VALUES (?,?,?,?,?,?)',
      [uid, match.id, seriesId, perWinner, `Win: ${match.name}`, now]);
  }
  for (const uid of losersPred) {
    await db.run('INSERT INTO points_ledger (user_id, match_id, series_id, points, reason, created_at) VALUES (?,?,?,?,?,?)',
      [uid, match.id, seriesId, -entryPoints, `Loss: ${match.name}`, now]);
  }
  for (const uid of missedIds) {
    await db.run('INSERT INTO points_ledger (user_id, match_id, series_id, points, reason, created_at) VALUES (?,?,?,?,?,?)',
      [uid, match.id, seriesId, -entryPoints, `Missed: ${match.name}`, now]);
  }

  res.redirect(`/admin/matches/${req.params.matchId}`);
});

export default router;

