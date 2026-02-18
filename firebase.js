// firebase.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// Optional: falls du später Uploads brauchst (Storage)
// import { getStorage } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyCnFEjFOcrpwjHtVnQ_-QssGtEhY__FzDk",
  authDomain: "bulldozer-f8a26.firebaseapp.com",
  projectId: "bulldozer-f8a26",

  // ✅ Diese 3 Werte bitte aus der Firebase Console ergänzen:
  storageBucket: "bulldozer-f8a26.appspot.com", // meistens genau so
  messagingSenderId: "PASTE_YOUR_SENDER_ID",
  appId: "PASTE_YOUR_APP_ID",

  // Optional (nur wenn du Analytics nutzt)
  // measurementId: "G-XXXXXXX"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// Optional: falls du Storage nutzt
// export const storage = getStorage(app);
