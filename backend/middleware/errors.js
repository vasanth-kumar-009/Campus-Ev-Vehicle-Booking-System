'use strict';
const { HttpError } = require('../utils/errors');
const log = require('../utils/logger');

const notFound = (req, res, next) => next(new HttpError(404, 'Not found'));

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });
  if (err.name === 'ValidationError' || err.name === 'CastError') return res.status(400).json({ error: 'Invalid request data' });
  if (err.code === 11000) return res.status(409).json({ error: 'That value is already in use' });

  log.error(`${req.method} ${req.path}`, err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
}

module.exports = { notFound, errorHandler };
