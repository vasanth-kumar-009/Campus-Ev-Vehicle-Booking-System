'use strict';
const express = require('express');
const v = require('../utils/validate');
const { asyncHandler } = require('../utils/errors');
const { authAny } = require('../middleware/auth');
const Notification = require('../models/Notification');

const router = express.Router();
router.use(authAny);

const scope = (req) => ({ recipient: req.auth.id, recipientType: req.auth.kind });

router.get('/', asyncHandler(async (req, res) => {
  const items = await Notification.find({ ...scope(req), read: false }).sort({ createdAt: 1 }).limit(20);
  res.json(items.map((n) => ({ _id: String(n._id), type: n.type, message: n.message, booking: n.booking ? String(n.booking) : null, createdAt: n.createdAt })));
}));

router.post('/read', asyncHandler(async (req, res) => {
  const ids = (v.body(req).ids || []);
  if (!Array.isArray(ids) || ids.length > 50) return res.status(400).json({ error: 'ids must be a list of up to 50 ids' });
  await Notification.updateMany({ ...scope(req), _id: { $in: ids.map((i) => v.objectId(i)) } }, { read: true });
  res.json({ message: 'ok' });
}));

module.exports = router;
