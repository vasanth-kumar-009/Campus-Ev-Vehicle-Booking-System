'use strict';
const express = require('express');
const v = require('../utils/validate');
const cfg = require('../config');
const { HttpError, asyncHandler } = require('../utils/errors');
const { haversineKm, toGeoPoint, withinArea } = require('../utils/geo');
const { approxRoute } = require('../services/routing');
const serialize = require('../services/serialize');
const svc = require('../services/bookings');
const { authAny, driverOnly, passengerOnly } = require('../middleware/auth');
const Booking = require('../models/Booking');
const Driver = require('../models/Driver');

const router = express.Router();

const populate = (q) => q.populate('driver', 'name').populate('user', 'name role').populate('vehicle', 'type plate capacity shared');
const viewerOf = (role) => (role === 'driver' ? 'driver' : role === 'admin' ? 'admin' : 'passenger');

async function loadForResponse(id, role) {
  const b = await populate(Booking.findById(id));
  return serialize.booking(b, viewerOf(role));
}

function parseRide(b) {
  const pickupLocation = v.coord(b.pickupLocation, 'Pickup location');
  const dropLocation = v.coord(b.dropLocation, 'Drop location');
  if (!withinArea(pickupLocation, cfg.serviceArea) || !withinArea(dropLocation, cfg.serviceArea)) {
    throw new HttpError(400, 'Pickup and drop must be inside the campus service area');
  }
  if (haversineKm(pickupLocation, dropLocation) < 0.05) throw new HttpError(400, 'Pickup and drop are the same place');
  const vehicleType = v.oneOf(b.vehicleType, ['any', 'auto', 'bus'], 'Vehicle type', 'any');
  const seats = v.int(b.seats, 'Seats', { min: 1, max: 20, def: 1 });
  if (vehicleType === 'auto' && seats > 3) throw new HttpError(400, 'An auto carries at most 3 passengers');
  return { pickupLocation, dropLocation, vehicleType, seats };
}

/* ---------- passenger ---------- */

router.post('/fare/estimate', passengerOnly, asyncHandler(async (req, res) => {
  const b = v.body(req);
  const ride = parseRide(b);
  res.json(await svc.estimate({ pickup: ride.pickupLocation, drop: ride.dropLocation, seats: ride.seats, role: req.auth.role }));
}));

router.post('/booking', passengerOnly, asyncHandler(async (req, res) => {
  const b = v.body(req);
  const ride = parseRide(b);
  const id = await svc.createBooking(req.auth.id, {
    ...ride,
    pickupName: v.optionalString(b.pickupName, 'Pickup name'),
    dropName: v.optionalString(b.dropName, 'Drop name'),
    paymentMethod: req.auth.role === 'staff' ? 'staff' : v.oneOf(b.paymentMethod, ['cash', 'wallet'], 'Payment method', 'cash')
  });
  const booking = await loadForResponse(id, req.auth.role);
  res.status(201).json({
    booking,
    message: booking.driver ? 'A driver has been asked to take your ride.' : 'No driver is free right now. We will keep looking for a few minutes.'
  });
}));

router.get('/bookings/mine', passengerOnly, asyncHandler(async (req, res) => {
  const list = await populate(Booking.find({ user: req.auth.id }).sort({ createdAt: -1 }).limit(30));
  res.json(list.map((b) => serialize.booking(b, 'passenger')));
}));

router.post('/booking/:id/cancel', passengerOnly, asyncHandler(async (req, res) => {
  const id = v.objectId(req.params.id);
  await svc.cancelBooking(id, req.auth.id);
  res.json({ booking: await loadForResponse(id, req.auth.role) });
}));

/* ---------- driver ---------- */

router.put('/booking/:id/status', driverOnly, asyncHandler(async (req, res) => {
  const id = v.objectId(req.params.id);
  const status = v.oneOf(v.body(req).status, ['accepted', 'rejected', 'completed'], 'Status');
  if (status === 'accepted') await svc.acceptBooking(id, req.auth.id);
  else if (status === 'rejected') await svc.declineBooking(id, req.auth.id);
  else await svc.completeBooking(id, req.auth.id);

  if (status === 'rejected') return res.json({ message: 'Request declined' }); // it now belongs to another driver
  res.json({ booking: await loadForResponse(id, req.auth.role) });
}));

router.post('/booking/:id/cash-collected', driverOnly, asyncHandler(async (req, res) => {
  const id = v.objectId(req.params.id);
  await svc.markCashCollected(id, req.auth.id);
  res.json({ booking: await loadForResponse(id, req.auth.role) });
}));

router.post('/location/update', driverOnly, asyncHandler(async (req, res) => {
  const loc = v.coord(v.body(req), 'Location');
  await Driver.updateOne(
    { _id: req.auth.id },
    { $set: { location: loc, geo: toGeoPoint(loc), locationUpdatedAt: new Date() } }
  );
  res.json({ message: 'Location updated' });
}));

/* ---------- shared (participants only) ---------- */

router.get('/booking/:id', authAny, asyncHandler(async (req, res) => {
  const id = v.objectId(req.params.id);
  const b = await populate(Booking.findById(id));
  if (!b) throw new HttpError(404, 'Booking not found');
  const isPassenger = b.user && String(b.user._id) === req.auth.id;
  const isDriver = b.driver && String(b.driver._id) === req.auth.id;
  if (!isPassenger && !isDriver && req.auth.role !== 'admin') throw new HttpError(403, 'Not allowed to view this booking');
  res.json(serialize.booking(b, viewerOf(req.auth.role)));
}));

/**
 * Live driver position. Only the passenger who owns an ACCEPTED booking (and admins) may read it,
 * and it stops being available the moment the ride ends.
 */
router.get('/booking/:id/driver-location', authAny, asyncHandler(async (req, res) => {
  const id = v.objectId(req.params.id);
  const b = await Booking.findById(id);
  if (!b) throw new HttpError(404, 'Booking not found');
  if (String(b.user) !== req.auth.id && req.auth.role !== 'admin') throw new HttpError(403, 'Not allowed to view this booking');
  if (b.status !== 'accepted' || !b.driver) return res.json({ available: false, status: b.status });

  const d = await Driver.findById(b.driver);
  if (!d || !d.geo) return res.json({ available: false, status: b.status });
  const loc = { lat: d.location.lat, lng: d.location.lng };
  const toPickup = approxRoute(loc, b.pickupLocation);
  res.json({
    available: true,
    status: b.status,
    location: loc,
    updatedAt: d.locationUpdatedAt,
    stale: !d.locationUpdatedAt || Date.now() - d.locationUpdatedAt > 2 * 60 * 1000,
    distanceToPickupKm: toPickup.distanceKm,
    etaToPickupMinutes: toPickup.etaMinutes
  });
}));

module.exports = router;
