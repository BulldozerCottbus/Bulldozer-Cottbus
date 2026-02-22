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
  limit,
  deleteField
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

/* ===================================================== */
/* HELPERS / DOM */
/* ===================================================== */

const $ = (id) => document.getElementById(id);

function setText(id, txt) {
  const el = $(id);
  if (el) el.innerText = txt;
}

function escapeAttr(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/* ===================================================== */
/* TREASURY HELPERS (DATE / EXEMPT) */
/* ===================================================== */

function treas_isValidISODate(v) {
  const s = String(v || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

// akzeptiert nur YYYY-MM-DD, alles andere => ""
function treas_normISODate(v) {
  const s = String(v || "").trim();
  return treas_isValidISODate(s) ? s : "";
}

// Hangaround + Supporter zahlen nichts
function treas_isDuesExempt(member) {
  const st = String(member?.status || member?.rank || "").toLowerCase().trim();
  return st === "hangaround" || st === "supporter";
}

// Monate von Eintrittsmonat bis reportMonth (YYYY-MM) inkl.
function monthsOwedFromJoin(joinISO, reportMonth) {
  if (!isValidISODate(joinISO)) return 0;
  const rm = String(reportMonth || "").trim();
  if (!/^\d{4}-\d{2}$/.test(rm)) return 0;

  const [jy, jm] = joinISO.split("-").slice(0, 2).map(Number);
  const [ry, rmo] = rm.split("-").map(Number);

  if (!jy || !jm || !ry || !rmo) return 0;

  const diff = (ry - jy) * 12 + (rmo - jm);
  return diff >= 0 ? (diff + 1) : 0;
}

// Monat-Name -> Nummer (de/en) (für Checkbox-Modelle)
function monthKeyToNum(key) {
  const k = String(key || "").toLowerCase().trim();

  const map = {
    jan: 1, januar: 1, january: 1,
    feb: 2, februar: 2, february: 2,
    mar: 3, maerz: 3, märz: 3, march: 3,
    apr: 4, april: 4,
    mai: 5, may: 5,
    jun: 6, juni: 6, june: 6,
    jul: 7, juli: 7, july: 7,
    aug: 8, august: 8,
    sep: 9, sept: 9, september: 9,
    okt: 10, october: 10, oktober: 10,
    nov: 11, november: 11,
    dez: 12, december: 12, dezember: 12
  };

  if (map[k]) return map[k];

  // auch "01","02" etc zulassen
  if (/^\d{1,2}$/.test(k)) {
    const n = Number(k);
    return n >= 1 && n <= 12 ? n : null;
  }
  return null;
}

// Ist-Betrag robust ermitteln (egal wie du es speicherst)
function calcPaidAmountFromMember(member, perMonthTotal, reportMonth) {
  // 1) Wenn du irgendwo einen fertigen Betrag speicherst:
  const numericKeys = ["paidTotal", "paid", "ist", "paidAmount", "amountPaid"];
  for (const k of numericKeys) {
    if (member && member[k] != null && member[k] !== "") {
      const n = Number(member[k]);
      if (!Number.isNaN(n)) return n;
    }
  }

  // 2) Wenn du Checkboxen speicherst (Objekt oder Array):
  // Varianten:
  // - member.paidMonths = { januar:true, februar:false, ... }
  // - member.monthsPaid = { "2026-01":true, "2026-02":true }
  // - member.paidMonths = ["2026-01","2026-02"]
  const rm = String(reportMonth || "").trim();
  const rmMonthNum = /^\d{4}-\d{2}$/.test(rm) ? Number(rm.split("-")[1]) : 12;

  // Objekt-Variante
  const obj = (member && (member.monthsPaid || member.paidMonths || member.months)) || null;
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    let count = 0;
    for (const [key, val] of Object.entries(obj)) {
      if (!val) continue;

      // key kann "2026-01" sein
      if (/^\d{4}-\d{2}$/.test(key)) {
        // nur bis reportMonth zählen (wenn reportMonth gesetzt)
        if (!/^\d{4}-\d{2}$/.test(rm) || key <= rm) count++;
        continue;
      }

      // key kann "januar" sein
      const mn = monthKeyToNum(key);
      if (mn && mn <= rmMonthNum) count++;
    }
    return count * Number(perMonthTotal || 0);
  }

  // Array-Variante
  if (Array.isArray(obj)) {
    let count = 0;
    obj.forEach((key) => {
      if (!key) return;
      const s = String(key).trim();
      if (/^\d{4}-\d{2}$/.test(s)) {
        if (!/^\d{4}-\d{2}$/.test(rm) || s <= rm) count++;
      } else {
        const mn = monthKeyToNum(s);
        if (mn && mn <= rmMonthNum) count++;
      }
    });
    return count * Number(perMonthTotal || 0);
  }

  return 0;
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (m) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"
  }[m]));
}
/* ===================================================== */
/* GLOBAL STATE */
/* ===================================================== */

let CURRENT_UID = null;
let CURRENT_RANK = null;

/* Secretary */
let CURRENT_MEMBER_DOC = null;

/* Users cache (uid -> {name, rank}) */
let USERS_CACHE = new Map();

/* Secretary caches */
let SECRETARY_ENTRIES_CACHE = [];

/* Meetings */
let EDIT_MEETING_ID = null;
let MEETINGS_CACHE = [];
let MEETING_ACTIONS = []; // [{text,toUid,dueDate,taskId?, removed?}]

/* Letters */
let EDIT_LETTER_ID = null;
let LETTERS_CACHE = [];

/* Bylaws */
let BYLAWS_CACHE = [];

/* Archive */
let ARCHIVE_CACHE = [];
let PENDING_ARCHIVE_LINK = { memberId: null, meetingId: null };

/* Treasury */
let TREASURY_REPORTS_CACHE = [];
let EDIT_TREAS_REPORT_ID = null;

let TREASURY_MEMBERS_CACHE = [];
let EDIT_TREAS_MEMBER_ID = null;
let TREAS_MEMBER_MODAL_READONLY = false;

/* INFO */
let EDIT_INFO_ID = null;

/* ===================================================== */
/* AUTH / LOGIN */
/* ===================================================== */

function bindLogin() {
  const loginBtn = $("loginBtn");
  const email = $("email");
  const password = $("password");
  const status = $("status");

  if (!loginBtn) return;

  loginBtn.onclick = async () => {
    try {
      await signInWithEmailAndPassword(auth, email.value, password.value);
      if (status) status.innerText = "";
    } catch (e) {
      if (status) status.innerText = e.message;
    }
  };
}

bindLogin();

window.logout = async () => {
  await signOut(auth);
  // UI zurücksetzen
  const loginScreen = $("loginScreen");
  const homeScreen = $("homeScreen");
  const topBar = $("topBar");
  if (loginScreen) loginScreen.classList.remove("hidden");
  if (homeScreen) homeScreen.classList.add("hidden");
  if (topBar) topBar.classList.add("hidden");
};

/* ===================================================== */
/* NAVIGATION */
/* ===================================================== */

window.showScreen = (id) => {
  document.querySelectorAll(".container").forEach(s => s.classList.add("hidden"));
  const target = $(id);
  if (target) target.classList.remove("hidden");
};

window.backHome = () => window.showScreen("homeScreen");

/* ===================================================== */
/* RANK RIGHTS */
/* ===================================================== */

function isAdmin() {
  return CURRENT_RANK === "admin";
}

function hasOfficerRights() {
  return ["president", "vice_president", "sergeant_at_arms"].includes(CURRENT_RANK) || isAdmin();
}

function hasSecretaryRights() {
  return ["secretary", "president", "vice_president", "sergeant_at_arms", "admin"].includes(CURRENT_RANK);
}

function hasTreasuryAccess() {
  // darf den Treasurer Screen öffnen (ansehen)
  return ["president", "vice_president", "sergeant_at_arms", "treasurer", "admin"].includes(CURRENT_RANK);
}

function isTreasurerOnly() {
  // NUR Treasurer darf erstellen/bearbeiten/löschen
  return ["treasurer", "admin"].includes(CURRENT_RANK);
}

function canViewAllNotes() {
  // wie vorher: Führung + Secretary
  return ["president", "vice_president", "sergeant_at_arms", "secretary", "admin"].includes(CURRENT_RANK);
}

  // ✅ Infos: jeder eingeloggte darf posten (Popup)
  if (postInfoBtn) {
    postInfoBtn.classList.remove("hidden");
  }

  if (createRideBtn) {
    if (["president", "vice_president", "sergeant_at_arms", "road_captain", "admin"].includes(rank)) {
      createRideBtn.classList.remove("hidden");
    } else {
      createRideBtn.classList.add("hidden");
    }
  }
}

/* ===================================================== */
/* SESSION */
/* ===================================================== */

onAuthStateChanged(auth, async (user) => {
  const loginScreen = $("loginScreen");
  const homeScreen = $("homeScreen");
  const topBar = $("topBar");

  if (!user) {
    CURRENT_UID = null;
    CURRENT_RANK = null;
    if (loginScreen) loginScreen.classList.remove("hidden");
    if (homeScreen) homeScreen.classList.add("hidden");
    if (topBar) topBar.classList.add("hidden");
    return;
  }

  CURRENT_UID = user.uid;

  if (loginScreen) loginScreen.classList.add("hidden");
  if (homeScreen) homeScreen.classList.remove("hidden");
  if (topBar) topBar.classList.remove("hidden");

  const snap = await getDoc(doc(db, "users", user.uid));
  const data = snap.exists() ? (snap.data() || {}) : {};

  CURRENT_RANK = data.rank || "member";

  setText("rankLabel", data.rank || "-");
  setText("userName", data.name || "-");
  setText("points", data.rPoints || 0);

  applyRankRights(CURRENT_RANK);

  // Users cache für Picklists
  await loadUsersCache();

  // Base loads
  await Promise.allSettled([
    loadInfos(),
    loadRides(),
    loadFiles(),
    loadHelp(),
    loadUsersForNotes(),
    loadMyNotes(),
    loadUsersForTasks(),
    loadTasks()
  ]);

  // Meetings Picklists vorbereiten (falls Tab geöffnet wird)
  prepareMeetingPicklists();

  // UI bindings
  bindUI();
});

/* ===================================================== */
/* UI BINDINGS */
/* ===================================================== */

function bindUI() {
  // Infos
    const postInfoBtn = $("postInfoBtn");
  if (postInfoBtn) postInfoBtn.onclick = () => window.openInfoModal();
    // Info Modal
  const infoSave = $("infoModalSaveBtn");
  if (infoSave) infoSave.onclick = () => saveInfoModal();

  const infoDel = $("infoModalDeleteBtn");
  if (infoDel) infoDel.onclick = () => {
    if (EDIT_INFO_ID) window.deleteInfo(EDIT_INFO_ID);
  };

  // Rides
  const createRideBtn = $("createRideBtn");
  if (createRideBtn) createRideBtn.onclick = () => window.createRide();

  // Notes
  const saveNoteBtn = $("saveNoteBtn");
  if (saveNoteBtn) saveNoteBtn.onclick = () => window.saveNote();

  // Calc
  const calcBtn = $("calcBtn");
  if (calcBtn) calcBtn.onclick = () => window.calcResult();

  const saveCalcBtn = $("saveCalcBtn");
  if (saveCalcBtn) saveCalcBtn.onclick = () => window.saveCalculation();

  // Tasks
  const createTaskBtn = $("createTaskBtn");
  if (createTaskBtn) createTaskBtn.onclick = () => window.createTask();

  // Secretary
  const saveMemberObservation = $("saveMemberObservation");
  if (saveMemberObservation) saveMemberObservation.onclick = () => window.saveMemberObservation();

  const addTimelineEntry = $("addTimelineEntry");
  if (addTimelineEntry) addTimelineEntry.onclick = () => window.addTimelineEntry();

  // Meetings extras
  const addAct = $("addMeetingActionBtn");
  if (addAct) addAct.onclick = () => addMeetingActionRow();

  const buildVote = $("buildVoteBoxBtn");
  if (buildVote) buildVote.onclick = () => buildVoteBox();

  const saveMeetingBtn = $("saveMeetingBtn");
  if (saveMeetingBtn) saveMeetingBtn.onclick = () => saveMeeting();

  // Searches / Filters
  const secSearch = $("secSearch");
  if (secSearch) secSearch.oninput = () => renderSecretaryEntries();

  const secFilter = $("secFilterStatus");
  if (secFilter) secFilter.onchange = () => renderSecretaryEntries();

  const meetSearch = $("meetSearch");
  if (meetSearch) meetSearch.oninput = () => renderMeetings();

  const meetFilter = $("meetFilterStatus");
  if (meetFilter) meetFilter.onchange = () => renderMeetings();

  const letterSearch = $("letterSearch");
  if (letterSearch) letterSearch.oninput = () => renderLetters();

  const letterFilter = $("letterFilter");
  if (letterFilter) letterFilter.onchange = () => renderLetters();

  const lt = $("letterTemplate");
  if (lt) lt.onchange = () => applyLetterTemplate();

  const saveLetterBtn = $("saveLetterBtn");
  if (saveLetterBtn) saveLetterBtn.onclick = () => saveLetter();

  const resetLetterBtn = $("resetLetterBtn");
  if (resetLetterBtn) resetLetterBtn.onclick = () => resetLetterForm();

  const createBylawsBtn = $("createBylawsBtn");
  if (createBylawsBtn) createBylawsBtn.onclick = () => createBylawsVersion();

  const saveArch = $("saveArchiveBtn");
  if (saveArch) saveArch.onclick = () => saveArchiveEntry();

  const dashR = $("secDashRefreshBtn");
  if (dashR) dashR.onclick = () => loadSecretaryDashboard();

  const archiveSearch = $("archiveSearch");
  if (archiveSearch) archiveSearch.oninput = () => renderArchive();

  const archiveFilter = $("archiveFilter");
  if (archiveFilter) archiveFilter.onchange = () => renderArchive();
  
  // Treasury
  const treasDashRefresh = $("treasDashRefreshBtn");
  if (treasDashRefresh) treasDashRefresh.onclick = () => loadTreasuryDashboard();

  const saveTR = $("saveTreasReportBtn");
  if (saveTR) saveTR.onclick = () => saveTreasuryReport();

  const resetTR = $("resetTreasReportBtn");
  if (resetTR) resetTR.onclick = () => resetTreasuryReportForm();

  const addM = $("treasAddMemberBtn");
  if (addM) addM.onclick = () => openTreasuryMemberModal(null);

  const mSearch = $("treasMemberSearch");
  if (mSearch) mSearch.oninput = () => renderTreasuryMembers();

  const treasMonth = $("treasMonth");
  if (treasMonth) treasMonth.onchange = () => onTreasuryMonthChanged();

  const autoChk = $("treasAutoSollIst");
  if (autoChk) autoChk.onchange = () => onTreasuryMonthChanged();

  const cashSoll = $("treasCashSoll");
  const cashIst = $("treasCashIst");
  if (cashSoll) cashSoll.oninput = () => updateTreasCashDiff();
  if (cashIst) cashIst.oninput = () => updateTreasCashDiff();

  const churchBtn = $("treasChurchBtn");
  if (churchBtn) churchBtn.onclick = () => generateChurchReportFromSelectedMonth();

  const churchCopyBtn = $("treasChurchCopyBtn");
  if (churchCopyBtn) churchCopyBtn.onclick = () => copyChurchReport();

  const tmSoll = $("tmSollTotal");
  const tmIst = $("tmIstTotal");
  if (tmSoll) tmSoll.oninput = () => updateMemberRest();
  if (tmIst) tmIst.oninput = () => updateMemberRest();

  const tmSave = $("tmSaveBtn");
  if (tmSave) tmSave.onclick = () => saveTreasuryMember();

  const tmDel = $("tmDeleteBtn");
  if (tmDel) tmDel.onclick = () => deleteTreasuryMember();
}

/* ===================================================== */
/* USERS CACHE */
/* ===================================================== */

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
/* INFOS (Popup + Ablauf + Edit/Delete Rechte) */
/* ===================================================== */

window.openInfoModal = async (infoId = null) => {
  const modal = $("infoModal");
  const title = $("infoModalTitle");
  const text = $("infoModalText");
  const exp = $("infoModalExpiry");
  const del = $("infoModalDeleteBtn");

  if (!modal || !title || !text || !exp || !del) return;

  EDIT_INFO_ID = infoId || null;

  if (!infoId) {
    title.innerText = "Info posten";
    text.value = "";
    exp.value = "keep";
    del.classList.add("hidden");
    modal.classList.remove("hidden");
    return;
  }

  // Edit Mode: laden
  try {
    const snap = await getDoc(doc(db, "infos", infoId));
    if (!snap.exists()) return alert("Info nicht gefunden");

    const d = snap.data() || {};
    title.innerText = "Info bearbeiten";
    text.value = d.text || "";

    // Ablauf-Auswahl aus expiresAt ableiten
    const hasExpiry = !!d.expiresAt;
    exp.value = hasExpiry ? "24h" : "keep";

    // Delete Button nur, wenn ich darf (Owner oder Officer)
    const can = hasOfficerRights() || d.createdBy === CURRENT_UID;
    if (can) del.classList.remove("hidden");
    else del.classList.add("hidden");

    modal.classList.remove("hidden");
  } catch (e) {
    alert("Fehler: " + e.message);
  }
};

window.closeInfoModal = () => {
  const modal = $("infoModal");
  if (modal) modal.classList.add("hidden");
  EDIT_INFO_ID = null;
};

async function saveInfoModal() {
  const text = $("infoModalText")?.value?.trim() || "";
  const exp = $("infoModalExpiry")?.value || "keep";
  if (!text) return alert("Text fehlt");

  const expiresAt = exp === "24h" ? (Date.now() + 24 * 60 * 60 * 1000) : null;

  try {
    if (!EDIT_INFO_ID) {
      // Create
      await addDoc(collection(db, "infos"), {
        text,
        createdBy: CURRENT_UID,
        time: Date.now(),
        expiresAt: expiresAt
      });
    } else {
      // Update (nur Owner/Officer erlaubt – Rules!)
      const patch = {
        text,
        editedAt: Date.now(),
        editedBy: CURRENT_UID
      };

      if (expiresAt) {
        patch.expiresAt = expiresAt;
      } else {
        patch.expiresAt = deleteField();
      }

      await updateDoc(doc(db, "infos", EDIT_INFO_ID), patch);
    }

    window.closeInfoModal();
    loadInfos();
  } catch (e) {
    // ✅ jetzt siehst du den echten Fehler (z.B. Rechte)
    alert("Speichern fehlgeschlagen: " + e.message);
  }
}

window.editInfo = (id) => window.openInfoModal(id);

window.deleteInfo = async (id) => {
  try {
    const snap = await getDoc(doc(db, "infos", id));
    if (!snap.exists()) return;

    const d = snap.data() || {};
    const can = hasOfficerRights() || d.createdBy === CURRENT_UID;
    if (!can) return alert("Keine Berechtigung");

    if (!confirm("Info wirklich löschen?")) return;

    await deleteDoc(doc(db, "infos", id));
    window.closeInfoModal();
    loadInfos();
  } catch (e) {
    alert("Löschen fehlgeschlagen: " + e.message);
  }
};

async function loadInfos() {
  const infosList = $("infosList");
  if (!infosList) return;

  infosList.innerHTML = `<div class="card">Lade...</div>`;

  try {
    const snaps = await getDocs(
      query(collection(db, "infos"), orderBy("time", "desc"), limit(200))
    );

    if (snaps.empty) {
      infosList.innerHTML = `<div class="card">Noch keine Infos.</div>`;
      return;
    }

    const now = Date.now();
    infosList.innerHTML = "";

    for (const ds of snaps.docs) {
      const d = ds.data() || {};
      const id = ds.id;

      // ✅ Ablauf: abgelaufene Infos nicht anzeigen
      if (d.expiresAt && Number(d.expiresAt) < now) {
        // Best-effort Cleanup: Officer oder Ersteller räumt auf
        const canCleanup = hasOfficerRights() || d.createdBy === CURRENT_UID;
        if (canCleanup) {
          try { await deleteDoc(doc(db, "infos", id)); } catch {}
        }
        continue;
      }

      const canEdit = hasOfficerRights() || d.createdBy === CURRENT_UID;

      const when = d.time ? new Date(d.time).toLocaleString() : "";
      const author = d.createdBy ? userNameByUid(d.createdBy) : "-";
      const expiryTxt = d.expiresAt ? ` | läuft ab: ${new Date(d.expiresAt).toLocaleString()}` : "";

      infosList.innerHTML += `
        <div class="card">
          <div style="opacity:.85;font-size:12px;margin-bottom:6px;">
            von: ${escapeHtml(author)} | ${escapeHtml(when)}${expiryTxt}
          </div>
          <div>${escapeHtml(d.text || "")}</div>

          ${canEdit ? `
            <div class="row" style="margin-top:10px;">
              <button class="smallbtn gray" type="button" onclick="editInfo('${id}')">Bearbeiten</button>
              <button class="smallbtn danger" type="button" onclick="deleteInfo('${id}')">Löschen</button>
            </div>
          ` : ``}
        </div>
      `;
    }

    if (!infosList.innerHTML.trim()) {
      infosList.innerHTML = `<div class="card">Keine aktiven Infos (evtl. abgelaufen).</div>`;
    }

  } catch (e) {
    infosList.innerHTML = `<div class="card">Fehler beim Laden: ${escapeHtml(e.message)}</div>`;
  }
}

/* ===================================================== */
/* RIDES */
/* ===================================================== */

async function loadRides() {
  const ridesList = $("ridesList");
  if (!ridesList) return;

  ridesList.innerHTML = "";
  const snaps = await getDocs(collection(db, "rides"));

  snaps.forEach(docSnap => {
    const r = docSnap.data() || {};
    ridesList.innerHTML += `
      <div class="card priority${r.priority || ""}">
        (${r.priority || "-"}) ${r.text || ""}
      </div>
    `;
  });
}

window.createRide = async () => {
  const rideText = $("rideText");
  const ridePriority = $("ridePriority");
  if (!rideText?.value) return;

  await addDoc(collection(db, "rides"), {
    text: rideText.value,
    priority: ridePriority ? ridePriority.value : "1",
    time: Date.now()
  });

  rideText.value = "";
  loadRides();
};

/* ===================================================== */
/* NOTES */
/* ===================================================== */

async function loadUsersForNotes() {
  const noteTarget = $("noteTarget");
  if (!noteTarget) return;

  noteTarget.innerHTML = `<option value="">Nur für mich speichern</option>`;

  const snaps = await getDocs(collection(db, "users"));
  snaps.forEach(docSnap => {
    const u = docSnap.data() || {};
    noteTarget.innerHTML += `<option value="${docSnap.id}">${u.name || "-"}</option>`;
  });
}

window.saveNote = async () => {
  const noteText = $("noteText");
  const noteType = $("noteType");
  const noteTarget = $("noteTarget");
  if (!noteText?.value) return;

  const target = noteTarget?.value || CURRENT_UID;
  const type = noteType?.value || "privat";

  await addDoc(collection(db, "notes"), {
    from: CURRENT_UID,
    to: target || CURRENT_UID,
    text: noteText.value,
    type,
    time: Date.now()
  });

  noteText.value = "";
  loadFiles();
  loadMyNotes();
};

async function fetchNotesVisible() {
  if (canViewAllNotes()) {
    const all = await getDocs(collection(db, "notes"));
    return all.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  // sonst: nur meine (from/to) – zwei queries, merge ohne doppelte
  const sent = await getDocs(query(collection(db, "notes"), where("from", "==", CURRENT_UID)));
  const recv = await getDocs(query(collection(db, "notes"), where("to", "==", CURRENT_UID)));

  const map = new Map();
  sent.forEach(d => map.set(d.id, { id: d.id, ...d.data() }));
  recv.forEach(d => map.set(d.id, { id: d.id, ...d.data() }));

  return [...map.values()];
}

async function loadMyNotes() {
  const myNotes = $("myNotes");
  if (!myNotes) return;

  myNotes.innerHTML = "";

  let notes = [];
  try {
    notes = await fetchNotesVisible();
  } catch (e) {
    myNotes.innerHTML = `<div class="card">Fehler beim Laden (Rechte?): ${e.message}</div>`;
    return;
  }

  notes.sort((a, b) => (b.time || 0) - (a.time || 0));

  notes.forEach(n => {
    const canDelete = canViewAllNotes() || n.from === CURRENT_UID;
    const delBtn = canDelete ? `<button type="button" onclick="deleteNote('${n.id}')">Löschen</button>` : "";
    myNotes.innerHTML += `
      <div class="card note-${n.type || "privat"}">
        <b>${(n.type || "privat").toUpperCase()}</b><br>
        ${n.text || ""}
        ${delBtn}
      </div>
    `;
  });
}

window.deleteNote = async (id) => {
  await deleteDoc(doc(db, "notes", id));
  loadMyNotes();
  loadFiles();
};

/* ===================================================== */
/* TASKS */
/* ===================================================== */

async function loadUsersForTasks() {
  const taskTarget = $("taskTarget");
  if (!taskTarget) return;

  taskTarget.innerHTML = `<option value="">An mich selbst</option>`;

  const snaps = await getDocs(collection(db, "users"));
  snaps.forEach(docSnap => {
    const u = docSnap.data() || {};
    taskTarget.innerHTML += `<option value="${docSnap.id}">${u.name || "-"}</option>`;
  });
}

window.createTask = async () => {
  const taskText = $("taskText");
  const taskTarget = $("taskTarget");
  if (!taskText?.value) return;

  await addDoc(collection(db, "tasks"), {
    from: CURRENT_UID,
    to: taskTarget?.value || CURRENT_UID,
    text: taskText.value,
    status: "open",
    time: Date.now()
  });

  taskText.value = "";
  loadTasks();
};

async function fetchTasksVisible() {
  if (hasSecretaryRights()) {
    const all = await getDocs(collection(db, "tasks"));
    return all.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  const sent = await getDocs(query(collection(db, "tasks"), where("from", "==", CURRENT_UID)));
  const recv = await getDocs(query(collection(db, "tasks"), where("to", "==", CURRENT_UID)));

  const map = new Map();
  sent.forEach(d => map.set(d.id, { id: d.id, ...d.data() }));
  recv.forEach(d => map.set(d.id, { id: d.id, ...d.data() }));

  return [...map.values()];
}

async function loadTasks() {
  const taskList = $("taskList");
  if (!taskList) return;

  taskList.innerHTML = "";

  let tasks = [];
  try {
    tasks = await fetchTasksVisible();
  } catch (e) {
    taskList.innerHTML = `<div class="card">Fehler beim Laden (Rechte?): ${e.message}</div>`;
    return;
  }

  tasks.sort((a, b) => (b.time || 0) - (a.time || 0));

  tasks.forEach(t => {
    taskList.innerHTML += `
      <div class="card task-${t.status || "open"}">
        ${t.text || ""}
        <button type="button" onclick="markTaskDone('${t.id}')">Erledigt</button>
      </div>
    `;
  });
}

window.markTaskDone = async (id) => {
  await updateDoc(doc(db, "tasks", id), { status: "done" });
  loadTasks();
};

/* ===================================================== */
/* FILES (NOTES + CALCS) */
/* ===================================================== */

async function loadFiles() {
  const filesNotes = $("filesNotes");
  const filesCalcs = $("filesCalcs");
  if (!filesNotes || !filesCalcs) return;

  filesNotes.innerHTML = "";
  filesCalcs.innerHTML = "";

  // Notes: gesendet + empfangen
  const sentSnaps = await getDocs(query(collection(db, "notes"), where("from", "==", CURRENT_UID)));
  const receivedSnaps = await getDocs(query(collection(db, "notes"), where("to", "==", CURRENT_UID)));

  const map = new Map();
  sentSnaps.forEach(d => map.set(d.id, d));
  receivedSnaps.forEach(d => map.set(d.id, d));

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

  // Calcs: nur eigene
  const calcsSnap = await getDocs(query(collection(db, "calculations"), where("uid", "==", CURRENT_UID)));
  const calcs = [];
  calcsSnap.forEach(d => calcs.push(d.data() || {}));
  calcs.sort((a, b) => (b.time || 0) - (a.time || 0));

  if (calcs.length === 0) {
    filesCalcs.innerHTML = `<div class="card">Keine Rechnungen gespeichert.</div>`;
  } else {
    calcs.forEach(c => {
      filesCalcs.innerHTML += `<div class="card">${c.calc || ""}</div>`;
    });
  }
}

/* ===================================================== */
/* CALC */
/* ===================================================== */

window.calcResult = () => {
  const calcDisplay = $("calcDisplay");
  if (!calcDisplay) return;
  try {
    calcDisplay.value = Function("return " + calcDisplay.value)();
  } catch {
    alert("Rechenfehler");
  }
};

window.saveCalculation = async () => {
  const calcDisplay = $("calcDisplay");
  if (!calcDisplay) return;

  await addDoc(collection(db, "calculations"), {
    uid: CURRENT_UID,
    calc: calcDisplay.value,
    time: Date.now()
  });

  loadFiles();
};

/* ===================================================== */
/* HELP */
/* ===================================================== */

async function loadHelp() {
  const helpList = $("helpList");
  if (!helpList) return;

  helpList.innerHTML = "";
  const snaps = await getDocs(collection(db, "help_requests"));
  snaps.forEach(d => {
    const h = d.data() || {};
    helpList.innerHTML += `<div class="card">${h.text || ""}</div>`;
  });
}

window.createHelp = async () => {
  const helpText = $("helpText");
  if (!helpText?.value) return;

  await addDoc(collection(db, "help_requests"), {
    uid: CURRENT_UID,
    text: helpText.value,
    time: Date.now()
  });

  helpText.value = "";
  loadHelp();
};

/* ===================================================== */
/* OFFICER: POINTS */
/* ===================================================== */

window.addPoints = async (targetUid, amount) => {
  if (!hasOfficerRights()) {
    alert("Keine Berechtigung");
    return;
  }

  const ref = doc(db, "users", targetUid);
  const snap = await getDoc(ref);
  const current = (snap.exists() ? (snap.data()?.rPoints || 0) : 0);

  await updateDoc(ref, { rPoints: current + Number(amount) });

  await addDoc(collection(db, "points_log"), {
    targetUid,
    amount: Number(amount),
    by: CURRENT_UID,
    time: Date.now()
  });

  alert("Punkte vergeben");
};

/* ===================================================== */
/* SECRETARY: TABS / PANEL */
/* ===================================================== */

window.secShow = (which) => {
  const tabs = ["secDashboard", "secMember", "secMeetings", "secLetters", "secBylaws", "secArchive"];

  tabs.forEach(id => {
    const el = $(id);
    if (el) el.classList.add("hidden");
  });

  const target = $(which);
  if (target) target.classList.remove("hidden");

  // Lazy load pro Tab
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

  window.showScreen("secretaryScreen");
  window.secShow("secDashboard");
};

/* ===================================================== */
/* SECRETARY: MEMBER OBSERVATIONS (SAVE) */
/* ===================================================== */

window.saveMemberObservation = async () => {
  if (!hasSecretaryRights()) return alert("Kein Zugriff");

  const name = $("secName")?.value?.trim();
  if (!name) return alert("Name fehlt");

  const joinDate = $("secJoinDate")?.value || "";
  const status = $("secStatus")?.value || "member";

  const hasLicense = !!$("secLicense")?.checked;
  const licenseCheckedAt = $("secLicenseDate")?.value || "";

  const warn1 = !!$("warn1")?.checked;
  const warn2 = !!$("warn2")?.checked;
  const warnText = $("warnText")?.value || "";

  const selfJoined = !!$("selfJoined")?.checked;
  const sponsor = selfJoined ? "self_joined" : ($("secSponsor")?.value || "");

  const notes = $("secNotes")?.value || "";

  await addDoc(collection(db, "member_observations"), {
    name,
    joinDate,
    status,
    hasLicense,
    licenseCheckedAt,

    warn1,
    warn2,
    warnText,

    sponsor,
    notes,

    createdBy: CURRENT_UID,
    time: Date.now()
  });

  // reset
  if ($("secName")) $("secName").value = "";
  if ($("secJoinDate")) $("secJoinDate").value = "";
  if ($("secStatus")) $("secStatus").value = "member";

  if ($("secLicense")) $("secLicense").checked = false;
  if ($("secLicenseDate")) $("secLicenseDate").value = "";

  if ($("warn1")) $("warn1").checked = false;
  if ($("warn2")) $("warn2").checked = false;
  if ($("warnText")) $("warnText").value = "";

  if ($("secSponsor")) $("secSponsor").value = "";
  if ($("selfJoined")) $("selfJoined").checked = false;
  if ($("secNotes")) $("secNotes").value = "";

  loadSecretaryEntries();
};

/* ===================================================== */
/* SECRETARY: MEMBER LIST (CACHE + FILTER) */
/* ===================================================== */

async function loadSecretaryEntries() {
  const secEntries = $("secEntries");
  if (!secEntries) return;

  secEntries.innerHTML = `<div class="card">Lade...</div>`;
  SECRETARY_ENTRIES_CACHE = [];

  const snaps = await getDocs(collection(db, "member_observations"));
  snaps.forEach(docSnap => {
    const e = docSnap.data() || {};
    SECRETARY_ENTRIES_CACHE.push({ id: docSnap.id, ...e });
  });

  SECRETARY_ENTRIES_CACHE.sort((a, b) => (b.time || 0) - (a.time || 0));
  renderSecretaryEntries();
}

function renderSecretaryEntries() {
  const secEntries = $("secEntries");
  if (!secEntries) return;

  const search = ($("secSearch")?.value || "").trim().toLowerCase();
  const statusFilter = $("secFilterStatus")?.value || "";

  const list = SECRETARY_ENTRIES_CACHE.filter(e => {
    const st = String(e.status || "").toLowerCase();
    if (statusFilter && st !== statusFilter) return false;
    if (!search) return true;

    const blob = [
      e.name,
      e.status,
      e.sponsor,
      e.notes,
      e.warnText,
      e.hasLicense ? "führerschein" : "",
      e.warn1 ? "w1" : "",
      e.warn2 ? "w2" : ""
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

    const st = e.status || "-";
    const lic = e.hasLicense ? "✅" : "❌";

    secEntries.innerHTML += `
      <div class="card sec-entry ${warnClass}" onclick="openMemberFile('${e.id}')">
        <b>${e.name || "-"}</b><br>
        Status: ${st}<br>
        Führerschein: ${lic}<br>
        Warns: ${e.warn1 ? "W.1 " : ""}${e.warn2 ? "W.2" : ""}<br>
        <small>${e.sponsor === "self_joined" ? "Selbst gekommen" : (e.sponsor ? ("Vorgestellt von: " + e.sponsor) : "")}</small>
      </div>
    `;
  });
}

/* ===================================================== */
/* SECRETARY: DETAIL / TIMELINE / WARNS */
/* ===================================================== */

window.openMemberFile = async (docId) => {
  CURRENT_MEMBER_DOC = docId;

  const snap = await getDoc(doc(db, "member_observations", docId));
  if (!snap.exists()) return alert("Nicht gefunden");

  const data = snap.data() || {};

  const statusText = data.status || "-";
  const licenseText = data.hasLicense ? "✅ Ja" : "❌ Nein";
  const licenseDate = data.licenseCheckedAt || "-";

  const sponsorLine =
    data.sponsor === "self_joined"
      ? "Selbst zum Club gekommen"
      : (data.sponsor ? `Vorgestellt von: ${data.sponsor}` : "-");

  const secDetail = $("secDetail");
  if (!secDetail) return;

  secDetail.innerHTML = `
    <div class="card">
      <h4>${data.name || "-"}</h4>
      Mitglied seit: ${data.joinDate || "-"}<br>
      Status: ${statusText}<br>
      Führerschein: ${licenseText}<br>
      Geprüft am: ${licenseDate}<br>
      Herkunft: ${sponsorLine}<br><br>
      ${data.notes || ""}
    </div>

    <div class="card">
      <h4>⚠️ Warns (Detail)</h4>

      <div class="row">
        <input id="warnIssued" type="date">
        <select id="warnLevel">
          <option value="W1">W.S1</option>
          <option value="W2">W.S2</option>
        </select>
      </div>

      <textarea id="warnReason" placeholder="Grund / Details"></textarea>

      <div class="row">
        <button class="smallbtn" type="button" onclick="addWarn()">➕ Warn hinzufügen</button>
        <button class="smallbtn gray" type="button" onclick="loadWarns()">🔄 Laden</button>
      </div>

      <div id="warnList"></div>
    </div>

    <div class="card">
      <h4>🗄️ Member-Archiv</h4>
      <button class="smallbtn" type="button" onclick="openArchiveLinkedToMember()">➕ Archiv-Eintrag für diese Akte</button>
      <div id="memberArchiveList"></div>
    </div>

    <h4>Timeline</h4>
    <div id="timelineList"></div>

    <div class="card">
      <h4>✏️ Bearbeiten</h4>

      <input id="editName" placeholder="Name" value="${escapeAttr(data.name)}">

      <label class="field-label" for="editStatus">Status</label>
      <select id="editStatus">
        <option value="supporter" ${statusText === "supporter" ? "selected" : ""}>Supporter</option>
        <option value="hangaround" ${statusText === "hangaround" ? "selected" : ""}>Hangaround</option>
        <option value="prospect" ${statusText === "prospect" ? "selected" : ""}>Prospect</option>
        <option value="member" ${statusText === "member" ? "selected" : ""}>Member</option>
      </select>

      <label class="checkline" for="editHasLicense">
        <input type="checkbox" id="editHasLicense" ${data.hasLicense ? "checked" : ""}>
        Führerschein vorhanden
      </label>

      <label class="field-label" for="editLicenseCheckedAt">Führerschein geprüft am</label>
      <input id="editLicenseCheckedAt" type="date" value="${escapeAttr(data.licenseCheckedAt)}">

      <div class="warn-checks">
        <label class="checkline small" for="editWarn1"><input type="checkbox" id="editWarn1" ${data.warn1 ? "checked" : ""}> W.1</label>
        <label class="checkline small" for="editWarn2"><input type="checkbox" id="editWarn2" ${data.warn2 ? "checked" : ""}> W.2</label>
      </div>

      <textarea id="editWarnText" placeholder="Warn Details">${data.warnText || ""}</textarea>

      <input id="editSponsor" placeholder="Vorgestellt von" value="${escapeAttr(data.sponsor === "self_joined" ? "" : data.sponsor)}">
      <label class="checkline" for="editSelfJoined">
        <input type="checkbox" id="editSelfJoined" ${data.sponsor === "self_joined" ? "checked" : ""}>
        Selbst zum Club gekommen
      </label>

      <textarea id="editNotes" placeholder="Notizen">${data.notes || ""}</textarea>

      <div class="row">
        <button class="smallbtn" type="button" onclick="saveMemberFile()">💾 Speichern</button>
        <button class="smallbtn danger" type="button" onclick="deleteMemberFile()">🗑️ Löschen</button>
      </div>
    </div>
  `;

  await loadTimeline();
  await loadWarns();
  await loadMemberArchive();
};

async function loadTimeline() {
  if (!CURRENT_MEMBER_DOC) return;

  const container = $("timelineList");
  if (!container) return;

  container.innerHTML = "";

  const snaps = await getDocs(collection(db, "member_observations", CURRENT_MEMBER_DOC, "timeline"));
  const items = [];
  snaps.forEach(d => items.push(d.data() || {}));
  items.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));

  items.forEach(t => {
    container.innerHTML += `
      <div class="timeline-entry">
        <b>${t.date || "-"}</b> – ${t.rank || ""}<br>
        ${t.text || ""}
      </div>
    `;
  });
}

window.addTimelineEntry = async () => {
  if (!CURRENT_MEMBER_DOC) return alert("Erst Akte öffnen");

  const timelineDate = $("timelineDate")?.value || "";
  const timelineRank = $("timelineRank")?.value || "";
  const timelineText = $("timelineText")?.value || "";

  if (!timelineDate) return alert("Datum fehlt");

  await addDoc(collection(db, "member_observations", CURRENT_MEMBER_DOC, "timeline"), {
    date: timelineDate,
    rank: timelineRank,
    text: timelineText,
    by: CURRENT_UID,
    time: Date.now()
  });

  if ($("timelineText")) $("timelineText").value = "";
  if ($("timelineRank")) $("timelineRank").value = "";

  loadTimeline();
};

/* Warns subcollection */

window.addWarn = async () => {
  if (!CURRENT_MEMBER_DOC) return alert("Erst Akte öffnen");

  const issued = $("warnIssued")?.value;
  const level = $("warnLevel")?.value || "W1";
  const reason = $("warnReason")?.value || "";

  if (!issued) return alert("Datum fehlt");

  await addDoc(collection(db, "member_observations", CURRENT_MEMBER_DOC, "warns"), {
    issued,
    level,
    reason,
    by: CURRENT_UID,
    time: Date.now(),
    active: true
  });

  if ($("warnReason")) $("warnReason").value = "";
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

        <button class="smallbtn gray" type="button"
          onclick="toggleWarnActive('${d.id}', ${w.active === false ? "false" : "true"})">
          Status: ${w.active === false ? "Erledigt" : "Aktiv"}
        </button>

        <button class="smallbtn danger" type="button" onclick="deleteWarn('${d.id}')">Löschen</button>
      </div>
    `;
  });
};

window.toggleWarnActive = async (warnId, current) => {
  if (!CURRENT_MEMBER_DOC) return;
  const next = current ? false : true;
  await updateDoc(doc(db, "member_observations", CURRENT_MEMBER_DOC, "warns", warnId), { active: next });
  loadWarns();
};

window.deleteWarn = async (warnId) => {
  if (!CURRENT_MEMBER_DOC) return;
  if (!confirm("Warn wirklich löschen?")) return;
  await deleteDoc(doc(db, "member_observations", CURRENT_MEMBER_DOC, "warns", warnId));
  loadWarns();
};

/* Edit / Delete member file */

window.saveMemberFile = async () => {
  if (!CURRENT_MEMBER_DOC) return;

  const name = $("editName")?.value || "";
  const status = $("editStatus")?.value || "member";
  const hasLicense = !!$("editHasLicense")?.checked;
  const licenseCheckedAt = $("editLicenseCheckedAt")?.value || "";

  const warn1 = !!$("editWarn1")?.checked;
  const warn2 = !!$("editWarn2")?.checked;
  const warnText = $("editWarnText")?.value || "";

  const selfJoined = !!$("editSelfJoined")?.checked;
  const sponsor = selfJoined ? "self_joined" : ($("editSponsor")?.value || "");

  const notes = $("editNotes")?.value || "";

  await updateDoc(doc(db, "member_observations", CURRENT_MEMBER_DOC), {
    name,
    status,
    hasLicense,
    licenseCheckedAt,
    warn1,
    warn2,
    warnText,
    sponsor,
    notes
  });

  alert("Gespeichert");
  await loadSecretaryEntries();
  await window.openMemberFile(CURRENT_MEMBER_DOC);
};

window.deleteMemberFile = async () => {
  if (!CURRENT_MEMBER_DOC) return;
  if (!confirm("Akte wirklich löschen?")) return;

  await deleteDoc(doc(db, "member_observations", CURRENT_MEMBER_DOC));
  CURRENT_MEMBER_DOC = null;

  const secDetail = $("secDetail");
  if (secDetail) secDetail.innerHTML = "";

  loadSecretaryEntries();
};

/* ===================================================== */
/* MEETINGS: PICKLISTS / VOTES / ACTIONS */
/* ===================================================== */

function prepareMeetingPicklists() {
  const presentBox = $("meetAttendanceBox");
  const excusedBox = $("meetAbsentExcusedBox");
  const unexcusedBox = $("meetAbsentUnexcusedBox");

  if (!presentBox || !excusedBox || !unexcusedBox) return;

  const users = [...USERS_CACHE.entries()]
    .map(([uid, u]) => ({ uid, ...u }))
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
  const out = [];
  box.querySelectorAll("input[type=checkbox]").forEach(ch => {
    if (ch.checked) out.push(ch.getAttribute("data-uid"));
  });
  return out;
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
      <small>Trage pro Person eine Stimme ein (z.B. Ja/Nein/A/B).</small>
      <div id="voteRows"></div>
      <button class="smallbtn" type="button" onclick="calcVoteResultFromRows()">Ergebnis berechnen</button>
    </div>
  `;

  const rows = $("voteRows");
  if (!rows) return;

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

/* Action items */

function addMeetingActionRow(prefill = null) {
  const list = $("meetActionsList");
  if (!list) return;

  const idx = MEETING_ACTIONS.length;
  MEETING_ACTIONS.push({
    text: prefill?.text || "",
    toUid: prefill?.toUid || CURRENT_UID,
    dueDate: prefill?.dueDate || "",
    taskId: prefill?.taskId || null,
    removed: false
  });

  list.innerHTML += `
    <div class="card" id="actRow${idx}">
      <input id="actText${idx}" placeholder="Aufgabe (Text)" value="${escapeAttr(prefill?.text || "")}">
      <select id="actTo${idx}"></select>
      <input id="actDue${idx}" type="date" value="${escapeAttr(prefill?.dueDate || "")}">
      <div class="row">
        <button class="smallbtn danger" type="button" onclick="removeActionRow(${idx})">Entfernen</button>
      </div>
    </div>
  `;

  const sel = $(`actTo${idx}`);
  if (!sel) return;

  const users = [...USERS_CACHE.entries()]
    .map(([uid, u]) => ({ uid, ...u }))
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));

  sel.innerHTML = users.map(u => `<option value="${u.uid}">${u.name}</option>`).join("");
  sel.value = prefill?.toUid || CURRENT_UID;

  const t = $(`actText${idx}`);
  const d = $(`actDue${idx}`);

  if (t) t.oninput = () => (MEETING_ACTIONS[idx].text = t.value);
  sel.onchange = () => (MEETING_ACTIONS[idx].toUid = sel.value);
  if (d) d.onchange = () => (MEETING_ACTIONS[idx].dueDate = d.value);

  // initial state
  MEETING_ACTIONS[idx].text = t ? t.value : "";
  MEETING_ACTIONS[idx].toUid = sel.value;
  MEETING_ACTIONS[idx].dueDate = d ? d.value : "";
}

window.removeActionRow = (idx) => {
  if (MEETING_ACTIONS[idx]) MEETING_ACTIONS[idx].removed = true;
  const row = $(`actRow${idx}`);
  if (row) row.style.display = "none";
};

function resetMeetingForm() {
  EDIT_MEETING_ID = null;
  MEETING_ACTIONS = [];

  const idsClear = [
    "meetDate","meetTitle","meetAgenda","meetNotes","voteTopic","voteOptions","voteResult",
    "meetPersons","meetAttendees","meetFollowups"
  ];
  idsClear.forEach(id => { const el = $(id); if (el) el.value = ""; });

  const ms = $("meetStatus");
  if (ms) ms.value = "open";

  const vb = $("voteBox");
  if (vb) vb.innerHTML = "";

  const al = $("meetActionsList");
  if (al) al.innerHTML = "";

  ["meetAttendanceBox", "meetAbsentExcusedBox", "meetAbsentUnexcusedBox"].forEach(id => {
    const box = $(id);
    if (!box) return;
    box.querySelectorAll("input[type=checkbox]").forEach(ch => ch.checked = false);
  });

  const smb = $("saveMeetingBtn");
  if (smb) smb.textContent = "Besprechung speichern";
}

async function loadMeetings() {
  const list = $("meetingList");
  if (!list) return;

  list.innerHTML = `<div class="card">Lade...</div>`;
  MEETINGS_CACHE = [];

  const snaps = await getDocs(query(collection(db, "meetings"), orderBy("date", "desc"), limit(50)));
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

        <button type="button" onclick="editMeeting('${m.id}')">Bearbeiten</button>
        <button type="button" onclick="deleteMeeting('${m.id}')">Löschen</button>
        <button type="button" onclick="toggleMeetingStatus('${m.id}', '${m.status || "open"}')">
          Status: ${m.status === "done" ? "Erledigt" : "Offen"}
        </button>
        <button class="smallbtn gray" type="button" onclick="openArchiveLinkedToMeeting('${m.id}')">🗄️ Archiv verknüpfen</button>
      </div>
    `;
  });
}

async function saveMeeting() {
  if (!hasSecretaryRights()) return alert("Kein Zugriff");

  const md = $("meetDate");
  const mt = $("meetTitle");
  if (!md?.value || !mt?.value) return alert("Datum und Titel sind Pflicht");

  const payload = {
    date: md.value,
    title: mt.value,
    agenda: $("meetAgenda")?.value || "",
    notes: $("meetNotes")?.value || "",

    voteTopic: $("voteTopic")?.value || "",
    voteOptions: $("voteOptions")?.value || "",
    voteResult: $("voteResult")?.value || "",

    persons: $("meetPersons")?.value || "",
    attendees: $("meetAttendees")?.value || "",
    followups: $("meetFollowups")?.value || "",

    status: $("meetStatus")?.value || "open",

    attendance: {
      present: getCheckedUids("meetAttendanceBox"),
      absentExcused: getCheckedUids("meetAbsentExcusedBox"),
      absentUnexcused: getCheckedUids("meetAbsentUnexcusedBox")
    },

    actions: MEETING_ACTIONS
      .filter(a => a && !a.removed)
      .map(a => ({
        text: a.text || "",
        toUid: a.toUid || CURRENT_UID,
        dueDate: a.dueDate || "",
        taskId: a.taskId || null
      }))
      .filter(a => a.text.trim().length > 0),

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

  // Tasks aus Action-Items erstellen/aktualisieren
  for (let i = 0; i < payload.actions.length; i++) {
    const a = payload.actions[i];

    // Neu anlegen
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
      continue;
    }

    // Existiert der Task noch?
    const tRef = doc(db, "tasks", a.taskId);
    const tDoc = await getDoc(tRef);

    // Wenn Task gelöscht wurde → neu erstellen statt updateDoc() Crash
    if (!tDoc.exists()) {
      const newRef = await addDoc(collection(db, "tasks"), {
        from: CURRENT_UID,
        to: a.toUid,
        text: `[Meeting ${md.value}] ${a.text}`,
        status: "open",
        dueDate: a.dueDate || "",
        meetingId: meetingId,
        time: Date.now()
      });
      a.taskId = newRef.id;
      continue;
    }

    // Update bestehend (Status beibehalten)
    const existing = tDoc.data() || {};
    await updateDoc(tRef, {
      to: a.toUid,
      text: `[Meeting ${md.value}] ${a.text}`,
      dueDate: a.dueDate || "",
      meetingId: meetingId,
      status: existing.status || "open"
    });
  }

  // Actions zurück in meeting schreiben (mit taskId)
  await updateDoc(doc(db, "meetings", meetingId), { actions: payload.actions });

  resetMeetingForm();
  await loadMeetings();
  loadTasks();
}

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

  window.secShow("secMeetings");
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
/* LETTERS */
/* ===================================================== */

function resetLetterForm() {
  EDIT_LETTER_ID = null;
  const setVal = (id, v) => { const el = $(id); if (el) el.value = v || ""; };
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

  if (!toEl?.value || !subEl?.value) return alert("Empfänger und Betreff sind Pflicht");

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
    const preview = (l.body || "").slice(0, 350).replace(/\n/g, "<br>");
    list.innerHTML += `
      <div class="card">
        <b>${(l.status || "draft").toUpperCase()}</b> – ${l.subject || "-"}<br>
        <small>an: ${l.to || "-"}</small><br><br>
        ${preview}
        ${(l.body || "").length > 350 ? "<br><small>...</small>" : ""}
        <br><br>
        <button type="button" onclick="editLetter('${l.id}')">Bearbeiten</button>
        <button class="danger" type="button" onclick="deleteLetter('${l.id}')">Löschen</button>
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

  window.secShow("secLetters");
};

window.deleteLetter = async (id) => {
  if (!hasSecretaryRights()) return;
  if (!confirm("Letter wirklich löschen?")) return;

  await deleteDoc(doc(db, "letters", id));
  loadLetters();
};

/* ===================================================== */
/* BYLAWS */
/* ===================================================== */

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

        <button class="smallbtn gray" type="button" onclick="previewBylaws('${b.id}')">Ansehen</button>
        <button class="smallbtn" type="button" onclick="setActiveBylaws('${b.id}')">Aktiv setzen</button>
        <button class="smallbtn danger" type="button" onclick="deleteBylaws('${b.id}')">Löschen</button>
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

  // alte aktive deaktivieren
  const activeSnap = await getDocs(query(collection(db, "bylaws"), where("active", "==", true), limit(10)));
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

  const activeSnap = await getDocs(query(collection(db, "bylaws"), where("active", "==", true), limit(10)));
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
/* ARCHIVE */
/* ===================================================== */

window.openArchiveLinkedToMember = () => {
  if (!CURRENT_MEMBER_DOC) return;

  PENDING_ARCHIVE_LINK = { memberId: CURRENT_MEMBER_DOC, meetingId: null };

  if ($("archCategory")) $("archCategory").value = "member";
  if ($("archTitle")) $("archTitle").value = `Akte: ${($("secDetail")?.querySelector("h4")?.innerText || "").trim()}`;

  if ($("archLinkMember")) $("archLinkMember").checked = true;
  if ($("archLinkMeeting")) $("archLinkMeeting").checked = false;

  window.secShow("secArchive");
};

window.openArchiveLinkedToMeeting = (meetingId) => {
  PENDING_ARCHIVE_LINK = { memberId: null, meetingId: meetingId || EDIT_MEETING_ID || null };

  if ($("archCategory")) $("archCategory").value = "meeting";
  if ($("archTitle")) $("archTitle").value = `Meeting Archiv (${meetingId || EDIT_MEETING_ID || ""})`;

  if ($("archLinkMember")) $("archLinkMember").checked = false;
  if ($("archLinkMeeting")) $("archLinkMeeting").checked = true;

  window.secShow("secArchive");
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

        <button class="smallbtn danger" type="button" onclick="deleteArchiveEntry('${a.id}')">Löschen</button>
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
    tEl.innerText = "Offene Tasks: (Fehler/Rechte)";
  }

  try {
    const mSnaps = await getDocs(query(collection(db, "meetings"), where("status", "==", "open")));
    mEl.innerText = `Offene Meetings: ${mSnaps.size}`;
  } catch {
    mEl.innerText = "Offene Meetings: (Fehler/Rechte)";
  }

  try {
    const lSnaps = await getDocs(query(collection(db, "letters"), where("status", "==", "draft")));
    lEl.innerText = `Entwürfe: ${lSnaps.size}`;
  } catch {
    lEl.innerText = "Entwürfe: (Fehler/Rechte)";
  }

  try {
    const aSnaps = await getDocs(query(collection(db, "archive"), limit(200)));
    aEl.innerText = `Archiv Einträge: ${aSnaps.size}${aSnaps.size === 200 ? "+" : ""}`;
  } catch {
    aEl.innerText = "Archiv Einträge: (Fehler/Rechte)";
  }

  // aktive Warns (best effort)
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
    wEl.innerText = "Aktive Warns: (Fehler/Rechte)";
  }
}

/* ===================================================== */
/* TREASURY: PANEL / TABS */
/* ===================================================== */

const TM_MONTHS = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
const TM_MONTH_LABELS = ["Januar","Februar","März","April","Mai","Juni","Juli","August","September","Oktober","November","Dezember"];

function monthKeyFromInput(monthStr) {
  // monthStr: "YYYY-MM"
  if (!monthStr || !monthStr.includes("-")) return null;
  const mm = Number(monthStr.split("-")[1]);
  if (!mm || mm < 1 || mm > 12) return null;
  return TM_MONTHS[mm - 1];
}

function monthLabelFromInput(monthStr) {
  if (!monthStr || !monthStr.includes("-")) return "-";
  const [yy, mmStr] = monthStr.split("-");
  const mm = Number(mmStr);
  if (!mm || mm < 1 || mm > 12) return monthStr;
  return `${TM_MONTH_LABELS[mm - 1]} ${yy}`;
}

function euro(n) {
  const x = Number(n || 0);
  return `${x.toFixed(2).replace(".", ",")}€`;
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;")
    .replace(/'/g,"&#039;");
}

function isTreasurerUIReadOnly() {
  // UI: President/Vice/Sergeant dürfen ansehen, Treasurer darf editieren
  return !isTreasurerOnly();
}

function setTreasuryTabReadOnly(tabId, readOnly) {
  const root = $(tabId);
  if (!root) return;
  root.querySelectorAll("input, textarea, select").forEach(el => {
    // Monat darf jeder Viewer auswählen (damit Bericht/Liste funktioniert)
    if (el.id === "treasMonth") return;
    if (el.id === "treasAutoSollIst") return;
    el.disabled = !!readOnly;
  });

  const saveBtn = $("saveTreasReportBtn");
  const resetBtn = $("resetTreasReportBtn");
  const hint = $("treasClubReadOnlyHint");

  if (saveBtn) saveBtn.style.display = readOnly ? "none" : "block";
  if (resetBtn) resetBtn.style.display = readOnly ? "none" : "block";

  if (hint) {
    hint.innerText = readOnly
      ? "Nur Ansicht: Speichern/Bearbeiten/Löschen kann nur der Treasurer."
      : "";
  }

  const memHint = $("treasMembersReadOnlyHint");
  const addBtn = $("treasAddMemberBtn");
  if (memHint) memHint.innerText = readOnly ? "Nur Ansicht: Neue Personen/Akten kann nur der Treasurer anlegen." : "";
  if (addBtn) addBtn.style.display = readOnly ? "none" : "block";
}

window.treasShow = (which) => {
  const tabs = ["treasDashboard", "treasClub", "treasMembers"];
  tabs.forEach(id => {
    const el = $(id);
    if (el) el.classList.add("hidden");
  });

  const target = $(which);
  if (target) target.classList.remove("hidden");

  // Readonly UI setzen
  setTreasuryTabReadOnly("treasClub", isTreasurerUIReadOnly());
  setTreasuryTabReadOnly("treasMembers", isTreasurerUIReadOnly());

  if (which === "treasDashboard") loadTreasuryDashboard();
  if (which === "treasClub") loadTreasuryReports();
  if (which === "treasMembers") loadTreasuryMembers();
};

window.showTreasuryPanel = () => {
  if (!hasTreasuryAccess()) {
    alert("Kein Zugriff");
    return;
  }
  window.showScreen("treasuryScreen");
  window.treasShow("treasDashboard");
};

/* ===================================================== */
/* TREASURY: DASHBOARD */
/* ===================================================== */

async function loadTreasuryDashboard() {
  const latest = $("treasDashLatest");
  const sollIst = $("treasDashSollIst");
  const mem = $("treasDashMembers");
  const open = $("treasDashOpenCount");
  const hint = $("treasReadHint");

  if (hint) {
    hint.innerText = isTreasurerOnly()
      ? "Du bist Treasurer: Du kannst erstellen/bearbeiten/löschen."
      : "Nur Ansicht: Erstellen/Bearbeiten/Löschen kann nur der Treasurer.";
  }

  if (!latest || !sollIst || !mem || !open) return;

  latest.innerText = "Letzter Monat: ...";
  sollIst.innerText = "Clubkasse Soll/Ist: ...";
  mem.innerText = "Member-Akten: ...";
  open.innerText = "Offene Zahler (Monat): ...";

  // ✅ Dashboard: ALLE Monats-Akten zusammenrechnen (Soll/Ist + offen)
  try {
    const snaps = await getDocs(
      query(collection(db, "treasury_reports"), orderBy("month", "desc"), limit(500))
    );

    if (snaps.empty) {
      latest.innerText = "Letzter Monat: keine Akten";
      sollIst.innerText = "Clubkasse Soll/Ist (gesamt): -";
    } else {
      let totalSoll = 0;
      let totalIst = 0;
      let totalOffen = 0;
      let count = 0;

      let latestMonth = "-";

      snaps.forEach((ds) => {
        const d = ds.data() || {};
        count++;

        if (count === 1) latestMonth = d.month || "-";

        const s = Number(d.cashSoll || 0);
        const i = Number(d.cashIst || 0);

        totalSoll += s;
        totalIst += i;
        totalOffen += Math.max(0, s - i);
      });

      latest.innerText = `Letzter Monat: ${latestMonth} (${count} Akte(n))`;
      sollIst.innerText = `Clubkasse Soll/Ist (gesamt, alle Akten): ${euro(totalSoll)} / ${euro(totalIst)} (offen: ${euro(totalOffen)})`;
    }
  } catch {
    latest.innerText = "Letzter Monat: (Fehler/Rechte)";
    sollIst.innerText = "Clubkasse Soll/Ist (gesamt): (Fehler/Rechte)";
  }

  // count members
  try {
    const ms = await getDocs(query(collection(db, "treasury_members"), limit(200)));
    mem.innerText = `Member-Akten: ${ms.size}${ms.size === 200 ? "+" : ""}`;
  } catch {
    mem.innerText = "Member-Akten: (Fehler/Rechte)";
  }

  // offene Zahler für aktuell ausgewählten Monat (oder aktueller Monat)
  try {
    const monthStr = $("treasMonth")?.value || new Date().toISOString().slice(0,7);
    await ensureTreasuryMembersLoaded();
    const stats = calcMonthStatsFromCache(monthStr);
    open.innerText = `Offene Zahler (${monthLabelFromInput(monthStr)}): ${stats.openMembers.length}`;
  } catch {
    open.innerText = "Offene Zahler (Monat): (Fehler/Rechte)";
  }
}

/* ===================================================== */
/* TREASURY: AUTO-BERECHNUNG (Monat) */
/* ===================================================== */

async function ensureTreasuryMembersLoaded() {
  if (TREASURY_MEMBERS_CACHE && TREASURY_MEMBERS_CACHE.length) return;
  await loadTreasuryMembers();
}

function calcMonthStatsFromCache(monthStr) {
  const key = monthKeyFromInput(monthStr);        // z.B. "januar" / "februar" etc. (dein System)
  const members = TREASURY_MEMBERS_CACHE || [];

  let sollTotal = 0;
  let istTotal = 0;

  const openMembers = [];
  const paidMembers = [];

  const monthYM = String(monthStr || "").trim(); // erwartet "YYYY-MM"

  members.forEach(m => {
    const club = Number(m.clubMonthly || 0);
    const other = Number(m.otherMonthly || 0);
    const baseDue = club + other;

    // ✅ FIX: Eintrittsdatum prüfen (nur echtes YYYY-MM-DD zählt)
    const joinISO = treas_normISODate(m.joinDate || m.entryDate || m.join || "");

    // ✅ FIX: Hangaround/Supporter zahlen nichts
    const exempt = treas_isDuesExempt(m);
    
    // ✅ FIX: Nur zahlen, wenn:
    // - Monat gewählt ist (key vorhanden)
    // - nicht exempt (kein Hangaround/Supporter)
    // - Eintrittsdatum vorhanden (gültig)
    // - und der ausgewählte Monat >= Eintrittsmonat ist
    let due = 0;
    if (key && !exempt && joinISO && /^\d{4}-\d{2}$/.test(monthYM)) {
      const joinYM = joinISO.slice(0, 7); // "YYYY-MM"
      if (monthYM >= joinYM) due = baseDue;
    }

    // ✅ wenn kein Monat gewählt wird, nur Summen anzeigen (wie vorher)
    // paid wird nur ausgewertet, wenn key da ist
    const paid = key ? !!(m.monthsPaid && m.monthsPaid[key]) : false;

    // ✅ Totals nur für Leute, die in dem Monat überhaupt zahlen müssen
    sollTotal += due;

    if (paid) {
      istTotal += due;
      if (due > 0) paidMembers.push({ m, due });
    } else {
      // ✅ WICHTIG: Wer 0 zahlen muss, darf NICHT in "offen" landen
      if (due > 0) openMembers.push({ m, due });
    }
  });

  // Fines als Extra-Info (nicht automatisch in Monatssoll gerechnet)
  const fines = members
    .filter(m => Number(m.fineAmount || 0) > 0)
    .map(m => ({ m, fine: Number(m.fineAmount || 0) }));

  return { key, sollTotal, istTotal, openMembers, paidMembers, fines };
}

async function onTreasuryMonthChanged() {
  const monthStr = $("treasMonth")?.value || "";
  if (!monthStr) {
    const list = $("treasOpenContribList");
    if (list) list.innerHTML = "Wähle einen Monat…";
    return;
  }

  await ensureTreasuryMembersLoaded();

  const stats = calcMonthStatsFromCache(monthStr);

  const info = $("treasAutoInfo");
  if (info) {
    info.innerText = `Auto: Soll/Ist aus Member-Akten für ${monthLabelFromInput(monthStr)} (Häkchen = bezahlt).`;
  }

  // Auto Soll/Ist setzen, wenn aktiviert
  const auto = !!$("treasAutoSollIst")?.checked;
  if (auto) {
    const sEl = $("treasCashSoll");
    const iEl = $("treasCashIst");
    if (sEl) sEl.value = String(Math.round(stats.sollTotal * 100) / 100);
    if (iEl) iEl.value = String(Math.round(stats.istTotal * 100) / 100);
  }
  updateTreasCashDiff();

  // Offen-Liste rendern
  renderOpenContribList(monthStr, stats);
}

function renderOpenContribList(monthStr, stats) {
  const box = $("treasOpenContribList");
  if (!box) return;

  if (!stats.openMembers.length) {
    box.innerHTML = `<div class="card money-good">Alle haben für ${monthLabelFromInput(monthStr)} bezahlt ✅</div>`;
    return;
  }

  const lines = stats.openMembers
    .sort((a,b) => (a.m.name || "").localeCompare(b.m.name || ""))
    .map(({m, due}) => {
      const fine = Number(m.fineAmount || 0);
      const fineTxt = fine > 0 ? ` | Strafe: ${euro(fine)} (${escapeHtml(m.fineReason || "-")})` : "";
      const lateTxt = m.lateNote ? ` | Verspätung: ${escapeHtml(m.lateNote)}` : "";
      const noteTxt = m.note ? ` | Notiz: ${escapeHtml(m.note)}` : "";
      return `<div class="card money-warn">
        <b>${escapeHtml(m.name || "-")}</b> – offen: <b>${euro(due)}</b>
        <br><small>Rang: ${escapeHtml(m.rank || "-")} | Eintritt: ${escapeHtml(m.joinDate || "-")}${fineTxt}${lateTxt}${noteTxt}</small>
      </div>`;
    }).join("");

  const totalOpen = stats.openMembers.reduce((s,x) => s + Number(x.due || 0), 0);

  box.innerHTML = `
    <div class="card money-bad">
      <b>Offen gesamt:</b> ${euro(totalOpen)} (${stats.openMembers.length} Person(en))
    </div>
    ${lines}
  `;
}

/* ===================================================== */
/* TREASURY: CLUB REPORTS (Monats-Akten) */
/* ===================================================== */

function updateTreasCashDiff() {
  const s = Number($("treasCashSoll")?.value || 0);
  const i = Number($("treasCashIst")?.value || 0);
  const diff = i - s;
  const box = $("treasCashDiff");
  if (!box) return;

  const offen = Math.max(0, s - i);
  box.innerText = `Differenz (Ist - Soll): ${diff.toFixed(2).replace(".", ",")}€ | Offen: ${offen.toFixed(2).replace(".", ",")}€`;

  box.classList.remove("money-good", "money-warn", "money-bad");
  if (offen === 0 && s > 0) box.classList.add("money-good");
  else if (offen > 0 && offen <= 20) box.classList.add("money-warn");
  else if (offen > 20) box.classList.add("money-bad");
}

function resetTreasuryReportForm() {
  EDIT_TREAS_REPORT_ID = null;

  const setVal = (id, v) => { const el = $(id); if (el) el.value = v || ""; };

  setVal("treasMonth", "");
  setVal("treasBudgetPerPerson", "30");

  setVal("treasIncomeSponsor", "");
  setVal("treasIncomeRides", "");
  setVal("treasIncomeOther", "");

  setVal("treasCostClub", "");
  setVal("treasCostOther", "");
  setVal("treasCostNote", "");

  setVal("treasCashSoll", "");
  setVal("treasCashIst", "");
  setVal("treasClubNote", "");

  const list = $("treasOpenContribList");
  if (list) list.innerHTML = "Wähle einen Monat…";

  updateTreasCashDiff();
}

async function loadTreasuryReports() {
  const list = $("treasReportList");
  if (!list) return;

  list.innerHTML = `<div class="card">Lade...</div>`;
  TREASURY_REPORTS_CACHE = [];

  try {
    const snaps = await getDocs(query(collection(db, "treasury_reports"), orderBy("month", "desc"), limit(36)));
    snaps.forEach(d => TREASURY_REPORTS_CACHE.push({ id: d.id, ...d.data() }));
  } catch (e) {
    list.innerHTML = `<div class="card">Fehler beim Laden: ${e.message}</div>`;
    return;
  }

  renderTreasuryReports();
  await onTreasuryMonthChanged(); // Auto-Liste + Soll/Ist aktualisieren
}

function renderTreasuryReports() {
  const list = $("treasReportList");
  if (!list) return;

  if (TREASURY_REPORTS_CACHE.length === 0) {
    list.innerHTML = `<div class="card">Noch keine Monats-Akten.</div>`;
    return;
  }

  list.innerHTML = "";

  TREASURY_REPORTS_CACHE.forEach(r => {
    const s = Number(r.cashSoll || 0);
    const i = Number(r.cashIst || 0);
    const offen = Math.max(0, s - i);

    let cls = "money-warn";
    if (offen === 0 && s > 0) cls = "money-good";
    if (offen > 20) cls = "money-bad";

    const canEdit = isTreasurerOnly();

    list.innerHTML += `
      <div class="card ${cls}">
        <b>${escapeHtml(r.month || "-")}</b><br>
        Budget/Person (Info): ${euro(Number(r.budgetPerPerson || 0))}<br><br>

        <b>Einnahmen:</b> Sponsor ${euro(Number(r.incomeSponsor || 0))} | Fahrten ${euro(Number(r.incomeRides || 0))} | Sonst ${euro(Number(r.incomeOther || 0))}<br>
        <b>Ausgaben:</b> Club ${euro(Number(r.costClub || 0))} | Andere ${euro(Number(r.costOther || 0))}<br>
        <small>${escapeHtml(r.costNote || "").replace(/\n/g, "<br>")}</small><br><br>

        <b>Clubkasse Soll/Ist:</b> ${euro(s)} / ${euro(i)} (offen: ${euro(offen)})<br>
        <small>${escapeHtml(r.note || "").replace(/\n/g, "<br>")}</small><br><br>

        <button type="button" onclick="editTreasuryReport('${r.id}')">Ansehen</button>
        ${canEdit ? `<button type="button" class="danger" onclick="deleteTreasuryReport('${r.id}')">Löschen</button>` : ""}
      </div>
    `;
  });
}

async function saveTreasuryReport() {
  if (!isTreasurerOnly()) return alert("Nur der Treasurer darf erstellen/bearbeiten/löschen.");

  const month = $("treasMonth")?.value || "";
  if (!month) return alert("Monat fehlt");

  // Auto Soll/Ist erzwingen, wenn aktiviert
  const auto = !!$("treasAutoSollIst")?.checked;
  if (auto) {
    await ensureTreasuryMembersLoaded();
    const stats = calcMonthStatsFromCache(month);
    const sEl = $("treasCashSoll");
    const iEl = $("treasCashIst");
    if (sEl) sEl.value = String(Math.round(stats.sollTotal * 100) / 100);
    if (iEl) iEl.value = String(Math.round(stats.istTotal * 100) / 100);
    updateTreasCashDiff();
  }

  const payload = {
    month,
    budgetPerPerson: Number($("treasBudgetPerPerson")?.value || 0),

    incomeSponsor: Number($("treasIncomeSponsor")?.value || 0),
    incomeRides: Number($("treasIncomeRides")?.value || 0),
    incomeOther: Number($("treasIncomeOther")?.value || 0),

    costClub: Number($("treasCostClub")?.value || 0),
    costOther: Number($("treasCostOther")?.value || 0),
    costNote: $("treasCostNote")?.value || "",

    cashSoll: Number($("treasCashSoll")?.value || 0),
    cashIst: Number($("treasCashIst")?.value || 0),
    note: $("treasClubNote")?.value || "",

    autoSollIst: auto,
    updatedBy: CURRENT_UID,
    updatedAt: Date.now()
  };

  try {
    if (EDIT_TREAS_REPORT_ID) {
      await updateDoc(doc(db, "treasury_reports", EDIT_TREAS_REPORT_ID), payload);
    } else {
      await addDoc(collection(db, "treasury_reports"), {
        ...payload,
        createdBy: CURRENT_UID,
        time: Date.now()
      });
    }
  } catch (e) {
    alert("Fehler beim Speichern: " + e.message);
    return;
  }

  resetTreasuryReportForm();
  loadTreasuryReports();
  loadTreasuryDashboard();
}

window.editTreasuryReport = async (id) => {
  const snap = await getDoc(doc(db, "treasury_reports", id));
  if (!snap.exists()) return alert("Nicht gefunden");

  const r = snap.data() || {};
  EDIT_TREAS_REPORT_ID = id;

  const setVal = (id2, v) => { const el = $(id2); if (el) el.value = (v ?? ""); };

  setVal("treasMonth", r.month);
  setVal("treasBudgetPerPerson", r.budgetPerPerson ?? 30);

  setVal("treasIncomeSponsor", r.incomeSponsor ?? 0);
  setVal("treasIncomeRides", r.incomeRides ?? 0);
  setVal("treasIncomeOther", r.incomeOther ?? 0);

  setVal("treasCostClub", r.costClub ?? 0);
  setVal("treasCostOther", r.costOther ?? 0);
  setVal("treasCostNote", r.costNote ?? "");

  setVal("treasCashSoll", r.cashSoll ?? 0);
  setVal("treasCashIst", r.cashIst ?? 0);
  setVal("treasClubNote", r.note ?? "");

  updateTreasCashDiff();
  await onTreasuryMonthChanged();

  window.treasShow("treasClub");
};

window.deleteTreasuryReport = async (id) => {
  if (!isTreasurerOnly()) return alert("Nur der Treasurer darf löschen.");
  if (!confirm("Monats-Akte wirklich löschen?")) return;

  await deleteDoc(doc(db, "treasury_reports", id));
  loadTreasuryReports();
  loadTreasuryDashboard();
};

/* ===================================================== */
/* TREASURY: CHURCH / TREFFEN FINANZBERICHT */
/* ===================================================== */

async function generateChurchReportFromSelectedMonth() {
  const monthStr = $("treasMonth")?.value || "";
  if (!monthStr) return alert("Bitte im Tab „Clubkasse“ zuerst einen Monat auswählen.");

  await ensureTreasuryMembersLoaded();
  const stats = calcMonthStatsFromCache(monthStr);

  // optional: passenden Monats-Report suchen (Einnahmen/Ausgaben etc.)
  if (!TREASURY_REPORTS_CACHE || !TREASURY_REPORTS_CACHE.length) {
    try { await loadTreasuryReports(); } catch {}
  }
  const rep = (TREASURY_REPORTS_CACHE || []).find(r => r.month === monthStr) || null;

  const openSum = stats.openMembers.reduce((s,x) => s + Number(x.due||0), 0);

  const linesOpen = stats.openMembers
    .sort((a,b) => (a.m.name || "").localeCompare(b.m.name || ""))
    .map(({m, due}) => {
      const fine = Number(m.fineAmount || 0);
      const fineTxt = fine > 0 ? ` | Strafe: ${euro(fine)} (${m.fineReason || "-"})` : "";
      const lateTxt = m.lateNote ? ` | Verspätung: ${m.lateNote}` : "";
      return `- ${m.name || "-"} (${m.rank || "-"}) offen: ${euro(due)}${fineTxt}${lateTxt}`;
    });

  const head =
`BULLDOZER – FINANZBERICHT (Church)
Monat: ${monthLabelFromInput(monthStr)}

Beiträge (Auto aus Member-Häkchen):
- Soll gesamt: ${euro(stats.sollTotal)}
- Ist gesamt: ${euro(stats.istTotal)}
- Offen gesamt: ${euro(openSum)} (${stats.openMembers.length} Person(en))`;

  const repPart = rep ? `
Monats-Akte (Treasurer):
- Einnahmen: Sponsor ${euro(rep.incomeSponsor)} | Fahrten ${euro(rep.incomeRides)} | Sonst ${euro(rep.incomeOther)}
- Ausgaben: Club ${euro(rep.costClub)} | Andere ${euro(rep.costOther)}
- Notiz Ausgaben: ${(rep.costNote || "-")}
- Notiz Monat: ${(rep.note || "-")}` : `
Monats-Akte:
- (Keine gespeicherte Monats-Akte gefunden – nur Auto-Beiträge angezeigt)`;

  const openPart =
linesOpen.length
? `\nOffene Zahler:\n${linesOpen.join("\n")}`
: `\nOffene Zahler:\n- Keine ✅`;

  const text = `${head}\n${repPart}\n${openPart}\n\nStand: ${new Date().toLocaleString()}`;

  const out = $("treasChurchText");
  if (out) out.value = text;

  // Dashboard anzeigen, damit man’s direkt sieht
  window.treasShow("treasDashboard");
}

async function copyChurchReport() {
  const out = $("treasChurchText");
  if (!out || !out.value) return alert("Kein Bericht vorhanden.");
  try {
    await navigator.clipboard.writeText(out.value);
    alert("Bericht kopiert ✅");
  } catch {
    // Fallback
    out.removeAttribute("readonly");
    out.select();
    document.execCommand("copy");
    out.setAttribute("readonly", "readonly");
    alert("Bericht kopiert ✅");
  }
}

/* ===================================================== */
/* TREASURY: MEMBER AKTEN (Modal) */
/* ===================================================== */

function getModalMonths() {
  const out = {};
  TM_MONTHS.forEach(k => { out[k] = !!$(`tm_${k}`)?.checked; });
  return out;
}

function setModalMonths(m) {
  const mm = m || {};
  TM_MONTHS.forEach(k => { const el = $(`tm_${k}`); if (el) el.checked = !!mm[k]; });
}

function updateMemberRest() {
  const s = Number($("tmSollTotal")?.value || 0);
  const i = Number($("tmIstTotal")?.value || 0);
  const offen = Math.max(0, s - i);
  const box = $("tmRestInfo");
  if (!box) return;

  box.innerText = `Offen: ${euro(offen)} (Soll ${euro(s)} / Ist ${euro(i)})`;

  box.classList.remove("money-good", "money-warn", "money-bad");
  if (offen === 0 && s > 0) box.classList.add("money-good");
  else if (offen > 0 && offen <= 20) box.classList.add("money-warn");
  else if (offen > 20) box.classList.add("money-bad");
}

function setTreasMemberModalReadOnly(readOnly) {
  TREAS_MEMBER_MODAL_READONLY = !!readOnly;

  const modal = $("treasMemberModal");
  if (!modal) return;

  modal.querySelectorAll("input, textarea, select").forEach(el => {
    el.disabled = TREAS_MEMBER_MODAL_READONLY;
  });

  const save = $("tmSaveBtn");
  const del = $("tmDeleteBtn");
  const hint = $("tmReadOnlyHint");

  if (save) save.style.display = TREAS_MEMBER_MODAL_READONLY ? "none" : "block";
  if (del) del.style.display = TREAS_MEMBER_MODAL_READONLY ? "none" : "block";

  if (hint) {
    hint.innerText = TREAS_MEMBER_MODAL_READONLY
      ? "Nur Ansicht: Bearbeiten/Löschen kann nur der Treasurer."
      : "";
  }
}

function resetTreasuryMemberModal() {
  EDIT_TREAS_MEMBER_ID = null;

  const setVal = (id, v) => { const el = $(id); if (el) el.value = v || ""; };
  setVal("tmName", "");
  setVal("tmRank", "");
  setVal("tmJoinDate", "");
  setVal("tmClubMonthly", "30");
  setVal("tmOtherMonthly", "0");
  setVal("tmNote", "");
  setVal("tmFineAmount", "");
  setVal("tmFineReason", "");
  setVal("tmLateNote", "");
  setVal("tmGeneralNote", "");
  setVal("tmSollTotal", "");
  setVal("tmIstTotal", "");

  setModalMonths({});
  updateMemberRest();
}

async function loadTreasuryMembers() {
  const list = $("treasMemberList");
  if (!list) return;

  list.innerHTML = `<div class="card">Lade...</div>`;
  TREASURY_MEMBERS_CACHE = [];

  try {
    const snaps = await getDocs(query(collection(db, "treasury_members"), orderBy("name", "asc"), limit(400)));
    snaps.forEach(d => TREASURY_MEMBERS_CACHE.push({ id: d.id, ...d.data() }));
  } catch (e) {
    list.innerHTML = `<div class="card">Fehler beim Laden: ${e.message}</div>`;
    return;
  }

  renderTreasuryMembers();
}

function renderTreasuryMembers() {
  const list = $("treasMemberList");
  if (!list) return;

  const search = ($("treasMemberSearch")?.value || "").trim().toLowerCase();
  let items = [...(TREASURY_MEMBERS_CACHE || [])];

  if (search) {
    items = items.filter(m => {
      const blob = [m.name, m.rank, m.note, m.generalNote, m.lateNote, m.fineReason].join(" ").toLowerCase();
      return blob.includes(search);
    });
  }

  if (items.length === 0) {
    list.innerHTML = `<div class="card">Keine passenden Akten.</div>`;
    return;
  }

  list.innerHTML = "";

  items.forEach(m => {
    const s = Number(m.sollTotal || 0);
    const i = Number(m.istTotal || 0);
    const offen = Math.max(0, s - i);

    let cls = "money-warn";
    if (offen === 0 && s > 0) cls = "money-good";
    if (offen > 20) cls = "money-bad";

    list.innerHTML += `
      <div class="card ${cls}" onclick="openTreasuryMemberModal('${m.id}')">
        <b>${escapeHtml(m.name || "-")}</b><br>
        Rang: ${escapeHtml(m.rank || "-")}<br>
        Eintritt: ${escapeHtml(m.joinDate || "-")}<br>
        Soll/Ist: ${euro(s)} / ${euro(i)} (offen: ${euro(offen)})
      </div>
    `;
  });
}

window.openTreasuryMemberModal = async (id) => {
  const modal = $("treasMemberModal");
  if (!modal) return;

  resetTreasuryMemberModal();

  const title = $("tmTitle");
  if (title) title.innerText = id ? "👤 Member-Akte ansehen" : "➕ Neue Member-Akte";

  setTreasMemberModalReadOnly(!isTreasurerOnly());

  if (id) {
    const snap = await getDoc(doc(db, "treasury_members", id));
    if (!snap.exists()) return alert("Nicht gefunden");

    const m = snap.data() || {};
    EDIT_TREAS_MEMBER_ID = id;

    const setVal = (id2, v) => { const el = $(id2); if (el) el.value = (v ?? ""); };

    setVal("tmName", m.name || "");
    setVal("tmRank", m.rank || "");
    setVal("tmJoinDate", m.joinDate || "");
    setVal("tmClubMonthly", m.clubMonthly ?? 30);
    setVal("tmOtherMonthly", m.otherMonthly ?? 0);
    setVal("tmNote", m.note || "");

    setModalMonths(m.monthsPaid || {});

    setVal("tmFineAmount", m.fineAmount ?? 0);
    setVal("tmFineReason", m.fineReason || "");
    setVal("tmLateNote", m.lateNote || "");
    setVal("tmGeneralNote", m.generalNote || "");

    setVal("tmSollTotal", m.sollTotal ?? 0);
    setVal("tmIstTotal", m.istTotal ?? 0);

    if (title) title.innerText = `👤 ${m.name || "Member"} – Akte`;
  }

  updateMemberRest();
  modal.classList.remove("hidden");
};

window.closeTreasuryMemberModal = () => {
  const modal = $("treasMemberModal");
  if (modal) modal.classList.add("hidden");
};

async function saveTreasuryMember() {
  if (!isTreasurerOnly()) return alert("Nur der Treasurer darf speichern.");

  const name = $("tmName")?.value?.trim() || "";
  if (!name) return alert("Name fehlt");

  const payload = {
    name,
    rank: $("tmRank")?.value || "",
    joinDate: $("tmJoinDate")?.value || "",

    clubMonthly: Number($("tmClubMonthly")?.value || 0),
    otherMonthly: Number($("tmOtherMonthly")?.value || 0),

    note: $("tmNote")?.value || "",

    monthsPaid: getModalMonths(),

    fineAmount: Number($("tmFineAmount")?.value || 0),
    fineReason: $("tmFineReason")?.value || "",

    lateNote: $("tmLateNote")?.value || "",
    generalNote: $("tmGeneralNote")?.value || "",

    sollTotal: Number($("tmSollTotal")?.value || 0),
    istTotal: Number($("tmIstTotal")?.value || 0),

    updatedBy: CURRENT_UID,
    updatedAt: Date.now()
  };

  try {
    if (EDIT_TREAS_MEMBER_ID) {
      await updateDoc(doc(db, "treasury_members", EDIT_TREAS_MEMBER_ID), payload);
    } else {
      await addDoc(collection(db, "treasury_members"), {
        ...payload,
        createdBy: CURRENT_UID,
        time: Date.now()
      });
    }
  } catch (e) {
    alert("Fehler beim Speichern: " + e.message);
    return;
  }

  closeTreasuryMemberModal();
  TREASURY_MEMBERS_CACHE = []; // Cache reset, damit Auto korrekt neu rechnet
  await loadTreasuryMembers();
  await onTreasuryMonthChanged();
  loadTreasuryDashboard();
}

async function deleteTreasuryMember() {
  if (!isTreasurerOnly()) return alert("Nur der Treasurer darf löschen.");
  if (!EDIT_TREAS_MEMBER_ID) return;

  if (!confirm("Member-Akte wirklich löschen?")) return;

  await deleteDoc(doc(db, "treasury_members", EDIT_TREAS_MEMBER_ID));
  closeTreasuryMemberModal();

  TREASURY_MEMBERS_CACHE = [];
  await loadTreasuryMembers();
  await onTreasuryMonthChanged();
  loadTreasuryDashboard();
}
