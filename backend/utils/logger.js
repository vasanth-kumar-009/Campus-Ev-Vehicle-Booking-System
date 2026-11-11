'use strict';
const cfg = require('../config');

const levels = { error: 0, warn: 1, info: 2, debug: 3 };
const current = levels[process.env.LOG_LEVEL || (cfg.isProd ? 'info' : 'debug')] ?? 2;

// Strip credentials from anything we log (Mongo URIs, bearer tokens, passwords).
function scrub(value) {
  const s = value instanceof Error ? `${value.name}: ${value.message}` : String(value);
  return s
    .replace(/(mongodb(?:\+srv)?:\/\/)([^@\s/]+)@/gi, '$1***:***@')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1***')
    .replace(/(password|token|secret)=([^&\s]+)/gi, '$1=***');
}

function log(level, ...args) {
  if (cfg.isTest || levels[level] > current) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${args.map(scrub).join(' ')}`;
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
}

module.exports = {
  scrub,
  error: (...a) => log('error', ...a),
  warn: (...a) => log('warn', ...a),
  info: (...a) => log('info', ...a),
  debug: (...a) => log('debug', ...a)
};
