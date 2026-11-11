'use strict';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const { Types } = require('mongoose');
const cfg = require('../config');
const User = require('../models/User');
const Booking = require('../models/Booking');
const Notification = require('../models/Notification');
const Vehicle = require('../models/Vehicle');
const service = require('../services/bookings');
const serialize = require('../services/serialize');
const { errorHandler } = require('../middleware/errors');
const app = express().use(express.json()).use('/wallet', require('../routes/wallet'))
  .use('/api', require('../routes/bookings')).use(errorHandler);

function sessions(t) {
  const users = new Map();
  t.mock.method(User, 'findById', (id) => ({ select: async () => users.get(String(id)) }));
  return (role) => {
    const id = String(new Types.ObjectId());
    users.set(id, { _id: id, role, active: true, walletBalance: 0 });
    const token = jwt.sign({ sub: id, role: 'user', tv: 0 }, cfg.jwtSecret);
    return (req) => req.set('Authorization', 'Bearer ' + token);
  };
}

test('requesting credit requires a student and a positive whole amount; submitting gives no credit', async (t) => {
  const login = sessions(t), student = login('student'), staff = login('staff');
  let pending;
  t.mock.method(User, 'findOneAndUpdate', async (filter, update) => {
    assert.equal(filter.role, 'student');
    assert.deepEqual(filter['walletRequest.status'], { $ne: 'pending' });
    assert.equal(update.$inc, undefined);
    if (pending) return null;
    pending = update.$set.walletRequest;
    return { walletBalance: 30, walletRequest: pending };
  });
  const post = (who, amount) => who(request(app).post('/wallet/requests')).send({ amount });
  assert.equal((await post(staff, 100)).status, 403);
  for (const amount of [0, -5, 2.5, 100001]) assert.equal((await post(student, amount)).status, 400);
  const res = await post(student, 100);
  assert.equal(res.status, 201);
  assert.equal(res.body.balance, 30);
  assert.equal(res.body.request.status, 'pending');
  assert.equal((await post(student, 100)).status, 409);
});

for (const decision of ['approved', 'rejected']) {
  test('only one admin decision can take effect: ' + decision, async (t) => {
    const login = sessions(t), admin = login('admin'), second = login('admin'), student = login('student');
    const id = String(new Types.ObjectId()), studentId = String(new Types.ObjectId());
    let balance = 50, pending = true;
    t.mock.method(User, 'findOne', () => ({ select: async () => pending ? { _id: studentId, walletRequest: { amount: 125 } } : null }));
    t.mock.method(User, 'updateOne', async (filter, update) => {
      assert.equal(filter._id, studentId);
      assert.equal(filter['walletRequest._id'], id);
      assert.equal(filter['walletRequest.status'], 'pending');
      if (!pending) return { modifiedCount: 0 };
      pending = false;
      assert.equal(update.$set['walletRequest.status'], decision);
      balance += update.$inc?.walletBalance || 0;
      return { modifiedCount: 1 };
    });
    const review = (who) => who(request(app).patch('/wallet/requests/' + id)).send({ status: decision, amount: 9999 });
    assert.equal((await review(student)).status, 403);
    const results = await Promise.all([review(admin), review(second)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal(balance, decision === 'approved' ? 175 : 50);
  });
}

test('fare estimates use the signed-in role and students cannot request staff pricing', async (t) => {
  const login = sessions(t), student = login('student'), staff = login('staff');
  const trip = { pickupLocation: { lat: 31.4, lng: 75.5 }, dropLocation: { lat: 31.41, lng: 75.51 }, seats: 2, role: 'staff' };
  const estimate = (who) => who(request(app).post('/api/fare/estimate')).send(trip);
  assert.deepEqual((await estimate(staff)).body.options, { auto: 0, bus: 0 });
  assert.ok((await estimate(student)).body.options.auto > 0);
  assert.equal((await student(request(app).post('/api/booking')).send({ ...trip, paymentMethod: 'staff' })).status, 400);
});

test('an existing accepted staff booking completes for free even with an old wallet fare', async (t) => {
  const original = { user: { role: 'staff' }, status: 'accepted', paymentMethod: 'wallet' };
  t.mock.method(Booking, 'findOne', () => ({ select: () => ({ populate: async () => original }) }));
  t.mock.method(Booking, 'findOneAndUpdate', async (filter, fields) => ({ ...original, ...fields, seats: 1, vehicle: 'v' }));
  t.mock.method(Vehicle, 'updateOne', async () => ({}));
  t.mock.method(Notification, 'create', async () => ({}));
  t.mock.method(Booking, 'find', () => ({ sort: () => ({ limit: () => ({ select: async () => [] }) }) }));
  const debit = t.mock.method(User, 'findOneAndUpdate', async () => ({}));
  const result = await service.completeBooking('ride', 'driver');
  assert.equal(result.fare, 0);
  assert.equal(result.paymentStatus, 'waived');
  assert.equal(result.paymentMethod, 'staff');
  assert.equal(debit.mock.callCount(), 0);
  assert.equal(serialize.profile({ walletBalance: 90 }, 'staff').walletBalance, undefined);
});
