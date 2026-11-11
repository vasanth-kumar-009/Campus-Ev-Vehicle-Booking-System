'use strict';
/**
 * Central configuration. Every setting comes from environment variables.
 * The .env file is always loaded from backend/.env (independent of the folder
 * you start the server from).
 */
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const env = process.env;
const isProd = env.NODE_ENV === 'production';
const isTest = env.NODE_ENV === 'test';

const bool = (v, def) => (v === undefined || v === '' ? def : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));
const num = (v, def) => {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};
const list = (v) => (v || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);

const BAD_SECRETS = ['campus-secret-key', 'secret', 'changeme', 'change-me'];
function resolveJwtSecret() {
  const s = (env.JWT_SECRET || '').trim();
  const weak = !s || s.length < 32 || BAD_SECRETS.includes(s.toLowerCase()) || /^change[-_ ]?me/i.test(s);
  if (!weak) return s;
  if (isProd) {
    throw new Error('JWT_SECRET is missing or weak. Set a random value of 32+ characters: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
  }
  if (!isTest) console.warn('[config] JWT_SECRET missing/weak - using a temporary random secret. Logins reset on every restart.');
  return crypto.randomBytes(48).toString('hex');
}

const mongoUri = (env.MONGODB_URI || '').trim() || (isProd ? '' : 'mongodb://127.0.0.1:27017/campus-ev-booking');
if (isProd && !mongoUri) throw new Error('MONGODB_URI is required when NODE_ENV=production');

const port = num(env.PORT, 3000);
const appUrl = (env.APP_URL || `http://localhost:${port}`).replace(/\/+$/, '');

const cfg = {
  isProd,
  isTest,
  port,
  appUrl,
  mongoUri,
  jwtSecret: resolveJwtSecret(),
  jwtExpiresIn: '12h',
  sessionMaxAgeMs: 12 * 60 * 60 * 1000,
  bcryptRounds: isTest ? 4 : 12,

  corsOrigins: [...new Set([...list(env.CORS_ORIGINS), appUrl])],
  trustProxy: num(env.TRUST_PROXY, isProd ? 1 : 0),
  forceHttps: bool(env.FORCE_HTTPS, isProd),
  cookieSecure: bool(env.COOKIE_SECURE, isProd),
  serveFrontend: bool(env.SERVE_FRONTEND, true),
  rateLimit: !isTest && bool(env.RATE_LIMIT, true),

  // Optional bootstrap of the first admin account
  adminEmail: (env.ADMIN_EMAIL || '').trim().toLowerCase(),
  adminPassword: env.ADMIN_PASSWORD || '',
  adminName: env.ADMIN_NAME || 'Campus Admin',

  // Demo data (never allowed in production)
  seedDemo: !isProd && bool(env.SEED_DEMO, false),
  seedDemoPassword: env.SEED_DEMO_PASSWORD || 'Password123',

  // Dispatch
  dispatchRadiusM: num(env.DISPATCH_RADIUS_KM, 10) * 1000,
  offerTimeoutMs: num(env.OFFER_TIMEOUT_SECONDS, 60) * 1000,
  maxWaitMs: num(env.MAX_WAIT_MINUTES, 15) * 60 * 1000,
  locationMaxAgeMs: num(env.LOCATION_MAX_AGE_SECONDS, 900) * 1000,
  sweepIntervalMs: isTest ? 0 : num(env.SWEEP_INTERVAL_SECONDS, 5) * 1000,

  // Optional service area (campus geofence): "lat,lng" + radius in km
  serviceArea: (() => {
    const [lat, lng] = (env.SERVICE_AREA_CENTER || '').split(',').map(Number);
    const radiusKm = num(env.SERVICE_AREA_RADIUS_KM, 0);
    return Number.isFinite(lat) && Number.isFinite(lng) && radiusKm > 0 ? { lat, lng, radiusKm } : null;
  })(),

  // Optional road routing (OSRM-compatible server). Empty = straight-line estimate.
  routingUrl: (env.ROUTING_URL || '').trim().replace(/\/+$/, ''),
  roadFactor: num(env.ROAD_FACTOR, 1.3),
  avgSpeedKmh: num(env.AVG_SPEED_KMH, 20),

  // Fares (INR). fare = max(min, base + perKm * km); shared vehicles multiply by seats.
  currency: env.CURRENCY || 'INR',
  fares: {
    auto: { base: num(env.FARE_AUTO_BASE, 20), perKm: num(env.FARE_AUTO_PER_KM, 10), min: num(env.FARE_AUTO_MIN, 30) },
    bus: { base: num(env.FARE_BUS_BASE, 5), perKm: num(env.FARE_BUS_PER_KM, 2), min: num(env.FARE_BUS_MIN, 10) }
  },

  // Email (optional). Without SMTP, links are printed to the console in development only.
  smtp: env.SMTP_HOST
    ? {
        host: env.SMTP_HOST,
        port: num(env.SMTP_PORT, 587),
        secure: bool(env.SMTP_SECURE, false),
        auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined
      }
    : null,
  mailFrom: env.MAIL_FROM || 'Campus EV <no-reply@campus-ev.local>',
  requireEmailVerification: bool(env.EMAIL_VERIFICATION_REQUIRED, !!env.SMTP_HOST),

  maxFailedLogins: 5,
  lockMinutes: 15
};

module.exports = cfg;
