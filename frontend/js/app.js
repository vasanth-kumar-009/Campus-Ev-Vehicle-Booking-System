// Shared helpers. Load this before every page script.
// Sessions are HttpOnly cookies set by the server; JavaScript never sees the token.
// <body data-session="driver|user"> tells the API which session (cookie) this page uses,
// so a driver tab and a passenger tab can be logged in side by side.
const SESSION = document.body.dataset.session || 'user';
window.API_BASE = window.API_BASE || (window.location.protocol === 'file:' ? 'http://localhost:3000/api' : `${window.location.origin}/api`);

/* ---------- tiny DOM builder (safe: text is never parsed as HTML) ---------- */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === false || value === null || value === undefined) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return el;
}

/* ---------- session profile (non-secret display data only) ---------- */
const profileKey = (session = SESSION) => `ev_profile_${session}`;
function getProfile(session = SESSION) {
  try { return JSON.parse(localStorage.getItem(profileKey(session))); } catch (err) { return null; }
}
function saveProfile(user, session = SESSION) { localStorage.setItem(profileKey(session), JSON.stringify(user)); }
function clearProfile(session = SESSION) { localStorage.removeItem(profileKey(session)); }
const homeFor = (role) => (role === 'driver' ? 'driver.html' : role === 'admin' ? 'admin.html' : 'booking.html');

/* ---------- API ---------- */
async function apiFetch(path, options = {}) {
  const { session = SESSION, noRedirect = false, ...rest } = options;
  let response;
  try {
    response = await fetch(`${window.API_BASE}${path}`, {
      ...rest,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Session': session, ...(rest.headers || {}) }
    });
  } catch (err) {
    throw new Error('Cannot reach the server. Check your internet connection.');
  }

  if (!(response.headers.get('content-type') || '').includes('application/json')) {
    throw new Error('The server sent an unexpected (non-JSON) response. Open the site through the Express URL, or check that the /api rewrite points to your backend.');
  }
  const data = await response.json();

  if (response.status === 401 && !noRedirect) {
    clearProfile(session);
    if (!/(login|register|forgot-password|reset-password|verify-email)\.html$/.test(location.pathname) && location.pathname !== '/') {
      location.replace('login.html?expired=1');
    }
  }
  if (!response.ok) {
    const err = new Error(data.error || 'Request failed');
    err.status = response.status;
    err.code = data.code;
    err.verificationType = data.verificationType;
    throw err;
  }
  return data;
}
const apiPost = (path, body = {}, options = {}) => apiFetch(path, { method: 'POST', body: JSON.stringify(body), ...options });
const apiPut = (path, body = {}) => apiFetch(path, { method: 'PUT', body: JSON.stringify(body) });
const apiPatch = (path, body = {}) => apiFetch(path, { method: 'PATCH', body: JSON.stringify(body) });
const apiDelete = (path) => apiFetch(path, { method: 'DELETE' });

/** Confirms the session with the server and the role with the database. Redirects when it is not valid. */
async function requireLogin(roles) {
  try {
    const { user } = await apiFetch('/auth/me', { noRedirect: true });
    saveProfile(user);
    if (roles && !roles.includes(user.role)) { location.replace(homeFor(user.role)); return null; }
    const who = document.getElementById('whoami');
    if (who) who.textContent = user.name;
    return user;
  } catch (err) {
    const hadSession = !!getProfile();
    clearProfile();
    location.replace(`login.html${hadSession ? '?expired=1' : ''}`);
    return null;
  }
}

async function logout() {
  await apiPost('/auth/logout', {}, { noRedirect: true }).catch(() => {});
  clearProfile();
  location.href = 'login.html';
}
const logoutButton = document.getElementById('logoutButton');
if (logoutButton) logoutButton.addEventListener('click', logout);

/* ---------- UI helpers ---------- */
function toast(message, kind = 'info') {
  let box = document.getElementById('toasts');
  if (!box) { box = h('div', { id: 'toasts', 'aria-live': 'polite' }); document.body.append(box); }
  const el = h('div', { class: `toast ${kind}`, text: message });
  box.append(el);
  setTimeout(() => el.remove(), 6000);
}

function showMessage(el, text, kind = 'error') {
  if (!el) return;
  el.textContent = text;
  el.className = `info-box ${kind}`;
  el.hidden = !text;
}

const money = (n) => (n === undefined || n === null ? '—' : `₹${n}`);
function rideFareLabel(ride) {
  if (ride.paymentMethod === 'staff') return 'Free staff ride';
  return `${money(ride.fare)} · ${ride.paymentMethod}${ride.status === 'completed' ? ' (' + ride.paymentStatus + ')' : ''}`;
}
const prettyStatus = (s) => ({ requested: 'Requested', accepted: 'Accepted', completed: 'Completed', cancelled: 'Cancelled', expired: 'No driver found', rejected: 'Rejected' }[s] || s);
const statusBadge = (s) => h('span', { class: `badge ${s}`, text: prettyStatus(s) });
const placeLabel = (name, loc) => name || `${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)}`;

/** Shows in-app notifications (new request, ride accepted, ...) as toasts. */
function startNotifications() {
  let busy = false;
  const poll = async () => {
    if (busy || document.hidden) return;
    busy = true;
    try {
      const items = await apiFetch('/notifications', { noRedirect: true });
      items.forEach((n) => toast(n.message, 'info'));
      if (items.length) await apiPost('/notifications/read', { ids: items.map((n) => n._id) }, { noRedirect: true });
    } catch (err) { /* ignore: next poll retries */ } finally { busy = false; }
  };
  poll();
  return setInterval(poll, 6000);
}
