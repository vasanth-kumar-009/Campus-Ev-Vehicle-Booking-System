// Admin panel: overview, drivers, vehicles, bookings, users and wallets.
const $a = (id) => document.getElementById(id);
const table = (head, rows) => h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, head.map((t) => h('th', { text: t })))), h('tbody', {}, rows)));
const td = (...c) => h('td', {}, c);
const safe = (fn) => async (...a) => { try { await fn(...a); } catch (err) { toast(err.message, 'error'); } };

function driverAssignment(vehicle, drivers) {
  const current = vehicle.driver;
  if (vehicle.reservedSeats > 0) {
    return td(current ? current.name : 'No driver', h('small', { text: ' · Ride in progress' }));
  }

  const options = drivers.map((driver) => h('option', {
    value: driver._id, text: driver.name + ' (' + driver.email + ')'
  }));
  if (current && !drivers.some((driver) => driver._id === current._id)) {
    options.push(h('option', { value: current._id, text: current.name }));
  }
  const select = h('select', { 'aria-label': 'Driver for ' + vehicle.plate },
    h('option', { value: '', text: 'No driver' }), options);
  const original = current ? current._id : '';
  select.value = original;
  const save = h('button', { type: 'button', class: 'small', text: 'Save driver', disabled: true });
  select.addEventListener('change', () => { save.disabled = select.value === original; });
  save.addEventListener('click', async () => {
    save.disabled = true;
    select.disabled = true;
    try {
      await apiPut('/admin/vehicles/' + vehicle._id, { driverId: select.value || null });
      toast('Driver assignment saved for ' + vehicle.plate + '.');
      if (select.isConnected) await show('vehicles');
    } catch (err) {
      toast(err.message, 'error');
      select.disabled = false;
      save.disabled = select.value === original;
    }
  });
  return td(select, save);
}

const views = {
  async overview(root) {
    const s = await apiFetch('/admin/stats');
    const cards = [['Passengers', s.users], ['Drivers', s.drivers], ['Online now', s.onlineDrivers], ['Vehicles', s.vehicles], ['Open rides', s.openBookings], ['Completed rides', s.completedBookings]];
    root.replaceChildren(h('div', { class: 'stats' }, cards.map(([k, v]) => h('div', { class: 'stat' }, h('strong', { text: String(v) }), h('span', { text: k })))));
  },

  async drivers(root) {
    const list = await apiFetch('/admin/drivers');
    const rows = list.map((d) => {
      const toggle = h('button', { type: 'button', class: d.active ? 'secondary small' : 'small', text: d.active ? 'Disable' : 'Enable',
        onclick: safe(async () => { await apiPatch(`/admin/drivers/${d._id}`, { active: !d.active }); show('drivers'); }) });
      const remove = h('button', { type: 'button', class: 'danger small', text: 'Delete', onclick: safe(async () => {
        if (!confirm(`Permanently delete driver ${d.name} (${d.email})? Their vehicles will be available for reassignment.`)) return;
        remove.disabled = true;
        try {
          await apiDelete(`/accounts/drivers/${d._id}`);
          toast('Driver account deleted.');
          if (remove.isConnected) await show('drivers');
        } finally { remove.disabled = false; }
      }) });
      return h('tr', {}, td(d.name), td(d.email), td(d.status),
        td(d.vehicles.map((v) => `${v.type} ${v.plate}`).join(', ') || '—'), td(toggle, remove));
    });
    root.replaceChildren(table(['Name', 'Email', 'Status', 'Vehicles', 'Account'], rows));
  },

  async vehicles(root) {
    const [vehicles, drivers] = await Promise.all([apiFetch('/admin/vehicles'), apiFetch('/admin/drivers')]);
    const driverSel = h('select', { id: 'vDriver', 'aria-label': 'Assigned driver' }, h('option', { value: '', text: 'No driver' }), drivers.map((d) => h('option', { value: d._id, text: d.name })));
    const form = h('form', { class: 'inline-form' },
      h('select', { id: 'vType', 'aria-label': 'Vehicle type' }, h('option', { value: 'auto', text: 'Auto' }), h('option', { value: 'bus', text: 'Bus' })),
      h('input', { id: 'vPlate', 'aria-label': 'Number plate', placeholder: 'Number plate', required: true }),
      h('input', { id: 'vCapacity', 'aria-label': 'Seat capacity', type: 'number', min: 1, max: 60, placeholder: 'Seats', required: true }),
      driverSel,
      h('button', { type: 'submit', text: 'Add vehicle' }));
    form.addEventListener('submit', safe(async (e) => {
      e.preventDefault();
      await apiPost('/admin/vehicles', {
        type: $a('vType').value, plate: $a('vPlate').value, capacity: Number($a('vCapacity').value), driverId: $a('vDriver').value || null
      });
      toast('Vehicle added.');
      show('vehicles');
    }));
    root.replaceChildren(form, table(['Type', 'Plate', 'Seats', 'In use', 'Driver', 'Active', ''], vehicles.map((v) => h('tr', {},
      td(v.type), td(v.plate), td(v.capacity), td(`${v.reservedSeats}/${v.capacity}`), driverAssignment(v, drivers), td(v.active ? 'yes' : 'no'),
      td(h('button', { type: 'button', class: 'danger small', text: 'Delete', onclick: safe(async () => {
        if (!confirm(`Delete ${v.plate}?`)) return;
        await apiDelete(`/admin/vehicles/${v._id}`); show('vehicles');
      }) }))))));
  },

  async bookings(root) {
    const list = await apiFetch('/admin/bookings');
    root.replaceChildren(table(['When', 'Passenger', 'Driver', 'Route', 'Status', 'Fare'], list.map((b) => h('tr', {},
      td(new Date(b.createdAt).toLocaleString()), td(b.user ? b.user.name : '—'), td(b.driver ? b.driver.name : '—'),
      td(`${placeLabel(b.pickupName, b.pickupLocation)} → ${placeLabel(b.dropName, b.dropLocation)}`), td(statusBadge(b.status)), td(rideFareLabel(b))))));
  },

  async admins(root) {
    const admins = await apiFetch('/accounts/admins');
    const name = h('input', { id: 'adminName', required: true, minlength: 2, maxlength: 80 });
    const email = h('input', { id: 'adminEmail', type: 'email', required: true });
    const password = h('input', { id: 'adminPassword', type: 'password', autocomplete: 'new-password', minlength: 8, required: true });
    const button = h('button', { type: 'submit', text: 'Create admin' });
    const form = h('form', {}, h('h2', { text: 'Create an admin' }),
      h('label', { for: name.id, text: 'Full name' }), name,
      h('label', { for: email.id, text: 'Login email' }), email,
      h('label', { for: password.id, text: 'Password (8+ characters, including a letter and a number)' }), password, button);
    form.addEventListener('submit', safe(async (event) => {
      event.preventDefault();
      button.disabled = true;
      try {
        await apiPost('/accounts/admins', { name: name.value, email: email.value, password: password.value });
        form.reset();
        toast('Admin account created.');
        if (form.isConnected) await show('admins');
      } finally { button.disabled = false; }
    }));
    root.replaceChildren(form, table(['Admin name', 'Email'], admins.map((a) => h('tr', {}, td(a.name), td(a.email)))));
  },

  async walletRequests(root) {
    const list = await apiFetch('/wallet/requests');
    if (!list.length) {
      root.replaceChildren(h('p', { text: 'No pending wallet requests.' }));
      return;
    }
    const rows = list.map(({ name, email, request }) => {
      const action = (label, status) => h('button', { type: 'button', class: 'small', text: label, onclick: safe(async () => {
        try {
          await apiPatch('/wallet/requests/' + request._id, { status });
          toast(`Request ${status} for ${email}.`);
        } finally {
          if (root.isConnected && document.querySelector('[data-tab="walletRequests"]').classList.contains('active')) await show('walletRequests');
        }
      }) });
      return h('tr', {}, td(name), td(email), td(money(request.amount)), td(new Date(request.requestedAt).toLocaleString()),
        td(action('Approve', 'approved'), action('Reject', 'rejected')));
    });
    root.replaceChildren(table(['Student', 'Email', 'Amount', 'Requested', 'Decision'], rows));
  },

  async users(root) {
    const list = await apiFetch('/admin/users');
    root.replaceChildren(table(['Name', 'Email', 'Role', 'Wallet', 'Top up', 'Account'], list.map((u) => {
      const amount = h('input', { type: 'number', min: 1, max: 100000, placeholder: '₹', 'aria-label': 'Wallet top-up for ' + u.email, class: 'amount' });
      return h('tr', {}, td(u.name), td(u.email), td(u.role), td(u.role === 'staff' ? 'Free staff rides' : money(u.walletBalance)),
        u.role === 'staff' ? td('—') : td(amount, h('button', { type: 'button', class: 'small', text: 'Add', onclick: safe(async () => {
          await apiPost(`/admin/users/${u._id}/wallet`, { amount: Number(amount.value) }); toast('Wallet updated.'); show('users');
        }) })),
        td(h('button', { type: 'button', class: u.active ? 'secondary small' : 'small', text: u.active ? 'Disable' : 'Enable',
          onclick: safe(async () => { await apiPatch(`/admin/users/${u._id}`, { active: !u.active }); show('users'); }) }),
          h('button', { type: 'button', class: 'danger small', text: 'Delete', onclick: safe(async () => {
            if (!confirm(`Permanently delete ${u.name} (${u.email})? ${u.role === 'student' ? 'Any remaining wallet credit will be lost. ' : ''}Ride history will be kept.`)) return;
            await apiDelete(`/accounts/passengers/${u._id}`);
            toast('Passenger account deleted.');
            show('users');
          }) })));
    })));
  }
};

async function show(name) {
  document.querySelectorAll('[data-tab]').forEach((button) => {
    const active = button.dataset.tab === name;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
    if (active) $a('adminTitle').textContent = button.textContent.trim();
  });
  const root = h('div', {}, h('p', { class: 'muted', text: 'Loading…' }));
  $a('adminView').replaceChildren(root);
  try { await views[name](root); } catch (err) { root.replaceChildren(h('p', { class: 'error-text', text: err.message })); }
}

(async () => {
  const user = await requireLogin(['admin']);
  if (!user) return;
  document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
  show('overview');
})();
