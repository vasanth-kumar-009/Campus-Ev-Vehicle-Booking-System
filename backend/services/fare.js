'use strict';
const cfg = require('../config');

/**
 * fare = max(min, base + perKm * km). Shared vehicles (buses) charge per seat.
 * Whole rupees only.
 */
function calculateFare({ type, distanceKm, seats = 1, shared = false }, fares = cfg.fares) {
  const rule = fares[type] || fares.auto;
  const base = Math.max(rule.min, Math.round(rule.base + rule.perKm * distanceKm));
  return shared ? base * seats : base;
}

const staffFare = { fare: 0, paymentMethod: 'staff', paymentStatus: 'waived' };

function isFreeStaffRide(booking) {
  return booking.paymentMethod === 'staff' ||
    (['requested', 'accepted'].includes(booking.status) && booking.user?.role === 'staff');
}

module.exports = { calculateFare, staffFare, isFreeStaffRide };
