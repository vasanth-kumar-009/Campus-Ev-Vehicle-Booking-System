'use strict';
const mongoose = require('mongoose');
const cfg = require('./config');
const dns = require('dns');
if (process.env.DNS_SERVERS) dns.setServers(process.env.DNS_SERVERS.split(',').map((s) => s.trim()));
const log = require('./utils/logger');
const { createApp } = require('./app');
const maintenance = require('./services/maintenance');
const bookings = require('./services/bookings');

mongoose.set('strictQuery', true);
mongoose.set('bufferCommands', false);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hide = (uri) => log.scrub(uri);

function explainMongoError(err) {
  const m = err.message || '';
  if (/bad auth|Authentication failed/i.test(m)) {
    return 'Database authentication failed. Use an Atlas DATABASE user (not your Atlas login), URL-encode special characters in the password (@ -> %40, # -> %23), and give the user read/write access.';
  }
  if (/ENOTFOUND|querySrv|EREFUSED/i.test(m)) return 'DNS lookup failed. Check the cluster hostname in MONGODB_URI and your internet/DNS.';
  if (/ECONNREFUSED/i.test(m)) return 'Connection refused. For a local database, start mongod first; for Atlas, check the hostname.';
  if (/Server selection timed out|ETIMEDOUT|timed out/i.test(m)) {
    return 'Could not reach the database. In Atlas > Network Access allow this server\'s IP (Render needs 0.0.0.0/0 or its outbound IPs), and make sure the cluster is not paused.';
  }
  return 'See the error above.';
}

async function connectWithRetry() {
  for (let attempt = 1; ; attempt++) {
    try {
      await mongoose.connect(cfg.mongoUri, { serverSelectionTimeoutMS: 10000, connectTimeoutMS: 10000, socketTimeoutMS: 45000, family: 4, maxPoolSize: 10 });
      return;
    } catch (err) {
      const delay = Math.min(30000, 2000 * 2 ** Math.min(attempt, 4));
      log.error(`MongoDB connection failed (attempt ${attempt}): ${err.message}`);
      log.error(`Hint: ${explainMongoError(err)} Retrying in ${delay / 1000}s...`);
      await mongoose.disconnect().catch(() => {});
      await sleep(delay);
    }
  }
}

async function initDatabase() {
  try {
    await maintenance.ensureIndexes();
    await maintenance.migrateLegacy();
    await maintenance.reconcileReservations();
    await maintenance.bootstrapAdmin();
    await maintenance.seedDemoData();
  } catch (err) {
    log.error('Database initialisation failed:', err);
  }
  bookings.startSweeper();
}

async function main() {
  if (!/^mongodb(\+srv)?:\/\//.test(cfg.mongoUri)) {
    log.error('MONGODB_URI must start with mongodb:// or mongodb+srv://');
    process.exit(1);
  }

  // Listen first so the platform sees an open port; API calls answer 503 until the database is up.
  const server = createApp().listen(cfg.port, () => {
    log.info(`Server listening on port ${cfg.port} (${cfg.isProd ? 'production' : 'development'})`);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') log.error(`Port ${cfg.port} is already in use. Stop the other process or set a different PORT in backend/.env.`);
    else log.error('Server error:', err);
    process.exit(1);
  });

  mongoose.connection.on('connected', () => log.info(`MongoDB connected: ${hide(cfg.mongoUri)}`));
  mongoose.connection.on('disconnected', () => log.warn('MongoDB disconnected'));
  mongoose.connection.on('error', (err) => log.error('MongoDB error:', err.message));

  await connectWithRetry();
  await initDatabase();

  const shutdown = async (signal) => {
    log.info(`${signal} received, shutting down`);
    bookings.stopSweeper();
    server.close(async () => { await mongoose.disconnect().catch(() => {}); process.exit(0); });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('unhandledRejection', (err) => log.error('Unhandled rejection:', err));
main().catch((err) => { log.error('Fatal startup error:', err); process.exit(1); });
