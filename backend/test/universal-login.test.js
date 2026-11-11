'use strict';
process.env.NODE_ENV = 'test';
process.env.EMAIL_VERIFICATION_REQUIRED = 'true';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Driver = require('../models/Driver');
const signIn = require('../routes/sign-in');
const { errorHandler } = require('../middleware/errors');

const app = express().use(express.json()).use('/api/sign-in', signIn).use(errorHandler);
const email = 'campus@example.test';
const password = 'MyDemoPass42';
const hash = bcrypt.hashSync(password, 4);
const account = { _id: '1', email, password: hash, emailVerified: true };
function records(t, user, driver) {
  for (const [Model, record] of [[User, user], [Driver, driver]]) {
    t.mock.method(Model, 'findOne', (filter) => {
      assert.equal(filter.email, email);
      if (Model === Driver) assert.equal(filter.role, undefined);
      return { select: async () => filter.role && record?.role !== filter.role ? null : record };
    });
  }
}
const login = (role) => request(app).post('/api/sign-in').send({ email, password, role });

for (const role of ['student', 'staff', 'admin', 'driver']) {
  test('email and password sign in a ' + role, async (t) => {
    records(t, role === 'driver' ? null : { ...account, role }, role === 'driver' ? account : null);
    const res = await login();
    assert.equal(res.status, 200);
    assert.equal(res.body.user.role, role);
    assert.match(res.headers['set-cookie'][0], role === 'driver' ? /^ev_driver=/ : /^ev_user=/);
  });
}
test('shared email uses the matching password and rejects ambiguous credentials', async (t) => {
  const driver = { ...account, password: bcrypt.hashSync('DifferentPass42', 4) };
  records(t, { ...account, role: 'staff' }, driver);
  assert.equal((await login()).body.user.role, 'staff');
  driver.password = hash;
  const res = await login();
  assert.equal(res.status, 409);
  assert.equal(res.headers['set-cookie'], undefined);
});
test('Book a ride signs in only the selected role, including when both account types share credentials', async (t) => {
  const passenger = { ...account, role: 'student' };
  records(t, passenger, account);
  for (const role of ['student', 'driver', 'staff', 'admin']) {
    if (role !== 'driver') passenger.role = role;
    const res = await login(role);
    assert.equal(res.status, 200);
    assert.equal(res.body.user.role, role);
    assert.match(res.headers['set-cookie'][0], role === 'driver' ? /^ev_driver=/ : /^ev_user=/);
  }
  passenger.role = 'student';
  for (const role of ['staff', 'admin', 'unknown']) {
    const res = await login(role);
    assert.equal(res.status, 400);
    assert.equal(res.headers['set-cookie'], undefined);
  }
});
test('disabled, locked and unverified accounts cannot start a session', async (t) => {
  const driver = { ...account, active: false };
  records(t, null, driver);
  assert.equal((await login()).status, 403);
  driver.active = true;
  driver.lockUntil = new Date(Date.now() + 60000);
  assert.equal((await login()).status, 429);
  delete driver.lockUntil;
  driver.emailVerified = false;
  const res = await login();
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'EMAIL_NOT_VERIFIED');
  assert.equal(res.body.verificationType, 'driver');
  assert.equal(res.headers['set-cookie'], undefined);
});
test('incorrect password counts as a failed attempt', async (t) => {
  records(t, { ...account, role: 'staff' }, null);
  const increment = t.mock.method(User, 'findOneAndUpdate', () => ({ select: async () => ({ failedLogins: 1 }) }));
  const res = await request(app).post('/api/sign-in').send({ email, password: 'wrong' });
  assert.equal(res.status, 400);
  assert.equal(res.headers['set-cookie'], undefined);
  assert.equal(increment.mock.callCount(), 1);
});
