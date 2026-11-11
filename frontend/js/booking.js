// Passenger page: choose pickup/drop, see the fare, request a ride, review history.
const bookingState = { pickup: null, drop: null, mapPick: null, user: null, map: null, pins: {} };
const SPECIAL = { gps: '__gps__', map: '__map__' };

function fillPlaceSelect(select, otherLabel) {
  select.append(h('option', { value: '', text: otherLabel }));
  window.CAMPUS.landmarks.forEach((p, i) => select.append(h('option', { value: String(i), text: p.name })));
  select.append(h('option', { value: SPECIAL.gps, text: '📍 My current location' }));
  select.append(h('option', { value: SPECIAL.map, text: '🗺 Choose on the map' }));
}

async function onPlaceChange(which, select) {
  const value = select.value;
  bookingState[which] = null;
  if (value === '') { refreshEstimate(); return; }
  if (value === SPECIAL.gps) {
    try {
      const loc = await getCurrentPosition();
      bookingState[which] = { ...loc, name: 'My location' };
    } catch (err) { toast(err.message, 'error'); select.value = ''; }
  } else if (value === SPECIAL.map) {
    bookingState.mapPick = which;
    toast(`Click the map to set the ${which} point.`);
  } else {
    const p = window.CAMPUS.landmarks[Number(value)];
    bookingState[which] = { lat: p.lat, lng: p.lng, name: p.name };
  }
  drawPins();
  refreshEstimate();
}

function drawPins() {
  const { map, pins } = bookingState;
  ['pickup', 'drop'].forEach((key) => {
    const point = bookingState[key];
    if (point) setPin(map, pins, key, point, key === 'pickup' ? 'Pickup' : 'Drop');
    else if (pins[key]) { map.removeLayer(pins[key]); delete pins[key]; }
  });
}

let estimateTimer = null;
function refreshEstimate() {
  clearTimeout(estimateTimer);
  estimateTimer = setTimeout(async () => {
    const box = document.getElementById('estimate');
    const { pickup, drop } = bookingState;
    if (!pickup || !drop) { box.textContent = 'Choose pickup and drop to see your estimate.'; return; }
    try {
      const est = await apiPost('/fare/estimate', {
        pickupLocation: { lat: pickup.lat, lng: pickup.lng },
        dropLocation: { lat: drop.lat, lng: drop.lng },
        seats: Number(document.getElementById('seats').value) || 1
      });
      const trip = `About ${est.distanceKm} km, ${est.etaMinutes} min.`;
      box.textContent = bookingState.user.role === 'staff' ? trip : `${trip} Auto ${money(est.options.auto)} · Bus ${money(est.options.bus)}`;
    } catch (err) { box.textContent = err.message; }
  }, 300);
}

function bookingCard(b) {
  const open = b.status === 'requested' || b.status === 'accepted';
  const lines = [
    h('div', { class: 'row' }, h('strong', { text: `${placeLabel(b.pickupName, b.pickupLocation)} → ${placeLabel(b.dropName, b.dropLocation)}` }), statusBadge(b.status)),
    h('p', { class: 'muted', text: new Date(b.createdAt).toLocaleString() }),
    h('p', {}, h('strong', { text: 'Driver: ' }), b.driver ? `${b.driver.name}${b.vehicle ? ` (${b.vehicle.type} ${b.vehicle.plate})` : ''}` : (b.status === 'requested' ? 'Searching…' : '—')),
    h('p', {}, h('strong', { text: 'Seats: ' }), b.seats, '  ', h('strong', { text: 'Fare: ' }), rideFareLabel(b))
  ];
  const actions = [];
  if (open) {
    actions.push(h('a', { class: 'button-link small', href: `tracking.html?id=${encodeURIComponent(b._id)}`, text: 'Track ride' }));
    actions.push(h('button', { type: 'button', class: 'secondary small', text: 'Cancel', onclick: () => cancelRide(b._id) }));
  }
  return h('div', { class: 'booking-item' }, lines, actions.length ? h('div', { class: 'actions' }, actions) : null);
}

async function cancelRide(id) {
  if (!confirm('Cancel this ride?')) return;
  try { await apiPost(`/booking/${id}/cancel`); toast('Ride cancelled.'); loadBookings(); } catch (err) { toast(err.message, 'error'); }
}

async function loadBookings() {
  const list = document.getElementById('bookingsList');
  try {
    const bookings = await apiFetch('/bookings/mine');
    list.replaceChildren(...(bookings.length ? bookings.map(bookingCard) : [h('p', { text: 'No bookings yet.' })]));
  } catch (err) { list.replaceChildren(h('p', { class: 'error-text', text: err.message })); }
}

function renderWallet({ balance, request }) {
  document.getElementById('walletInfo').textContent = 'Wallet balance: ' + money(balance);
  document.getElementById('requestStatus').textContent = request
    ? `Latest request: ${money(request.amount)} · ${request.status}` : '';
  document.getElementById('topupForm').hidden = request?.status === 'pending';
}

async function refreshWallet() {
  try { renderWallet(await apiFetch('/wallet/me')); }
  catch (err) { document.getElementById('requestStatus').textContent = err.message; }
}

function setupPayments(user) {
  const student = user.role === 'student';
  document.getElementById('staffRideInfo').hidden = student;
  document.getElementById('paymentFields').hidden = !student;
  document.getElementById('walletDeletionNote').hidden = !student;
  if (!student) return;
  document.getElementById('studentWallet').hidden = false;
  document.getElementById('topupForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      renderWallet(await apiPost('/wallet/requests', { amount: Number(document.getElementById('topupAmount').value) }));
      form.reset();
    } catch (err) { toast(err.message, 'error'); await refreshWallet(); }
    finally { button.disabled = false; }
  });
  refreshWallet();
}

async function initBooking() {
  bookingState.user = await requireLogin(['student', 'staff']);
  if (!bookingState.user) return;

  setupPayments(bookingState.user);
  bookingState.map = createMap('map');
  bookingState.map.on('click', (e) => {
    const which = bookingState.mapPick;
    if (!which) return;
    bookingState[which] = { lat: e.latlng.lat, lng: e.latlng.lng, name: `Map point (${e.latlng.lat.toFixed(4)}, ${e.latlng.lng.toFixed(4)})` };
    bookingState.mapPick = null;
    drawPins();
    refreshEstimate();
  });

  const pickupSel = document.getElementById('pickup');
  const dropSel = document.getElementById('drop');
  fillPlaceSelect(pickupSel, 'Select pickup…');
  fillPlaceSelect(dropSel, 'Select drop…');
  pickupSel.addEventListener('change', () => onPlaceChange('pickup', pickupSel));
  dropSel.addEventListener('change', () => onPlaceChange('drop', dropSel));
  document.getElementById('seats').addEventListener('input', refreshEstimate);

  document.getElementById('bookingForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const { pickup, drop } = bookingState;
    const message = document.getElementById('bookingMessage');
    if (!pickup || !drop) return showMessage(message, 'Please choose both pickup and drop.', 'error');
    const button = e.target.querySelector('button[type=submit]');
    button.disabled = true; // prevents double submits
    try {
      const data = await apiPost('/booking', {
        pickupName: pickup.name, dropName: drop.name,
        pickupLocation: { lat: pickup.lat, lng: pickup.lng },
        dropLocation: { lat: drop.lat, lng: drop.lng },
        seats: Number(document.getElementById('seats').value) || 1,
        vehicleType: document.getElementById('vehicleType').value,
        ...(bookingState.user.role === 'student' ? { paymentMethod: document.getElementById('paymentMethod').value } : {})
      });
      showMessage(message, data.message, 'ok');
      setTimeout(() => { location.href = `tracking.html?id=${encodeURIComponent(data.booking._id)}`; }, 1200);
    } catch (err) {
      showMessage(message, err.message, 'error');
      button.disabled = false;
    }
  });

  loadBookings();
  startNotifications();
  setInterval(() => { if (!document.hidden) { loadBookings(); if (bookingState.user.role === 'student') refreshWallet(); } }, 8000);
}
initBooking();
