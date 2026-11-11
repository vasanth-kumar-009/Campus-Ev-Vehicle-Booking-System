process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'unit-test-secret-unit-test-secret-1234';
const test = require('node:test');
const assert = require('node:assert/strict');

const v = require('../utils/validate');
const { haversineKm, isValidCoord, withinArea } = require('../utils/geo');
const { calculateFare } = require('../services/fare');
const { canTransition, TRANSITIONS } = require('../services/bookings');
const { hashToken, makeToken } = require('../utils/tokens');
const log = require('../utils/logger');

test('validators accept good input and reject bad input', () => {
  assert.equal(v.email(' Student@Example.COM '), 'student@example.com');
  assert.throws(() => v.email('nope'), /valid email/);
  assert.equal(v.password('abcdef12'), 'abcdef12');
  assert.throws(() => v.password('short1'), /at least 8/);
  assert.throws(() => v.password('onlyletters'), /letter and one number/);
  assert.throws(() => v.password('a1'.repeat(40)), /72 bytes/);
  assert.equal(v.plate('ka-01 ab 1234'), 'KA-01 AB 1234');
  assert.throws(() => v.plate('<script>'), /Number plate/);
  assert.throws(() => v.oneOf('admin', ['student', 'staff'], 'Role'), /Role must be one of/);
  assert.throws(() => v.int(0, 'Seats', { min: 1, max: 5 }), /Seats/);
  assert.throws(() => v.int('2', 'Seats', { min: 1, max: 5 }), /Seats/); // strings are rejected
  assert.throws(() => v.objectId('123'), /Invalid/);
  assert.throws(() => v.coord({ lat: 91, lng: 0 }, 'p'), /lat/);
  assert.throws(() => v.coord({ lat: '12', lng: 77 }, 'p'), /lat/);
  assert.deepEqual(v.coord({ lat: 12.9, lng: 77.5, extra: 1 }, 'p'), { lat: 12.9, lng: 77.5 });
});

test('geo helpers', () => {
  assert.ok(Math.abs(haversineKm({ lat: 0, lng: 0 }, { lat: 0, lng: 1 }) - 111.19) < 0.5);
  assert.equal(haversineKm({ lat: 12, lng: 77 }, { lat: 12, lng: 77 }), 0);
  assert.ok(isValidCoord({ lat: 12, lng: 77 }));
  assert.ok(!isValidCoord({ lat: NaN, lng: 77 }));
  assert.ok(!isValidCoord({ lat: 12, lng: 181 }));
  assert.ok(withinArea({ lat: 12, lng: 77 }, null));
  assert.ok(!withinArea({ lat: 13, lng: 77 }, { lat: 12, lng: 77, radiusKm: 5 }));
});

test('fare: minimum, per-km and per-seat on shared vehicles', () => {
  const fares = { auto: { base: 20, perKm: 10, min: 30 }, bus: { base: 5, perKm: 2, min: 10 } };
  assert.equal(calculateFare({ type: 'auto', distanceKm: 0.1 }, fares), 30);      // minimum applies
  assert.equal(calculateFare({ type: 'auto', distanceKm: 3 }, fares), 50);        // 20 + 30
  assert.equal(calculateFare({ type: 'bus', distanceKm: 3, seats: 4, shared: true }, fares), 44); // 11 * 4
  assert.equal(calculateFare({ type: 'auto', distanceKm: 3, seats: 3, shared: false }, fares), 50); // autos: per ride
});

test('booking state machine allows only legal transitions', () => {
  assert.ok(canTransition('requested', 'accepted'));
  assert.ok(canTransition('accepted', 'completed'));
  assert.ok(canTransition('accepted', 'cancelled'));
  assert.ok(!canTransition('requested', 'completed'));  // cannot skip accept
  assert.ok(!canTransition('completed', 'accepted'));   // terminal
  assert.ok(!canTransition('cancelled', 'accepted'));
  for (const s of ['completed', 'cancelled', 'expired']) assert.equal(TRANSITIONS[s].length, 0);
});

test('tokens are random and only their hash is comparable', () => {
  const a = makeToken(1000); const b = makeToken(1000);
  assert.notEqual(a.token, b.token);
  assert.equal(hashToken(a.token), a.hash);
  assert.notEqual(a.token, a.hash);
});

test('logger scrubs credentials', () => {
  assert.equal(log.scrub('mongodb+srv://user:p%40ss@cluster0.x.mongodb.net/db'), 'mongodb+srv://***:***@cluster0.x.mongodb.net/db');
  assert.ok(!log.scrub('Authorization: Bearer abc.def.ghi').includes('abc.def'));
});
