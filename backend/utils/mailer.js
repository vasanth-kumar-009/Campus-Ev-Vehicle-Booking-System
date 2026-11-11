'use strict';
const nodemailer = require('nodemailer');
const cfg = require('../config');
const log = require('./logger');

let transport;
function getTransport() {
  if (!cfg.smtp) return null;
  if (!transport) transport = nodemailer.createTransport(cfg.smtp);
  return transport;
}

/**
 * Sends an email. Without SMTP: development prints the message (including the link)
 * to the console; production logs a warning and sends nothing.
 */
async function sendMail({ to, subject, text }) {
  const t = getTransport();
  if (!t) {
    if (cfg.isProd) log.warn('SMTP is not configured - email not sent:', subject);
    else if (!cfg.isTest) console.log(`\n--- EMAIL (dev, not sent) ---\nTo: ${to}\nSubject: ${subject}\n${text}\n-----------------------------\n`);
    return false;
  }
  await t.sendMail({ from: cfg.mailFrom, to, subject, text });
  return true;
}

module.exports = { sendMail };
