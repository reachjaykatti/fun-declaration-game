import express from 'express';
import bcrypt from 'bcrypt';
import { getDb } from '../config/db.js';
import { ensureAuthenticated } from '../middleware/auth.js';

const router = express.Router();

// Show profile page
router.get('/profile', ensureAuthenticated, (req, res) => {
  res.render('profile', {
    title: 'My Profile',
    user: req.session.user
  });
});

// Update display name
router.post('/profile/display-name', ensureAuthenticated, async (req, res) => {
  const { display_name } = req.body;
  if (!display_name || display_name.trim().length < 3) {
    return res.render('profile', {
      title: 'My Profile',
      user: req.session.user,
      error: 'Display name must be at least 3 characters'
    });
  }

  const db = await getDb();
  await db.run(
    'UPDATE users SET display_name = ? WHERE id = ?',
    [display_name.trim(), req.session.user.id]
  );

  // Update session
  req.session.user.display_name = display_name.trim();

  res.render('profile', {
    title: 'My Profile',
    user: req.session.user,
    success: 'Display name updated successfully'
  });
});

// Change password
router.post('/profile/change-password', ensureAuthenticated, async (req, res) => {
  const { current_password, new_password } = req.body;

  if (!new_password || new_password.length < 6) {
    return res.render('profile', {
      title: 'My Profile',
      user: req.session.user,
      error: 'New password must be at least 6 characters'
    });
  }

  const db = await getDb();
  const user = await db.get(
    'SELECT password_hash FROM users WHERE id = ?',
    [req.session.user.id]
  );

  const ok = await bcrypt.compare(current_password, user.password_hash);
  if (!ok) {
    return res.render('profile', {
      title: 'My Profile',
      user: req.session.user,
      error: 'Current password is incorrect'
    });
  }

  const hash = await bcrypt.hash(new_password, 10);
  await db.run(
    'UPDATE users SET password_hash = ? WHERE id = ?',
    [hash, req.session.user.id]
  );

  res.render('profile', {
    title: 'My Profile',
    user: req.session.user,
    success: 'Password changed successfully'
  });
});
module.exports = router;
