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
  setDoc,
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
  if (!treas_isValidISODate(joinISO)) return 0;
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
  return ["president", "vice_president", "sergeant_at_arms", "treasurer", "admin"].includes(CURRENT_RANK);
}

function isTreasurerOnly() {
  return ["treasurer", "admin"].includes(CURRENT_RANK);
}

function canViewAllNotes() {
  return ["president", "vice_president", "sergeant_at_arms", "secretary", "admin"].includes(CURRENT_RANK);
}

/* ✅ HIER gehört deine UI-Rechte-Logik rein */
function applyRankRights(rank) {
  const postInfoBtn = $("postInfoBtn");       // muss es in HTML als id geben
  const createRideBtn = $("createRideBtn");   // muss es in HTML als id geben

  // ✅ Infos: jeder eingeloggte darf posten (Popup)
  if (postInfoBtn) {
    postInfoBtn.classList.remove("hidden");
  }

  // ✅ Ausfahrten erstellen: nur Boss/Officer/RC/Admin
  if (createRideBtn) {
    const canCreateRide = ["president", "vice_president", "sergeant_at_arms", "road_captain", "admin"].includes(rank);
    if (canCreateRide) createRideBtn.classList.remove("hidden");
    else createRideBtn.classList.add("hidden");
  }

    // ✅ Ausfahrten Button: Hangaround/Supporter -> komplett weg
  const ridesNavBtn = $("ridesNavBtn");
  if (ridesNavBtn) {
    const r = String(rank || "").toLowerCase();
    const blocked = (r === "hangaround" || r === "supporter");
    if (blocked) ridesNavBtn.classList.add("hidden");
    else ridesNavBtn.classList.remove("hidden");
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
try {
  await loadUsersCache();
} catch (e) {
  console.warn("loadUsersCache failed:", e);
}

// Base loads
try {
  await Promise.allSettled([
  loadInfos(),
  loadRidesCache(),
  loadFiles(),
  loadUsersForNotes(),
  loadMyNotes(),
  loadUsersForTasks(),
  loadTasks()
]);
} catch (e) {
  console.warn("base loads failed:", e);
}

// Meetings Picklists vorbereiten (falls Tab geöffnet wird)
try {
  prepareMeetingPicklists();
} catch (e) {
  console.warn("prepareMeetingPicklists failed:", e);
}

// UI bindings (immer!)
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
    // Debug / Changelog
  const dbg = $("debugButton");
  if (dbg) dbg.onclick = () => window.openDebugModal();

  const addLog = $("addChangelogBtn");
  if (addLog) addLog.onclick = () => addChangelogEntry();

    // ✅ Rides Modal
  const ridesNavBtn = $("ridesNavBtn");
  if (ridesNavBtn) ridesNavBtn.onclick = () => window.openRidesModal();

  const rt1 = $("ridesTabCompleted");
  if (rt1) rt1.onclick = () => window.ridesOpen("completed");

  const rt2 = $("ridesTabRsvp");
  if (rt2) rt2.onclick = () => window.ridesOpen("rsvp");

  const rt3 = $("ridesTabManage");
  if (rt3) rt3.onclick = () => window.ridesOpen("manage");

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

  // ✅ NEU: Netto live berechnen sobald man Einnahmen/Ausgaben tippt
  const netInputs = [
    "treasIncomeSponsor",
    "treasIncomeRides",
    "treasIncomeOther",
    "treasCostClub",
    "treasCostOther"
  ];
  netInputs.forEach((id) => {
    const el = $(id);
    if (el) el.oninput = () => updateTreasNetUI();
  });

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

  // Calendar
  const calendarNavBtn = $("calendarNavBtn");
  if (calendarNavBtn) calendarNavBtn.onclick = () => window.showCalendarPanel();

  const calMonthInput = $("calMonthInput");
  if (calMonthInput) calMonthInput.onchange = () => loadCalendarMonth(calMonthInput.value);

  const calPrevMonthBtn = $("calPrevMonthBtn");
  if (calPrevMonthBtn) calPrevMonthBtn.onclick = () => {
    const [y, m] = CALENDAR_CURRENT_MONTH.split("-").map(Number);
    const d = new Date(y, m - 2, 1);
    loadCalendarMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };

  const calNextMonthBtn = $("calNextMonthBtn");
  if (calNextMonthBtn) calNextMonthBtn.onclick = () => {
    const [y, m] = CALENDAR_CURRENT_MONTH.split("-").map(Number);
    const d = new Date(y, m, 1);
    loadCalendarMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };

  const calSaveBtn = $("calSaveBtn");
  if (calSaveBtn) calSaveBtn.onclick = () => window.saveCalendarDay();

  const calDoneBtn = $("calDoneBtn");
  if (calDoneBtn) calDoneBtn.onclick = () => window.markCalendarDayDone();

  const calReopenBtn = $("calReopenBtn");
  if (calReopenBtn) calReopenBtn.onclick = () => window.reopenCalendarDay();

  const calConfirmBtn = $("calConfirmBtn");
  if (calConfirmBtn) calConfirmBtn.onclick = () => window.setCalendarRsvp("confirmed");

  const calDeclineBtn = $("calDeclineBtn");
  if (calDeclineBtn) calDeclineBtn.onclick = () => window.setCalendarRsvp("declined");
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
/* RIDES (NEU) – Modal mit 3 Tabs + Firestore */
/* ===================================================== */

let RIDES_CACHE = [];
let EDIT_RIDE_ID = null;
let EDIT_RIDE_BACKTAB = "completed";
let RIDES_TAB = "rsvp";

function rideFmtChapter(r) {
  const t = String(r.chapterType || "").toUpperCase();
  if (t === "HAMC") return "HAMC";
  if (t === "RDMC") return "RDMC";
  if (t === "OTHER") return "Sonstiges";
  return t || "-";
}

function rideFmtWhen(r) {
  const d = r.date || "-";
  const t = r.time || "-";
  return `${d} • ${t}`;
}

function rideFmtWhere(r) {
  const dest = r.destination || "-";
  const chap = rideFmtChapter(r);
  const other = (String(r.chapterType || "").toUpperCase() === "OTHER" && r.otherNote) ? ` (${r.otherNote})` : "";
  return `${dest} • ${chap}${other}`;
}

async function loadRidesCache() {
  RIDES_CACHE = [];
  try {
    const snaps = await getDocs(query(collection(db, "rides"), limit(200)));
    snaps.forEach(ds => {
      RIDES_CACHE.push({ id: ds.id, ...(ds.data() || {}) });
    });

    // Sort: aktive zuerst nach Datum aufsteigend, erledigt nach doneAt absteigend
    RIDES_CACHE.sort((a, b) => {
      const as = (a.status || "active");
      const bs = (b.status || "active");
      if (as !== bs) return as === "active" ? -1 : 1;

      if ((a.status || "active") === "active") {
        return String(a.date || "").localeCompare(String(b.date || ""));
      }
      return (Number(b.doneAt || b.time || 0) - Number(a.doneAt || a.time || 0));
    });
  } catch (e) {
    console.warn("loadRidesCache failed:", e);
  }
}

window.openRidesModal = async () => {
  if (!canOpenRides()) {
    alert("Kein Zugriff auf Ausfahrten.");
    return;
  }
  const modal = $("ridesModal");
  if (!modal) return;

   modal.classList.remove("hidden");
  await loadRidesCache();

  // Default Tab: Anmeldung (damit man aktuelle sieht)
  await window.ridesOpen("rsvp");
};

window.closeRidesModal = () => {
  const modal = $("ridesModal");
  if (modal) modal.classList.add("hidden");
};

window.ridesOpen = async (tab) => {
  RIDES_TAB = tab || "rsvp";
  const box = $("ridesTabContent");
  if (!box) return;

  box.innerHTML = "Lade...";

  // Cache aktualisieren (damit Anmeldungen/Status neu sind)
  await loadRidesCache();

  // ✅ WICHTIG: NICHT über window.* aufrufen (module!)
  if (RIDES_TAB === "completed") return renderRidesCompleted();
  if (RIDES_TAB === "manage") return renderRidesManage();
  return renderRidesRsvp();
};

window.rideEdit = async (rideId, backTab = "completed") => {
  if (!canRideManage()) {
    alert("Bearbeiten nur Road Captain / Admin.");
    return;
  }

  EDIT_RIDE_ID = rideId;
  EDIT_RIDE_BACKTAB = backTab || "completed";

  const box = $("ridesTabContent");
  if (!box) return;

  box.innerHTML = `<div class="card">Lade...</div>`;

  try {
    const snap = await getDoc(doc(db, "rides", rideId));
    if (!snap.exists()) {
      alert("Ausfahrt nicht gefunden.");
      return window.ridesOpen(EDIT_RIDE_BACKTAB);
    }

    const r = snap.data() || {};
    const chap = String(r.chapterType || "HAMC").toUpperCase();

    box.innerHTML = `
      <div class="card">
        <h4 style="margin-top:0;">✏️ Ausfahrt bearbeiten</h4>

        <label class="field-label">Wo geht es hin?</label>
        <input id="rideEditDest" value="${escapeAttr(r.destination || "")}" placeholder="Ziel">

        <label class="field-label">Datum</label>
        <input id="rideEditDate" type="date" value="${escapeAttr(r.date || "")}">

        <label class="field-label">Uhrzeit</label>
        <input id="rideEditTime" type="time" value="${escapeAttr(r.time || "")}">

        <label class="field-label">Chapter</label>
        <select id="rideEditChapterType">
          <option value="HAMC" ${chap === "HAMC" ? "selected" : ""}>HAMC</option>
          <option value="RDMC" ${chap === "RDMC" ? "selected" : ""}>RDMC</option>
          <option value="OTHER" ${chap === "OTHER" ? "selected" : ""}>Sonstiges</option>
        </select>

        <textarea id="rideEditOtherNote" ${chap === "OTHER" ? "" : "class=\"hidden\""}
          placeholder="Notiz (nur wenn Sonstiges)">${escapeHtml(r.otherNote || "")}</textarea>

        <label class="field-label">Treffpunkt</label>
        <input id="rideEditMeetPoint" value="${escapeAttr(r.meetPoint || "")}" placeholder="Treffpunkt">

        <textarea id="rideEditNote" placeholder="Optionale Notiz">${escapeHtml(r.note || "")}</textarea>

        <label class="field-label">Status</label>
        <select id="rideEditStatus">
          <option value="active" ${(r.status || "active") === "active" ? "selected" : ""}>Aktiv</option>
          <option value="done" ${(r.status || "active") === "done" ? "selected" : ""}>Abgeschlossen</option>
        </select>

        <div class="row">
          <button type="button" id="rideEditSaveBtn">💾 Speichern</button>
          <button type="button" class="danger" id="rideEditDeleteBtn">🗑️ Löschen</button>
          <button type="button" class="gray" id="rideEditBackBtn">⬅ Zurück</button>
        </div>
      </div>
    `;

    // Chapter OTHER show/hide
    const ct = $("rideEditChapterType");
    const on = $("rideEditOtherNote");
    if (ct && on) {
      const sync = () => {
        if (String(ct.value || "").toUpperCase() === "OTHER") on.classList.remove("hidden");
        else on.classList.add("hidden");
      };
      ct.onchange = sync;
      sync();
    }

    const saveBtn = $("rideEditSaveBtn");
    if (saveBtn) saveBtn.onclick = () => window.rideSaveEdit();

    const delBtn = $("rideEditDeleteBtn");
    if (delBtn) delBtn.onclick = () => window.rideDelete(EDIT_RIDE_ID);

    const backBtn = $("rideEditBackBtn");
    if (backBtn) backBtn.onclick = () => window.ridesOpen(EDIT_RIDE_BACKTAB);

  } catch (e) {
    alert("Fehler: " + e.message);
    return window.ridesOpen(EDIT_RIDE_BACKTAB);
  }
};

window.rideSaveEdit = async () => {
  if (!canRideManage()) return alert("Nur Road Captain / Admin.");

  if (!EDIT_RIDE_ID) return alert("Keine Ausfahrt gewählt.");

  const destination = $("rideEditDest")?.value?.trim() || "";
  const date = $("rideEditDate")?.value || "";
  const time = $("rideEditTime")?.value || "";
  const chapterType = ($("rideEditChapterType")?.value || "HAMC").toUpperCase();
  const otherNote = $("rideEditOtherNote")?.value?.trim() || "";
  const meetPoint = $("rideEditMeetPoint")?.value?.trim() || "";
  const note = $("rideEditNote")?.value?.trim() || "";
  const status = $("rideEditStatus")?.value || "active";

  if (!destination) return alert("Wo geht es hin? fehlt.");
  if (!date) return alert("Datum fehlt.");
  if (!time) return alert("Uhrzeit fehlt.");
  if (!meetPoint) return alert("Treffpunkt fehlt.");
  if (chapterType === "OTHER" && !otherNote) return alert("Bei „Sonstiges“ bitte Notiz ausfüllen.");

  const patch = {
    destination,
    date,
    time,
    chapterType,
    otherNote: chapterType === "OTHER" ? otherNote : "",
    meetPoint,
    note,
    status,
    updatedAt: Date.now(),
    updatedBy: CURRENT_UID
  };

  // doneAt / doneBy sauber setzen/entfernen
  if (status === "done") {
    patch.doneAt = Date.now();
    patch.doneBy = CURRENT_UID;
  } else {
    patch.doneAt = deleteField();
    patch.doneBy = deleteField();
  }

  try {
    await updateDoc(doc(db, "rides", EDIT_RIDE_ID), patch);
    await window.ridesOpen(EDIT_RIDE_BACKTAB || "completed");
  } catch (e) {
    alert("Fehler beim Speichern: " + e.message);
  }
};

/* ---------- Tab 1: Abgeschlossene ---------- */

async function renderRidesCompleted() {
  const box = document.getElementById("ridesTabContent");
  if (!box) return;

  const done = (RIDES_CACHE || []).filter(r => (r.status || "active") === "done");

  if (!done.length) {
    box.innerHTML = `<div class="card">Noch keine abgeschlossenen Ausfahrten.</div>`;
    return;
  }

  const slice = done.slice(0, 50);

  // Optional: zeigen, ob DU angemeldet warst (best effort)
  const myFlags = await Promise.all(slice.map(async (r) => {
    try {
      const snap = await getDoc(doc(db, "rides", r.id, "rsvps", CURRENT_UID));
      if (!snap.exists()) return false;
      const d = snap.data() || {};
      return d.status === "going";
    } catch {
      return false;
    }
  }));

  const canMng = canRideManage();
  let html = "";

  slice.forEach((r, idx) => {
    const wasIn = myFlags[idx]
      ? `<div class="small-note">✅ Du warst angemeldet</div>`
      : "";

    const noteHtml = r.note
      ? `<div>${escapeHtml(r.note)}</div>`
      : "";

    const actionsHtml = canMng
      ? `
        <div class="ride-actions">
          <button type="button" class="smallbtn gray" onclick="rideEdit('${r.id}', 'completed')">✏️ Bearbeiten</button>
          <button type="button" class="smallbtn danger" onclick="rideDelete('${r.id}')">🗑️ Löschen</button>
        </div>
      `
      : "";

    html += `
      <div class="card ride-card">
        <div class="ride-title">${escapeHtml(rideFmtWhere(r))}</div>
        <div class="ride-meta">📅 ${escapeHtml(rideFmtWhen(r))} • 📍 Treffpunkt: ${escapeHtml(r.meetPoint || "-")}</div>
        ${noteHtml}
        ${wasIn}
        ${actionsHtml}
      </div>
    `;
  });

  box.innerHTML = html;
};

async function renderRidesRsvp() {
  const box = $("ridesTabContent");
  if (!box) return;

  const active = (RIDES_CACHE || []).filter(r => (r.status || "active") === "active");

  if (!active.length) {
    box.innerHTML = `<div class="card">Keine aktuellen Ausfahrten eingetragen.</div>`;
    return;
  }

  // Pro Ride meinen Status laden (best effort)
  const my = await Promise.all(active.map(async (r) => {
    try {
      const snap = await getDoc(doc(db, "rides", r.id, "rsvps", CURRENT_UID));
      if (!snap.exists()) return null;
      return (snap.data() || {}).status || null;
    } catch {
      return null;
    }
  }));

  const can = canRideRSVP();
  const isProspect = String(CURRENT_RANK || "").toLowerCase() === "prospect";

  let html = "";
  if (!can && isProspect) {
    html += `<div class="card">👁️ Prospect kann Ausfahrten sehen – Anmeldung erst ab Member.</div>`;
  }

  active.forEach((r, idx) => {
    const st = my[idx];
    const stTxt = st === "going" ? "✅ Angemeldet" : (st === "not_going" ? "❌ Abgemeldet" : "—");

    const noteHtml = r.note ? `<div>${escapeHtml(r.note)}</div>` : "";

    html += `
      <div class="card ride-card">
        <div class="ride-title">${escapeHtml(rideFmtWhere(r))}</div>
        <div class="ride-meta">📅 ${escapeHtml(rideFmtWhen(r))} • 📍 Treffpunkt: ${escapeHtml(r.meetPoint || "-")}</div>
        ${noteHtml}
        <div class="small-note">Dein Status: <b>${escapeHtml(stTxt)}</b></div>

        ${can ? `
          <div class="ride-actions">
            <button type="button" class="smallbtn" onclick="window.rideSetRsvp('${r.id}', true)">✅ Anmelden</button>
            <button type="button" class="smallbtn gray" onclick="window.rideSetRsvp('${r.id}', false)">❌ Abmelden</button>
          </div>
        ` : ``}
      </div>
    `;
  });

  box.innerHTML = html;
}

/* ---------- Tab 3: Aktuelle Fahrten (Erstellen/Verwalten) ---------- */
window.rideCreateFromUI = async () => {
  if (!canRideManage()) return alert("Nur Road Captain / Admin kann Ausfahrten erstellen.");

  const destination = $("rideDest")?.value?.trim() || "";
  const date = $("rideDate")?.value || "";
  const time = $("rideTime")?.value || "";
  const chapterType = ($("rideChapterType")?.value || "HAMC").toUpperCase();
  const otherNote = $("rideOtherNote")?.value?.trim() || "";
  const meetPoint = $("rideMeetPoint")?.value?.trim() || "";
  const note = $("rideNote")?.value?.trim() || "";

  if (!destination) return alert("Wo geht es hin? fehlt.");
  if (!date) return alert("Datum fehlt.");
  if (!time) return alert("Uhrzeit fehlt.");
  if (!meetPoint) return alert("Treffpunkt fehlt.");
  if (chapterType === "OTHER" && !otherNote) return alert("Bei „Sonstiges“ bitte Notiz ausfüllen.");

  try {
    await addDoc(collection(db, "rides"), {
      destination,
      date,
      time,
      chapterType,
      otherNote: chapterType === "OTHER" ? otherNote : "",
      meetPoint,
      note,
      status: "active",
      createdBy: CURRENT_UID,
      time: Date.now()
    });

    await window.ridesOpen("manage");
  } catch (e) {
    alert("Fehler beim Speichern: " + e.message);
  }
};

window.rideMarkDone = async (rideId) => {
  if (!canRideManage()) return;
  if (!confirm("Diese Ausfahrt als abgeschlossen markieren?")) return;

  try {
    await updateDoc(doc(db, "rides", rideId), {
      status: "done",
      doneAt: Date.now(),
      doneBy: CURRENT_UID
    });
    await window.ridesOpen("manage");
  } catch (e) {
    alert("Fehler: " + e.message);
  }
};

window.rideDelete = async (rideId) => {
  if (!canRideManage()) {
    alert("Löschen nur Road Captain / Admin.");
    return;
  }
  if (!confirm("Ausfahrt wirklich löschen?")) return;

  try {
    await deleteDoc(doc(db, "rides", rideId));
    await window.ridesOpen(RIDES_TAB || "completed");
  } catch (e) {
    alert("Fehler: " + e.message);
  }
};

window.rideToggleRsvpList = async (rideId) => {
  const box = $(`rideRsvpBox_${rideId}`);
  if (!box) return;

  if (box.getAttribute("data-open") === "1") {
    box.setAttribute("data-open", "0");
    box.innerHTML = "";
    return;
  }

  box.setAttribute("data-open", "1");
  box.innerHTML = `<div class="card">Lade Anmeldungen...</div>`;

  try {
    const snaps = await getDocs(query(collection(db, "rides", rideId, "rsvps"), limit(200)));
    const rows = [];
    snaps.forEach(d => rows.push(d.data() || {}));

    const going = rows.filter(x => x.status === "going");
    const notGoing = rows.filter(x => x.status === "not_going");

    const list = (arr) => arr.length
      ? arr.sort((a,b)=>String(a.name||"").localeCompare(String(b.name||"")))
          .map(x => `<div class="card">${escapeHtml(x.name || x.uid || "-")}</div>`).join("")
      : `<div class="card">—</div>`;

    box.innerHTML = `
      <div class="card money-good"><b>✅ Angemeldet:</b> ${going.length}</div>
      ${list(going)}
      <div class="card money-warn" style="margin-top:10px;"><b>❌ Abgemeldet:</b> ${notGoing.length}</div>
      ${list(notGoing)}
    `;
  } catch (e) {
    box.innerHTML = `<div class="card">Fehler: ${escapeHtml(e.message)}</div>`;
  }
};

async function renderRidesManage() {
  const box = $("ridesTabContent");
  if (!box) return;

  if (!canRideManage()) {
    box.innerHTML = `
      <div class="card">Nur Road Captain / Admin kann „Aktuelle Fahrten“ öffnen.</div>
      <div class="card">✅ Du kannst aber über „Anmeldung/Abmeldung“ aktuelle Fahrten sehen.</div>
    `;
    return;
  }

  const active = RIDES_CACHE.filter(r => (r.status || "active") === "active");

  box.innerHTML = `
    <div class="card">
      <h4 style="margin-top:0;">➕ Neue Ausfahrt erstellen</h4>

      <label class="field-label" for="rideDest">Wo geht es hin?</label>
      <input id="rideDest" placeholder="z.B. Berlin / Treffen / Ausfahrtziel">

      <label class="field-label" for="rideDate">Datum</label>
      <input id="rideDate" type="date">

      <label class="field-label" for="rideTime">Uhrzeit</label>
      <input id="rideTime" type="time">

      <label class="field-label" for="rideChapterType">Chapter</label>
      <select id="rideChapterType">
        <option value="HAMC">HAMC</option>
        <option value="RDMC">RDMC</option>
        <option value="OTHER">Sonstiges</option>
      </select>

      <textarea id="rideOtherNote" class="hidden" placeholder="Notiz (nur wenn Sonstiges)"></textarea>

      <label class="field-label" for="rideMeetPoint">Treffpunkt (Notiz)</label>
      <input id="rideMeetPoint" placeholder="z.B. Tankstelle XY, Adresse...">

      <textarea id="rideNote" placeholder="Optionale Notiz (Hinweise, Regeln, Route...)"></textarea>

      <button type="button" id="rideCreateBtn">💾 Ausfahrt speichern</button>
      <div class="small-note">Erstellen nur Road Captain/Admin. Anmeldung läuft über Tab „Anmeldung/Abmeldung“.</div>
    </div>

    <h4>Aktuelle Fahrten</h4>
    <div id="rideManageList">
      ${active.length ? "" : `<div class="card">Keine aktiven Ausfahrten.</div>`}
    </div>
  `;

  // Form Events
  const ct = $("rideChapterType");
  const on = $("rideOtherNote");
  if (ct && on) {
    const sync = () => {
      if (String(ct.value || "").toUpperCase() === "OTHER") on.classList.remove("hidden");
      else on.classList.add("hidden");
    };
    ct.onchange = sync;
    sync();
  }

  const createBtn = $("rideCreateBtn");
  if (createBtn) createBtn.onclick = () => window.rideCreateFromUI();

  // Active list render
  const list = $("rideManageList");
  if (!list || !active.length) return;

  let html = "";
  active.forEach(r => {
    html += `
      <div class="card ride-card">
        <div class="ride-title">${escapeHtml(rideFmtWhere(r))}</div>
        <div class="ride-meta">📅 ${escapeHtml(rideFmtWhen(r))} • 📍 Treffpunkt: ${escapeHtml(r.meetPoint || "-")}</div>
        ${r.note ? `<div>${escapeHtml(r.note)}</div>` : ``}

     <div class="ride-actions">
        <button type="button" class="smallbtn gray" onclick="window.rideToggleRsvpList('${r.id}')">👁️ Anmeldungen</button>
        <button type="button" class="smallbtn" onclick="window.rideMarkDone('${r.id}')">✅ Abschließen</button>
        ${String(CURRENT_RANK || "").toLowerCase() === "admin"
        ? `<button type="button" class="smallbtn danger" onclick="window.rideDelete('${r.id}')">🗑️ Löschen</button>`
    : ``}
</div>

        <div id="rideRsvpBox_${r.id}" data-open="0" style="margin-top:10px;"></div>
      </div>
    `;
  });

  list.innerHTML = html;
}

/* ===================================================== */
/* RIDES RIGHTS */
/* ===================================================== */

function canOpenRides() {
  // Hangaround/Supp dürfen gar nicht rein
  return !["hangaround", "supporter"].includes(String(CURRENT_RANK || "").toLowerCase());
}

function canRideRSVP() {
  // An/Abmelden erst ab Member (Prospect darf nur sehen)
  return !["hangaround", "supporter", "prospect"].includes(String(CURRENT_RANK || "").toLowerCase());
}

function canRideManage() {
  // Nur Road Chief + Admin
  return ["road_captain", "admin"].includes(String(CURRENT_RANK || "").toLowerCase());
}

/* =====================================================
   ✅ Export-Safety (MODULE -> inline onclick Fix)
   Damit inline onclick IMMER funktioniert
===================================================== */

if (typeof window.rideSetRsvp !== "function") {
  window.rideSetRsvp = async (rideId, going) => {
    // Zugriff prüfen (ab Member)
    if (!canRideRSVP()) {
      alert("Anmeldung/Abmeldung ist erst ab Member möglich.");
      return;
    }

    try {
      await setDoc(
        doc(db, "rides", rideId, "rsvps", CURRENT_UID),
        {
          uid: CURRENT_UID,
          name: userNameByUid(CURRENT_UID),
          status: going ? "going" : "not_going",
          updatedAt: Date.now()
        },
        { merge: true }
      );

      // UI neu laden
      if (typeof window.ridesOpen === "function") {
        await window.ridesOpen("rsvp");
      }
    } catch (e) {
      alert("Fehler (RSVP): " + e.message);
    }
  };
}

/* =====================================================
   ✅ INFO-BOX TOGGLES (Warn Info + Club Regeln + Meeting Regeln)
===================================================== */

window.toggleWarnInfo = () => {
  const warnBox = document.getElementById("warnInfoBox");
  const clubBox = document.getElementById("clubRulesBox");
  const meetBox = document.getElementById("meetingRulesBox");

  if (!warnBox) return;

  // immer nur eine Box offen
  if (clubBox) clubBox.classList.add("hidden");
  if (meetBox) meetBox.classList.add("hidden");

  warnBox.classList.toggle("hidden");
};

window.toggleClubRules = () => {
  const clubBox = document.getElementById("clubRulesBox");
  const warnBox = document.getElementById("warnInfoBox");
  const meetBox = document.getElementById("meetingRulesBox");

  if (!clubBox) return;

  // immer nur eine Box offen
  if (warnBox) warnBox.classList.add("hidden");
  if (meetBox) meetBox.classList.add("hidden");

  clubBox.classList.toggle("hidden");
};

window.toggleMeetingRules = () => {
  const meetBox = document.getElementById("meetingRulesBox");
  const warnBox = document.getElementById("warnInfoBox");
  const clubBox = document.getElementById("clubRulesBox");

  if (!meetBox) return;

  // immer nur eine Box offen
  if (warnBox) warnBox.classList.add("hidden");
  if (clubBox) clubBox.classList.add("hidden");

  meetBox.classList.toggle("hidden");
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
/* Rocker Points Abschnitt */
/* ===================================================== */

// ✅ R.P Modal (global für onclick="")
window.openRPModal = () => {
  const btn = document.getElementById("rpBtn");
  if (btn) {
    btn.classList.remove("btn-pop");
    void btn.offsetWidth; // reflow, damit Animation erneut startet
    btn.classList.add("btn-pop");
  }

  const modal = document.getElementById("rpModal");
  if (!modal) return;

  modal.classList.remove("hidden");

  const card = modal.querySelector(".rp-card");
  if (card) {
    card.classList.remove("pop-in");
    void card.offsetWidth;
    card.classList.add("pop-in");
  }

  window.rpOpen("dash");
};

window.closeRPModal = () => {
  document.getElementById("rpModal")?.classList.add("hidden");
};

// ✅ Tab Content
window.rpOpen = (tab) => {
  const box = document.getElementById("rpContent");
  if (!box) return;

  if (tab === "dash") {
    box.innerHTML = `
      <h4 style="margin-top:0;">📊 Übersicht</h4>
      <div class="card">Deine Rocker Points: <b><span id="rpMyPoints">...</span></b></div>
      <div class="card">Letzte Aktivität: <span id="rpLastActivity">...</span></div>
      <div class="readonly-hint">Rocker Points = Leistung / Zuverlässigkeit / Support fürs Chapter.</div>
    `;
    return;
  }

  if (tab === "earn") {
    box.innerHTML = `
      <h4 style="margin-top:0;">✅ Verdienste</h4>
      <ul>
        <li>Meeting anwesend / pünktlich</li>
        <li>Ausfahrt anwesend</li>
        <li>Chapter-Dienst (Aufbau/Abbau/Organisation)</li>
        <li>Road Support / Pannenhilfe</li>
        <li>Mentoring (Prospect begleiten)</li>
      </ul>
    `;
    return;
  }

  if (tab === "rewards") {
    box.innerHTML = `
      <h4 style="margin-top:0;">🎖️ Privilegien</h4>
      <ul>
        <li>Anträge priorisieren (Rang/Patch/Verantwortung)</li>
        <li>Verantwortungsbereiche freischalten (z.B. Orga / Road Support)</li>
        <li>Interne Benefits (z.B. Merch/Clubkasse nach Absprache)</li>
      </ul>
    `;
    return;
  }

  if (tab === "ledger") {
    box.innerHTML = `
      <h4 style="margin-top:0;">📜 Verlauf</h4>
      <div class="readonly-hint">Später: Datum • +/- Punkte • Grund • wer vergeben hat.</div>
      <div id="rpLedgerList">Lade...</div>
    `;
    return;
  }

  if (tab === "rules") {
    box.innerHTML = `
      <h4 style="margin-top:0;">📘 Regeln</h4>
      <div class="card">
        <b>Beispiel (später editierbar):</b><br>
        • Meeting anwesend: +2<br>
        • Meeting pünktlich: +1<br>
        • Ausfahrt: +3<br>
        • Chapter-Dienst: +1 bis +5<br>
        • Unentschuldigt fehlen: -3<br>
      </div>
      <div class="readonly-hint">Wichtig: klare Regeln = kein Stress.</div>
    `;
    return;
  }

  if (tab === "requests") {
    box.innerHTML = `
      <h4 style="margin-top:0;">📝 Anträge</h4>
      <ul>
        <li>Verantwortung übernehmen (Orga/Road Support)</li>
        <li>Ausfahrt-Vorschlag einreichen</li>
        <li>Meeting-Thema / Abstimmung vorschlagen</li>
      </ul>
      <div class="readonly-hint">Später als Formular + Speicherung in Firestore.</div>
    `;
    return;
  }
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

// ✅ NEW: Netto (Einnahmen - Ausgaben) in Clubkasse reinrechnen
let TREAS_LAST_STATS = null;

function treasNumInput(id) {
  const raw = String($(id)?.value ?? "").replace(",", ".").trim();
  const n = Number(raw || 0);
  return Number.isFinite(n) ? n : 0;
}

function treasCalcNet() {
  const income =
    treasNumInput("treasIncomeSponsor") +
    treasNumInput("treasIncomeRides") +
    treasNumInput("treasIncomeOther");

  const cost =
    treasNumInput("treasCostClub") +
    treasNumInput("treasCostOther");

  return { income, cost, net: income - cost };
}

function applyTreasAutoSollIst() {
  const auto = !!$("treasAutoSollIst")?.checked;
  const monthStr = $("treasMonth")?.value || "";
  if (!auto || !monthStr || !TREAS_LAST_STATS) return;

  const { net } = treasCalcNet();

  const sEl = $("treasCashSoll");
  const iEl = $("treasCashIst");

  if (sEl) sEl.value = String(Math.round((TREAS_LAST_STATS.sollTotal + net) * 100) / 100);
  if (iEl) iEl.value = String(Math.round((TREAS_LAST_STATS.istTotal + net) * 100) / 100);
}

function updateTreasNetUI() {
  const box = $("treasNetInfo");
  const { income, cost, net } = treasCalcNet();

  if (box) {
    box.innerText = `Netto (Einnahmen - Ausgaben): ${euro(net)}  |  Einnahmen: ${euro(income)}  |  Ausgaben: ${euro(cost)}`;

    box.classList.remove("money-good", "money-warn", "money-bad");
    if (net > 0) box.classList.add("money-good");
    else if (net < 0) box.classList.add("money-bad");
    else box.classList.add("money-warn");
  }

  // Auto: Cash Soll/Ist neu setzen, danach Diff aktualisieren
  applyTreasAutoSollIst();

  // ✅ WICHTIG: verhindert "schwarzer Screen", falls Funktion bei dir (noch) anders heißt / fehlt
  if (typeof updateTreasCashDiff === "function") {
    updateTreasCashDiff();
  }
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

// ✅ Dashboard: ALLE Monats-Akten zusammenrechnen (Soll/Ist + offen + Einnahmen/Ausgaben)
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

    // ✅ NEU
    let totalIncome = 0;
    let totalCost = 0;

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

      // ✅ NEU: Einnahmen/Ausgaben summieren
      const inc =
        Number(d.incomeSponsor || 0) +
        Number(d.incomeRides || 0) +
        Number(d.incomeOther || 0);

      const cst =
        Number(d.costClub || 0) +
        Number(d.costOther || 0);

      totalIncome += inc;
      totalCost += cst;
    });

    latest.innerText = `Letzter Monat: ${latestMonth} (${count} Akte(n))`;

    const net = totalIncome - totalCost;
    sollIst.innerText =
      `Clubkasse Soll/Ist (gesamt, alle Akten): ${euro(totalSoll)} / ${euro(totalIst)} (offen: ${euro(totalOffen)})\n` +
      `Einnahmen/Ausgaben (gesamt): +${euro(totalIncome)} / -${euro(totalCost)} (Netto: ${euro(net)})`;
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
    TREAS_LAST_STATS = null;
    updateTreasNetUI(); // setzt Netto/Diff sauber zurück
    return;
  }

  await ensureTreasuryMembersLoaded();

  const stats = calcMonthStatsFromCache(monthStr);
  TREAS_LAST_STATS = stats; // ✅ WICHTIG: sonst kann Netto nie in Soll/Ist rein

  const info = $("treasAutoInfo");
  if (info) {
    info.innerText = `Auto: Soll/Ist aus Member-Akten für ${monthLabelFromInput(monthStr)} (Häkchen = bezahlt).`;
  }

  // ✅ setzt Netto-UI + (wenn Auto aktiv) Cash Soll/Ist inkl. Netto
  updateTreasNetUI();

  // Offen-Liste
  renderOpenContribList(monthStr, stats);
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
    TREAS_LAST_STATS = stats;

    const { net } = treasCalcNet(); // ✅ Einnahmen - Ausgaben

    const sEl = $("treasCashSoll");
    const iEl = $("treasCashIst");

    if (sEl) sEl.value = String(Math.round((stats.sollTotal + net) * 100) / 100);
    if (iEl) iEl.value = String(Math.round((stats.istTotal + net) * 100) / 100);

    updateTreasCashDiff();
    updateTreasNetUI();
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

/* ===================================================== */
/* DEBUG / CHANGELOG (Updates / Bug Fixes) */
/* ===================================================== */

function canEditChangelog() {
  return isAdmin(); // ✅ NUR Admin
}

window.openDebugModal = async () => {
  const modal = $("debugModal");
  const adminBox = $("changelogAdminBox");
  if (!modal) return;

  // Admin Bereich nur für Officer
  if (adminBox) {
    if (canEditChangelog()) adminBox.classList.remove("hidden");
    else adminBox.classList.add("hidden");
  }

  modal.classList.remove("hidden");
  await loadChangelog();
};

window.closeDebugModal = () => {
  const modal = $("debugModal");
  if (modal) modal.classList.add("hidden");
};

async function loadChangelog() {
  const list = $("changelogList");
  if (!list) return;

  list.innerHTML = "Lade...";

  try {
    const snaps = await getDocs(
      query(collection(db, "changelog"), orderBy("time", "desc"), limit(50))
    );

    if (snaps.empty) {
      list.innerHTML = `<div class="card">Noch keine Updates eingetragen.</div>`;
      return;
    }

    let html = "";
    snaps.forEach(ds => {
      const d = ds.data() || {};
      const type = String(d.type || "info");
      const cls = type === "bugfix" ? "chlog-bugfix" : (type === "feature" ? "chlog-feature" : "chlog-info");

      const when = d.time ? new Date(d.time).toLocaleString() : "";
      const by = d.createdBy ? userNameByUid(d.createdBy) : "-";

      const delBtn = canEditChangelog()
        ? `<button class="smallbtn danger" type="button" onclick="deleteChangelogEntry('${ds.id}')">Löschen</button>`
        : "";

      html += `
        <div class="chlog-item ${cls}">
          <div class="chlog-meta">
            <b>${escapeHtml(d.title || "-")}</b> • ${escapeHtml(type.toUpperCase())} • ${escapeHtml(when)} • von: ${escapeHtml(by)}
          </div>
          <div>${escapeHtml(d.text || "").replace(/\n/g, "<br>")}</div>
          ${delBtn ? `<div style="margin-top:10px;">${delBtn}</div>` : ""}
        </div>
      `;
    });

    list.innerHTML = html;

  } catch (e) {
    list.innerHTML = `<div class="card">Fehler: ${escapeHtml(e.message)}</div>`;
  }
}

async function addChangelogEntry() {
  if (!canEditChangelog()) return alert("Keine Berechtigung");

  const type = $("changelogType")?.value || "bugfix";
  const title = ($("changelogTitle")?.value || "").trim();
  const text = ($("changelogText")?.value || "").trim();

  if (!title || !text) return alert("Titel und Text sind Pflicht");

  try {
    await addDoc(collection(db, "changelog"), {
      type,
      title,
      text,
      createdBy: CURRENT_UID,
      time: Date.now()
    });

    if ($("changelogTitle")) $("changelogTitle").value = "";
    if ($("changelogText")) $("changelogText").value = "";

    await loadChangelog();
  } catch (e) {
    alert("Speichern fehlgeschlagen: " + e.message);
  }
}

window.deleteChangelogEntry = async (id) => {
  if (!canEditChangelog()) return alert("Keine Berechtigung");
  if (!confirm("Eintrag wirklich löschen?")) return;

  try {
    await deleteDoc(doc(db, "changelog", id));
    await loadChangelog();
  } catch (e) {
    alert("Löschen fehlgeschlagen: " + e.message);
  }
};

// =========================
// RP Bereich: aktuell gesperrt
// =========================
const RP_ENABLED = false;

function openRpDisabledModal() {
  const backdrop = document.getElementById("rpDisabledBackdrop");
  if (!backdrop) {
    alert("Dieser Bereich ist aktuell nicht zugänglich.");
    return;
  }
  backdrop.classList.remove("hidden");
}

function closeRpDisabledModal() {
  const backdrop = document.getElementById("rpDisabledBackdrop");
  if (backdrop) backdrop.classList.add("hidden");
}

// OK Button + Klick außerhalb schließt
document.addEventListener("click", (e) => {
  if (e.target && e.target.id === "rpDisabledOk") closeRpDisabledModal();
  if (e.target && e.target.id === "rpDisabledBackdrop") closeRpDisabledModal();
});

// WICHTIG: Capture-Listener blockt auch inline onclick / Navigation
document.addEventListener("click", (e) => {
  const rpTrigger = e.target.closest?.('[data-feature="rp"]');
  if (!rpTrigger) return;

  if (!RP_ENABLED) {
    e.preventDefault();
    e.stopPropagation(); // stoppt, bevor onclick / andere Handler feuern
    openRpDisabledModal();
  }
}, true);

/* ===================================================== */
/* ✅ CALENDAR */
/* ===================================================== */

let CALENDAR_CURRENT_MONTH = new Date().toISOString().slice(0, 7);
let CALENDAR_SELECTED_DAY = null;
let CALENDAR_CACHE = new Map();

function canManageCalendar() {
  return ["road_captain", "admin"].includes(String(CURRENT_RANK || "").toLowerCase());
}

function calMonthLabel(monthStr) {
  const [y, m] = String(monthStr || "").split("-");
  const names = ["Januar","Februar","März","April","Mai","Juni","Juli","August","September","Oktober","November","Dezember"];
  const idx = Number(m) - 1;
  return idx >= 0 ? `${names[idx]} ${y}` : monthStr;
}

function calHumanDate(iso) {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString("de-DE", { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" });
}

function calWeekdayHeaders() {
  return ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
}

function calStartOffset(year, monthZeroBased) {
  const jsDay = new Date(year, monthZeroBased, 1).getDay(); // 0=So
  return jsDay === 0 ? 6 : jsDay - 1; // Mo=0
}

function calDaysInMonth(year, monthZeroBased) {
  return new Date(year, monthZeroBased + 1, 0).getDate();
}

window.showCalendarPanel = async () => {
  window.showScreen("calendarScreen");

  const monthInput = $("calMonthInput");
  if (monthInput && !monthInput.value) monthInput.value = CALENDAR_CURRENT_MONTH;

  await loadCalendarMonth(monthInput?.value || CALENDAR_CURRENT_MONTH);
};

async function loadCalendarMonth(monthStr) {
  CALENDAR_CURRENT_MONTH = monthStr || new Date().toISOString().slice(0, 7);

  const monthInput = $("calMonthInput");
  if (monthInput) monthInput.value = CALENDAR_CURRENT_MONTH;

  CALENDAR_CACHE.clear();

  try {
    const snaps = await getDocs(
      query(collection(db, "calendar_days"), where("month", "==", CALENDAR_CURRENT_MONTH))
    );

    snaps.forEach((ds) => {
      CALENDAR_CACHE.set(ds.id, { id: ds.id, ...(ds.data() || {}) });
    });
  } catch (e) {
    console.warn("loadCalendarMonth failed:", e);
  }

  renderCalendarGrid(CALENDAR_CURRENT_MONTH);
}

function renderCalendarGrid(monthStr) {
  const grid = $("calendarGrid");
  if (!grid) return;

  const [yearStr, monthStrNum] = String(monthStr).split("-");
  const year = Number(yearStr);
  const monthZero = Number(monthStrNum) - 1;

  const totalDays = calDaysInMonth(year, monthZero);
  const offset = calStartOffset(year, monthZero);

  let html = "";

  calWeekdayHeaders().forEach((w) => {
    html += `<div class="calendar-weekday">${w}</div>`;
  });

  for (let i = 0; i < offset; i++) {
    html += `<div class="calendar-day calendar-blank"></div>`;
  }

  for (let day = 1; day <= totalDays; day++) {
    const dayIso = `${year}-${String(monthZero + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const entry = CALENDAR_CACHE.get(dayIso);

    let cls = "day-empty";
    if (entry) cls = entry.status === "done" ? "day-done" : "day-open";

    const preview = entry
      ? `${entry.required ? "⚠️ " : ""}${escapeHtml(entry.destination || entry.type || "Eintrag")}<br>${escapeHtml(entry.time || "")}`
      : `Kein Eintrag`;

    html += `
      <div class="calendar-day ${cls}" onclick="window.openCalendarDay('${dayIso}')">
        <div class="calendar-day-num">${day}</div>
        <div class="calendar-day-text">${preview}</div>
      </div>
    `;
  }

  grid.innerHTML = html;
}

window.openCalendarDay = async (dayIso) => {
  CALENDAR_SELECTED_DAY = dayIso;

  const modal = $("calendarDayModal");
  if (!modal) return;

  $("calDayModalTitle").innerText = `📅 ${calHumanDate(dayIso)}`;

  let entry = CALENDAR_CACHE.get(dayIso) || null;
  if (!entry) {
    try {
      const snap = await getDoc(doc(db, "calendar_days", dayIso));
      if (snap.exists()) {
        entry = { id: snap.id, ...(snap.data() || {}) };
        CALENDAR_CACHE.set(dayIso, entry);
      }
    } catch (e) {
      console.warn("openCalendarDay getDoc failed:", e);
    }
  }

  fillCalendarDayModal(entry);
  modal.classList.remove("hidden");
  await loadCalendarRsvps(dayIso, !!entry);
};

window.closeCalendarDayModal = () => {
  const modal = $("calendarDayModal");
  if (modal) modal.classList.add("hidden");
};

function fillCalendarDayModal(entry) {
  const manager = canManageCalendar();
  const hasEntry = !!entry;

  setText("calReadDestination", entry?.destination || "-");
  setText("calReadTime", entry?.time || "-");
  setText("calReadMeetPoint", entry?.meetPoint || "-");
  setText("calReadCost", entry?.cost != null && entry?.cost !== "" ? `${Number(entry.cost).toFixed(2)}€` : "-");
  setText("calReadType", entry?.type || "-");
  setText("calReadStatus", entry?.status === "done" ? "Abgeschlossen" : (hasEntry ? "Aktiv" : "Kein Eintrag"));
  setText("calReadNote", entry?.note || "-");
    // ✅ NEU: Pflicht / Max / Link + Meta
  setText("calReadRequired", entry?.required ? "✅ Ja" : "—");
  setText("calReadMax", entry?.maxParticipants ? String(entry.maxParticipants) : "—");

  // Link als klickbarer Anchor (nur http/https)
  const linkBox = document.getElementById("calReadLink");
  if (linkBox) {
    const raw = String(entry?.routeLink || "").trim();
    if (raw && /^https?:\/\//i.test(raw)) {
      const safe = escapeAttr(raw);
      linkBox.innerHTML = `<a href="${safe}" target="_blank" rel="noopener">Link öffnen</a>`;
    } else {
      linkBox.innerText = "—";
    }
  }

  const createdBy = entry?.createdBy ? userNameByUid(entry.createdBy) : "—";
  const createdAt = entry?.time ? new Date(entry.time).toLocaleString("de-DE") : "";
  setText("calReadCreated", createdAt ? `${createdBy} (${createdAt})` : createdBy);

  const upd = entry?.updatedAt ? new Date(entry.updatedAt).toLocaleString("de-DE") : "—";
  setText("calReadUpdated", upd);

  const doneTxt = entry?.status === "done"
    ? `${entry?.doneAt ? new Date(entry.doneAt).toLocaleString("de-DE") : ""} ${entry?.doneBy ? "• " + userNameByUid(entry.doneBy) : ""}`.trim()
    : "—";
  setText("calReadDone", doneTxt || "—");

  const dest = $("calDestination");
  const time = $("calTime");
  const cost = $("calCost");
  const meet = $("calMeetPoint");
  const type = $("calType");
  const note = $("calNote");
    // ✅ NEU: zusätzliche Edit-Felder
  const req = $("calRequired");
  const maxP = $("calMaxParticipants");
  const link = $("calRouteLink");

  if (dest) dest.value = entry?.destination || "";
  if (time) time.value = entry?.time || "";
  if (cost) cost.value = entry?.cost ?? "";
  if (meet) meet.value = entry?.meetPoint || "";
  if (type) type.value = entry?.type || "ausfahrt";
  if (note) note.value = entry?.note || "";
  if (req) req.checked = !!entry?.required;
  if (maxP) maxP.value = entry?.maxParticipants ? String(entry.maxParticipants) : "";
  if (link) link.value = entry?.routeLink || "";

  [dest, time, cost, meet, type, note, req, maxP, link].forEach((el) => {
    if (el) el.disabled = !manager;
  });

  const saveBtn = $("calSaveBtn");
  const doneBtn = $("calDoneBtn");
  const reopenBtn = $("calReopenBtn");
  const hint = $("calManageHint");

  if (saveBtn) saveBtn.style.display = manager ? "block" : "none";
  if (doneBtn) doneBtn.style.display = manager && hasEntry && entry?.status !== "done" ? "block" : "none";
  if (reopenBtn) reopenBtn.style.display = manager && hasEntry && entry?.status === "done" ? "block" : "none";

  if (hint) {
    hint.innerText = manager
      ? "Du kannst diesen Tag bearbeiten und abschließen."
      : "Nur Road Captain / Admin kann den Tag bearbeiten. Du kannst unten bestätigen oder ablehnen.";
  }

  const rsvpBox = $("calRsvpBox");
  if (rsvpBox) rsvpBox.style.display = hasEntry ? "block" : "none";

  // ✅ FIX: Maps-Button MUSS in der Funktion sein (sonst "entry is not defined")
  const mapsBtn = $("calMapsBtn");
  if (mapsBtn) {
    const q = String(entry?.meetPoint || "").trim();
    if (hasEntry && q) {
      mapsBtn.style.display = "block";
      mapsBtn.onclick = () => {
        const url = "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(q);
        window.open(url, "_blank");
      };
    } else {
      mapsBtn.style.display = "none";
      mapsBtn.onclick = null;
    }
  }
}

window.saveCalendarDay = async () => {
  if (!canManageCalendar()) return alert("Nur Road Captain / Admin darf den Tag bearbeiten.");
  if (!CALENDAR_SELECTED_DAY) return;

  const destination = $("calDestination")?.value?.trim() || "";
  const time = $("calTime")?.value || "";
  const cost = Number($("calCost")?.value || 0);
  const meetPoint = $("calMeetPoint")?.value?.trim() || "";
  const type = $("calType")?.value || "ausfahrt";
  const note = $("calNote")?.value?.trim() || "";
  const required = !!$("calRequired")?.checked;
  const maxParticipants = Number($("calMaxParticipants")?.value || 0);
  const routeLink = ($("calRouteLink")?.value || "").trim();

  if (!destination) return alert("Bitte 'Ausfahrt nach' eintragen.");

  const payload = {
    date: CALENDAR_SELECTED_DAY,
    month: CALENDAR_SELECTED_DAY.slice(0, 7),
    destination,
    time,
    cost,
    meetPoint,
    type,
    note,

    // ✅ NEU
    required,
    maxParticipants: maxParticipants > 0 ? maxParticipants : 0,
    routeLink,

    status: (CALENDAR_CACHE.get(CALENDAR_SELECTED_DAY)?.status || "open"),
    updatedBy: CURRENT_UID,
    updatedAt: Date.now()
  };

  try {
    const existing = await getDoc(doc(db, "calendar_days", CALENDAR_SELECTED_DAY));
    if (existing.exists()) {
      await updateDoc(doc(db, "calendar_days", CALENDAR_SELECTED_DAY), payload);
    } else {
      await setDoc(doc(db, "calendar_days", CALENDAR_SELECTED_DAY), {
        ...payload,
        createdBy: CURRENT_UID,
        time: Date.now()
      });
    }

    await loadCalendarMonth(CALENDAR_CURRENT_MONTH);
    const snap = await getDoc(doc(db, "calendar_days", CALENDAR_SELECTED_DAY));
    fillCalendarDayModal({ id: snap.id, ...(snap.data() || {}) });
    await loadCalendarRsvps(CALENDAR_SELECTED_DAY, true);
  } catch (e) {
    alert("Speichern fehlgeschlagen: " + e.message);
  }
};

window.markCalendarDayDone = async () => {
  if (!canManageCalendar()) return alert("Keine Berechtigung.");
  if (!CALENDAR_SELECTED_DAY) return;

  try {
    await updateDoc(doc(db, "calendar_days", CALENDAR_SELECTED_DAY), {
      status: "done",
      doneBy: CURRENT_UID,
      doneAt: Date.now(),
      updatedAt: Date.now()
    });

    await loadCalendarMonth(CALENDAR_CURRENT_MONTH);
    const snap = await getDoc(doc(db, "calendar_days", CALENDAR_SELECTED_DAY));
    fillCalendarDayModal({ id: snap.id, ...(snap.data() || {}) });
  } catch (e) {
    alert("Abschließen fehlgeschlagen: " + e.message);
  }
};

window.reopenCalendarDay = async () => {
  if (!canManageCalendar()) return alert("Keine Berechtigung.");
  if (!CALENDAR_SELECTED_DAY) return;

  try {
    await updateDoc(doc(db, "calendar_days", CALENDAR_SELECTED_DAY), {
      status: "open",
      updatedAt: Date.now()
    });

    await loadCalendarMonth(CALENDAR_CURRENT_MONTH);
    const snap = await getDoc(doc(db, "calendar_days", CALENDAR_SELECTED_DAY));
    fillCalendarDayModal({ id: snap.id, ...(snap.data() || {}) });
  } catch (e) {
    alert("Wieder öffnen fehlgeschlagen: " + e.message);
  }
};

window.setCalendarRsvp = async (status) => {
  if (!CALENDAR_SELECTED_DAY) return;

  const entry = CALENDAR_CACHE.get(CALENDAR_SELECTED_DAY);
  if (!entry) return alert("Für diesen Tag ist noch nichts eingetragen.");

  try {
    await setDoc(
      doc(db, "calendar_days", CALENDAR_SELECTED_DAY, "rsvps", CURRENT_UID),
      {
        uid: CURRENT_UID,
        name: userNameByUid(CURRENT_UID),
        status,
        updatedAt: Date.now()
      },
      { merge: true }
    );

    await loadCalendarRsvps(CALENDAR_SELECTED_DAY, true);
  } catch (e) {
    alert("Bestätigung/Ablehnung fehlgeschlagen: " + e.message);
  }
};

async function loadCalendarRsvps(dayIso, hasEntry) {
  const myBox = $("calMyRsvpStatus");
  const list = $("calRsvpList");

  if (!hasEntry) {
    if (myBox) myBox.innerText = "Kein Eintrag vorhanden.";
    if (list) list.innerHTML = `<div class="card">Noch keine Rückmeldungen.</div>`;
    return;
  }

  try {
    const mySnap = await getDoc(doc(db, "calendar_days", dayIso, "rsvps", CURRENT_UID));
    if (mySnap.exists()) {
      const d = mySnap.data() || {};
      const txt = d.status === "confirmed" ? "✅ Bestätigt" : "❌ Abgelehnt";
      const when = d.updatedAt ? new Date(d.updatedAt).toLocaleString("de-DE") : "-";
      if (myBox) myBox.innerText = `Dein Status: ${txt} (${when})`;
    } else {
      if (myBox) myBox.innerText = "Kein Status gesetzt.";
    }
  } catch {
    if (myBox) myBox.innerText = "Dein Status konnte nicht geladen werden.";
  }

  try {
    const snaps = await getDocs(collection(db, "calendar_days", dayIso, "rsvps"));
    const rows = [];
    snaps.forEach((ds) => rows.push(ds.data() || {}));
    rows.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));

    if (!rows.length) {
      if (list) list.innerHTML = `<div class="card">Noch keine Rückmeldungen.</div>`;
      return;
    }

    if (list) {
      list.innerHTML = rows.map((r) => {
        const st = r.status === "confirmed" ? "✅ Bestätigt" : "❌ Abgelehnt";
        const when = r.updatedAt ? new Date(r.updatedAt).toLocaleString("de-DE") : "-";
        return `
          <div class="card">
            <b>${escapeHtml(r.name || r.uid || "-")}</b><br>
            ${st}<br>
            <small>${escapeHtml(when)}</small>
          </div>
        `;
      }).join("");
    }
  } catch (e) {
    if (list) list.innerHTML = `<div class="card">Fehler beim Laden: ${escapeHtml(e.message)}</div>`;
  }
}
