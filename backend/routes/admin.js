'use strict';
const express = require('express');
const v = require('../utils/validate');
const { HttpError, asyncHandler } = require('../utils/errors');
const serialize = require('../services/serialize');
const svc = require('../services/bookings');
const { adminOnly } = require('../middleware/auth');
const User = require('../models/User');
const Driver = require('../models/Driver');
const Vehicle = require('../models/Vehicle');
const Booking = require('../models/Booking');

const router = express.Router();
router.use(adminOnly);

router.get('/stats', asyncHandler(async (req, res) => {
  const [users, drivers, onlineDrivers, vehicles, open, completed] = await Promise.all([
    User.countDocuments({ role: { $in: ['student', 'staff'] } }),
    Driver.countDocuments(),
    Driver.countDocuments({ status: 'online' }),
    Vehicle.countDocuments({ active: { $ne: false } }),
    Booking.countDocuments({ status: { $in: ['requested', 'accepted'] } }),
    Booking.countDocuments({ status: 'completed' })
  ]);
  res.json({ users, drivers, onlineDrivers, vehicles, openBookings: open, completedBookings: completed });
}));

/* ---------- drivers ---------- */
router.get('/drivers', asyncHandler(async (req, res) => {
  const drivers = await Driver.find().sort({ createdAt: -1 }).limit(200);
  const vehicles = await Vehicle.find({ driver: { $in: drivers.map((d) => d._id) } });
  res.json(drivers.map((d) => ({
    _id: String(d._id), name: d.name, email: d.email, status: d.status, active: d.active !== false,
    vehicles: vehicles.filter((x) => String(x.driver) === String(d._id)).map(serialize.vehicleAdminView)
  })));
}));

router.patch('/drivers/:id', asyncHandler(async (req, res) => {
  const id = v.objectId(req.params.id);
  const active = v.body(req).active;
  if (typeof active !== 'boolean') throw new HttpError(400, 'active must be true or false');
  const update = active ? { active } : { active, status: 'offline', $inc: { tokenVersion: 1 } };
  const d = await Driver.findByIdAndUpdate(id, update, { new: true });
  if (!d) throw new HttpError(404, 'Driver not found');
  if (!active) {
    const offers = await Booking.find({ driver: id, status: 'requested' }).select('_id');
    for (const o of offers) await svc.releaseOffer(o._id, id, { markDeclined: false });
  }
  res.json({ message: active ? 'Driver enabled' : 'Driver disabled' });
}));

/* ---------- vehicles ---------- */
async function vehicleFields(b, existing) {
  const out = {};
  const type = b.type !== undefined ? v.oneOf(b.type, ['auto', 'bus'], 'Type') : existing && existing.type;
  if (b.type !== undefined) out.type = type;
  if (b.plate !== undefined || !existing) out.plate = v.plate(b.plate);
  if (b.capacity !== undefined || !existing) out.capacity = v.int(b.capacity, 'Capacity', { min: 1, max: 60, def: type === 'bus' ? 20 : 3 });
  if (b.shared !== undefined) out.shared = !!b.shared; else if (!existing) out.shared = type === 'bus';
  if (b.active !== undefined) out.active = !!b.active;
  if (b.driverId !== undefined) {
    if (b.driverId === null || b.driverId === '') out.driver = null;
    else {
      const id = v.objectId(b.driverId, 'driverId');
      if (!(await Driver.exists({ _id: id, deletionToken: null }))) throw new HttpError(404, 'Driver not found');
      out.driver = id;
    }
  }
  return out;
}

async function verifyAssignedDriver(vehicle) {
  if (!vehicle.driver || await Driver.exists({ _id: vehicle.driver, deletionToken: null })) return;
  await Vehicle.updateOne({ _id: vehicle._id, driver: vehicle.driver }, { $unset: { driver: 1 } });
  throw new HttpError(409, 'Driver account is being deleted. Refresh the vehicle list.');
}

router.get('/vehicles', asyncHandler(async (req, res) => {
  const list = await Vehicle.find().populate('driver', 'name').sort({ createdAt: -1 }).limit(200);
  res.json(list.map(serialize.vehicleAdminView));
}));

router.post('/vehicles', asyncHandler(async (req, res) => {
  const fields = await vehicleFields(v.body(req), null);
  const vehicle = await Vehicle.create(fields);
  if (fields.driver) await verifyAssignedDriver(vehicle);
  if (fields.driver) await Driver.updateOne({ _id: fields.driver, activeVehicle: { $exists: false } }, { activeVehicle: vehicle._id });
  res.status(201).json({ vehicle: serialize.vehicleAdminView(vehicle) });
}));

router.put('/vehicles/:id', asyncHandler(async (req, res) => {
  const id = v.objectId(req.params.id);
  const existing = await Vehicle.findById(id);
  if (!existing) throw new HttpError(404, 'Vehicle not found');
  const fields = await vehicleFields(v.body(req), existing);
  const filter = { _id: id };
  if (fields.driver !== undefined || fields.active === false) {
    filter.reservedSeats = { $not: { $gt: 0 } };
  } else if (fields.capacity !== undefined) {
    filter.reservedSeats = { $not: { $gt: fields.capacity } };
  }
  if (fields.driver !== undefined) filter.driver = existing.driver || null;
  const updated = await Vehicle.findOneAndUpdate(filter, { $set: fields }, { new: true, runValidators: true });
  if (!updated) throw new HttpError(409, 'Vehicle changed or has rides in progress. Refresh Vehicles and try again.');
  if (fields.driver !== undefined && existing.driver && String(existing.driver) !== fields.driver) {
    await Driver.updateOne({ _id: existing.driver, activeVehicle: id }, { $unset: { activeVehicle: 1 } });
  }
  if (fields.driver) await verifyAssignedDriver(updated);
  res.json({ vehicle: serialize.vehicleAdminView(updated) });
}));

router.delete('/vehicles/:id', asyncHandler(async (req, res) => {
  const id = v.objectId(req.params.id);
  const vehicle = await Vehicle.findById(id);
  if (!vehicle) throw new HttpError(404, 'Vehicle not found');
  if (vehicle.reservedSeats > 0) throw new HttpError(409, 'This vehicle has rides in progress');
  await vehicle.deleteOne();
  await Driver.updateMany({ activeVehicle: id }, { $unset: { activeVehicle: 1 } });
  res.json({ message: 'Vehicle deleted' });
}));

/* ---------- bookings ---------- */
router.get('/bookings', asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = v.oneOf(String(req.query.status), ['requested', 'accepted', 'completed', 'cancelled', 'expired'], 'status');
  const list = await Booking.find(filter).populate('driver', 'name').populate('user', 'name role').populate('vehicle', 'type plate capacity shared')
    .sort({ createdAt: -1 }).limit(100);
  res.json(list.map((b) => serialize.booking(b, 'admin')));
}));

/* ---------- users & wallet ---------- */
router.get('/users', asyncHandler(async (req, res) => {
  const users = await User.find({ role: { $in: ['student', 'staff'] } }).sort({ createdAt: -1 }).limit(200);
  res.json(users.map((u) => ({ _id: String(u._id), name: u.name, email: u.email, role: u.role, active: u.active !== false, walletBalance: u.role === 'student' ? u.walletBalance || 0 : null })));
}));

router.patch('/users/:id', asyncHandler(async (req, res) => {
  const id = v.objectId(req.params.id);
  const active = v.body(req).active;
  if (typeof active !== 'boolean') throw new HttpError(400, 'active must be true or false');
  const u = await User.findOneAndUpdate({ _id: id, role: { $in: ['student', 'staff'] } }, active ? { active } : { active, $inc: { tokenVersion: 1 } }, { new: true });
  if (!u) throw new HttpError(404, 'User not found');
  res.json({ message: active ? 'User enabled' : 'User disabled' });
}));

router.post('/users/:id/wallet', asyncHandler(async (req, res) => {
  const id = v.objectId(req.params.id);
  const amount = v.int(v.body(req).amount, 'Amount', { min: 1, max: 100000 });
  const u = await User.findOneAndUpdate({ _id: id, role: 'student', deletionToken: null }, { $inc: { walletBalance: amount } }, { new: true });
  if (!u) throw new HttpError(404, 'User not found');
  res.json({ walletBalance: u.walletBalance });
}));

module.exports = router;
