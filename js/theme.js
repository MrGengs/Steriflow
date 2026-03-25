// ============================================================
//  SteriFlow — Theme Manager (Dark / Light)
//  Persists to localStorage, applies on all pages
// ============================================================

(function() {
  'use strict';

  const STORAGE_KEY = 'steriflow-theme';

  // Apply saved theme immediately (before page renders)
  function getTheme() {
    return localStorage.getItem(STORAGE_KEY) || 'dark';
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);

    // Update meta theme-color
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.content = theme === 'light' ? '#f0f2f5' : '#0a0a1a';
    }
  }

  function saveTheme(theme) {
    localStorage.setItem(STORAGE_KEY, theme);
  }

  // Apply on load (runs synchronously before paint)
  applyTheme(getTheme());

  // Setup toggle on DOMContentLoaded
  document.addEventListener('DOMContentLoaded', () => {
    const toggle = document.getElementById('themeToggle');
    if (!toggle) return;

    // Set initial state
    toggle.checked = getTheme() === 'light';

    toggle.addEventListener('change', () => {
      const theme = toggle.checked ? 'light' : 'dark';
      applyTheme(theme);
      saveTheme(theme);
    });
  });

})();
