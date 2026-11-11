// Driver dashboard: go online, pick a vehicle, answer ride offers, complete rides, collect cash.
const driverState = { online: false, map: null, pins: {}, poll: null, tick: null, trackingError: false };

const $ = (id) => document.getElementById(id);

function setOnlineUi(online) {
  driverState.online = online;
  $('toggleOnline').textContent = online ? 'Go Offline' : 'Go Online';
  $('driverStatus').textContent = online ? 'Online – waiting for ride requests' : 'Offline';
  $('driverStatus').className = `status-box ${online ? 'accepted' : ''}`;
  $('vehicleSelect').disabled = online;
}

function showDriverPosition(loc) {
  setPin(driverState.map, driverState.pins, 'driver', loc, 'You');
  if (!driverState.centered) { driverState.map.setView([loc.lat, loc.lng], 16); driverState.centered = true; }
}

function beginTracking() {
  startTracking(showDriverPosition, (message) => {
    if (!driverState.trackingError) { driverState.trackingError = true; toast(message, 'error'); }
  });
}

function startPolling() {
  stopPolling();
  loadRides();
  driverState.poll = setInterval(loadRides, 4000);
  driverState.tick = setInterval(updateCountdowns, 1000);
}
function stopPolling() {
  clearInterval(driverState.poll);
  clearInterval(driverState.tick);
  driverState.poll = driverState.tick = null;
}

/* ---------- rendering ---------- */
function rideSummary(b) {
  return [
    h('p', {}, h('strong', { text: 'Passenger: ' }), b.user ? b.user.name : 'Passenger', '  ', h('strong', { text: 'Seats: ' }), b.seats),
    h('p', {}, h('strong', { text: 'Trip: ' }), `${placeLabel(b.pickupName, b.pickupLocation)} → ${placeLabel(b.dropName, b.dropLocation)}`),
    h('p', {}, h('strong', { text: 'Fare: ' }), rideFareLabel(b))
  ];
}

function offerCard(b) {
  const left = h('span', { class: 'countdown', 'data-expires': b.offerExpiresAt, text: '' });
  return h('div', { class: 'booking-item' },
    rideSummary(b),
    h('p', { class: 'muted' }, 'Respond within ', left),
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'small', text: 'Accept', onclick: () => respond(b._id, 'accepted') }),
      h('button', { type: 'button', class: 'secondary small', text: 'Decline', onclick: () => respond(b._id, 'rejected') })));
}

function activeCard(b) {
  return h('div', { class: 'booking-item' },
    h('div', { class: 'row' }, h('strong', { text: 'Ride in progress' }), statusBadge(b.status)),
    rideSummary(b),
    h('div', { class: 'actions' }, h('button', { type: 'button', class: 'small', text: 'Complete ride', onclick: () => respond(b._id, 'completed') })));
}

function unpaidCard(b) {
  return h('div', { class: 'booking-item' },
    h('p', {}, h('strong', { text: `Collect ${money(b.fare)} cash from ${b.user ? b.user.name : 'passenger'}` })),
    h('div', { class: 'actions' }, h('button', { type: 'button', class: 'small', text: 'Cash collected', onclick: () => collectCash(b._id) })));
}

function fillList(id, items, build, emptyText) {
  $(id).replaceChildren(...(items.length ? items.map(build) : [h('p', { class: 'muted', text: emptyText })]));
}

function updateCountdowns() {
  document.querySelectorAll('.countdown').forEach((el) => {
    const secs = Math.max(0, Math.round((new Date(el.dataset.expires) - Date.now()) / 1000));
    el.textContent = `${secs}s`;
  });
}

async function loadRides() {
  if (document.hidden && driverState.poll) return;
  try {
    const { pending, active, unpaid } = await apiFetch('/driver/rides');
    fillList('pendingList', pending, offerCard, 'No pending requests.');
    fillList('activeList', active, activeCard, 'No ride in progress.');
    fillList('unpaidList', unpaid, unpaidCard, 'Nothing to collect.');
    $('unpaidPanel').hidden = unpaid.length === 0;
    updateCountdowns();
  } catch (err) {
    $('pendingList').replaceChildren(h('p', { class: 'error-text', text: err.message }));
  }
}

/* ---------- actions ---------- */
async function respond(id, status) {
  try {
    await apiPut(`/booking/${id}/status`, { status });
    toast(status === 'accepted' ? 'Ride accepted.' : status === 'completed' ? 'Ride completed.' : 'Request declined.');
  } catch (err) { toast(err.message, 'error'); }
  loadRides(); // location tracking is NOT stopped: you stay visible while online
}

async function collectCash(id) {
  try { await apiPost(`/booking/${id}/cash-collected`); toast('Marked as paid.'); } catch (err) { toast(err.message, 'error'); }
  loadRides();
}

async function toggleOnline() {
  const goOnline = !driverState.online;
  const button = $('toggleOnline');
  button.disabled = true;
  try {
    if (goOnline) {
      const location = await getCurrentPosition(); // needed so the server can match you to nearby passengers
      await apiPost('/driver/online', { online: true, location });
      driverState.trackingError = false;
      setOnlineUi(true);
      showDriverPosition(location);
      beginTracking();
      startPolling();
    } else {
      await apiPost('/driver/online', { online: false });
      setOnlineUi(false);
      stopTracking();
      stopPolling();
      $('pendingList').replaceChildren(h('p', { class: 'muted', text: 'You are offline. Go online to receive requests.' }));
    }
  } catch (err) { toast(err.message, 'error'); } finally { button.disabled = false; }
}

async function loadProfile() {
  const { driver, vehicles } = await apiFetch('/driver/me');
  const select = $('vehicleSelect');
  select.replaceChildren(...vehicles.map((v) => h('option', { value: v._id, text: `${v.type} · ${v.plate} (${v.capacity} seats)`, selected: v._id === driver.activeVehicle })));
  if (!vehicles.length) select.replaceChildren(h('option', { value: '', text: 'No vehicle – ask the administrator' }));
  setOnlineUi(driver.status === 'online');
  if (driver.location) { showDriverPosition(driver.location); }
  if (driver.status === 'online') { beginTracking(); startPolling(); } else { loadRides(); }
}

async function initDriver() {
  const user = await requireLogin(['driver']);
  if (!user) return;
  driverState.map = createMap('map');
  $('toggleOnline').addEventListener('click', toggleOnline);
  $('vehicleSelect').addEventListener('change', async (e) => {
    try { await apiPost('/driver/vehicle', { vehicleId: e.target.value }); toast('Vehicle selected.'); } catch (err) { toast(err.message, 'error'); loadProfile(); }
  });
  try { await loadProfile(); } catch (err) { $('driverStatus').textContent = err.message; }
  startNotifications();
}
initDriver();
