import { auth, db } from "./firebase.js";

import {
    signInWithEmailAndPassword,
    onAuthStateChanged,
    signOut
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import {
    doc,
    getDoc
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

/* LOGIN */

loginBtn.onclick = async () => {
    try {
        await signInWithEmailAndPassword(auth,email.value,password.value);
    } catch(e){
        status.innerText = e.message;
    }
};

window.logout = async () => await signOut(auth);

/* SESSION */

onAuthStateChanged(auth, async user => {

    if (!user) return;

    loginScreen.classList.add("hidden");
    homeScreen.classList.remove("hidden");
    topBar.classList.remove("hidden");

    const snap = await getDoc(doc(db,"users",user.uid));
    const data = snap.data();

    rankLabel.innerText = data.rank;
    userName.innerText = data.name;
    points.innerText = data.rPoints;

    applyRankRights(data.rank);
});

/* RANGRECHTE */

function applyRankRights(rank){

    if(["president","vice_president","sergeant_at_arms","secretary"].includes(rank)){
        postInfoBtn.classList.remove("hidden");
    }

    if(["president","vice_president","sergeant_at_arms","road_captain"].includes(rank)){
        createRideBtn.classList.remove("hidden");
    }
}

/* NAVIGATION */

window.showScreen = id => {
    document.querySelectorAll(".container").forEach(s=>s.classList.add("hidden"));
    document.getElementById(id).classList.remove("hidden");
};

window.backHome = () => showScreen("homeScreen");
