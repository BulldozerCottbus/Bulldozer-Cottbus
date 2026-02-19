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
  where,
  deleteDoc,
  updateDoc,
  orderBy,
  limit
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
loadUsersForNotes();
loadMyNotes();
loadUsersForTasks();
loadTasks();
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

    const target = noteTarget?.value || CURRENT_UID;
    const type = noteType?.value || "privat";

    await addDoc(collection(db,"notes"),{
        from: CURRENT_UID,
        to: target || CURRENT_UID,
        text: noteText.value,
        type: type,
        time: Date.now()
    });

    noteText.value = "";

    loadFiles();
    loadMyNotes();
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

  if (!document.getElementById("filesNotes") || !document.getElementById("filesCalcs")) return;

  filesNotes.innerHTML = "";
  filesCalcs.innerHTML = "";

  // ✅ Notes: alles was mich betrifft (gesendet ODER empfangen)
  const sentSnaps = await getDocs(query(
    collection(db, "notes"),
    where("from", "==", CURRENT_UID)
  ));

  const receivedSnaps = await getDocs(query(
    collection(db, "notes"),
    where("to", "==", CURRENT_UID)
  ));

  // zusammenführen (ohne doppelte)
  const map = new Map();
  sentSnaps.forEach(d => map.set(d.id, d));
  receivedSnaps.forEach(d => map.set(d.id, d));

  // sortieren nach Zeit (neueste zuerst)
  const items = [...map.values()]
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.time || 0) - (a.time || 0));

  if (items.length === 0) {
    filesNotes.innerHTML = `<div class="card">Keine Notizen gespeichert.</div>`;
  } else {
    items.forEach(n => {
      filesNotes.innerHTML += `
        <div class="card note-${n.type || "privat"}">
          <b>${(n.type || "privat").toUpperCase()}</b><br>
          ${n.text || ""}
        </div>
      `;
    });
  }

  // ✅ Rechnungen laden (deine alten Daten nutzen uid)
  // ✅ Rechnungen laden
  const calcsSnap = await getDocs(query(
    collection(db, "calculations"),
    where("uid", "==", CURRENT_UID)
  ));

  const calcs = [];
  calcsSnap.forEach(d => calcs.push(d.data()));
  calcs.sort((a, b) => (b.time || 0) - (a.time || 0));

  if (calcs.length === 0) {
    filesCalcs.innerHTML = `<div class="card">Keine Rechnungen gespeichert.</div>`;
  } else {
    calcs.forEach(c => {
      filesCalcs.innerHTML += `
        <div class="card">
          ${c.calc || ""}
        </div>
      `;
    });
  }
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

/* ===================================================== */
/* WARN INFO (INFOS TAB) */
/* ===================================================== */

window.toggleWarnInfo = () => {
  const box = document.getElementById("warnInfoBox");
  if (!box) return;

  const rules = document.getElementById("clubRulesBox");
  if (rules && !rules.classList.contains("hidden")) rules.classList.add("hidden");

  box.classList.toggle("hidden");
};

/* ===================================================== */
/* CLUB REGELN (INFOS TAB) */
/* ===================================================== */

window.toggleClubRules = () => {
  const box = document.getElementById("clubRulesBox");
  if (!box) return;

  const warn = document.getElementById("warnInfoBox");
  if (warn && !warn.classList.contains("hidden")) warn.classList.add("hidden");

  box.classList.toggle("hidden");
};

/* ===================================================== */
/* USERS FÜR NOTIZEN LADEN */
/* ===================================================== */

async function loadUsersForNotes(){

    if (!document.getElementById("noteTarget")) return;

    noteTarget.innerHTML = `<option value="">Nur für mich speichern</option>`;

    const snaps = await getDocs(collection(db,"users"));

    snaps.forEach(docSnap => {

        const data = docSnap.data();

        noteTarget.innerHTML += `
            <option value="${docSnap.id}">
                ${data.name}
            </option>
        `;
    });
}

/* ===================================================== */
/* EIGENE NOTIZEN LADEN */
/* ===================================================== */

async function loadMyNotes(){

    if (!document.getElementById("myNotes")) return;

    myNotes.innerHTML = "";

    const snaps = await getDocs(collection(db,"notes"));

    snaps.forEach(docSnap => {

        const n = docSnap.data();

        /* Sichtbarkeitslogik */

        if (!canViewAllNotes()) {

            if (n.to !== CURRENT_UID && n.from !== CURRENT_UID) return;
        }

        const deleteButton = canDeleteNote(n)
            ? `<button onclick="deleteNote('${docSnap.id}')">Löschen</button>`
            : "";

myNotes.innerHTML += `
    <div class="card note-${n.type || "privat"}">
        <b>${(n.type || "privat").toUpperCase()}</b><br>
        ${n.text}
        ${deleteButton}
    </div>
`;
    });
}

/* ===================================================== */
/* NOTIZ LÖSCHEN */
/* ===================================================== */

window.deleteNote = async (id) => {

    await deleteDoc(doc(db,"notes",id));

    loadMyNotes();
    loadFiles();
};

/* ===================================================== */
/* RANGRECHTE / SICHTBARKEIT */
/* ===================================================== */

function canViewAllNotes(){

    return [
        "president",
        "vice_president",
        "sergeant_at_arms",
        "secretary"
    ].includes(CURRENT_RANK);
}

function canDeleteNote(note){

    if (canViewAllNotes()) return true;

    return note.from === CURRENT_UID;
}

/* ===================================================== */
/* TASK SYSTEM */
/* ===================================================== */

async function loadUsersForTasks(){

    if (!document.getElementById("taskTarget")) return;

    taskTarget.innerHTML = `<option value="">An mich selbst</option>`;

    const snaps = await getDocs(collection(db,"users"));

    snaps.forEach(docSnap => {

        const data = docSnap.data();

        taskTarget.innerHTML += `
            <option value="${docSnap.id}">
                ${data.name}
            </option>
        `;
    });
}

createTaskBtn.onclick = async () => {

    if (!taskText.value) return;

    await addDoc(collection(db,"tasks"),{
        from: CURRENT_UID,
        to: taskTarget.value || CURRENT_UID,
        text: taskText.value,
        status: "open",
        time: Date.now()
    });

    taskText.value = "";

    loadTasks();
};

async function loadTasks(){

    if (!document.getElementById("taskList")) return;

    taskList.innerHTML = "";

    const snaps = await getDocs(collection(db,"tasks"));

    snaps.forEach(docSnap => {

        const t = docSnap.data();

        if (!canViewAllNotes()) {
            if (t.to !== CURRENT_UID) return;
        }

        const doneButton = `
            <button onclick="markTaskDone('${docSnap.id}')">
                Erledigt
            </button>
        `;

        taskList.innerHTML += `
            <div class="card task-${t.status}">
                ${t.text}
                ${doneButton}
            </div>
        `;
    });
}

window.markTaskDone = async id => {

    await updateDoc(doc(db,"tasks",id),{
        status: "done"
    });

    loadTasks();
};

/* ===================================================== */
/* OFFICER & ADMIN RIGHTS ENGINE */
/* ===================================================== */

function isAdmin(){
    return CURRENT_RANK === "admin";
}

function hasOfficerRights(){

    return [
        "president",
        "vice_president",
        "sergeant_at_arms"
    ].includes(CURRENT_RANK) || isAdmin();
}

/* ===================================================== */
/* MANUELLE PUNKTEVERGABE */
/* ===================================================== */

window.addPoints = async (targetUid, amount) => {

    if (!hasOfficerRights()) {
        alert("Keine Berechtigung");
        return;
    }

    const ref = doc(db,"users",targetUid);
    const snap = await getDoc(ref);

    const current = snap.data().rPoints || 0;

    await updateDoc(ref,{
        rPoints: current + Number(amount)
    });

    await addDoc(collection(db,"points_log"),{
        targetUid,
        amount: Number(amount),
        by: CURRENT_UID,
        time: Date.now()
    });

    alert("Punkte vergeben");
};

/* ===================================================== */
/* SECRETARY RIGHTS */
/* ===================================================== */

function hasSecretaryRights(){

    return [
        "secretary",
        "president",
        "vice_president",
        "sergeant_at_arms",
        "admin"
    ].includes(CURRENT_RANK);
}

/* ===================================================== */
/* SECRETARY TABS (WICHTIG: MUSS GLOBAL SEIN, NICHT IN EINER FUNKTION) */
/* ===================================================== */

window.secShow = (which) => {
    const a = document.getElementById("secMember");
    const b = document.getElementById("secMeetings");
    if (!a || !b) return;

    a.classList.add("hidden");
    b.classList.add("hidden");

    const target = document.getElementById(which);
    if (target) target.classList.remove("hidden");

    // Optional: Meetings neu laden wenn Tab geöffnet
    if (which === "secMeetings") loadMeetings();
};

window.showSecretaryPanel = () => {

    if (!hasSecretaryRights()) {
        alert("Kein Zugriff");
        return;
    }

    // ✅ FIX: showScreen muss den CONTAINER-SCREEN öffnen
    showScreen("secretaryScreen");

    // ✅ FIX: Tab setzen
    secShow("secMember");

    loadSecretaryEntries();
    loadMeetings();
};

/* ===================================================== */
/* MEMBER OBSERVATION SAVE */
/* ===================================================== */

saveMemberObservation.onclick = async () => {

    if (!secName.value) return;

    await addDoc(collection(db,"member_observations"),{

        name: secName.value,
        joinDate: secJoinDate.value,
        startRank: secStartRank.value,
        contribution: secContribution.value,

        warn1: warn1.checked,
        warn2: warn2.checked,
        warnText: warnText.value,

        sponsor: selfJoined.checked ? "self_joined" : secSponsor.value,

        notes: secNotes.value,

        createdBy: CURRENT_UID,
        time: Date.now()
    });

    secName.value = "";
    warnText.value = "";
    secNotes.value = "";

    loadSecretaryEntries();
};

/* ===================================================== */
/* SECRETARY DETAIL / TIMELINE SYSTEM */
/* ===================================================== */

let CURRENT_MEMBER_DOC = null;

/* Einträge klickbar laden */

async function loadSecretaryEntries(){

    if (!document.getElementById("secEntries")) return;

    secEntries.innerHTML = "";

    const snaps = await getDocs(collection(db,"member_observations"));

    snaps.forEach(docSnap => {

        const e = docSnap.data();

        let warnClass = "";

        if (e.warn2) warnClass = "warn-w2";
        else if (e.warn1) warnClass = "warn-w1";

        secEntries.innerHTML += `
            <div class="card sec-entry ${warnClass}"
                 onclick="openMemberFile('${docSnap.id}')">

                <b>${e.name}</b><br>
                Start: ${e.startRank}<br>
                Beitrag: ${e.contribution || "-"} €<br>
                Warns: ${e.warn1 ? "W.1 " : ""}${e.warn2 ? "W.2" : ""}
            </div>
        `;
    });
}

/* Akte öffnen */

window.openMemberFile = async (docId) => {

    CURRENT_MEMBER_DOC = docId;

    const snap = await getDoc(doc(db,"member_observations",docId));
    const data = snap.data();

    secDetail.innerHTML = `
        <div class="card">
            <h4>${data.name}</h4>
            Mitglied seit: ${data.joinDate || "-"}<br>
            Start Rang: ${data.startRank}<br>
            Sponsor: ${data.sponsor || "-"}<br>
            <br>
            ${data.notes || ""}
        </div>
        <h4>Timeline</h4>
        <div id="timelineList"></div>
    `;

    loadTimeline();
};

/* Timeline laden */

async function loadTimeline(){

    if (!CURRENT_MEMBER_DOC) return;

    const snaps = await getDocs(collection(
        db,
        "member_observations",
        CURRENT_MEMBER_DOC,
        "timeline"
    ));

    const container = document.getElementById("timelineList");

    container.innerHTML = "";

    snaps.forEach(docSnap => {

        const t = docSnap.data();

        container.innerHTML += `
            <div class="timeline-entry">
                <b>${t.date || "-"}</b> – ${t.rank || ""}<br>
                ${t.text}
            </div>
        `;
    });
}

/* Timeline speichern */

addTimelineEntry.onclick = async () => {

    if (!CURRENT_MEMBER_DOC) {
        alert("Erst Akte öffnen");
        return;
    }

    await addDoc(collection(
        db,
        "member_observations",
        CURRENT_MEMBER_DOC,
        "timeline"
    ),{
        date: timelineDate.value,
        rank: timelineRank.value,
        text: timelineText.value,
        by: CURRENT_UID,
        time: Date.now()
    });

    timelineText.value = "";
    timelineRank.value = "";

    loadTimeline();
};

/* ===================================================== */
/* SECRETARY PROFI SYSTEM */
/* ===================================================== */

/* Speichern */

window.saveMemberFile = async () => {

    if (!CURRENT_MEMBER_DOC) return;

    await updateDoc(doc(db,"member_observations",CURRENT_MEMBER_DOC),{

        name: editName.value,
        contribution: editContribution.value,

        warn1: editWarn1.checked,
        warn2: editWarn2.checked,

        notes: editNotes.value
    });

    alert("Gespeichert");

    loadSecretaryEntries();
    openMemberFile(CURRENT_MEMBER_DOC);
};

/* Löschen */

window.deleteMemberFile = async () => {

    if (!CURRENT_MEMBER_DOC) return;

    if (!confirm("Akte wirklich löschen?")) return;

    await deleteDoc(doc(db,"member_observations",CURRENT_MEMBER_DOC));

    CURRENT_MEMBER_DOC = null;

    // ✅ FIX: secShow NICHT hier definieren (war bei dir falsch drin)
    secDetail.innerHTML = "";

    loadSecretaryEntries();
};

/* ===================================================== */
/* MEETINGS (BESPRECHUNGSVERLAUF) */
/* ===================================================== */

let EDIT_MEETING_ID = null;

function resetMeetingForm(){
  EDIT_MEETING_ID = null;

  meetDate.value = "";
  meetTitle.value = "";
  meetAgenda.value = "";
  meetNotes.value = "";

  voteTopic.value = "";
  voteOptions.value = "";
  voteResult.value = "";

  meetPersons.value = "";
  meetAttendees.value = "";
  meetFollowups.value = "";

  meetStatus.value = "open";

  if (document.getElementById("saveMeetingBtn")) {
    saveMeetingBtn.textContent = "Besprechung speichern";
  }
}

async function loadMeetings(){
  const list = document.getElementById("meetingList");
  if (!list) return;

  list.innerHTML = "";

  // ✅ FIX: sortiert + begrenzt (braucht orderBy + limit im Import)
  const snaps = await getDocs(
    query(collection(db, "meetings"), orderBy("date", "desc"), limit(50))
  );

  if (snaps.empty) {
    list.innerHTML = `<div class="card">Noch keine Protokolle.</div>`;
    return;
  }

  snaps.forEach(docSnap => {
    const m = docSnap.data();

    list.innerHTML += `
      <div class="card ${m.status === "done" ? "task-done" : "task-open"}">
        <b>${m.date || "-"}</b> – ${m.title || "Besprechung"}<br>
        <small>${m.agenda || ""}</small><br><br>
        ${m.notes || ""}<br><br>
        <b>Abstimmung:</b> ${m.voteTopic || "-"}<br>
        Optionen: ${m.voteOptions || "-"}<br>
        Ergebnis: ${m.voteResult || "-"}<br><br>
        <b>Betroffen:</b> ${m.persons || "-"}<br>
        <b>Teilnehmer:</b> ${m.attendees || "-"}<br><br>
        <b>Follow-ups:</b><br>${m.followups || "-"}<br><br>

        <button onclick="editMeeting('${docSnap.id}')">Bearbeiten</button>
        <button onclick="deleteMeeting('${docSnap.id}')">Löschen</button>
        <button onclick="toggleMeetingStatus('${docSnap.id}', '${m.status || "open"}')">
          Status: ${m.status === "done" ? "Erledigt" : "Offen"}
        </button>
      </div>
    `;
  });
}

saveMeetingBtn.onclick = async () => {

  if (!hasSecretaryRights()) {
    alert("Kein Zugriff");
    return;
  }

  if (!meetDate.value || !meetTitle.value) {
    alert("Datum und Titel sind Pflicht");
    return;
  }

  const payload = {
    date: meetDate.value,
    title: meetTitle.value,
    agenda: meetAgenda.value,
    notes: meetNotes.value,

    voteTopic: voteTopic.value,
    voteOptions: voteOptions.value,
    voteResult: voteResult.value,

    persons: meetPersons.value,
    attendees: meetAttendees.value,
    followups: meetFollowups.value,

    status: meetStatus.value,

    createdBy: CURRENT_UID,
    time: Date.now()
  };

  // ✅ FIX: Wenn Bearbeiten aktiv -> update, sonst add
  if (EDIT_MEETING_ID) {
    await updateDoc(doc(db, "meetings", EDIT_MEETING_ID), payload);
  } else {
    await addDoc(collection(db, "meetings"), payload);
  }

  // ✅ Nach Speichern Felder leeren + Modus zurücksetzen
  resetMeetingForm();
  loadMeetings();
};

window.editMeeting = async (id) => {
  if (!hasSecretaryRights()) return;

  const snap = await getDoc(doc(db, "meetings", id));
  if (!snap.exists()) return alert("Nicht gefunden");

  const m = snap.data();
  EDIT_MEETING_ID = id;

  meetDate.value = m.date || "";
  meetTitle.value = m.title || "";
  meetAgenda.value = m.agenda || "";
  meetNotes.value = m.notes || "";

  voteTopic.value = m.voteTopic || "";
  voteOptions.value = m.voteOptions || "";
  voteResult.value = m.voteResult || "";

  meetPersons.value = m.persons || "";
  meetAttendees.value = m.attendees || "";
  meetFollowups.value = m.followups || "";

  meetStatus.value = m.status || "open";

  saveMeetingBtn.textContent = "✅ Änderungen speichern";

  // optional: direkt den Tab zeigen
  secShow("secMeetings");
};

window.deleteMeeting = async (id) => {
  if (!hasSecretaryRights()) return;
  if (!confirm("Besprechung wirklich löschen?")) return;
  await deleteDoc(doc(db, "meetings", id));
  loadMeetings();
};

window.toggleMeetingStatus = async (id, current) => {
  if (!hasSecretaryRights()) return;
  const next = current === "done" ? "open" : "done";
  await updateDoc(doc(db, "meetings", id), { status: next });
  loadMeetings();
};
