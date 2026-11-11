'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const cfg = require('../config');
const { issueSession } = require('../middleware/auth');
const { authLimiter } = require('../middleware/security');
const { HttpError, asyncHandler } = require('../utils/errors');
const { email: normalizeEmail, body, oneOf } = require('../utils/validate');
const { profile } = require('../services/serialize');
const User = require('../models/User');
const Driver = require('../models/Driver');

const router = express.Router();
const dummyHash = bcrypt.hashSync('unused-login-timing-hash', cfg.bcryptRounds);
const accountFields = '+password +failedLogins +lockUntil +tokenVersion';
const locked = (a) => a && a.lockUntil && a.lockUntil > new Date();

async function recordFailure(Model, account) {
  if (!account || locked(account)) return;
  const updated = await Model.findOneAndUpdate({ _id: account._id },
    { $inc: { failedLogins: 1 } }, { new: true }).select('+failedLogins');
  if (updated && updated.failedLogins >= cfg.maxFailedLogins) {
    await Model.updateOne({ _id: account._id }, {
      $set: { failedLogins: 0, lockUntil: new Date(Date.now() + cfg.lockMinutes * 60000) }
    });
  }
}

// Older installations can have the same email in both account collections.
router.post('/', authLimiter, asyncHandler(async (req, res) => {
  const data = body(req);
  const email = normalizeEmail(data.email);
  if (typeof data.password !== 'string' || !data.password) throw new HttpError(400, 'Password is required');
  const selectedRole = data.role === undefined ? null : oneOf(data.role, ['student', 'staff', 'driver', 'admin'], 'Role');
  const models = selectedRole ? [selectedRole === 'driver' ? Driver : User] : [User, Driver];
  const candidates = await Promise.all(models.map(async (Model) => {
    const filter = { email };
    if (selectedRole && Model === User) filter.role = selectedRole;
    const account = await Model.findOne(filter).select(accountFields);
    const matches = await bcrypt.compare(data.password, account ? account.password : dummyHash);
    return { Model, account, matches: !!account && matches };
  }));
  const matches = candidates.filter((c) => c.matches);
  if (!matches.length) {
    await Promise.all(candidates.map((c) => recordFailure(c.Model, c.account)));
    throw new HttpError(400, selectedRole ? 'Check your email, password, and selected role.' : 'Invalid login details');
  }
  if (matches.length > 1) {
    throw new HttpError(409, 'Two accounts share these login details. Select your role through Book a ride to log in.');
  }
  const { Model, account } = matches[0];
  if (locked(account)) throw new HttpError(429, 'Too many failed attempts. Try again after the account lock expires.');
  if (account.active === false) throw new HttpError(403, 'This account has been disabled. Contact the administrator.');
  const role = Model === Driver ? 'driver' : account.role;
  if (cfg.requireEmailVerification && account.emailVerified === false) {
    return res.status(403).json({ error: 'Please verify your email address first.', code: 'EMAIL_NOT_VERIFIED', verificationType: Model === Driver ? 'driver' : 'user' });
  }
  if (account.failedLogins || account.lockUntil) {
    await Model.updateOne({ _id: account._id }, { $set: { failedLogins: 0 }, $unset: { lockUntil: 1 } });
  }
  issueSession(res, account, role);
  res.json({ user: profile(account, role) });
}));

module.exports = router;
