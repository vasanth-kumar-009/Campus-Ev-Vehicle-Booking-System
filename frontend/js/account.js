const deletionForm = document.getElementById('deleteAccountForm');
deletionForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!confirm('Permanently delete your account? This cannot be undone.')) return;
  const button = deletionForm.querySelector('button');
  const password = document.getElementById('deletePassword');
  const message = document.getElementById('deleteMessage');
  button.disabled = true;
  message.textContent = '';
  try {
    await apiFetch('/accounts/me', {
      method: 'DELETE',
      body: JSON.stringify({ password: password.value })
    });
    clearProfile();
    location.replace('login.html');
  } catch (err) {
    message.textContent = err.message;
  } finally {
    password.value = '';
    button.disabled = false;
  }
});
