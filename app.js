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

/* Member Directory (Member Info Bereich) */
let MEMBER_DIR_CACHE = [];
let MEMBER_SELECTED_UID = null;

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

/* ✅ NEU: B) Rechte-Helper ergänzen (HIER EINFÜGEN) */
function isSergeantAtArms() {
  return ["sergeant_at_arms", "admin"].includes(String(CURRENT_RANK || "").toLowerCase());
}

function canManageMemberDirectory() {
  // wer Member anlegen/löschen darf:
  return hasOfficerRights() || isAdmin();
}

/* ✅ HIER gehört deine UI-Rechte-Logik rein */
function applyRankRights(rank) {
  const postInfoBtn = $("postInfoBtn");
  const createRideBtn = $("createRideBtn");

  if (postInfoBtn) postInfoBtn.classList.remove("hidden");

  if (createRideBtn) {
    const canCreateRide = ["president", "vice_president", "sergeant_at_arms", "road_captain", "admin"].includes(rank);
    if (canCreateRide) createRideBtn.classList.remove("hidden");
    else createRideBtn.classList.add("hidden");
  }

  const ridesNavBtn = $("ridesNavBtn");
  if (ridesNavBtn) {
    const r = String(rank || "").toLowerCase();
    const blocked = (r === "hangaround" || r === "supporter");
    if (blocked) ridesNavBtn.classList.add("hidden");
    else ridesNavBtn.classList.remove("hidden");
  }
}

/* ===================================================== */
/* SETTINGS (LocalStorage) + FLOATING BACK */
/* ===================================================== */

const SETTINGS_KEY = "bdz_settings_v1";

let APP_SETTINGS = {
  floatingBackEnabled: true,
  floatingBackLocked: true,
  floatingBackPos: null // {x, y} in px (left/top)
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      APP_SETTINGS = { ...APP_SETTINGS, ...parsed };
    }
  } catch (e) {}
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(APP_SETTINGS));
  } catch (e) {}
}

function openSettingsModal() {
  const modal = $("settingsModal");
  if (!modal) return;

  // UI sync
  const t1 = $("toggleFloatingBack");
  const t2 = $("toggleLockFloatingBack");
  if (t1) t1.checked = !!APP_SETTINGS.floatingBackEnabled;
  if (t2) t2.checked = !!APP_SETTINGS.floatingBackLocked;

  modal.classList.remove("hidden");
  modal.classList.add("show");
  modal.setAttribute("aria-hidden", "false");
}

function closeSettingsModal() {
  const modal = $("settingsModal");
  if (!modal) return;

  modal.classList.remove("show");
  modal.setAttribute("aria-hidden", "true");

  // kleine Delay damit Animation sauber ausläuft
  setTimeout(() => {
    modal.classList.add("hidden");
  }, 180);
}

/* ✅ Back-Fallback: nutzt deine App-Back Funktion wenn vorhanden */
function smartBackAction() {
  // 1) wenn du eine eigene Funktion hast, wird die genutzt
  if (typeof window.goBack === "function") return window.goBack();
  if (typeof window.back === "function") return window.back();

  // 2) wenn ein Modal offen ist, erst schließen (optional)
  // (wenn du ein zentrales Modal-System hast, kannst du das erweitern)

  // 3) Browser fallback
  window.history.back();
}

function applyFloatingBackUI() {
  const btn = $("floatingBackBtn");
  if (!btn) return;

  // anzeigen/ausblenden
  if (APP_SETTINGS.floatingBackEnabled) btn.classList.remove("hidden");
  else btn.classList.add("hidden");

  // lock/unlock styling
  if (!APP_SETTINGS.floatingBackLocked) btn.classList.add("unlocked");
  else btn.classList.remove("unlocked");

  // position anwenden
  if (APP_SETTINGS.floatingBackPos && typeof APP_SETTINGS.floatingBackPos.x === "number") {
    btn.style.left = APP_SETTINGS.floatingBackPos.x + "px";
    btn.style.top = APP_SETTINGS.floatingBackPos.y + "px";
    btn.style.right = "auto";
    btn.style.bottom = "auto";
  } else {
    // Standard unten rechts
    btn.style.left = "auto";
    btn.style.top = "auto";
    btn.style.right = "14px";
    btn.style.bottom = "calc(14px + env(safe-area-inset-bottom))";
  }
}

/* ✅ clamp so dass button nicht aus dem screen wandert */
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function resetFloatingBackPos() {
  APP_SETTINGS.floatingBackPos = null;
  saveSettings();
  applyFloatingBackUI();
}

/* ✅ Drag handling (Touch + Mouse via Pointer Events) */
function initFloatingBackDrag() {
  const btn = $("floatingBackBtn");
  if (!btn) return;

  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;
  let moved = 0;

  // click -> back (auch wenn gelockt)
  btn.addEventListener("click", (e) => {
    // Wenn wirklich gezogen wurde, click nicht als back auslösen
    if (moved > 6) return;
    smartBackAction();
  });

  btn.addEventListener("pointerdown", (e) => {
    if (!APP_SETTINGS.floatingBackEnabled) return;

    moved = 0;

    // wenn gelockt: nicht draggen – aber click bleibt möglich
    if (APP_SETTINGS.floatingBackLocked) return;

    dragging = true;
    btn.setPointerCapture(e.pointerId);

    const rect = btn.getBoundingClientRect();
    startX = e.clientX;
    startY = e.clientY;
    startLeft = rect.left;
    startTop = rect.top;

    // während dragging absolute left/top benutzen
    btn.style.left = rect.left + "px";
    btn.style.top = rect.top + "px";
    btn.style.right = "auto";
    btn.style.bottom = "auto";
  });

  btn.addEventListener("pointermove", (e) => {
    if (!dragging) return;

    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    moved = Math.max(moved, Math.abs(dx) + Math.abs(dy));

    const w = btn.offsetWidth || 48;
    const h = btn.offsetHeight || 48;

    const maxX = window.innerWidth - w - 6;
    const maxY = window.innerHeight - h - 6;

    const newLeft = clamp(startLeft + dx, 6, maxX);
    const newTop = clamp(startTop + dy, 6, maxY);

    btn.style.left = newLeft + "px";
    btn.style.top = newTop + "px";
  });

  function endDrag(e) {
    if (!dragging) return;
    dragging = false;

    const rect = btn.getBoundingClientRect();
    APP_SETTINGS.floatingBackPos = { x: Math.round(rect.left), y: Math.round(rect.top) };
    saveSettings();
    applyFloatingBackUI();
  }

  btn.addEventListener("pointerup", endDrag);
  btn.addEventListener("pointercancel", endDrag);

  window.addEventListener("resize", () => {
    // wenn position gespeichert ist -> neu clampen
    if (!APP_SETTINGS.floatingBackPos) return;
    const w = btn.offsetWidth || 48;
    const h = btn.offsetHeight || 48;
    const maxX = window.innerWidth - w - 6;
    const maxY = window.innerHeight - h - 6;
    APP_SETTINGS.floatingBackPos.x = clamp(APP_SETTINGS.floatingBackPos.x, 6, maxX);
    APP_SETTINGS.floatingBackPos.y = clamp(APP_SETTINGS.floatingBackPos.y, 6, maxY);
    saveSettings();
    applyFloatingBackUI();
  });
}

/* ✅ EINMAL beim App-Start aufrufen */
function initSettingsAndFloatingBack() {
  loadSettings();
  applyFloatingBackUI();
  initFloatingBackDrag();
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

  // ✅ Settings
  const settingsBtn = $("settingsBtn");
  if (settingsBtn) settingsBtn.onclick = () => openSettingsModal();

  const settingsClose = $("settingsCloseBtn");
  if (settingsClose) settingsClose.onclick = () => closeSettingsModal();

  const settingsBackdrop = $("settingsBackdrop");
  if (settingsBackdrop) settingsBackdrop.onclick = () => closeSettingsModal();

  const toggleFloatingBack = $("toggleFloatingBack");
  if (toggleFloatingBack) toggleFloatingBack.onchange = () => {
    APP_SETTINGS.floatingBackEnabled = !!toggleFloatingBack.checked;
    saveSettings();
    applyFloatingBackUI();
  };

  const toggleLockFloatingBack = $("toggleLockFloatingBack");
  if (toggleLockFloatingBack) toggleLockFloatingBack.onchange = () => {
    APP_SETTINGS.floatingBackLocked = !!toggleLockFloatingBack.checked;
    saveSettings();
    applyFloatingBackUI();
  };

  const resetPosBtn = $("resetFloatingBackPosBtn");
  if (resetPosBtn) resetPosBtn.onclick = () => resetFloatingBackPos();

  // ✅ Member Info (NEU)
  const memberInfoBtn = $("memberInfoBtn");
  if (memberInfoBtn) memberInfoBtn.onclick = () => window.openMemberInfoModal();

  const memberSearch = $("memberInfoSearch");
  if (memberSearch) memberSearch.oninput = () => window.renderMemberInfoList();

  const memberAddOpenBtn = $("memberAddOpenBtn");
  if (memberAddOpenBtn) memberAddOpenBtn.onclick = () => window.openMemberAddModal();

  const maSave = $("maSaveBtn");
  if (maSave) maSave.onclick = () => window.saveNewMember();

  const mdSend = $("mdSendRequestBtn");
  if (mdSend) mdSend.onclick = () => window.sendMyMemberInfoRequest();

  const mdDel = $("mdDeleteMemberBtn");
  if (mdDel) mdDel.onclick = () => window.deleteSelectedMember();

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

  // ✅ Netto live berechnen sobald man Einnahmen/Ausgaben tippt
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

  // ✅ Settings + Floating Back initialisieren
  initSettingsAndFloatingBack();
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

/* =====================================================
   SECRETARY NEU – MEETING / MEETING INFO
   Ansicht: Secretary, President, Vice, Sergeant, Admin
   Bearbeiten: NUR Secretary
   Collection: secretary_meetings_v2
===================================================== */

let SEC_MEETING_CACHE = [];
let SEC_EDIT_MEETING_ID = null;
let SEC_BACK_VIEW = "edit";

/* =========================
   Rechte im Frontend
========================= */

function canViewSecretaryArea() {
  const r = String(CURRENT_RANK || "").toLowerCase();
  return ["secretary", "president", "vice_president", "sergeant_at_arms", "admin"].includes(r);
}

function canEditSecretaryArea() {
  return String(CURRENT_RANK || "").toLowerCase() === "secretary";
}

function secBox() {
  return $("secNewContent");
}

function secTodayISO() {
  return new Date().toISOString().slice(0, 10);
}

function secDateDE(iso) {
  if (!iso) return "-";
  try {
    return new Date(`${iso}T00:00:00`).toLocaleDateString("de-DE");
  } catch {
    return iso;
  }
}

function secMeetingRef(id) {
  return doc(db, "secretary_meetings_v2", id);
}

function secMeetingColl() {
  return collection(db, "secretary_meetings_v2");
}

/* ✅ Überschreibt den alten Secretary-Start */
window.showSecretaryPanel = async () => {
  if (!canViewSecretaryArea()) {
    alert("Kein Zugriff");
    return;
  }

  window.showScreen("secretaryScreen");
  await window.secOpenMeetingMenu();
};

/* =====================================================
   HAUPTMENÜ: MEETING
===================================================== */

window.secOpenMeetingMenu = async () => {
  if (!canViewSecretaryArea()) return alert("Kein Zugriff");

  const box = secBox();
  if (!box) return;

  const canEdit = canEditSecretaryArea();

  box.innerHTML = `
    <div class="card">
      <h3>🗓️ Meeting</h3>

      <div class="secretary-meeting-grid">
        <button type="button" onclick="window.secOpenMeetingEdit()">1. Bearbeitung</button>
        <button type="button" onclick="window.secOpenMeetingDone()">2. Erledigt</button>
        ${
          canEdit
            ? `<button type="button" class="danger" onclick="window.secCreateNoMeeting()">3. No Meeting</button>`
            : `<button type="button" class="danger" disabled>3. No Meeting – nur Secretary</button>`
        }
      </div>

      <div class="small-note">
        Gelb = in Bearbeitung · Grün = erledigt · Rot = Es gab kein Meeting
      </div>

      ${
        canEdit
          ? `<div class="small-note">Du bist Secretary: Du darfst bearbeiten.</div>`
          : `<div class="small-note">Nur Ansicht: Bearbeiten darf nur der Secretary.</div>`
      }
    </div>

    <div id="secMeetingContent"></div>
  `;

  await window.secOpenMeetingEdit();
};

async function secLoadMeetings() {
  SEC_MEETING_CACHE = [];

  try {
    const snaps = await getDocs(
      query(
        collection(db, "secretary_meetings_v2"),
        orderBy("meetingDate", "desc"),
        limit(300)
      )
    );

    snaps.forEach((ds) => {
      SEC_MEETING_CACHE.push({
        id: ds.id,
        ...(ds.data() || {})
      });
    });
  } catch (e) {
    const box = $("secMeetingContent");
    if (box) {
      box.innerHTML = `<div class="card">Fehler beim Laden: ${escapeHtml(e.message)}</div>`;
    }
  }
}

/* =====================================================
   1. BEARBEITUNG
===================================================== */

window.secOpenMeetingEdit = async () => {
  if (!canViewSecretaryArea()) return alert("Kein Zugriff");

  SEC_EDIT_MEETING_ID = null;
  SEC_BACK_VIEW = "edit";

  const box = $("secMeetingContent");
  if (!box) return;

  await secLoadMeetings();

  const canEdit = canEditSecretaryArea();

  const openMeetings = SEC_MEETING_CACHE
    .filter((m) => (m.status || "open") === "open" && m.kind !== "no_meeting")
    .sort((a, b) => String(b.meetingDate || "").localeCompare(String(a.meetingDate || "")));

  box.innerHTML = `
    ${
      canEdit
        ? `
          <div class="card">
            <h3>🟡 Bearbeitung</h3>

            <label class="field-label">Datum</label>
            <input id="secMeetingDate" type="date" value="${secTodayISO()}">

            <label class="field-label">Meeting Nummer</label>
            <input id="secMeetingNumber" placeholder="z.B. Meeting 1 / 001 / Vorstand 01">

            <label class="field-label">Info / Notiz optional</label>
            <textarea id="secMeetingInfo" placeholder="Optional: Was ist vorbereitet, was fehlt, worum geht es?"></textarea>

            <button type="button" onclick="window.secSaveMeeting()">💾 Meeting speichern</button>
          </div>
        `
        : `
          <div class="card">
            <h3>🟡 Bearbeitung</h3>
            <div class="small-note">Nur Ansicht. Neue Meetings darf nur der Secretary anlegen.</div>
          </div>
        `
    }

    <h3>Offene Meetings</h3>
    <div id="secOpenMeetingList">
      ${
        openMeetings.length
          ? openMeetings.map(secRenderOpenMeetingCard).join("")
          : `<div class="card">Keine offenen Meetings vorhanden.</div>`
      }
    </div>
  `;
};

function secRenderOpenMeetingCard(m) {
  const canEdit = canEditSecretaryArea();

  return `
    <div class="card sec-meeting-card sec-meeting-open">
      <b>${escapeHtml(m.meetingNumber || "Meeting")}</b><br>
      Datum: ${escapeHtml(secDateDE(m.meetingDate))}<br>

      ${
        m.info
          ? `<div class="small-note" style="margin-top:8px;">${escapeHtml(m.info).replace(/\n/g, "<br>")}</div>`
          : `<div class="small-note" style="margin-top:8px;">Keine Info eingetragen.</div>`
      }

      ${
        canEdit
          ? `
            <div class="row" style="margin-top:10px;">
              <button type="button" class="smallbtn gray" onclick="window.secEditMeeting('${m.id}', 'edit')">Bearbeiten</button>
              <button type="button" class="smallbtn" onclick="window.secMarkMeetingDone('${m.id}')">✅ Als erledigt markieren</button>
              <button type="button" class="smallbtn danger" onclick="window.secDeleteMeeting('${m.id}', 'edit')">🗑️ Löschen</button>
            </div>
          `
          : `<div class="small-note" style="margin-top:10px;">Nur Ansicht</div>`
      }
    </div>
  `;
}

window.secSaveMeeting = async () => {
  if (!canEditSecretaryArea()) return alert("Nur der Secretary darf speichern.");

  const meetingDate = $("secMeetingDate")?.value || "";
  const meetingNumber = $("secMeetingNumber")?.value?.trim() || "";
  const info = $("secMeetingInfo")?.value?.trim() || "";

  if (!meetingDate) return alert("Datum fehlt.");
  if (!meetingNumber) return alert("Meeting Nummer fehlt.");

  const payload = {
    kind: "meeting",
    meetingDate,
    meetingNumber,
    info,
    status: "open",
    updatedBy: CURRENT_UID,
    updatedAt: Date.now()
  };

  try {
    if (SEC_EDIT_MEETING_ID) {
      await updateDoc(secMeetingRef(SEC_EDIT_MEETING_ID), payload);
    } else {
      await addDoc(secMeetingColl(), {
        ...payload,
        createdBy: CURRENT_UID,
        createdAt: Date.now()
      });
    }

    SEC_EDIT_MEETING_ID = null;
    await window.secOpenMeetingEdit();
  } catch (e) {
    alert("Speichern fehlgeschlagen: " + e.message);
  }
};

/* =====================================================
   2. ERLEDIGT
===================================================== */

window.secOpenMeetingDone = async () => {
  if (!canViewSecretaryArea()) return alert("Kein Zugriff");

  SEC_EDIT_MEETING_ID = null;
  SEC_BACK_VIEW = "done";

  const box = $("secMeetingContent");
  if (!box) return;

  await secLoadMeetings();

  const openMeetings = SEC_MEETING_CACHE
    .filter((m) => (m.status || "open") === "open" && m.kind !== "no_meeting")
    .sort((a, b) => String(b.meetingDate || "").localeCompare(String(a.meetingDate || "")));

  const doneMeetings = SEC_MEETING_CACHE
    .filter((m) => (m.status || "open") === "done")
    .sort((a, b) => String(b.meetingDate || "").localeCompare(String(a.meetingDate || "")));

  box.innerHTML = `
    <div class="card">
      <h3>🟢 Erledigt</h3>
      <div class="small-note">
        Hier siehst du offene Meetings zum Abschließen und alle erledigten Meetings.
      </div>
      ${
        canEditSecretaryArea()
          ? `<div class="small-note">Du bist Secretary: Du darfst erledigen und bearbeiten.</div>`
          : `<div class="small-note">Nur Ansicht. Erledigen und bearbeiten darf nur der Secretary.</div>`
      }
    </div>

    <h3>Noch offen / zum Erledigen</h3>
    <div>
      ${
        openMeetings.length
          ? openMeetings.map(secRenderDoneActionCard).join("")
          : `<div class="card">Keine offenen Meetings zum Erledigen.</div>`
      }
    </div>

    <h3>Erledigte Meetings</h3>
    <div>
      ${
        doneMeetings.length
          ? doneMeetings.map(secRenderFinishedMeetingCard).join("")
          : `<div class="card">Noch keine erledigten Meetings.</div>`
      }
    </div>
  `;
};

function secRenderDoneActionCard(m) {
  const canEdit = canEditSecretaryArea();

  return `
    <div class="card sec-meeting-card sec-meeting-open">
      <b>${escapeHtml(m.meetingNumber || "Meeting")}</b><br>
      Datum: ${escapeHtml(secDateDE(m.meetingDate))}<br>

      ${
        m.info
          ? `<div class="small-note" style="margin-top:8px;">${escapeHtml(m.info).replace(/\n/g, "<br>")}</div>`
          : `<div class="small-note" style="margin-top:8px;">Keine Info eingetragen.</div>`
      }

      ${
        canEdit
          ? `
            <div class="row" style="margin-top:10px;">
              <button type="button" class="smallbtn" onclick="window.secMarkMeetingDone('${m.id}')">✅ Erledigt markieren</button>
              <button type="button" class="smallbtn gray" onclick="window.secEditMeeting('${m.id}', 'done')">Bearbeiten</button>
            </div>
          `
          : `<div class="small-note" style="margin-top:10px;">Nur Ansicht</div>`
      }
    </div>
  `;
}

function secRenderFinishedMeetingCard(m) {
  const canEdit = canEditSecretaryArea();
  const isNoMeeting = m.kind === "no_meeting";

  if (!canEdit) {
    return `
      <div class="card sec-meeting-card ${isNoMeeting ? "sec-meeting-none" : "sec-meeting-done"}">
        <b>${isNoMeeting ? "Es gab kein Meeting" : escapeHtml(m.meetingNumber || "Meeting")}</b><br>
        Datum: ${escapeHtml(secDateDE(m.meetingDate))}<br>
        Status: ${isNoMeeting ? "No Meeting" : "Erledigt"}<br>

        <div class="small-note" style="margin-top:10px;">
          <b>Info:</b><br>
          ${m.info ? escapeHtml(m.info).replace(/\n/g, "<br>") : "Keine Info eingetragen."}
        </div>

        <div class="small-note" style="margin-top:10px;">Nur Ansicht</div>
      </div>
    `;
  }

  return `
    <div class="card sec-meeting-card ${isNoMeeting ? "sec-meeting-none" : "sec-meeting-done"}">
      <b>${isNoMeeting ? "Es gab kein Meeting" : escapeHtml(m.meetingNumber || "Meeting")}</b><br>
      Datum: ${escapeHtml(secDateDE(m.meetingDate))}<br>
      Status: ${isNoMeeting ? "No Meeting" : "Erledigt"}<br>

      <label class="field-label">Info Zeile / Was fehlt / Notiz</label>
      <textarea id="secInfo_${m.id}" placeholder="Hier Info eintragen...">${escapeHtml(m.info || "")}</textarea>

      <div class="row" style="margin-top:10px;">
        <button type="button" class="smallbtn" onclick="window.secSaveMeetingInfo('${m.id}')">💾 Info speichern</button>
        <button type="button" class="smallbtn gray" onclick="window.secEditMeeting('${m.id}', 'done')">Bearbeiten</button>
        <button type="button" class="smallbtn danger" onclick="window.secDeleteMeeting('${m.id}', 'done')">🗑️ Löschen</button>
      </div>
    </div>
  `;
}

window.secMarkMeetingDone = async (id) => {
  if (!canEditSecretaryArea()) return alert("Nur der Secretary darf erledigen.");

  try {
    await updateDoc(secMeetingRef(id), {
      status: "done",
      doneBy: CURRENT_UID,
      doneAt: Date.now(),
      updatedBy: CURRENT_UID,
      updatedAt: Date.now()
    });

    await window.secOpenMeetingDone();
  } catch (e) {
    alert("Konnte nicht erledigt markieren: " + e.message);
  }
};

/* =====================================================
   3. NO MEETING
===================================================== */

window.secCreateNoMeeting = async () => {
  if (!canEditSecretaryArea()) return alert("Nur der Secretary darf No Meeting speichern.");

  const today = secTodayISO();
  const id = `no_meeting_${today}`;

  try {
    await setDoc(
      secMeetingRef(id),
      {
        kind: "no_meeting",
        meetingDate: today,
        meetingNumber: "No Meeting",
        info: "Es gab kein Meeting",
        status: "done",
        createdBy: CURRENT_UID,
        createdAt: Date.now(),
        updatedBy: CURRENT_UID,
        updatedAt: Date.now()
      },
      { merge: true }
    );

    alert("No Meeting wurde gespeichert.");
    await window.secOpenMeetingDone();
  } catch (e) {
    alert("No Meeting konnte nicht gespeichert werden: " + e.message);
  }
};

/* =====================================================
   BEARBEITEN / INFO SPEICHERN / LÖSCHEN
===================================================== */

window.secEditMeeting = async (id, backView = "edit") => {
  if (!canEditSecretaryArea()) return alert("Nur der Secretary darf bearbeiten.");

  SEC_EDIT_MEETING_ID = id;
  SEC_BACK_VIEW = backView || "edit";

  const box = $("secMeetingContent");
  if (!box) return;

  try {
    const snap = await getDoc(secMeetingRef(id));
    if (!snap.exists()) return alert("Meeting nicht gefunden.");

    const m = snap.data() || {};
    const isNoMeeting = m.kind === "no_meeting";

    box.innerHTML = `
      <div class="card ${isNoMeeting ? "sec-meeting-none" : (m.status === "done" ? "sec-meeting-done" : "sec-meeting-open")}">
        <h3>✏️ ${isNoMeeting ? "No Meeting bearbeiten" : "Meeting bearbeiten"}</h3>

        <label class="field-label">Datum</label>
        <input id="secEditMeetingDate" type="date" value="${escapeAttr(m.meetingDate || secTodayISO())}">

        <label class="field-label">Meeting Nummer</label>
        <input id="secEditMeetingNumber" value="${escapeAttr(m.meetingNumber || "")}" ${isNoMeeting ? "readonly" : ""}>

        <label class="field-label">Info / Notiz</label>
        <textarea id="secEditMeetingInfo" placeholder="Info / was fehlt / Notiz...">${escapeHtml(m.info || "")}</textarea>

        <div class="row">
          <button type="button" onclick="window.secUpdateMeeting('${id}')">💾 Änderungen speichern</button>
          ${
            !isNoMeeting && m.status !== "done"
              ? `<button type="button" onclick="window.secMarkMeetingDone('${id}')">✅ Erledigt markieren</button>`
              : ``
          }
          <button type="button" class="gray" onclick="window.secBackAfterEdit()">⬅ Zurück</button>
        </div>
      </div>
    `;
  } catch (e) {
    alert("Bearbeiten fehlgeschlagen: " + e.message);
  }
};

window.secUpdateMeeting = async (id) => {
  if (!canEditSecretaryArea()) return alert("Nur der Secretary darf speichern.");

  const meetingDate = $("secEditMeetingDate")?.value || "";
  const meetingNumber = $("secEditMeetingNumber")?.value?.trim() || "";
  const info = $("secEditMeetingInfo")?.value?.trim() || "";

  if (!meetingDate) return alert("Datum fehlt.");
  if (!meetingNumber) return alert("Meeting Nummer fehlt.");

  try {
    const oldSnap = await getDoc(secMeetingRef(id));
    const old = oldSnap.exists() ? (oldSnap.data() || {}) : {};

    await updateDoc(secMeetingRef(id), {
      meetingDate,
      meetingNumber: old.kind === "no_meeting" ? "No Meeting" : meetingNumber,
      info,
      updatedBy: CURRENT_UID,
      updatedAt: Date.now()
    });

    SEC_EDIT_MEETING_ID = null;
    await window.secBackAfterEdit();
  } catch (e) {
    alert("Änderung konnte nicht gespeichert werden: " + e.message);
  }
};

window.secSaveMeetingInfo = async (id) => {
  if (!canEditSecretaryArea()) return alert("Nur der Secretary darf Info speichern.");

  const info = $(`secInfo_${id}`)?.value?.trim() || "";

  try {
    await updateDoc(secMeetingRef(id), {
      info,
      updatedBy: CURRENT_UID,
      updatedAt: Date.now()
    });

    await window.secOpenMeetingDone();
  } catch (e) {
    alert("Info konnte nicht gespeichert werden: " + e.message);
  }
};

window.secDeleteMeeting = async (id, backView = "edit") => {
  if (!canEditSecretaryArea()) return alert("Nur der Secretary darf löschen.");
  if (!confirm("Eintrag wirklich löschen?")) return;

  try {
    await deleteDoc(secMeetingRef(id));

    if (backView === "done") await window.secOpenMeetingDone();
    else await window.secOpenMeetingEdit();
  } catch (e) {
    alert("Löschen fehlgeschlagen: " + e.message);
  }
};

window.secBackAfterEdit = async () => {
  if (SEC_BACK_VIEW === "done") await window.secOpenMeetingDone();
  else await window.secOpenMeetingEdit();
};

/* =====================================================
   MEETING INFO
===================================================== */

window.secOpenMeetingInfoMenu = () => {
  if (!canViewSecretaryArea()) return alert("Kein Zugriff");

  const box = secBox();
  if (!box) return;

  box.innerHTML = `
    <div class="card">
      <h3>ℹ️ Meeting Info</h3>

      <button type="button" onclick="window.secOpenInformation()">1. Information</button>
      <button type="button" class="gray" onclick="window.secOpenMeetingMenu()">⬅ Zurück zu Meeting</button>
    </div>

    <div id="secMeetingInfoContent"></div>
  `;
};

window.secOpenInformation = () => {
  const box = $("secMeetingInfoContent");
  if (!box) return;

  if (!isAdmin()) {
    box.innerHTML = `
      <div class="card sec-meeting-none">
        <h3>🔒 Information</h3>
        <p>Dieser Bereich ist für alle geschlossen.</p>
        <button type="button" class="gray" onclick="window.secOpenMeetingInfoMenu()">⬅ Zurück</button>
      </div>
    `;
    return;
  }

  box.innerHTML = `
    <div class="card">
      <h3>🔓 Information</h3>
      <p class="small-note">Admin-Zugriff aktiv. Dieser Bereich ist aktuell leer.</p>
      <button type="button" class="gray" onclick="window.secOpenMeetingInfoMenu()">⬅ Zurück</button>
    </div>
  `;
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
  const key = monthKeyFromInput(monthStr);
  const members = TREASURY_MEMBERS_CACHE || [];

  let sollTotal = 0;
  let istTotal = 0;

  const openMembers = [];
  const paidMembers = [];

  const monthYM = String(monthStr || "").trim(); // "YYYY-MM"

  members.forEach((m) => {
    const club = Number(m.clubMonthly || 0);
    const other = Number(m.otherMonthly || 0);
    const baseDue = club + other;

    const joinISO = treas_normISODate(m.joinDate || m.entryDate || m.join || "");
    const exempt = treas_isDuesExempt(m);

    let due = 0;
    if (key && !exempt && joinISO && /^\d{4}-\d{2}$/.test(monthYM)) {
      const joinYM = joinISO.slice(0, 7); // "YYYY-MM"
      if (monthYM >= joinYM) due = baseDue;
    }

    const paid = key ? !!(m.monthsPaid && m.monthsPaid[key]) : false;

    sollTotal += due;

    if (paid) {
      istTotal += due;
      if (due > 0) paidMembers.push({ m, due });
    } else {
      if (due > 0) openMembers.push({ m, due });
    }
  });

  const fines = members
    .filter((m) => Number(m.fineAmount || 0) > 0)
    .map((m) => ({ m, fine: Number(m.fineAmount || 0) }));

  return { key, sollTotal, istTotal, openMembers, paidMembers, fines };
}

async function onTreasuryMonthChanged() {
  const monthStr = $("treasMonth")?.value || "";
  if (!monthStr) {
    const list = $("treasOpenContribList");
    if (list) list.innerHTML = "Wähle einen Monat…";
    TREAS_LAST_STATS = null;
    updateTreasNetUI();
    return;
  }

  await ensureTreasuryMembersLoaded();

  const stats = calcMonthStatsFromCache(monthStr);
  TREAS_LAST_STATS = stats;

  const info = $("treasAutoInfo");
  if (info) {
    info.innerText = `Auto: Soll/Ist aus Member-Akten für ${monthLabelFromInput(monthStr)} (Häkchen = bezahlt).`;
  }

  // ✅ setzt Netto + (wenn Auto aktiv) Cash Soll/Ist inkl. Netto
  updateTreasNetUI();

  // Offen-Liste
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
    .sort((a, b) => (a.m.name || "").localeCompare(b.m.name || ""))
    .map(({ m, due }) => {
      const fine = Number(m.fineAmount || 0);
      const fineTxt = fine > 0 ? ` | Strafe: ${euro(fine)} (${escapeHtml(m.fineReason || "-")})` : "";
      const lateTxt = m.lateNote ? ` | Verspätung: ${escapeHtml(m.lateNote)}` : "";
      const noteTxt = m.note ? ` | Notiz: ${escapeHtml(m.note)}` : "";

      return `<div class="card money-warn">
        <b>${escapeHtml(m.name || "-")}</b> – offen: <b>${euro(due)}</b>
        <br><small>Rang: ${escapeHtml(m.rank || "-")} | Eintritt: ${escapeHtml(m.joinDate || "-")}${fineTxt}${lateTxt}${noteTxt}</small>
      </div>`;
    })
    .join("");

  const totalOpen = stats.openMembers.reduce((s, x) => s + Number(x.due || 0), 0);

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
  return ["road_captain", "president", "vice_president", "sergeant_at_arms", "admin"]
    .includes(String(CURRENT_RANK || "").toLowerCase());
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

/* ===================================================== */
/* MEMBER INFO (Directory + Requests) */
/* ===================================================== */

window.openMemberInfoModal = async () => {
  const modal = $("memberInfoModal");
  if (!modal) return;

  // Add Button nur für Officer/Admin
  const addBtn = $("memberAddOpenBtn");
  if (addBtn) addBtn.style.display = canManageMemberDirectory() ? "block" : "none";

  modal.classList.remove("hidden");

  await window.loadMemberDirectory();
  window.renderMemberInfoList();
};

window.closeMemberInfoModal = () => {
  $("memberInfoModal")?.classList.add("hidden");
};

window.loadMemberDirectory = async () => {
  MEMBER_DIR_CACHE = [];
  const box = $("memberInfoList");
  if (box) box.innerHTML = "Lade...";

  try {
    const snaps = await getDocs(query(collection(db, "member_directory"), orderBy("name", "asc"), limit(500)));
    snaps.forEach((ds) => {
      MEMBER_DIR_CACHE.push({ id: ds.id, ...(ds.data() || {}) });
    });
  } catch (e) {
    if (box) box.innerHTML = `<div class="card">Fehler: ${escapeHtml(e.message)}</div>`;
  }
};

window.renderMemberInfoList = () => {
  const box = $("memberInfoList");
  if (!box) return;

  const q = ($("memberInfoSearch")?.value || "").trim().toLowerCase();

  let items = [...(MEMBER_DIR_CACHE || [])];
  if (q) {
    items = items.filter((m) => {
      const blob = [m.name, m.rank, m.joinDate].join(" ").toLowerCase();
      return blob.includes(q);
    });
  }

  if (!items.length) {
    box.innerHTML = `<div class="card">Noch keine Member angelegt. ${canManageMemberDirectory() ? "Unten auf „Member hinzufügen“." : ""}</div>`;
    return;
  }

  box.innerHTML = items.map((m) => `
    <div class="card member-card" onclick="window.openMemberDetailModal('${m.id}')">
      <b>${escapeHtml(m.name || "-")}</b><br>
      Rang: ${escapeHtml(m.rank || "-")}
    </div>
  `).join("");
};

window.openMemberDetailModal = async (uid) => {
  MEMBER_SELECTED_UID = uid;

  const modal = $("memberDetailModal");
  if (!modal) return;

  modal.classList.remove("hidden");

  // Delete Button nur Officer/Admin
  const delBtn = $("mdDeleteMemberBtn");
  if (delBtn) delBtn.style.display = canManageMemberDirectory() ? "block" : "none";

  // Daten laden
  try {
    const snap = await getDoc(doc(db, "member_directory", uid));
    if (!snap.exists()) {
      alert("Member nicht gefunden.");
      return;
    }
    const m = snap.data() || {};

    $("memberDetailTitle").innerText = `👤 ${m.name || "Member"}`;
    setText("mdName", m.name || "-");
    setText("mdRank", m.rank || "-");
    setText("mdJoin", m.joinDate || "-");

    const info = m.approvedInfo || "";
    $("mdInfo").innerHTML = info ? escapeHtml(info).replace(/\n/g, "<br>") : "—";

    const meta = m.approvedAt
      ? `Freigegeben: ${new Date(m.approvedAt).toLocaleString("de-DE")} • von: ${userNameByUid(m.approvedBy)}`
      : "";
    setText("mdApprovedMeta", meta);

    // ✅ “Meine Anfrage” nur wenn das mein eigenes UID ist
    const myBox = $("mdMyRequestBox");
    if (myBox) {
      if (uid === CURRENT_UID) myBox.classList.remove("hidden");
      else myBox.classList.add("hidden");
    }
    if ($("mdMyRequestHint")) $("mdMyRequestHint").innerText = "Wird erst sichtbar, wenn Sergeant-at-Arms bestätigt ✅";

    // ✅ Approve Box nur Sergeant/Admin
    const appr = $("mdApproveBox");
    if (appr) {
      if (isSergeantAtArms()) appr.classList.remove("hidden");
      else appr.classList.add("hidden");
    }

    if (isSergeantAtArms()) {
      await window.loadPendingMemberRequests(uid);
    }
  } catch (e) {
    alert("Fehler: " + e.message);
  }
};

window.closeMemberDetailModal = () => {
  $("memberDetailModal")?.classList.add("hidden");
  MEMBER_SELECTED_UID = null;
};

window.openMemberAddModal = () => {
  if (!canManageMemberDirectory()) {
    alert("Keine Berechtigung.");
    return;
  }

  const modal = $("memberAddModal");
  if (!modal) return;

  // Select füllen aus USERS_CACHE (damit UID passt!)
  const sel = $("maUserSelect");
  if (sel) {
    const users = [...USERS_CACHE.entries()]
      .map(([uid, u]) => ({ uid, ...u }))
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""));

    sel.innerHTML = users.map((u) => `<option value="${u.uid}">${escapeHtml(u.name)} • ${escapeHtml(u.rank)}</option>`).join("");
  }

  const hint = $("maHint");
  if (hint) hint.innerText = "Tipp: User auswählen → Speichern. Dann kann der Member später seine Info anfragen.";

  modal.classList.remove("hidden");
};

window.closeMemberAddModal = () => {
  $("memberAddModal")?.classList.add("hidden");
};

window.saveNewMember = async () => {
  if (!canManageMemberDirectory()) return alert("Keine Berechtigung");

  const uid = $("maUserSelect")?.value || "";
  const joinDate = $("maJoinDate")?.value || "";

  if (!uid) return alert("Bitte User auswählen.");

  const u = USERS_CACHE.get(uid);
  if (!u) return alert("User nicht gefunden.");

  try {
    await setDoc(doc(db, "member_directory", uid), {
      uid,
      name: u.name || "Unbekannt",
      rank: u.rank || "member",
      joinDate: joinDate || "",
      approvedInfo: "",
      approvedAt: null,
      approvedBy: null,
      updatedAt: Date.now(),
      updatedBy: CURRENT_UID
    }, { merge: true });

    window.closeMemberAddModal();
    await window.loadMemberDirectory();
    window.renderMemberInfoList();
    alert("Member hinzugefügt ✅");
  } catch (e) {
    alert("Speichern fehlgeschlagen: " + e.message);
  }
};

window.deleteSelectedMember = async () => {
  if (!canManageMemberDirectory()) return alert("Keine Berechtigung");
  if (!MEMBER_SELECTED_UID) return;

  if (!confirm("Member wirklich löschen?")) return;

  try {
    await deleteDoc(doc(db, "member_directory", MEMBER_SELECTED_UID));
    window.closeMemberDetailModal();
    await window.loadMemberDirectory();
    window.renderMemberInfoList();
  } catch (e) {
    alert("Löschen fehlgeschlagen: " + e.message);
  }
};

// ✅ Member selbst: Anfrage stellen (Text), Sergeant muss bestätigen
window.sendMyMemberInfoRequest = async () => {
  if (!MEMBER_SELECTED_UID || MEMBER_SELECTED_UID !== CURRENT_UID) {
    return alert("Du kannst nur für dich selbst eine Anfrage senden.");
  }

  const text = ($("mdMyInfoText")?.value || "").trim();
  if (!text) return alert("Bitte Text schreiben.");

  try {
    await addDoc(collection(db, "member_info_requests"), {
      uid: CURRENT_UID,
      name: userNameByUid(CURRENT_UID),
      text,
      status: "pending",
      createdAt: Date.now()
    });

    $("mdMyInfoText").value = "";
    if ($("mdMyRequestHint")) $("mdMyRequestHint").innerText = "Anfrage gesendet ✅ (wartet auf Freigabe)";
    if (isSergeantAtArms()) await window.loadPendingMemberRequests(CURRENT_UID);
  } catch (e) {
    alert("Senden fehlgeschlagen: " + e.message);
  }
};

// ✅ Sergeant/Admin: Pending Requests laden + Approve/Reject
window.loadPendingMemberRequests = async (uid) => {
  const box = $("mdPendingList");
  if (!box) return;

  box.innerHTML = "Lade...";

  try {
    const snaps = await getDocs(query(
      collection(db, "member_info_requests"),
      where("uid", "==", uid),
      where("status", "==", "pending"),
      limit(25)
    ));

    const items = [];
    snaps.forEach((ds) => items.push({ id: ds.id, ...(ds.data() || {}) }));
    items.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));

    if (!items.length) {
      box.innerHTML = `<div class="card">Keine offenen Anfragen.</div>`;
      return;
    }

    box.innerHTML = items.map((r) => `
      <div class="card">
        <b>Anfrage:</b> ${escapeHtml(r.name || r.uid || "-")}<br>
        <small>${r.createdAt ? new Date(r.createdAt).toLocaleString("de-DE") : ""}</small><br><br>
        <div class="small-note">${escapeHtml(r.text || "").replace(/\n/g, "<br>")}</div>
        <div class="row" style="margin-top:10px;">
          <button type="button" onclick="window.approveMemberInfoRequest('${r.id}', '${uid}')">✅ Freigeben</button>
          <button type="button" class="gray" onclick="window.rejectMemberInfoRequest('${r.id}')">❌ Ablehnen</button>
        </div>
      </div>
    `).join("");
  } catch (e) {
    box.innerHTML = `<div class="card">Fehler: ${escapeHtml(e.message)}</div>`;
  }
};

window.approveMemberInfoRequest = async (reqId, uid) => {
  if (!isSergeantAtArms()) return alert("Nur Sergeant-at-Arms/Admin.");

  try {
    const snap = await getDoc(doc(db, "member_info_requests", reqId));
    if (!snap.exists()) return alert("Request nicht gefunden.");

    const r = snap.data() || {};
    const text = String(r.text || "").trim();
    if (!text) return alert("Request-Text leer.");

    // ✅ In Directory übernehmen (freigegeben)
    await updateDoc(doc(db, "member_directory", uid), {
      approvedInfo: text,
      approvedAt: Date.now(),
      approvedBy: CURRENT_UID,
      updatedAt: Date.now(),
      updatedBy: CURRENT_UID
    });

    // ✅ Request als approved markieren
    await updateDoc(doc(db, "member_info_requests", reqId), {
      status: "approved",
      decidedAt: Date.now(),
      decidedBy: CURRENT_UID
    });

    // UI refresh
    await window.openMemberDetailModal(uid);
    await window.loadMemberDirectory();
    window.renderMemberInfoList();
  } catch (e) {
    alert("Freigabe fehlgeschlagen: " + e.message);
  }
};

window.rejectMemberInfoRequest = async (reqId) => {
  if (!isSergeantAtArms()) return alert("Nur Sergeant-at-Arms/Admin.");
  if (!confirm("Anfrage ablehnen?")) return;

  try {
    await updateDoc(doc(db, "member_info_requests", reqId), {
      status: "rejected",
      decidedAt: Date.now(),
      decidedBy: CURRENT_UID
    });

    if (MEMBER_SELECTED_UID) await window.loadPendingMemberRequests(MEMBER_SELECTED_UID);
  } catch (e) {
    alert("Ablehnen fehlgeschlagen: " + e.message);
  }
};
