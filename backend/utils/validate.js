'use strict';
const mongoose = require('mongoose');
const { HttpError } = require('./errors');
const { isValidCoord } = require('./geo');

const bad = (msg) => new HttpError(400, msg);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PLATE_RE = /^[A-Z0-9][A-Z0-9 -]{2,14}$/;

function body(req) {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw bad('Request body must be a JSON object');
  return req.body;
}

function string(v, field, { min = 1, max = 200 } = {}) {
  if (typeof v !== 'string') throw bad(`${field} is required`);
  const s = v.trim();
  if (s.length < min || s.length > max) throw bad(`${field} must be ${min}-${max} characters`);
  return s;
}

function optionalString(v, field, max = 120) {
  if (v === undefined || v === null || v === '') return '';
  return string(v, field, { min: 0, max });
}

function email(v) {
  const s = string(v, 'Email', { max: 254 }).toLowerCase();
  if (!EMAIL_RE.test(s)) throw bad('Please enter a valid email address');
  return s;
}

function password(v) {
  if (typeof v !== 'string') throw bad('Password is required');
  if (v.length < 8) throw bad('Password must be at least 8 characters');
  if (Buffer.byteLength(v, 'utf8') > 72) throw bad('Password must be at most 72 bytes');
  if (!/[A-Za-z]/.test(v) || !/\d/.test(v)) throw bad('Password must contain at least one letter and one number');
  return v;
}

function oneOf(v, allowed, field, def) {
  if ((v === undefined || v === null || v === '') && def !== undefined) return def;
  if (!allowed.includes(v)) throw bad(`${field} must be one of: ${allowed.join(', ')}`);
  return v;
}

function int(v, field, { min = 1, max = 100, def } = {}) {
  if ((v === undefined || v === null || v === '') && def !== undefined) return def;
  if (!Number.isInteger(v) || v < min || v > max) throw bad(`${field} must be a whole number between ${min} and ${max}`);
  return v;
}

function number(v, field, { min = -Infinity, max = Infinity } = {}) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw bad(`${field} must be a number between ${min} and ${max}`);
  return v;
}

function coord(v, field) {
  if (!isValidCoord(v)) throw bad(`${field} must be {lat, lng} with lat -90..90 and lng -180..180`);
  return { lat: v.lat, lng: v.lng };
}

function plate(v) {
  const s = string(v, 'Number plate', { min: 3, max: 15 }).toUpperCase();
  if (!PLATE_RE.test(s)) throw bad('Number plate may contain letters, numbers, spaces and hyphens only');
  return s;
}

function objectId(v, field = 'id') {
  if (typeof v !== 'string' || !mongoose.isValidObjectId(v) || String(new mongoose.Types.ObjectId(v)) !== v) {
    throw new HttpError(400, `Invalid ${field}`);
  }
  return v;
}

module.exports = { body, string, optionalString, email, password, oneOf, int, number, coord, plate, objectId };
