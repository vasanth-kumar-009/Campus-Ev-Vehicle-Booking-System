'use strict';
const jwt = require('jsonwebtoken');
const cfg = require('../config');
const { HttpError, asyncHandler } = require('../utils/errors');
const User = require('../models/User');
const Driver = require('../models/Driver');

/**
 * Sessions live in HttpOnly cookies (not readable by JavaScript, so XSS cannot steal them).
 * Drivers and passengers use DIFFERENT cookies, so one browser can hold a driver session and a
 * passenger session at the same time. The page tells the API which one it wants with the
 * X-Session header (a custom header also blocks cross-site form posts - CSRF).
 */
const COOKIE_NAMES = { driver: 'ev_driver', user: 'ev_user' };
const kindOf = (role) => (role === 'driver' ? 'driver' : 'user');

const cookieOptions = () => ({
  httpOnly: true,
  secure: cfg.cookieSecure,
  sameSite: 'strict',
  path: '/'
});

function issueSession(res, account, role) {
  const token = jwt.sign(
    { sub: String(account._id), role: kindOf(role), tv: account.tokenVersion || 0 },
    cfg.jwtSecret,
    { algorithm: 'HS256', expiresIn: cfg.jwtExpiresIn }
  );
  res.cookie(COOKIE_NAMES[kindOf(role)], token, { ...cookieOptions(), maxAge: cfg.sessionMaxAgeMs });
}

function clearSession(res, kind) {
  res.clearCookie(COOKIE_NAMES[kind], cookieOptions());
}

/** Loads the account behind the session and attaches req.auth = { id, role, kind, account }. */
const authenticate = asyncHandler(async (req, res, next) => {
  let token;
  let kind;
  const header = req.get('authorization');
  if (header && header.startsWith('Bearer ')) {
    token = header.slice(7); // for API clients and tests
  } else {
    kind = req.get('x-session');
    if (!COOKIE_NAMES[kind]) throw new HttpError(401, 'Please log in');
    token = req.cookies && req.cookies[COOKIE_NAMES[kind]];
  }
  if (!token) throw new HttpError(401, 'Please log in');

  let payload;
  try {
    payload = jwt.verify(token, cfg.jwtSecret, { algorithms: ['HS256'] });
  } catch (err) {
    throw new HttpError(401, err.name === 'TokenExpiredError' ? 'Session expired. Please log in again.' : 'Invalid session. Please log in again.');
  }

  const isDriver = payload.role === 'driver';
  if (kind && (kind === 'driver') !== isDriver) throw new HttpError(401, 'Invalid session. Please log in again.');

  const Model = isDriver ? Driver : User;
  const account = await Model.findById(payload.sub).select('+tokenVersion');
  if (!account || account.active === false || (account.tokenVersion || 0) !== payload.tv) {
    throw new HttpError(401, 'Session is no longer valid. Please log in again.');
  }

  // The role comes from the stored account, never from the client.
  req.auth = { id: String(account._id), role: isDriver ? 'driver' : account.role, kind: kindOf(isDriver ? 'driver' : 'user'), account };
  next();
});

const requireRole = (...roles) => [
  authenticate,
  (req, res, next) => (roles.includes(req.auth.role) ? next() : next(new HttpError(403, 'You do not have access to this resource')))
];

module.exports = {
  COOKIE_NAMES, kindOf, issueSession, clearSession, authenticate,
  authAny: authenticate,
  driverOnly: requireRole('driver'),
  studentOnly: requireRole('student'),
  passengerOnly: requireRole('student', 'staff'),
  adminOnly: requireRole('admin')
};
