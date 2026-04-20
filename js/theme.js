// ============================================================
//  SteriFlow — Theme Manager (Dark / Light)
//  Persists to localStorage, applies on all pages.
//
//  HTML usage:
//    <input type="checkbox" id="themeToggle">      ← checked = light
//    <button data-theme-toggle>…</button>          ← any button flips dark↔light
//    <button data-theme-set="light">Light</button> ← explicit set
//
//  JS:
//    SteriflowTheme.get()         // 'dark' | 'light'
//    SteriflowTheme.set('light')
//    SteriflowTheme.toggle()
//    window.addEventListener('theme:change', e => console.log(e.detail.theme));
// ============================================================

(function() {
  'use strict';

  const STORAGE_KEY = 'steriflow-theme';

  function getTheme() {
    const v = localStorage.getItem(STORAGE_KEY);
    return (v === 'light' || v === 'dark') ? v : 'dark';
  }

  function saveTheme(theme) {
    localStorage.setItem(STORAGE_KEY, theme);
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);

    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === 'light' ? '#f0f2f5' : '#0a0a1a';

    // Sinkron checkbox + tombol
    const cb = document.getElementById('themeToggle');
    if (cb) cb.checked = (theme === 'light');

    document.querySelectorAll('[data-theme-toggle]').forEach(btn => {
      btn.setAttribute('aria-pressed', theme === 'light' ? 'true' : 'false');
    });
    document.querySelectorAll('[data-theme-set]').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-theme-set') === theme);
    });

    try {
      window.dispatchEvent(new CustomEvent('theme:change', { detail: { theme } }));
    } catch (_) {}
  }

  function setTheme(theme) {
    if (theme !== 'dark' && theme !== 'light') return;
    saveTheme(theme);
    applyTheme(theme);
  }

  function toggleTheme() {
    setTheme(getTheme() === 'light' ? 'dark' : 'light');
  }

  // Terapkan segera sebelum paint supaya tidak flash
  applyTheme(getTheme());

  document.addEventListener('DOMContentLoaded', () => {
    applyTheme(getTheme());

    // Checkbox lama (id=themeToggle)
    const cb = document.getElementById('themeToggle');
    if (cb) {
      cb.checked = getTheme() === 'light';
      cb.addEventListener('change', () => setTheme(cb.checked ? 'light' : 'dark'));
    }

    // Tombol generik (data-theme-toggle)
    document.querySelectorAll('[data-theme-toggle]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        toggleTheme();
      });
    });

    // Tombol set eksplisit (data-theme-set="dark|light")
    document.querySelectorAll('[data-theme-set]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        setTheme(btn.getAttribute('data-theme-set'));
      });
    });
  });

  window.SteriflowTheme = { get: getTheme, set: setTheme, toggle: toggleTheme };
})();
