'use strict';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Types } = require('mongoose');
const cfg = require('../config');
const accounts = require('../routes/accounts');
const adminRoutes = require('../routes/admin');
const { errorHandler } = require('../middleware/errors');
const User = require('../models/User');
const Driver = require('../models/Driver');
const Booking = require('../models/Booking');
const Vehicle = require('../models/Vehicle');
const Notification = require('../models/Notification');

const app = express().use(express.json()).use('/accounts', accounts).use('/admin', adminRoutes).use(errorHandler);
const password = 'SamplePass42';
const hash = bcrypt.hashSync(password, 4);

function loginFixture(t, role) {
  const id = String(new Types.ObjectId());
  const model = role === 'driver' ? Driver : User;
  const account = { _id: id, role, active: true, password: hash };
  t.mock.method(model, 'findById', () => ({ select: async () => account }));
  const token = jwt.sign({ sub: id, role: role === 'driver' ? 'driver' : 'user', tv: 0 }, cfg.jwtSecret);
  const auth = (req) => req.set('Authorization', 'Bearer ' + token);
  return { id, model, account, auth };
}

for (const role of ['student', 'staff', 'driver']) {
  test(role + ' can delete their own account and clear the matching session', async (t) => {
    const { id, model, account, auth } = loginFixture(t, role);
    t.mock.method(model, 'findOne', () => ({ select: async () => account }));
    let token;
    t.mock.method(model, 'findOneAndUpdate', async (filter, update) => {
      assert.equal(filter._id, id);
      assert.equal(filter.password, hash);
      token = update.$set.deletionToken;
      return account;
    });
    t.mock.method(Booking, 'exists', async (filter) => {
      assert.equal(filter[role === 'driver' ? 'driver' : 'user'], id);
      return null;
    });
    const vehicles = t.mock.method(Vehicle, 'updateMany', async () => ({}));
    const notifications = t.mock.method(Notification, 'deleteMany', async () => ({}));
    t.mock.method(model, 'deleteOne', async (filter) => {
      assert.equal(filter.deletionToken, token);
      return { deletedCount: 1 };
    });
    const res = await auth(request(app).delete('/accounts/me')).send({ password });
    assert.equal(res.status, 200);
    assert.ok(res.headers['set-cookie'][0].startsWith(role === 'driver' ? 'ev_driver=;' : 'ev_user=;'));
    assert.equal(vehicles.mock.callCount(), role === 'driver' ? 1 : 0);
    assert.equal(notifications.mock.calls[0].arguments[0].recipient, id);
  });
}

test('self-deletion checks password before marking an account', async (t) => {
  const { model, account, auth } = loginFixture(t, 'student');
  t.mock.method(model, 'findOne', () => ({ select: async () => account }));
  const mark = t.mock.method(model, 'findOneAndUpdate', async () => null);
  const res = await auth(request(app).delete('/accounts/me')).send({ password: 'wrong' });
  assert.equal(res.status, 400);
  assert.equal(mark.mock.callCount(), 0);
});

test('an admin can remove a disabled passenger but cannot target another admin through passenger deletion', async (t) => {
  const { id, auth } = loginFixture(t, 'admin');
  const target = String(new Types.ObjectId());
  t.mock.method(User, 'findOneAndUpdate', async (filter) => {
    assert.deepEqual(filter.role.$in, ['student', 'staff']);
    assert.equal(filter.active, undefined);
    return filter._id === target ? { _id: target, active: false } : null;
  });
  t.mock.method(Booking, 'exists', async () => null);
  t.mock.method(Notification, 'deleteMany', async () => ({}));
  t.mock.method(User, 'deleteOne', async () => ({ deletedCount: 1 }));
  assert.equal((await auth(request(app).delete('/accounts/passengers/' + target))).status, 200);
  assert.equal((await auth(request(app).delete('/accounts/passengers/' + id))).status, 404);
});

test('outstanding rides or payments keep account and fleet intact', async (t) => {
  const { model, account, auth } = loginFixture(t, 'driver');
  t.mock.method(model, 'findOne', () => ({ select: async () => account }));
  t.mock.method(model, 'findOneAndUpdate', async () => account);
  t.mock.method(Booking, 'exists', async (filter) => {
    assert.deepEqual(filter.$or[0].status.$in, ['requested', 'accepted']);
    assert.deepEqual(filter.$or[1].paymentStatus.$in, ['pending', 'due']);
    return { _id: new Types.ObjectId() };
  });
  const release = t.mock.method(model, 'updateOne', async () => ({}));
  const remove = t.mock.method(model, 'deleteOne', async () => ({}));
  const unassign = t.mock.method(Vehicle, 'updateMany', async () => ({}));
  assert.equal((await auth(request(app).delete('/accounts/me')).send({ password })).status, 409);
  assert.equal(release.mock.callCount(), 1);
  assert.equal(remove.mock.callCount(), 0);
  assert.equal(unassign.mock.callCount(), 0);
});

test('admin can create multiple distinct admin logins and duplicate email is rejected', async (t) => {
  const { auth } = loginFixture(t, 'admin');
  const created = new Map();
  t.mock.method(User, 'exists', async ({ email }) => created.has(email));
  t.mock.method(User, 'create', async (fields) => {
    assert.equal(fields.role, 'admin');
    assert.ok(await bcrypt.compare(password, fields.password));
    const account = { ...fields, _id: new Types.ObjectId() };
    created.set(fields.email, account);
    return account;
  });
  for (const [email, status] of [['admin2@example.test', 201], ['admin3@example.test', 201], ['admin2@example.test', 409]]) {
    const res = await auth(request(app).post('/accounts/admins')).send({ name: 'Campus administrator', email, password });
    assert.equal(res.status, status);
    assert.equal(res.body.password, undefined);
  }
});

test('passenger management permissions and enable/disable controls', async (t) => {
  const { auth, account } = loginFixture(t, 'student');
  assert.equal((await auth(request(app).post('/accounts/admins')).send({})).status, 403);
  assert.equal((await auth(request(app).delete('/accounts/passengers/' + account._id))).status, 403);
  assert.equal((await auth(request(app).delete('/accounts/drivers/' + account._id))).status, 403);
  account.role = 'admin';
  assert.equal((await auth(request(app).delete('/accounts/me')).send({ password })).status, 403);
  t.mock.method(User, 'findOneAndUpdate', async (filter, update) => {
    assert.deepEqual(filter.role.$in, ['student', 'staff']);
    if (!update.active) assert.equal(update.$inc.tokenVersion, 1);
    return { active: update.active };
  });
  for (const active of [false, true]) {
    assert.equal((await auth(request(app).patch('/admin/users/' + new Types.ObjectId())).send({ active })).status, 200);
  }
});

test('admin deletes an idle driver and releases vehicles only after rides and payments are resolved', async (t) => {
  const { auth } = loginFixture(t, 'admin');
  const target = String(new Types.ObjectId());
  t.mock.method(Driver, 'findOneAndUpdate', async (filter) => {
    assert.deepEqual(filter, { _id: target });
    return { _id: target };
  });
  let outstanding = true;
  t.mock.method(Booking, 'exists', async ({ driver }) => {
    assert.equal(driver, target);
    return outstanding;
  });
  t.mock.method(Driver, 'updateOne', async () => ({}));
  const release = t.mock.method(Vehicle, 'updateMany', async () => ({}));
  t.mock.method(Notification, 'deleteMany', async () => ({}));
  const remove = t.mock.method(Driver, 'deleteOne', async () => ({ deletedCount: 1 }));
  const deleteDriver = () => auth(request(app).delete('/accounts/drivers/' + target));
  assert.equal((await deleteDriver()).status, 409);
  assert.equal(release.mock.callCount(), 0);
  assert.equal(remove.mock.callCount(), 0);
  outstanding = false;
  assert.equal((await deleteDriver()).status, 200);
  assert.deepEqual(release.mock.calls[0].arguments, [{ driver: target }, { $unset: { driver: 1 } }]);
  assert.equal(remove.mock.callCount(), 1);
});
