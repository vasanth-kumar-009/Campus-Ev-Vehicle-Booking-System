'use strict';
const cfg = require('../config');
const log = require('../utils/logger');
const { haversineKm } = require('../utils/geo');

/** Straight-line estimate scaled by a road factor. Used when no routing server is configured. */
function approxRoute(a, b) {
  const distanceKm = Math.round(haversineKm(a, b) * cfg.roadFactor * 100) / 100;
  return { distanceKm, etaMinutes: Math.max(1, Math.round((distanceKm / cfg.avgSpeedKmh) * 60)), source: 'estimate' };
}

/**
 * Road distance/ETA. If ROUTING_URL points to an OSRM-compatible server it is used,
 * otherwise (or on any failure) we fall back to the straight-line estimate.
 */
async function estimateRoute(a, b) {
  if (!cfg.routingUrl) return approxRoute(a, b);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const url = `${cfg.routingUrl}/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=false`;
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`routing HTTP ${res.status}`);
    const data = await res.json();
    const route = data.routes && data.routes[0];
    if (!route) throw new Error('no route');
    return {
      distanceKm: Math.round((route.distance / 1000) * 100) / 100,
      etaMinutes: Math.max(1, Math.round(route.duration / 60)),
      source: 'road'
    };
  } catch (err) {
    log.warn('Routing server unavailable, using straight-line estimate:', err.message);
    return approxRoute(a, b);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { estimateRoute, approxRoute };
