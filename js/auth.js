// ============================================================
//  SteriFlow — Firebase Auth + Firestore
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.7.3/firebase-app.js";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  onAuthStateChanged,
  signOut,
  updateProfile
} from "https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js";
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

// ── Firebase Config ──────────────────────────────────────────
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const googleProvider = new GoogleAuthProvider();

// ── Protected Pages List ─────────────────────────────────────
const PROTECTED_PAGES = ['dashboard.html', 'monitoring.html', 'history.html', 'ai-detection.html', 'account.html'];
const AUTH_PAGE = 'auth.html';
const PUBLIC_PAGES = ['index.html', 'auth.html', ''];

// ── Auth Guard ───────────────────────────────────────────────
function getCurrentPage() {
  const path = window.location.pathname;
  const filename = path.substring(path.lastIndexOf('/') + 1) || 'index.html';
  return filename;
}

function isProtectedPage(page) {
  return PROTECTED_PAGES.includes(page);
}

function isAuthPage(page) {
  return page === AUTH_PAGE;
}

// Flag: true while login/register is in progress (prevents onAuthStateChanged redirect)
let authActionInProgress = false;

// Listen for auth state changes globally
onAuthStateChanged(auth, (user) => {
  const currentPage = getCurrentPage();

  if (!user && isProtectedPage(currentPage)) {
    window.location.href = 'auth.html';
    return;
  }

  if (user && isAuthPage(currentPage) && !authActionInProgress) {
    // Already logged in (e.g. returning to auth page), redirect to dashboard
    window.location.href = 'dashboard.html';
    return;
  }

  if (user && isProtectedPage(currentPage)) {
    updateUserUI(user);
  }
});

// ── Update UI with user info (for dashboard pages) ───────────
function updateUserUI(user) {
  const userNameEls = document.querySelectorAll('[data-user-name]');
  const userEmailEls = document.querySelectorAll('[data-user-email]');
  const logoutBtns = document.querySelectorAll('[data-logout]');

  const displayName = user.displayName || user.email.split('@')[0];

  userNameEls.forEach(el => el.textContent = displayName);
  userEmailEls.forEach(el => el.textContent = user.email);

  logoutBtns.forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      await signOut(auth);
      window.location.href = 'auth.html';
    });
  });
}

// ── Save user to Firestore ───────────────────────────────────
async function saveUserToFirestore(user, extraData = {}) {
  try {
    const userRef = doc(db, 'users', user.uid);

    // Use setDoc with merge — works for both new and existing users.
    // For new users: creates the doc. For existing: merges fields.
    // This avoids needing a getDoc first (which can fail on permissions).
    const userData = {
      uid: user.uid,
      email: user.email,
      displayName: user.displayName || extraData.displayName || '',
      photoURL: user.photoURL || '',
      provider: extraData.provider || 'email',
      lastLoginAt: serverTimestamp()
    };

    // Check if doc exists to set createdAt only on first write
    try {
      const userSnap = await getDoc(userRef);
      if (!userSnap.exists()) {
        userData.createdAt = serverTimestamp();
      }
    } catch (readErr) {
      // If read fails (e.g. no doc yet), treat as new user
      userData.createdAt = serverTimestamp();
    }

    await setDoc(userRef, userData, { merge: true });
    console.log('User saved to Firestore:', user.uid);
  } catch (e) {
    console.error('Firestore save error:', e);
  }
}

// ── Auth Page Logic ──────────────────────────────────────────
function initAuthPage() {
  // Tab switching
  const tabs = document.querySelectorAll('.auth-tab');
  const panels = document.querySelectorAll('.auth-panel');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      tabs.forEach(t => t.classList.remove('active'));
      panels.forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('panel-' + target).classList.add('active');
      hideMessage();
    });
  });

  // Password toggle
  document.querySelectorAll('.auth-toggle-pw').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = btn.parentElement.querySelector('.auth-input');
      const isPassword = input.type === 'password';
      input.type = isPassword ? 'text' : 'password';
      btn.querySelector('.eye-open').style.display = isPassword ? 'none' : 'block';
      btn.querySelector('.eye-closed').style.display = isPassword ? 'block' : 'none';
    });
  });

  // Login form
  const loginForm = document.getElementById('loginForm');
  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('loginEmail').value.trim();
      const password = document.getElementById('loginPassword').value;
      const btn = loginForm.querySelector('.auth-submit');

      if (!email || !password) {
        showMessage('Please fill in all fields.', 'error');
        return;
      }

      setLoading(btn, true);
      hideMessage();
      authActionInProgress = true;

      try {
        const cred = await signInWithEmailAndPassword(auth, email, password);
        await saveUserToFirestore(cred.user, { provider: 'email' });
        showMessage('Login successful! Redirecting...', 'success');
        setTimeout(() => { window.location.href = 'dashboard.html'; }, 800);
      } catch (err) {
        authActionInProgress = false;
        showMessage(getErrorMessage(err.code), 'error');
        setLoading(btn, false);
      }
    });
  }

  // Register form
  const registerForm = document.getElementById('registerForm');
  if (registerForm) {
    registerForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('registerName').value.trim();
      const email = document.getElementById('registerEmail').value.trim();
      const password = document.getElementById('registerPassword').value;
      const btn = registerForm.querySelector('.auth-submit');

      if (!name || !email || !password) {
        showMessage('Please fill in all fields.', 'error');
        return;
      }

      if (password.length < 6) {
        showMessage('Password must be at least 6 characters.', 'error');
        return;
      }

      setLoading(btn, true);
      hideMessage();
      authActionInProgress = true;

      try {
        const cred = await createUserWithEmailAndPassword(auth, email, password);
        await updateProfile(cred.user, { displayName: name });
        await saveUserToFirestore(cred.user, { provider: 'email', displayName: name });
        showMessage('Registration successful! Redirecting...', 'success');
        setTimeout(() => { window.location.href = 'dashboard.html'; }, 800);
      } catch (err) {
        authActionInProgress = false;
        showMessage(getErrorMessage(err.code), 'error');
        setLoading(btn, false);
      }
    });
  }

  // Google Sign In
  document.querySelectorAll('.auth-google').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      hideMessage();
      authActionInProgress = true;

      try {
        const result = await signInWithPopup(auth, googleProvider);
        await saveUserToFirestore(result.user, { provider: 'google' });
        showMessage('Login successful! Redirecting...', 'success');
        setTimeout(() => { window.location.href = 'dashboard.html'; }, 800);
      } catch (err) {
        authActionInProgress = false;
        if (err.code !== 'auth/popup-closed-by-user') {
          showMessage(getErrorMessage(err.code), 'error');
        }
        btn.disabled = false;
      }
    });
  });
}

// ── Helpers ──────────────────────────────────────────────────
function showMessage(text, type) {
  const msgEl = document.querySelector('.auth-message');
  if (!msgEl) return;
  msgEl.className = 'auth-message show ' + type;
  msgEl.querySelector('.auth-msg-text').textContent = text;
}

function hideMessage() {
  const msgEl = document.querySelector('.auth-message');
  if (msgEl) msgEl.classList.remove('show');
}

function setLoading(btn, loading) {
  btn.classList.toggle('loading', loading);
  btn.disabled = loading;
}

function getErrorMessage(code) {
  const messages = {
    'auth/user-not-found': 'Account not found. Please register first.',
    'auth/wrong-password': 'Wrong password. Please try again.',
    'auth/invalid-credential': 'Invalid email or password.',
    'auth/email-already-in-use': 'Email already registered. Please login.',
    'auth/weak-password': 'Password too weak. Minimum 6 characters.',
    'auth/invalid-email': 'Invalid email format.',
    'auth/too-many-requests': 'Too many attempts. Please try again later.',
    'auth/network-request-failed': 'Failed to connect to the network.',
    'auth/popup-blocked': 'Popup blocked by browser. Allow popups and try again.',
    'auth/account-exists-with-different-credential': 'Account already exists with a different login method.',
  };
  return messages[code] || 'An error occurred. Please try again.';
}

// ── Init ─────────────────────────────────────────────────────
if (getCurrentPage() === AUTH_PAGE) {
  document.addEventListener('DOMContentLoaded', initAuthPage);
}

// Export for use in other modules
export { auth, db, signOut, onAuthStateChanged };
