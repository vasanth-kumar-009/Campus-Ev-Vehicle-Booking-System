'use strict';
const { createHmac } = require('node:crypto');
const nodemailer = require('nodemailer');
const cfg = require('../config');
const log = require('./logger');

let transport;
function getTransport() {
  if (!cfg.smtp) return null;
  if (!transport) transport = nodemailer.createTransport(cfg.smtp);
  return transport;
}

async function sendWithGoogleScript(message) {
  const { url, secret } = cfg.googleScript;
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url) || !secret || secret.length < 32) {
    throw new Error('Check GOOGLE_SCRIPT_URL and GOOGLE_SCRIPT_SECRET on the backend.');
  }
  const payload = JSON.stringify({ ...message, sentAt: Date.now() });
  const signature = createHmac('sha256', secret).update(payload).digest('base64');
  const signal = AbortSignal.timeout(20000);
  let result = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload, signature }), redirect: 'manual', signal
  });
  // ContentService returns its JSON through a one-time Google download URL.
  if (result.status === 302 || result.status === 303) {
    const location = new URL(result.headers.get('location'), url);
    if (location.origin !== 'https://script.googleusercontent.com') {
      throw new Error('Check Google web app access and deploy the /exec version.');
    }
    result = await fetch(location, { redirect: 'error', signal });
  }
  const reply = result.ok ? await result.json().catch(() => null) : null;
  if (!reply || reply.ok !== true) throw new Error('Google mail failed. Check the script secret, authorization and daily quota.');
  return true;
}

/**
 * Sends an email. Without SMTP: development prints the message (including the link)
 * to the console; production logs a warning and sends nothing.
 */
async function sendMail({ to, subject, text }) {
  if (cfg.googleScript) return sendWithGoogleScript({ to, subject, text });
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
