// ============================================================
//  SteriFlow — Firebase Realtime Database Integration
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

// ── Initialize (returns existing app if already initialized) ──
let app;
try { app = initializeApp(firebaseConfig); } catch (e) {
  // App already initialized by auth.js — get existing instance
  const { getApp } = await import("https://www.gstatic.com/firebasejs/11.7.3/firebase-app.js");
  app = getApp();
}
const auth = getAuth(app);
const db = getDatabase(app);

// ── Device ID ────────────────────────────────────────────────
const DEVICE_ID = 'steriflow-001';

// ── References ───────────────────────────────────────────────
const sensorDataRef = ref(db, `${DEVICE_ID}/sensorData`);

// ── State ────────────────────────────────────────────────────
let currentData = {
  dht11: { temperature: 0, humidity: 0 },
  mq3: { analog: 0, digital: false, status: '' },
  mq6: { analog: 0, digital: false, status: '' },
  mq8: { analog: 0, digital: false, status: '' },
  relay: { fan: 'OFF', fan_mode: 'MANUAL', uv: 'OFF', uv_mode: 'MANUAL' }
};

let currentStatus = {
  gas_alert: '',
  hum_alert: '',
  temp_alert: '',
  timestamp: 0
};

// Relay command is no longer a separate node — relay state is inside sensorData.relay
// For manual control, we write to a separate relayCommand node
let currentRelayCommand = {
  fan: false,
  uv: false
};

// Chart history (20 data points)
const HISTORY_LEN = 20;
const vocHistory = new Array(HISTORY_LEN).fill(null);
const tempHistory = new Array(HISTORY_LEN).fill(null);
const humHistory = new Array(HISTORY_LEN).fill(null);
let historyInitialized = false;

// Flag to signal app.js to skip dummy simulation
window.__realtimeActive = false;

// ── Toggle UV relay command ──────────────────────────────────
export async function toggleUV(value) {
  try {
    await set(ref(db, `${DEVICE_ID}/relayCommand/uv`), value);
  } catch (e) {
    console.error('Failed to toggle UV:', e);
  }
}

// ── Toggle Fan relay command ─────────────────────────────────
export async function toggleFan(value) {
  try {
    await set(ref(db, `${DEVICE_ID}/relayCommand/fan`), value);
  } catch (e) {
    console.error('Failed to toggle Fan:', e);
  }
}

// ── Get average VOC from MQ sensors ──────────────────────────
function getAvgVOC(data) {
  const mq3 = data.mq3?.analog || 0;
  const mq6 = data.mq6?.analog || 0;
  const mq8 = data.mq8?.analog || 0;
  return Math.round((mq3 + mq6 + mq8) / 3);
}

// ── Get gas alert level ──────────────────────────────────────
function getGasLevel(data) {
  const dangers = [data.mq3?.status, data.mq6?.status, data.mq8?.status]
    .filter(s => s === 'BAHAYA').length;
  if (dangers >= 2) return { level: 'Danger', color: 'var(--accent3)', badge: 'badge-dirty' };
  if (dangers === 1) return { level: 'Warning', color: 'var(--accent4)', badge: 'badge-moderate' };
  return { level: 'Normal', color: 'var(--accent2)', badge: 'badge-clean' };
}

// ── Update Dashboard UI ──────────────────────────────────────
function updateDashboardUI(sensorData, relayCmd, status) {
  // Bacteria elimination status
  const avgVOC = getAvgVOC(sensorData);
  const temp = sensorData.dht11?.temperature || 0;
  const humidity = sensorData.dht11?.humidity || 0;
  const maxAnalogVal = 4095;

  // Bacteria kill rate (inverse of gas contamination level)
  const bacteriaKillPct = Math.max(0, Math.min(100, Math.round((1 - avgVOC / maxAnalogVal) * 100)));
  const homeBacteriaKill = document.getElementById('homeBacteriaKill');
  if (homeBacteriaKill) homeBacteriaKill.textContent = bacteriaKillPct;

  const bacteriaKillTrend = document.getElementById('bacteriaKillTrend');
  if (bacteriaKillTrend) {
    const gasInfo = getGasLevel(sensorData);
    if (gasInfo.level === 'Normal') {
      bacteriaKillTrend.innerHTML = 'Bakteri terkendali';
      bacteriaKillTrend.style.color = 'var(--accent2)';
    } else if (gasInfo.level === 'Warning') {
      bacteriaKillTrend.innerHTML = 'Perlu sterilisasi';
      bacteriaKillTrend.style.color = 'var(--accent4)';
    } else {
      bacteriaKillTrend.innerHTML = 'Kontaminasi tinggi!';
      bacteriaKillTrend.style.color = 'var(--accent3)';
    }
  }

  // Food safety level
  const homeFoodSafety = document.getElementById('homeFoodSafety');
  const foodSafetyTrend = document.getElementById('foodSafetyTrend');
  if (homeFoodSafety) {
    const gasInfo = getGasLevel(sensorData);
    if (gasInfo.level === 'Normal') {
      homeFoodSafety.innerHTML = 'Aman';
      homeFoodSafety.style.color = 'var(--accent2)';
      if (foodSafetyTrend) { foodSafetyTrend.textContent = 'Layak konsumsi'; foodSafetyTrend.style.color = 'var(--accent2)'; }
    } else if (gasInfo.level === 'Warning') {
      homeFoodSafety.innerHTML = 'Waspada';
      homeFoodSafety.style.color = 'var(--accent4)';
      if (foodSafetyTrend) { foodSafetyTrend.textContent = 'Segera sterilkan'; foodSafetyTrend.style.color = 'var(--accent4)'; }
    } else {
      homeFoodSafety.innerHTML = 'Bahaya';
      homeFoodSafety.style.color = 'var(--accent3)';
      if (foodSafetyTrend) { foodSafetyTrend.textContent = 'Tidak layak konsumsi'; foodSafetyTrend.style.color = 'var(--accent3)'; }
    }
  }

  // UV-C exposure time (calculated from relay state)
  const homeUvExposure = document.getElementById('homeUvExposure');
  if (homeUvExposure) {
    const uvOn = sensorData.relay?.uv === 'ON';
    homeUvExposure.textContent = uvOn ? '~15' : '0';
  }

  // UV toggle + label: both follow RTDB relayCommand/uv (boolean) so slider and text never disagree
  const uvcToggle = document.getElementById('uvcToggle');
  const uvcStatus = document.getElementById('uvcStatus');
  const uvcCard = document.getElementById('uvcCard');

  const uvCmdOn = relayCmd.uv === true;
  if (uvcToggle) {
    uvcToggle.checked = uvCmdOn;
    if (uvcStatus) {
      uvcStatus.innerHTML = uvCmdOn
        ? '<span style="color:var(--accent);">ON</span>'
        : '<span style="color:var(--text-muted);">OFF</span>';
    }
  }

  // Fan toggle + label: same as UV — relayCommand/fan (boolean)
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

  // Relay modes
  const dashUvMode = document.getElementById('dashUvMode');
  const dashFanMode = document.getElementById('dashFanMode');
  if (dashUvMode) dashUvMode.textContent = sensorData.relay?.uv_mode || 'MANUAL';
  if (dashFanMode) dashFanMode.textContent = sensorData.relay?.fan_mode || 'MANUAL';

  // System status
  const systemStatus = document.getElementById('systemStatus');
  if (systemStatus) {
    const uvOn = sensorData.relay?.uv === 'ON';
    const fanOn = sensorData.relay?.fan === 'ON';

    if (uvOn || fanOn) {
      systemStatus.textContent = 'Sterilizing';
      systemStatus.className = 'badge badge-sterilizing badge-lg';
    } else if (status.gas_alert === 'BAHAYA') {
      systemStatus.textContent = 'Alert';
      systemStatus.className = 'badge badge-dirty badge-lg';
    } else {
      systemStatus.textContent = 'Standby';
      systemStatus.className = 'badge badge-standby badge-lg';
    }
  }

  // Cleanliness level
  const gasInfo = getGasLevel(sensorData);
  const cleanlinessLevel = document.getElementById('cleanlinessLevel');
  const cleanlinessPercent = document.getElementById('cleanlinessPercent');
  const hygieneVal = document.getElementById('hygieneVal');
  const hygieneBar = document.getElementById('hygieneBar');

  if (cleanlinessLevel) {
    if (gasInfo.level === 'Normal') {
      cleanlinessLevel.textContent = 'Aman';
      cleanlinessLevel.className = 'badge badge-clean';
    } else if (gasInfo.level === 'Warning') {
      cleanlinessLevel.textContent = 'Waspada';
      cleanlinessLevel.className = 'badge badge-moderate';
    } else {
      cleanlinessLevel.textContent = 'Terkontaminasi';
      cleanlinessLevel.className = 'badge badge-dirty';
    }
  }

  // Calculate cleanliness percent (inverse of avg gas level, max 4095)
  const maxAnalog = 4095;
  const cleanPct = Math.max(0, Math.min(100, Math.round((1 - avgVOC / maxAnalog) * 100)));
  if (cleanlinessPercent) cleanlinessPercent.textContent = cleanPct + '%';
  if (hygieneVal) hygieneVal.textContent = cleanPct + '%';
  if (hygieneBar) hygieneBar.style.width = cleanPct + '%';

  // Notifications
  updateNotifications(sensorData, status);
}

// ── Update Monitoring UI ─────────────────────────────────────
function updateMonitoringUI(sensorData, relayCmd, status) {
  const avgVOC = getAvgVOC(sensorData);
  const temp = sensorData.dht11?.temperature || 0;
  const humidity = sensorData.dht11?.humidity || 0;

  // On first data, fill entire history with current value (flat line)
  if (!historyInitialized) {
    vocHistory.fill(avgVOC);
    tempHistory.fill(temp);
    humHistory.fill(humidity);
    historyInitialized = true;
  } else {
    vocHistory.push(avgVOC);
    vocHistory.shift();
    tempHistory.push(temp);
    tempHistory.shift();
    humHistory.push(humidity);
    humHistory.shift();
  }

  // ── Individual MQ Sensor Cards ──
  const mq3Val = document.getElementById('mq3Value');
  const mq6Val = document.getElementById('mq6Value');
  const mq8Val = document.getElementById('mq8Value');
  const mq3Bar = document.getElementById('mq3Bar');
  const mq6Bar = document.getElementById('mq6Bar');
  const mq8Bar = document.getElementById('mq8Bar');
  const mq3Status = document.getElementById('mq3Status');
  const mq6Status = document.getElementById('mq6Status');
  const mq8Status = document.getElementById('mq8Status');

  const mq3 = sensorData.mq3?.analog || 0;
  const mq6 = sensorData.mq6?.analog || 0;
  const mq8 = sensorData.mq8?.analog || 0;

  if (mq3Val) mq3Val.textContent = mq3;
  if (mq6Val) mq6Val.textContent = mq6;
  if (mq8Val) mq8Val.textContent = mq8;
  if (mq3Bar) mq3Bar.style.width = Math.min(100, (mq3 / 4095) * 100) + '%';
  if (mq6Bar) mq6Bar.style.width = Math.min(100, (mq6 / 4095) * 100) + '%';
  if (mq8Bar) mq8Bar.style.width = Math.min(100, (mq8 / 4095) * 100) + '%';

  function setMqStatus(el, sensorObj) {
    if (!el) return;
    const s = sensorObj?.status || 'AMAN';
    el.textContent = s;
    if (s === 'BAHAYA') {
      el.style.color = 'var(--accent3)';
    } else {
      el.style.color = 'var(--accent2)';
    }
  }
  setMqStatus(mq3Status, sensorData.mq3);
  setMqStatus(mq6Status, sensorData.mq6);
  setMqStatus(mq8Status, sensorData.mq8);

  // Temperature
  const tempValue = document.getElementById('tempValue');
  const tempBar = document.getElementById('tempBar');
  if (tempValue) tempValue.textContent = temp;
  if (tempBar) tempBar.style.width = Math.min(100, (temp / 60) * 100) + '%';

  // Temperature trend
  const tempTrend = document.getElementById('tempTrend');
  if (tempTrend) {
    const alertText = status.temp_alert || 'NORMAL';
    if (temp > 32) {
      tempTrend.textContent = 'Hot';
      tempTrend.style.color = 'var(--accent3)';
    } else if (temp > 28) {
      tempTrend.textContent = 'Warm';
      tempTrend.style.color = 'var(--accent4)';
    } else {
      tempTrend.textContent = alertText === 'NORMAL' ? 'Normal' : alertText;
      tempTrend.style.color = 'var(--accent2)';
    }
  }

  // Humidity
  const humidityValue = document.getElementById('humidityValue');
  const humidityBar = document.getElementById('humidityBar');
  if (humidityValue) humidityValue.textContent = humidity;
  if (humidityBar) humidityBar.style.width = Math.min(100, humidity) + '%';

  // Humidity trend
  const humTrend = document.getElementById('humTrend');
  if (humTrend) {
    const alertText = status.hum_alert || 'NORMAL';
    if (humidity > 80) {
      humTrend.textContent = 'Too humid';
      humTrend.style.color = 'var(--accent3)';
    } else if (humidity < 40) {
      humTrend.textContent = 'Too dry';
      humTrend.style.color = 'var(--accent4)';
    } else {
      humTrend.textContent = alertText === 'NORMAL' ? 'Stable' : alertText;
      humTrend.style.color = 'var(--text-dim)';
    }
  }

  // Gas alert badge
  const monitorGasAlert = document.getElementById('monitorGasAlert');
  if (monitorGasAlert) {
    const gasInfo = getGasLevel(sensorData);
    monitorGasAlert.textContent = gasInfo.level.toUpperCase();
    if (gasInfo.level === 'Danger') {
      monitorGasAlert.className = 'badge badge-dirty';
    } else if (gasInfo.level === 'Warning') {
      monitorGasAlert.className = 'badge badge-moderate';
    } else {
      monitorGasAlert.className = 'badge badge-clean';
    }
  }

  // Sterilization status
  const monitorStatus = document.getElementById('monitorStatus');
  const monitorUvc = document.getElementById('monitorUvc');
  const monitorEthanol = document.getElementById('monitorEthanol');
  const monitorUvMode = document.getElementById('monitorUvMode');
  const monitorFanMode = document.getElementById('monitorFanMode');

  const uvOn = sensorData.relay?.uv === 'ON';
  const fanOn = sensorData.relay?.fan === 'ON';
  const uvMode = sensorData.relay?.uv_mode || 'MANUAL';
  const fanMode = sensorData.relay?.fan_mode || 'MANUAL';

  if (monitorStatus) {
    if (uvOn || fanOn) {
      monitorStatus.textContent = 'Sterilizing';
      monitorStatus.className = 'badge badge-sterilizing';
    } else if (status.gas_alert === 'BAHAYA') {
      monitorStatus.textContent = 'Alert';
      monitorStatus.className = 'badge badge-dirty';
    } else {
      monitorStatus.textContent = 'Standby';
      monitorStatus.className = 'badge badge-standby';
    }
  }
  if (monitorUvc) {
    monitorUvc.textContent = uvOn ? 'ACTIVE' : 'INACTIVE';
    monitorUvc.className = uvOn ? 'status-pill active' : 'status-pill inactive';
  }
  if (monitorEthanol) {
    monitorEthanol.textContent = fanOn ? 'ACTIVE' : 'INACTIVE';
    monitorEthanol.className = fanOn ? 'status-pill active' : 'status-pill inactive';
  }
  if (monitorUvMode) monitorUvMode.textContent = uvMode;
  if (monitorFanMode) monitorFanMode.textContent = fanMode;

  // Last updated
  const lastUpdated = document.getElementById('lastUpdated');
  if (lastUpdated) {
    const now = new Date();
    lastUpdated.textContent = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  // Render charts using app.js functions (exposed on window)
  if (typeof window.drawLineChart === 'function') {
    window.drawLineChart('vocChart', vocHistory, '#7c5cfc', { unit: '' });
    window.drawDualLineChart('envChart', tempHistory, humHistory, '#36d6c3', '#ff6b9d');
  }
}

// ── Update Notifications ─────────────────────────────────────
function updateNotifications(sensorData, status) {
  const notifList = document.getElementById('notifList');
  const notifCount = document.getElementById('notifCount');
  if (!notifList) return;

  const notifications = [];

  if (status.gas_alert === 'BAHAYA') {
    notifications.push({
      icon: 'red', title: 'Kontaminasi Bakteri Tinggi!',
      desc: 'Terdeteksi kontaminasi bakteri pada makanan. Segera lakukan sterilisasi UV-C.',
      color: 'pink'
    });
  }

  if (sensorData.relay?.uv === 'ON' || sensorData.relay?.fan === 'ON') {
    notifications.push({
      icon: 'purple', title: 'Sterilisasi Aktif',
      desc: `UV-C sedang membasmi bakteri makanan. UV-C: ${sensorData.relay?.uv}, Fan: ${sensorData.relay?.fan}`,
      color: 'purple'
    });
  }

  const avgVOCNotif = getAvgVOC(sensorData);
  const bacteriaPct = Math.max(0, Math.min(100, Math.round((1 - avgVOCNotif / 4095) * 100)));
  notifications.push({
    icon: 'teal', title: 'Status Keamanan Pangan',
    desc: `Tingkat kebersihan pangan: ${bacteriaPct}%. Makanan ${bacteriaPct >= 70 ? 'layak konsumsi' : 'perlu sterilisasi'}.`,
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

// ── Initialize Listeners ─────────────────────────────────────
function getCurrentPage() {
  const path = window.location.pathname;
  return path.substring(path.lastIndexOf('/') + 1) || 'index.html';
}

const page = getCurrentPage();

if (page === 'dashboard.html' || page === 'monitoring.html') {

  let listenersStarted = false;

  // Wait for user to be authenticated before connecting to RTDB
  onAuthStateChanged(auth, (user) => {
    if (!user || listenersStarted) return;
    listenersStarted = true;
    window.__realtimeActive = true;

    // Listen to sensorData (contains dht11, mq3, mq6, mq8, relay, status, timestamp)
    onValue(sensorDataRef, (snapshot) => {
      const data = snapshot.val();
      if (!data) return;

      // Extract status from sensorData (new structure nests it inside)
      if (data.status) {
        currentStatus = data.status;
      }

      // Relay state is inside sensorData.relay
      currentData = data;

      if (page === 'dashboard.html') {
        updateDashboardUI(currentData, currentRelayCommand, currentStatus);
      } else {
        updateMonitoringUI(currentData, currentRelayCommand, currentStatus);
      }
    });

    // Listen to relay commands (for manual toggle state)
    onValue(ref(db, `${DEVICE_ID}/relayCommand`), (snapshot) => {
      const data = snapshot.val();
      if (!data) return;
      currentRelayCommand = data;

      if (page === 'dashboard.html') {
        updateDashboardUI(currentData, currentRelayCommand, currentStatus);
      } else {
        updateMonitoringUI(currentData, currentRelayCommand, currentStatus);
      }
    });
  });

  // Setup toggle event listeners
  document.addEventListener('DOMContentLoaded', () => {
    const uvcToggle = document.getElementById('uvcToggle');
    const fanToggle = document.getElementById('fanToggle');

    if (uvcToggle) {
      uvcToggle.addEventListener('change', () => {
        toggleUV(uvcToggle.checked);
      });
    }

    if (fanToggle) {
      fanToggle.addEventListener('change', () => {
        toggleFan(fanToggle.checked);
      });
    }

    // Start sterilization button
    const toggleSterilize = document.getElementById('toggleSterilize');
    if (toggleSterilize) {
      toggleSterilize.addEventListener('click', async () => {
        const uvOn = currentRelayCommand.uv === true;
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

export { db, currentData, currentRelayCommand, currentStatus };
