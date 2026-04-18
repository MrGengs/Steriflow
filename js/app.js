/* ============================================================
   SteriFlow — app.js
   Shared JavaScript for all pages
   ============================================================ */

'use strict';

/* ── CSS variable helpers ─────────────────────────────────── */
const CSS = {
  accent:  '#7c5cfc',
  accent2: '#36d6c3',
  accent3: '#ff6b9d',
  accent4: '#ffc247',
  green:   '#27c76a',
  red:     '#ff4757',
  text:    'rgba(232,232,244,0.55)',
  bg:      '#0a0a1a',
};

/* ── Shared State (simulated sensor data) ─────────────────── */
const sensorState = {
  voc:      350,
  temp:     28.5,
  humidity: 65,
  vocHistory:      new Array(20).fill(350),
  tempHistory:     new Array(20).fill(28),
  humidityHistory: Array.from({length: 20}, () => 60 + Math.random() * 15),
};

const systemState = {
  status:         'standby',  // standby | sterilizing | done
  uvcOn:          false,
  ethanolOn:      false,
  cycleProgress:  0,
  notifCount:     3,
  cleanliness:    82,
  cleanlinessLevel: 'Clean',
};

/* ── Utility ──────────────────────────────────────────────── */
function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }
function rand(min, max) { return min + Math.random() * (max - min); }
function lerp(a, b, t) { return a + (b - a) * t; }

function hexToRgb(hex) {
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  return `${r},${g},${b}`;
}

function el(id) { return document.getElementById(id); }
function qs(sel, scope) { return (scope || document).querySelector(sel); }
function qsa(sel, scope) { return [...(scope || document).querySelectorAll(sel)]; }

function formatTime(date) {
  return date.toLocaleTimeString('en-GB', {hour:'2-digit', minute:'2-digit', second:'2-digit'});
}

function formatDate(date) {
  return date.toLocaleDateString('en-GB', {weekday:'short', day:'numeric', month:'long', year:'numeric'});
}

/* ── Cleanliness Ring Canvas ──────────────────────────────── */
// Ensure the canvas drawing buffer matches device pixel ratio for crisp rendering.
// Memoised per canvas so we don't thrash on every frame.
function ensureCanvasDPR(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth  || parseInt(canvas.getAttribute('width'))  || 110;
  const cssH = canvas.clientHeight || parseInt(canvas.getAttribute('height')) || 110;
  const wantW = Math.round(cssW * dpr);
  const wantH = Math.round(cssH * dpr);
  if (canvas.width !== wantW || canvas.height !== wantH) {
    canvas.width  = wantW;
    canvas.height = wantH;
    canvas.style.width  = cssW + 'px';
    canvas.style.height = cssH + 'px';
    canvas.__dpr = dpr;
    canvas.__cssW = cssW;
    canvas.__cssH = cssH;
  }
  return canvas;
}

function drawCleanlinessRing(canvasId, percent, color) {
  const canvas = el(canvasId);
  if (!canvas) return;
  ensureCanvasDPR(canvas);

  const ctx = canvas.getContext('2d');
  const dpr = canvas.__dpr || (window.devicePixelRatio || 1);
  const w = canvas.__cssW || 110;
  const h = canvas.__cssH || 110;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const cx = w / 2, cy = h / 2;
  const r = Math.min(w, h) / 2 - 10;
  const pct = Math.max(0, Math.min(100, Number(percent) || 0));
  const isFull = pct >= 99.999;
  const startAngle = -Math.PI / 2;
  const endAngle = startAngle + (2 * Math.PI * pct / 100);

  ctx.clearRect(0, 0, w, h);

  // Reset shadow defensively so the track isn't affected by leftover state.
  ctx.shadowBlur = 0;
  ctx.shadowColor = 'transparent';

  // Track
  ctx.beginPath();
  ctx.lineCap = 'butt';
  ctx.arc(cx, cy, r, 0, 2 * Math.PI);
  ctx.closePath();
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.lineWidth = 8;
  ctx.stroke();

  if (pct <= 0) return;

  const grad = ctx.createLinearGradient(cx - r, cy, cx + r, cy);
  grad.addColorStop(0, color || CSS.accent2);
  grad.addColorStop(1, CSS.accent);

  ctx.beginPath();
  if (isFull) {
    // Full circle — flat caps + closePath so the start/end join has no seam
    // regardless of subpixel alignment across different screens/DPRs.
    ctx.lineCap = 'butt';
    ctx.arc(cx, cy, r, 0, 2 * Math.PI);
    ctx.closePath();
  } else {
    ctx.lineCap = 'round';
    ctx.arc(cx, cy, r, startAngle, endAngle);
  }
  ctx.strokeStyle = grad;
  ctx.lineWidth = 8;
  ctx.shadowColor = color || CSS.accent2;
  ctx.shadowBlur = 10;
  ctx.stroke();
  ctx.shadowBlur = 0;
}

/* ── Animated Ring (perpetual — follows a live target, not a snapshot) ────
 * Pass a number for a one-shot target, or a function that returns the current
 * target. Using a function prevents the race where the caller reads the
 * target too early (before realtime data arrives) and ends up animating
 * toward a stale value. The rAF loop redraws only when `current` changes.
 */
function animateRing(canvasId, target, color) {
  // Cancel any previous loop on the same canvas to prevent double-animation
  // (e.g. if animateRing is invoked twice by a resize re-trigger).
  const canvas = el(canvasId);
  if (!canvas) return;
  if (canvas.__ringRAF) cancelAnimationFrame(canvas.__ringRAF);

  const getTarget = typeof target === 'function' ? target : () => target;
  let current = 0;
  let lastDrawn = -1;

  const step = () => {
    const raw = Number(getTarget());
    const t = Math.max(0, Math.min(100, Number.isFinite(raw) ? raw : 0));
    if (current < t)      current = Math.min(current + 2, t);
    else if (current > t) current = Math.max(current - 2, t);

    if (current !== lastDrawn) {
      drawCleanlinessRing(canvasId, current, color);
      lastDrawn = current;
    }
    canvas.__ringRAF = requestAnimationFrame(step);
  };
  canvas.__ringRAF = requestAnimationFrame(step);
}

/* ── Line Chart Drawing ───────────────────────────────────── */
/**
 * drawLineChart(canvasId, data[], color, options)
 * Draws a smooth bezier line chart with gradient fill.
 */
// Expose for realtime.js
window.drawLineChart = drawLineChart;
window.drawDualLineChart = drawDualLineChart;
window.drawCleanlinessRing = drawCleanlinessRing;
window.systemState = systemState;

function drawLineChart(canvasId, data, color, options = {}) {
  const canvas = el(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;

  // Use fixed height from options or data attribute (not the canvas.height which gets scaled)
  const cssW = canvas.parentElement ? canvas.parentElement.clientWidth : 340;
  const cssH = options.height || parseInt(canvas.dataset.h || '160');

  canvas.width  = cssW * dpr;
  canvas.height = cssH * dpr;
  canvas.style.width  = cssW + 'px';
  canvas.style.height = cssH + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const w = cssW, h = cssH;
  const padL = 8, padR = 8, padT = 16, padB = 20;
  const chartW = w - padL - padR;
  const chartH = h - padT - padB;

  ctx.clearRect(0, 0, w, h);

  if (!data || data.length < 2) return;

  const min = Math.min(...data) * 0.96;
  const max = Math.max(...data) * 1.04;

  function xPos(i) { return padL + (i / (data.length - 1)) * chartW; }
  function yPos(v) { return padT + chartH - ((v - min) / (max - min)) * chartH; }

  // Grid lines
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = padT + (i / 4) * chartH;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + chartW, y);
    ctx.stroke();
  }

  // Y-axis labels
  ctx.fillStyle = 'rgba(232,232,244,0.3)';
  ctx.font = `${10 / dpr + 10}px Outfit, sans-serif`;
  ctx.textAlign = 'left';
  const topLabel  = options.unit ? Math.round(max) + options.unit : Math.round(max);
  const botLabel  = options.unit ? Math.round(min) + options.unit : Math.round(min);
  ctx.fillText(topLabel, padL + 2, padT + 11);
  ctx.fillText(botLabel, padL + 2, padT + chartH - 3);

  // Gradient fill
  const fillGrad = ctx.createLinearGradient(0, padT, 0, padT + chartH);
  fillGrad.addColorStop(0, `rgba(${hexToRgb(color)}, 0.28)`);
  fillGrad.addColorStop(1, `rgba(${hexToRgb(color)}, 0.01)`);

  // Build smooth bezier path
  function buildPath() {
    ctx.beginPath();
    ctx.moveTo(xPos(0), yPos(data[0]));
    for (let i = 1; i < data.length; i++) {
      const cpx = (xPos(i - 1) + xPos(i)) / 2;
      ctx.bezierCurveTo(cpx, yPos(data[i-1]), cpx, yPos(data[i]), xPos(i), yPos(data[i]));
    }
  }

  // Fill
  buildPath();
  ctx.lineTo(xPos(data.length - 1), padT + chartH);
  ctx.lineTo(padL, padT + chartH);
  ctx.closePath();
  ctx.fillStyle = fillGrad;
  ctx.fill();

  // Line stroke
  buildPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.shadowColor = color;
  ctx.shadowBlur = 8;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Dots for last point
  const lx = xPos(data.length - 1);
  const ly = yPos(data[data.length - 1]);
  ctx.beginPath();
  ctx.arc(lx, ly, 4, 0, 2 * Math.PI);
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 10;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.beginPath();
  ctx.arc(lx, ly, 2, 0, 2 * Math.PI);
  ctx.fillStyle = '#fff';
  ctx.fill();
}

/**
 * drawDualLineChart(canvasId, data1, data2, color1, color2, options)
 */
function drawDualLineChart(canvasId, data1, data2, color1, color2, options = {}) {
  const canvas = el(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;

  const cssW = canvas.parentElement ? canvas.parentElement.clientWidth : 340;
  const cssH = options.height || parseInt(canvas.dataset.h || '160');

  canvas.width  = cssW * dpr;
  canvas.height = cssH * dpr;
  canvas.style.width  = cssW + 'px';
  canvas.style.height = cssH + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const w = cssW, h = cssH;
  const padL = 8, padR = 8, padT = 16, padB = 20;
  const chartW = w - padL - padR;
  const chartH = h - padT - padB;

  ctx.clearRect(0, 0, w, h);

  // Normalize both datasets to 0-100 scale for display
  const allVals = [...data1, ...data2];
  const globalMin = Math.min(...allVals) * 0.95;
  const globalMax = Math.max(...allVals) * 1.05;

  function xPos(i, len) { return padL + (i / (len - 1)) * chartW; }
  function yPos(v) { return padT + chartH - ((v - globalMin) / (globalMax - globalMin)) * chartH; }

  // Grid
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = padT + (i / 4) * chartH;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + chartW, y);
    ctx.stroke();
  }

  function drawOneLine(data, color, fillOpacity) {
    if (!data || data.length < 2) return;

    const fillGrad = ctx.createLinearGradient(0, padT, 0, padT + chartH);
    fillGrad.addColorStop(0, `rgba(${hexToRgb(color)}, ${fillOpacity})`);
    fillGrad.addColorStop(1, `rgba(${hexToRgb(color)}, 0.01)`);

    function buildPath() {
      ctx.beginPath();
      ctx.moveTo(xPos(0, data.length), yPos(data[0]));
      for (let i = 1; i < data.length; i++) {
        const cpx = (xPos(i-1, data.length) + xPos(i, data.length)) / 2;
        ctx.bezierCurveTo(cpx, yPos(data[i-1]), cpx, yPos(data[i]), xPos(i, data.length), yPos(data[i]));
      }
    }

    buildPath();
    ctx.lineTo(xPos(data.length - 1, data.length), padT + chartH);
    ctx.lineTo(padL, padT + chartH);
    ctx.closePath();
    ctx.fillStyle = fillGrad;
    ctx.fill();

    buildPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.shadowColor = color;
    ctx.shadowBlur = 6;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Last dot
    const lx = xPos(data.length - 1, data.length);
    const ly = yPos(data[data.length - 1]);
    ctx.beginPath();
    ctx.arc(lx, ly, 3.5, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.arc(lx, ly, 1.5, 0, 2 * Math.PI);
    ctx.fillStyle = '#fff';
    ctx.fill();
  }

  drawOneLine(data1, color1, 0.2);
  drawOneLine(data2, color2, 0.15);
}

/**
 * drawBarChart(canvasId, data[], color)
 * Simple bar chart for history page
 */
function drawBarChart(canvasId, data, color) {
  const canvas = el(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;

  const cssW = canvas.parentElement ? canvas.parentElement.clientWidth : 340;
  const cssH = parseInt(canvas.dataset.h || '120');

  canvas.width  = cssW * dpr;
  canvas.height = cssH * dpr;
  canvas.style.width  = cssW + 'px';
  canvas.style.height = cssH + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const w = cssW, h = cssH;
  const padT = 10, padB = 8, padL = 4, padR = 4;
  const chartW = w - padL - padR;
  const chartH = h - padT - padB;
  const maxVal = Math.max(...data);
  const barW = chartW / data.length;
  const gap = barW * 0.3;

  ctx.clearRect(0, 0, w, h);

  data.forEach((v, i) => {
    const bh = (v / maxVal) * chartH;
    const bx = padL + i * barW + gap / 2;
    const by = padT + chartH - bh;
    const bw = barW - gap;
    const radius = Math.min(4, bw / 2);

    const grad = ctx.createLinearGradient(bx, by, bx, by + bh);
    grad.addColorStop(0, color);
    grad.addColorStop(1, `rgba(${hexToRgb(color)}, 0.3)`);

    ctx.beginPath();
    ctx.moveTo(bx + radius, by);
    ctx.lineTo(bx + bw - radius, by);
    ctx.quadraticCurveTo(bx + bw, by, bx + bw, by + radius);
    ctx.lineTo(bx + bw, by + bh);
    ctx.lineTo(bx, by + bh);
    ctx.lineTo(bx, by + radius);
    ctx.quadraticCurveTo(bx, by, bx + radius, by);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.shadowColor = color;
    ctx.shadowBlur = 4;
    ctx.fill();
    ctx.shadowBlur = 0;
  });
}

/* ── Sensor Simulation ────────────────────────────────────── */
function tickSensors() {
  // VOC: 280–420 ppm
  const vocTarget = 280 + Math.random() * 140;
  sensorState.voc = lerp(sensorState.voc, vocTarget, 0.3);
  sensorState.vocHistory.push(sensorState.voc);
  sensorState.vocHistory.shift();

  // Temp: 27–30 °C
  const tempTarget = 27 + Math.random() * 3;
  sensorState.temp = lerp(sensorState.temp, tempTarget, 0.2);
  sensorState.tempHistory.push(sensorState.temp);
  sensorState.tempHistory.shift();

  // Humidity: 60–75 %
  const humTarget = 60 + Math.random() * 15;
  sensorState.humidity = lerp(sensorState.humidity, humTarget, 0.2);
  sensorState.humidityHistory.push(sensorState.humidity);
  sensorState.humidityHistory.shift();
}

/* ── Update Sensor DOM ────────────────────────────────────── */
function updateSensorDOM() {
  const voc = Math.round(sensorState.voc);
  const temp = sensorState.temp.toFixed(1);
  const hum = Math.round(sensorState.humidity);

  // Home page
  setElText('homeVoc', voc);
  setElText('homeTemp', temp);
  setElText('homeHumidity', hum);

  // Monitoring page
  setElText('vocValue', voc);
  setElText('tempValue', temp);
  setElText('humidityValue', hum);

  setBarWidth('vocBar',      clamp((voc - 280) / 140 * 100, 5, 100));
  setBarWidth('tempBar',     clamp((sensorState.temp - 27) / 3 * 100, 5, 100));
  setBarWidth('humidityBar', clamp((sensorState.humidity - 60) / 15 * 100, 5, 100));

  const now = el('lastUpdated');
  if (now) now.textContent = 'just now';
}

function setElText(id, val) {
  const e = el(id);
  if (e) e.textContent = val;
}

function setBarWidth(id, pct) {
  const e = el(id);
  if (e) e.style.width = pct + '%';
}

/* ── Chart Rendering (per page) ──────────────────────────── */
function renderCharts() {
  const page = detectPage();

  if (page === 'monitoring') {
    drawLineChart('bacteriChart', sensorState.vocHistory, CSS.accent, {unit:' ppm'});
    drawLineChart('gasChart', sensorState.vocHistory, CSS.accent3, {unit:' ppm'});
    drawLineChart('kipasChart', sensorState.vocHistory, '#ffc247', {unit:' ppm'});
    drawDualLineChart(
      'envChart',
      sensorState.tempHistory,
      sensorState.humidityHistory,
      CSS.accent2,
      CSS.accent3
    );
  }

  if (page === 'history') {
    const barData = [3,5,4,6,4,5,3,7,5,4,6,5,4,7,5,6,4,5,3,5,4,6,5,3,4,5,6,4,5,3];
    drawBarChart('historyBarChart', barData, CSS.accent);
  }

  // Note: the cleanliness ring animator is started once in initPage (not here),
  // because renderCharts is also invoked on window resize — restarting the
  // animator would reset it to 0% and re-animate, which is jarring.
}

/* ── Detect current page ─────────────────────────────────── */
function detectPage() {
  const path = window.location.pathname;
  if (path.includes('monitoring'))   return 'monitoring';
  if (path.includes('ai-detection')) return 'ai';
  if (path.includes('history'))      return 'history';
  return 'home';
}

/* ── System Status (Home) ────────────────────────────────── */
function initSystemStatus() {
  const toggleBtn = el('toggleSterilize');
  if (!toggleBtn) return;

  toggleBtn.addEventListener('click', () => {
    if (systemState.status === 'standby') {
      startSterilization();
    } else if (systemState.status === 'sterilizing') {
      stopSterilization();
    } else {
      resetSystem();
    }
  });

  const navFab = el('navFab');
  if (navFab) {
    navFab.addEventListener('click', () => {
      if (systemState.status === 'standby') startSterilization();
    });
  }
}

function startSterilization() {
  systemState.status = 'sterilizing';
  systemState.cycleProgress = 0;

  updateStatusBadge();

  const btn = el('toggleSterilize');
  if (btn) {
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> Stop`;
    btn.className = 'btn btn-danger btn-sm';
  }

  // Auto-turn on UV-C and ethanol
  const uvcInput = el('uvcToggle');
  const ethInput = el('ethanolToggle');
  if (uvcInput) { uvcInput.checked = true; updateUvcUI(true); }
  if (ethInput) { ethInput.checked = true; updateEthanolUI(true); }

  systemState._sterilizeTimer = setInterval(() => {
    systemState.cycleProgress += 100 / (15 * 30); // 15 min cycle
    if (systemState.cycleProgress >= 100) {
      systemState.cycleProgress = 100;
      completeSterilization();
    }
    updateCycleBar();
  }, 2000);
}

function stopSterilization() {
  clearInterval(systemState._sterilizeTimer);
  systemState.status = 'standby';
  systemState.cycleProgress = 0;
  updateStatusBadge();
  updateCycleBar();

  const uvcInput = el('uvcToggle');
  const ethInput = el('ethanolToggle');
  if (uvcInput) { uvcInput.checked = false; updateUvcUI(false); }
  if (ethInput) { ethInput.checked = false; updateEthanolUI(false); }

  const btn = el('toggleSterilize');
  if (btn) {
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="5,3 19,12 5,21 5,3"/></svg> Start`;
    btn.className = 'btn btn-primary btn-sm';
  }
}

function completeSterilization() {
  clearInterval(systemState._sterilizeTimer);
  systemState.status = 'done';
  systemState.cycleProgress = 100;
  systemState.cleanliness = 95;

  const uvcInput = el('uvcToggle');
  const ethInput = el('ethanolToggle');
  if (uvcInput) { uvcInput.checked = false; updateUvcUI(false); }
  if (ethInput) { ethInput.checked = false; updateEthanolUI(false); }

  updateStatusBadge();
  updateCycleBar();

  const btn = el('toggleSterilize');
  if (btn) {
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20,6 9,17 4,12"/></svg> Reset`;
    btn.className = 'btn btn-secondary btn-sm';
  }

  const lastInfo = el('lastCycleInfo');
  if (lastInfo) lastInfo.textContent = 'Just now';

  // The perpetual ring animator (started in renderCharts) will pick up the
  // new systemState.cleanliness value on the next frame — no direct draw needed.
  const cpEl = el('cleanlinessPercent');
  if (cpEl) cpEl.textContent = '95%';
  const clEl = el('cleanlinessLevel');
  if (clEl) { clEl.className = 'badge badge-clean'; clEl.textContent = 'Clean'; }

  setTimeout(resetSystem, 5000);
}

function resetSystem() {
  systemState.status = 'standby';
  systemState.cycleProgress = 0;
  updateStatusBadge();
  updateCycleBar();

  const btn = el('toggleSterilize');
  if (btn) {
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="5,3 19,12 5,21 5,3"/></svg> Start`;
    btn.className = 'btn btn-primary btn-sm';
  }
}

function updateStatusBadge() {
  const badge = el('systemStatus');
  const monBadge = el('monitorStatus');

  const map = {
    standby:     { cls: 'badge badge-standby badge-lg', text: 'Standby' },
    sterilizing: { cls: 'badge badge-sterilizing badge-lg', text: 'Sterilizing' },
    done:        { cls: 'badge badge-done badge-lg', text: 'Complete' },
  };

  const cfg = map[systemState.status] || map.standby;

  if (badge) { badge.className = cfg.cls; badge.textContent = cfg.text; }
  if (monBadge) { monBadge.className = cfg.cls.replace(' badge-lg',''); monBadge.textContent = cfg.text; }

  // Monitoring page status pills
  const isActive = systemState.status === 'sterilizing';
  const uvcPill = el('monitorUvc');
  const ethPill = el('monitorEthanol');
  if (uvcPill) {
    uvcPill.className = isActive ? 'status-pill active' : 'status-pill inactive';
    uvcPill.textContent = isActive ? 'ACTIVE' : 'INACTIVE';
  }
  if (ethPill) {
    ethPill.className = isActive ? 'status-pill active' : 'status-pill inactive';
    ethPill.textContent = isActive ? 'ACTIVE' : 'INACTIVE';
  }
}

function updateCycleBar() {
  const pct = Math.round(systemState.cycleProgress);
  setBarWidth('cycleBar', pct);
  setElText('cyclePercent', pct + '%');
  setBarWidth('monitorCycleBar', pct);
  setElText('monitorCyclePercent', pct + '%');
}

/* ── Toggle Switches (UV-C & Ethanol) ─────────────────────── */
function initToggles() {
  const uvcToggle = el('uvcToggle');
  if (uvcToggle) {
    uvcToggle.addEventListener('change', () => {
      systemState.uvcOn = uvcToggle.checked;
      updateUvcUI(systemState.uvcOn);
    });
  }

  const ethanolToggle = el('ethanolToggle');
  if (ethanolToggle) {
    ethanolToggle.addEventListener('change', () => {
      systemState.ethanolOn = ethanolToggle.checked;
      updateEthanolUI(systemState.ethanolOn);
    });
  }
}

function updateUvcUI(on) {
  systemState.uvcOn = on;
  const statusEl = el('uvcStatus');
  const card = el('uvcCard');

  if (statusEl) {
    statusEl.innerHTML = on
      ? `<span style="color:var(--accent);">ON</span>`
      : `<span style="color:var(--text-muted);">OFF</span>`;
  }
  if (card) {
    card.style.boxShadow = on ? '0 0 20px rgba(124,92,252,0.25)' : '';
    card.style.borderColor = on ? 'rgba(124,92,252,0.4)' : '';
  }
}

function updateEthanolUI(on) {
  systemState.ethanolOn = on;
  const statusEl = el('ethanolStatus');
  const card = el('ethanolCard');

  if (statusEl) {
    statusEl.innerHTML = on
      ? `<span style="color:var(--accent2);">ON</span>`
      : `<span style="color:var(--text-muted);">OFF</span>`;
  }
  if (card) {
    card.style.boxShadow = on ? '0 0 20px rgba(54,214,195,0.25)' : '';
    card.style.borderColor = on ? 'rgba(54,214,195,0.4)' : '';
  }
}

/* ── Next Sterilization Card (live status from RTDB) ─────── */
// Data shape stored at window.__sterilStatus (pushed by dashboard.html's RTDB listener):
// { active, startedAt (ms), totalSeconds, remainingSeconds, updatedAt (ms), deviceId }

function fmtMMSS(totalSec) {
  const n = Number(totalSec);
  const t = Math.max(0, Math.round(Number.isFinite(n) ? n : 0));
  const m = Math.floor(t / 60);
  const s = t % 60;
  return String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
}

function initCountdown() {
  const countdownEl = el('countdown');
  if (!countdownEl) return;

  const labelEl    = el('countdownLabel');
  const subtitleEl = el('nextCycleAt');
  const badgeEl    = el('nextCycleBadge');
  const statusEl   = el('nextCycleStatus');

  function render() {
    const s = window.__sterilStatus;
    const now = Date.now();
    // Consider a status "fresh" only if it was updated in the last 8 seconds.
    // This guards against a stuck active flag if the sterilization tab crashes.
    const isFresh = s && s.updatedAt && (now - s.updatedAt) < 8000;

    if (s && s.active && isFresh) {
      // Prefer locally-interpolated remaining from startedAt + totalSeconds
      // (smooth per-frame countdown between RTDB pushes).
      let remaining = s.remainingSeconds;
      if (s.startedAt && s.totalSeconds) {
        remaining = s.totalSeconds - (now - s.startedAt) / 1000;
      }
      countdownEl.textContent = fmtMMSS(remaining);
      countdownEl.style.background = '';
      countdownEl.style.webkitBackgroundClip = '';
      countdownEl.style.webkitTextFillColor = '';
      if (labelEl)    labelEl.textContent    = 'Sisa waktu sterilisasi';
      if (subtitleEl) subtitleEl.textContent = 'Proses sedang berjalan' + (s.deviceId ? ' · ' + s.deviceId : '');
      if (badgeEl) {
        badgeEl.textContent = 'In Progress';
        badgeEl.className   = 'badge badge-sterilizing';
        badgeEl.style.fontSize = '0.62rem';
      }
      if (statusEl) {
        statusEl.textContent = '⟳ Sterilizing';
        statusEl.style.color = 'var(--accent)';
      }
    } else {
      // Idle — alat siap digunakan
      countdownEl.textContent = 'SIAP';
      if (labelEl)    labelEl.textContent    = 'Status Alat';
      if (subtitleEl) subtitleEl.textContent = 'Alat siap digunakan';
      if (badgeEl) {
        badgeEl.textContent = 'Ready';
        badgeEl.className   = 'badge badge-clean';
        badgeEl.style.fontSize = '0.62rem';
      }
      if (statusEl) {
        statusEl.textContent = '✓ Siap';
        statusEl.style.color = 'var(--accent2)';
      }
    }
  }

  // Re-render once per second for smooth countdown + freshness check.
  window.__renderSterilCard = render;
  render();
  setInterval(render, 1000);
}

/* ── Header Date ─────────────────────────────────────────── */
function initHeaderDate() {
  const dateEl = el('headerDate');
  if (dateEl) {
    dateEl.textContent = formatDate(new Date());
  }
}

/* ── Notification Badge ──────────────────────────────────── */
function initNotifBadge() {
  const notifBtn = el('notifBtn');
  const notifDot = el('notifDot');
  const countEl  = el('notifCount');

  if (notifBtn) {
    notifBtn.addEventListener('click', () => {
      systemState.notifCount = 0;
      if (notifDot) notifDot.style.display = 'none';
      if (countEl) countEl.textContent = '0';
    });
  }
}

/* ── Refresh Button (Monitoring) ─────────────────────────── */
function initRefreshBtn() {
  const btn = el('refreshBtn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const icon = btn.querySelector('svg');
    if (icon) icon.classList.add('spin');
    setTimeout(() => {
      if (icon) icon.classList.remove('spin');
      renderCharts();
    }, 800);
  });
}

/* ── Export Button (History) ─────────────────────────────── */
function initExportBtn() {
  const btn = el('exportBtn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    alert('Exporting sterilization log as CSV…\n(Feature coming soon)');
  });
}

/* ── Filter Chips (History) ──────────────────────────────── */
function initFilterChips() {
  const chips = qsa('.chip');
  chips.forEach(chip => {
    chip.addEventListener('click', () => {
      chips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      // In a real app, filter the table here
    });
  });
}

/* ── AI Scan ─────────────────────────────────────────────── */
function initAiScan() {
  const scanBtn = el('scanBtn');
  if (!scanBtn) return;

  let scanning = false;

  scanBtn.addEventListener('click', () => {
    if (scanning) return;
    scanning = true;

    // Enter scanning state
    const cameraView = el('cameraView');
    const btnText = el('scanBtnText');
    const idleIcon = el('cameraIdleIcon');
    const resultOverlay = el('scanResultOverlay');

    if (cameraView) cameraView.classList.add('scanning');
    if (idleIcon) idleIcon.style.display = 'none';
    if (resultOverlay) resultOverlay.style.display = 'none';
    if (btnText) btnText.textContent = 'Scanning…';
    scanBtn.disabled = true;
    scanBtn.style.opacity = '0.6';

    setTimeout(() => {
      finishScan(cameraView, btnText, idleIcon, resultOverlay);
      scanning = false;
    }, 3200);
  });
}

function finishScan(cameraView, btnText, idleIcon, resultOverlay) {
  if (cameraView) cameraView.classList.remove('scanning');
  if (btnText) btnText.textContent = 'Scan Again';

  const scanBtn = el('scanBtn');
  if (scanBtn) { scanBtn.disabled = false; scanBtn.style.opacity = '1'; }

  // Random result for demo
  const outcomes = [
    { level: 'clean',    badge: 'badge-clean',    text: 'CLEAN',    conf: 94, contPct: 8,  contLevel: 'LOW',    color: CSS.accent2 },
    { level: 'moderate', badge: 'badge-moderate', text: 'MODERATE', conf: 87, contPct: 42, contLevel: 'MEDIUM', color: CSS.accent4 },
    { level: 'dirty',    badge: 'badge-dirty',    text: 'DIRTY',    conf: 91, contPct: 78, contLevel: 'HIGH',   color: CSS.red },
  ];
  const weights = [0.6, 0.3, 0.1]; // 60% clean, 30% moderate, 10% dirty
  const r = Math.random();
  let outcome;
  if (r < weights[0])             outcome = outcomes[0];
  else if (r < weights[0]+weights[1]) outcome = outcomes[1];
  else                            outcome = outcomes[2];

  // Show result overlay on camera
  if (resultOverlay) {
    resultOverlay.style.display = 'flex';
    const wrap = el('resultIconWrap');
    if (wrap) {
      wrap.style.borderColor = outcome.color;
      wrap.querySelector('svg').style.stroke = outcome.color;
    }
  }

  // Populate result card
  const badge = el('detectionBadge');
  if (badge) {
    badge.className = `badge ${outcome.badge} badge-lg`;
    badge.textContent = outcome.text;
  }

  const confNum = el('confidenceNum');
  if (confNum) confNum.textContent = outcome.conf + '%';

  const confBar = el('confidenceBar');
  if (confBar) {
    confBar.style.width = '0%';
    confBar.className = 'progress-fill teal';
    requestAnimationFrame(() => {
      confBar.style.transition = 'width 1s cubic-bezier(0.4,0,0.2,1)';
      confBar.style.width = outcome.conf + '%';
    });
  }

  const contBadge = el('contLevelBadge');
  if (contBadge) {
    contBadge.className = `badge ${outcome.badge}`;
    contBadge.textContent = outcome.contLevel;
  }

  const contBar = el('contaminationBar');
  if (contBar) {
    contBar.style.width = '0%';
    const colorClass = outcome.level === 'clean' ? 'teal' : outcome.level === 'moderate' ? 'yellow' : 'red';
    contBar.className = `progress-fill ${colorClass}`;
    requestAnimationFrame(() => {
      contBar.style.transition = 'width 1s cubic-bezier(0.4,0,0.2,1)';
      contBar.style.width = outcome.contPct + '%';
    });
  }

  const contPct = el('contPct');
  if (contPct) {
    contPct.textContent = outcome.contPct + '%';
    contPct.style.color = outcome.color;
  }

  // Scan time
  const scanTime = el('scanTime');
  if (scanTime) {
    scanTime.textContent = new Date().toLocaleTimeString('en-GB', {hour:'2-digit', minute:'2-digit'});
  }

  // Residue list
  const residueList = el('residueList');
  if (residueList) {
    const residues = outcome.level === 'clean'
      ? [
          { name: 'Food Residue', pct: 3, color: CSS.accent2 },
          { name: 'Oil Stains', pct: 2, color: CSS.accent2 },
          { name: 'Biological Residue', pct: 1, color: CSS.accent2 },
        ]
      : outcome.level === 'moderate'
      ? [
          { name: 'Food Residue', pct: 22, color: CSS.accent4 },
          { name: 'Oil Stains', pct: 18, color: CSS.accent4 },
          { name: 'Biological Residue', pct: 12, color: CSS.accent4 },
        ]
      : [
          { name: 'Food Residue', pct: 45, color: CSS.red },
          { name: 'Oil Stains', pct: 38, color: CSS.red },
          { name: 'Biological Residue', pct: 29, color: CSS.red },
        ];

    residueList.innerHTML = residues.map(r => `
      <div class="residue-item">
        <div class="flex items-center gap-10">
          <div class="residue-dot" style="background:${r.color};"></div>
          <span>${r.name}</span>
        </div>
        <span style="font-weight:600;color:${r.color};">${r.pct}%</span>
      </div>
    `).join('');
  }

  // Show result card
  const detectionResults = el('detectionResults');
  if (detectionResults) {
    detectionResults.classList.add('visible');
    detectionResults.style.display = 'flex';
  }

  // Scroll to results
  setTimeout(() => {
    if (detectionResults) {
      detectionResults.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, 200);
}

/* ── Bottom Nav Active State ─────────────────────────────── */
function syncNavState() {
  const page = detectPage();
  const pageToIndex = { home: 0, monitoring: 1, ai: 3, history: 4 };
  // Active states are already set via .active class in HTML
  // This function ensures JS consistency
}

/* ── Main Loop ───────────────────────────────────────────── */
function startSensorLoop() {
  setInterval(() => {
    // Skip dummy simulation if realtime database is active
    if (window.__realtimeActive) return;
    tickSensors();
    updateSensorDOM();
    renderCharts();
  }, 2000);
}

/* ── Page-specific Init ──────────────────────────────────── */
function initPage() {
  const page = detectPage();

  initHeaderDate();
  initNotifBadge();
  syncNavState();

  // Initial sensor display (skip if realtime will handle it)
  if (!window.__realtimeActive) updateSensorDOM();

  if (page === 'home') {
    initSystemStatus();
    initToggles();
    initCountdown();
    // Start the perpetual cleanliness-ring animator once per page load. Its
    // target is read each frame, so late realtime updates are picked up
    // without restarting (no race, no "stuck at stale target" bug).
    animateRing('cleanlinessRing', () => systemState.cleanliness, CSS.accent2);
    setTimeout(() => renderCharts(), 100);
  }

  if (page === 'monitoring') {
    initRefreshBtn();
    setTimeout(() => renderCharts(), 100);
  }

  if (page === 'ai') {
    initAiScan();
  }

  if (page === 'history') {
    initFilterChips();
    initExportBtn();
    // Start the success-rate ring once, same reason as cleanlinessRing above:
    // avoid restarting the animator whenever renderCharts runs on resize.
    animateRing('successRateRing', 96, CSS.green);
    setTimeout(() => renderCharts(), 100);
  }

  startSensorLoop();
}

/* ── Window resize → re-render charts ───────────────────── */
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(renderCharts, 200);
});

/* ── Boot ────────────────────────────────────────────────── */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initPage);
} else {
  initPage();
}
