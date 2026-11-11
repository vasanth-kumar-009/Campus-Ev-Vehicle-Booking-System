const mongoose = require('mongoose');

const point = { lat: { type: Number, required: true }, lng: { type: Number, required: true } };

const bookingSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  driver: { type: mongoose.Schema.Types.ObjectId, ref: 'Driver' },
  vehicle: { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle' },
  pickupName: { type: String, default: '', maxlength: 120 },
  dropName: { type: String, default: '', maxlength: 120 },
  pickupLocation: point,
  dropLocation: point,

  seats: { type: Number, default: 1, min: 1, max: 60 },
  vehicleType: { type: String, enum: ['any', 'auto', 'bus'], default: 'any' },

  // requested = searching for a driver, or offered to `driver` and awaiting their answer
  // 'rejected' is legacy: a driver's rejection now re-offers the ride to someone else.
  status: {
    type: String,
    enum: ['requested', 'accepted', 'completed', 'cancelled', 'expired', 'rejected'],
    default: 'requested'
  },
  declinedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Driver' }],
  offerExpiresAt: { type: Date },
  assignedAt: Date,
  acceptedAt: Date,
  completedAt: Date,
  cancelledAt: Date,
  cancelledBy: { type: String, enum: ['passenger', 'system'] },

  distanceKm: Number,
  etaMinutes: Number,
  fare: { type: Number, min: 0 },
  paymentMethod: { type: String, enum: ['cash', 'wallet', 'staff'], default: 'cash' },
  paymentStatus: { type: String, enum: ['pending', 'paid', 'due', 'waived'], default: 'pending' }
}, { timestamps: true });

bookingSchema.index({ user: 1, createdAt: -1 });
bookingSchema.index({ driver: 1, status: 1 });
bookingSchema.index({ status: 1, createdAt: 1 });

module.exports = mongoose.model('Booking', bookingSchema);
