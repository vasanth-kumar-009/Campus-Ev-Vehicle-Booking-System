// Browser geolocation for drivers. Location access needs HTTPS (or localhost) and the user's permission.
let watchId = null;
let lastSentAt = 0;

function geoErrorMessage(error) {
  if (!window.isSecureContext) return 'Location needs HTTPS (or http://localhost). Open the site over a secure connection.';
  if (error && error.code === 1) return 'Location permission was denied. Allow location for this site in your browser settings.';
  if (error && error.code === 2) return 'Your position is unavailable. Turn on GPS / location services.';
  if (error && error.code === 3) return 'Getting your position timed out. Try again.';
  return 'Could not read your location.';
}

function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('This browser does not support location.'));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => reject(new Error(geoErrorMessage(err))),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 }
    );
  });
}

/** Watches the position, calls onPosition for the map and sends it to the server (at most every 4 s). */
function startTracking(onPosition, onError) {
  stopTracking();
  if (!navigator.geolocation) { if (onError) onError('This browser does not support location.'); return; }
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      if (onPosition) onPosition(loc);
      const now = Date.now();
      if (now - lastSentAt >= 4000) {
        lastSentAt = now;
        apiPost('/location/update', loc, { noRedirect: true }).catch(() => {});
      }
    },
    (err) => { if (onError) onError(geoErrorMessage(err)); },
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 }
  );
}

function stopTracking() {
  if (watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
  watchId = null;
}
