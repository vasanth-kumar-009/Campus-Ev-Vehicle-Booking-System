'use strict';
const express = require('express');
const v = require('../utils/validate');
const { HttpError, asyncHandler } = require('../utils/errors');
const { toGeoPoint } = require('../utils/geo');
const cfg = require('../config');
const serialize = require('../services/serialize');
const svc = require('../services/bookings');
const { driverOnly } = require('../middleware/auth');
const Driver = require('../models/Driver');
const Vehicle = require('../models/Vehicle');
const Booking = require('../models/Booking');

const router = express.Router();
router.use(driverOnly);

const populate = (q) => q.populate('user', 'name role').populate('vehicle', 'type plate capacity shared');

const driverView = (d) => ({
  _id: String(d._id), name: d.name, email: d.email, status: d.status,
  activeVehicle: d.activeVehicle ? String(d.activeVehicle) : null,
  location: d.geo ? { lat: d.location.lat, lng: d.location.lng } : null,
  locationUpdatedAt: d.locationUpdatedAt || null
});

async function vehicleSelection(driver) {
  const vehicles = await Vehicle.find({ driver: driver._id, active: { $ne: false } }).sort({ createdAt: 1 });
  const selected = vehicles.find((vehicle) => vehicle._id.equals(driver.activeVehicle)) || vehicles[0];
  return {
    vehicles: vehicles.map(serialize.vehicleView),
    activeVehicle: selected ? String(selected._id) : null
  };
}

router.get('/me', asyncHandler(async (req, res) => {
  const driver = req.auth.account;
  const { vehicles, activeVehicle } = await vehicleSelection(driver);
  res.json({ driver: { ...driverView(driver), activeVehicle }, vehicles });
}));

// Go online/offline. Going online needs a location so the driver can be matched.
router.post('/online', asyncHandler(async (req, res) => {
  const b = v.body(req);
  if (typeof b.online !== 'boolean') throw new HttpError(400, 'online must be true or false');
  const driver = await Driver.findById(req.auth.id);

  if (b.online) {
    const set = { status: 'online' };
    if (b.location) {
      const loc = v.coord(b.location, 'location');
      Object.assign(set, { location: loc, geo: toGeoPoint(loc), locationUpdatedAt: new Date() });
    } else if (!driver.geo || !driver.locationUpdatedAt || Date.now() - driver.locationUpdatedAt > cfg.locationMaxAgeMs) {
      throw new HttpError(400, 'Your location is needed to receive requests. Allow location access and try again.');
    }
    const vehicle = await svc.resolveVehicle(driver);
    if (!vehicle) throw new HttpError(400, 'No vehicle is assigned to your account. Ask the administrator to add one.');
    await Driver.updateOne({ _id: driver._id }, { $set: set });
    await svc.dispatchWaiting(); // queued passengers can be offered to this driver straight away
    return res.json({ message: 'Driver is now online', status: 'online' });
  }

  if (await Booking.exists({ driver: driver._id, status: 'accepted' })) {
    throw new HttpError(409, 'Finish your current ride before going offline');
  }
  await Driver.updateOne({ _id: driver._id }, { $set: { status: 'offline' } }); // first, so no new offer can reach this driver
  const offers = await Booking.find({ driver: driver._id, status: 'requested' }).select('_id');
  for (const o of offers) await svc.releaseOffer(o._id, driver._id, { markDeclined: false });
  res.json({ message: 'Driver is now offline', status: 'offline' });
}));

router.get('/vehicles', asyncHandler(async (req, res) => {
  res.json(await vehicleSelection(req.auth.account));
}));

// Vehicle selection: choose which of your vehicles you are driving today.
router.post('/vehicle', asyncHandler(async (req, res) => {
  const vehicleId = v.objectId(v.body(req).vehicleId, 'vehicleId');
  const target = await Vehicle.findOne({ _id: vehicleId, driver: req.auth.id, active: { $ne: false } });
  if (!target) throw new HttpError(404, 'Vehicle not found');
  const current = req.auth.account.activeVehicle && await Vehicle.findOne({ _id: req.auth.account.activeVehicle, driver: req.auth.id });
  if (current && String(current._id) !== vehicleId && current.reservedSeats > 0) {
    throw new HttpError(409, 'Finish or release current rides before switching vehicle');
  }
  await Driver.updateOne({ _id: req.auth.id }, { activeVehicle: target._id });
  res.json({ message: 'Vehicle selected', vehicle: serialize.vehicleView(target) });
}));

// Everything the dashboard needs in one poll.
router.get('/rides', asyncHandler(async (req, res) => {
  const now = new Date();
  const [pending, active, unpaid] = await Promise.all([
    populate(Booking.find({ driver: req.auth.id, status: 'requested', offerExpiresAt: { $gt: now } }).sort({ createdAt: 1 })),
    populate(Booking.find({ driver: req.auth.id, status: 'accepted' }).sort({ acceptedAt: 1 })),
    populate(Booking.find({ driver: req.auth.id, status: 'completed', paymentStatus: 'due' }).sort({ completedAt: -1 }).limit(10))
  ]);
  const map = (list) => list.map((b) => serialize.booking(b, 'driver'));
  res.json({ pending: map(pending), active: map(active), unpaid: map(unpaid) });
}));

module.exports = router;
