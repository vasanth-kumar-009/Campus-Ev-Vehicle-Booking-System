const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  recipient: { type: mongoose.Schema.Types.ObjectId, required: true },
  recipientType: { type: String, enum: ['user', 'driver'], required: true },
  type: { type: String, required: true },
  message: { type: String, required: true },
  booking: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking' },
  read: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 7 } // auto-delete after 7 days
});

notificationSchema.index({ recipient: 1, recipientType: 1, read: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
