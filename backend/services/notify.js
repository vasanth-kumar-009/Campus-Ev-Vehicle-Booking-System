'use strict';
const Notification = require('../models/Notification');
const log = require('../utils/logger');

/** In-app notification. Never throws: a failed notification must not break a booking. */
async function notify(recipientType, recipient, type, message, booking) {
  if (!recipient) return;
  try {
    await Notification.create({ recipientType, recipient, type, message, booking });
  } catch (err) {
    log.warn('Notification failed:', err.message);
  }
}

module.exports = { notify };
