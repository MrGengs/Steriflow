// ============================================================
//  SteriFlow — Sterilization Flow & History (Firestore)
//  Connects AI Detection → Sterilization → History
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.7.3/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js";
import {
  getFirestore, collection, addDoc, query, where, orderBy, getDocs,
  serverTimestamp, limit as firestoreLimit, Timestamp
} from "https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js";
import {
  getDatabase, ref, set
} from "https://www.gstatic.com/firebasejs/11.7.3/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js";

let app;
try { app = initializeApp(firebaseConfig); } catch (e) {
  const { getApp } = await import("https://www.gstatic.com/firebasejs/11.7.3/firebase-app.js");
  app = getApp();
}

const auth = getAuth(app);
const db = getFirestore(app);
const rtdb = getDatabase(app);

// ── Save sterilization log to Firestore ──────────────────────
export async function saveSterilizationLog(logData) {
  const user = auth.currentUser;
  if (!user) return null;

  try {
    const docRef = await addDoc(collection(db, 'users', user.uid, 'sterilization_logs'), {
      classification: logData.classification || 'Unknown',
      confidence: logData.confidence || 0,
      contaminationLevel: logData.contamination_level || 0,
      analysis: logData.analysis || '',
      residues: logData.residues || [],
      durationMinutes: logData.durationMinutes || 0,
      status: logData.status || 'Sterilized', // Sterilized | Skipped
      sensorData: logData.sensorData || {},
      createdAt: serverTimestamp()
    });
    console.log('Sterilization log saved:', docRef.id);
    return docRef.id;
  } catch (e) {
    console.error('Failed to save sterilization log:', e);
    return null;
  }
}

// ── Load sterilization history from Firestore ────────────────
export async function loadHistory(filterType = 'all') {
  const user = auth.currentUser;
  if (!user) return [];

  try {
    let q = query(
      collection(db, 'users', user.uid, 'sterilization_logs'),
      orderBy('createdAt', 'desc'),
      firestoreLimit(50)
    );

    const snapshot = await getDocs(q);
    const logs = [];

    snapshot.forEach(doc => {
      const data = doc.data();
      const date = data.createdAt?.toDate?.() || new Date();

      // Apply filter
      if (filterType !== 'all') {
        const now = new Date();
        if (filterType === 'today') {
          if (date.toDateString() !== now.toDateString()) return;
        } else if (filterType === 'week') {
          const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          if (date < weekAgo) return;
        } else if (filterType === 'month') {
          if (date.getMonth() !== now.getMonth() || date.getFullYear() !== now.getFullYear()) return;
        }
      }

      logs.push({ id: doc.id, ...data, date });
    });

    return logs;
  } catch (e) {
    console.error('Failed to load history:', e);
    return [];
  }
}

// ── Start sterilization process ──────────────────────────────
export async function startSterilization(durationMinutes, onTick, onComplete) {
  // Turn ON UV and Fan via RTDB
  try {
    await set(ref(rtdb, 'relayCommand/uv'), true);
    await set(ref(rtdb, 'relayCommand/fan'), true);
  } catch (e) {
    console.error('Failed to activate relays:', e);
  }

  const totalSeconds = Math.round(durationMinutes * 60);
  let elapsed = 0;

  const timer = setInterval(() => {
    elapsed++;
    const pct = Math.min(100, Math.round((elapsed / totalSeconds) * 100));
    const remaining = totalSeconds - elapsed;
    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;

    if (onTick) onTick({ pct, elapsed, remaining, mins, secs, total: totalSeconds });

    if (elapsed >= totalSeconds) {
      clearInterval(timer);
      stopSterilization();
      if (onComplete) onComplete();
    }
  }, 1000);

  return timer;
}

// ── Stop sterilization ───────────────────────────────────────
export async function stopSterilization() {
  try {
    await set(ref(rtdb, 'relayCommand/uv'), false);
    await set(ref(rtdb, 'relayCommand/fan'), false);
  } catch (e) {
    console.error('Failed to deactivate relays:', e);
  }
}

// ── Get sterilization duration recommendation from AI result ─
export function getRecommendedDuration(classification, contaminationLevel) {
  if (classification === 'Clean') return 0; // No sterilization needed
  if (classification === 'Moderate') {
    if (contaminationLevel > 40) return 3;
    return 2;
  }
  // Dirty
  if (contaminationLevel > 80) return 7;
  if (contaminationLevel > 60) return 5;
  return 4;
}

export { auth, db };
