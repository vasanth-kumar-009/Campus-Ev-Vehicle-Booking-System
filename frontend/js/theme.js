// Apply the preference before the styles and page content load.
(() => {
  const key = 'campus-ev-theme';
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  let preference;
  try { preference = localStorage.getItem(key); } catch { /* Storage can be unavailable. */ }

  function apply() {
    const dark = preference === 'dark' || (preference !== 'light' && system.matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    const toggle = document.getElementById('themeToggle');
    if (toggle) {
      toggle.setAttribute('aria-pressed', String(dark));
      toggle.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = dark ? '#101b17' : '#f6f7ef';
  }
  apply();
  system.addEventListener('change', apply);
  window.addEventListener('storage', (event) => {
    if (event.key === key || event.key === null) { preference = event.newValue; apply(); }
  });
  document.addEventListener('DOMContentLoaded', () => {
    apply();
    document.getElementById('themeToggle').addEventListener('click', () => {
      preference = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(key, preference); } catch { /* This page still switches. */ }
      apply();
    });
  });
})();
