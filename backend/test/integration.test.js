/**
 * End-to-end tests against a real MongoDB.
 * Run:  MONGODB_TEST_URI=mongodb://127.0.0.1:27017/campus-ev-test npm test
 * Skipped automatically when MONGODB_TEST_URI is not set. The test database is DROPPED afterwards.
 */
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'integration-test-secret-integration-1234';
const URI = process.env.MONGODB_TEST_URI;
const test = require('node:test');
const assert = require('node:assert/strict');

if (!URI) {
  test('integration tests (skipped: set MONGODB_TEST_URI)', { skip: true }, () => {});
} else {
  const mongoose = require('mongoose');
  const request = require('supertest');
  const bcrypt = require('bcryptjs');
  process.env.MONGODB_URI = URI;
  const cfg = require('../config');
  const { createApp } = require('../app');
  const maintenance = require('../services/maintenance');
  const svc = require('../services/bookings');
  const { makeToken } = require('../utils/tokens');
  const User = require('../models/User');
  const Driver = require('../models/Driver');
  const Vehicle = require('../models/Vehicle');
  const Booking = require('../models/Booking');

  const app = createApp();
  const C = { lat: 12.9716, lng: 77.5946 };
  const GATE = { lat: 12.9716, lng: 77.5946 };
  const HALL = { lat: 12.9728, lng: 77.5955 };
  const PW = 'Passw0rdOK';
  const noSecrets = (res) => assert.ok(!/\$2[aby]\$|"password"|tokenVersion|verifyTokenHash|resetTokenHash/.test(JSON.stringify(res.body)), 'response leaked a secret field');

  // A browser-like client: keeps cookies and always sends the X-Session header.
  function client(session) {
    const agent = request.agent(app);
    const wrap = (m) => (url) => agent[m](url).set('X-Session', session);
    return { get: wrap('get'), post: wrap('post'), put: wrap('put'), patch: wrap('patch'), delete: wrap('delete'), raw: agent };
  }

  async function registerAndLogin(role, n, extra = {}) {
    const email = `${role}${n}@test.com`;
    const c = client(role === 'driver' ? 'driver' : 'user');
    const reg = await c.post('/api/auth/register').send({ name: `${role} ${n}`, email, password: PW, role, ...extra });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    const login = await c.post('/api/auth/login').send({ email, password: PW, type: role === 'driver' ? 'driver' : 'passenger' });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    return { c, user: login.body.user, email };
  }

  const goOnline = (d, loc = C) => d.c.post('/api/driver/online').send({ online: true, location: loc });
  const book = (p, body = {}) => p.c.post('/api/booking').send({ pickupName: 'Gate', dropName: 'Hall', pickupLocation: GATE, dropLocation: HALL, ...body });

  test.before(async () => {
    await mongoose.connect(URI);
    await mongoose.connection.dropDatabase();
    await maintenance.ensureIndexes();
  });
  test.after(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  test.beforeEach(async () => {
    for (const m of [Booking]) await m.deleteMany({});
    await Vehicle.updateMany({}, { reservedSeats: 0 });
    await Driver.updateMany({}, { status: 'offline' });
  });

  let p1, p2, p3, d1, d2, admin;

  test('registration validates input and never allows admin self-registration', async () => {
    const c = client('user');
    const weak = await c.post('/api/auth/register').send({ name: 'Weak', email: 'weak@test.com', password: 'abc', role: 'student' });
    assert.equal(weak.status, 400);
    const adm = await c.post('/api/auth/register').send({ name: 'Evil', email: 'evil@test.com', password: PW, role: 'admin' });
    assert.equal(adm.status, 400);
    const noPlate = await c.post('/api/auth/register').send({ name: 'Drv', email: 'drvx@test.com', password: PW, role: 'driver' });
    assert.equal(noPlate.status, 400);

    p1 = await registerAndLogin('student', 1);
    p2 = await registerAndLogin('staff', 2);
    p3 = await registerAndLogin('student', 3);
    d1 = await registerAndLogin('driver', 1, { vehicleType: 'auto', plate: 'KA01AB1234' });
    d2 = await registerAndLogin('driver', 2, { vehicleType: 'bus', plate: 'KA01BUS200', capacity: 20 });

    const dup = await client('user').post('/api/auth/register').send({ name: 'Dup', email: p1.email, password: PW, role: 'student' });
    assert.equal(dup.status, 400);
    const dupPlate = await client('driver').post('/api/auth/register').send({ name: 'D3', email: 'd3@test.com', password: PW, role: 'driver', vehicleType: 'auto', plate: 'ka01ab1234' });
    assert.equal(dupPlate.status, 400);

    await User.create({ name: 'Admin', email: 'admin@test.com', role: 'admin', password: await bcrypt.hash(PW, 4) });
    admin = client('user');
    assert.equal((await admin.post('/api/auth/login').send({ email: 'admin@test.com', password: PW, type: 'passenger' })).status, 200);
  });

  test('every driver gets a vehicle automatically', async () => {
    const me = await d1.c.get('/api/driver/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.vehicles.length, 1);
    assert.equal(me.body.vehicles[0].plate, 'KA01AB1234');
    assert.equal(me.body.driver.activeVehicle, me.body.vehicles[0]._id);
    noSecrets(me);
  });

  test('login: role comes from the database, not the client; cookie is HttpOnly', async () => {
    // a student cannot log in as a driver and a driver cannot log in as a passenger
    assert.equal((await client('driver').post('/api/auth/login').send({ email: p1.email, password: PW, type: 'driver' })).status, 400);
    assert.equal((await client('user').post('/api/auth/login').send({ email: d1.email, password: PW, type: 'student' })).status, 400);
    const res = await client('user').post('/api/auth/login').send({ email: p2.email, password: PW, type: 'student' });
    assert.equal(res.body.user.role, 'staff'); // client said "student", DB says staff
    const cookie = res.headers['set-cookie'].join(';');
    assert.match(cookie, /ev_user=/);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
    assert.equal(res.body.token, undefined); // no token in the JSON body
    noSecrets(res);
    assert.equal((await client('user').post('/api/auth/login').send({ email: p1.email, password: PW, type: 'robot' })).status, 400);
  });

  test('driver and passenger sessions coexist in one browser (separate cookies)', async () => {
    const both = request.agent(app);
    await both.post('/api/auth/login').set('X-Session', 'driver').send({ email: d1.email, password: PW, type: 'driver' });
    await both.post('/api/auth/login').set('X-Session', 'user').send({ email: p1.email, password: PW, type: 'passenger' });
    assert.equal((await both.get('/api/auth/me').set('X-Session', 'driver')).body.user.role, 'driver');
    assert.equal((await both.get('/api/auth/me').set('X-Session', 'user')).body.user.role, 'student');
  });

  test('unauthenticated, wrong-role and cross-site requests are rejected', async () => {
    assert.equal((await request(app).get('/api/auth/me')).status, 401);
    assert.equal((await request(app).get('/api/auth/me').set('X-Session', 'user')).status, 401);
    assert.equal((await p1.c.get('/api/admin/stats')).status, 403);
    assert.equal((await p1.c.get('/api/driver/rides')).status, 403); // a student is not a driver
    assert.equal((await d1.c.post('/api/booking').send({})).status, 403);
    const evil = await p1.c.post('/api/booking').set('Origin', 'https://evil.example').send({});
    assert.equal(evil.status, 403);
    // cookie auth without the custom header must not work (CSRF)
    assert.equal((await p1.c.raw.get('/api/auth/me')).status, 401);
  });

  test('unknown API paths return JSON 404, never HTML', async () => {
    const res = await request(app).get('/api/does-not-exist');
    assert.equal(res.status, 404);
    assert.match(res.headers['content-type'], /json/);
  });

  test('health endpoint reveals no connection details', async () => {
    const res = await request(app).get('/api/health');
    assert.deepEqual(Object.keys(res.body).sort(), ['database', 'status']);
  });

  test('input validation: coordinates, seats, same pickup/drop', async () => {
    assert.equal((await book(p1, { pickupLocation: { lat: 999, lng: 0 } })).status, 400);
    assert.equal((await book(p1, { pickupLocation: { lat: '12', lng: 77 } })).status, 400);
    assert.equal((await book(p1, { dropLocation: GATE })).status, 400);
    assert.equal((await book(p1, { seats: 0 })).status, 400);
    assert.equal((await book(p1, { vehicleType: 'auto', seats: 5 })).status, 400);
    assert.equal((await book(p1, { vehicleType: 'rocket' })).status, 400);
    assert.equal((await d1.c.post('/api/location/update').send({ lat: 'x', lng: 1 })).status, 400);
  });

  test('driver must share a location to go online', async () => {
    await Driver.updateOne({ email: d1.email }, { $unset: { geo: 1, locationUpdatedAt: 1 } });
    assert.equal((await d1.c.post('/api/driver/online').send({ online: true })).status, 400);
    assert.equal((await goOnline(d1)).status, 200);
  });

  test('fare estimate', async () => {
    const res = await p1.c.post('/api/fare/estimate').send({ pickupLocation: GATE, dropLocation: HALL, seats: 2 });
    assert.equal(res.status, 200);
    assert.ok(res.body.distanceKm > 0 && res.body.etaMinutes >= 1);
    assert.ok(res.body.options.auto >= cfg.fares.auto.min);
  });

  test('happy path: request -> offered -> accept -> track -> complete (cash)', async () => {
    await goOnline(d1);
    const created = await book(p1, { vehicleType: 'auto' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    noSecrets(created);
    const bk = created.body.booking;
    assert.equal(bk.status, 'requested');
    assert.equal(bk.driver.name, 'driver 1');
    assert.equal(bk.vehicle.plate, 'KA01AB1234');
    assert.ok(bk.fare >= cfg.fares.auto.min);

    // location is private until the ride is accepted, and only for the owner
    assert.equal((await p1.c.get(`/api/booking/${bk._id}/driver-location`)).body.available, false);

    const rides = await d1.c.get('/api/driver/rides');
    assert.equal(rides.body.pending.length, 1);
    assert.equal(rides.body.pending[0].user.name, 'student 1');
    noSecrets(rides);

    assert.equal((await d1.c.put(`/api/booking/${bk._id}/status`).send({ status: 'completed' })).status, 409); // cannot skip accept
    const acc = await d1.c.put(`/api/booking/${bk._id}/status`).send({ status: 'accepted' });
    assert.equal(acc.status, 200);
    assert.equal(acc.body.booking.status, 'accepted');

    await d1.c.post('/api/location/update').send({ lat: 12.9720, lng: 77.5950 });
    const loc = await p1.c.get(`/api/booking/${bk._id}/driver-location`);
    assert.equal(loc.body.available, true);
    assert.equal(loc.body.location.lat, 12.972);
    assert.ok(loc.body.etaToPickupMinutes >= 1);
    assert.equal((await p2.c.get(`/api/booking/${bk._id}/driver-location`)).status, 403); // another passenger
    assert.equal((await p2.c.get(`/api/booking/${bk._id}`)).status, 403);

    assert.equal((await d1.c.post('/api/driver/online').send({ online: false })).status, 409); // mid-ride
    const done = await d1.c.put(`/api/booking/${bk._id}/status`).send({ status: 'completed' });
    assert.equal(done.body.booking.status, 'completed');
    assert.equal(done.body.booking.paymentStatus, 'due');
    assert.equal((await d1.c.put(`/api/booking/${bk._id}/status`).send({ status: 'completed' })).status, 409); // not twice
    assert.equal((await p1.c.get(`/api/booking/${bk._id}/driver-location`)).body.available, false); // location closes

    const paid = await d1.c.post(`/api/booking/${bk._id}/cash-collected`).send({});
    assert.equal(paid.body.booking.paymentStatus, 'paid');
    assert.equal((await Vehicle.findOne({ plate: 'KA01AB1234' })).reservedSeats, 0);
    assert.equal((await Driver.findOne({ email: d1.email })).status, 'online'); // still online after completing

    const notes = await p1.c.get('/api/notifications');
    assert.ok(notes.body.some((n) => n.type === 'ride_accepted'));
    assert.ok(notes.body.some((n) => n.type === 'ride_completed'));
    await p1.c.post('/api/notifications/read').send({ ids: notes.body.map((n) => n._id) });
    assert.equal((await p1.c.get('/api/notifications')).body.length, 0);
  });

  test('concurrency: one auto, many simultaneous requests -> exactly one is offered the driver', async () => {
    await goOnline(d1);
    await Driver.updateOne({ email: d2.email }, { status: 'offline' });
    const passengers = [p1, p2, p3];
    const results = await Promise.all(passengers.map((p) => book(p, { vehicleType: 'auto' })));
    results.forEach((r) => assert.equal(r.status, 201, JSON.stringify(r.body)));
    const assigned = results.filter((r) => r.body.booking.driver);
    assert.equal(assigned.length, 1, 'exactly one booking should hold the auto');
    assert.equal((await Vehicle.findOne({ plate: 'KA01AB1234' })).reservedSeats, 1);

    // the other two wait; when the first ride is done, the next waiting one is offered the driver
    const first = assigned[0].body.booking;
    await d1.c.put(`/api/booking/${first._id}/status`).send({ status: 'accepted' });
    await d1.c.put(`/api/booking/${first._id}/status`).send({ status: 'completed' });
    const offered = await Booking.countDocuments({ status: 'requested', driver: { $ne: null } });
    assert.equal(offered, 1, 'a queued booking is offered right after the seat frees up');
    assert.equal((await Vehicle.findOne({ plate: 'KA01AB1234' })).reservedSeats, 1);
  });

  test('double-submit: a passenger cannot hold two open bookings', async () => {
    const [a, b] = await Promise.all([book(p1), book(p1)]);
    assert.deepEqual([a.status, b.status].sort(), [201, 409]);
    assert.equal(await Booking.countDocuments({ user: p1.user._id, status: { $in: ['requested', 'accepted'] } }), 1);
  });

  test('driver rejects -> ride is re-offered to the next nearest driver', async () => {
    await goOnline(d1);
    await goOnline(d2, { lat: 12.9730, lng: 77.5960 });
    const created = await book(p1);
    const first = created.body.booking.driver.name;
    const firstDriver = first === 'driver 1' ? d1 : d2;
    const otherDriver = first === 'driver 1' ? d2 : d1;
    const rej = await firstDriver.c.put(`/api/booking/${created.body.booking._id}/status`).send({ status: 'rejected' });
    assert.equal(rej.status, 200);
    const now = await p1.c.get(`/api/booking/${created.body.booking._id}`);
    assert.ok(now.body.driver && now.body.driver.name !== first, 'offered to the other driver');
    assert.equal((await otherDriver.c.get('/api/driver/rides')).body.pending.length, 1);
    assert.equal((await firstDriver.c.get('/api/driver/rides')).body.pending.length, 0);
    // the first driver can no longer touch it
    assert.equal((await firstDriver.c.put(`/api/booking/${created.body.booking._id}/status`).send({ status: 'accepted' })).status, 409);
    // nobody left -> stays queued instead of vanishing
    await otherDriver.c.put(`/api/booking/${created.body.booking._id}/status`).send({ status: 'rejected' });
    const queued = await p1.c.get(`/api/booking/${created.body.booking._id}`);
    assert.equal(queued.body.status, 'requested');
    assert.equal(queued.body.driver, null);
    await Booking.deleteMany({});
  });

  test('nearest driver is chosen using real geospatial distance', async () => {
    await goOnline(d1, { lat: 12.9800, lng: 77.6000 });   // ~1 km away
    await goOnline(d2, { lat: 12.9718, lng: 77.5948 });   // ~30 m away
    const created = await book(p1);
    assert.equal(created.body.booking.driver.name, 'driver 2');
  });

  test('offer timeout: unanswered offers are re-dispatched by the sweeper', async () => {
    await goOnline(d1);
    await Driver.updateOne({ email: d2.email }, { status: 'offline' });
    const created = await book(p1, { vehicleType: 'auto' });
    const id = created.body.booking._id;
    await Booking.updateOne({ _id: id }, { offerExpiresAt: new Date(Date.now() - 1000) });
    assert.equal((await d1.c.put(`/api/booking/${id}/status`).send({ status: 'accepted' })).status, 409); // too late
    await svc.sweep();
    const after = await Booking.findById(id);
    assert.ok(!after.driver, 'offer was taken back');
    assert.equal(after.status, 'requested');
    assert.equal((await Vehicle.findOne({ plate: 'KA01AB1234' })).reservedSeats, 0);
    // booking waiting too long expires
    await Booking.collection.updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $set: { createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000) } }); // createdAt is immutable in Mongoose
    await svc.sweep();
    assert.equal((await Booking.findById(id)).status, 'expired');
  });

  test('cancel: passenger can cancel; seats are released; others cannot', async () => {
    await goOnline(d1);
    await Driver.updateOne({ email: d2.email }, { status: 'offline' });
    const created = await book(p1, { vehicleType: 'auto' });
    const id = created.body.booking._id;
    assert.equal((await p2.c.post(`/api/booking/${id}/cancel`).send({})).status, 404); // not theirs
    const res = await p1.c.post(`/api/booking/${id}/cancel`).send({});
    assert.equal(res.body.booking.status, 'cancelled');
    assert.equal((await Vehicle.findOne({ plate: 'KA01AB1234' })).reservedSeats, 0);
    assert.equal((await p1.c.post(`/api/booking/${id}/cancel`).send({})).status, 409);
    assert.equal((await d1.c.put(`/api/booking/${id}/status`).send({ status: 'accepted' })).status, 409);
  });

  test('shared bus: seat inventory is enforced', async () => {
    await Driver.updateOne({ email: d1.email }, { status: 'offline' });
    await goOnline(d2);
    const a = await book(p1, { vehicleType: 'bus', seats: 12 });
    const b = await book(p2, { vehicleType: 'bus', seats: 8 });   // 12 + 8 = 20 -> fits exactly
    const c = await book(p3, { vehicleType: 'bus', seats: 1 });   // 21 > 20 -> must wait
    assert.ok(a.body.booking.driver && b.body.booking.driver);
    assert.equal(c.body.booking.driver, null);
    assert.equal((await Vehicle.findOne({ plate: 'KA01BUS200' })).reservedSeats, 20);
    assert.equal(b.body.booking.fare, 0);
    assert.equal(b.body.booking.paymentStatus, 'waived');
    // Student and staff reservations still share the same seat inventory.
    assert.ok(a.body.booking.fare > b.body.booking.fare);
  });

  test('student request is credited once across concurrent admin reviews; staff completes a free ride', async () => {
    const before = (await p1.c.get('/api/wallet/me')).body.balance;
    const created = await p1.c.post('/api/wallet/requests').send({ amount: 100 });
    assert.equal(created.status, 201);
    assert.equal(created.body.balance, before);
    const id = created.body.request._id;
    assert.ok((await admin.get('/api/wallet/requests')).body.some((row) => row.request._id === id));
    const decide = () => admin.patch('/api/wallet/requests/' + id).send({ status: 'approved' });
    const decisions = await Promise.all([decide(), decide()]);
    assert.deepEqual(decisions.map((r) => r.status).sort(), [200, 409]);
    const wallet = (await p1.c.get('/api/wallet/me')).body;
    assert.equal(wallet.balance, before + 100);
    assert.equal(wallet.request.status, 'approved');
    await goOnline(d1);
    const ride = await book(p2, { vehicleType: 'auto', paymentMethod: 'wallet' });
    assert.equal(ride.status, 201);
    assert.equal(ride.body.booking.fare, 0);
    const statusUrl = '/api/booking/' + ride.body.booking._id + '/status';
    assert.equal((await d1.c.put(statusUrl).send({ status: 'accepted' })).status, 200);
    const done = await d1.c.put(statusUrl).send({ status: 'completed' });
    assert.equal(done.body.booking.paymentStatus, 'waived');
    assert.equal((await d1.c.get('/api/driver/rides')).body.unpaid.length, 0);
  });

  test('wallet: charged exactly once on completion; insufficient balance is refused', async () => {
    await goOnline(d1);
    await Driver.updateOne({ email: d2.email }, { status: 'offline' });
    await User.updateOne({ email: p1.email }, { walletBalance: 0 });
    assert.equal((await book(p1, { vehicleType: 'auto', paymentMethod: 'wallet' })).status, 402);

    assert.equal((await admin.post(`/api/admin/users/${p1.user._id}/wallet`).send({ amount: 500 })).body.walletBalance, 500);
    const created = await book(p1, { vehicleType: 'auto', paymentMethod: 'wallet' });
    const id = created.body.booking._id;
    const fare = created.body.booking.fare;
    await d1.c.put(`/api/booking/${id}/status`).send({ status: 'accepted' });
    await Promise.all([
      d1.c.put(`/api/booking/${id}/status`).send({ status: 'completed' }),
      d1.c.put(`/api/booking/${id}/status`).send({ status: 'completed' })
    ]);
    const done = await Booking.findById(id);
    assert.equal(done.paymentStatus, 'paid');
    assert.equal((await User.findOne({ email: p1.email })).walletBalance, 500 - fare, 'charged once, not twice');
    assert.equal((await p1.c.get('/api/auth/me')).body.user.walletBalance, 500 - fare);
  });

  test('admin: vehicle management, driver disable, bookings list', async () => {
    const stats = await admin.get('/api/admin/stats');
    assert.equal(stats.status, 200);
    assert.ok(stats.body.drivers >= 2);

    const drvList = await admin.get('/api/admin/drivers');
    noSecrets(drvList);
    const d3 = await registerAndLogin('driver', 3, { vehicleType: 'auto', plate: 'KA09ZZ0001' });
    const dId = (await d3.c.get('/api/driver/me')).body.driver._id;

    const spare = await admin.post('/api/admin/vehicles').send({ type: 'bus', plate: 'spare 1', capacity: 30, driverId: dId });
    assert.equal(spare.status, 201);
    assert.equal(spare.body.vehicle.plate, 'SPARE 1');
    assert.equal(spare.body.vehicle.shared, true);
    assert.equal((await admin.post('/api/admin/vehicles').send({ type: 'bus', plate: 'SPARE 1' })).status, 409); // duplicate plate

    // vehicle selection UI backend: driver picks between their vehicles
    const mine = await d3.c.get('/api/driver/vehicles');
    assert.equal(mine.body.vehicles.length, 2);
    const sel = await d3.c.post('/api/driver/vehicle').send({ vehicleId: spare.body.vehicle._id });
    assert.equal(sel.status, 200);
    assert.equal((await d3.c.get('/api/driver/me')).body.driver.activeVehicle, spare.body.vehicle._id);
    assert.equal((await d3.c.post('/api/driver/vehicle').send({ vehicleId: String(new mongoose.Types.ObjectId()) })).status, 404);

    const upd = await admin.put(`/api/admin/vehicles/${spare.body.vehicle._id}`).send({ capacity: 25 });
    assert.equal(upd.body.vehicle.capacity, 25);
    assert.equal((await admin.delete(`/api/admin/vehicles/${spare.body.vehicle._id}`)).status, 200);

    // disabling a driver kills their session immediately
    assert.equal((await d3.c.get('/api/driver/me')).status, 200);
    assert.equal((await admin.patch(`/api/admin/drivers/${dId}`).send({ active: false })).status, 200);
    assert.equal((await d3.c.get('/api/driver/me')).status, 401);
    assert.equal((await client('driver').post('/api/auth/login').send({ email: d3.email, password: PW, type: 'driver' })).status, 403);

    const bookings = await admin.get('/api/admin/bookings');
    assert.equal(bookings.status, 200);
    noSecrets(bookings);
  });

  test('sessions: logout-all revokes tokens; password reset flow; lockout', async () => {
    const s = client('user');
    await s.post('/api/auth/login').send({ email: p3.email, password: PW, type: 'student' });
    assert.equal((await s.get('/api/auth/me')).status, 200);
    await s.post('/api/auth/logout-all').send({});
    assert.equal((await s.get('/api/auth/me')).status, 401);
    // an old cookie from before logout-all no longer works anywhere
    assert.equal((await p3.c.get('/api/auth/me')).status, 401);

    // reset: token is single-use, expires, and revokes old sessions
    const { token, hash, expires } = makeToken(60000);
    await User.updateOne({ email: p3.email }, { resetTokenHash: hash, resetTokenExpires: expires });
    assert.equal((await client('user').post('/api/auth/reset-password').send({ token, type: 'user', password: 'short' })).status, 400);
    assert.equal((await client('user').post('/api/auth/reset-password').send({ token, type: 'user', password: 'NewPassw0rd' })).status, 200);
    assert.equal((await client('user').post('/api/auth/reset-password').send({ token, type: 'user', password: 'Another0ne' })).status, 400); // single use
    assert.equal((await client('user').post('/api/auth/login').send({ email: p3.email, password: PW, type: 'student' })).status, 400);
    assert.equal((await client('user').post('/api/auth/login').send({ email: p3.email, password: 'NewPassw0rd', type: 'student' })).status, 200);

    // forgot-password gives the same answer for unknown emails (no account enumeration)
    const known = await client('user').post('/api/auth/forgot-password').send({ email: p3.email, type: 'user' });
    const unknown = await client('user').post('/api/auth/forgot-password').send({ email: 'nobody@test.com', type: 'user' });
    assert.equal(known.status, 200);
    assert.deepEqual(known.body, unknown.body);

    // lockout after repeated failures
    const victim = await registerAndLogin('student', 9);
    for (let i = 0; i < cfg.maxFailedLogins; i++) {
      await client('user').post('/api/auth/login').send({ email: victim.email, password: 'wrongPass1', type: 'student' });
    }
    assert.equal((await client('user').post('/api/auth/login').send({ email: victim.email, password: PW, type: 'student' })).status, 429);
  });

  test('email verification (when required) blocks login until verified', async () => {
    cfg.requireEmailVerification = true;
    try {
      const c = client('user');
      const reg = await c.post('/api/auth/register').send({ name: 'Verify Me', email: 'verify@test.com', password: PW, role: 'student' });
      assert.equal(reg.body.verificationRequired, true);
      const blocked = await c.post('/api/auth/login').send({ email: 'verify@test.com', password: PW, type: 'student' });
      assert.equal(blocked.status, 403);
      assert.equal(blocked.body.code, 'EMAIL_NOT_VERIFIED');
      const { token, hash, expires } = makeToken(60000);
      await User.updateOne({ email: 'verify@test.com' }, { verifyTokenHash: hash, verifyTokenExpires: expires });
      assert.equal((await c.post('/api/auth/verify-email').send({ token: 'wrong', type: 'user' })).status, 400);
      assert.equal((await c.post('/api/auth/verify-email').send({ token, type: 'user' })).status, 200);
      assert.equal((await c.post('/api/auth/login').send({ email: 'verify@test.com', password: PW, type: 'student' })).status, 200);
    } finally {
      cfg.requireEmailVerification = false;
    }
  });

  test('startup migration and reconciliation heal legacy data', async () => {
    // simulate documents from the old version: vehicle without capacity, stale reserved counter
    await Vehicle.collection.insertOne({ type: 'bus', plate: 'LEGACY-1', status: 'idle', reservedSeats: 7 });
    await maintenance.migrateLegacy();
    await maintenance.reconcileReservations();
    const v = await Vehicle.findOne({ plate: 'LEGACY-1' });
    assert.equal(v.capacity, 20);
    assert.equal(v.shared, true);
    assert.equal(v.active, true);
    assert.equal(v.reservedSeats, 0);
  });
}
