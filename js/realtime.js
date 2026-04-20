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
let historyInitialized = false;

window.__realtimeActive = false;

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
export async function pulsePump(ms = 800) {
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
  if (s === 'BAHAYA' || s === 'DANGER' || s === 'BAD' || s === 'HIGH') {
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
  if (trayStatus) {
    if (vocInfo.level === 'Normal') {
      trayStatus.innerHTML = 'Bersih'; trayStatus.style.color = 'var(--accent2)';
      if (trayStatusTrend) { trayStatusTrend.textContent = 'Ompreng siap dipakai'; trayStatusTrend.style.color = 'var(--accent2)'; }
    } else if (vocInfo.level === 'Warning') {
      trayStatus.innerHTML = 'Waspada'; trayStatus.style.color = 'var(--accent4)';
      if (trayStatusTrend) { trayStatusTrend.textContent = 'Segera sterilkan ompreng'; trayStatusTrend.style.color = 'var(--accent4)'; }
    } else {
      trayStatus.innerHTML = 'Terkontaminasi'; trayStatus.style.color = 'var(--accent3)';
      if (trayStatusTrend) { trayStatusTrend.textContent = 'Ompreng belum layak dipakai'; trayStatusTrend.style.color = 'var(--accent3)'; }
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
    if (vocInfo.level === 'Normal') {
      cleanlinessLevel.textContent = 'Aman';        cleanlinessLevel.className = 'badge badge-clean';
    } else if (vocInfo.level === 'Warning') {
      cleanlinessLevel.textContent = 'Waspada';     cleanlinessLevel.className = 'badge badge-moderate';
    } else {
      cleanlinessLevel.textContent = 'Terkontaminasi'; cleanlinessLevel.className = 'badge badge-dirty';
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
  const voc    = dev.sensorData?.voc   || {};
  const dht    = dev.sensorData?.dht11 || {};
  const relay  = dev.relay              || {};
  const status = dev.status             || {};

  const ppm       = Number(voc.ppm)        || 0;
  const temp      = Number(dht.temperature) || 0;
  const humidity  = Number(dht.humidity)    || 0;

  // History buffer
  if (!historyInitialized) {
    vocHistory.fill(ppm);
    tempHistory.fill(temp);
    humHistory.fill(humidity);
    historyInitialized = true;
  } else {
    vocHistory.push(ppm);       vocHistory.shift();
    tempHistory.push(temp);     tempHistory.shift();
    humHistory.push(humidity);  humHistory.shift();
  }

  // VOC card
  const vocValue = document.getElementById('vocValue');
  const vocBar   = document.getElementById('vocBar');
  const vocStatusEl = document.getElementById('vocStatus');
  if (vocValue) vocValue.textContent = ppm.toFixed(2);
  if (vocBar)   vocBar.style.width   = Math.min(100, (ppm / 10) * 100) + '%';
  if (vocStatusEl) {
    const raw = String(voc.status || status.voc_alert || 'GOOD').toUpperCase();
    vocStatusEl.textContent = raw;
    const info = getVocLevel(raw);
    vocStatusEl.style.color = info.color;
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
    if (humidity > 80) {
      humTrend.textContent = 'Too humid'; humTrend.style.color = 'var(--accent3)';
    } else if (humidity < 40) {
      humTrend.textContent = 'Too dry';   humTrend.style.color = 'var(--accent4)';
    } else {
      humTrend.textContent = alertText === 'NORMAL' ? 'Stable' : alertText;
      humTrend.style.color = 'var(--text-dim)';
    }
  }

  // VOC alert badge (support both ids for forward/backward compatibility)
  const vocInfo = getVocLevel(voc.status || status.voc_alert);
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
    window.drawLineChart('vocChart', vocHistory, '#7c5cfc', { unit: ' ppm' });
  }
  if (typeof window.drawDualLineChart === 'function') {
    window.drawDualLineChart('envChart', tempHistory, humHistory, '#36d6c3', '#ff6b9d');
  }
}

// ── Notifications ────────────────────────────────────────────
function updateNotifications(dev) {
  const notifList  = document.getElementById('notifList');
  const notifCount = document.getElementById('notifCount');
  if (!notifList) return;

  const voc    = dev.sensorData?.voc || {};
  const status = dev.status           || {};
  const relay  = dev.relay            || {};
  const vocInfo = getVocLevel(voc.status || status.voc_alert);
  const cleanPct = cleanlinessFromPpm(voc.ppm);

  const notifications = [];
  if (vocInfo.level === 'Danger') {
    notifications.push({
      title: 'Kontaminasi Ompreng Tinggi!',
      desc:  'VOC tinggi pada permukaan ompreng. Segera lakukan sterilisasi UV-C.',
      color: 'pink'
    });
  }
  if (relay.uv === 'ON' || relay.fan === 'ON') {
    notifications.push({
      title: 'Sterilisasi Aktif',
      desc:  `UV-C: ${relay.uv || 'OFF'} · Fan: ${relay.fan || 'OFF'}`,
      color: 'purple'
    });
  }
  notifications.push({
    title: 'Status Kebersihan Ompreng',
    desc:  `Tingkat kebersihan: ${cleanPct}%. Ompreng ${cleanPct >= 70 ? 'siap dipakai' : 'perlu disterilkan'}.`,
    color: 'teal'
  });

  if (notifCount) notifCount.textContent = notifications.length;
  notifList.innerHTML = notifications.map(n => `
    <div class="notif-item fade-in">
      <div class="notif-icon ${n.color}">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      </div>
      <div class="notif-text">
        <div class="notif-title">${n.title}</div>
        <div class="notif-desc">${n.desc}</div>
        <div class="notif-time">Live</div>
      </div>
    </div>
  `).join('');
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

function tearDownListeners() {
  for (const u of activeUnsubs) {
    try { u(); } catch (_) {}
  }
  activeUnsubs = [];
  if (sterilTicker) { clearInterval(sterilTicker); sterilTicker = null; }
}

function attachListenersFor(page) {
  currentPageKey = page;
  if (page !== 'dashboard.html' && page !== 'monitoring.html') return;

  // Full device snapshot (sensorData + relay + status + timestamp)
  const u1 = onValue(deviceRef, (snap) => {
    const data = snap.val();
    if (!data) return;
    currentDevice = {
      sensorData: data.sensorData || {},
      relay:      data.relay      || {},
      status:     data.status     || {},
      timestamp:  data.timestamp  || 0
    };
    if (currentPageKey === 'dashboard.html') updateDashboardUI(currentDevice, currentRelayCommand);
    else                                     updateMonitoringUI(currentDevice, currentRelayCommand);
  });
  activeUnsubs.push(u1);

  const u2 = onValue(relayCmdRef, (snap) => {
    const data = snap.val() || {};
    currentRelayCommand = { fan: !!data.fan, uv: !!data.uv, pump: !!data.pump };
    if (currentPageKey === 'dashboard.html') updateDashboardUI(currentDevice, currentRelayCommand);
    else                                     updateMonitoringUI(currentDevice, currentRelayCommand);
  });
  activeUnsubs.push(u2);

  const u3 = onValue(sterilStatusRef, (snap) => {
    const status = snap.val() || null;
    window.__sterilStatus = status;
    if (typeof window.__renderSterilCard === 'function') window.__renderSterilCard();
    if (currentPageKey === 'monitoring.html') onSterilStatusUpdate(status);
  });
  activeUnsubs.push(u3);

  console.log('[realtime] listeners aktif untuk', page);
}

function wireUIHandlers() {
  const uvcToggle     = document.getElementById('uvcToggle');
  const fanToggle     = document.getElementById('fanToggle');
  const ethanolToggle = document.getElementById('ethanolToggle');
  if (uvcToggle     && !uvcToggle.__wired)     { uvcToggle.__wired = true;     uvcToggle.addEventListener('change',     () => toggleUV(uvcToggle.checked)); }
  if (fanToggle     && !fanToggle.__wired)     { fanToggle.__wired = true;     fanToggle.addEventListener('change',     () => toggleFan(fanToggle.checked)); }
  if (ethanolToggle && !ethanolToggle.__wired) { ethanolToggle.__wired = true; ethanolToggle.addEventListener('change', () => togglePump(ethanolToggle.checked)); }

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
  currentRelayCommand = { fan: false, uv: false, pump: false };
  tearDownListeners();
  const page = getCurrentPage();
  wireUIHandlers();
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

// Expose untuk di-trigger manual (debug / SPA).
window.SteriflowRealtime = { refresh, tearDown: tearDownListeners };

// ============================================================
//  Sterilization cycle driver (monitoring.html only)
//  Sumber kebenaran = /{device}/sterilizationStatus.
//  Driver menghitung sisa dari (startedAt + totalSeconds), memicu pompa pada
//  jadwal sprayTimes, dan mematikan relay saat selesai.
// ============================================================

let latestSterilStatus = null;
// sterilTicker sudah dideklarasi di atas (blok SPA teardown).
const sprayFiredLocal = new Set();   // semprotan yang sudah diminta dari tab ini
const SPRAY_PULSE_MS = 800;

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
