// firebase.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-analytics.js";

const firebaseConfig = {
  apiKey: "AIzaSyCnFEjFOcrpwjHtVnQ_-QssGtEhY__FzDk",
  authDomain: "bulldozer-f8a26.firebaseapp.com",
  projectId: "bulldozer-f8a26",
  storageBucket: "bulldozer-f8a26.firebasestorage.app",
  messagingSenderId: "576318762826",
  appId: "1:576318762826:web:7d812e32e152d64d425bb3",
  measurementId: "G-X3C80RP00D"
};

export const app = initializeApp(firebaseConfig);

// Analytics optional & safe
export let analytics = null;
try {
  analytics = getAnalytics(app);
} catch (e) {
  // z.B. localhost / blockierte Cookies / unsupportet env
  console.warn("Firebase Analytics deaktiviert:", e?.message || e);
}

export const auth = getAuth(app);
export const db = getFirestore(app);
