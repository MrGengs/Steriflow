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

// ── References ───────────────────────────────────────────────
const sensorDataRef = ref(db, 'sensorData');
const relayCommandRef = ref(db, 'relayCommand');
const statusRef = ref(db, 'status');

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
    await set(ref(db, 'relayCommand/uv'), value);
  } catch (e) {
    console.error('Failed to toggle UV:', e);
  }
}

// ── Toggle Fan relay command ─────────────────────────────────
export async function toggleFan(value) {
  try {
    await set(ref(db, 'relayCommand/fan'), value);
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
  // Sensor quick view
  const avgVOC = getAvgVOC(sensorData);
  const temp = sensorData.dht11?.temperature || 0;
  const humidity = sensorData.dht11?.humidity || 0;

  const homeVoc = document.getElementById('homeVoc');
  const homeTemp = document.getElementById('homeTemp');
  const homeHumidity = document.getElementById('homeHumidity');

  if (homeVoc) homeVoc.textContent = avgVOC;
  if (homeTemp) homeTemp.textContent = temp;
  if (homeHumidity) homeHumidity.textContent = humidity;

  // VOC trend
  const vocTrend = document.getElementById('vocTrend');
  if (vocTrend) {
    const gasInfo = getGasLevel(sensorData);
    vocTrend.innerHTML = gasInfo.level;
    vocTrend.style.color = gasInfo.color;
  }

  // UV toggle
  const uvcToggle = document.getElementById('uvcToggle');
  const uvcStatus = document.getElementById('uvcStatus');
  const uvcCard = document.getElementById('uvcCard');

  if (uvcToggle) {
    uvcToggle.checked = relayCmd.uv === true;
    // Also reflect actual relay state
    const uvRelay = sensorData.relay?.uv || 'OFF';
    if (uvcStatus) {
      uvcStatus.innerHTML = uvRelay === 'ON'
        ? '<span style="color:var(--accent);">ON</span>'
        : '<span style="color:var(--text-muted);">OFF</span>';
    }
  }

  // Fan/Ethanol toggle
  const fanToggle = document.getElementById('fanToggle');
  const fanStatus = document.getElementById('fanStatus');

  if (fanToggle) {
    fanToggle.checked = relayCmd.fan === true;
    const fanRelay = sensorData.relay?.fan || 'OFF';
    if (fanStatus) {
      fanStatus.innerHTML = fanRelay === 'ON'
        ? '<span style="color:var(--accent2);">ON</span>'
        : '<span style="color:var(--text-muted);">OFF</span>';
    }
  }

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
      cleanlinessLevel.textContent = 'Clean';
      cleanlinessLevel.className = 'badge badge-clean';
    } else if (gasInfo.level === 'Warning') {
      cleanlinessLevel.textContent = 'Moderate';
      cleanlinessLevel.className = 'badge badge-moderate';
    } else {
      cleanlinessLevel.textContent = 'Dirty';
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

  // VOC
  const vocValue = document.getElementById('vocValue');
  const vocBar = document.getElementById('vocBar');
  const vocTrendMonitor = document.getElementById('vocTrendMonitor');
  if (vocValue) vocValue.textContent = avgVOC;
  if (vocBar) vocBar.style.width = Math.min(100, (avgVOC / 4095) * 100) + '%';
  if (vocTrendMonitor) {
    const gasInfo = getGasLevel(sensorData);
    vocTrendMonitor.textContent = gasInfo.level === 'Normal' ? 'Normal range' : gasInfo.level;
    vocTrendMonitor.style.color = gasInfo.color;
  }

  // Temperature
  const tempValue = document.getElementById('tempValue');
  const tempBar = document.getElementById('tempBar');
  if (tempValue) tempValue.textContent = temp;
  if (tempBar) tempBar.style.width = Math.min(100, (temp / 60) * 100) + '%';

  // Temperature trend
  const tempTrend = document.getElementById('tempBar')?.closest('.stat-card')?.querySelector('.stat-trend');
  if (tempTrend) {
    if (temp > 32) {
      tempTrend.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="18 15 12 9 6 15"/></svg> Hot';
      tempTrend.style.color = 'var(--accent3)';
    } else if (temp > 28) {
      tempTrend.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="18 15 12 9 6 15"/></svg> Warm';
      tempTrend.style.color = 'var(--accent4)';
    } else {
      tempTrend.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="5" y1="12" x2="19" y2="12"/></svg> Normal';
      tempTrend.style.color = 'var(--accent2)';
    }
  }

  // Humidity
  const humidityValue = document.getElementById('humidityValue');
  const humidityBar = document.getElementById('humidityBar');
  if (humidityValue) humidityValue.textContent = humidity;
  if (humidityBar) humidityBar.style.width = Math.min(100, humidity) + '%';

  // Humidity trend
  const humTrend = document.getElementById('humidityBar')?.closest('.stat-card')?.querySelector('.stat-trend');
  if (humTrend) {
    if (humidity > 80) {
      humTrend.textContent = 'Too humid';
      humTrend.style.color = 'var(--accent3)';
    } else if (humidity < 40) {
      humTrend.textContent = 'Too dry';
      humTrend.style.color = 'var(--accent4)';
    } else {
      humTrend.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="5" y1="12" x2="19" y2="12"/></svg> Stable';
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

  const uvOn = sensorData.relay?.uv === 'ON';
  const fanOn = sensorData.relay?.fan === 'ON';

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

  // Last updated
  const lastUpdated = document.getElementById('lastUpdated');
  if (lastUpdated) {
    const now = new Date();
    lastUpdated.textContent = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  // Render charts using app.js functions (exposed on window)
  if (typeof window.drawLineChart === 'function') {
    window.drawLineChart('vocChart', vocHistory, '#7c5cfc', { unit: ' ppm' });
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
      icon: 'red', title: 'Gas Alert: DANGER',
      desc: `High gas contamination detected. MQ3: ${sensorData.mq3?.analog}, MQ6: ${sensorData.mq6?.analog}, MQ8: ${sensorData.mq8?.analog}`,
      color: 'pink'
    });
  }

  if (sensorData.relay?.uv === 'ON' || sensorData.relay?.fan === 'ON') {
    notifications.push({
      icon: 'purple', title: 'Sterilization Active',
      desc: `UV-C: ${sensorData.relay?.uv}, Fan: ${sensorData.relay?.fan}`,
      color: 'purple'
    });
  }

  const temp = sensorData.dht11?.temperature || 0;
  if (temp > 0) {
    notifications.push({
      icon: 'teal', title: 'Environment Status',
      desc: `Temperature: ${temp}°C, Humidity: ${sensorData.dht11?.humidity || 0}%. Status: ${status.temp_alert || 'OK'}`,
      color: 'teal'
    });
  }

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

    // Listen to sensor data
    onValue(sensorDataRef, (snapshot) => {
      const data = snapshot.val();
      if (!data) return;
      currentData = data;

      if (page === 'dashboard.html') {
        updateDashboardUI(currentData, currentRelayCommand, currentStatus);
      } else {
        updateMonitoringUI(currentData, currentRelayCommand, currentStatus);
      }
    });

    // Listen to relay commands
    onValue(relayCommandRef, (snapshot) => {
      const data = snapshot.val();
      if (!data) return;
      currentRelayCommand = data;

      if (page === 'dashboard.html') {
        updateDashboardUI(currentData, currentRelayCommand, currentStatus);
      } else {
        updateMonitoringUI(currentData, currentRelayCommand, currentStatus);
      }
    });

    // Listen to status
    onValue(statusRef, (snapshot) => {
      const data = snapshot.val();
      if (!data) return;
      currentStatus = data;

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
