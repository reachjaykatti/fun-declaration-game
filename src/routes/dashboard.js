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
    const userId = req.session.user.id;
    const rawSid = (req.query.seriesId || '').trim();
    const selectedSeriesId = rawSid ? parseInt(rawSid, 10) : NaN;
    const hasSeriesFilter = !Number.isNaN(selectedSeriesId);

    // ✅ Total points
    const totalRow = await db.get(
      `SELECT COALESCE(SUM(points), 0) AS total_points 
       FROM points_ledger 
       WHERE user_id = ?`,
      [userId]
    );
    const totalPoints = totalRow?.total_points || 0;

    // ✅ Per-series stats
    const stats = await db.all(`
      SELECT 
        s.id AS series_id,
        s.name AS seriesName,
        COUNT(m.id) AS totalTravels,
        SUM(CASE WHEN p.predicted_team IS NOT NULL THEN 1 ELSE 0 END) AS planned,
        SUM(CASE WHEN p.predicted_team IS NULL THEN 1 ELSE 0 END) AS notInterested,
        ROUND(
          100.0 * SUM(CASE WHEN p.predicted_team IS NOT NULL THEN 1 ELSE 0 END) /
          NULLIF(COUNT(m.id), 0), 1
        ) AS plannerPercent,
        COALESCE(SUM(pl.points), 0) AS seriesPoints
      FROM series s
      LEFT JOIN matches m ON s.id = m.series_id
      LEFT JOIN predictions p ON m.id = p.match_id AND p.user_id = ?
      LEFT JOIN points_ledger pl ON pl.series_id = s.id AND pl.user_id = ?
      GROUP BY s.id
      ORDER BY s.id DESC
    `, [userId, userId]);

    const seriesStats = stats || [];
    const totalPointsOverall = seriesStats.reduce((sum, s) => sum + (s.seriesPoints || 0), 0);

    // ✅ Series name for filter
    const selectedSeriesName = hasSeriesFilter
      ? ((seriesStats.find(s => s.series_id === selectedSeriesId) || {}).seriesName || null)
      : null;

    // ✅ Leaderboard
    let leaderboard = [];
    if (!hasSeriesFilter) {
      leaderboard = await db.all(`
        SELECT u.display_name, COALESCE(SUM(pl.points), 0) AS points
        FROM users u
        LEFT JOIN points_ledger pl ON pl.user_id = u.id
        GROUP BY u.id
        ORDER BY points DESC
      `);
    } else {
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
      stats: seriesStats,
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

export default router;
