const express = require('express');
const { requireAuth } = require('../auth');
const { ah } = require('../utils');
const { changePassword } = require('../../portal/auth');

const router = express.Router();

router.get('/me', requireAuth, (req, res) => {
  const { id, username, full_name, role, docTypes } = req.user;
  res.json({ user: { id, username, full_name, role, docTypes } });
});

router.post('/change-password', requireAuth, ah(async (req, res) => {
  await changePassword(req.user.id, req.body.current_password, req.body.new_password);
  res.json({ ok: true });
}));

module.exports = router;
