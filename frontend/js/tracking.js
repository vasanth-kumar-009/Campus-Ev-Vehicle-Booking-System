// Passenger page: follow one ride (status, fare, ETA and the driver's live position).
const trackState = { map: null, pins: {}, bookingId: null, timer: null, fitted: false };

function setStatus(text, kind = '') {
  const el = document.getElementById('status');
  el.textContent = text;
  el.className = `status-box ${kind}`;
}

function describe(b) {
  if (b.status === 'requested' && b.driver) return `Waiting for ${b.driver.name} to confirm your ride…`;
  if (b.status === 'requested') return 'Looking for a driver near you…';
  if (b.status === 'accepted') return `${b.driver ? b.driver.name : 'Your driver'} accepted and is on the way.`;
  if (b.status === 'completed' && b.paymentMethod === 'staff') return 'Staff ride completed. No payment is required.';
  if (b.status === 'completed') return b.paymentStatus === 'paid' ? 'Ride completed. Payment received. Thank you!' : `Ride completed. Please pay ${money(b.fare)} to the driver.`;
  if (b.status === 'cancelled') return 'This ride was cancelled.';
  if (b.status === 'expired') return 'No driver was available. Please request again.';
  return prettyStatus(b.status);
}

function renderDetails(b) {
  const rows = [
    ['Route', `${placeLabel(b.pickupName, b.pickupLocation)} → ${placeLabel(b.dropName, b.dropLocation)}`],
    ['Vehicle', b.vehicle ? `${b.vehicle.type} · ${b.vehicle.plate}` : '—'],
    ['Seats', b.seats],
    ['Distance', b.distanceKm ? `${b.distanceKm} km (about ${b.etaMinutes} min)` : '—'],
    ['Fare', rideFareLabel(b)]
  ];
  document.getElementById('details').replaceChildren(...rows.map(([k, v]) => h('p', {}, h('strong', { text: `${k}: ` }), String(v))));
  const cancel = document.getElementById('cancelButton');
  cancel.hidden = !(b.status === 'requested' || b.status === 'accepted');
}

async function refreshTracking() {
  if (document.hidden && trackState.fitted) return;
  let b;
  try { b = await apiFetch(`/booking/${trackState.bookingId}`); } catch (err) { return setStatus(err.message, 'error'); }

  setStatus(describe(b), b.status);
  renderDetails(b);
  setPin(trackState.map, trackState.pins, 'pickup', b.pickupLocation, 'Pickup');
  setPin(trackState.map, trackState.pins, 'drop', b.dropLocation, 'Drop');

  if (b.status === 'accepted') {
    try {
      const loc = await apiFetch(`/booking/${b._id}/driver-location`);
      if (loc.available) {
        setPin(trackState.map, trackState.pins, 'driver', loc.location, 'Driver');
        const stale = loc.stale ? ' (location is a few minutes old)' : '';
        setStatus(`${describe(b)} About ${loc.distanceToPickupKm} km away, ~${loc.etaToPickupMinutes} min.${stale}`, b.status);
      } else {
        setStatus(`${describe(b)} Driver location not shared yet.`, b.status);
      }
    } catch (err) { /* keep last known position */ }
  } else if (trackState.pins.driver) {
    trackState.map.removeLayer(trackState.pins.driver);
    delete trackState.pins.driver;
  }
  if (!trackState.fitted) { fitPins(trackState.map, trackState.pins); trackState.fitted = true; }

  return ['completed', 'cancelled', 'expired'].includes(b.status); // true = nothing more to follow
}

async function initTracking() {
  const user = await requireLogin(['student', 'staff']);
  if (!user) return;
  trackState.map = createMap('map');
  setStatus('Loading ride details…');

  let id = new URLSearchParams(location.search).get('id');
  if (!id) { // fall back to the newest open ride
    try {
      const list = await apiFetch('/bookings/mine');
      const open = list.find((b) => b.status === 'requested' || b.status === 'accepted') || list[0];
      id = open && open._id;
    } catch (err) { return setStatus(err.message, 'error'); }
  }
  if (!id) return setStatus('You have no rides yet. Book one first.');
  trackState.bookingId = id;

  document.getElementById('cancelButton').addEventListener('click', async () => {
    if (!confirm('Cancel this ride?')) return;
    try { await apiPost(`/booking/${id}/cancel`); toast('Ride cancelled.'); refreshTracking(); } catch (err) { toast(err.message, 'error'); }
  });

  const finished = await refreshTracking();
  if (!finished) {
    trackState.timer = setInterval(async () => { if (await refreshTracking()) clearInterval(trackState.timer); }, 4000);
  }
  startNotifications();
}
initTracking();
