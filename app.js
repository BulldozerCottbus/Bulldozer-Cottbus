import { auth, db } from "./firebase.js";

import {
    signInWithEmailAndPassword,
    onAuthStateChanged,
    signOut
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import {
    doc,
    getDoc,
    addDoc,
    collection,
    getDocs,
    query,
    where
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

/* ===================================================== */
/* GLOBAL STATE */
/* ===================================================== */

let CURRENT_UID = null;
let CURRENT_RANK = null;

/* ===================================================== */
/* LOGIN */
/* ===================================================== */

loginBtn.onclick = async () => {

    try {

        await signInWithEmailAndPassword(
            auth,
            email.value,
            password.value
        );

    } catch (e) {

        status.innerText = e.message;

    }
};

window.logout = async () => await signOut(auth);

/* ===================================================== */
/* SESSION */
/* ===================================================== */

onAuthStateChanged(auth, async user => {

    if (!user) return;

    CURRENT_UID = user.uid;

    loginScreen.classList.add("hidden");
    homeScreen.classList.remove("hidden");
    topBar.classList.remove("hidden");

    const snap = await getDoc(doc(db, "users", user.uid));
    const data = snap.data();

    CURRENT_RANK = data.rank;

    rankLabel.innerText = data.rank;
    userName.innerText = data.name;
    points.innerText = data.rPoints;

    applyRankRights(data.rank);

    loadInfos();
    loadRides();
    loadFiles();
    loadHelp();
});

/* ===================================================== */
/* RANK RIGHTS */
/* ===================================================== */

function applyRankRights(rank){

    if(["president","vice_president","sergeant_at_arms","secretary"].includes(rank)){
        postInfoBtn.classList.remove("hidden");
    }

    if(["president","vice_president","sergeant_at_arms","road_captain"].includes(rank)){
        createRideBtn.classList.remove("hidden");
    }
}

/* ===================================================== */
/* INFOSYSTEM */
/* ===================================================== */

async function loadInfos(){

    infosList.innerHTML = "";

    const snaps = await getDocs(collection(db, "infos"));

    snaps.forEach(docSnap => {

        const data = docSnap.data();

        infosList.innerHTML += `
            <div class="card">
                ${data.text}
            </div>
        `;
    });
}

window.postInfo = async () => {

    if (!newInfoText.value) return;

    await addDoc(collection(db, "infos"), {
        text: newInfoText.value,
        time: Date.now(),
        uid: CURRENT_UID
    });

    newInfoText.value = "";

    loadInfos();
};

/* ===================================================== */
/* RIDESYSTEM */
/* ===================================================== */

async function loadRides(){

    ridesList.innerHTML = "";

    const snaps = await getDocs(collection(db, "rides"));

    snaps.forEach(docSnap => {

        const r = docSnap.data();

        ridesList.innerHTML += `
            <div class="card priority${r.priority}">
                (${r.priority}) ${r.text}
            </div>
        `;
    });
}

window.createRide = async () => {

    if (!rideText.value) return;

    await addDoc(collection(db, "rides"), {
        text: rideText.value,
        priority: ridePriority.value,
        time: Date.now()
    });

    rideText.value = "";

    loadRides();
};

/* ===================================================== */
/* NOTIZEN */
/* ===================================================== */

window.saveNote = async () => {

    if (!noteText.value) return;

    await addDoc(collection(db, "notes"), {
        uid: CURRENT_UID,
        text: noteText.value,
        time: Date.now()
    });

    noteText.value = "";

    loadFiles();
};

/* ===================================================== */
/* RECHNER */
/* ===================================================== */

window.calcResult = () => {

    try {

        calcDisplay.value = Function("return " + calcDisplay.value)();

    } catch {

        alert("Rechenfehler");

    }
};

window.saveCalculation = async () => {

    await addDoc(collection(db, "calculations"), {
        uid: CURRENT_UID,
        calc: calcDisplay.value,
        time: Date.now()
    });

    loadFiles();
};

/* ===================================================== */
/* DATEIEN */
/* ===================================================== */

async function loadFiles(){

    filesNotes.innerHTML = "";
    filesCalcs.innerHTML = "";

    const notes = await getDocs(query(
        collection(db, "notes"),
        where("uid", "==", CURRENT_UID)
    ));

    notes.forEach(n => {

        filesNotes.innerHTML += `
            <div class="card">
                ${n.data().text}
            </div>
        `;
    });

    const calcs = await getDocs(query(
        collection(db, "calculations"),
        where("uid", "==", CURRENT_UID)
    ));

    calcs.forEach(c => {

        filesCalcs.innerHTML += `
            <div class="card">
                ${c.data().calc}
            </div>
        `;
    });
}

/* ===================================================== */
/* HILFE */
/* ===================================================== */

async function loadHelp(){

    helpList.innerHTML = "";

    const snaps = await getDocs(collection(db, "help_requests"));

    snaps.forEach(docSnap => {

        helpList.innerHTML += `
            <div class="card">
                ${docSnap.data().text}
            </div>
        `;
    });
}

window.createHelp = async () => {

    if (!helpText.value) return;

    await addDoc(collection(db, "help_requests"), {
        uid: CURRENT_UID,
        text: helpText.value,
        time: Date.now()
    });

    helpText.value = "";

    loadHelp();
};

/* ===================================================== */
/* NAVIGATION */
/* ===================================================== */

window.showScreen = id => {
    document.querySelectorAll(".container").forEach(s=>s.classList.add("hidden"));
    document.getElementById(id).classList.remove("hidden");
};

window.backHome = () => showScreen("homeScreen");
