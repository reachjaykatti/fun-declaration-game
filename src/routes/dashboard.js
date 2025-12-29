import express from 'express';
import { getDb } from '../config/db.js';
import { ensureAuthenticated } from "../middleware/auth.js";
const router = express.Router();
// Default placeholders for series filter
let selectedSeriesId = null;
let selectedSeriesName = '';

// compute streaks from an array of 'W'/'L' values
function computeStreaks(seq) {
  let current = 0, currentType = null;
  let longestWin = 0, longestLoss = 0;

  for (const v of seq) {
    if (v === 'W') {
      if (currentType === 'W') current += 1;
      else { current = 1; currentType = 'W'; }
      if (current > longestWin) longestWin = current;
    } else if (v === 'L') {
      if (currentType === 'L') current += 1;
      else { current = 1; currentType = 'L'; }
      if (current > longestLoss) longestLoss = current;
    }
  }
  const currentStreak = current ? (String(current) + currentType) : '—';
  return { currentStreak, longestWin, longestLoss };
}

router.get('/', async (req, res) => {
  const db = await getDb();
  const uid = req.session.user.id;

  // Helper: detect if points_ledger has a given column
  async function tableHasColumn(table, column) {
    const cols = await db.all(`PRAGMA table_info(${table});`);
    return cols.some(c => c.name === column);
  }

  // Read optional series filter from query string (e.g., /dashboard?seriesId=4)
  const rawSid = (req.query.seriesId || '').trim();
  const selectedSeriesId = rawSid ? parseInt(rawSid, 10) : NaN;
  const hasSeriesFilter = !Number.isNaN(selectedSeriesId);

  // ----- Total points (all-time for the logged-in user) -----
  const totalRow = await db.get(
    'SELECT COALESCE(SUM(points),0) as total_points FROM points_ledger WHERE user_id = ?',
    [uid]
  );
  /*const totalPoints = (totalRow && typeof totalRow.total_points === 'number')
    ? totalRow.total_points
    : 0;*/

  // ----- Per-series stats for the user (for the table and for the dropdown) -----
  const stats = await db.all(`
  SELECT 
    s.id AS series_id,
    s.name AS seriesName,
    COUNT(m.id) AS totalTravels,
    SUM(CASE WHEN p.predicted_team IS NOT NULL THEN 1 ELSE 0 END) AS planned,
    SUM(CASE WHEN p.predicted_team IS NULL THEN 1 ELSE 0 END) AS notInterested,
    ROUND(100.0 * SUM(CASE WHEN p.predicted_team IS NOT NULL THEN 1 ELSE 0 END) / COUNT(m.id), 1) AS plannerPercent,
    COALESCE(SUM(pl.points), 0) AS seriesPoints
  FROM series s
  LEFT JOIN matches m ON s.id = m.series_id
  LEFT JOIN predictions p ON m.id = p.match_id AND p.user_id = ?
  LEFT JOIN points_ledger pl ON pl.series_id = s.id AND pl.user_id = ?
  GROUP BY s.id
`, [req.session.user.id, req.session.user.id]);
  
const totalPoints = stats.reduce((sum, s) => sum + (s.seriesPoints || 0), 0);

const streaks = {
  currentStreak: 0,
  longestWin: 0,
  longestLoss: 0
};
const seriesStats = stats; // reuse same data for dropdown/filter support
// Default series filter placeholders (for template compatibility)
router.get('/', ensureAuthenticated, async (req, res) => {
  try {
  const db = await getDb();
  const userId = req.user.id;

  // ✅ 1. Total points for this specific user only
  const totalRow = await db.get(
    `SELECT COALESCE(SUM(points), 0) AS total_points 
     FROM points_ledger 
     WHERE user_id = ?`,
    [userId]
  );
  const totalPoints = totalRow?.total_points || 0;

  // ✅ 2. Per-series breakdown for this user
  const stats = await db.all(`
    SELECT 
      s.id AS series_id,
      s.name AS seriesName,
      COALESCE(SUM(pl.points), 0) AS seriesPoints,
      COUNT(m.id) AS totalTravels,
      SUM(CASE WHEN p.predicted_team IS NOT NULL THEN 1 ELSE 0 END) AS planned,
      SUM(CASE WHEN p.predicted_team IS NULL THEN 1 ELSE 0 END) AS notInterested,
      ROUND(
        100.0 * SUM(CASE WHEN p.predicted_team IS NOT NULL THEN 1 ELSE 0 END) / 
        NULLIF(COUNT(m.id), 0), 1  
      ) AS plannerPercent
    FROM series s
    LEFT JOIN matches m ON s.id = m.series_id
    LEFT JOIN predictions p ON m.id = p.match_id AND p.user_id = ?
    LEFT JOIN points_ledger pl ON pl.series_id = s.id AND pl.user_id = ?
    GROUP BY s.id
    ORDER BY s.id DESC
  `, [userId, userId]);

  // ✅ 3. Safe render
  const safeStats = stats || [];
  const streaks = { currentStreak: 0, longestWin: 0, longestLoss: 0 };
  const selectedSeriesId = null;
  const selectedSeriesName = null;
  res.render('dashboard/index', {
  title: 'My Dashboard',
  totalPoints: totalPoints || 0,
  stats: stats || [], // ✅ added safety
  seriesStats: stats || [], // ✅ alias for compatibility with dropdowns
  streaks: streaks || { currentStreak: 0, longestWin: 0, longestLoss: 0 },
  selectedSeriesId: selectedSeriesId || null,
  selectedSeriesName: selectedSeriesName || null
});


} catch (err) {
  console.error("🔴 Dashboard render failed:", err.message);
  console.error("Stack trace:", err.stack);

  if (!res.headersSent) {
    res.status(500).send("Dashboard rendering error. Check logs for details.");
  }
}
});
  // For heading when filtering
  const selectedSeriesName = hasSeriesFilter
    ? ((seriesStats.find(s => s.series_id === selectedSeriesId) || {}).name || null)
    : null;

 // ----- Leaderboard (global or series-wise) -----
let leaderboard = [];
let seriesUnsupported = false;

if (!hasSeriesFilter) {
  // 🌍 Global leaderboard
  leaderboard = await db.all(`
    SELECT u.display_name, COALESCE(SUM(pl.points), 0) AS points
    FROM users u
    LEFT JOIN points_ledger pl ON pl.user_id = u.id
    GROUP BY u.id
    ORDER BY points DESC
  `);

} else {
  // 🎯 Series-specific leaderboard via match linkage (always safe)
  leaderboard = await db.all(`
    SELECT u.display_name, COALESCE(SUM(pl.points), 0) AS points
    FROM users u
    LEFT JOIN points_ledger pl ON pl.user_id = u.id
    LEFT JOIN matches m ON m.id = pl.match_id
    WHERE m.series_id = ?
    GROUP BY u.id
    ORDER BY points DESC
  `, [selectedSeriesId]);
}

  // ----- W/L streaks for the current user (unchanged) -----
  const wlRows = await db.all(`
    SELECT m.start_time_utc, m.status, m.winner, p.predicted_team
    FROM matches m
    JOIN predictions p ON p.match_id = m.id AND p.user_id = ?
    WHERE m.status = 'completed'
    ORDER BY m.start_time_utc ASC
  `, [uid]);

  const seq = wlRows.map(r => (r.predicted_team === r.winner ? 'W' : 'L'));
  const { currentStreak, longestWin, longestLoss } = computeStreaks(seq);

  // Render with extra locals for the new filter
  res.render('dashboard/index', {
  title: 'Dashboard',
  totalPoints: totalPoints || 0,
  stats: seriesStats || [], // renamed for internal consistency
  seriesStats: seriesStats || [],
  leaderboard: leaderboard || [],
  streaks: streaks || { currentStreak, longestWin, longestLoss },
  // New locals for the series-wise leaderboard
  selectedSeriesId: hasSeriesFilter ? selectedSeriesId : null,
  selectedSeriesName: selectedSeriesName || null,
  seriesUnsupported: seriesUnsupported || false
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

    // Total points & ranking position
    const total = await db.get(`
      SELECT COALESCE(SUM(points), 0) as totalPoints FROM points_ledger WHERE user_id = ?
    `, [userId]);

    const leaderboard = await db.all(`
      SELECT user_id, SUM(points) AS totalPoints
      FROM points_ledger
      GROUP BY user_id
      ORDER BY totalPoints DESC
    `);
    const rank = leaderboard.findIndex(u => u.user_id === userId) + 1;

    // Per-Series stats
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

    // Win Accuracy
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
  accuracy: accuracy || { winRate: 0, lossRate: 0, totalMatches: 0 }
});

  } catch (e) {
    console.error('Player stats error:', e);
    res.status(500).render('404', { title: 'Error' });
  }
});
export default router;  
