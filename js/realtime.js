// ============================================================
//  SteriFlow — Firebase Realtime Database Integration
//
//  Struktur RTDB aktual (per ESP32 + ESP32-CAM):
//    /steriflow-001
//      ├── camera/      { ip, streamUrl, captureUrl, online, lastSeen, rssi }
//      ├── relay/       { fan, fan_mode, pump, pump_mode, uv, uv_mode }
//      ├── sensorData/
//      │     ├── dht11/ { temperature, humidity }
//      │     └── voc/   { ppm, status }
//      ├── status/      { hum_alert, temp_alert, voc_alert }
//      ├── relayCommand/{ fan, uv }         (dari app → ESP)
//      ├── sterilizationStatus/{ active, remainingSeconds, ... }
//      └── timestamp
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.7.3/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js";
import {
  getDatabase,
  ref,
  onValue,
  set,
  update
} from "https://www.gstatic.com/firebasejs/11.7.3/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js";

// ── Init (share app dengan auth.js kalau sudah diinisialisasi) ──
let app;
try { app = initializeApp(firebaseConfig); } catch (e) {
  const { getApp } = await import("https://www.gstatic.com/firebasejs/11.7.3/firebase-app.js");
  app = getApp();
}
const auth = getAuth(app);
const db   = getDatabase(app);

// ── Device ID ────────────────────────────────────────────────
const DEVICE_ID = 'steriflow-001';

// ── References ───────────────────────────────────────────────
const deviceRef       = ref(db, `${DEVICE_ID}`);
const relayCmdRef     = ref(db, `${DEVICE_ID}/relayCommand`);
const sterilStatusRef = ref(db, `${DEVICE_ID}/sterilizationStatus`);

// ── State ────────────────────────────────────────────────────
let currentDevice = {
  sensorData: {
    dht11: { temperature: 0, humidity: 0 },
    voc:   { ppm: 0, status: 'GOOD' }
  },
  relay:  { fan: 'OFF', fan_mode: 'MANUAL', pump: 'OFF', pump_mode: 'MANUAL', uv: 'OFF', uv_mode: 'MANUAL' },
  status: { hum_alert: 'NORMAL', temp_alert: 'NORMAL', voc_alert: 'GOOD' },
  timestamp: 0
};

let currentRelayCommand = { fan: false, uv: false, pump: false };

// Chart history
const HISTORY_LEN = 20;
const vocHistory  = new Array(HISTORY_LEN).fill(null);
const tempHistory = new Array(HISTORY_LEN).fill(null);
const humHistory  = new Array(HISTORY_LEN).fill(null);
const gasHistory  = new Array(HISTORY_LEN).fill(null);
let historyInitialized = false;

window.__realtimeActive = false;

// ── localStorage cache for sterilizationStatus ───────────────
// Dipakai untuk rehidrasi UI secara instan sebelum Firebase onValue pertama
// firing — menghilangkan kedipan "Standby" saat halaman di-refresh di tengah
// siklus sterilisasi atau saat user berpindah halaman.
const STERIL_CACHE_KEY = 'steriflow:sterilStatus:v1';
function readSterilCache() {
  try {
    const raw = localStorage.getItem(STERIL_CACHE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || !s.active) return null;
    // Stale guard: abaikan cache kalau cycle-nya seharusnya sudah selesai.
    if (s.startedAt && s.totalSeconds) {
      const endsAt = Number(s.startedAt) + Number(s.totalSeconds) * 1000;
      if (Date.now() > endsAt + 5000) { localStorage.removeItem(STERIL_CACHE_KEY); return null; }
    }
    return s;
  } catch (_) { return null; }
}
function writeSterilCache(status) {
  try {
    if (status && status.active) localStorage.setItem(STERIL_CACHE_KEY, JSON.stringify(status));
    else localStorage.removeItem(STERIL_CACHE_KEY);
  } catch (_) {}
}

// ── Global sterilization banner (semua halaman kecuali monitoring.html) ──
// Dideklarasi di sini (sebelum refresh dipanggil) supaya tidak kena TDZ.
// Countdown + tombol Stop. Klik banner → pindah ke monitoring.html#steril.
let sterilBannerEl     = null;
let sterilBannerTicker = null;
// latestSterilStatus ditempatkan di sini juga supaya banner bisa membacanya
// tanpa tabrakan TDZ saat hydration dari cache di refresh().
let latestSterilStatus = null;

function pageIsMonitoring() {
  const p = window.location.pathname;
  const page = p.substring(p.lastIndexOf('/') + 1) || 'index.html';
  return page === 'monitoring.html';
}

function bannerFmtMMSS(sec) {
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function ensureBannerStyles() {
  if (document.getElementById('sterilBannerStyles')) return;
  const st = document.createElement('style');
  st.id = 'sterilBannerStyles';
  st.textContent = `
    #sterilBanner {
      position: fixed;
      top: 12px;
      left: 50%;
      transform: translate(-50%, -140%);
      z-index: 9999;
      display: none;
      align-items: center;
      gap: 12px;
      padding: 9px 14px;
      border-radius: 14px;
      background: rgba(15,15,30,0.88);
      border: 1px solid rgba(124,92,252,0.55);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      box-shadow: 0 8px 28px rgba(124,92,252,0.3), 0 2px 8px rgba(0,0,0,0.3);
      color: var(--text, #e8e8f4);
      font-family: 'Outfit', sans-serif;
      font-size: 0.78rem;
      cursor: pointer;
      transition: transform 0.32s cubic-bezier(0.22, 0.9, 0.35, 1);
      max-width: calc(100vw - 24px);
      user-select: none;
    }
    #sterilBanner.visible { display: inline-flex; transform: translate(-50%, 0); }
    #sterilBanner .pulse-dot {
      width: 9px; height: 9px;
      border-radius: 50%;
      background: var(--accent, #7c5cfc);
      box-shadow: 0 0 10px var(--accent, #7c5cfc);
      animation: pulseLive 1s infinite;
      flex-shrink: 0;
    }
    #sterilBanner .steril-label {
      font-size: 0.58rem;
      color: var(--text-dim, rgba(232,232,244,0.55));
      letter-spacing: 0.08em;
      text-transform: uppercase;
      line-height: 1.1;
    }
    #sterilBanner .steril-remain {
      font-family: 'Sora', sans-serif;
      font-size: 1rem;
      font-weight: 700;
      color: var(--accent, #7c5cfc);
      letter-spacing: 0.04em;
      line-height: 1.1;
    }
    #sterilBanner .steril-stop {
      padding: 6px 12px;
      border-radius: 10px;
      border: 1px solid rgba(255,255,255,0.16);
      background: rgba(255,255,255,0.06);
      color: inherit;
      font-family: inherit;
      font-size: 0.72rem;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s ease;
    }
    #sterilBanner .steril-stop:hover { background: rgba(255,255,255,0.14); }
  `;
  document.head.appendChild(st);
}

function ensureBannerEl() {
  if (sterilBannerEl && document.body.contains(sterilBannerEl)) return sterilBannerEl;
  if (!document.body) return null;
  ensureBannerStyles();
  const el = document.createElement('div');
  el.id = 'sterilBanner';
  el.setAttribute('role', 'status');
  el.innerHTML = `
    <span class="pulse-dot"></span>
    <div style="display:flex;flex-direction:column;">
      <span class="steril-label">Sterilisasi aktif</span>
      <span class="steril-remain" id="sterilBannerRemain">00:00</span>
    </div>
    <button type="button" class="steril-stop" id="sterilBannerStop">Stop</button>
  `;
  document.body.appendChild(el);

  el.addEventListener('click', (ev) => {
    if (ev.target.closest('#sterilBannerStop')) return;
    if (!pageIsMonitoring()) window.location.href = 'monitoring.html#steril';
  });
  el.querySelector('#sterilBannerStop').addEventListener('click', (ev) => {
    ev.stopPropagation();
    // stopSterilizationNow ada di bawah — hoisted sebagai function declaration.
    stopSterilizationNow();
  });
  sterilBannerEl = el;
  return el;
}

function renderSterilBanner(status) {
  const isActive = !!(status && status.active && status.startedAt && status.totalSeconds);
  if (!isActive || pageIsMonitoring()) {
    if (sterilBannerEl) sterilBannerEl.classList.remove('visible');
    if (sterilBannerTicker) { clearInterval(sterilBannerTicker); sterilBannerTicker = null; }
    return;
  }
  const el = ensureBannerEl();
  if (!el) return;
  el.classList.add('visible');
  tickSterilBanner();
  if (!sterilBannerTicker) sterilBannerTicker = setInterval(tickSterilBanner, 1000);
}

function tickSterilBanner() {
  const s = latestSterilStatus;
  if (!s || !sterilBannerEl) return;
  const elapsed = Math.max(0, Math.floor((Date.now() - s.startedAt) / 1000));
  const total = Number(s.totalSeconds) || 0;
  const remaining = Math.max(0, total - elapsed);
  const remainEl = sterilBannerEl.querySelector('#sterilBannerRemain');
  if (remainEl) remainEl.textContent = bannerFmtMMSS(remaining);
  if (remaining === 0 && elapsed >= total) {
    sterilBannerEl.classList.remove('visible');
    if (sterilBannerTicker) { clearInterval(sterilBannerTicker); sterilBannerTicker = null; }
  }
}

// ── Notification drawer (global, semua halaman kecuali index/auth) ──
let notifDrawerEl = null;

function ensureNotifDrawerStyles() {
  if (document.getElementById('notifDrawerStyles')) return;
  const st = document.createElement('style');
  st.id = 'notifDrawerStyles';
  st.textContent = `
    #notifDrawerOverlay {
      position: fixed;
      inset: 0;
      z-index: 9998;
      background: rgba(0,0,0,0.45);
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.2s ease;
      backdrop-filter: blur(2px);
      -webkit-backdrop-filter: blur(2px);
    }
    #notifDrawerOverlay.open { opacity: 1; pointer-events: auto; }
    #notifDrawer {
      position: fixed;
      top: 0; right: 0;
      z-index: 9999;
      width: min(380px, 92vw);
      height: 100dvh;
      background: rgba(15,15,30,0.96);
      border-left: 1px solid var(--glass-border, rgba(255,255,255,0.1));
      box-shadow: -12px 0 32px rgba(0,0,0,0.45);
      color: var(--text, #e8e8f4);
      font-family: 'Outfit', sans-serif;
      display: flex;
      flex-direction: column;
      transform: translateX(100%);
      transition: transform 0.28s cubic-bezier(0.22, 0.9, 0.35, 1);
    }
    [data-theme="light"] #notifDrawer {
      background: rgba(248,249,253,0.98);
      border-left-color: rgba(0,0,0,0.08);
    }
    #notifDrawer.open { transform: translateX(0); }
    #notifDrawer .notif-drawer-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 16px 18px 12px;
      border-bottom: 1px solid var(--glass-border, rgba(255,255,255,0.08));
    }
    #notifDrawer .notif-drawer-title {
      font-family: 'Sora', sans-serif;
      font-weight: 600;
      font-size: 1rem;
      letter-spacing: 0.01em;
    }
    #notifDrawer .notif-drawer-badge {
      background: var(--accent, #7c5cfc);
      color: #fff;
      font-size: 0.62rem;
      font-weight: 700;
      padding: 3px 9px;
      border-radius: 100px;
      min-width: 22px;
      text-align: center;
    }
    #notifDrawer .notif-drawer-close {
      background: transparent;
      border: none;
      color: inherit;
      cursor: pointer;
      padding: 6px;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0.7;
      transition: opacity 0.15s ease, background 0.15s ease;
    }
    #notifDrawer .notif-drawer-close:hover {
      opacity: 1;
      background: rgba(255,255,255,0.08);
    }
    #notifDrawer .notif-drawer-list {
      flex: 1;
      overflow-y: auto;
      padding: 10px 14px 18px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
  `;
  document.head.appendChild(st);
}

function ensureNotifDrawer() {
  if (notifDrawerEl && document.body.contains(notifDrawerEl)) return notifDrawerEl;
  if (!document.body) return null;
  ensureNotifDrawerStyles();

  const overlay = document.createElement('div');
  overlay.id = 'notifDrawerOverlay';
  overlay.addEventListener('click', closeNotifDrawer);

  const drawer = document.createElement('aside');
  drawer.id = 'notifDrawer';
  drawer.setAttribute('role', 'dialog');
  drawer.setAttribute('aria-label', 'Notifications');
  const titleText = (window.SteriflowI18n && window.SteriflowI18n.t)
    ? window.SteriflowI18n.t('common.notifications') : 'Notifikasi';
  drawer.innerHTML = `
    <div class="notif-drawer-head">
      <div style="display:flex;align-items:center;gap:10px;">
        <span class="notif-drawer-title" data-i18n="common.notifications">${titleText}</span>
        <span class="notif-drawer-badge" id="notifDrawerBadge">0</span>
      </div>
      <button type="button" class="notif-drawer-close" id="notifDrawerClose" aria-label="Close">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
    <div class="notif-drawer-list" id="notifDrawerList"></div>
  `;

  document.body.appendChild(overlay);
  document.body.appendChild(drawer);
  drawer.querySelector('#notifDrawerClose').addEventListener('click', closeNotifDrawer);

  notifDrawerEl = drawer;
  return drawer;
}

function openNotifDrawer() {
  const drawer = ensureNotifDrawer();
  if (!drawer) return;
  // Selalu pakai snapshot terbaru saat dibuka.
  renderNotifList(document.getElementById('notifDrawerList'), latestNotifications);
  const badge = document.getElementById('notifDrawerBadge');
  if (badge) badge.textContent = String(latestNotifications.length);
  drawer.classList.add('open');
  const overlay = document.getElementById('notifDrawerOverlay');
  if (overlay) overlay.classList.add('open');

  // Mark as read — sembunyikan dot sampai ada notif kritis baru.
  notifSeenKey = latestNotifications.map(n => n.id).join('|');
  try { localStorage.setItem(NOTIF_SEEN_STORAGE_KEY, notifSeenKey); } catch (_) {}
  const notifDot = document.getElementById('notifDot');
  if (notifDot) notifDot.style.display = 'none';
}

function closeNotifDrawer() {
  if (notifDrawerEl) notifDrawerEl.classList.remove('open');
  const overlay = document.getElementById('notifDrawerOverlay');
  if (overlay) overlay.classList.remove('open');
}

window.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && notifDrawerEl && notifDrawerEl.classList.contains('open')) {
    closeNotifDrawer();
  }
});

// ── Toggle relay via /relayCommand ───────────────────────────
export async function toggleUV(value) {
  try { await set(ref(db, `${DEVICE_ID}/relayCommand/uv`), value); }
  catch (e) { console.error('Failed to toggle UV:', e); }
}
export async function toggleFan(value) {
  try { await set(ref(db, `${DEVICE_ID}/relayCommand/fan`), value); }
  catch (e) { console.error('Failed to toggle Fan:', e); }
}
// Pompa sanitizer (Ethanol Spray) — toggle on/off manual dari dashboard.
// AI sterilization mem-pulse pompa sendiri; di sini user bisa nyalakan manual.
export async function togglePump(value) {
  try { await set(ref(db, `${DEVICE_ID}/relayCommand/pump`), value); }
  catch (e) { console.error('Failed to toggle Pump:', e); }
}
// Pulse pendek (default 800ms) untuk "semprot sekali".
export async function pulsePump(ms = 1000) {
  try {
    await set(ref(db, `${DEVICE_ID}/relayCommand/pump`), true);
    await new Promise(r => setTimeout(r, ms));
    await set(ref(db, `${DEVICE_ID}/relayCommand/pump`), false);
  } catch (e) {
    console.error('Failed to pulse Pump:', e);
    try { await set(ref(db, `${DEVICE_ID}/relayCommand/pump`), false); } catch (_) {}
  }
}

// ── Helpers ──────────────────────────────────────────────────
// Klasifikasi VOC dari string status (sensor mengirim "GOOD" / "WASPADA" / "BAHAYA").
function getVocLevel(rawStatus) {
  const s = String(rawStatus || '').toUpperCase();
  if (s === 'BAHAYA' || s === 'DANGER' || s === 'BAD' || s === 'HIGH' ||
      s === 'VERY UNHEALTHY' || s === 'UNHEALTHY' || s === 'POOR' || s === 'HAZARDOUS') {
    return { level: 'Danger',  color: 'var(--accent3)', badge: 'badge-dirty' };
  }
  if (s === 'WASPADA' || s === 'WARNING' || s === 'MODERATE' || s === 'MEDIUM') {
    return { level: 'Warning', color: 'var(--accent4)', badge: 'badge-moderate' };
  }
  return   { level: 'Normal',  color: 'var(--accent2)', badge: 'badge-clean' };
}

// ppm → % kebersihan (0 ppm = 100%, 10 ppm+ = 0%).
function cleanlinessFromPpm(ppm) {
  const p = Math.max(0, Math.min(10, Number(ppm) || 0));
  return Math.round((1 - p / 10) * 100);
}

// ── Dashboard UI ─────────────────────────────────────────────
function updateDashboardUI(dev, relayCmd) {
  const voc    = dev.sensorData?.voc   || {};
  const relay  = dev.relay              || {};
  const status = dev.status             || {};
  const vocInfo = getVocLevel(voc.status || status.voc_alert);
  const cleanPct = cleanlinessFromPpm(voc.ppm);

  // Bacteria kill % (inverse of VOC contamination)
  const homeBacteriaKill = document.getElementById('homeBacteriaKill');
  if (homeBacteriaKill) homeBacteriaKill.textContent = cleanPct;

  const bacteriaKillTrend = document.getElementById('bacteriaKillTrend');
  if (bacteriaKillTrend) {
    if (vocInfo.level === 'Normal') {
      bacteriaKillTrend.innerHTML = 'Bakteri terkendali';
      bacteriaKillTrend.style.color = 'var(--accent2)';
    } else if (vocInfo.level === 'Warning') {
      bacteriaKillTrend.innerHTML = 'Perlu sterilisasi';
      bacteriaKillTrend.style.color = 'var(--accent4)';
    } else {
      bacteriaKillTrend.innerHTML = 'Kontaminasi tinggi!';
      bacteriaKillTrend.style.color = 'var(--accent3)';
    }
  }

  // Tray status
  const trayStatus = document.getElementById('trayStatus');
  const trayStatusTrend = document.getElementById('trayStatusTrend');
  const t = (k) => (window.SteriflowI18n ? window.SteriflowI18n.t(k) : k);
  if (trayStatus) {
    if (vocInfo.level === 'Normal') {
      trayStatus.textContent = t('dash.tray.clean'); trayStatus.style.color = 'var(--accent2)';
      if (trayStatusTrend) { trayStatusTrend.textContent = t('dash.tray.clean_desc'); trayStatusTrend.style.color = 'var(--accent2)'; }
    } else if (vocInfo.level === 'Warning') {
      trayStatus.textContent = t('dash.tray.warn'); trayStatus.style.color = 'var(--accent4)';
      if (trayStatusTrend) { trayStatusTrend.textContent = t('dash.tray.warn_desc'); trayStatusTrend.style.color = 'var(--accent4)'; }
    } else {
      trayStatus.textContent = t('dash.tray.dirty'); trayStatus.style.color = 'var(--accent3)';
      if (trayStatusTrend) { trayStatusTrend.textContent = t('dash.tray.dirty_desc'); trayStatusTrend.style.color = 'var(--accent3)'; }
    }
  }

  // UV exposure minutes (simplified)
  const homeUvExposure = document.getElementById('homeUvExposure');
  if (homeUvExposure) homeUvExposure.textContent = relay.uv === 'ON' ? '~15' : '0';

  // UV toggle + label mengikuti relayCommand/uv
  const uvcToggle = document.getElementById('uvcToggle');
  const uvcStatus = document.getElementById('uvcStatus');
  const uvCmdOn = relayCmd.uv === true;
  if (uvcToggle) {
    uvcToggle.checked = uvCmdOn;
    if (uvcStatus) {
      uvcStatus.innerHTML = uvCmdOn
        ? '<span style="color:var(--accent);">ON</span>'
        : '<span style="color:var(--text-muted);">OFF</span>';
    }
  }

  // Fan toggle + label
  const fanToggle = document.getElementById('fanToggle');
  const fanStatus = document.getElementById('fanStatus');
  const fanCmdOn = relayCmd.fan === true;
  if (fanToggle) {
    fanToggle.checked = fanCmdOn;
    if (fanStatus) {
      fanStatus.innerHTML = fanCmdOn
        ? '<span style="color:var(--accent2);">ON</span>'
        : '<span style="color:var(--text-muted);">OFF</span>';
    }
  }

  // Ethanol Spray (pump) toggle + label — mengikuti relayCommand/pump.
  const ethanolToggle = document.getElementById('ethanolToggle');
  const ethanolStatus = document.getElementById('ethanolStatus');
  const pumpCmdOn = relayCmd.pump === true;
  if (ethanolToggle) {
    ethanolToggle.checked = pumpCmdOn;
    if (ethanolStatus) {
      ethanolStatus.innerHTML = pumpCmdOn
        ? '<span style="color:var(--accent4);">SPRAYING</span>'
        : '<span style="color:var(--text-muted);">OFF</span>';
    }
  }

  // Relay modes (dari /relay langsung)
  const dashUvMode      = document.getElementById('dashUvMode');
  const dashFanMode     = document.getElementById('dashFanMode');
  const dashEthanolMode = document.getElementById('dashEthanolMode');
  if (dashUvMode)      dashUvMode.textContent      = relay.uv_mode   || 'MANUAL';
  if (dashFanMode)     dashFanMode.textContent     = relay.fan_mode  || 'MANUAL';
  if (dashEthanolMode) dashEthanolMode.textContent = relay.pump_mode || 'MANUAL';

  // System status badge
  const systemStatus = document.getElementById('systemStatus');
  if (systemStatus) {
    const uvOn  = relay.uv  === 'ON';
    const fanOn = relay.fan === 'ON';
    if (uvOn || fanOn) {
      systemStatus.textContent = 'Sterilizing';
      systemStatus.className   = 'badge badge-sterilizing badge-lg';
    } else if (vocInfo.level === 'Danger') {
      systemStatus.textContent = 'Alert';
      systemStatus.className   = 'badge badge-dirty badge-lg';
    } else {
      systemStatus.textContent = 'Standby';
      systemStatus.className   = 'badge badge-standby badge-lg';
    }
  }

  // Cleanliness ring
  const cleanlinessLevel   = document.getElementById('cleanlinessLevel');
  const cleanlinessPercent = document.getElementById('cleanlinessPercent');
  const hygieneVal = document.getElementById('hygieneVal');
  const hygieneBar = document.getElementById('hygieneBar');
  if (cleanlinessLevel) {
    const tr = (k) => (window.SteriflowI18n ? window.SteriflowI18n.t(k) : k);
    if (vocInfo.level === 'Normal') {
      cleanlinessLevel.textContent = tr('dash.safe');        cleanlinessLevel.className = 'badge badge-clean';
    } else if (vocInfo.level === 'Warning') {
      cleanlinessLevel.textContent = tr('dash.tray.warn');   cleanlinessLevel.className = 'badge badge-moderate';
    } else {
      cleanlinessLevel.textContent = tr('dash.tray.dirty');  cleanlinessLevel.className = 'badge badge-dirty';
    }
  }
  if (cleanlinessPercent) cleanlinessPercent.textContent = cleanPct + '%';
  if (hygieneVal) hygieneVal.textContent = cleanPct + '%';
  if (hygieneBar) hygieneBar.style.width = cleanPct + '%';
  if (window.systemState) window.systemState.cleanliness = cleanPct;

  updateNotifications(dev);
}

// ── Monitoring UI ────────────────────────────────────────────
function updateMonitoringUI(dev, relayCmd) {
  const sgp30  = dev.sensorData?.sgp30 || {};
  const voc    = dev.sensorData?.voc   || {};  // legacy fallback
  const dht    = dev.sensorData?.dht11 || {};
  const relay  = dev.relay              || {};
  const status = dev.status             || {};

  // Bacteria proxy = TVOC (ppb) dari SGP30; eCO2 (ppm) = Gas dari SGP30.
  // Fallback ke path lama `voc.ppm` bila SGP30 belum kirim (perangkat legacy).
  const tvoc       = Number(sgp30.tvoc) || Number(voc.ppm) || 0;
  const eco2       = Number(sgp30.eco2) || 0;
  const tvocStatus = sgp30.tvoc_status || voc.status || status.voc_alert || 'GOOD';
  const eco2Status = sgp30.eco2_status || 'GOOD';
  const temp       = Number(dht.temperature) || 0;
  const humidity   = Number(dht.humidity)    || 0;

  // History buffer
  if (!historyInitialized) {
    vocHistory.fill(tvoc);
    gasHistory.fill(eco2);
    tempHistory.fill(temp);
    humHistory.fill(humidity);
    historyInitialized = true;
  } else {
    vocHistory.push(tvoc);      vocHistory.shift();
    gasHistory.push(eco2);      gasHistory.shift();
    tempHistory.push(temp);     tempHistory.shift();
    humHistory.push(humidity);  humHistory.shift();
  }

  // Bacteria card (TVOC dari SGP30, satuan ppb).
  // Progress bar: 0 → 2 ppb = 0 → 100% (batas aman < 1 ppb).
  const vocValue = document.getElementById('vocValue');
  const vocBar   = document.getElementById('vocBar');
  const vocStatusEl = document.getElementById('vocStatus');
  if (vocValue) vocValue.textContent = Math.round(tvoc).toString();
  if (vocBar)   vocBar.style.width   = Math.min(100, (tvoc / 2) * 100) + '%';
  if (vocStatusEl) {
    const raw = String(tvocStatus).toUpperCase();
    vocStatusEl.textContent = raw;
    vocStatusEl.style.color = getVocLevel(raw).color;
  }

  // Temperature
  const tempValue = document.getElementById('tempValue');
  const tempBar   = document.getElementById('tempBar');
  if (tempValue) tempValue.textContent = temp.toFixed(1);
  if (tempBar)   tempBar.style.width   = Math.min(100, (temp / 60) * 100) + '%';
  const tempTrend = document.getElementById('tempTrend');
  if (tempTrend) {
    const alertText = status.temp_alert || 'NORMAL';
    if (temp > 32) {
      tempTrend.textContent = 'Hot';   tempTrend.style.color = 'var(--accent3)';
    } else if (temp > 28) {
      tempTrend.textContent = 'Warm';  tempTrend.style.color = 'var(--accent4)';
    } else {
      tempTrend.textContent = alertText === 'NORMAL' ? 'Normal' : alertText;
      tempTrend.style.color = 'var(--accent2)';
    }
  }

  // Humidity
  const humidityValue = document.getElementById('humidityValue');
  const humidityBar   = document.getElementById('humidityBar');
  if (humidityValue) humidityValue.textContent = humidity.toFixed(1);
  if (humidityBar)   humidityBar.style.width   = Math.min(100, humidity) + '%';
  const humTrend = document.getElementById('humTrend');
  if (humTrend) {
    const alertText = status.hum_alert || 'NORMAL';
    if (humidity > 60) {
      humTrend.textContent = 'Too humid'; humTrend.style.color = 'var(--accent3)';
    } else if (humidity < 40) {
      humTrend.textContent = 'Too dry';   humTrend.style.color = 'var(--accent4)';
    } else {
      humTrend.textContent = alertText === 'NORMAL' ? 'Stable' : alertText;
      humTrend.style.color = 'var(--text-dim)';
    }
  }

  // Gas card (eCO2 dari SGP30, satuan ppm).
  // Progress bar: 0 → 1 ppm = 0 → 100% (batas aman < 0.5 ppm).
  const gasValueEl  = document.getElementById('gasValue');
  const gasBarEl    = document.getElementById('gasBar');
  const gasStatusEl = document.getElementById('gasStatus');
  if (gasValueEl) gasValueEl.textContent = Math.round(eco2).toString();
  if (gasBarEl)   gasBarEl.style.width   = Math.min(100, (eco2 / 1) * 100) + '%';
  if (gasStatusEl) {
    const raw = String(eco2Status).toUpperCase();
    gasStatusEl.textContent = raw;
    gasStatusEl.style.color = getVocLevel(raw).color;
  }

  // Fan card (RPM dummy — mengikuti relay.fan dari Firebase)
  const fanRpmEl   = document.getElementById('fanRpm');
  const fanBarEl   = document.getElementById('fanBar');
  const fanTrendEl = document.getElementById('fanTrend');
  const relayFanOn = relay.fan === 'ON';
  // Basis RPM ikut suhu & kelembapan dari Firebase; jitter tiap tick supaya bergerak hidup.
  fanRpmBase = 1100 + Math.round(temp * 6 + humidity * 0.5);
  if (fanRpmEl) {
    fanRpmEl.style.color = relayFanOn ? '#27c76a' : 'var(--text-dim)';
    if (!relayFanOn) fanRpmEl.textContent = 0;
  }
  if (fanBarEl) fanBarEl.style.width = relayFanOn ? '100%' : '0%';
  if (fanTrendEl) {
    const mode = (relay.fan_mode || 'MANUAL').toUpperCase();
    fanTrendEl.textContent = 'Mode ' + mode;
    fanTrendEl.style.color = 'var(--text-dim)';
  }
  // Start/stop ticker dummy saat relay.fan berubah.
  if (relayFanOn && !fanRpmTicker) {
    tickFanRpm();
    fanRpmTicker = setInterval(tickFanRpm, 800);
  } else if (!relayFanOn && fanRpmTicker) {
    clearInterval(fanRpmTicker); fanRpmTicker = null;
  }

  // VOC alert badge (support both ids for forward/backward compatibility)
  const vocInfo = getVocLevel(tvocStatus);
  const vocAlertEl = document.getElementById('monitorVocAlert') || document.getElementById('monitorGasAlert');
  if (vocAlertEl) {
    vocAlertEl.textContent = vocInfo.level.toUpperCase();
    vocAlertEl.className   = 'badge ' + vocInfo.badge;
  }

  // Sterilization status
  const monitorStatus     = document.getElementById('monitorStatus');
  const monitorUvc        = document.getElementById('monitorUvc');
  const monitorEthanol    = document.getElementById('monitorEthanol');
  const monitorFan        = document.getElementById('monitorFan');
  const monitorUvMode     = document.getElementById('monitorUvMode');
  const monitorFanMode    = document.getElementById('monitorFanMode');
  const monitorEthanolMode= document.getElementById('monitorEthanolMode');

  const uvOn    = relay.uv    === 'ON';
  const fanOn   = relay.fan   === 'ON';
  const pumpOn  = relay.pump  === 'ON';

  if (monitorStatus) {
    if (uvOn || fanOn) {
      monitorStatus.textContent = 'Sterilizing'; monitorStatus.className = 'badge badge-sterilizing';
    } else if (vocInfo.level === 'Danger') {
      monitorStatus.textContent = 'Alert';       monitorStatus.className = 'badge badge-dirty';
    } else {
      monitorStatus.textContent = 'Standby';     monitorStatus.className = 'badge badge-standby';
    }
  }
  if (monitorUvc) {
    monitorUvc.textContent = uvOn ? 'ACTIVE' : 'INACTIVE';
    monitorUvc.className   = uvOn ? 'status-pill active' : 'status-pill inactive';
  }
  if (monitorEthanol) {
    monitorEthanol.textContent = pumpOn ? 'ACTIVE' : 'INACTIVE';
    monitorEthanol.className   = pumpOn ? 'status-pill active' : 'status-pill inactive';
  }
  if (monitorFan) {
    monitorFan.textContent = fanOn ? 'ACTIVE' : 'INACTIVE';
    monitorFan.className   = fanOn ? 'status-pill active' : 'status-pill inactive';
  }
  if (monitorUvMode)      monitorUvMode.textContent      = relay.uv_mode   || 'MANUAL';
  if (monitorFanMode)     monitorFanMode.textContent     = relay.fan_mode  || 'MANUAL';
  if (monitorEthanolMode) monitorEthanolMode.textContent = relay.pump_mode || 'MANUAL';

  // Last updated
  const lastUpdated = document.getElementById('lastUpdated');
  if (lastUpdated) {
    lastUpdated.textContent = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  // Charts (app.js exposes these on window)
  if (typeof window.drawLineChart === 'function') {
    window.drawLineChart('vocChart', vocHistory, '#7c5cfc', { unit: ' ppb' });
    window.drawLineChart('gasChart', gasHistory, '#ffc247', { unit: ' ppm' });
  }
  if (typeof window.drawDualLineChart === 'function') {
    window.drawDualLineChart('envChart', tempHistory, humHistory, '#36d6c3', '#ff6b9d', { unit1: '°C', unit2: '%' });
  }
}

// ── Notifications ────────────────────────────────────────────
// latestDevice di-cache supaya updateNotifications bisa dipanggil ulang
// (misal saat tombol notifikasi diklik, atau saat ganti halaman SPA)
// tanpa menunggu Firebase push berikutnya.
let latestNotifications = [];
let notifSeenKey        = null; // key notif terakhir yang sudah dibaca user

const NOTIF_SEEN_STORAGE_KEY = 'steriflow:notifSeen:v1';
try { notifSeenKey = localStorage.getItem(NOTIF_SEEN_STORAGE_KEY) || null; } catch (_) {}

const NOTIF_ICONS = {
  pink:   '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>',
  purple: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v3"/><path d="M12 20v3"/><path d="M4.22 4.22l2.12 2.12"/><path d="M17.66 17.66l2.12 2.12"/><path d="M1 12h3"/><path d="M20 12h3"/><path d="M4.22 19.78l2.12-2.12"/><path d="M17.66 6.34l2.12-2.12"/></svg>',
  teal:   '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  yellow: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
  blue:   '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>'
};

// Interpolasi ringan: "Hello {name}" + {name:'World'} → "Hello World".
function interpolate(tpl, vars) {
  return String(tpl).replace(/\{(\w+)\}/g, (_, k) => (vars && vars[k] != null ? String(vars[k]) : ''));
}

// Fungsi t() yang selalu return hasil terjemahan dari i18n. Disimpan lokal
// supaya computeNotifications bersih dari pengecekan null setiap kali.
function tn(key, vars) {
  const t = (window.SteriflowI18n && window.SteriflowI18n.t)
    ? window.SteriflowI18n.t(key)
    : key;
  return vars ? interpolate(t, vars) : t;
}

function computeNotifications(dev, sterilStatus) {
  const sgp30 = dev?.sensorData?.sgp30 || {};
  const voc   = dev?.sensorData?.voc   || {};
  const dht   = dev?.sensorData?.dht11 || {};
  const camera = dev?.camera || {};
  const status = dev?.status || {};
  const relay  = dev?.relay  || {};

  const tvocStatus = sgp30.tvoc_status || voc.status || status.voc_alert;
  const eco2Status = sgp30.eco2_status;
  const vocInfo = getVocLevel(tvocStatus);

  const tvoc = Number(sgp30.tvoc) || Number(voc.ppm) || 0;
  const eco2 = Number(sgp30.eco2) || 0;
  const temp = Number(dht.temperature) || 0;
  const hum  = Number(dht.humidity)    || 0;

  const liveLabel = tn('common.live_label');
  const list = [];

  // 1) Sterilisasi aktif — dari RTDB sterilizationStatus.
  if (sterilStatus && sterilStatus.active && sterilStatus.startedAt && sterilStatus.totalSeconds) {
    const elapsed   = Math.max(0, Math.floor((Date.now() - sterilStatus.startedAt) / 1000));
    const remaining = Math.max(0, Number(sterilStatus.totalSeconds) - elapsed);
    const mode = sterilStatus.classification || tn('notif.steril_classify.auto');
    list.push({
      id: 'steril-active',
      title: tn('notif.steril_active.title'),
      desc:  tn('notif.steril_active.desc', { remain: fmtMMSS(remaining), mode }),
      color: 'purple',
      time:  liveLabel
    });
  }

  // 2) Kontaminasi tinggi (TVOC).
  if (vocInfo.level === 'Danger') {
    list.push({
      id: 'voc-danger',
      title: tn('notif.voc_danger.title'),
      desc:  tn('notif.voc_danger.desc', { value: Math.round(tvoc), status: String(tvocStatus || '').toUpperCase() }),
      color: 'pink',
      time:  liveLabel
    });
  } else if (vocInfo.level === 'Warning') {
    list.push({
      id: 'voc-warn',
      title: tn('notif.voc_warn.title'),
      desc:  tn('notif.voc_warn.desc', { value: Math.round(tvoc), status: String(tvocStatus || '').toUpperCase() }),
      color: 'yellow',
      time:  liveLabel
    });
  }

  // 3) Kualitas gas (eCO2).
  if (eco2Status && /VERY UNHEALTHY|UNHEALTHY|POOR|HAZARDOUS/i.test(eco2Status)) {
    list.push({
      id: 'eco2-bad',
      title: tn('notif.eco2_bad.title'),
      desc:  tn('notif.eco2_bad.desc', { value: Math.round(eco2), status: String(eco2Status).toUpperCase() }),
      color: 'pink',
      time:  liveLabel
    });
  }

  // 4) Relay aktif manual (bukan siklus terjadwal).
  const uvOn  = relay.uv  === 'ON';
  const fanOn = relay.fan === 'ON';
  if (!sterilStatus?.active && (uvOn || fanOn)) {
    list.push({
      id: 'relay-active',
      title: tn('notif.relay_active.title'),
      desc:  tn('notif.relay_active.desc', {
        uv:   relay.uv   || 'OFF',
        fan:  relay.fan  || 'OFF',
        pump: relay.pump || 'OFF'
      }),
      color: 'purple',
      time:  liveLabel
    });
  }

  // 5) Lingkungan ekstrem.
  if (hum > 0 && hum > 85) {
    list.push({
      id: 'hum-high',
      title: tn('notif.hum_high.title'),
      desc:  tn('notif.hum_high.desc', { value: hum.toFixed(1) }),
      color: 'yellow',
      time:  liveLabel
    });
  }
  if (temp > 0 && temp > 32) {
    list.push({
      id: 'temp-high',
      title: tn('notif.temp_high.title'),
      desc:  tn('notif.temp_high.desc', { value: temp.toFixed(1) }),
      color: 'yellow',
      time:  liveLabel
    });
  }

  // 6) Kamera / device offline.
  if (camera && camera.online === false) {
    list.push({
      id: 'cam-offline',
      title: tn('notif.cam_offline.title'),
      desc:  tn('notif.cam_offline.desc'),
      color: 'pink',
      time:  liveLabel
    });
  }

  // 7) Status kebersihan (selalu ada sebagai info dasar).
  const cleanPct = cleanlinessFromPpm(voc.ppm ?? (tvoc > 0 ? Math.min(10, tvoc / 200) : 0));
  list.push({
    id: 'hygiene-status',
    title: tn('notif.hygiene.title'),
    desc:  tn(cleanPct >= 70 ? 'notif.hygiene.desc_ready' : 'notif.hygiene.desc_dirty', { pct: cleanPct }),
    color: 'teal',
    time:  liveLabel
  });

  return list;
}

function renderNotifList(container, notifs) {
  if (!container) return;
  if (!notifs.length) {
    container.innerHTML = `
      <div style="padding:18px 10px;text-align:center;color:var(--text-dim);font-size:0.78rem;">
        ${tn('notif.empty')}
      </div>`;
    return;
  }
  container.innerHTML = notifs.map(n => `
    <div class="notif-item fade-in">
      <div class="notif-icon ${n.color || 'teal'}">${NOTIF_ICONS[n.color] || NOTIF_ICONS.teal}</div>
      <div class="notif-text">
        <div class="notif-title">${n.title}</div>
        <div class="notif-desc">${n.desc}</div>
        <div class="notif-time">${n.time || 'Live'}</div>
      </div>
    </div>
  `).join('');
}

function updateNotifications(dev) {
  latestNotifications = computeNotifications(dev, latestSterilStatus);

  // Inline panel (dashboard).
  renderNotifList(document.getElementById('notifList'), latestNotifications);

  // Drawer global (semua halaman yang punya #notifBtn).
  renderNotifList(document.getElementById('notifDrawerList'), latestNotifications);

  // Badge count: total semua notifikasi yang ditampilkan (match panjang list).
  const total = latestNotifications.length;
  const notifCount = document.getElementById('notifCount');
  if (notifCount) notifCount.textContent = String(total);

  // Dot pada tombol header: muncul hanya kalau ada notif KRITIS (pink/yellow)
  // yang belum dibaca. Item teal (info baseline seperti Hygiene Status) tidak
  // memicu dot supaya tidak mengganggu.
  const critical = latestNotifications.filter(n => n.color === 'pink' || n.color === 'yellow').length;
  const key = latestNotifications.map(n => n.id).join('|');
  const hasUnread = critical > 0 && key !== notifSeenKey;
  const notifDot = document.getElementById('notifDot');
  if (notifDot) notifDot.style.display = hasUnread ? 'block' : 'none';

  // Drawer count chip
  const drawerBadge = document.getElementById('notifDrawerBadge');
  if (drawerBadge) drawerBadge.textContent = String(latestNotifications.length);
}

// ── Initialize listeners (re-runnable untuk SPA) ─────────────
function getCurrentPage() {
  const path = window.location.pathname;
  return path.substring(path.lastIndexOf('/') + 1) || 'index.html';
}

// Daftar unsub RTDB supaya bisa di-tear-down saat SPA pindah page.
let activeUnsubs = [];
let authUnsub    = null;
let currentPageKey = null;

// Sterilization cycle ticker (dideklarasi di sini supaya tearDownListeners
// bisa mengaksesnya tanpa kena TDZ — block driver di bawah mengoperasikannya).
let sterilTicker = null;

// Fan dummy RPM ticker — aktif hanya saat relay.fan ON.
let fanRpmTicker = null;
let fanRpmBase   = 1200;

// Sterilization spray dedup set — hoisted ke sini supaya onSterilStatusUpdate
// yang dipanggil dari refresh() (via cache hydration) tidak kena TDZ.
const sprayFiredLocal = new Set();

function tickFanRpm() {
  const el = document.getElementById('fanRpm');
  if (!el) return;
  const jitter = Math.floor(Math.random() * 40 - 20);
  el.textContent = Math.max(0, fanRpmBase + jitter);
}

function tearDownListeners() {
  for (const u of activeUnsubs) {
    try { u(); } catch (_) {}
  }
  activeUnsubs = [];
  if (sterilTicker) { clearInterval(sterilTicker); sterilTicker = null; }
  if (fanRpmTicker) { clearInterval(fanRpmTicker); fanRpmTicker = null; }
  // NOTE: bannerTicker sengaja TIDAK di-clear di sini — banner harus tetap
  // bergerak saat SPA pindah halaman. renderSterilBanner akan mengelola
  // lifecycle-nya berdasarkan status terbaru.
}

function attachListenersFor(page) {
  currentPageKey = page;

  // sterilizationStatus dipasang di SEMUA halaman agar banner sterilisasi
  // persisten (countdown tetap terlihat walau pindah halaman).
  const uSteril = onValue(sterilStatusRef, (snap) => {
    const status = snap.val() || null;
    window.__sterilStatus = status;
    latestSterilStatus = status;
    writeSterilCache(status);
    if (typeof window.__renderSterilCard === 'function') window.__renderSterilCard();
    renderSterilBanner(status);
    if (currentPageKey === 'monitoring.html') onSterilStatusUpdate(status);
    // Notifikasi ikut ter-update bila cycle berubah (mis. banner "Sterilisasi Berjalan").
    updateNotifications(currentDevice || {});
  });
  activeUnsubs.push(uSteril);

  // Device snapshot dipasang di SEMUA halaman (bukan hanya dashboard/monitoring)
  // supaya notifikasi selalu refleksi sensor terbaru di mana pun user berada.
  const u1 = onValue(deviceRef, (snap) => {
    const data = snap.val();
    if (!data) return;
    currentDevice = {
      camera:     data.camera     || {},
      sensorData: data.sensorData || {},
      relay:      data.relay      || {},
      status:     data.status     || {},
      timestamp:  data.timestamp  || 0
    };
    if (currentPageKey === 'dashboard.html') {
      updateDashboardUI(currentDevice, currentRelayCommand);
    } else if (currentPageKey === 'monitoring.html') {
      updateMonitoringUI(currentDevice, currentRelayCommand);
    }
    // Notifikasi global (drawer) selalu ter-update.
    updateNotifications(currentDevice);
  });
  activeUnsubs.push(u1);

  const u2 = onValue(relayCmdRef, (snap) => {
    const data = snap.val() || {};
    currentRelayCommand = { fan: !!data.fan, uv: !!data.uv, pump: !!data.pump };
    if (currentPageKey === 'dashboard.html') {
      updateDashboardUI(currentDevice, currentRelayCommand);
    } else if (currentPageKey === 'monitoring.html') {
      updateMonitoringUI(currentDevice, currentRelayCommand);
    }
  });
  activeUnsubs.push(u2);

  console.log('[realtime] listeners aktif untuk', page);
}

function wireUIHandlers() {
  const uvcToggle     = document.getElementById('uvcToggle');
  const fanToggle     = document.getElementById('fanToggle');
  const ethanolToggle = document.getElementById('ethanolToggle');
  if (uvcToggle     && !uvcToggle.__wired)     { uvcToggle.__wired = true;     uvcToggle.addEventListener('change',     () => toggleUV(uvcToggle.checked)); }
  if (fanToggle     && !fanToggle.__wired)     { fanToggle.__wired = true;     fanToggle.addEventListener('change',     () => toggleFan(fanToggle.checked)); }
  if (ethanolToggle && !ethanolToggle.__wired) { ethanolToggle.__wired = true; ethanolToggle.addEventListener('change', () => togglePump(ethanolToggle.checked)); }

  // Tombol notifikasi di header: buka drawer global. Berlaku di semua
  // halaman yang memiliki #notifBtn (dashboard, monitoring, history,
  // ai-detection, ai-chat, account).
  const notifBtn = document.getElementById('notifBtn');
  if (notifBtn && !notifBtn.__wired) {
    notifBtn.__wired = true;
    notifBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      openNotifDrawer();
    });
  }

  const toggleSterilize = document.getElementById('toggleSterilize');
  if (toggleSterilize && !toggleSterilize.__wired) {
    toggleSterilize.__wired = true;
    toggleSterilize.addEventListener('click', async () => {
      const uvOn  = currentRelayCommand.uv  === true;
      const fanOn = currentRelayCommand.fan === true;
      const newState = !(uvOn && fanOn);
      await toggleUV(newState);
      await toggleFan(newState);
      toggleSterilize.innerHTML = newState
        ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> Stop'
        : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="5,3 19,12 5,21 5,3"/></svg> Start';
    });
  }
}

function refresh() {
  // Reset history chart & UI pointers untuk halaman baru.
  historyInitialized = false;
  gasHistory.fill(null);
  currentRelayCommand = { fan: false, uv: false, pump: false };
  tearDownListeners();
  const page = getCurrentPage();
  currentPageKey = page;
  wireUIHandlers();

  // Inisialisasi drawer notifikasi + render dari snapshot terakhir supaya
  // panel tidak kosong sebelum Firebase onValue pertama firing.
  ensureNotifDrawer();
  updateNotifications(currentDevice || {});

  // Hydrate sterilization UI dari cache SEBELUM Firebase firing pertama,
  // supaya tidak ada kedipan "Standby" kalau halaman di-refresh di tengah
  // siklus atau user baru saja pindah halaman.
  const cached = readSterilCache();
  if (cached) {
    window.__sterilStatus = cached;
    latestSterilStatus = cached;
    if (page === 'monitoring.html') onSterilStatusUpdate(cached);
    renderSterilBanner(cached);
  } else {
    // Cache kosong → pastikan banner hilang & countdown section disembunyikan.
    renderSterilBanner(null);
    if (page === 'monitoring.html') onSterilStatusUpdate(null);
  }

  // Monitoring sterilSection: wire Stop button + scroll ke #steril jika perlu.
  if (page === 'monitoring.html') {
    const stopBtn = document.getElementById('sterilStopBtn');
    if (stopBtn && !stopBtn.__wired) {
      stopBtn.__wired = true;
      stopBtn.addEventListener('click', stopSterilizationNow);
    }
    if (window.location.hash === '#steril') {
      setTimeout(() => {
        const el = document.getElementById('sterilSection');
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 350);
    }
  }
  // Auth listener hanya dipasang sekali; listener attach ke DB
  // ditunda sampai user siap.
  if (!authUnsub) {
    authUnsub = onAuthStateChanged(auth, (user) => {
      if (!user) return;
      window.__realtimeActive = true;
      // Re-attach untuk page aktif.
      tearDownListeners();
      attachListenersFor(getCurrentPage());
    });
  } else {
    // Auth sudah login sebelumnya → langsung attach page saat ini.
    attachListenersFor(page);
  }
}

// First run (muat langsung tanpa SPA).
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', refresh, { once: true });
  } else {
    refresh();
  }
}

// Saat SPA pindah halaman, panggil refresh agar listener bind ulang ke
// DOM baru dan listener halaman lama dilepas.
window.addEventListener('spa:navigate', () => {
  console.log('[realtime] SPA navigate → refresh listeners');
  refresh();
});

// Saat bahasa diubah, render ulang UI dinamis (teks tray status, countdown,
// notifikasi, dll) dengan snapshot Firebase terakhir — tanpa menunggu push
// berikutnya.
window.addEventListener('language:change', () => {
  if (currentPageKey === 'dashboard.html') updateDashboardUI(currentDevice, currentRelayCommand);
  else if (currentPageKey === 'monitoring.html') updateMonitoringUI(currentDevice, currentRelayCommand);
  // Notifikasi (inline panel + drawer) di-relokalisasi di semua halaman.
  updateNotifications(currentDevice || {});
});

// Saat theme berubah, canvas chart harus dilukis ulang dengan warna grid/label
// yang baru supaya label "ppm"/angka sumbu tetap kontras.
window.addEventListener('theme:change', () => {
  if (!currentDevice || currentPageKey !== 'monitoring.html') return;
  updateMonitoringUI(currentDevice, currentRelayCommand);
});

// Expose untuk di-trigger manual (debug / SPA).
window.SteriflowRealtime = { refresh, tearDown: tearDownListeners };

// ============================================================
//  Sterilization cycle driver (monitoring.html only)
//  Sumber kebenaran = /{device}/sterilizationStatus.
//  Driver menghitung sisa dari (startedAt + totalSeconds), memicu pompa pada
//  jadwal sprayTimes, dan mematikan relay saat selesai.
// ============================================================

// latestSterilStatus sudah dideklarasi di blok banner (atas file).
// sterilTicker sudah dideklarasi di atas (blok SPA teardown).
// sprayFiredLocal juga dihoist ke atas (lihat blok fan ticker) supaya tidak
// kena TDZ saat refresh() pertama memanggil onSterilStatusUpdate dari cache.
// Lihat catatan di ai-detection.html: ESP polling /relayCommand tiap 5 detik.
// 1000 = margin aman minimum supaya ESP menangkap ON sekali siklus, tapi tidak
// menahan perintah ON lebih lama dari perlu. Physical ON tetap ~5s (batas
// polling firmware).
const SPRAY_PULSE_MS = 1000;

function fmtMMSS(sec) {
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function pulsePumpOnce(devicePath) {
  set(ref(db, `${devicePath}/relayCommand/pump`), true)
    .then(() => new Promise(r => setTimeout(r, SPRAY_PULSE_MS)))
    .then(() => set(ref(db, `${devicePath}/relayCommand/pump`), false))
    .catch(err => {
      console.error('pump pulse error:', err);
      set(ref(db, `${devicePath}/relayCommand/pump`), false).catch(() => {});
    });
}

function buildRecipeChipsHTML(s) {
  const chip = (active, label, color) => {
    const dim = 'color:var(--text-muted);background:rgba(255,255,255,0.04);border-color:var(--glass-border);';
    const on  = `color:${color};background:color-mix(in srgb, ${color} 14%, transparent);border-color:color-mix(in srgb, ${color} 55%, transparent);`;
    return `<span style="display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;border:1px solid;font-size:0.72rem;font-weight:600;letter-spacing:0.02em;${active ? on : dim}">${active ? '●' : '○'} ${label}</span>`;
  };
  const chips = [];
  chips.push(chip(!!s.uvUsed,  'UV-C', 'var(--accent)'));
  chips.push(chip(!!s.fanUsed, 'Fan',  'var(--accent2)'));
  const sprays = Number(s.spraysTotal) || 0;
  const interval = Number(s.sprayIntervalSeconds) || 0;
  const pumpLabel = sprays > 0
    ? `Pump × ${sprays}${sprays > 1 ? ` / ${interval}s` : ''}`
    : 'Pump';
  chips.push(chip(sprays > 0, pumpLabel, 'var(--accent4)'));
  return chips.join(' ');
}

async function onSterilStatusUpdate(status) {
  latestSterilStatus = status;

  const recipeRow    = document.getElementById('sterilRecipeRow');
  const countdownRow = document.getElementById('sterilCountdownRow');

  if (!status || !status.active || !status.startedAt || !status.totalSeconds) {
    // Cycle tidak aktif → sembunyikan baris, reset ticker.
    if (recipeRow)    recipeRow.style.display    = 'none';
    if (countdownRow) countdownRow.style.display = 'none';
    if (sterilTicker) { clearInterval(sterilTicker); sterilTicker = null; }
    sprayFiredLocal.clear();
    return;
  }

  // Tampilkan recipe + baris countdown.
  if (recipeRow) {
    recipeRow.style.display = 'flex';
    recipeRow.innerHTML = buildRecipeChipsHTML(status);
  }
  if (countdownRow) countdownRow.style.display = 'flex';

  if (!sterilTicker) {
    sterilTicker = setInterval(() => sterilTick(), 1000);
    sterilTick(); // first tick immediately
  }
}

async function sterilTick() {
  const s = latestSterilStatus;
  if (!s || !s.active || !s.startedAt || !s.totalSeconds) return;

  const devicePath = s.deviceId || DEVICE_ID;
  const elapsed = Math.max(0, Math.floor((Date.now() - s.startedAt) / 1000));
  const total   = Number(s.totalSeconds) || 0;
  const remaining = Math.max(0, total - elapsed);
  const pct = total > 0 ? Math.min(100, Math.round((elapsed / total) * 100)) : 0;

  // DOM update
  const pctEl = document.getElementById('monitorCyclePercent');
  const barEl = document.getElementById('monitorCycleBar');
  const cdEl  = document.getElementById('sterilCountdownRemain');
  const spEl  = document.getElementById('sterilSprayInfo');
  if (pctEl) pctEl.textContent = pct + '%';
  if (barEl) barEl.style.width = pct + '%';
  if (cdEl)  cdEl.textContent  = fmtMMSS(remaining);

  const spraysTotal = Number(s.spraysTotal) || 0;
  const spraysDone  = Number(s.spraysDone)  || 0;
  const sprayTimes  = Array.isArray(s.sprayTimes) ? s.sprayTimes.map(Number) : [];

  if (spEl) {
    if (spraysTotal > 0) {
      const nextIdx = spraysDone;
      const nextIn  = nextIdx < sprayTimes.length
        ? Math.max(0, Math.round(sprayTimes[nextIdx] - elapsed))
        : null;
      spEl.textContent = nextIn !== null && nextIn > 0
        ? `${spraysDone} / ${spraysTotal} · next in ${nextIn}s`
        : `${spraysDone} / ${spraysTotal}`;
    } else {
      spEl.textContent = 'Tidak ada';
    }
  }

  // Picu pulse pompa kalau sudah waktunya & belum pernah dipicu dari tab ini.
  for (let i = 0; i < sprayTimes.length; i++) {
    if (i < spraysDone) continue;
    if (elapsed < sprayTimes[i]) break;
    const key = `${s.startedAt}:${i}`;
    if (sprayFiredLocal.has(key)) continue;
    sprayFiredLocal.add(key);
    pulsePumpOnce(devicePath);
    try {
      await update(ref(db, `${devicePath}/sterilizationStatus`), {
        spraysDone: i + 1,
        nextSprayInSeconds: (i + 1 < sprayTimes.length)
          ? Math.max(0, Math.round(sprayTimes[i + 1] - elapsed))
          : null,
        updatedAt: Date.now()
      });
    } catch (_) {}
  }

  // Heartbeat umum.
  try {
    await update(ref(db, `${devicePath}/sterilizationStatus`), {
      remainingSeconds: remaining,
      updatedAt: Date.now()
    });
  } catch (_) {}

  // Selesai → matikan relay + tandai inaktif.
  if (elapsed >= total) {
    if (sterilTicker) { clearInterval(sterilTicker); sterilTicker = null; }
    try {
      if (s.uvUsed)  await set(ref(db, `${devicePath}/relayCommand/uv`),  false);
      if (s.fanUsed) await set(ref(db, `${devicePath}/relayCommand/fan`), false);
      // Pastikan pompa mati juga (best-effort).
      await set(ref(db, `${devicePath}/relayCommand/pump`), false);
      await update(ref(db, `${devicePath}/sterilizationStatus`), {
        active: false,
        remainingSeconds: 0,
        nextSprayInSeconds: null,
        endedAt: Date.now(),
        updatedAt: Date.now()
      });
    } catch (e) { console.error('finalize sterilization:', e); }
    sprayFiredLocal.clear();
  }
}

async function stopSterilizationNow() {
  const s = latestSterilStatus;
  if (!s || !s.active) return;
  const devicePath = s.deviceId || DEVICE_ID;
  if (sterilTicker) { clearInterval(sterilTicker); sterilTicker = null; }
  try {
    if (s.uvUsed)  await set(ref(db, `${devicePath}/relayCommand/uv`),  false);
    if (s.fanUsed) await set(ref(db, `${devicePath}/relayCommand/fan`), false);
    await set(ref(db, `${devicePath}/relayCommand/pump`), false);
    await update(ref(db, `${devicePath}/sterilizationStatus`), {
      active: false,
      remainingSeconds: 0,
      nextSprayInSeconds: null,
      endedAt: Date.now(),
      updatedAt: Date.now(),
      stoppedManually: true
    });
  } catch (e) { console.error('stop error:', e); }
  sprayFiredLocal.clear();
}

// Tidak ada `const page = ...` lagi di top-level — semua logika page-specific
// (termasuk hash scroll #steril) sudah dipanggil dari refresh() tiap kali
// first-load / SPA navigate.

export { db, currentDevice, currentRelayCommand };
