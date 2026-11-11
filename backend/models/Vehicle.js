const mongoose = require('mongoose');

const vehicleSchema = new mongoose.Schema({
  type: { type: String, enum: ['auto', 'bus'], default: 'auto' },
  plate: { type: String, required: true, unique: true, uppercase: true, trim: true },
  capacity: { type: Number, default: 3, min: 1, max: 60 },
  // Shared vehicles (buses) can carry several bookings at once, up to `capacity` seats.
  // Non-shared vehicles (autos) carry one booking at a time.
  shared: { type: Boolean, default: false },
  // Seats currently held by offered or accepted bookings. Changed only with atomic $inc.
  reservedSeats: { type: Number, default: 0, min: 0 },
  active: { type: Boolean, default: true },
  driver: { type: mongoose.Schema.Types.ObjectId, ref: 'Driver' }
}, { timestamps: true });

vehicleSchema.index({ driver: 1 });

module.exports = mongoose.model('Vehicle', vehicleSchema);
