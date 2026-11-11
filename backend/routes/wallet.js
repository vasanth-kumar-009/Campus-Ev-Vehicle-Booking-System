'use strict';
const express = require('express');
const { Types } = require('mongoose');
const { studentOnly, adminOnly } = require('../middleware/auth');
const { HttpError, asyncHandler } = require('../utils/errors');
const v = require('../utils/validate');
const User = require('../models/User');

const router = express.Router();
const eligible = { role: 'student', active: { $ne: false }, deletionToken: null };

router.get('/me', studentOnly, (req, res) => {
  const student = req.auth.account;
  res.json({ balance: student.walletBalance || 0, request: student.walletRequest || null });
});

router.post('/requests', studentOnly, asyncHandler(async (req, res) => {
  const amount = v.int(v.body(req).amount, 'Amount', { min: 1, max: 100000 });
  const request = { _id: new Types.ObjectId(), amount, status: 'pending', requestedAt: new Date() };
  const student = await User.findOneAndUpdate(
    { ...eligible, _id: req.auth.id, 'walletRequest.status': { $ne: 'pending' } },
    { $set: { walletRequest: request } }, { new: true, runValidators: true }
  );
  if (!student) throw new HttpError(409, 'Refresh your wallet before sending another request.');
  res.status(201).json({ balance: student.walletBalance || 0, request: student.walletRequest });
}));

router.get('/requests', adminOnly, asyncHandler(async (req, res) => {
  const students = await User.find({ ...eligible, 'walletRequest.status': 'pending' })
    .select('name email walletRequest').sort({ 'walletRequest.requestedAt': 1 });
  res.json(students.map((s) => ({ name: s.name, email: s.email, request: s.walletRequest })));
}));

router.patch('/requests/:id', adminOnly, asyncHandler(async (req, res) => {
  const id = v.objectId(req.params.id);
  const status = v.oneOf(v.body(req).status, ['approved', 'rejected'], 'Decision');
  const pending = { ...eligible, 'walletRequest._id': id, 'walletRequest.status': 'pending' };
  const student = await User.findOne(pending).select('walletRequest');
  if (!student) throw new HttpError(409, 'This request is no longer pending.');
  const update = { $set: {
    'walletRequest.status': status, 'walletRequest.reviewedAt': new Date(), 'walletRequest.reviewedBy': req.auth.id
  } };
  if (status === 'approved') update.$inc = { walletBalance: student.walletRequest.amount };
  // The decision and credit change together. Only one reviewer can match a pending request.
  const result = await User.updateOne({ ...pending, _id: student._id }, update);
  if (!result.modifiedCount) throw new HttpError(409, 'This request is no longer pending.');
  res.json({ status });
}));

module.exports = router;
