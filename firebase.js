import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

export const app = initializeApp({
    apiKey: "AIzaSyCnFEjFOcrpwjHtVnQ_-QssGtEhY__FzDk",
    authDomain: "bulldozer-f8a26.firebaseapp.com",
    projectId: "bulldozer-f8a26"
});

export const auth = getAuth(app);
export const db = getFirestore(app);
