/**
 * SteriFlow — Firebase web app config (same object as in Firebase console).
 *
 * Setup:
 *   cp js/firebase-config.example.js js/firebase-config.js
 *   Replace placeholders with values from Project settings in Firebase console.
 *
 * js/firebase-config.js is listed in .gitignore so it will not be committed.
 * Rotate keys in Firebase console if they were ever committed publicly.
 */
export const firebaseConfig = {
  apiKey: 'YOUR_FIREBASE_API_KEY',
  authDomain: 'your-project.firebaseapp.com',
  databaseURL: 'https://your-project-default-rtdb.REGION.firebasedatabase.app',
  projectId: 'your-project-id',
  storageBucket: 'your-project.firebasestorage.app',
  messagingSenderId: '000000000000',
  appId: '1:000000000000:web:xxxxxxxxxxxxxxxxxxxxxx'
};
