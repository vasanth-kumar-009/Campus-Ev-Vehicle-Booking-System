'use strict';
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const cfg = require('../config');
const { HttpError } = require('../utils/errors');

const LOCAL_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function isAllowedOrigin(origin, req) {
  if (!origin) return true;
  const clean = origin.replace(/\/+$/, '');
  if (cfg.corsOrigins.includes(clean)) return true;
  if (!cfg.isProd && LOCAL_RE.test(clean)) return true;
  try { return new URL(clean).host === req.get('host'); } catch { return false; } // same-origin
}

/** CORS: only the origins listed in CORS_ORIGINS (plus APP_URL) may call the API from a browser. */
const corsOptions = (req, cb) => cb(null, { origin: isAllowedOrigin(req.get('origin'), req), credentials: true });

/** Rejects state-changing requests that come from a foreign website. */
function originCheck(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (isAllowedOrigin(req.get('origin'), req)) return next();
  next(new HttpError(403, 'Request origin is not allowed'));
}

/** Public deployments must use HTTPS (health checks are exempt). */
function httpsOnly(req, res, next) {
  if (!cfg.forceHttps || req.secure || req.path === '/api/health') return next();
  if (req.method === 'GET' || req.method === 'HEAD') return res.redirect(308, `https://${req.get('host')}${req.originalUrl}`);
  next(new HttpError(426, 'HTTPS is required'));
}

/** 503 instead of a hang or crash while the database is unreachable. */
function requireDb(req, res, next) {
  if (mongoose.connection.readyState === 1) return next();
  next(new HttpError(503, 'Database temporarily unavailable. Please try again shortly.'));
}

const noop = (req, res, next) => next();
const sessionKey = (req) => {
  const c = req.cookies && (req.cookies.ev_driver || req.cookies.ev_user);
  return c ? `s:${c.slice(-32)}` : `ip:${req.ip}`;
};

const apiLimiter = cfg.rateLimit
  ? rateLimit({ windowMs: 60 * 1000, limit: Number(process.env.API_RATE_LIMIT) || 300, keyGenerator: sessionKey, standardHeaders: true, legacyHeaders: false,
      handler: (req, res, next) => next(new HttpError(429, 'Too many requests. Slow down and try again shortly.')) })
  : noop;

const authLimiter = cfg.rateLimit
  ? rateLimit({ windowMs: 15 * 60 * 1000, limit: Number(process.env.AUTH_RATE_LIMIT) || 30, standardHeaders: true, legacyHeaders: false,
      handler: (req, res, next) => next(new HttpError(429, 'Too many attempts. Please wait a few minutes.')) })
  : noop;

module.exports = { corsOptions, originCheck, httpsOnly, requireDb, apiLimiter, authLimiter, isAllowedOrigin };
