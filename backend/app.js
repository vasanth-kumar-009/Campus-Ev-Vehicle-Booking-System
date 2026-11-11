'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const mongoose = require('mongoose');
const cfg = require('./config');
const sec = require('./middleware/security');
const { notFound, errorHandler } = require('./middleware/errors');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (cfg.trustProxy) app.set('trust proxy', cfg.trustProxy);

  if (!cfg.isTest) {
    // Log the path only: query strings can contain one-time tokens. Bodies and cookies are never logged.
    morgan.token('safe-path', (req) => req.originalUrl.split('?')[0]);
    app.use(morgan(':remote-addr :method :safe-path :status :response-time ms', { skip: (req) => req.path === '/api/health' }));
  }

  app.use(sec.httpsOnly);
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https://*.tile.openstreetmap.org'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"]
      }
    },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' }, // OpenStreetMap tiles need the origin
    crossOriginEmbedderPolicy: false,
    hsts: cfg.isProd ? { maxAge: 15552000, includeSubDomains: true } : false
  }));

  app.use('/api', cors(sec.corsOptions));
  app.use(express.json({ limit: '20kb' }));
  app.use(cookieParser());

  const frontendDir = path.join(__dirname, '../frontend');
  if (cfg.serveFrontend && fs.existsSync(frontendDir)) {
    app.use(express.static(frontendDir, { maxAge: cfg.isProd ? '1h' : 0, dotfiles: 'ignore' }));
  }

  // Health: no secrets, no connection strings.
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', database: mongoose.connection.readyState === 1 ? 'up' : 'down' });
  });

  app.use('/api', sec.originCheck, sec.apiLimiter, sec.requireDb);
  app.use('/api/sign-in', require('./routes/sign-in'));
  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/driver', require('./routes/driver'));
  app.use('/api/notifications', require('./routes/notifications'));
  app.use('/api/wallet', require('./routes/wallet'));
  app.use('/api/accounts', require('./routes/accounts'));
  app.use('/api/admin', require('./routes/admin'));
  app.use('/api', require('./routes/bookings'));

  // Unknown /api paths get JSON (never the HTML page), so the frontend never fails to parse them.
  app.use('/api', notFound);
  app.use((req, res) => res.status(404).type('text').send('Page not found'));
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
