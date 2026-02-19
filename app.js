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

    const statusEl = $("secStatus");
    const licenseEl = $("secLicense");
    const licenseDateEl = $("secLicenseDate");
    const freezeEl = $("secFreezeUntil");

    await addDoc(collection(db, "member_observations"), {
      name: secName.value,
      joinDate: secJoinDate.value,
      startRank: secStartRank.value,

      // ✅ NEU
      status: statusEl ? statusEl.value : secStartRank.value,
      hasLicense: licenseEl ? !!licenseEl.checked : false,
      licenseCheckedAt: licenseDateEl ? licenseDateEl.value : "",
      freezeUntil: freezeEl ? freezeEl.value : "",

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

    if (statusEl) statusEl.value = "member";
    if (licenseEl) licenseEl.checked = false;
    if (licenseDateEl) licenseDateEl.value = "";
    if (freezeEl) freezeEl.value = "";

    loadSecretaryEntries();
  };
}

/* ===================================================== */
/* SECRETARY: MEMBER LIST CACHE + FILTER */
/* ===================================================== */

let SECRETARY_ENTRIES_CACHE = [];

async function loadSecretaryEntries() {
  if (!$("secEntries")) return;

  secEntries.innerHTML = `<div class="card">Lade...</div>`;
  SECRETARY_ENTRIES_CACHE = [];

  const snaps = await getDocs(collection(db, "member_observations"));

  snaps.forEach(docSnap => {
    const e = docSnap.data() || {};
    SECRETARY_ENTRIES_CACHE.push({
      id: docSnap.id,
      ...e
    });
  });

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

  const status = data.status || data.startRank || "-";
  const license = data.hasLicense ? "✅ Ja" : "❌ Nein";

  secDetail.innerHTML = `
    <div class="card">
      <h4>${data.name || "-"}</h4>
      Mitglied seit: ${data.joinDate || "-"}<br>
      Start Rang: ${data.startRank || "-"}<br>
      Status: ${status}<br>
      Führerschein: ${license}<br>
      ${data.licenseCheckedAt ? `Geprüft am: ${data.licenseCheckedAt}<br>` : ""}
      ${data.freezeUntil ? `<b>Rangsperre bis:</b> ${data.freezeUntil}<br>` : ""}
      Sponsor: ${data.sponsor || "-"}<br>
      Beitrag: ${data.contribution || "-"} €<br>
      <br>
      ${data.notes || ""}
    </div>

    <div class="card">
      <h4>⚠️ Warns (Detail)</h4>

      <div class="row">
        <input id="warnIssued" type="date" placeholder="Datum">
        <select id="warnLevel">
          <option value="W1">W.S1</option>
          <option value="W2">W.S2</option>
        </select>
      </div>

      <textarea id="warnReason" placeholder="Grund / Details"></textarea>

      <div class="row">
        <button class="smallbtn" onclick="addWarn()">➕ Warn hinzufügen</button>
        <button class="smallbtn gray" onclick="loadWarns()">🔄 Laden</button>
      </div>

      <div id="warnList"></div>
    </div>

    <div class="card">
      <h4>🗄️ Member-Archiv</h4>
      <button class="smallbtn" onclick="openArchiveLinkedToMember()">➕ Archiv-Eintrag für diese Akte</button>
      <div id="memberArchiveList"></div>
    </div>

    <h4>Timeline</h4>
    <div id="timelineList"></div>

    <div class="card">
      <h4>✏️ Bearbeiten (Pro)</h4>
      <input id="editName" placeholder="Name" value="${(data.name || "").replace(/"/g, "&quot;")}">
      <input id="editContribution" type="number" step="0.01" placeholder="Beitrag" value="${data.contribution || ""}">

      <label style="display:block;margin-top:6px;">
        <input type="checkbox" id="editWarn1" ${data.warn1 ? "checked" : ""}> W.1
      </label>
      <label style="display:block;margin-top:6px;">
        <input type="checkbox" id="editWarn2" ${data.warn2 ? "checked" : ""}> W.2
      </label>

      <label style="display:block;margin-top:6px;">
        <input type="checkbox" id="editHasLicense" ${data.hasLicense ? "checked" : ""}> Führerschein vorhanden
      </label>
      <input id="editLicenseCheckedAt" type="date" value="${data.licenseCheckedAt || ""}">
      <input id="editFreezeUntil" type="date" value="${data.freezeUntil || ""}">

      <select id="editStatus">
        <option value="supporter" ${status === "supporter" ? "selected" : ""}>Supporter</option>
        <option value="hangaround" ${status === "hangaround" ? "selected" : ""}>Hangaround</option>
        <option value="prospect" ${status === "prospect" ? "selected" : ""}>Prospect</option>
        <option value="member" ${status === "member" ? "selected" : ""}>Member</option>
      </select>

      <textarea id="editNotes" placeholder="Notizen">${data.notes || ""}</textarea>

      <div class="row">
        <button class="smallbtn" onclick="saveMemberFile()">💾 Speichern</button>
        <button class="smallbtn danger" onclick="deleteMemberFile()">🗑️ Löschen</button>
      </div>
    </div>
  `;

  loadTimeline();
  loadWarns();
  loadMemberArchive();
};

/* Timeline laden */

async function loadTimeline() {
  if (!CURRENT_MEMBER_DOC) return;

  const snaps = await getDocs(collection(
    db,
    "member_observations",
    CURRENT_MEMBER_DOC,
    "timeline"
  ));

  const container = $("timelineList");
  if (!container) return;

  container.innerHTML = "";

  snaps.forEach(docSnap => {
    const t = docSnap.data();
    container.innerHTML += `
      <div class="timeline-entry">
        <b>${t.date || "-"}</b> – ${t.rank || ""}<br>
        ${t.text || ""}
      </div>
    `;
  });
}

/* Timeline speichern */

if (typeof addTimelineEntry !== "undefined") {
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
    ), {
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
}

/* Warn hinzufügen */

window.addWarn = async () => {
  if (!CURRENT_MEMBER_DOC) return alert("Erst Akte öffnen");

  const issued = $("warnIssued")?.value;
  const level = $("warnLevel")?.value || "W1";
  const reason = $("warnReason")?.value || "";

  if (!issued) return alert("Datum fehlt");

  await addDoc(collection(
    db,
    "member_observations",
    CURRENT_MEMBER_DOC,
    "warns"
  ), {
    issued,
    level,
    reason,
    by: CURRENT_UID,
    time: Date.now(),
    active: true
  });

  const wr = $("warnReason");
  if (wr) wr.value = "";

  loadWarns();
};

window.loadWarns = async () => {
  if (!CURRENT_MEMBER_DOC) return;

  const list = $("warnList");
  if (!list) return;

  list.innerHTML = `<div class="card">Lade...</div>`;

  const snaps = await getDocs(
    query(
      collection(db, "member_observations", CURRENT_MEMBER_DOC, "warns"),
      orderBy("issued", "desc"),
      limit(50)
    )
  );

  if (snaps.empty) {
    list.innerHTML = `<div class="card">Keine Warn-Details gespeichert.</div>`;
    return;
  }

  list.innerHTML = "";

  snaps.forEach(d => {
    const w = d.data() || {};
    const lvlClass = w.level === "W2" ? "warn-w2" : "warn-w1";

    list.innerHTML += `
      <div class="card ${lvlClass}">
        <b>${w.level || "-"}</b> – ${w.issued || "-"}<br>
        ${w.reason || ""}<br>
        <small>von: ${userNameByUid(w.by)}</small><br><br>
        <button class="smallbtn gray" onclick="toggleWarnActive('${d.id}', ${w.active === false ? "false" : "true"})">
          Status: ${w.active === false ? "Erledigt" : "Aktiv"}
        </button>
        <button class="smallbtn danger" onclick="deleteWarn('${d.id}')">Löschen</button>
      </div>
    `;
  });
};

window.toggleWarnActive = async (warnId, current) => {
  if (!CURRENT_MEMBER_DOC) return;
  const next = current ? false : true;
  await updateDoc(doc(db, "member_observations", CURRENT_MEMBER_DOC, "warns", warnId), {
    active: next
  });
  loadWarns();
};

window.deleteWarn = async (warnId) => {
  if (!CURRENT_MEMBER_DOC) return;
  if (!confirm("Warn wirklich löschen?")) return;
  await deleteDoc(doc(db, "member_observations", CURRENT_MEMBER_DOC, "warns", warnId));
  loadWarns();
};

/* ===================================================== */
/* SECRETARY PROFI SYSTEM (Bearbeiten / Löschen) */
/* ===================================================== */

window.saveMemberFile = async () => {
  if (!CURRENT_MEMBER_DOC) return;

  const en = $("editName");
  const ec = $("editContribution");
  const ew1 = $("editWarn1");
  const ew2 = $("editWarn2");
  const es = $("editStatus");
  const ehl = $("editHasLicense");
  const elc = $("editLicenseCheckedAt");
  const efu = $("editFreezeUntil");
  const enotes = $("editNotes");

  await updateDoc(doc(db, "member_observations", CURRENT_MEMBER_DOC), {
    name: en ? en.value : "",
    contribution: ec ? ec.value : "",

    warn1: ew1 ? ew1.checked : false,
    warn2: ew2 ? ew2.checked : false,

    // ✅ NEU
    status: es ? es.value : "",
    hasLicense: ehl ? !!ehl.checked : false,
    licenseCheckedAt: elc ? elc.value : "",
    freezeUntil: efu ? efu.value : "",

    notes: enotes ? enotes.value : ""
  });

  alert("Gespeichert");

  loadSecretaryEntries();
  openMemberFile(CURRENT_MEMBER_DOC);
};

window.deleteMemberFile = async () => {
  if (!CURRENT_MEMBER_DOC) return;

  if (!confirm("Akte wirklich löschen?")) return;

  await deleteDoc(doc(db, "member_observations", CURRENT_MEMBER_DOC));

  CURRENT_MEMBER_DOC = null;
  secDetail.innerHTML = "";

  loadSecretaryEntries();
};
/* ===================================================== */
/* MEETINGS (BESPRECHUNGSVERLAUF) - ERWEITERT */
/* ===================================================== */

let EDIT_MEETING_ID = null;
let MEETINGS_CACHE = [];
let MEETING_ACTIONS = []; // temp editor state [{text,toUid,dueDate,taskId?}]

function resetMeetingForm() {
  EDIT_MEETING_ID = null;
  MEETING_ACTIONS = [];

  const idsClear = ["meetDate","meetTitle","meetAgenda","meetNotes","voteTopic","voteOptions","voteResult","meetPersons","meetAttendees","meetFollowups"];
  idsClear.forEach(id => { const el = $(id); if (el) el.value = ""; });

  const ms = $("meetStatus");
  if (ms) ms.value = "open";

  const vb = $("voteBox");
  if (vb) vb.innerHTML = "";

  const al = $("meetActionsList");
  if (al) al.innerHTML = "";

  // uncheck picklists
  ["meetAttendanceBox", "meetAbsentExcusedBox", "meetAbsentUnexcusedBox"].forEach(id => {
    const box = $(id);
    if (!box) return;
    box.querySelectorAll("input[type=checkbox]").forEach(ch => ch.checked = false);
  });

  const smb = $("saveMeetingBtn");
  if (smb) smb.textContent = "Besprechung speichern";
}

function prepareMeetingPicklists() {
  const presentBox = $("meetAttendanceBox");
  const excusedBox = $("meetAbsentExcusedBox");
  const unexcusedBox = $("meetAbsentUnexcusedBox");

  if (!presentBox || !excusedBox || !unexcusedBox) return;

  const users = [...USERS_CACHE.entries()].map(([uid, u]) => ({ uid, ...u }))
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));

  const row = (uid, name) => `
    <label class="pickitem">
      <input type="checkbox" data-uid="${uid}">
      <span>${name}</span>
    </label>
  `;

  presentBox.innerHTML = users.map(u => row(u.uid, u.name)).join("");
  excusedBox.innerHTML = users.map(u => row(u.uid, u.name)).join("");
  unexcusedBox.innerHTML = users.map(u => row(u.uid, u.name)).join("");

  const hook = () => syncMeetingAttendanceText();
  [presentBox, excusedBox, unexcusedBox].forEach(box => {
    box.querySelectorAll("input[type=checkbox]").forEach(ch => ch.onchange = hook);
  });
}

function getCheckedUids(boxId) {
  const box = $(boxId);
  if (!box) return [];
  const uids = [];
  box.querySelectorAll("input[type=checkbox]").forEach(ch => {
    if (ch.checked) uids.push(ch.getAttribute("data-uid"));
  });
  return uids;
}

function setCheckedUids(boxId, uids) {
  const box = $(boxId);
  if (!box) return;
  const set = new Set(uids || []);
  box.querySelectorAll("input[type=checkbox]").forEach(ch => {
    const uid = ch.getAttribute("data-uid");
    ch.checked = set.has(uid);
  });
}

function syncMeetingAttendanceText() {
  const out = $("meetAttendees");
  if (!out) return;

  const present = getCheckedUids("meetAttendanceBox").map(userNameByUid);
  const excused = getCheckedUids("meetAbsentExcusedBox").map(userNameByUid);
  const unexcused = getCheckedUids("meetAbsentUnexcusedBox").map(userNameByUid);

  const lines = [];
  if (present.length) lines.push("Anwesend: " + present.join(", "));
  if (excused.length) lines.push("Abwesend (entschuldigt): " + excused.join(", "));
  if (unexcused.length) lines.push("Abwesend (unentschuldigt): " + unexcused.join(", "));

  out.value = lines.join(" | ");
}

/* ✅ Action Items UI */

function addMeetingActionRow(prefill = null) {
  const list = $("meetActionsList");
  if (!list) return;

  const idx = MEETING_ACTIONS.length;
  MEETING_ACTIONS.push({
    text: prefill?.text || "",
    toUid: prefill?.toUid || CURRENT_UID,
    dueDate: prefill?.dueDate || "",
    taskId: prefill?.taskId || null
  });

  list.innerHTML += `
    <div class="card" id="actRow${idx}">
      <input id="actText${idx}" placeholder="Aufgabe (Text)" value="${(prefill?.text || "").replace(/"/g, "&quot;")}">
      <select id="actTo${idx}"></select>
      <input id="actDue${idx}" type="date" value="${prefill?.dueDate || ""}">
      <div class="row">
        <button class="smallbtn danger" type="button" onclick="removeActionRow(${idx})">Entfernen</button>
      </div>
    </div>
  `;

  const sel = $(`actTo${idx}`);
  if (!sel) return;

  const users = [...USERS_CACHE.entries()].map(([uid, u]) => ({ uid, ...u }))
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));

  sel.innerHTML = users.map(u => `<option value="${u.uid}">${u.name}</option>`).join("");
  sel.value = prefill?.toUid || CURRENT_UID;

  const t = $(`actText${idx}`);
  const d = $(`actDue${idx}`);

  if (t) t.oninput = () => MEETING_ACTIONS[idx].text = t.value;
  sel.onchange = () => MEETING_ACTIONS[idx].toUid = sel.value;
  if (d) d.onchange = () => MEETING_ACTIONS[idx].dueDate = d.value;

  MEETING_ACTIONS[idx].text = t ? t.value : "";
  MEETING_ACTIONS[idx].toUid = sel.value;
  MEETING_ACTIONS[idx].dueDate = d ? d.value : "";
}

window.removeActionRow = (idx) => {
  if (MEETING_ACTIONS[idx]) MEETING_ACTIONS[idx].removed = true;
  const row = $(`actRow${idx}`);
  if (row) row.style.display = "none";
};

/* ✅ Voting box helper */

function buildVoteBox() {
  const vb = $("voteBox");
  if (!vb) return;

  const presentUids = getCheckedUids("meetAttendanceBox");
  if (!presentUids.length) {
    vb.innerHTML = `<div class="card">Bitte zuerst Teilnehmer "Anwesend" auswählen.</div>`;
    return;
  }

  vb.innerHTML = `
    <div class="card">
      <b>Stimmen (optional)</b><br>
      <small>Trage pro Person eine Stimme ein (z.B. Ja/Nein/A/B/C).</small>
      <div id="voteRows"></div>
      <button class="smallbtn" type="button" onclick="calcVoteResultFromRows()">Ergebnis berechnen</button>
    </div>
  `;

  const rows = $("voteRows");
  rows.innerHTML = presentUids.map(uid => `
    <div class="pickitem">
      <span style="flex:1">${userNameByUid(uid)}</span>
      <input style="width:120px" data-uid="${uid}" placeholder="Stimme">
    </div>
  `).join("");
}

window.calcVoteResultFromRows = () => {
  const vb = $("voteBox");
  if (!vb) return;

  const inputs = vb.querySelectorAll("input[data-uid]");
  const counts = new Map();

  inputs.forEach(inp => {
    const v = (inp.value || "").trim();
    if (!v) return;
    counts.set(v, (counts.get(v) || 0) + 1);
  });

  if (counts.size === 0) {
    alert("Keine Stimmen eingetragen");
    return;
  }

  const parts = [...counts.entries()].map(([k, n]) => `${n} ${k}`);
  const vr = $("voteResult");
  if (vr) vr.value = parts.join(" / ");
};

/* Load + render meetings */

async function loadMeetings() {
  const list = $("meetingList");
  if (!list) return;

  list.innerHTML = `<div class="card">Lade...</div>`;
  MEETINGS_CACHE = [];

  const snaps = await getDocs(
    query(collection(db, "meetings"), orderBy("date", "desc"), limit(50))
  );

  snaps.forEach(docSnap => {
    MEETINGS_CACHE.push({ id: docSnap.id, ...docSnap.data() });
  });

  renderMeetings();
}

function renderMeetings() {
  const list = $("meetingList");
  if (!list) return;

  const search = ($("meetSearch")?.value || "").trim().toLowerCase();
  const statusFilter = $("meetFilterStatus")?.value || "";

  let items = [...MEETINGS_CACHE];

  if (statusFilter) items = items.filter(m => (m.status || "open") === statusFilter);

  if (search) {
    items = items.filter(m => {
      const blob = [
        m.date, m.title, m.agenda, m.notes, m.voteTopic, m.voteOptions, m.voteResult,
        m.persons, m.attendees, m.followups
      ].join(" ").toLowerCase();
      return blob.includes(search);
    });
  }

  if (items.length === 0) {
    list.innerHTML = `<div class="card">Noch keine passenden Protokolle.</div>`;
    return;
  }

  list.innerHTML = "";

  items.forEach(m => {
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

        <button onclick="editMeeting('${m.id}')">Bearbeiten</button>
        <button onclick="deleteMeeting('${m.id}')">Löschen</button>
        <button onclick="toggleMeetingStatus('${m.id}', '${m.status || "open"}')">
          Status: ${m.status === "done" ? "Erledigt" : "Offen"}
        </button>
        <button class="smallbtn gray" onclick="openArchiveLinkedToMeeting('${m.id}')">🗄️ Archiv verknüpfen</button>
      </div>
    `;
  });
}

/* Save */

const saveMeetingBtnEl = $("saveMeetingBtn");
if (saveMeetingBtnEl) {
  saveMeetingBtnEl.onclick = async () => {
    if (!hasSecretaryRights()) {
      alert("Kein Zugriff");
      return;
    }

    const md = $("meetDate");
    const mt = $("meetTitle");
    if (!md?.value || !mt?.value) {
      alert("Datum und Titel sind Pflicht");
      return;
    }

    const ma = $("meetAgenda");
    const mn = $("meetNotes");
    const vt = $("voteTopic");
    const vo = $("voteOptions");
    const vr = $("voteResult");
    const mp = $("meetPersons");
    const matt = $("meetAttendees");
    const mf = $("meetFollowups");
    const ms = $("meetStatus");

    // Attendance arrays
    const attendance = {
      present: getCheckedUids("meetAttendanceBox"),
      absentExcused: getCheckedUids("meetAbsentExcusedBox"),
      absentUnexcused: getCheckedUids("meetAbsentUnexcusedBox")
    };

    // Actions cleanup
    const actions = MEETING_ACTIONS
      .filter(a => a && !a.removed)
      .map(a => ({
        text: a.text || "",
        toUid: a.toUid || CURRENT_UID,
        dueDate: a.dueDate || "",
        taskId: a.taskId || null
      }))
      .filter(a => a.text.trim().length > 0);

    const payload = {
      date: md.value,
      title: mt.value,
      agenda: ma ? ma.value : "",
      notes: mn ? mn.value : "",

      voteTopic: vt ? vt.value : "",
      voteOptions: vo ? vo.value : "",
      voteResult: vr ? vr.value : "",

      persons: mp ? mp.value : "",
      attendees: matt ? matt.value : "",
      followups: mf ? mf.value : "",

      status: ms ? ms.value : "open",

      attendance,
      actions,

      createdBy: CURRENT_UID,
      time: Date.now()
    };

    let meetingId = EDIT_MEETING_ID;

    if (EDIT_MEETING_ID) {
      await updateDoc(doc(db, "meetings", EDIT_MEETING_ID), payload);
    } else {
      const ref = await addDoc(collection(db, "meetings"), payload);
      meetingId = ref.id;
    }

    // ✅ Create/Update tasks from action-items
    for (let i = 0; i < actions.length; i++) {
      const a = actions[i];

      if (!a.taskId) {
        const tRef = await addDoc(collection(db, "tasks"), {
          from: CURRENT_UID,
          to: a.toUid,
          text: `[Meeting ${md.value}] ${a.text}`,
          status: "open",
          dueDate: a.dueDate || "",
          meetingId: meetingId,
          time: Date.now()
        });
        a.taskId = tRef.id;
      } else {
        const tDoc = await getDoc(doc(db, "tasks", a.taskId));
        const existing = tDoc.exists() ? tDoc.data() : {};
        await updateDoc(doc(db, "tasks", a.taskId), {
          to: a.toUid,
          text: `[Meeting ${md.value}] ${a.text}`,
          dueDate: a.dueDate || "",
          meetingId: meetingId,
          status: existing.status || "open"
        });
      }
    }

    await updateDoc(doc(db, "meetings", meetingId), { actions });

    resetMeetingForm();
    await loadMeetings();
    loadTasks();
  };
}

/* Edit */

window.editMeeting = async (id) => {
  if (!hasSecretaryRights()) return;

  const snap = await getDoc(doc(db, "meetings", id));
  if (!snap.exists()) return alert("Nicht gefunden");

  const m = snap.data() || {};
  EDIT_MEETING_ID = id;

  const setVal = (id2, v) => { const el = $(id2); if (el) el.value = v || ""; };

  setVal("meetDate", m.date);
  setVal("meetTitle", m.title);
  setVal("meetAgenda", m.agenda);
  setVal("meetNotes", m.notes);

  setVal("voteTopic", m.voteTopic);
  setVal("voteOptions", m.voteOptions);
  setVal("voteResult", m.voteResult);

  setVal("meetPersons", m.persons);
  setVal("meetAttendees", m.attendees);
  setVal("meetFollowups", m.followups);

  setVal("meetStatus", m.status || "open");

  prepareMeetingPicklists();
  setCheckedUids("meetAttendanceBox", m.attendance?.present || []);
  setCheckedUids("meetAbsentExcusedBox", m.attendance?.absentExcused || []);
  setCheckedUids("meetAbsentUnexcusedBox", m.attendance?.absentUnexcused || []);
  syncMeetingAttendanceText();

  MEETING_ACTIONS = [];
  const list = $("meetActionsList");
  if (list) list.innerHTML = "";
  (m.actions || []).forEach(a => addMeetingActionRow(a));

  const smb = $("saveMeetingBtn");
  if (smb) smb.textContent = "✅ Änderungen speichern";

  secShow("secMeetings");
};

window.deleteMeeting = async (id) => {
  if (!hasSecretaryRights()) return;
  if (!confirm("Besprechung wirklich löschen?")) return;

  await deleteDoc(doc(db, "meetings", id));
  await loadMeetings();
};

window.toggleMeetingStatus = async (id, current) => {
  if (!hasSecretaryRights()) return;
  const next = current === "done" ? "open" : "done";
  await updateDoc(doc(db, "meetings", id), { status: next });
  await loadMeetings();
};
/* ===================================================== */
/* LETTERS (SCHRIFTVERKEHR) */
/* ===================================================== */

let EDIT_LETTER_ID = null;
let LETTERS_CACHE = [];

function resetLetterForm() {
  EDIT_LETTER_ID = null;
  const setVal = (id, v) => { const el = $(id); if (el) el.value = v; };
  setVal("letterTemplate", "");
  setVal("letterTo", "");
  setVal("letterSubject", "");
  setVal("letterBody", "");
  setVal("letterStatus", "draft");
}

function applyLetterTemplate() {
  const t = $("letterTemplate")?.value || "";
  if (!t) return;

  const subj = $("letterSubject");
  const body = $("letterBody");

  const subjEmpty = !subj?.value;
  const bodyEmpty = !body?.value;

  if (t === "invite") {
    if (subj && subjEmpty) subj.value = "Einladung";
    if (body && bodyEmpty) body.value = "Hallo,\n\nhiermit laden wir euch herzlich zu unserem Treffen / Run ein.\n\nDatum:\nOrt:\nUhrzeit:\n\nMit freundlichen Grüßen\n";
  }

  if (t === "warning") {
    if (subj && subjEmpty) subj.value = "Hinweis / Verwarnung";
    if (body && bodyEmpty) body.value = "Hallo,\n\nhiermit dokumentieren wir folgenden Vorfall:\n\n- Datum:\n- Ort:\n- Beschreibung:\n\nBitte beachten:\n\nMit freundlichen Grüßen\n";
  }

  if (t === "confirm") {
    if (subj && subjEmpty) subj.value = "Bestätigung";
    if (body && bodyEmpty) body.value = "Hallo,\n\nhiermit bestätigen wir:\n\n...\n\nMit freundlichen Grüßen\n";
  }

  if (t === "reply") {
    if (subj && subjEmpty) subj.value = "Antwort";
    if (body && bodyEmpty) body.value = "Hallo,\n\ndanke für deine Nachricht. Hier unsere Rückmeldung:\n\n...\n\nMit freundlichen Grüßen\n";
  }
}

async function saveLetter() {
  if (!hasSecretaryRights()) return alert("Kein Zugriff");

  const toEl = $("letterTo");
  const subEl = $("letterSubject");
  const bodyEl = $("letterBody");
  const statusEl = $("letterStatus");
  const tplEl = $("letterTemplate");

  if (!toEl?.value || !subEl?.value) {
    alert("Empfänger und Betreff sind Pflicht");
    return;
  }

  const payload = {
    to: toEl.value,
    subject: subEl.value,
    body: bodyEl ? bodyEl.value : "",
    status: statusEl ? statusEl.value : "draft",
    template: tplEl ? tplEl.value : "",
    createdBy: CURRENT_UID,
    time: Date.now()
  };

  if (EDIT_LETTER_ID) {
    await updateDoc(doc(db, "letters", EDIT_LETTER_ID), payload);
  } else {
    await addDoc(collection(db, "letters"), payload);
  }

  resetLetterForm();
  loadLetters();
}

async function loadLetters() {
  const list = $("lettersList");
  if (!list) return;

  list.innerHTML = `<div class="card">Lade...</div>`;
  LETTERS_CACHE = [];

  const snaps = await getDocs(query(collection(db, "letters"), orderBy("time", "desc"), limit(100)));
  snaps.forEach(d => LETTERS_CACHE.push({ id: d.id, ...d.data() }));

  renderLetters();
}

function renderLetters() {
  const list = $("lettersList");
  if (!list) return;

  const search = ($("letterSearch")?.value || "").trim().toLowerCase();
  const filter = $("letterFilter")?.value || "";

  let items = [...LETTERS_CACHE];
  if (filter) items = items.filter(l => (l.status || "draft") === filter);

  if (search) {
    items = items.filter(l => {
      const blob = [l.to, l.subject, l.body, l.status].join(" ").toLowerCase();
      return blob.includes(search);
    });
  }

  if (items.length === 0) {
    list.innerHTML = `<div class="card">Keine Einträge.</div>`;
    return;
  }

  list.innerHTML = "";

  items.forEach(l => {
    list.innerHTML += `
      <div class="card">
        <b>${(l.status || "draft").toUpperCase()}</b> – ${l.subject || "-"}<br>
        <small>an: ${l.to || "-"}</small><br><br>
        ${((l.body || "").slice(0, 350)).replace(/\n/g, "<br>")}
        ${((l.body || "").length > 350) ? "<br><small>...</small>" : ""}
        <br><br>
        <button onclick="editLetter('${l.id}')">Bearbeiten</button>
        <button class="danger" onclick="deleteLetter('${l.id}')">Löschen</button>
      </div>
    `;
  });
}

window.editLetter = async (id) => {
  if (!hasSecretaryRights()) return;

  const snap = await getDoc(doc(db, "letters", id));
  if (!snap.exists()) return alert("Nicht gefunden");

  const l = snap.data() || {};
  EDIT_LETTER_ID = id;

  const setVal = (id2, v) => { const el = $(id2); if (el) el.value = v || ""; };
  setVal("letterTemplate", l.template);
  setVal("letterTo", l.to);
  setVal("letterSubject", l.subject);
  setVal("letterBody", l.body);
  setVal("letterStatus", l.status || "draft");

  secShow("secLetters");
};

window.deleteLetter = async (id) => {
  if (!hasSecretaryRights()) return;
  if (!confirm("Letter wirklich löschen?")) return;

  await deleteDoc(doc(db, "letters", id));
  loadLetters();
};

/* ===================================================== */
/* BYLAWS / STATUTEN (Versionierung) */
/* ===================================================== */

let BYLAWS_CACHE = [];

async function loadBylaws() {
  const activeInfo = $("bylawsActiveInfo");
  const list = $("bylawsList");
  if (!activeInfo || !list) return;

  activeInfo.innerHTML = "Lade...";
  list.innerHTML = `<div class="card">Lade...</div>`;
  BYLAWS_CACHE = [];

  const snaps = await getDocs(query(collection(db, "bylaws"), orderBy("time", "desc"), limit(50)));
  snaps.forEach(d => BYLAWS_CACHE.push({ id: d.id, ...d.data() }));

  const active = BYLAWS_CACHE.find(x => x.active === true) || null;

  if (!active) {
    activeInfo.innerHTML = "Keine aktive Version.";
  } else {
    activeInfo.innerHTML = `<b>${active.title || "Bylaws"}</b><br><small>${new Date(active.time || 0).toLocaleString()}</small>`;
  }

  renderBylaws();
}

function renderBylaws() {
  const list = $("bylawsList");
  if (!list) return;

  if (BYLAWS_CACHE.length === 0) {
    list.innerHTML = `<div class="card">Noch keine Versionen.</div>`;
    return;
  }

  list.innerHTML = "";

  BYLAWS_CACHE.forEach(b => {
    list.innerHTML += `
      <div class="card">
        <b>${b.title || "-"}</b>
        ${b.active ? `<span class="badge">AKTIV</span>` : ""}<br>
        <small>${new Date(b.time || 0).toLocaleString()}</small><br><br>
        ${(b.reason || "").replace(/\n/g, "<br>")}<br><br>

        <button class="smallbtn gray" onclick="previewBylaws('${b.id}')">Ansehen</button>
        <button class="smallbtn" onclick="setActiveBylaws('${b.id}')">Aktiv setzen</button>
        <button class="smallbtn danger" onclick="deleteBylaws('${b.id}')">Löschen</button>
      </div>
    `;
  });
}

window.previewBylaws = async (id) => {
  const snap = await getDoc(doc(db, "bylaws", id));
  if (!snap.exists()) return alert("Nicht gefunden");
  const b = snap.data() || {};
  alert((b.title || "Bylaws") + "\n\n" + (b.text || ""));
};

async function createBylawsVersion() {
  if (!hasSecretaryRights()) return alert("Kein Zugriff");

  const title = $("bylawsTitle");
  const text = $("bylawsText");
  const reason = $("bylawsReason");

  if (!title?.value || !text?.value) return alert("Titel und Text sind Pflicht");

  const activeSnap = await getDocs(query(collection(db, "bylaws"), where("active", "==", true), limit(1)));
  for (const d of activeSnap.docs) {
    await updateDoc(doc(db, "bylaws", d.id), { active: false });
  }

  await addDoc(collection(db, "bylaws"), {
    title: title.value,
    text: text.value,
    reason: reason ? reason.value : "",
    active: true,
    createdBy: CURRENT_UID,
    time: Date.now()
  });

  title.value = "";
  text.value = "";
  if (reason) reason.value = "";

  loadBylaws();
}

window.setActiveBylaws = async (id) => {
  if (!hasSecretaryRights()) return;

  const activeSnap = await getDocs(query(collection(db, "bylaws"), where("active", "==", true), limit(1)));
  for (const d of activeSnap.docs) {
    await updateDoc(doc(db, "bylaws", d.id), { active: false });
  }

  await updateDoc(doc(db, "bylaws", id), { active: true });
  loadBylaws();
};

window.deleteBylaws = async (id) => {
  if (!hasSecretaryRights()) return;
  if (!confirm("Bylaws-Version wirklich löschen?")) return;

  await deleteDoc(doc(db, "bylaws", id));
  loadBylaws();
};

/* ===================================================== */
/* ARCHIV */
/* ===================================================== */

let ARCHIVE_CACHE = [];
let PENDING_ARCHIVE_LINK = { memberId: null, meetingId: null };

window.openArchiveLinkedToMember = () => {
  if (!CURRENT_MEMBER_DOC) return;

  PENDING_ARCHIVE_LINK = { memberId: CURRENT_MEMBER_DOC, meetingId: null };

  const cat = $("archCategory");
  const tit = $("archTitle");
  const lm = $("archLinkMember");
  const lme = $("archLinkMeeting");

  if (cat) cat.value = "member";
  if (tit) tit.value = `Akte: ${($("secDetail")?.querySelector("h4")?.innerText || "").trim()}`;
  if (lm) lm.checked = true;
  if (lme) lme.checked = false;

  secShow("secArchive");
};

window.openArchiveLinkedToMeeting = (meetingId) => {
  PENDING_ARCHIVE_LINK = { memberId: null, meetingId: meetingId || EDIT_MEETING_ID || null };

  const cat = $("archCategory");
  const tit = $("archTitle");
  const lm = $("archLinkMember");
  const lme = $("archLinkMeeting");

  if (cat) cat.value = "meeting";
  if (tit) tit.value = `Meeting Archiv (${meetingId || EDIT_MEETING_ID || ""})`;
  if (lm) lm.checked = false;
  if (lme) lme.checked = true;

  secShow("secArchive");
};

async function saveArchiveEntry() {
  if (!hasSecretaryRights()) return alert("Kein Zugriff");

  const title = $("archTitle");
  const category = $("archCategory");
  const tags = $("archTags");
  const url = $("archUrl");
  const linkMember = $("archLinkMember");
  const linkMeeting = $("archLinkMeeting");

  if (!title?.value) return alert("Titel ist Pflicht");

  let memberId = null;
  let meetingId = null;

  if (linkMember?.checked && CURRENT_MEMBER_DOC) memberId = CURRENT_MEMBER_DOC;
  if (linkMeeting?.checked) meetingId = EDIT_MEETING_ID || PENDING_ARCHIVE_LINK.meetingId || null;

  memberId = memberId || PENDING_ARCHIVE_LINK.memberId || null;
  meetingId = meetingId || PENDING_ARCHIVE_LINK.meetingId || null;

  await addDoc(collection(db, "archive"), {
    title: title.value,
    category: category ? category.value : "other",
    tags: (tags ? tags.value : "").split(",").map(x => x.trim()).filter(Boolean),
    url: url ? url.value : "",
    memberId,
    meetingId,
    createdBy: CURRENT_UID,
    time: Date.now()
  });

  title.value = "";
  if (tags) tags.value = "";
  if (url) url.value = "";
  if (linkMember) linkMember.checked = false;
  if (linkMeeting) linkMeeting.checked = false;

  PENDING_ARCHIVE_LINK = { memberId: null, meetingId: null };

  loadArchive();
  loadMemberArchive();
}

async function loadArchive() {
  const list = $("archiveList");
  if (!list) return;

  list.innerHTML = `<div class="card">Lade...</div>`;
  ARCHIVE_CACHE = [];

  const snaps = await getDocs(query(collection(db, "archive"), orderBy("time", "desc"), limit(200)));
  snaps.forEach(d => ARCHIVE_CACHE.push({ id: d.id, ...d.data() }));

  renderArchive();
}

function renderArchive() {
  const list = $("archiveList");
  if (!list) return;

  const search = ($("archiveSearch")?.value || "").trim().toLowerCase();
  const filter = $("archiveFilter")?.value || "";

  let items = [...ARCHIVE_CACHE];
  if (filter) items = items.filter(a => (a.category || "other") === filter);

  if (search) {
    items = items.filter(a => {
      const blob = [
        a.title, a.category, (a.tags || []).join(" "), a.url, a.memberId, a.meetingId
      ].join(" ").toLowerCase();
      return blob.includes(search);
    });
  }

  if (items.length === 0) {
    list.innerHTML = `<div class="card">Keine Einträge.</div>`;
    return;
  }

  list.innerHTML = "";

  items.forEach(a => {
    const tags = (a.tags || []).map(t => `<span class="badge">${t}</span>`).join(" ");
    const link = a.url ? `<a href="${a.url}" target="_blank" style="color:orange;">Link öffnen</a>` : "";
    const rel = [
      a.memberId ? `Member: ${a.memberId}` : "",
      a.meetingId ? `Meeting: ${a.meetingId}` : ""
    ].filter(Boolean).join(" | ");

    list.innerHTML += `
      <div class="card">
        <b>${a.title || "-"}</b> <span class="badge">${(a.category || "other").toUpperCase()}</span><br>
        <small>${new Date(a.time || 0).toLocaleString()}</small><br>
        ${rel ? `<small>${rel}</small><br>` : ""}
        ${tags ? `<div style="margin-top:6px;">${tags}</div>` : ""}
        ${link ? `<div style="margin-top:8px;">${link}</div>` : ""}

        <button class="smallbtn danger" onclick="deleteArchiveEntry('${a.id}')">Löschen</button>
      </div>
    `;
  });
}

window.deleteArchiveEntry = async (id) => {
  if (!hasSecretaryRights()) return;
  if (!confirm("Archiv-Eintrag wirklich löschen?")) return;

  await deleteDoc(doc(db, "archive", id));
  loadArchive();
  loadMemberArchive();
};

async function loadMemberArchive() {
  const box = $("memberArchiveList");
  if (!box) return;

  if (!CURRENT_MEMBER_DOC) {
    box.innerHTML = `<div class="card">Keine Akte geöffnet.</div>`;
    return;
  }

  box.innerHTML = `<div class="card">Lade...</div>`;

  // ✅ Ohne orderBy, damit KEIN Index gebraucht wird
  const snaps = await getDocs(query(
    collection(db, "archive"),
    where("memberId", "==", CURRENT_MEMBER_DOC),
    limit(50)
  ));

  const items = [];
  snaps.forEach(d => items.push({ id: d.id, ...d.data() }));
  items.sort((a, b) => (b.time || 0) - (a.time || 0));
  const top = items.slice(0, 10);

  if (top.length === 0) {
    box.innerHTML = `<div class="card">Keine Archiv-Einträge für diese Akte.</div>`;
    return;
  }

  box.innerHTML = "";
  top.forEach(a => {
    box.innerHTML += `
      <div class="card">
        <b>${a.title || "-"}</b><br>
        <small>${new Date(a.time || 0).toLocaleString()}</small><br>
        ${(a.tags || []).map(t => `<span class="badge">${t}</span>`).join(" ")}
        ${a.url ? `<div style="margin-top:6px;"><a href="${a.url}" target="_blank" style="color:orange;">Link öffnen</a></div>` : ""}
      </div>
    `;
  });
}

/* ===================================================== */
/* SECRETARY DASHBOARD */
/* ===================================================== */

async function loadSecretaryDashboard() {
  const tEl = $("secDashTasks");
  const mEl = $("secDashMeetings");
  const wEl = $("secDashWarnings");
  const lEl = $("secDashLetters");
  const aEl = $("secDashArchive");

  if (!tEl || !mEl || !wEl || !lEl || !aEl) return;

  tEl.innerText = "Offene Tasks: ...";
  mEl.innerText = "Offene Meetings: ...";
  wEl.innerText = "Aktive Warns: ...";
  lEl.innerText = "Entwürfe: ...";
  aEl.innerText = "Archiv Einträge: ...";

  try {
    const tSnaps = await getDocs(query(collection(db, "tasks"), where("status", "==", "open")));
    tEl.innerText = `Offene Tasks: ${tSnaps.size}`;
  } catch {
    tEl.innerText = "Offene Tasks: (Fehler)";
  }

  try {
    const mSnaps = await getDocs(query(collection(db, "meetings"), where("status", "==", "open")));
    mEl.innerText = `Offene Meetings: ${mSnaps.size}`;
  } catch {
    mEl.innerText = "Offene Meetings: (Fehler)";
  }

  try {
    const lSnaps = await getDocs(query(collection(db, "letters"), where("status", "==", "draft")));
    lEl.innerText = `Entwürfe: ${lSnaps.size}`;
  } catch {
    lEl.innerText = "Entwürfe: (Fehler)";
  }

  try {
    const aSnaps = await getDocs(query(collection(db, "archive"), limit(200)));
    aEl.innerText = `Archiv Einträge: ${aSnaps.size}${aSnaps.size === 200 ? "+" : ""}`;
  } catch {
    aEl.innerText = "Archiv Einträge: (Fehler)";
  }

  // Active warns (best effort)
  try {
    const memSnaps = await getDocs(query(collection(db, "member_observations"), limit(50)));
    const members = [];
    memSnaps.forEach(d => members.push(d.id));

    let activeCount = 0;
    await Promise.all(members.map(async mid => {
      const wSnaps = await getDocs(query(
        collection(db, "member_observations", mid, "warns"),
        where("active", "==", true),
        limit(50)
      ));
      activeCount += wSnaps.size;
    }));

    wEl.innerText = `Aktive Warns: ${activeCount}${members.length === 50 ? "+" : ""}`;
  } catch {
    wEl.innerText = "Aktive Warns: (Fehler)";
  }
}
