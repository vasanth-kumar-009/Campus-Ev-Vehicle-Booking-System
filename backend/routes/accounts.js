'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { Types } = require('mongoose');
const cfg = require('../config');
const { authenticate, adminOnly, clearSession } = require('../middleware/auth');
const { authLimiter } = require('../middleware/security');
const { HttpError, asyncHandler } = require('../utils/errors');
const v = require('../utils/validate');
const User = require('../models/User');
const Driver = require('../models/Driver');
const Vehicle = require('../models/Vehicle');
const Booking = require('../models/Booking');
const Notification = require('../models/Notification');

const router = express.Router();
const passengerRoles = ['student', 'staff'];

async function removeAccount(isDriver, filter) {
  const Model = isDriver ? Driver : User;
  const deletionToken = new Types.ObjectId();
  const attempt = { ...filter, deletionToken };
  // Mark first so a booking created concurrently can detect the closure.
  // A retry can take over an interrupted attempt.
  const account = await Model.findOneAndUpdate(filter, { $set: { deletionToken } });
  if (!account) throw new HttpError(404, 'Account no longer available');
  try {
    const participant = isDriver ? { driver: account._id } : { user: account._id };
    const outstanding = await Booking.exists({
      ...participant,
      $or: [
        { status: { $in: ['requested', 'accepted'] } },
        { status: 'completed', paymentStatus: { $in: ['pending', 'due'] } }
      ]
    });
    if (outstanding) {
      throw new HttpError(409, 'Resolve the open ride or outstanding ride payment before deleting this account.');
    }

    if (isDriver) await Vehicle.updateMany({ driver: account._id }, { $unset: { driver: 1 } });
    await Notification.deleteMany({ recipient: account._id, recipientType: isDriver ? 'driver' : 'user' });
    const result = await Model.deleteOne(attempt);
    if (!result.deletedCount) throw new HttpError(409, 'Account changed. Refresh and try again.');
  } catch (err) {
    await Model.updateOne({ _id: account._id, deletionToken }, { $unset: { deletionToken: 1 } });
    throw err;
  }
}

router.delete('/me', authenticate, authLimiter, asyncHandler(async (req, res) => {
  const { id, role, kind } = req.auth;
  const isDriver = role === 'driver';
  if (!isDriver && !passengerRoles.includes(role)) throw new HttpError(403, 'Self-deletion is available for passengers and drivers.');
  const Model = isDriver ? Driver : User;
  const filter = isDriver ? { _id: id } : { _id: id, role: { $in: passengerRoles } };
  const { password } = v.body(req);
  const account = await Model.findOne(filter).select('+password');
  if (!account || typeof password !== 'string' || !password || !(await bcrypt.compare(password, account.password))) {
    throw new HttpError(400, 'Enter your current password.');
  }
  await removeAccount(isDriver, { ...filter, password: account.password });
  clearSession(res, kind);
  res.json({ message: 'Your account was deleted.' });
}));

router.delete('/passengers/:id', adminOnly, asyncHandler(async (req, res) => {
  await removeAccount(false, { _id: v.objectId(req.params.id), role: { $in: passengerRoles } });
  res.json({ message: 'Passenger account deleted.' });
}));

router.delete('/drivers/:id', adminOnly, asyncHandler(async (req, res) => {
  await removeAccount(true, { _id: v.objectId(req.params.id) });
  res.json({ message: 'Driver account deleted.' });
}));

router.get('/admins', adminOnly, asyncHandler(async (req, res) => {
  const admins = await User.find({ role: 'admin' }).select('name email').sort({ name: 1, email: 1 });
  res.json(admins.map(({ _id, name, email }) => ({ _id, name, email })));
}));

router.post('/admins', adminOnly, asyncHandler(async (req, res) => {
  const b = v.body(req);
  const name = v.string(b.name, 'Name', { min: 2, max: 80 });
  const email = v.email(b.email);
  const password = v.password(b.password);
  if (await User.exists({ email })) throw new HttpError(409, 'This email already has a passenger or admin account.');
  const admin = await User.create({
    name, email, password: await bcrypt.hash(password, cfg.bcryptRounds), role: 'admin', emailVerified: true
  });
  res.status(201).json({ _id: admin._id, name: admin.name, email: admin.email });
}));

module.exports = router;
