// CHANGE PASSWORD (on login page)
router.post('/change-password', async (req, res) => {
  const { username, old_password, new_password } = req.body;

  if (!username || !old_password || !new_password) {
    return res.render('auth/login', {
      title: 'Login',
      error: 'All fields are required.',
      showChangePassword: true
    });
  }

  const db = await getDb();
  const user = await db.get('SELECT * FROM users WHERE username = ?', [username]);

  if (!user) {
    return res.render('auth/login', {
      title: 'Login',
      error: 'User not found.',
      showChangePassword: true
    });
  }

  const ok = await bcrypt.compare(old_password, user.password_hash);
  if (!ok) {
    return res.render('auth/login', {
      title: 'Login',
      error: 'Old password is incorrect.',
      showChangePassword: true
    });
  }

  // Hash new password
  const newHash = await bcrypt.hash(new_password, 10);

  await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, user.id]);

  return res.render('auth/login', {
    title: 'Login',
    success: 'Password changed successfully! You may now log in.',
    showLogin: true
  });
});
