import express from 'express';
import { getDb } from '../config/db.js';
import { ensureAuthenticated } from '../middleware/auth.js';

const router = express.Router();

// 🧮 Compute W/L streaks
function computeStreaks(seq) {
  let current = 0, currentType = null;
  let longestWin = 0, longestLoss = 0;

  for (const v of seq) {
    if (v === 'W') {
      if (currentType === 'W') current += 1;
      else { current = 1; currentType = 'W'; }
      longestWin = Math.max(longestWin, current);
    } else if (v === 'L') {
      if (currentType === 'L') current += 1;
      else { current = 1; currentType = 'L'; }
      longestLoss = Math.max(longestLoss, current);
    }
  }
  const currentStreak = current ? `${current}${currentType}` : '—';
  return { currentStreak, longestWin, longestLoss };
}

// -----------------------------------------
// 🏠 Dashboard Main Route
// -----------------------------------------
router.get('/', ensureAuthenticated, async (req, res) => {
  try {
    const db = await getDb();
    // 🧩 DEBUG — log how winners are stored
const winnerRows = await db.all(`
  SELECT id, team_a, team_b, winner, status
  FROM matches
  WHERE status = 'completed'
  LIMIT 5
`);
console.log("🏁 SAMPLE WINNER ROWS:", winnerRows);

    const userId = req.session.user.id;

    // =============================
    // ✅ SERIES FILTER HANDLING
    // =============================
    const rawSid = req.query.seriesId ? String(req.query.seriesId).trim() : '';
    const selectedSeriesId = rawSid && !isNaN(rawSid) ? parseInt(rawSid, 10) : null;
    const hasSeriesFilter = selectedSeriesId !== null;

    console.log("🧭 Dashboard filter check →", { rawSid, selectedSeriesId, hasSeriesFilter });

    // =============================
    // TOTAL POINTS (all time)
    // =============================
    const totalRow = await db.get(
      `SELECT COALESCE(SUM(points), 0) AS total_points FROM points_ledger WHERE user_id = ?`,
      [userId]
    );
    const totalPointsOverall = totalRow?.total_points || 0;

    // ✅ Per-series stats (corrected for A/B vs team name mapping)
// ✅ Per-series stats — supports winner stored as 'A'/'B' or team name
const stats = await db.all(`
  SELECT
    s.id AS series_id,
    s.name AS seriesName,

    -- ✅ Total travels completed (played)
    COUNT(DISTINCT CASE WHEN m.status = 'completed' THEN m.id END) AS planned,

    -- ✅ Planners (Wins): compare prediction vs actual winner correctly
    COUNT(DISTINCT CASE 
      WHEN m.status = 'completed'
       AND (
         (p.predicted_team = 'A' AND m.winner = m.team_a)
         OR
         (p.predicted_team = 'B' AND m.winner = m.team_b)
       )
      THEN m.id END
    ) AS planners,

    -- ✅ Not Interested (Loss or Missed)
    COUNT(DISTINCT CASE 
      WHEN m.status = 'completed'
       AND (
         p.predicted_team IS NULL
         OR
         (p.predicted_team = 'A' AND m.winner != m.team_a)
         OR
         (p.predicted_team = 'B' AND m.winner != m.team_b)
       )
      THEN m.id END
    ) AS notInterested,

    -- ✅ Planner % (Winning %)
    ROUND(
      100.0 * COUNT(DISTINCT CASE 
        WHEN m.status = 'completed'
         AND (
           (p.predicted_team = 'A' AND m.winner = m.team_a)
           OR
           (p.predicted_team = 'B' AND m.winner = m.team_b)
         )
        THEN m.id END
      ) / NULLIF(COUNT(DISTINCT CASE WHEN m.status = 'completed' THEN m.id END), 0),
    1) AS plannerPercent,

    -- ✅ Total points in that series
    COALESCE((
      SELECT SUM(points)
      FROM points_ledger pl
      WHERE pl.user_id = ? AND pl.series_id = s.id
    ), 0) AS seriesPoints

  FROM series s
  LEFT JOIN matches m ON m.series_id = s.id
  LEFT JOIN predictions p ON p.match_id = m.id AND p.user_id = ?
  GROUP BY s.id
  ORDER BY s.id DESC
`, [userId, userId]);

    console.log("📊 DASHBOARD STATS:", JSON.stringify(stats, null, 2));

    const seriesStats = stats || [];
    //const totalPointsOverall = seriesStats.reduce((sum, s) => sum + (s.seriesPoints || 0), 0);

    // ✅ Series name for filter
    const selectedSeriesName = hasSeriesFilter
      ? ((seriesStats.find(s => s.series_id === selectedSeriesId) || {}).seriesName || null)
      : null;

    // ✅ Leaderboard
    // ======================
// 🏆 LEADERBOARD FIX
// ======================
let leaderboard = [];

if (!hasSeriesFilter) {
  // 🌍 Global leaderboard
  leaderboard = await db.all(`
    SELECT 
      u.id AS user_id,
      u.display_name,
      COALESCE(SUM(pl.points), 0) AS points
    FROM users u
    LEFT JOIN points_ledger pl ON pl.user_id = u.id
    GROUP BY u.id
    ORDER BY points DESC
  `);
} else {
  // 🎯 Series-specific leaderboard (correct filtering)
  leaderboard = await db.all(`
    SELECT 
      u.id AS user_id,
      u.display_name,
      COALESCE(SUM(pl.points), 0) AS points
    FROM users u
    LEFT JOIN points_ledger pl ON pl.user_id = u.id
    WHERE pl.series_id = ?
    GROUP BY u.id
    ORDER BY points DESC
  `, [selectedSeriesId]);

  console.log("📊 Leaderboard filtered for series:", selectedSeriesId, leaderboard.length);
}
    // ✅ W/L streaks
    const wlRows = await db.all(`
      SELECT m.start_time_utc, m.status, m.winner, p.predicted_team
      FROM matches m
      JOIN predictions p ON p.match_id = m.id AND p.user_id = ?
      WHERE m.status = 'completed'
      ORDER BY m.start_time_utc ASC
    `, [userId]);
    const seq = wlRows.map(r => (r.predicted_team === r.winner ? 'W' : 'L'));
    const streaks = computeStreaks(seq);

    // ✅ Render EJS
    res.render('dashboard/index', {
  title: 'My Dashboard',
  totalPoints: totalPointsOverall || 0,
  seriesStats, // ✅ ensure this variable exists
  stats: seriesStats, // optional alias
  leaderboard,
  streaks,
  selectedSeriesId: hasSeriesFilter ? selectedSeriesId : null,
  selectedSeriesName,
  seriesUnsupported: false
});

  } catch (err) {
    console.error("🔴 Dashboard render failed:", err);
    if (!res.headersSent) {
      res.status(500).send("Dashboard rendering error.");
    }
  }
});

// -----------------------------------------
// 👤 Player Performance Dashboard
// -----------------------------------------
router.get('/player/:userId', ensureAuthenticated, async (req, res) => {
  try {
    const db = await getDb();
    const userId = parseInt(req.params.userId, 10);

    const user = await db.get('SELECT id, display_name FROM users WHERE id = ?', [userId]);
    if (!user) return res.status(404).render('404', { title: 'User Not Found' });

    const total = await db.get(`
      SELECT COALESCE(SUM(points), 0) AS totalPoints 
      FROM points_ledger 
      WHERE user_id = ?`,
      [userId]
    );

    const leaderboard = await db.all(`
      SELECT user_id, SUM(points) AS totalPoints
      FROM points_ledger
      GROUP BY user_id
      ORDER BY totalPoints DESC
    `);
    const rank = leaderboard.findIndex(u => u.user_id === userId) + 1;

    const perSeries = await db.all(`
      SELECT s.name AS series_name,
             COALESCE(SUM(pl.points), 0) AS total_points,
             COUNT(DISTINCT m.id) AS total_travels,
             COUNT(DISTINCT CASE WHEN p.user_id IS NOT NULL THEN m.id END) AS planned_travels
      FROM series s
      LEFT JOIN matches m ON m.series_id = s.id
      LEFT JOIN points_ledger pl ON pl.match_id = m.id AND pl.user_id = ?
      LEFT JOIN predictions p ON p.match_id = m.id AND p.user_id = ?
      GROUP BY s.id
      ORDER BY s.start_date_utc DESC
    `, [userId, userId]);

    const correct = await db.get(`
      SELECT COUNT(*) AS wins
      FROM predictions p
      JOIN matches m ON m.id = p.match_id
      WHERE p.user_id = ? AND p.predicted_team = m.winner
    `, [userId]);
    const totalPreds = await db.get(`SELECT COUNT(*) AS total FROM predictions WHERE user_id = ?`, [userId]);
    const accuracy = totalPreds.total ? ((correct.wins / totalPreds.total) * 100).toFixed(1) : 0;

    res.render('dashboard/player', {
      title: `${user.display_name} — Performance`,
      user,
      totalPoints: total?.totalPoints || 0,
      rank: rank || null,
      perSeries: perSeries || [],
      accuracy
    });

  } catch (e) {
    console.error('Player stats error:', e);
    res.status(500).render('404', { title: 'Error' });
  }
});
// =======================================
// 📊 Series Detail Page (Travel Breakdown)
// =======================================
router.get('/series/:seriesId', ensureAuthenticated, async (req, res) => {
  try {
    const db = await getDb();
    const userId = req.session.user.id;
    const seriesId = parseInt(req.params.seriesId, 10);

    // Fetch the series
    const series = await db.get(
      `SELECT id, name, description FROM series WHERE id = ?`,
      [seriesId]
    );
    if (!series) {
      return res.status(404).render('404', { title: 'Series Not Found' });
    }

    // Fetch all travels (matches) inside this series for this user
    const travels = await db.all(`
      SELECT 
        m.id AS match_id,
        m.name AS matchName,
        m.team_a AS teamA,
        m.team_b AS teamB,
        m.start_time_utc,
        m.status,
        COALESCE((
          SELECT SUM(points)
          FROM points_ledger pl
          WHERE pl.match_id = m.id AND pl.user_id = ?
        ), 0) AS travelPoints
      FROM matches m
      WHERE m.series_id = ?
      ORDER BY m.start_time_utc ASC
    `, [userId, seriesId]);

    // Compute cumulative total points
    let cumulative = 0;
    const travelsWithCumulative = travels.map((t) => {
      cumulative += t.travelPoints || 0;
      return { ...t, cumulativePoints: cumulative };
    });

    // Render breakdown page
    res.render('dashboard/series_detail', {
      title: `${series.name} — Travel Breakdown`,
      series,
      travels: travelsWithCumulative,
      totalPoints: cumulative
    });

  } catch (err) {
    console.error('🔴 Series detail error:', err);
    if (!res.headersSent) {
      res.status(500).render('404', { title: 'Error Loading Series Detail' });
    }
  }
});
export default router;
