'use strict';
const bcrypt = require('bcryptjs');
const cfg = require('../config');
const log = require('../utils/logger');
const validate = require('../utils/validate');
const User = require('../models/User');
const Driver = require('../models/Driver');
const Vehicle = require('../models/Vehicle');
const Booking = require('../models/Booking');
const Notification = require('../models/Notification');
const { toGeoPoint } = require('../utils/geo');

/** Build indexes before serving traffic (2dsphere is required for dispatch). */
async function ensureIndexes() {
  for (const m of [User, Driver, Vehicle, Booking, Notification]) {
    try { await m.init(); } catch (err) { log.error(`Index build failed for ${m.modelName}:`, err.message); }
  }
  // At most one open booking per passenger, enforced by the database (prevents double-click duplicates).
  try {
    await Booking.collection.createIndex(
      { user: 1 },
      { unique: true, name: 'one_open_booking_per_user', partialFilterExpression: { status: { $in: ['requested', 'accepted'] } } }
    );
  } catch (err) {
    log.warn('Could not create one-open-booking index (existing duplicate open bookings?):', err.message);
  }
}

/** Bring documents created by older versions up to the current schema. Safe to run repeatedly. */
async function migrateLegacy() {
  await Vehicle.updateMany({ type: 'bus', capacity: { $exists: false } }, { $set: { capacity: 20 } });
  await Vehicle.updateMany({ capacity: { $exists: false } }, { $set: { capacity: 3 } });
  await Vehicle.updateMany({ type: 'bus', shared: { $exists: false } }, { $set: { shared: true } });
  await Vehicle.updateMany({ shared: { $exists: false } }, { $set: { shared: false } });
  await Vehicle.updateMany({ active: { $exists: false } }, { $set: { active: true } });
  await Booking.updateMany({ seats: { $exists: false } }, { $set: { seats: 1 } });
  await Booking.updateMany(
    { status: 'requested', driver: { $ne: null }, offerExpiresAt: { $exists: false } },
    { $set: { offerExpiresAt: new Date(Date.now() + cfg.offerTimeoutMs) } }
  );
  // Old drivers that have a stored position but no GeoJSON point yet.
  const drivers = await Driver.find({ geo: { $exists: false }, 'location.lat': { $ne: 0 } }).select('location');
  for (const d of drivers) {
    await Driver.updateOne({ _id: d._id }, { $set: { geo: toGeoPoint(d.location), locationUpdatedAt: d.updatedAt } });
  }
}

/** Recompute reserved seats from live bookings (heals counters after a crash). Run at startup. */
async function reconcileReservations() {
  const held = await Booking.aggregate([
    { $match: { vehicle: { $ne: null }, $or: [{ status: 'accepted' }, { status: 'requested', driver: { $ne: null } }] } },
    { $group: { _id: '$vehicle', seats: { $sum: { $ifNull: ['$seats', 1] } } } }
  ]);
  await Vehicle.updateMany({ reservedSeats: { $ne: 0 } }, { $set: { reservedSeats: 0 } });
  for (const h of held) await Vehicle.updateOne({ _id: h._id }, { $set: { reservedSeats: h.seats } });
}

/** Creates the first admin from ADMIN_EMAIL / ADMIN_PASSWORD (only if that email does not exist). */
async function bootstrapAdmin() {
  if (!cfg.adminEmail || !cfg.adminPassword) return;
  try {
    validate.email(cfg.adminEmail);
    validate.password(cfg.adminPassword);
  } catch (err) {
    log.error('ADMIN_EMAIL/ADMIN_PASSWORD ignored:', err.message);
    return;
  }
  const existing = await User.findOne({ email: cfg.adminEmail }).select('role');
  if (existing) {
    if (existing.role !== 'admin') log.warn('ADMIN_EMAIL belongs to a non-admin account; not changed.');
    return;
  }
  await User.create({
    name: cfg.adminName, email: cfg.adminEmail, role: 'admin', emailVerified: true,
    password: await bcrypt.hash(cfg.adminPassword, cfg.bcryptRounds)
  });
  log.info(`Admin account created: ${cfg.adminEmail}`);
}

/** Development demo data. Only runs when SEED_DEMO=true and never in production. */
async function seedDemoData() {
  if (!cfg.seedDemo) return;
  const hash = await bcrypt.hash(cfg.seedDemoPassword, cfg.bcryptRounds);
  const lat = Number(process.env.SEED_LAT) || 12.9716;
  const lng = Number(process.env.SEED_LNG) || 77.5946;
  const demoDrivers = [
    { name: 'Driver One', email: 'driver1@example.com', plate: 'AUTO-101', type: 'auto', capacity: 3, shared: false, dLat: 0, dLng: 0 },
    { name: 'Driver Two', email: 'driver2@example.com', plate: 'BUS-202', type: 'bus', capacity: 20, shared: true, dLat: 0.0034, dLng: -0.0036 }
  ];
  for (const d of demoDrivers) {
    let driver = await Driver.findOne({ email: d.email });
    if (!driver) {
      const loc = { lat: lat + d.dLat, lng: lng + d.dLng };
      driver = await Driver.create({ name: d.name, email: d.email, password: hash, location: loc, geo: toGeoPoint(loc), locationUpdatedAt: new Date() });
    }
    let vehicle = await Vehicle.findOne({ plate: d.plate });
    if (!vehicle) vehicle = await Vehicle.create({ type: d.type, plate: d.plate, capacity: d.capacity, shared: d.shared, driver: driver._id });
    if (!driver.activeVehicle) await Driver.updateOne({ _id: driver._id }, { activeVehicle: vehicle._id });
  }
  if (!(await User.exists({ email: 'student@example.com' }))) {
    await User.create({ name: 'Demo Student', email: 'student@example.com', password: hash, role: 'student', walletBalance: 500 });
  }
  log.info(`Demo accounts ready (password: ${cfg.seedDemoPassword}): driver1@example.com, driver2@example.com, student@example.com`);
}

module.exports = { ensureIndexes, migrateLegacy, reconcileReservations, bootstrapAdmin, seedDemoData };
