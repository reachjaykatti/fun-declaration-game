
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

// ==============================
// 🧭 View Matches in a Series
// ==============================
router.get('/:id/matches', async (req, res) => {
  try {
    const db = await getDb();
    const seriesId = req.params.id;

    // 1️⃣ Fetch series info
    const series = await db.get('SELECT * FROM series WHERE id = ?', [seriesId]);
    if (!series) return res.status(404).send('Series not found');

    // 2️⃣ Fetch matches ordered by start time
    const matches = await db.all(
      'SELECT * FROM matches WHERE series_id = ? ORDER BY start_time_utc ASC',
      [seriesId]
    );

    const now = new Date();

    // 3️⃣ Enrich each match with computed data
    for (const m of matches) {
      // --- Compute cutoff ---
      const cutoffUtc = new Date(
        new Date(m.start_time_utc).getTime() - m.cutoff_minutes_before * 60000
      );

      // --- Compute time left ---
      const diffMs = cutoffUtc - now;
      if (diffMs <= 0) {
        m.locked = true;
        m.time_left = 'Closed';
      } else {
        m.locked = false;
        const hrs = Math.floor(diffMs / 3600000);
        const mins = Math.floor((diffMs % 3600000) / 60000);
        m.time_left = `${hrs}h ${mins}m left`;
      }

      // --- Convert IST times ---
      const startIST = new Date(m.start_time_utc).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
      const cutoffIST = new Date(cutoffUtc).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
      m.start_time_ist = startIST;
      m.cutoff_time_ist = cutoffIST;

      // --- User Prediction ---
      const pred = await db.get(
        'SELECT predicted_team FROM predictions WHERE match_id = ? AND user_id = ?',
        [m.id, req.session.user.id]
      );

      if (pred) {
        m.user_has_predicted = true;
        m.user_predicted_team = pred.predicted_team;
        m.user_predicted_name = pred.predicted_team === 'A' ? m.team_a : m.team_b;
      } else {
        m.user_has_predicted = false;
        m.user_predicted_team = null;
        m.user_predicted_name = null;
      }

      // --- Points (if completed) ---
      const ledger = await db.get(
        'SELECT SUM(points) AS total FROM points_ledger WHERE user_id = ? AND match_id = ?',
        [req.session.user.id, m.id]
      );
      m.user_points = ledger?.total ?? null;
    }

    // 4️⃣ Sort: upcoming first, then completed
    matches.sort((a, b) => {
      const order = { scheduled: 1, completed: 2, cancelled: 3 };
      const aOrder = order[a.status] || 99;
      const bOrder = order[b.status] || 99;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return new Date(a.start_time_utc) - new Date(b.start_time_utc);
    });

    // 5️⃣ Render
    return res.render('series/matches_list', {
      title: 'My Matches',
      series,
      matches
    });

  } catch (err) {
    console.error('❌ Error loading series matches:', err);
    res.status(500).send('Server Error');
  }
});

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

    res.redirect(`/series/${req.params.id}/matches`);
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
