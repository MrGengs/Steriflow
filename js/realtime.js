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
  set
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

let currentRelayCommand = { fan: false, uv: false };

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

  // Relay modes (dari /relay langsung)
  const dashUvMode  = document.getElementById('dashUvMode');
  const dashFanMode = document.getElementById('dashFanMode');
  if (dashUvMode)  dashUvMode.textContent  = relay.uv_mode  || 'MANUAL';
  if (dashFanMode) dashFanMode.textContent = relay.fan_mode || 'MANUAL';

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

// ── Initialize listeners ─────────────────────────────────────
function getCurrentPage() {
  const path = window.location.pathname;
  return path.substring(path.lastIndexOf('/') + 1) || 'index.html';
}

const page = getCurrentPage();

if (page === 'dashboard.html' || page === 'monitoring.html') {
  let listenersStarted = false;

  onAuthStateChanged(auth, (user) => {
    if (!user || listenersStarted) return;
    listenersStarted = true;
    window.__realtimeActive = true;

    // Full device snapshot (sensorData + relay + status + timestamp)
    onValue(deviceRef, (snap) => {
      const data = snap.val();
      if (!data) return;
      currentDevice = {
        sensorData: data.sensorData || {},
        relay:      data.relay      || {},
        status:     data.status     || {},
        timestamp:  data.timestamp  || 0
      };
      if (page === 'dashboard.html') updateDashboardUI(currentDevice, currentRelayCommand);
      else                           updateMonitoringUI(currentDevice, currentRelayCommand);
    });

    // User-facing relay commands
    onValue(relayCmdRef, (snap) => {
      const data = snap.val() || {};
      currentRelayCommand = { fan: !!data.fan, uv: !!data.uv };
      if (page === 'dashboard.html') updateDashboardUI(currentDevice, currentRelayCommand);
      else                           updateMonitoringUI(currentDevice, currentRelayCommand);
    });

    // Sterilization status (drives dashboard "Next Sterilization")
    onValue(sterilStatusRef, (snap) => {
      window.__sterilStatus = snap.val() || null;
      if (typeof window.__renderSterilCard === 'function') window.__renderSterilCard();
    });
  });

  document.addEventListener('DOMContentLoaded', () => {
    const uvcToggle = document.getElementById('uvcToggle');
    const fanToggle = document.getElementById('fanToggle');
    if (uvcToggle) uvcToggle.addEventListener('change', () => toggleUV(uvcToggle.checked));
    if (fanToggle) fanToggle.addEventListener('change', () => toggleFan(fanToggle.checked));

    const toggleSterilize = document.getElementById('toggleSterilize');
    if (toggleSterilize) {
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
  });
}

export { db, currentDevice, currentRelayCommand };
