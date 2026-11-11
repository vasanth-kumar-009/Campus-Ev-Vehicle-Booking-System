'use strict';

const EARTH_RADIUS_KM = 6371;
const toRad = (d) => (d * Math.PI) / 180;

/** Great-circle distance in km between two {lat,lng} points. */
function haversineKm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

const isValidCoord = (p) =>
  !!p && typeof p.lat === 'number' && typeof p.lng === 'number' &&
  Number.isFinite(p.lat) && Number.isFinite(p.lng) &&
  p.lat >= -90 && p.lat <= 90 && p.lng >= -180 && p.lng <= 180;

const toGeoPoint = (p) => ({ type: 'Point', coordinates: [p.lng, p.lat] }); // GeoJSON is [lng, lat]

function withinArea(point, area) {
  return !area || haversineKm(point, area) <= area.radiusKm;
}

module.exports = { haversineKm, isValidCoord, toGeoPoint, withinArea };
