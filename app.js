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

// ✅ Helper: sicher Elemente holen (ohne "global id variable" Problem)
const $ = (id) => document.getElementById(id);

/* ===================================================== */
/* DOM REFS (damit Module nicht crasht) */
/* ===================================================== */

const loginScreen = $("loginScreen");
const homeScreen = $("homeScreen");
const topBar = $("topBar");

const rankLabel = $("rankLabel");
const userName = $("userName");
const points = $("points");

const email = $("email");
const password = $("password");
const loginBtn = $("loginBtn");
const status = $("status");

const postInfoBtn = $("postInfoBtn");
const newInfoText = $("newInfoText");
const infosList = $("infosList");

const ridesList = $("ridesList");
const rideText = $("rideText");
const ridePriority = $("ridePriority");
const createRideBtn = $("createRideBtn");

const noteText = $("noteText");
const noteType = $("noteType");
const noteTarget = $("noteTarget");
const saveNoteBtn = $("saveNoteBtn");
const myNotes = $("myNotes");

const taskText = $("taskText");
const taskTarget = $("taskTarget");
const createTaskBtn = $("createTaskBtn");
const taskList = $("taskList");

const helpText = $("helpText");
const helpList = $("helpList");

const calcDisplay = $("calcDisplay");
const calcBtn = $("calcBtn");
const saveCalcBtn = $("saveCalcBtn");

const filesNotes = $("filesNotes");
const filesCalcs = $("filesCalcs");

/* Secretary Member */
const secSearch = $("secSearch");
const secFilterStatus = $("secFilterStatus");

const secName = $("secName");
const secJoinDate = $("secJoinDate");
const secStatus = $("secStatus");

const secLicense = $("secLicense");
const secLicenseDate = $("secLicenseDate");

const warn1 = $("warn1");
const warn2 = $("warn2");
const warnText = $("warnText");

const secSponsor = $("secSponsor");
const selfJoined = $("selfJoined");

const secNotes = $("secNotes");
const saveMemberObservation = $("saveMemberObservation");

const secEntries = $("secEntries");
const secDetail = $("secDetail");

const timelineDate = $("timelineDate");
const timelineRank = $("timelineRank");
const timelineText = $("timelineText");
const addTimelineEntry = $("addTimelineEntry");

/* Meetings */
const meetDate = $("meetDate");
const meetTitle = $("meetTitle");
const meetAgenda = $("meetAgenda");
const meetNotes = $("meetNotes");
const voteTopic = $("voteTopic");
const voteOptions = $("voteOptions");
const voteResult = $("voteResult");
const meetPersons = $("meetPersons");
const meetAttendees = $("meetAttendees");
const meetFollowups = $("meetFollowups");
const meetStatus = $("meetStatus");
const saveMeetingBtn = $("saveMeetingBtn");

/* ===================================================== */
/* UI BINDINGS (Buttons) */
/* ===================================================== */

function bindUI() {
  // LOGIN
  if (typeof loginBtn !== "undefined") {
    loginBtn.onclick = async () => {
      try {
        await signInWithEmailAndPassword(auth, email.value, password.value);
      } catch (e) {
        status.innerText = e.message;
      }
    };
  }

  // Base buttons
  if (typeof postInfoBtn !== "undefined") postInfoBtn.onclick = () => window.postInfo();
  if (typeof createRideBtn !== "undefined") createRideBtn.onclick = () => window.createRide();
  if (typeof saveNoteBtn !== "undefined") saveNoteBtn.onclick = () => window.saveNote();

  if (typeof calcBtn !== "undefined") calcBtn.onclick = () => window.calcResult();
  if (typeof saveCalcBtn !== "undefined") saveCalcBtn.onclick = () => window.saveCalculation();

  // Secretary extras (NEU) - immer per getElementById, damit es nie crasht
  const addAct = $("addMeetingActionBtn");
  if (addAct) addAct.onclick = () => addMeetingActionRow();

  const buildVote = $("buildVoteBoxBtn");
  if (buildVote) buildVote.onclick = () => buildVoteBox();

  const saveL = $("saveLetterBtn");
  if (saveL) saveL.onclick = () => saveLetter();

  const resetL = $("resetLetterBtn");
  if (resetL) resetL.onclick = () => resetLetterForm();

  const createBy = $("createBylawsBtn");
  if (createBy) createBy.onclick = () => createBylawsVersion();

  const saveArch = $("saveArchiveBtn");
  if (saveArch) saveArch.onclick = () => saveArchiveEntry();

  const dashR = $("secDashRefreshBtn");
  if (dashR) dashR.onclick = () => loadSecretaryDashboard();

  // Search hooks
  const secSearch = $("secSearch");
  if (secSearch) secSearch.oninput = () => renderSecretaryEntries();

  const meetSearch = $("meetSearch");
  if (meetSearch) meetSearch.oninput = () => renderMeetings();

  const letterSearch = $("letterSearch");
  if (letterSearch) letterSearch.oninput = () => renderLetters();

  const archiveSearch = $("archiveSearch");
  if (archiveSearch) archiveSearch.oninput = () => renderArchive();

  const secFilter = $("secFilterStatus");
  if (secFilter) secFilter.onchange = () => renderSecretaryEntries();

  const meetFilter = $("meetFilterStatus");
  if (meetFilter) meetFilter.onchange = () => renderMeetings();

  const letterFilter = $("letterFilter");
  if (letterFilter) letterFilter.onchange = () => renderLetters();

  const archiveFilter = $("archiveFilter");
  if (archiveFilter) archiveFilter.onchange = () => renderArchive();

  const lt = $("letterTemplate");
  if (lt) lt.onchange = () => applyLetterTemplate();
}

bindUI();

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
  const data = snap.data() || {};

  CURRENT_RANK = data.rank;

  rankLabel.innerText = data.rank || "-";
  userName.innerText = data.name || "-";
  points.innerText = data.rPoints || 0;

  applyRankRights(data.rank);

  // ✅ NEU: Users Cache laden (Namen/Ränge für Picklists)
  await loadUsersCache();

  loadInfos();
  loadRides();
  loadFiles();
  loadHelp();
  loadUsersForNotes();
  loadMyNotes();
  loadUsersForTasks();
  loadTasks();

  // ✅ Secretary: Picklists vorbereiten (wenn Tab geöffnet)
  prepareMeetingPicklists();
});

/* ===================================================== */
/* RANK RIGHTS */
/* ===================================================== */

function applyRankRights(rank) {
  if (["president", "vice_president", "sergeant_at_arms", "secretary"].includes(rank)) {
    postInfoBtn.classList.remove("hidden");
  }

  if (["president", "vice_president", "sergeant_at_arms", "road_captain"].includes(rank)) {
    createRideBtn.classList.remove("hidden");
  }
}

/* ===================================================== */
/* INFOSYSTEM */
/* ===================================================== */

async function loadInfos() {
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

async function loadRides() {
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

  await addDoc(collection(db, "notes"), {
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

async function loadFiles() {
  if (!$("filesNotes") || !$("filesCalcs")) return;

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

async function loadHelp() {
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
  document.querySelectorAll(".container").forEach(s => s.classList.add("hidden"));
  document.getElementById(id).classList.remove("hidden");
};

window.backHome = () => showScreen("homeScreen");

/* ===================================================== */
/* WARN INFO (INFOS TAB) */
/* ===================================================== */

window.toggleWarnInfo = () => {
  const box = $("warnInfoBox");
  if (!box) return;

  const rules = $("clubRulesBox");
  if (rules && !rules.classList.contains("hidden")) rules.classList.add("hidden");

  box.classList.toggle("hidden");
};

/* ===================================================== */
/* CLUB REGELN (INFOS TAB) */
/* ===================================================== */

window.toggleClubRules = () => {
  const box = $("clubRulesBox");
  if (!box) return;

  const warn = $("warnInfoBox");
  if (warn && !warn.classList.contains("hidden")) warn.classList.add("hidden");

  box.classList.toggle("hidden");
};

/* ===================================================== */
/* USERS FÜR NOTIZEN LADEN */
/* ===================================================== */

async function loadUsersForNotes() {
  if (!$("noteTarget")) return;

  noteTarget.innerHTML = `<option value="">Nur für mich speichern</option>`;

  const snaps = await getDocs(collection(db, "users"));

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

async function loadMyNotes() {
  if (!$("myNotes")) return;

  myNotes.innerHTML = "";

  const snaps = await getDocs(collection(db, "notes"));

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
        ${n.text || ""}
        ${deleteButton}
      </div>
    `;
  });
}

/* ===================================================== */
/* NOTIZ LÖSCHEN */
/* ===================================================== */

window.deleteNote = async (id) => {
  await deleteDoc(doc(db, "notes", id));
  loadMyNotes();
  loadFiles();
};

/* ===================================================== */
/* RANGRECHTE / SICHTBARKEIT */
/* ===================================================== */

function canViewAllNotes() {
  return [
    "president",
    "vice_president",
    "sergeant_at_arms",
    "secretary"
  ].includes(CURRENT_RANK);
}

function canDeleteNote(note) {
  if (canViewAllNotes()) return true;
  return note.from === CURRENT_UID;
}

/* ===================================================== */
/* TASK SYSTEM */
/* ===================================================== */

async function loadUsersForTasks() {
  if (!$("taskTarget")) return;

  taskTarget.innerHTML = `<option value="">An mich selbst</option>`;

  const snaps = await getDocs(collection(db, "users"));

  snaps.forEach(docSnap => {
    const data = docSnap.data();
    taskTarget.innerHTML += `
      <option value="${docSnap.id}">
        ${data.name}
      </option>
    `;
  });
}

if (typeof createTaskBtn !== "undefined") {
  createTaskBtn.onclick = async () => {
    if (!taskText.value) return;

    await addDoc(collection(db, "tasks"), {
      from: CURRENT_UID,
      to: taskTarget.value || CURRENT_UID,
      text: taskText.value,
      status: "open",
      time: Date.now()
    });

    taskText.value = "";

    loadTasks();
  };
}

async function loadTasks() {
  if (!$("taskList")) return;

  taskList.innerHTML = "";

  const snaps = await getDocs(collection(db, "tasks"));

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
      <div class="card task-${t.status || "open"}">
        ${t.text || ""}
        ${doneButton}
      </div>
    `;
  });
}

window.markTaskDone = async id => {
  await updateDoc(doc(db, "tasks", id), {
    status: "done"
  });
  loadTasks();
};

/* ===================================================== */
/* OFFICER & ADMIN RIGHTS ENGINE */
/* ===================================================== */

function isAdmin() {
  return CURRENT_RANK === "admin";
}

function hasOfficerRights() {
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

  const ref = doc(db, "users", targetUid);
  const snap = await getDoc(ref);

  const current = snap.data().rPoints || 0;

  await updateDoc(ref, {
    rPoints: current + Number(amount)
  });

  await addDoc(collection(db, "points_log"), {
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

function hasSecretaryRights() {
  return [
    "secretary",
    "president",
    "vice_president",
    "sergeant_at_arms",
    "admin"
  ].includes(CURRENT_RANK);
}

/* ===================================================== */
/* USERS CACHE (uid -> name/rank) */
/* ===================================================== */

let USERS_CACHE = new Map();

async function loadUsersCache() {
  USERS_CACHE.clear();
  const snaps = await getDocs(collection(db, "users"));
  snaps.forEach(d => {
    const u = d.data() || {};
    USERS_CACHE.set(d.id, { name: u.name || "Unbekannt", rank: u.rank || "member" });
  });
}

function userNameByUid(uid) {
  return USERS_CACHE.get(uid)?.name || uid || "-";
}
/* ===================================================== */
/* SECRETARY TABS (GLOBAL) */
/* ===================================================== */

window.secShow = (which) => {
  const tabs = [
    "secDashboard",
    "secMember",
    "secMeetings",
    "secLetters",
    "secBylaws",
    "secArchive"
  ];

  // hide all
  tabs.forEach(id => {
    const el = $(id);
    if (el) el.classList.add("hidden");
  });

  // show target
  const target = $(which);
  if (target) target.classList.remove("hidden");

  // auto loads per tab
  if (which === "secDashboard") loadSecretaryDashboard();
  if (which === "secMember") loadSecretaryEntries();
  if (which === "secMeetings") loadMeetings();
  if (which === "secLetters") loadLetters();
  if (which === "secBylaws") loadBylaws();
  if (which === "secArchive") loadArchive();
};

window.showSecretaryPanel = () => {
  if (!hasSecretaryRights()) {
    alert("Kein Zugriff");
    return;
  }

  showScreen("secretaryScreen");
  secShow("secDashboard");
};

/* ===================================================== */
/* SECRETARY: MEMBER OBSERVATION SAVE */
/* ===================================================== */

if (typeof saveMemberObservation !== "undefined") {
saveMemberObservation.onclick = async () => {

  if (!secName.value) return;

  await addDoc(collection(db,"member_observations"),{

    name: secName.value,
    joinDate: secJoinDate.value,

    // ✅ nur noch 1× Status
    status: secStatus.value,

    // ✅ Führerschein
    hasLicense: !!secLicense.checked,
    licenseCheckedAt: secLicenseDate.value,

    // ✅ Warns
    warn1: warn1.checked,
    warn2: warn2.checked,
    warnText: warnText.value,

    // ✅ Herkunft
    sponsor: selfJoined.checked ? "self_joined" : secSponsor.value,

    notes: secNotes.value,

    createdBy: CURRENT_UID,
    time: Date.now()
  });

  // reset
  secName.value = "";
  secJoinDate.value = "";
  secStatus.value = "member";

  secLicense.checked = false;
  secLicenseDate.value = "";

  warn1.checked = false;
  warn2.checked = false;
  warnText.value = "";

  secSponsor.value = "";
  selfJoined.checked = false;

  secNotes.value = "";

  loadSecretaryEntries();
};

/* ===================================================== */
/* SECRETARY: MEMBER LIST CACHE + FILTER */
/* ===================================================== */

let SECRETARY_ENTRIES_CACHE = [];

async function loadSecretaryEntries(){

  if (!document.getElementById("secEntries")) return;

  secEntries.innerHTML = "";

  const snaps = await getDocs(collection(db,"member_observations"));

  snaps.forEach(docSnap => {

    const e = docSnap.data();

    let warnClass = "";
    if (e.warn2) warnClass = "warn-w2";
    else if (e.warn1) warnClass = "warn-w1";

    const statusText = (e.status || e.startRank || "-");

    secEntries.innerHTML += `
      <div class="card sec-entry ${warnClass}"
           onclick="openMemberFile('${docSnap.id}')">
        <b>${e.name}</b><br>
        Status: ${statusText}<br>
        Warns: ${e.warn1 ? "W.1 " : ""}${e.warn2 ? "W.2" : ""}
      </div>
    `;
  });
}

  // newest first
  SECRETARY_ENTRIES_CACHE.sort((a, b) => (b.time || 0) - (a.time || 0));

  renderSecretaryEntries();
}

function renderSecretaryEntries() {
  if (!$("secEntries")) return;

  const search = ($("secSearch")?.value || "").trim().toLowerCase();
  const statusFilter = $("secFilterStatus")?.value || "";

  const list = SECRETARY_ENTRIES_CACHE.filter(e => {
    const status = (e.status || e.startRank || "").toLowerCase();
    if (statusFilter && status !== statusFilter) return false;

    if (!search) return true;

    const blob = [
      e.name,
      e.startRank,
      e.status,
      e.sponsor,
      e.notes,
      e.warnText,
      e.hasLicense ? "führerschein" : "",
      e.warn1 ? "warn1" : "",
      e.warn2 ? "warn2" : ""
    ].join(" ").toLowerCase();

    return blob.includes(search);
  });

  if (list.length === 0) {
    secEntries.innerHTML = `<div class="card">Keine passenden Einträge.</div>`;
    return;
  }

  secEntries.innerHTML = "";

  list.forEach(e => {
    let warnClass = "";
    if (e.warn2) warnClass = "warn-w2";
    else if (e.warn1) warnClass = "warn-w1";

    const status = e.status || e.startRank || "-";
    const license = e.hasLicense ? "✅" : "❌";
    const freeze = e.freezeUntil ? `Sperre bis: ${e.freezeUntil}` : "";

    secEntries.innerHTML += `
      <div class="card sec-entry ${warnClass}"
           onclick="openMemberFile('${e.id}')">

        <b>${e.name || "-"}</b><br>
        Status: ${status}<br>
        Führerschein: ${license}<br>
        Beitrag: ${e.contribution || "-"} €<br>
        ${freeze ? `<small>${freeze}</small><br>` : ""}
        Warns: ${e.warn1 ? "W.1 " : ""}${e.warn2 ? "W.2" : ""}
      </div>
    `;
  });
}

/* ===================================================== */
/* SECRETARY: DETAIL / TIMELINE / WARNS */
/* ===================================================== */

let CURRENT_MEMBER_DOC = null;

/* Akte öffnen */
window.openMemberFile = async (docId) => {
  CURRENT_MEMBER_DOC = docId;

  const snap = await getDoc(doc(db, "member_observations", docId));
  if (!snap.exists()) return alert("Nicht gefunden");

  const data = snap.data() || {};

  const statusText = (data.status || data.startRank || "-");
  const licenseText = data.hasLicense ? "✅ Ja" : "❌ Nein";
  const licenseDate = data.licenseCheckedAt || "-";

  // ✅ UI (Akte + Timeline + Warns) – alles als String
  secDetail.innerHTML = `
    <div class="card">
      <h4>${data.name || "-"}</h4>
      Mitglied seit: ${data.joinDate || "-"}<br>
      Status: ${statusText}<br>
      Führerschein: ${licenseText}<br>
      Geprüft am: ${licenseDate}<br>
      Sponsor: ${data.sponsor || "-"}<br><br>
      ${data.notes || ""}
    </div>

    <h4>Timeline</h4>
    <div id="timelineList"></div>

    <div class="card">
      <h4>⚠️ Warns (Detail)</h4>

      <div class="row">
        <input id="warnIssued" type="date">
        <select id="warnLevel">
          <option value="W1">W.S1</option>
          <option value="W2">W.S2</option>
        </select>
      </div>

      <textarea id="warnReason" placeholder="Grund / Details..."></textarea>

      <label class="checkline" for="warnActive">
        <input type="checkbox" id="warnActive" checked>
        Aktiv
      </label>

      <button type="button" id="saveWarnBtn">Warn speichern</button>

      <h4>Liste</h4>
      <div id="warnList"></div>
    </div>
  `;

  // ✅ Wichtig: erst NACH innerHTML, sonst gibt's die IDs noch nicht
  loadTimeline();
  loadWarns();

  const saveWarnBtn = document.getElementById("saveWarnBtn");
  if (saveWarnBtn) saveWarnBtn.onclick = saveWarnFromDetail;
};

/* =========================
   WARNS: Laden
========================= */
async function loadWarns() {
  if (!CURRENT_MEMBER_DOC) return;

  const warnList = document.getElementById("warnList");
  if (!warnList) return;

  warnList.innerHTML = "";

  const snaps = await getDocs(collection(
    db,
    "member_observations",
    CURRENT_MEMBER_DOC,
    "warns"
  ));

  if (snaps.empty) {
    warnList.innerHTML = `<div class="card">Keine Warns gespeichert.</div>`;
    return;
  }

  const items = [];
  snaps.forEach(d => items.push({ id: d.id, ...d.data() }));

  // Neueste zuerst
  items.sort((a, b) => (b.time || 0) - (a.time || 0));

  items.forEach(w => {
    const active = (w.active === true); // default false wenn nicht gesetzt
    warnList.innerHTML += `
      <div class="card ${active ? "warn-w2" : "task-done"}" style="margin-bottom:6px;">
        <b>${w.level || "-"}</b> – ${w.issued || "-"} ${active ? "" : "(erledigt)"}<br>
        ${w.reason || ""}
        <div style="margin-top:8px; display:flex; gap:8px; flex-wrap:wrap;">
          <button type="button" class="gray" onclick="toggleWarnActive('${w.id}', ${active ? "true" : "false"})">
            ${active ? "Als erledigt markieren" : "Wieder aktiv"}
          </button>
          <button type="button" class="danger" onclick="deleteWarn('${w.id}')">Löschen</button>
        </div>
      </div>
    `;
  });
}

/* =========================
   WARNS: Speichern
========================= */
async function saveWarnFromDetail() {
  if (!CURRENT_MEMBER_DOC) return alert("Erst Akte öffnen");

  const issuedEl = document.getElementById("warnIssued");
  const levelEl = document.getElementById("warnLevel");
  const reasonEl = document.getElementById("warnReason");
  const activeEl = document.getElementById("warnActive");

  const issued = issuedEl ? issuedEl.value : "";
  const level = levelEl ? levelEl.value : "W1";
  const reason = reasonEl ? reasonEl.value : "";
  const active = activeEl ? !!activeEl.checked : true;

  if (!issued) return alert("Bitte Datum wählen");
  if (!reason.trim()) return alert("Bitte Grund/Details eintragen");

  await addDoc(collection(
    db,
    "member_observations",
    CURRENT_MEMBER_DOC,
    "warns"
  ), {
    issued,
    level,
    reason,
    active,
    by: CURRENT_UID,
    time: Date.now()
  });

  // reset
  if (reasonEl) reasonEl.value = "";
  if (activeEl) activeEl.checked = true;

  loadWarns();
  loadSecretaryEntries(); // damit Liste oben Warn-Markierung aktuell bleibt
}

/* =========================
   WARNS: Aktiv/Erledigt
========================= */
window.toggleWarnActive = async (warnId, current) => {
  if (!CURRENT_MEMBER_DOC) return;

  await updateDoc(
    doc(db, "member_observations", CURRENT_MEMBER_DOC, "warns", warnId),
    { active: !current }
  );

  loadWarns();
  loadSecretaryEntries();
};

/* =========================
   WARNS: Löschen
========================= */
window.deleteWarn = async (warnId) => {
  if (!CURRENT_MEMBER_DOC) return;
  if (!confirm("Warn wirklich löschen?")) return;

  await deleteDoc(doc(db, "member_observations", CURRENT_MEMBER_DOC, "warns", warnId));

  loadWarns();
  loadSecretaryEntries();
};
