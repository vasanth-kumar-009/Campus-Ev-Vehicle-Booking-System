'use strict';
const crypto = require('crypto');

/** Random one-time token. Only the SHA-256 hash is stored in the database. */
function makeToken(ttlMs) {
  const token = crypto.randomBytes(32).toString('hex');
  return { token, hash: hashToken(token), expires: new Date(Date.now() + ttlMs) };
}
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

module.exports = { makeToken, hashToken };
