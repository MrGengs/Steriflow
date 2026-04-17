/**
 * SteriFlow — Gemini API keys (browser-side; still visible to visitors).
 *
 * Setup:
 *   cp js/gemini-config.example.js js/gemini-config.js
 *   Edit js/gemini-config.js and paste your keys from Google AI Studio.
 *
 * Multiple keys enable automatic fallback when one key is rate-limited.
 * js/gemini-config.js is listed in .gitignore so it will not be committed.
 */
window.__GEMINI_API_KEYS__ = [
  'PASTE_YOUR_GEMINI_API_KEY_1_HERE',
  'PASTE_YOUR_GEMINI_API_KEY_2_HERE'
];

// Backward compat
window.__GEMINI_API_KEY__ = window.__GEMINI_API_KEYS__[0];
