// Login, registration, email verification and password reset pages.
const sessionFor = (type) => (type === 'driver' ? 'driver' : 'user');
const params = new URLSearchParams(location.search);
const msg = document.getElementById('formMessage');

/* ---------- login ---------- */
const loginForm = document.getElementById('loginForm');
if (loginForm) {
  const role = params.get('role');
  const selectedRole = ['student', 'staff', 'driver', 'admin'].includes(role) ? role : null;
  if (selectedRole) {
    const label = selectedRole[0].toUpperCase() + selectedRole.slice(1);
    document.getElementById('loginTitle').textContent = label + ' login';
    document.getElementById('changeRole').hidden = false;
  }
  let verification = null;
  if (params.get('expired')) showMessage(msg, 'Your session expired. Please log in again.', 'warn');
  const resend = document.getElementById('resendButton');

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (resend) resend.hidden = true;
    verification = null;
    const email = document.getElementById('email').value.trim();
    try {
      const credentials = { email, password: document.getElementById('password').value };
      if (selectedRole) credentials.role = selectedRole;
      const { user } = await apiPost('/sign-in', credentials, { noRedirect: true });
      saveProfile(user, sessionFor(user.role));
      location.href = homeFor(user.role); // the role comes from the server
    } catch (err) {
      showMessage(msg, err.message, 'error');
      if (err.code === 'EMAIL_NOT_VERIFIED' && resend) {
        verification = { email, type: err.verificationType };
        resend.hidden = false;
      }
    }
  });

  if (resend) {
    resend.addEventListener('click', async () => {
      try {
        if (!verification) return;
        const r = await apiPost('/auth/resend-verification', verification, { noRedirect: true });
        showMessage(msg, r.message, 'ok');
      } catch (err) { showMessage(msg, err.message, 'error'); }
    });
  }
}

/* ---------- register ---------- */
const registerForm = document.getElementById('registerForm');
if (registerForm) {
  const role = document.getElementById('role');
  const driverFields = document.getElementById('driverFields');
  const vehicleType = document.getElementById('vehicleType');
  const capacity = document.getElementById('capacity');
  const syncFields = () => { driverFields.hidden = role.value !== 'driver'; };
  role.addEventListener('change', syncFields);
  vehicleType.addEventListener('change', () => { capacity.value = vehicleType.value === 'bus' ? 20 : 3; });
  syncFields();

  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      name: document.getElementById('name').value.trim(),
      email: document.getElementById('email').value.trim(),
      password: document.getElementById('password').value,
      role: role.value
    };
    if (body.role === 'driver') {
      body.vehicleType = vehicleType.value;
      body.plate = document.getElementById('plate').value.trim();
      body.capacity = Number(capacity.value);
    }
    try {
      const r = await apiPost('/auth/register', body, { session: sessionFor(body.role), noRedirect: true });
      showMessage(msg, r.message, 'ok');
      registerForm.reset();
      syncFields();
      setTimeout(() => { location.href = 'login.html'; }, r.verificationRequired ? 4000 : 1500);
    } catch (err) { showMessage(msg, err.message, 'error'); }
  });
}

/* ---------- forgot password ---------- */
const forgotForm = document.getElementById('forgotForm');
if (forgotForm) {
  forgotForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await apiPost('/auth/forgot-password', {
        email: document.getElementById('email').value.trim(),
        type: document.getElementById('type').value
      }, { noRedirect: true });
      showMessage(msg, r.message, 'ok');
    } catch (err) { showMessage(msg, err.message, 'error'); }
  });
}

/* ---------- reset password (link from email) ---------- */
const resetForm = document.getElementById('resetForm');
if (resetForm) {
  resetForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await apiPost('/auth/reset-password', {
        token: params.get('token') || '',
        type: params.get('type') || 'user',
        password: document.getElementById('password').value
      }, { noRedirect: true });
      showMessage(msg, r.message, 'ok');
      setTimeout(() => { location.href = 'login.html'; }, 1800);
    } catch (err) { showMessage(msg, err.message, 'error'); }
  });
}

/* ---------- verify email (link from email) ---------- */
if (document.getElementById('verifyBox')) {
  (async () => {
    try {
      const r = await apiPost('/auth/verify-email', { token: params.get('token') || '', type: params.get('type') || 'user' }, { noRedirect: true });
      showMessage(msg, r.message, 'ok');
    } catch (err) { showMessage(msg, err.message, 'error'); }
  })();
}
