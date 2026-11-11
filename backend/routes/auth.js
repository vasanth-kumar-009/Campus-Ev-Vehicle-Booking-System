'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const cfg = require('../config');
const log = require('../utils/logger');
const v = require('../utils/validate');
const { HttpError, asyncHandler } = require('../utils/errors');
const { makeToken, hashToken } = require('../utils/tokens');
const { sendMail } = require('../utils/mailer');
const serialize = require('../services/serialize');
const { issueSession, clearSession, authenticate, COOKIE_NAMES } = require('../middleware/auth');
const { authLimiter } = require('../middleware/security');
const User = require('../models/User');
const Driver = require('../models/Driver');
const Vehicle = require('../models/Vehicle');

const router = express.Router();
const DUMMY_HASH = bcrypt.hashSync('dummy-password-1', cfg.bcryptRounds); // keeps timing equal for unknown emails
const VERIFY_TTL = 24 * 60 * 60 * 1000;
const RESET_TTL = 60 * 60 * 1000;

const isDriverType = (t) => t === 'driver';
const modelFor = (t) => (isDriverType(t) ? Driver : User);
const typeOf = (raw) => v.oneOf(raw, ['driver', 'passenger', 'student', 'staff', 'user'], 'type');
const linkType = (t) => (isDriverType(t) ? 'driver' : 'user');

async function sendVerification(account, type) {
  const { token, hash, expires } = makeToken(VERIFY_TTL);
  account.verifyTokenHash = hash;
  account.verifyTokenExpires = expires;
  await account.save();
  const link = `${cfg.appUrl}/verify-email.html?type=${linkType(type)}&token=${token}`;
  return sendMail({ to: account.email, subject: 'Verify your Campus EV account', text: `Hi ${account.name},\n\nConfirm your email address:\n${link}\n\nThe link is valid for 24 hours.` });
}

/* ---------- register ---------- */
router.post('/register', authLimiter, asyncHandler(async (req, res) => {
  const b = v.body(req);
  const name = v.string(b.name, 'Name', { min: 2, max: 80 });
  const email = v.email(b.email);
  const password = v.password(b.password);
  const role = v.oneOf(b.role, ['student', 'staff', 'driver'], 'Role'); // admins can never self-register

  const Model = modelFor(role);
  if (await Model.exists({ email })) throw new HttpError(400, 'Email already registered');

  let vehicleInput;
  if (role === 'driver') {
    const type = v.oneOf(b.vehicleType, ['auto', 'bus'], 'Vehicle type', 'auto');
    vehicleInput = {
      type,
      plate: v.plate(b.plate),
      capacity: v.int(b.capacity, 'Seats', { min: 1, max: 60, def: type === 'bus' ? 20 : 3 }),
      shared: type === 'bus'
    };
    if (await Vehicle.exists({ plate: vehicleInput.plate })) throw new HttpError(400, 'That number plate is already registered');
  }

  const doc = {
    name, email,
    password: await bcrypt.hash(password, cfg.bcryptRounds),
    emailVerified: !cfg.requireEmailVerification
  };
  if (role !== 'driver') doc.role = role;

  let account;
  try {
    account = await Model.create(doc);
    if (role === 'driver') {
      const vehicle = await Vehicle.create({ ...vehicleInput, driver: account._id });
      account.activeVehicle = vehicle._id; // every driver gets a vehicle automatically
      await account.save();
    }
  } catch (err) {
    if (account && role === 'driver') await Driver.deleteOne({ _id: account._id }); // roll back
    if (err.code === 11000) throw new HttpError(400, 'Email or number plate already registered');
    throw err;
  }

  let emailSent = false;
  if (cfg.requireEmailVerification) {
    try { emailSent = await sendVerification(account, role); } catch (err) { log.error('Verification email failed:', err); }
  }
  res.status(201).json({
    message: cfg.requireEmailVerification
      ? (emailSent ? 'Registered. Check your email to verify your account.' : 'Registered, but the verification email could not be sent. Use "resend verification" on the login page.')
      : 'Registered successfully. You can log in now.',
    verificationRequired: cfg.requireEmailVerification
  });
}));

/* ---------- login / logout / me ---------- */
router.post('/login', authLimiter, asyncHandler(async (req, res) => {
  const b = v.body(req);
  const email = v.email(b.email);
  const type = typeOf(b.type); // only chooses WHERE to look; the role comes from the stored account
  if (typeof b.password !== 'string' || !b.password) throw new HttpError(400, 'Password is required');

  const Model = modelFor(type);
  const account = await Model.findOne({ email }).select('+password +failedLogins +lockUntil +tokenVersion');
  const invalid = new HttpError(400, 'Invalid login details');

  if (account && account.lockUntil && account.lockUntil > new Date()) {
    const mins = Math.ceil((account.lockUntil - Date.now()) / 60000);
    throw new HttpError(429, `Too many failed attempts. Try again in ${mins} minute(s).`);
  }

  const ok = await bcrypt.compare(b.password, account ? account.password : DUMMY_HASH);
  if (!account || !ok) {
    if (account) {
      const updated = await Model.findOneAndUpdate({ _id: account._id }, { $inc: { failedLogins: 1 } }, { new: true }).select('+failedLogins');
      if (updated.failedLogins >= cfg.maxFailedLogins) {
        await Model.updateOne({ _id: account._id }, { $set: { failedLogins: 0, lockUntil: new Date(Date.now() + cfg.lockMinutes * 60000) } });
      }
    }
    throw invalid;
  }
  if (account.active === false) throw new HttpError(403, 'This account has been disabled. Contact the administrator.');
  if (cfg.requireEmailVerification && account.emailVerified === false) {
    throw new HttpError(403, 'Please verify your email address first.', 'EMAIL_NOT_VERIFIED');
  }
  if (account.failedLogins || account.lockUntil) {
    await Model.updateOne({ _id: account._id }, { $set: { failedLogins: 0 }, $unset: { lockUntil: 1 } });
  }

  const role = isDriverType(type) ? 'driver' : account.role; // derived from the database
  issueSession(res, account, role);
  res.json({ user: serialize.profile(account, role) });
}));

router.post('/logout', (req, res) => {
  const kind = req.get('x-session');
  if (COOKIE_NAMES[kind]) clearSession(res, kind);
  res.json({ message: 'Logged out' });
});

// Invalidates every session of this account on every device.
router.post('/logout-all', authenticate, asyncHandler(async (req, res) => {
  const Model = req.auth.role === 'driver' ? Driver : User;
  await Model.updateOne({ _id: req.auth.id }, { $inc: { tokenVersion: 1 } });
  clearSession(res, req.auth.kind);
  res.json({ message: 'Logged out everywhere' });
}));

router.get('/me', authenticate, (req, res) => {
  res.json({ user: serialize.profile(req.auth.account, req.auth.role) });
});

router.post('/change-password', authLimiter, authenticate, asyncHandler(async (req, res) => {
  const b = v.body(req);
  const next = v.password(b.newPassword);
  const Model = req.auth.role === 'driver' ? Driver : User;
  const account = await Model.findById(req.auth.id).select('+password +tokenVersion');
  if (!(await bcrypt.compare(String(b.currentPassword || ''), account.password))) throw new HttpError(400, 'Current password is incorrect');
  account.password = await bcrypt.hash(next, cfg.bcryptRounds);
  account.tokenVersion = (account.tokenVersion || 0) + 1; // signs out all other sessions
  await account.save();
  issueSession(res, account, req.auth.role);
  res.json({ message: 'Password changed' });
}));

/* ---------- email verification ---------- */
router.post('/verify-email', authLimiter, asyncHandler(async (req, res) => {
  const b = v.body(req);
  const Model = modelFor(typeOf(b.type));
  const account = await Model.findOne({ verifyTokenHash: hashToken(v.string(b.token, 'Token', { max: 128 })), verifyTokenExpires: { $gt: new Date() } })
    .select('+verifyTokenHash +verifyTokenExpires');
  if (!account) throw new HttpError(400, 'This verification link is invalid or has expired');
  account.emailVerified = true;
  account.verifyTokenHash = undefined;
  account.verifyTokenExpires = undefined;
  await account.save();
  res.json({ message: 'Email verified. You can log in now.' });
}));

router.post('/resend-verification', authLimiter, asyncHandler(async (req, res) => {
  const b = v.body(req);
  const type = typeOf(b.type);
  const account = await modelFor(type).findOne({ email: v.email(b.email) });
  if (account && account.emailVerified === false) {
    try { await sendVerification(account, type); } catch (err) { log.error('Verification email failed:', err); }
  }
  res.json({ message: 'If that account exists and is not verified, a new email has been sent.' });
}));

/* ---------- password reset ---------- */
router.post('/forgot-password', authLimiter, asyncHandler(async (req, res) => {
  const b = v.body(req);
  const type = typeOf(b.type);
  const account = await modelFor(type).findOne({ email: v.email(b.email) });
  if (account && account.active !== false) {
    try {
      const { token, hash, expires } = makeToken(RESET_TTL);
      account.resetTokenHash = hash;
      account.resetTokenExpires = expires;
      await account.save();
      const link = `${cfg.appUrl}/reset-password.html?type=${linkType(type)}&token=${token}`;
      await sendMail({
        to: account.email,
        subject: 'Reset your Campus EV password',
        text: `Hi ${account.name},

We received a request to reset your Campus EV Booking password.

Open the link below to choose a new password and get back to your account.

${link}

This link is valid for 1 hour. If you didn’t request a password reset, you can ignore this email. Your password will stay the same.

Thanks,
Campus EV Support Team`
      });
    } catch (err) { log.error('Reset email failed:', err); }
  }
  res.json({ message: 'If that account exists, a reset link has been sent.' }); // same answer either way
}));

router.post('/reset-password', authLimiter, asyncHandler(async (req, res) => {
  const b = v.body(req);
  const Model = modelFor(typeOf(b.type));
  const password = v.password(b.password);
  const account = await Model.findOne({ resetTokenHash: hashToken(v.string(b.token, 'Token', { max: 128 })), resetTokenExpires: { $gt: new Date() } })
    .select('+resetTokenHash +resetTokenExpires +tokenVersion');
  if (!account) throw new HttpError(400, 'This reset link is invalid or has expired');
  account.password = await bcrypt.hash(password, cfg.bcryptRounds);
  account.resetTokenHash = undefined;
  account.resetTokenExpires = undefined;
  account.tokenVersion = (account.tokenVersion || 0) + 1; // old sessions stop working
  account.failedLogins = 0;
  account.lockUntil = undefined;
  await account.save();
  res.json({ message: 'Password updated. You can log in now.' });
}));

module.exports = router;
