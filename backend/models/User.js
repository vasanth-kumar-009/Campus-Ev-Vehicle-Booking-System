const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true, select: false },
  // 'driver' is kept only so old documents stay valid; drivers live in the Driver collection.
  role: { type: String, enum: ['student', 'staff', 'admin', 'driver'], default: 'student' },
  deletionToken: { type: mongoose.Schema.Types.ObjectId, select: false },
  active: { type: Boolean, default: true },
  walletRequest: {
    type: new mongoose.Schema({
      amount: { type: Number, required: true, min: 1, max: 100000 },
      status: { type: String, enum: ['pending', 'approved', 'rejected'], required: true },
      requestedAt: { type: Date, required: true }, reviewedAt: Date,
      reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
    }), default: undefined
  },
  walletBalance: { type: Number, default: 0, min: 0 },

  // Defaults to true so accounts created before verification existed keep working.
  emailVerified: { type: Boolean, default: true },
  verifyTokenHash: { type: String, select: false },
  verifyTokenExpires: { type: Date, select: false },
  resetTokenHash: { type: String, select: false },
  resetTokenExpires: { type: Date, select: false },

  tokenVersion: { type: Number, default: 0, select: false },
  failedLogins: { type: Number, default: 0, select: false },
  lockUntil: { type: Date, select: false }
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);
