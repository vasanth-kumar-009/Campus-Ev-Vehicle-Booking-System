'use strict';
/**
 * Explicit response shapes. Nothing is ever returned by spreading a database document,
 * so password hashes and internal fields cannot leak.
 */
const { staffFare, isFreeStaffRide } = require('./fare');
const id = (v) => (v && v._id ? String(v._id) : v ? String(v) : null);

function profile(account, role) {
  return {
    _id: String(account._id),
    name: account.name,
    email: account.email,
    role,
    emailVerified: account.emailVerified !== false,
    ...(role === 'student' && account.walletBalance !== undefined ? { walletBalance: account.walletBalance } : {})
  };
}

const vehicleView = (v) =>
  v && v.plate ? { _id: String(v._id), type: v.type, plate: v.plate, capacity: v.capacity, shared: !!v.shared } : null;

const vehicleAdminView = (v) => ({
  ...vehicleView(v),
  reservedSeats: v.reservedSeats || 0,
  active: v.active !== false,
  driver: v.driver && v.driver.name ? { _id: id(v.driver), name: v.driver.name } : id(v.driver)
});

/**
 * viewer: 'passenger' | 'driver' | 'admin'
 * Expects `driver`, `user` and `vehicle` to be populated with at most name/plate fields.
 */
function booking(b, viewer = 'passenger') {
  const out = {
    _id: String(b._id),
    status: b.status,
    pickupName: b.pickupName,
    dropName: b.dropName,
    pickupLocation: { lat: b.pickupLocation.lat, lng: b.pickupLocation.lng },
    dropLocation: { lat: b.dropLocation.lat, lng: b.dropLocation.lng },
    seats: b.seats || 1,
    vehicleType: b.vehicleType || 'any',
    distanceKm: b.distanceKm,
    etaMinutes: b.etaMinutes,
    fare: b.fare,
    paymentMethod: b.paymentMethod,
    paymentStatus: b.paymentStatus,
    offerExpiresAt: b.offerExpiresAt || null,
    createdAt: b.createdAt,
    acceptedAt: b.acceptedAt,
    completedAt: b.completedAt,
    vehicle: vehicleView(b.vehicle)
  };
  if (isFreeStaffRide(b)) Object.assign(out, staffFare);
  if (viewer !== 'driver') out.driver = b.driver && b.driver.name ? { _id: id(b.driver), name: b.driver.name } : null;
  if (viewer !== 'passenger') out.user = b.user && b.user.name ? { _id: id(b.user), name: b.user.name } : null;
  if (viewer === 'admin') out.driver = b.driver && b.driver.name ? { _id: id(b.driver), name: b.driver.name } : null;
  return out;
}

module.exports = { profile, booking, vehicleView, vehicleAdminView };
