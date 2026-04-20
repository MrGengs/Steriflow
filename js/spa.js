// ============================================================
//  SteriFlow — SPA-lite router
//
//  Tujuan: perpindahan antar halaman aplikasi (dashboard, monitoring,
//  ai-detection, ai-chat, history, account) tanpa full reload —
//  swap body innerHTML + re-run inline <script>. Script <script src>
//  hanya di-load sekali (modul sudah di-cache), jadi koneksi Firebase
//  tetap hidup. Index & auth tetap navigasi normal.
//
//  API publik:
//    window.SteriflowSPA.navigate(url)     — pindah halaman programmatis
//    window.SteriflowSPA.onPageChange(fn)  — subscribe event ganti page
//    window.__spaCleanup.push(fn)          — daftar fungsi cleanup
//                                            sebelum body di-swap
// ============================================================

(function () {
  'use strict';

  const APP_PAGES = ['dashboard.html', 'monitoring.html', 'ai-detection.html',
                     'ai-chat.html',   'history.html',    'account.html'];

  window.__spaCleanup = window.__spaCleanup || [];
  const pageChangeHandlers = [];

  // Set URL absolut script yang sudah pernah di-load. Persisten lintas
  // navigasi — saat body di-swap, script element lama hilang dari DOM
  // tapi kode-nya sudah tereksekusi di global scope. Jadi jangan re-inject.
  const loadedScripts = new Set();
  function markLoadedScript(src) {
    if (!src) return;
    try { loadedScripts.add(new URL(src, location.href).href); } catch (_) {}
  }
  // Isi awal: semua <script src> yang sudah ada di document saat SPA init.
  document.querySelectorAll('script[src]').forEach(s => markLoadedScript(s.getAttribute('src')));

  function pageOf(u) {
    try {
      const p = new URL(u, location.href).pathname;
      return p.substring(p.lastIndexOf('/') + 1) || 'index.html';
    } catch (_) { return ''; }
  }

  function isAppUrl(u) {
    try {
      const url = new URL(u, location.href);
      if (url.origin !== location.origin) return false;
      return APP_PAGES.includes(pageOf(url.href));
    } catch (_) { return false; }
  }

  function runCleanups() {
    const fns = window.__spaCleanup.splice(0);
    for (const fn of fns) {
      try { fn(); } catch (e) { console.warn('[SPA] cleanup err:', e); }
    }
  }

  // Script dengan src sama sudah pernah dimuat? Pakai Set persisten di atas.
  function scriptAlreadyLoaded(src) {
    if (!src) return false;
    try {
      return loadedScripts.has(new URL(src, location.href).href);
    } catch (_) { return false; }
  }

  async function runScript(oldScript, baseUrl) {
    // Inline script → selalu buat elemen baru supaya browser execute.
    if (!oldScript.src && !oldScript.getAttribute('src')) {
      const s = document.createElement('script');
      if (oldScript.type) s.type = oldScript.type;
      s.textContent = oldScript.textContent;
      document.body.appendChild(s);
      return;
    }

    // Script dengan src.
    const rawSrc = oldScript.getAttribute('src');
    const abs = new URL(rawSrc, baseUrl).href;
    if (scriptAlreadyLoaded(abs) || scriptAlreadyLoaded(rawSrc)) {
      // Sudah di-load pada navigasi sebelumnya / initial load → skip.
      return;
    }
    const s = document.createElement('script');
    if (oldScript.type) s.type = oldScript.type;
    s.src = abs;
    s.setAttribute('data-spa-src', abs);
    markLoadedScript(abs);      // tandai segera — cegah double load kalau fetch lambat
    await new Promise((resolve) => {
      s.onload  = () => resolve();
      s.onerror = () => { console.warn('[SPA] script load fail:', abs); resolve(); };
      document.body.appendChild(s);
    });
  }

  async function navigate(target, { push = true } = {}) {
    const url = new URL(target, location.href);
    console.log('[SPA] →', url.pathname + url.search + url.hash);

    if (document.body.__spaBusy) {
      console.log('[SPA] navigation already in progress, ignoring');
      return;
    }
    document.body.__spaBusy = true;
    document.body.classList.add('spa-navigating');

    try {
      const t0 = performance.now();
      const res = await fetch(url.href, {
        credentials: 'same-origin',
        headers: { 'X-SPA': '1' }
      });
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      console.log('[SPA] fetched', Math.round(performance.now() - t0), 'ms');

      // Cleanup subscription/timers dari halaman sebelumnya.
      runCleanups();

      // Ganti judul tab.
      if (doc.title) document.title = doc.title;

      // Copy body class (misal "lp-body" untuk landing).
      const newBodyClass = doc.body.getAttribute('class') || '';
      document.body.className = newBodyClass;

      // Pisahkan script dari body baru — biar innerHTML bersih dari script
      // yang tidak auto-execute.
      const newBody = doc.body;
      const scripts = Array.from(newBody.querySelectorAll('script'));
      scripts.forEach(s => s.remove());

      // Update URL sebelum swap, supaya script baru membaca location yang benar.
      if (push) history.pushState({ spa: true, url: url.href }, '', url.href);

      // Swap body content (non-script).
      document.body.innerHTML = newBody.innerHTML;

      // Jalankan ulang script dari halaman tujuan (inline = re-run,
      // src baru = load, src yang sudah ada = skip).
      for (const s of scripts) {
        await runScript(s, url.href);
      }

      // Terapkan ulang i18n ke DOM baru.
      if (window.SteriflowI18n && typeof window.SteriflowI18n.applyLang === 'function') {
        window.SteriflowI18n.applyLang(window.SteriflowI18n.getLang());
      }

      // Sinkronkan theme attribute (theme.js sudah kerja global,
      // ini hanya safety net untuk meta theme-color).
      if (window.SteriflowTheme && typeof window.SteriflowTheme.get === 'function') {
        document.documentElement.setAttribute('data-theme', window.SteriflowTheme.get());
      }

      // Scroll ke hash (kalau ada) atau ke atas.
      if (url.hash) {
        setTimeout(() => {
          const el = document.getElementById(url.hash.slice(1));
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 180);
      } else {
        window.scrollTo(0, 0);
      }

      // Notifikasi ke module yang ingin tahu (realtime.js dsb.).
      const evtDetail = { url: url.href, page: pageOf(url.href) };
      for (const fn of pageChangeHandlers) {
        try { fn(evtDetail); } catch (e) { console.warn('[SPA] page handler:', e); }
      }
      window.dispatchEvent(new CustomEvent('spa:navigate', { detail: evtDetail }));

      console.log('[SPA] ✓ total', Math.round(performance.now() - t0), 'ms');
    } catch (e) {
      console.error('[SPA] nav failed — fallback hard reload:', e);
      location.href = url.href;
    } finally {
      document.body.__spaBusy = false;
      document.body.classList.remove('spa-navigating');
    }
  }

  // Intercept klik pada <a href> dalam-app.
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button !== 0) return;
    const a = e.target.closest('a[href]');
    if (!a) return;
    const t = a.getAttribute('target');
    if (t && t !== '' && t !== '_self') return;
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
    if (!isAppUrl(href)) return;  // index.html / auth.html / external → biarkan browser
    e.preventDefault();
    navigate(href);
  });

  // Back / Forward.
  window.addEventListener('popstate', () => {
    if (isAppUrl(location.href)) {
      navigate(location.href, { push: false });
    } else {
      // Keluar dari app → let browser reload normally.
      location.reload();
    }
  });

  // Transition styling: small fade during swap, tidak ganggu layout.
  (function injectStyle() {
    if (document.getElementById('spa-style')) return;
    const st = document.createElement('style');
    st.id = 'spa-style';
    st.textContent = `
      body.spa-navigating{cursor:progress;}
      body.spa-navigating .page-wrapper{opacity:0.55;transition:opacity .15s ease;}
      .page-wrapper{transition:opacity .22s ease;}
    `;
    document.head.appendChild(st);
  })();

  window.SteriflowSPA = {
    navigate,
    isAppUrl,
    onPageChange(fn) {
      if (typeof fn === 'function') pageChangeHandlers.push(fn);
      return () => {
        const i = pageChangeHandlers.indexOf(fn);
        if (i >= 0) pageChangeHandlers.splice(i, 1);
      };
    },
    pageOf
  };
})();
