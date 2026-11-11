'use strict';
/**
 * Booking lifecycle: dispatch, offers, state transitions and payment.
 *
 * Concurrency model (no transactions needed):
 *  - Seats on a vehicle are reserved with ONE atomic conditional update, so two bookings
 *    can never reserve the same auto, and a bus can never exceed its capacity.
 *  - Every status change is ONE atomic findOneAndUpdate that names the status it expects.
 *    Exactly one caller can win a transition; the winner is the only one that releases seats.
 *
 * State machine:
 *   requested --(driver accepts)--> accepted --(driver completes)--> completed
 *   requested --(driver declines / offer times out)--> requested (re-offered to next driver)
 *   requested --(passenger cancels)--> cancelled        accepted --(passenger cancels)--> cancelled
 *   requested --(nobody accepts within MAX_WAIT)--> expired
 */
const cfg = require('../config');
const log = require('../utils/logger');
const { HttpError } = require('../utils/errors');
const Booking = require('../models/Booking');
const Driver = require('../models/Driver');
const User = require('../models/User');
const Vehicle = require('../models/Vehicle');
const { notify } = require('./notify');
const { calculateFare, staffFare, isFreeStaffRide } = require('./fare');
const { estimateRoute } = require('./routing');

const TRANSITIONS = {
  requested: ['accepted', 'cancelled', 'expired'],
  accepted: ['completed', 'cancelled'],
  completed: [], cancelled: [], expired: [], rejected: []
};
const canTransition = (from, to) => (TRANSITIONS[from] || []).includes(to);

/* ---------- vehicle seat inventory ---------- */

async function reserveSeats(vehicleId, seats, driverId) {
  const v = await Vehicle.findOneAndUpdate(
    {
      _id: vehicleId,
      ...(driverId ? { driver: driverId } : {}),
      active: { $ne: false },
      capacity: { $gte: seats },
      $or: [
        { shared: false, reservedSeats: 0 },
        { shared: true, $expr: { $lte: [{ $add: ['$reservedSeats', seats] }, '$capacity'] } }
      ]
    },
    { $inc: { reservedSeats: seats } },
    { new: true }
  );
  return !!v;
}

async function releaseSeats(vehicleId, seats) {
  if (!vehicleId) return;
  await Vehicle.updateOne({ _id: vehicleId, reservedSeats: { $gte: seats } }, { $inc: { reservedSeats: -seats } });
}

/** The vehicle a driver is currently driving (falls back to their first active vehicle). */
async function resolveVehicle(driver) {
  let v = driver.activeVehicle ? await Vehicle.findOne({ _id: driver.activeVehicle, driver: driver._id, active: { $ne: false } }) : null;
  if (!v) {
    v = await Vehicle.findOne({ driver: driver._id, active: { $ne: false } }).sort({ createdAt: 1 });
    if (v) await Driver.updateOne({ _id: driver._id }, { activeVehicle: v._id });
  }
  return v;
}

/* ---------- dispatch ---------- */

/**
 * Offers a waiting booking to the nearest suitable driver. Returns the updated booking
 * or null when no driver could be reserved right now (it stays queued and is retried).
 */
async function dispatchBooking(bookingId) {
  const booking = await Booking.findById(bookingId).populate('user', 'role');
  if (!booking || booking.status !== 'requested' || booking.driver) return null;

  const cutoff = new Date(Date.now() - cfg.locationMaxAgeMs);
  const candidates = await Driver.find({
    active: { $ne: false },
    deletionToken: null,
    status: 'online',
    _id: { $nin: booking.declinedBy || [] },
    locationUpdatedAt: { $gte: cutoff },
    geo: {
      $near: {
        $geometry: { type: 'Point', coordinates: [booking.pickupLocation.lng, booking.pickupLocation.lat] },
        $maxDistance: cfg.dispatchRadiusM
      }
    }
  }).limit(15); // $near returns nearest first

  for (const driver of candidates) {
    const vehicle = await resolveVehicle(driver);
    if (!vehicle) continue;
    if (booking.vehicleType !== 'any' && vehicle.type !== booking.vehicleType) continue;
    if (!(await reserveSeats(vehicle._id, booking.seats, driver._id))) continue;

    const fare = calculateFare({ type: vehicle.type, distanceKm: booking.distanceKm || 0, seats: booking.seats, shared: vehicle.shared });
    const updated = await Booking.findOneAndUpdate(
      { _id: booking._id, status: 'requested', driver: null },
      {
        driver: driver._id,
        vehicle: vehicle._id,
        ...(isFreeStaffRide(booking) ? staffFare : { fare }),
        assignedAt: new Date(),
        offerExpiresAt: new Date(Date.now() + cfg.offerTimeoutMs)
      },
      { new: true }
    );
    if (!updated) {
      // Cancelled or taken while we were reserving: give the seats back.
      await releaseSeats(vehicle._id, booking.seats);
      return null;
    }
    if (!(await Driver.exists({ _id: driver._id, deletionToken: null, active: { $ne: false } }))) {
      await releaseOffer(booking._id, driver._id);
      return null;
    }
    await notify('driver', driver._id, 'new_request',
      `New ride request: ${booking.pickupName || 'pickup'} to ${booking.dropName || 'drop'}`, booking._id);
    return updated;
  }
  return null;
}

/** Retry every booking that is still waiting for a driver. */
async function dispatchWaiting(limit = 50) {
  const waiting = await Booking.find({ status: 'requested', driver: null }).sort({ createdAt: 1 }).limit(limit).select('_id');
  for (const b of waiting) await dispatchBooking(b._id);
}

/* ---------- create ---------- */

async function estimate({ pickup, drop, seats, role }) {
  const route = await estimateRoute(pickup, drop);
  const options = {};
  for (const type of ['auto', 'bus']) {
    const shared = type === 'bus';
    options[type] = role === 'staff' ? 0 : calculateFare({ type, distanceKm: route.distanceKm, seats, shared });
  }
  return { ...route, seats, options, currency: cfg.currency };
}

async function createBooking(userId, input) {
  const est = await estimate({ pickup: input.pickupLocation, drop: input.dropLocation, seats: input.seats, role: input.paymentMethod === 'staff' ? 'staff' : 'student' });

  if (input.paymentMethod === 'wallet') {
    const types = input.vehicleType === 'any' ? ['auto', 'bus'] : [input.vehicleType];
    const cheapest = Math.min(...types.map((t) => est.options[t]));
    const u = await User.findById(userId).select('walletBalance');
    if (!u || u.walletBalance < cheapest) {
      throw new HttpError(402, `Insufficient wallet balance (need at least ${cheapest} ${cfg.currency})`);
    }
  }

  let booking;
  try {
    booking = await Booking.create({
      user: userId,
      pickupName: input.pickupName,
      dropName: input.dropName,
      pickupLocation: input.pickupLocation,
      dropLocation: input.dropLocation,
      seats: input.seats,
      vehicleType: input.vehicleType,
      ...(input.paymentMethod === 'staff' ? staffFare : { paymentMethod: input.paymentMethod }),
      distanceKm: est.distanceKm,
      etaMinutes: est.etaMinutes,
      status: 'requested'
    });
  } catch (err) {
    if (err.code === 11000) throw new HttpError(409, 'You already have an active ride. Cancel it or wait until it finishes.');
    throw err;
  }
  if (!(await User.exists({ _id: userId, deletionToken: null, active: { $ne: false } }))) {
    await cancelBooking(booking._id, userId);
    throw new HttpError(409, 'This account is no longer available for bookings.');
  }
  await dispatchBooking(booking._id);
  return booking._id;
}

/* ---------- driver actions ---------- */

async function acceptBooking(bookingId, driverId) {
  const driver = await Driver.findOne({ _id: driverId, deletionToken: null, active: { $ne: false }, status: 'online' }).select('_id');
  if (!driver) throw new HttpError(409, 'Go online before accepting rides');

  const b = await Booking.findOneAndUpdate(
    { _id: bookingId, driver: driverId, status: 'requested', offerExpiresAt: { $gt: new Date() } },
    { status: 'accepted', acceptedAt: new Date(), $unset: { offerExpiresAt: 1 } },
    { new: true }
  );
  if (!b) throw new HttpError(409, 'This request is no longer available (expired, cancelled or reassigned)');
  await notify('user', b.user, 'ride_accepted', 'Your driver accepted the ride and is on the way.', b._id);
  return b;
}

/**
 * Takes an offer away from a driver (decline, timeout, or driver going offline), frees the
 * seats and immediately offers the booking to the next nearest driver.
 */
async function releaseOffer(bookingId, driverId, { expiredOnly = false, markDeclined = true } = {}) {
  const filter = { _id: bookingId, driver: driverId, status: 'requested' };
  if (expiredOnly) filter.offerExpiresAt = { $lt: new Date() };
  const update = { $set: { driver: null, vehicle: null }, $unset: { offerExpiresAt: 1 } };
  if (markDeclined) update.$addToSet = { declinedBy: driverId };

  const old = await Booking.findOneAndUpdate(filter, update, { new: false });
  if (!old) return false;
  await releaseSeats(old.vehicle, old.seats);
  await dispatchBooking(bookingId);
  return true;
}

async function declineBooking(bookingId, driverId) {
  const ok = await releaseOffer(bookingId, driverId);
  if (!ok) throw new HttpError(409, 'This request is no longer assigned to you');
}

async function completeBooking(bookingId, driverId) {
  const filter = { _id: bookingId, driver: driverId, status: 'accepted' };
  const accepted = await Booking.findOne(filter).select('user paymentMethod status').populate('user', 'role');
  if (!accepted) throw new HttpError(409, 'Only your accepted ride can be completed');
  const free = isFreeStaffRide(accepted);
  const b = await Booking.findOneAndUpdate(
    filter,
    { status: 'completed', completedAt: new Date(), ...(free ? staffFare : {}) },
    { new: true }
  );
  if (!b) throw new HttpError(409, 'Only an accepted ride that is assigned to you can be completed');
  await releaseSeats(b.vehicle, b.seats);

  if (free) {
    await notify('user', b.user, 'ride_completed', 'Staff ride completed. No payment is required.', b._id);
    await dispatchWaiting();
    return b;
  }

  // Payment: wallet is charged atomically (only if the balance covers the fare); cash is collected by the driver.
  let paymentStatus = 'due';
  if (!b.fare) paymentStatus = 'paid';
  else if (b.paymentMethod === 'wallet') {
    const charged = await User.findOneAndUpdate(
      { _id: b.user, walletBalance: { $gte: b.fare } },
      { $inc: { walletBalance: -b.fare } }
    );
    paymentStatus = charged ? 'paid' : 'due';
  }
  b.paymentStatus = paymentStatus;
  await b.save();

  const msg = paymentStatus === 'paid'
    ? `Ride completed. ${b.fare || 0} ${cfg.currency} paid.`
    : `Ride completed. Please pay ${b.fare} ${cfg.currency} to the driver.`;
  await notify('user', b.user, 'ride_completed', msg, b._id);
  await dispatchWaiting(); // freed seats may serve a queued booking
  return b;
}

async function markCashCollected(bookingId, driverId) {
  const b = await Booking.findOneAndUpdate(
    { _id: bookingId, driver: driverId, status: 'completed', paymentStatus: 'due' },
    { paymentStatus: 'paid' },
    { new: true }
  );
  if (!b) throw new HttpError(409, 'No unpaid completed ride found');
  return b;
}

/* ---------- passenger / system actions ---------- */

async function cancelBooking(bookingId, userId) {
  const old = await Booking.findOneAndUpdate(
    { _id: bookingId, user: userId, status: { $in: ['requested', 'accepted'] } },
    { status: 'cancelled', cancelledAt: new Date(), cancelledBy: 'passenger', $unset: { offerExpiresAt: 1 } },
    { new: false }
  );
  if (!old) {
    const exists = await Booking.exists({ _id: bookingId, user: userId });
    throw new HttpError(exists ? 409 : 404, exists ? 'This booking can no longer be cancelled' : 'Booking not found');
  }
  if (old.driver) {
    await releaseSeats(old.vehicle, old.seats);
    await notify('driver', old.driver, 'ride_cancelled', 'The passenger cancelled the ride.', old._id);
    await dispatchWaiting();
  }
}

async function expireBooking(bookingId) {
  const b = await Booking.findOneAndUpdate(
    { _id: bookingId, status: 'requested', driver: null },
    { status: 'expired', cancelledAt: new Date(), cancelledBy: 'system' },
    { new: true }
  );
  if (b) await notify('user', b.user, 'no_driver', 'No driver was available for your ride request. Please try again.', b._id);
  return !!b;
}

/* ---------- background maintenance ---------- */

let sweeping = false;
async function sweep() {
  if (sweeping) return;
  sweeping = true;
  try {
    const now = new Date();
    const stale = await Booking.find({ status: 'requested', driver: { $ne: null }, offerExpiresAt: { $lt: now } }).limit(50).select('driver');
    for (const b of stale) await releaseOffer(b._id, b.driver, { expiredOnly: true });

    const old = await Booking.find({ status: 'requested', driver: null, createdAt: { $lt: new Date(now - cfg.maxWaitMs) } }).limit(50).select('_id');
    for (const b of old) await expireBooking(b._id);

    await dispatchWaiting();
  } catch (err) {
    log.error('Sweep failed:', err);
  } finally {
    sweeping = false;
  }
}

let timer = null;
function startSweeper() {
  if (!cfg.sweepIntervalMs || timer) return;
  timer = setInterval(sweep, cfg.sweepIntervalMs);
  timer.unref();
}
function stopSweeper() { if (timer) clearInterval(timer); timer = null; }

module.exports = {
  TRANSITIONS, canTransition,
  reserveSeats, releaseSeats, resolveVehicle,
  dispatchBooking, dispatchWaiting, estimate, createBooking,
  acceptBooking, declineBooking, releaseOffer, completeBooking, markCashCollected,
  cancelBooking, expireBooking, sweep, startSweeper, stopSweeper
};
