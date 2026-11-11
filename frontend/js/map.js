// Leaflet helpers (Leaflet is served from /vendor/leaflet - no third-party script is needed).
function createMap(elementId, center = window.CAMPUS.center, zoom = window.CAMPUS.zoom) {
  const map = L.map(elementId).setView([center.lat, center.lng], zoom);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap contributors'
  }).addTo(map);
  addCampusMarkers(map);
  setTimeout(() => map.invalidateSize(), 250); // fixes a blank/partial map when the container was hidden at creation
  return map;
}

function addCampusMarkers(map) {
  window.CAMPUS.landmarks.forEach((place) => {
    const label = document.createElement('b');
    label.textContent = place.name; // textContent: never parsed as HTML
    L.circleMarker([place.lat, place.lng], { radius: 5, color: '#555', weight: 1, fillColor: '#999', fillOpacity: 0.8 })
      .addTo(map).bindPopup(label);
  });
}

const MARKER_COLORS = { pickup: '#2e8b57', drop: '#c0392b', driver: '#1f6feb' };

/** Creates or moves a coloured marker stored in `holder[key]`. */
function setPin(map, holder, key, point, label) {
  if (!point) return;
  if (!holder[key]) {
    const color = MARKER_COLORS[key] || '#333';
    holder[key] = L.circleMarker([point.lat, point.lng], { radius: 9, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1 }).addTo(map);
    holder[key].bindTooltip(label, { permanent: false });
  } else {
    holder[key].setLatLng([point.lat, point.lng]);
  }
}

function fitPins(map, holder) {
  const pts = Object.values(holder).filter(Boolean).map((m) => m.getLatLng());
  if (pts.length === 1) map.setView(pts[0], 16);
  else if (pts.length > 1) map.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 17 });
}
