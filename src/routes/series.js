
// src/routes/series.js  (FULL FILE REPLACEMENT)
import moment from 'moment-timezone';
import express from 'express';
import { getDb } from '../config/db.js';
import {
  hasDeadlinePassed,
  hasMatchStarted,
  nowUtcISO,
  cutoffTimeUtc,
  toIst,
} from '../utils/time.js';

const router = express.Router();

/* ---------------------------
   My Series (the ones user is in)
---------------------------- */
router.get('/', async (req, res) => {
  const db = await getDb();
  const seriesAllowed = await db.all(
    `
    SELECT s.* FROM series s
    JOIN series_members sm ON sm.series_id = s.id
    WHERE sm.user_id = ?
    ORDER BY s.start_date_utc DESC
    `,
    [req.session.user.id]
  );
  res.render('series/index', { title: 'My Series', series: seriesAllowed });
});

/* ---------------------------
   Redirect /series/:id -> /series/:id/matches
---------------------------- */
router.get('/:id', async (req, res) => {
  return res.redirect('/series/' + req.params.id + '/matches');
});

/* ---------------------------
   User: List Matches in a Series
   (IST time, time left, user prediction state, ADMIN declared flag)
---------------------------- */
router.get('/:id/matches', async (req, res) => {
  try {
    const db = await getDb();
    const seriesId = parseInt(req.params.id, 10);
    const userId = req.session.user.id;

    const series = await db.get('SELECT * FROM series WHERE id = ?', [seriesId]);
    if (!series) {
      return res.status(404).render('404', { title: 'Not Found' });
    }

    const matches = await db.all(
      'SELECT * FROM matches WHERE series_id = ? ORDER BY start_time_utc ASC',
      [seriesId]
    );

    // Load user's predictions for these matches
    let predByMatch = {};
    if (matches.length > 0) {
      const ids = matches.map(m => m.id).join(',');
      const preds = await db.all(
        'SELECT match_id, predicted_team FROM predictions WHERE user_id = ? AND match_id IN (' + ids + ')',
        [userId]
      );
      for (let i = 0; i < preds.length; i++) {
        const r = preds[i];
        predByMatch[r.match_id] = r.predicted_team; // 'A' or 'B'
      }
    }

    // --- ADMIN-AS-PLAYER declared flag -------------------------------------
    // Prefer series.created_by as the "Admin-as-player"; fallback to first is_admin=1
    let adminUserId = series && series.created_by ? series.created_by : null;
    if (!adminUserId) {
      const adm = await db.get('SELECT id FROM users WHERE is_admin = 1 ORDER BY id LIMIT 1');
      adminUserId = adm ? adm.id : null;
    }

    // Map of match_id => true if Admin declared
    let adminDeclaredMap = {};
    if (adminUserId && matches.length > 0) {
      const ids = matches.map(m => m.id).join(',');
      const aPreds = await db.all(
        'SELECT match_id FROM predictions WHERE user_id = ? AND match_id IN (' + ids + ')',
        [adminUserId]
      );
      for (let i = 0; i < aPreds.length; i++) {
        adminDeclaredMap[aPreds[i].match_id] = true;
      }
    }
    // -----------------------------------------------------------------------

    // Build derived rows for the view
    const rows = matches.map(function (m) {
      const startIstStr = toIst(m.start_time_utc).format('YYYY-MM-DD HH:mm');

      const cutoffIso = cutoffTimeUtc(m.start_time_utc, m.cutoff_minutes_before);
      const cutoffMillis = new Date(cutoffIso).getTime();
      const nowMillis = Date.now();

      let timeLeftLabel = '';
      let lockedForPrediction = hasDeadlinePassed(m.start_time_utc, m.cutoff_minutes_before) || (m.status !== 'scheduled');

      if (lockedForPrediction) {
        timeLeftLabel = 'Closed';
      } else {
        const msLeft = cutoffMillis - nowMillis;
        const minsTotal = Math.floor(msLeft / (60 * 1000));
        const hours = Math.floor(minsTotal / 60);
        const mins = minsTotal % 60;
        timeLeftLabel = (hours > 0 ? (hours + 'h ') : '') + mins + 'm left';
      }

      const userPredCode = predByMatch[m.id] ? predByMatch[m.id] : null; // 'A' or 'B'
      const userPredName =
        userPredCode === 'A' ? m.team_a :
        userPredCode === 'B' ? m.team_b : null;

      const userHasPredicted = !!userPredCode;

      return {
        id: m.id,
        name: m.name,
        sport: m.sport,
        team_a: m.team_a,
        team_b: m.team_b,
        entry_points: m.entry_points,
        status: m.status,
        start_time_ist: startIstStr,
        time_left: timeLeftLabel,
        locked: lockedForPrediction,
        user_predicted_code: userPredCode,
        user_predicted_name: userPredName,
        user_has_predicted: userHasPredicted,

        // NEW: show admin declared as green/red dot
        admin_declared: adminDeclaredMap[m.id] ? true : false
      };
    });
// 🧭 Sort matches: scheduled (nearest cutoff first), then completed (latest last)
matches.sort((a, b) => {
  const order = { scheduled: 1, completed: 2, cancelled: 3 };
  const aOrder = order[a.status] || 99;
  const bOrder = order[b.status] || 99;

  if (aOrder !== bOrder) return aOrder - bOrder;

  // Within same status, sort by start time
  return new Date(a.start_time_utc) - new Date(b.start_time_utc);
});

    // Include user-specific points per match (if available)
for (const m of matches) {
  const ledger = await db.get(
    'SELECT SUM(points) AS total FROM points_ledger WHERE user_id = ? AND match_id = ?',
    [req.session.user.id, m.id]
  );
  m.user_points = ledger?.total ?? null;
}
// ⏰ Compute time left for each match
for (const m of matches) {
  const start = new Date(m.start_time_utc);
  const cutoff = new Date(start.getTime() - (m.cutoff_minutes_before || 30) * 60000);
  const now = new Date();

  if (now >= cutoff) {
    m.locked = true;
    m.time_left = "Closed";
  } else {
    m.locked = false;
    const diff = cutoff - now;
    const hours = Math.floor(diff / 3600000);
    const mins = Math.floor((diff % 3600000) / 60000);
    m.time_left = `${hours}h ${mins}m left`;
  }
}

// Compute IST-friendly display and cutoff time
for (const m of matches) {
  // Convert UTC start time → IST formatted string
  if (m.start_time_utc) {
    const ist = moment.utc(m.start_time_utc).tz('Asia/Kolkata');
    m.start_time_ist = ist.format('YYYY-MM-DD HH:mm');

    const cutoff = ist.clone().subtract(m.cutoff_minutes_before || 30, 'minutes');
    m.cutoff_time_ist = cutoff.format('YYYY-MM-DD HH:mm');
  } else {
    m.start_time_ist = '-';
    m.cutoff_time_ist = '-';
  }
}

    return res.render('series/matches_list', {
      title: 'My Matches',
      series,
      matches
    });
  } catch (e) {
    console.error('Series list error:', e);
    return res.status(500).render('404', { title: 'Not Found' });
  }
});

/* ---------------------------
   Submit/Update Prediction
---------------------------- */
router.post('/:id/matches/:matchId/predict', async (req, res) => {
  try {
    const db = await getDb();

    // Fetch match details
    const match = await db.get(
      'SELECT * FROM matches WHERE id = ? AND series_id = ?',
      [req.params.matchId, req.params.id]
    );

    if (!match) return res.status(404).send('Match not found');

    const team = String(
      req.body.team !== undefined && req.body.team !== null ? req.body.team : ''
    ).trim(); // 'A' or 'B'

    if (!team) return res.status(400).send('Invalid team selection');

    // Deadline validation
    const deadlinePassed = hasDeadlinePassed(
      match.start_time_utc,
      match.cutoff_minutes_before
    );
    const lockedForPrediction = deadlinePassed || match.status !== 'scheduled';
    if (lockedForPrediction)
      return res.status(400).send('Prediction locked — cutoff passed.');

    // Ensure upsert (insert or update)
    const existing = await db.get(
      'SELECT * FROM predictions WHERE match_id = ? AND user_id = ?',
      [req.params.matchId, req.session.user.id]
    );

    const nowISO = nowUtcISO();

    if (existing) {
      await db.run(
        'UPDATE predictions SET predicted_team = ?, predicted_at_utc = ? WHERE match_id = ? AND user_id = ?',
        [team, nowISO, req.params.matchId, req.session.user.id]
      );
      console.log(
        `🔁 Updated prediction for user ${req.session.user.id} → ${team}`
      );
    } else {
      await db.run(
        'INSERT INTO predictions (match_id, user_id, predicted_team, predicted_at_utc) VALUES (?,?,?,?)',
        [req.params.matchId, req.session.user.id, team, nowISO]
      );
      console.log(
        `✅ New prediction saved for user ${req.session.user.id} → ${team}`
      );
    }

    res.redirect(`/series/${req.params.seriesId}/matches`);
  } catch (err) {
    console.error('❌ Prediction save error:', err);
    res.status(500).send('Server error while saving prediction');
  }
});

/* ---------------------------
   Match Detail (user)
---------------------------- */
router.get('/:id/matches/:matchId', async (req, res) => {
  const db = await getDb();

  // --- 1️⃣ Load match & series ---
  const match = await db.get(
    'SELECT * FROM matches WHERE id = ? AND series_id = ?',
    [req.params.matchId, req.params.id]
  );
  if (!match) return res.status(404).send('Match not found');

  const series = await db.get('SELECT * FROM series WHERE id = ?', [req.params.id]);
  if (!series) return res.status(404).send('Series not found');

  // --- 2️⃣ User’s own prediction ---
  const myPred = await db.get(
    'SELECT * FROM predictions WHERE match_id = ? AND user_id = ?',
    [req.params.matchId, req.session.user.id]
  );

  // --- 3️⃣ Time and cutoff logic ---
  const deadlinePassed = hasDeadlinePassed(match.start_time_utc, match.cutoff_minutes_before);
  const hasStartedByTime = hasMatchStarted(match.start_time_utc);
  const startedFlag = (match.status !== 'scheduled') || hasStartedByTime;
  const showAll = deadlinePassed || startedFlag;

  // --- 4️⃣ Load all predictions if needed ---
  let preds = [];
  if (showAll || match.status === 'completed') {
    preds = await db.all(
      'SELECT p.*, u.display_name FROM predictions p JOIN users u ON p.user_id = u.id WHERE match_id = ?',
      [req.params.matchId]
    );
  }

  // --- 5️⃣ Member count ---
  const membersCountRow = await db.get(
    'SELECT COUNT(*) as c FROM series_members WHERE series_id = ?',
    [req.params.id]
  );
  const membersCount =
    (membersCountRow && typeof membersCountRow.c === 'number')
      ? membersCountRow.c
      : 0;
// --- 🧭 Determine Missed Travellers ---
const members = await db.all('SELECT u.id, u.display_name FROM series_members sm JOIN users u ON sm.user_id = u.id WHERE sm.series_id = ?', [req.params.id]);
const votedIds = preds.map(p => p.user_id);
const missedTravellers = members.filter(m => !votedIds.includes(m.id));

  // --- 6️⃣ Probable outcome (only before declaration) ---
  let probable = null;
  let probableNames = null;
  if (showAll && match.status !== 'completed' && match.status !== 'washed_out') {
    const aSide = preds.filter(p => p.predicted_team === 'A');
    const bSide = preds.filter(p => p.predicted_team === 'B');
    const aCount = aSide.length;
    const bCount = bSide.length;
    const missed = Math.max(0, membersCount - preds.length);
    const entry = match.entry_points;

    const potIfA = (bCount + missed) * entry;
    const potIfB = (aCount + missed) * entry;

    probable = {
      A: {
        winners: aCount,
        losers: bCount + missed,
        perWinner: aCount ? (potIfA / aCount) : 0,
        totalPot: potIfA,
      },
      B: {
        winners: bCount,
        losers: aCount + missed,
        perWinner: bCount ? (potIfB / bCount) : 0,
        totalPot: potIfB,
      },
    };

    probableNames = {
      A: aSide.map(p => p.display_name).sort((x, y) => x.localeCompare(y)),
      B: bSide.map(p => p.display_name).sort((x, y) => x.localeCompare(y)),
    };
  }

  // --- 7️⃣ Declared names (AFTER declaration only) ---
  let declaredNames = null;
  if (match.status === 'completed' && preds.length > 0) {
    declaredNames = {
      winners: preds.filter(p => p.predicted_team === match.winner).map(p => p.display_name),
      losers: preds.filter(p => p.predicted_team !== match.winner).map(p => p.display_name),
    };
  }

  // --- 8️⃣ IST string for display ---
  const matchStartIstStr = toIst(match.start_time_utc).format('YYYY-MM-DD HH:mm');

  // --- 9️⃣ My final points (if completed) ---
  let myMatchPoints = null;
  if (match.status === 'completed') {
    const row = await db.get(
      'SELECT COALESCE(SUM(points),0) as pts FROM points_ledger WHERE user_id = ? AND match_id = ?',
      [req.session.user.id, match.id]
    );
    myMatchPoints = row ? row.pts : 0;
  }

  // --- 🔟 Render page ---
  res.render('series/match', {
    title: match.name,
    series,
    match: { ...match, startIstStr: matchStartIstStr },
    myPred,
    allPreds: preds,
    declaredNames,
    membersCount,
    probable,
    probableNames,
    deadlinePassed,
    startedFlag,
    showAll,
    myMatchPoints,
    missedTravellers,
  });
});

export default router;
