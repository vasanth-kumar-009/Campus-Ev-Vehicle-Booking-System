const mongoose = require('mongoose');

// GeoJSON point used by the 2dsphere index. Stored only after the first location update.
const pointSchema = new mongoose.Schema({
  type: { type: String, enum: ['Point'], default: 'Point' },
  coordinates: { type: [Number], required: true } // [lng, lat]
}, { _id: false });

const driverSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true, select: false },
  deletionToken: { type: mongoose.Schema.Types.ObjectId, select: false },
  active: { type: Boolean, default: true },
  status: { type: String, enum: ['offline', 'online'], default: 'offline' },

  location: {
    lat: { type: Number, default: 0 },
    lng: { type: Number, default: 0 }
  },
  geo: { type: pointSchema, default: undefined },
  locationUpdatedAt: { type: Date },

  activeVehicle: { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle' },

  emailVerified: { type: Boolean, default: true },
  verifyTokenHash: { type: String, select: false },
  verifyTokenExpires: { type: Date, select: false },
  resetTokenHash: { type: String, select: false },
  resetTokenExpires: { type: Date, select: false },

  tokenVersion: { type: Number, default: 0, select: false },
  failedLogins: { type: Number, default: 0, select: false },
  lockUntil: { type: Date, select: false }
}, { timestamps: true });

driverSchema.index({ geo: '2dsphere' });
driverSchema.index({ status: 1 });

module.exports = mongoose.model('Driver', driverSchema);
