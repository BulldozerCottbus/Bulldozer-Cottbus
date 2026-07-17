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

/* =====================================================
   HELPERS / DOM
===================================================== */

const $ = (id) => document.getElementById(id);

function setText(id, txt) {
  const el = $(id);
  if (el) el.innerText = txt;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  }[m]));
}

function escapeAttr(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/* =====================================================
   GLOBAL STATE
===================================================== */

let CURRENT_UID = null;
let CURRENT_RANK = null;
let USERS_CACHE = new Map();

let EDIT_INFO_ID = null;

/* Calendar */
let CALENDAR_CURRENT_MONTH = new Date().toISOString().slice(0, 7);
let CALENDAR_SELECTED_DAY = null;
let CALENDAR_CACHE = new Map();
let CALENDAR_MY_RSVP_CACHE = new Map(); // dayIso -> confirmed / declined
let CALENDAR_FILTER = "all";

/* Settings */
const SETTINGS_KEY = "bdz_settings_v1";

let APP_SETTINGS = {
  floatingBackEnabled: true,
  floatingBackLocked: true,
  floatingBackPos: null
};

/* =====================================================
   AUTH / LOGIN
===================================================== */

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

  const loginScreen = $("loginScreen");
  const homeScreen = $("homeScreen");
  const topBar = $("topBar");

  if (loginScreen) loginScreen.classList.remove("hidden");
  if (homeScreen) homeScreen.classList.add("hidden");
  if (topBar) topBar.classList.add("hidden");
};

/* =====================================================
   NAVIGATION
===================================================== */

window.showScreen = (id) => {
  if (!canAccessMainArea(id)) {
    alert("FÃ¼r Hangaround-Accounts ist nur der Kalender freigeschaltet.");
    id = "calendarScreen";
  }

  document.querySelectorAll(".container").forEach((s) => s.classList.add("hidden"));
  const target = $(id);
  if (target) target.classList.remove("hidden");

  if (id === "calendarScreen" && CURRENT_UID) {
    const monthInput = $("calMonthInput");
    loadCalendarMonth(monthInput?.value || CALENDAR_CURRENT_MONTH);
  }
};

window.backHome = () => window.showScreen("homeScreen");

/* =====================================================
   RIGHTS
===================================================== */

function isAdmin() {
  return CURRENT_RANK === "admin";
}

function hasOfficerRights() {
  return ["president", "vice_president", "sergeant_at_arms"].includes(CURRENT_RANK) || isAdmin();
}

function canManageCalendar() {
  return ["road_captain", "president", "vice_president", "sergeant_at_arms", "admin"]
    .includes(String(CURRENT_RANK || "").toLowerCase());
}

function applyRankRights() {
  const debugButton = $("debugButton");
  const infosBtn = $("infosNavBtn");
  const calendarBtn = $("calendarNavBtn");
  const settingsBtn = $("settingsBtn");
  const postInfoBtn = $("postInfoBtn");

  // Standard: alle Hauptbuttons sichtbar, sofern im HTML vorhanden.
  [debugButton, infosBtn, calendarBtn, settingsBtn, postInfoBtn].forEach((el) => {
    if (el) el.classList.remove("hidden");
  });

  // Hangaround: NUR Kalender + Logout sichtbar. Alles andere gesperrt.
  if (isHangaroundAccount()) {
    [debugButton, infosBtn, settingsBtn, postInfoBtn].forEach((el) => {
      if (el) el.classList.add("hidden");
    });

    if (calendarBtn) calendarBtn.classList.remove("hidden");
  }
}

/* =====================================================
   USERS CACHE
===================================================== */

async function loadUsersCache() {
  USERS_CACHE.clear();

  try {
    const snaps = await getDocs(collection(db, "users"));
    snaps.forEach((d) => {
      const u = d.data() || {};
      USERS_CACHE.set(d.id, {
        name: u.name || "Unbekannt",
        rank: u.rank || "member"
      });
    });
  } catch (e) {
    console.warn("loadUsersCache failed:", e);
  }
}

function userNameByUid(uid) {
  return USERS_CACHE.get(uid)?.name || uid || "-";
}

/* =====================================================
   ACCESS HELPERS
===================================================== */

function rankKey(rank = CURRENT_RANK) {
  return String(rank || "member").toLowerCase().trim();
}

function isHangaroundAccount() {
  return rankKey() === "hangaround";
}

function canAccessMainArea(area) {
  if (isHangaroundAccount()) {
    return ["homeScreen", "loginScreen", "calendarScreen"].includes(String(area || ""));
  }
  return true;
}

/* =====================================================
   SETTINGS + FLOATING BACK
===================================================== */

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      APP_SETTINGS = { ...APP_SETTINGS, ...parsed };
    }
  } catch (e) {
    console.warn("loadSettings failed:", e);
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(APP_SETTINGS));
  } catch (e) {
    console.warn("saveSettings failed:", e);
  }
}

function openSettingsModal() {
  if (isHangaroundAccount()) {
    alert("Einstellungen sind fÃ¼r Hangaround-Accounts gesperrt. Es ist nur der Kalender freigeschaltet.");
    return;
  }

  const modal = $("settingsModal");
  if (!modal) return;

  const t1 = $("toggleFloatingBack");
  const t2 = $("toggleLockFloatingBack");

  if (t1) t1.checked = !!APP_SETTINGS.floatingBackEnabled;
  if (t2) t2.checked = !!APP_SETTINGS.floatingBackLocked;

  syncMemberOnlySettingsUI();

  modal.classList.remove("hidden");
  modal.classList.add("show");
  modal.setAttribute("aria-hidden", "false");
}

function closeSettingsModal() {
  const modal = $("settingsModal");
  if (!modal) return;

  modal.classList.remove("show");
  modal.setAttribute("aria-hidden", "true");

  setTimeout(() => {
    modal.classList.add("hidden");
  }, 180);
}

function smartBackAction() {
  const openModal = document.querySelector(".modal:not(.hidden)");
  if (openModal) {
    openModal.classList.add("hidden");
    openModal.classList.remove("show");
    return;
  }

  const visible = [...document.querySelectorAll(".container")]
    .find((el) => !el.classList.contains("hidden"));

  if (visible && visible.id !== "homeScreen" && visible.id !== "loginScreen") {
    window.backHome();
    return;
  }

  window.history.back();
}

function applyFloatingBackUI() {
  const btn = $("floatingBackBtn");
  if (!btn) return;

  if (APP_SETTINGS.floatingBackEnabled) btn.classList.remove("hidden");
  else btn.classList.add("hidden");

  if (!APP_SETTINGS.floatingBackLocked) btn.classList.add("unlocked");
  else btn.classList.remove("unlocked");

  if (APP_SETTINGS.floatingBackPos && typeof APP_SETTINGS.floatingBackPos.x === "number") {
    btn.style.left = APP_SETTINGS.floatingBackPos.x + "px";
    btn.style.top = APP_SETTINGS.floatingBackPos.y + "px";
    btn.style.right = "auto";
    btn.style.bottom = "auto";
  } else {
    btn.style.left = "auto";
    btn.style.top = "auto";
    btn.style.right = "14px";
    btn.style.bottom = "calc(14px + env(safe-area-inset-bottom))";
  }
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function resetFloatingBackPos() {
  APP_SETTINGS.floatingBackPos = null;
  saveSettings();
  applyFloatingBackUI();
}

function initFloatingBackDrag() {
  const btn = $("floatingBackBtn");
  if (!btn || btn.dataset.ready === "1") return;

  btn.dataset.ready = "1";

  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;
  let moved = 0;

  btn.addEventListener("click", () => {
    if (moved > 6) return;
    smartBackAction();
  });

  btn.addEventListener("pointerdown", (e) => {
    if (!APP_SETTINGS.floatingBackEnabled) return;

    moved = 0;

    if (APP_SETTINGS.floatingBackLocked) return;

    dragging = true;
    btn.setPointerCapture(e.pointerId);

    const rect = btn.getBoundingClientRect();
    startX = e.clientX;
    startY = e.clientY;
    startLeft = rect.left;
    startTop = rect.top;

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

    const w = btn.offsetWidth || 50;
    const h = btn.offsetHeight || 50;

    const maxX = window.innerWidth - w - 6;
    const maxY = window.innerHeight - h - 6;

    const newLeft = clamp(startLeft + dx, 6, maxX);
    const newTop = clamp(startTop + dy, 6, maxY);

    btn.style.left = newLeft + "px";
    btn.style.top = newTop + "px";
  });

  function endDrag() {
    if (!dragging) return;
    dragging = false;

    const rect = btn.getBoundingClientRect();
    APP_SETTINGS.floatingBackPos = {
      x: Math.round(rect.left),
      y: Math.round(rect.top)
    };

    saveSettings();
    applyFloatingBackUI();
  }

  btn.addEventListener("pointerup", endDrag);
  btn.addEventListener("pointercancel", endDrag);

  window.addEventListener("resize", () => {
    if (!APP_SETTINGS.floatingBackPos) return;

    const w = btn.offsetWidth || 50;
    const h = btn.offsetHeight || 50;

    const maxX = window.innerWidth - w - 6;
    const maxY = window.innerHeight - h - 6;

    APP_SETTINGS.floatingBackPos.x = clamp(APP_SETTINGS.floatingBackPos.x, 6, maxX);
    APP_SETTINGS.floatingBackPos.y = clamp(APP_SETTINGS.floatingBackPos.y, 6, maxY);

    saveSettings();
    applyFloatingBackUI();
  });
}

function initSettingsAndFloatingBack() {
  loadSettings();
  applyFloatingBackUI();
  initFloatingBackDrag();
}

/* =====================================================
   SESSION
===================================================== */

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

  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    const data = snap.exists() ? (snap.data() || {}) : {};

    CURRENT_RANK = data.rank || "member";

    setText("rankLabel", data.rank || "-");
    setText("userName", data.name || "-");
    setText("points", data.rPoints || 0);
  } catch (e) {
    CURRENT_RANK = "member";
    console.warn("user profile failed:", e);
  }

  applyRankRights();

  await loadUsersCache();
  await loadInfos();

  bindUI();
});

/* =====================================================
   UI BINDINGS
===================================================== */

function bindUI() {
  const postInfoBtn = $("postInfoBtn");
  if (postInfoBtn) postInfoBtn.onclick = () => window.openInfoModal();

  const infoSave = $("infoModalSaveBtn");
  if (infoSave) infoSave.onclick = () => saveInfoModal();

  const infoDel = $("infoModalDeleteBtn");
  if (infoDel) {
    infoDel.onclick = () => {
      if (EDIT_INFO_ID) window.deleteInfo(EDIT_INFO_ID);
    };
  }

  const dbg = $("debugButton");
  if (dbg) dbg.onclick = () => window.openDebugModal();

  const addLog = $("addChangelogBtn");
  if (addLog) addLog.onclick = () => addChangelogEntry();

  const calendarNavBtn = $("calendarNavBtn");
  if (calendarNavBtn) calendarNavBtn.onclick = () => window.showCalendarPanel();

  const calMonthInput = $("calMonthInput");
  if (calMonthInput) calMonthInput.onchange = () => loadCalendarMonth(calMonthInput.value);

  const calPrevMonthBtn = $("calPrevMonthBtn");
  if (calPrevMonthBtn) {
    calPrevMonthBtn.onclick = () => {
      const [y, m] = CALENDAR_CURRENT_MONTH.split("-").map(Number);
      const d = new Date(y, m - 2, 1);
      loadCalendarMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    };
  }

  const calNextMonthBtn = $("calNextMonthBtn");
  if (calNextMonthBtn) {
    calNextMonthBtn.onclick = () => {
      const [y, m] = CALENDAR_CURRENT_MONTH.split("-").map(Number);
      const d = new Date(y, m, 1);
      loadCalendarMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    };
  }

  const calTodayBtn = $("calTodayBtn");
  if (calTodayBtn) {
    calTodayBtn.onclick = () => {
      const today = calTodayISO();
      loadCalendarMonth(today.slice(0, 7)).then(() => window.openCalendarDay(today));
    };
  }

  document.querySelectorAll("[data-cal-filter]").forEach((btn) => {
    btn.onclick = () => {
      CALENDAR_FILTER = btn.dataset.calFilter || "all";
      document.querySelectorAll("[data-cal-filter]").forEach((item) => {
        item.classList.toggle("active", item === btn);
      });
      renderCalendarGrid(CALENDAR_CURRENT_MONTH);
    };
  });

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

  const settingsBtn = $("settingsBtn");
  if (settingsBtn) settingsBtn.onclick = () => openSettingsModal();

  const settingsClose = $("settingsCloseBtn");
  if (settingsClose) settingsClose.onclick = () => closeSettingsModal();

  const settingsBackdrop = $("settingsBackdrop");
  if (settingsBackdrop) settingsBackdrop.onclick = () => closeSettingsModal();

  const toggleFloatingBack = $("toggleFloatingBack");
  if (toggleFloatingBack) {
    toggleFloatingBack.onchange = () => {
      APP_SETTINGS.floatingBackEnabled = !!toggleFloatingBack.checked;
      saveSettings();
      applyFloatingBackUI();
    };
  }

  const toggleLockFloatingBack = $("toggleLockFloatingBack");
  if (toggleLockFloatingBack) {
    toggleLockFloatingBack.onchange = () => {
      APP_SETTINGS.floatingBackLocked = !!toggleLockFloatingBack.checked;
      saveSettings();
      applyFloatingBackUI();
    };
  }

  const resetPosBtn = $("resetFloatingBackPosBtn");
  if (resetPosBtn) resetPosBtn.onclick = () => resetFloatingBackPos();


  initSettingsAndFloatingBack();
}

/* =====================================================
   INFOS
===================================================== */

window.openInfoModal = async (infoId = null) => {
  if (isHangaroundAccount()) {
    alert("Infos sind fÃ¼r Hangaround-Accounts gesperrt. Es ist nur der Kalender freigeschaltet.");
    return;
  }

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

  try {
    const snap = await getDoc(doc(db, "infos", infoId));
    if (!snap.exists()) return alert("Info nicht gefunden.");

    const d = snap.data() || {};
    title.innerText = "Info bearbeiten";
    text.value = d.text || "";
    exp.value = d.expiresAt ? "24h" : "keep";

    const can = hasOfficerRights() || d.createdBy === CURRENT_UID;
    if (can) del.classList.remove("hidden");
    else del.classList.add("hidden");

    modal.classList.remove("hidden");
  } catch (e) {
    alert("Fehler: " + e.message);
  }
};

window.closeInfoModal = () => {
  $("infoModal")?.classList.add("hidden");
  EDIT_INFO_ID = null;
};

async function saveInfoModal() {
  const text = $("infoModalText")?.value?.trim() || "";
  const exp = $("infoModalExpiry")?.value || "keep";

  if (!text) return alert("Text fehlt.");

  const expiresAt = exp === "24h"
    ? Date.now() + 24 * 60 * 60 * 1000
    : null;

  try {
    if (!EDIT_INFO_ID) {
      await addDoc(collection(db, "infos"), {
        text,
        createdBy: CURRENT_UID,
        time: Date.now(),
        expiresAt
      });
    } else {
      const patch = {
        text,
        editedAt: Date.now(),
        editedBy: CURRENT_UID
      };

      if (expiresAt) patch.expiresAt = expiresAt;
      else patch.expiresAt = deleteField();

      await updateDoc(doc(db, "infos", EDIT_INFO_ID), patch);
    }

    window.closeInfoModal();
    await loadInfos();
  } catch (e) {
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

    if (!can) return alert("Keine Berechtigung.");
    if (!confirm("Info wirklich lÃ¶schen?")) return;

    await deleteDoc(doc(db, "infos", id));

    window.closeInfoModal();
    await loadInfos();
  } catch (e) {
    alert("LÃ¶schen fehlgeschlagen: " + e.message);
  }
};

async function loadInfos() {
  if (isHangaroundAccount()) return;

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
    let html = "";

    for (const ds of snaps.docs) {
      const d = ds.data() || {};
      const id = ds.id;

      if (d.expiresAt && Number(d.expiresAt) < now) {
        const canCleanup = hasOfficerRights() || d.createdBy === CURRENT_UID;
        if (canCleanup) {
          try {
            await deleteDoc(doc(db, "infos", id));
          } catch (e) {
            console.warn("expired info cleanup failed:", e);
          }
        }
        continue;
      }

      const canEdit = hasOfficerRights() || d.createdBy === CURRENT_UID;
      const when = d.time ? new Date(d.time).toLocaleString("de-DE") : "";
      const author = d.createdBy ? userNameByUid(d.createdBy) : "-";
      const expiryTxt = d.expiresAt
        ? ` | lÃ¤uft ab: ${new Date(d.expiresAt).toLocaleString("de-DE")}`
        : "";

      html += `
        <div class="card">
          <div class="small-note">
            von: ${escapeHtml(author)} | ${escapeHtml(when)}${escapeHtml(expiryTxt)}
          </div>
          <div style="margin-top:8px;">${escapeHtml(d.text || "").replace(/\n/g, "<br>")}</div>

          ${canEdit ? `
            <div class="row" style="margin-top:10px;">
              <button class="smallbtn gray" type="button" onclick="window.editInfo('${id}')">Bearbeiten</button>
              <button class="smallbtn danger" type="button" onclick="window.deleteInfo('${id}')">LÃ¶schen</button>
            </div>
          ` : ""}
        </div>
      `;
    }

    infosList.innerHTML = html.trim()
      ? html
      : `<div class="card">Keine aktiven Infos.</div>`;
  } catch (e) {
    infosList.innerHTML = `<div class="card">Fehler beim Laden: ${escapeHtml(e.message)}</div>`;
  }
}

/* =====================================================
   INFO RULE BOX TOGGLES
===================================================== */

window.toggleWarnInfo = () => {
  const warnBox = $("warnInfoBox");
  const clubBox = $("clubRulesBox");
  const meetBox = $("meetingRulesBox");

  if (!warnBox) return;

  clubBox?.classList.add("hidden");
  meetBox?.classList.add("hidden");

  warnBox.classList.toggle("hidden");
};

window.toggleClubRules = () => {
  const clubBox = $("clubRulesBox");
  const warnBox = $("warnInfoBox");
  const meetBox = $("meetingRulesBox");

  if (!clubBox) return;

  warnBox?.classList.add("hidden");
  meetBox?.classList.add("hidden");

  clubBox.classList.toggle("hidden");
};

window.toggleMeetingRules = () => {
  const meetBox = $("meetingRulesBox");
  const warnBox = $("warnInfoBox");
  const clubBox = $("clubRulesBox");

  if (!meetBox) return;

  warnBox?.classList.add("hidden");
  clubBox?.classList.add("hidden");

  meetBox.classList.toggle("hidden");
};

/* =====================================================
   DEBUG / CHANGELOG
===================================================== */

function canEditChangelog() {
  return isAdmin();
}

window.openDebugModal = async () => {
  if (isHangaroundAccount()) {
    alert("Beta/Updates sind fÃ¼r Hangaround-Accounts gesperrt. Es ist nur der Kalender freigeschaltet.");
    return;
  }

  const modal = $("debugModal");
  const adminBox = $("changelogAdminBox");

  if (!modal) return;

  if (adminBox) {
    if (canEditChangelog()) adminBox.classList.remove("hidden");
    else adminBox.classList.add("hidden");
  }

  modal.classList.remove("hidden");
  await loadChangelog();
};

window.closeDebugModal = () => {
  $("debugModal")?.classList.add("hidden");
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

    snaps.forEach((ds) => {
      const d = ds.data() || {};
      const type = String(d.type || "info");
      const cls = type === "bugfix"
        ? "chlog-bugfix"
        : (type === "feature" ? "chlog-feature" : "chlog-info");

      const when = d.time ? new Date(d.time).toLocaleString("de-DE") : "";
      const by = d.createdBy ? userNameByUid(d.createdBy) : "-";

      const delBtn = canEditChangelog()
        ? `<button class="smallbtn danger" type="button" onclick="window.deleteChangelogEntry('${ds.id}')">LÃ¶schen</button>`
        : "";

      html += `
        <div class="chlog-item ${cls}">
          <div class="chlog-meta">
            <b>${escapeHtml(d.title || "-")}</b> â€¢ ${escapeHtml(type.toUpperCase())} â€¢ ${escapeHtml(when)} â€¢ von: ${escapeHtml(by)}
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
  if (!canEditChangelog()) return alert("Keine Berechtigung.");

  const type = $("changelogType")?.value || "bugfix";
  const title = ($("changelogTitle")?.value || "").trim();
  const text = ($("changelogText")?.value || "").trim();

  if (!title || !text) return alert("Titel und Text sind Pflicht.");

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
  if (!canEditChangelog()) return alert("Keine Berechtigung.");
  if (!confirm("Eintrag wirklich lÃ¶schen?")) return;

  try {
    await deleteDoc(doc(db, "changelog", id));
    await loadChangelog();
  } catch (e) {
    alert("LÃ¶schen fehlgeschlagen: " + e.message);
  }
};


/* =====================================================
   CALENDAR
===================================================== */

function calHumanDate(iso) {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString("de-DE", {
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  });
}

function calWeekdayHeaders() {
  return ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
}

function calStartOffset(year, monthZeroBased) {
  const jsDay = new Date(year, monthZeroBased, 1).getDay();
  return jsDay === 0 ? 6 : jsDay - 1;
}

function calDaysInMonth(year, monthZeroBased) {
  return new Date(year, monthZeroBased + 1, 0).getDate();
}

function calTodayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function calIsPastDay(dayIso) {
  return String(dayIso || "") < calTodayISO();
}

function calStatusLabel(entry, myStatus, dayIso) {
  if (!entry) return "Frei";
  if (calIsPastDay(dayIso) || entry.status === "done") return "Vergangen";
  if (myStatus === "confirmed") return "BestÃƒÂ¤tigt";
  if (myStatus === "declined") return "Abgelehnt";
  return "Neu";
}

function calStatusIcon(entry, myStatus, dayIso) {
  if (!entry) return "Ã¢â€”â€¹";
  if (calIsPastDay(dayIso) || entry.status === "done") return "Ã¢â€”Å’";
  if (myStatus === "confirmed") return "Ã¢Å“â€œ";
  if (myStatus === "declined") return "Ãƒâ€”";
  return "!";
}

function calTypeLabel(type) {
  const t = String(type || "").toLowerCase();
  if (t === "ausfahrt") return "Ausfahrt";
  if (t === "treffen") return "Treffen";
  if (t === "tour") return "Tour";
  if (t === "sitzung") return "Sitzung";
  if (t === "aktion") return "Club-Aktion";
  if (t === "sonstiges") return "Sonstiges";
  return type || "Termin";
}

function calendarEntryMatchesFilter(entry, myStatus, dayIso) {
  if (CALENDAR_FILTER === "open") {
    return !!entry && !calIsPastDay(dayIso) && entry.status !== "done" && !myStatus;
  }
  if (CALENDAR_FILTER === "mine") return !!myStatus;
  if (CALENDAR_FILTER === "required") return !!entry?.required;
  return true;
}

function updateCalendarStats() {
  const entries = [...CALENDAR_CACHE.entries()];
  const today = calTodayISO();
  const open = entries.filter(([day, entry]) =>
    day >= today && entry.status !== "done" && !CALENDAR_MY_RSVP_CACHE.get(day)
  ).length;
  const answered = entries.filter(([day]) => CALENDAR_MY_RSVP_CACHE.has(day)).length;
  const required = entries.filter(([, entry]) => !!entry.required).length;

  setText("calStatTotal", entries.length);
  setText("calStatOpen", open);
  setText("calStatMine", answered);
  setText("calStatRequired", required);
}

async function loadMyRsvpsForCalendarMonth() {
  CALENDAR_MY_RSVP_CACHE.clear();

  if (!CURRENT_UID || !CALENDAR_CACHE.size) return;

  const days = [...CALENDAR_CACHE.keys()];

  await Promise.all(days.map(async (dayIso) => {
    try {
      const snap = await getDoc(doc(db, "calendar_days", dayIso, "rsvps", CURRENT_UID));
      if (!snap.exists()) return;

      const d = snap.data() || {};
      if (d.status === "confirmed" || d.status === "declined") {
        CALENDAR_MY_RSVP_CACHE.set(dayIso, d.status);
      }
    } catch (e) {
      console.warn("load calendar rsvp failed:", dayIso, e);
    }
  }));
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
  CALENDAR_MY_RSVP_CACHE.clear();

  try {
    const snaps = await getDocs(
      query(collection(db, "calendar_days"), where("month", "==", CALENDAR_CURRENT_MONTH))
    );

    snaps.forEach((ds) => {
      CALENDAR_CACHE.set(ds.id, { id: ds.id, ...(ds.data() || {}) });
    });

    await loadMyRsvpsForCalendarMonth();
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
  const todayIso = calTodayISO();

  const totalDays = calDaysInMonth(year, monthZero);
  const offset = calStartOffset(year, monthZero);

  updateCalendarStats();

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
    const myStatus = CALENDAR_MY_RSVP_CACHE.get(dayIso) || "";

    const classes = ["calendar-day"];
    if (!calendarEntryMatchesFilter(entry, myStatus, dayIso)) classes.push("calendar-filtered");

    if (!entry) {
      classes.push("day-empty");
    } else if (calIsPastDay(dayIso) || entry.status === "done") {
      classes.push("day-past");
    } else if (myStatus === "confirmed" || myStatus === "declined") {
      classes.push("day-my-rsvp");
    } else {
      classes.push("day-open");
    }

    if (dayIso === todayIso) classes.push("day-today");
    if (entry?.required) classes.push("day-required");

    const label = calStatusLabel(entry, myStatus, dayIso);
    const icon = calStatusIcon(entry, myStatus, dayIso);
    const type = entry ? calTypeLabel(entry.type) : "";
    const destination = entry ? escapeHtml(entry.destination || "Eintrag") : "Frei";
    const time = entry?.time
      ? escapeHtml(entry.time + (entry.endTime ? `Ã¢â‚¬â€œ${entry.endTime}` : ""))
      : "Ã¢â‚¬â€";
    const meet = entry?.meetPoint ? escapeHtml(entry.meetPoint) : "";
    const required = entry?.required ? `<span class="cal-pill cal-pill-required">Pflicht</span>` : "";

    const preview = entry
      ? `
        <div class="calendar-card-top">
          <span class="calendar-status-dot">${icon}</span>
          <span class="calendar-status-text">${escapeHtml(label)}</span>
        </div>
        <div class="calendar-event-title">${destination}</div>
        <div class="calendar-event-meta">${escapeHtml(type)} Ã¢â‚¬Â¢ ${time}</div>
        ${meet ? `<div class="calendar-event-place">Ã°Å¸â€œÂ ${meet}</div>` : ""}
        <div class="calendar-pills">${required}</div>
      `
      : `
        <div class="calendar-card-top">
          <span class="calendar-status-dot">Ã¢â€”â€¹</span>
          <span class="calendar-status-text">Frei</span>
        </div>
        <div class="calendar-empty-text">Kein Eintrag</div>
      `;

    html += `
      <div class="${classes.join(" ")}" onclick="window.openCalendarDay('${dayIso}')">
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

  setText("calDayModalTitle", `Ã°Å¸â€œâ€¦ ${calHumanDate(dayIso)}`);

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
  $("calendarDayModal")?.classList.add("hidden");
};

function fillCalendarDayModal(entry) {
  const manager = canManageCalendar();
  const hasEntry = !!entry;

  setText("calReadDestination", entry?.destination || "-");
  setText("calReadTime", entry?.time || "-");
  setText("calReadMeetPoint", entry?.meetPoint || "-");
  setText("calReadContact", entry?.contact || "-");
  setText("calReadCost", entry?.cost != null && entry?.cost !== "" ? `${Number(entry.cost).toFixed(2)}Ã¢â€šÂ¬` : "-");
  setText("calReadType", entry?.type || "-");
  const myCalendarStatus = entry ? (CALENDAR_MY_RSVP_CACHE.get(entry.id || CALENDAR_SELECTED_DAY) || "") : "";
  const myStatusText = myCalendarStatus === "confirmed"
    ? " Ã¢â‚¬Â¢ Du hast bestÃƒÂ¤tigt"
    : (myCalendarStatus === "declined" ? " Ã¢â‚¬Â¢ Du hast abgelehnt" : "");
  setText("calReadStatus", entry?.status === "done" ? "Abgeschlossen" : (hasEntry ? `Aktiv${myStatusText}` : "Kein Eintrag"));
  setText("calReadNote", entry?.note || "-");
  setText("calReadRequired", entry?.required ? "Ã¢Å“â€¦ Ja" : "Ã¢â‚¬â€");
  setText("calReadMax", entry?.maxParticipants ? String(entry.maxParticipants) : "Ã¢â‚¬â€");
  setText("calReadTime", entry?.time
    ? `${entry.time}${entry.endTime ? ` Ã¢â‚¬â€œ ${entry.endTime}` : ""} Uhr`
    : "-");

  const linkBox = $("calReadLink");
  if (linkBox) {
    const raw = String(entry?.routeLink || "").trim();
    if (raw && /^https?:\/\//i.test(raw)) {
      const safe = escapeAttr(raw);
      linkBox.innerHTML = `<a href="${safe}" target="_blank" rel="noopener">Link ÃƒÂ¶ffnen</a>`;
    } else {
      linkBox.innerText = "Ã¢â‚¬â€";
    }
  }

  const createdBy = entry?.createdBy ? userNameByUid(entry.createdBy) : "Ã¢â‚¬â€";
  const createdAt = entry?.createdAt ? new Date(entry.createdAt).toLocaleString("de-DE") : "";
  setText("calReadCreated", createdAt ? `${createdBy} (${createdAt})` : createdBy);

  const updated = entry?.updatedAt ? new Date(entry.updatedAt).toLocaleString("de-DE") : "Ã¢â‚¬â€";
  setText("calReadUpdated", updated);

  const doneTxt = entry?.status === "done"
    ? `${entry?.doneAt ? new Date(entry.doneAt).toLocaleString("de-DE") : ""} ${entry?.doneBy ? "Ã¢â‚¬Â¢ " + userNameByUid(entry.doneBy) : ""}`.trim()
    : "Ã¢â‚¬â€";

  setText("calReadDone", doneTxt || "Ã¢â‚¬â€");

  const dest = $("calDestination");
  const time = $("calTime");
  const endTime = $("calEndTime");
  const cost = $("calCost");
  const meet = $("calMeetPoint");
  const type = $("calType");
  const note = $("calNote");
  const req = $("calRequired");
  const maxP = $("calMaxParticipants");
  const link = $("calRouteLink");
  const contact = $("calContact");

  if (dest) dest.value = entry?.destination || "";
  if (time) time.value = entry?.time || "";
  if (endTime) endTime.value = entry?.endTime || "";
  if (cost) cost.value = entry?.cost ?? "";
  if (meet) meet.value = entry?.meetPoint || "";
  if (type) type.value = entry?.type || "ausfahrt";
  if (note) note.value = entry?.note || "";
  if (req) req.checked = !!entry?.required;
  if (maxP) maxP.value = entry?.maxParticipants ? String(entry.maxParticipants) : "";
  if (link) link.value = entry?.routeLink || "";
  if (contact) contact.value = entry?.contact || "";

  [dest, time, endTime, cost, meet, type, note, req, maxP, link, contact].forEach((el) => {
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
      ? "Du kannst diesen Tag bearbeiten und abschlieÃƒÅ¸en."
      : "Nur berechtigte Rollen kÃƒÂ¶nnen diesen Tag bearbeiten. Du kannst unten bestÃƒÂ¤tigen oder ablehnen.";
  }

  const rsvpBox = $("calRsvpBox");
  if (rsvpBox) rsvpBox.style.display = hasEntry ? "block" : "none";

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
  if (!canManageCalendar()) return alert("Keine Berechtigung.");
  if (!CALENDAR_SELECTED_DAY) return;

  const destination = $("calDestination")?.value?.trim() || "";
  const time = $("calTime")?.value || "";
  const endTime = $("calEndTime")?.value || "";
  const cost = Number($("calCost")?.value || 0);
  const meetPoint = $("calMeetPoint")?.value?.trim() || "";
  const type = $("calType")?.value || "ausfahrt";
  const note = $("calNote")?.value?.trim() || "";
  const required = !!$("calRequired")?.checked;
  const maxParticipants = Number($("calMaxParticipants")?.value || 0);
  const routeLink = ($("calRouteLink")?.value || "").trim();
  const contact = ($("calContact")?.value || "").trim();

  if (!destination) return alert("Bitte 'Ausfahrt nach / Termin' eintragen.");

  const payload = {
    date: CALENDAR_SELECTED_DAY,
    month: CALENDAR_SELECTED_DAY.slice(0, 7),
    destination,
    time,
    endTime,
    cost,
    meetPoint,
    type,
    note,
    required,
    maxParticipants: maxParticipants > 0 ? maxParticipants : 0,
    routeLink,
    contact,
    status: CALENDAR_CACHE.get(CALENDAR_SELECTED_DAY)?.status || "open",
    updatedBy: CURRENT_UID,
    updatedAt: Date.now()
  };

  try {
    const ref = doc(db, "calendar_days", CALENDAR_SELECTED_DAY);
    const existing = await getDoc(ref);

    if (existing.exists()) {
      await updateDoc(ref, payload);
    } else {
      await setDoc(ref, {
        ...payload,
        createdBy: CURRENT_UID,
        createdAt: Date.now()
      });
    }

    await loadCalendarMonth(CALENDAR_CURRENT_MONTH);

    const snap = await getDoc(ref);
    if (snap.exists()) {
      const entry = { id: snap.id, ...(snap.data() || {}) };
      CALENDAR_CACHE.set(CALENDAR_SELECTED_DAY, entry);
      fillCalendarDayModal(entry);
    }

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
    if (snap.exists()) fillCalendarDayModal({ id: snap.id, ...(snap.data() || {}) });
  } catch (e) {
    alert("AbschlieÃƒÅ¸en fehlgeschlagen: " + e.message);
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
    if (snap.exists()) fillCalendarDayModal({ id: snap.id, ...(snap.data() || {}) });
  } catch (e) {
    alert("Wieder ÃƒÂ¶ffnen fehlgeschlagen: " + e.message);
  }
};

window.setCalendarRsvp = async (status) => {
  if (!CALENDAR_SELECTED_DAY) return;

  const entry = CALENDAR_CACHE.get(CALENDAR_SELECTED_DAY);
  if (!entry) return alert("FÃƒÂ¼r diesen Tag ist noch nichts eingetragen.");

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

    CALENDAR_MY_RSVP_CACHE.set(CALENDAR_SELECTED_DAY, status);
    renderCalendarGrid(CALENDAR_CURRENT_MONTH);
    await loadCalendarRsvps(CALENDAR_SELECTED_DAY, true);
  } catch (e) {
    alert("BestÃƒÂ¤tigung/Ablehnung fehlgeschlagen: " + e.message);
  }
};

async function loadCalendarRsvps(dayIso, hasEntry) {
  const myBox = $("calMyRsvpStatus");
  const list = $("calRsvpList");

  if (!hasEntry) {
    if (myBox) myBox.innerText = "Kein Eintrag vorhanden.";
    if (list) list.innerHTML = `<div class="card">Noch keine RÃƒÂ¼ckmeldungen.</div>`;
    return;
  }

  try {
    const mySnap = await getDoc(doc(db, "calendar_days", dayIso, "rsvps", CURRENT_UID));

    if (mySnap.exists()) {
      const d = mySnap.data() || {};
      const txt = d.status === "confirmed" ? "Ã¢Å“â€¦ BestÃƒÂ¤tigt" : "Ã¢ÂÅ’ Abgelehnt";
      const when = d.updatedAt ? new Date(d.updatedAt).toLocaleString("de-DE") : "-";

      CALENDAR_MY_RSVP_CACHE.set(dayIso, d.status);
      renderCalendarGrid(CALENDAR_CURRENT_MONTH);
      if (myBox) myBox.innerText = `Dein Status: ${txt} (${when})`;
    } else {
      if (myBox) myBox.innerText = "Kein Status gesetzt.";
    }
  } catch (e) {
    console.warn("load my rsvp failed:", e);
    if (myBox) myBox.innerText = "Dein Status konnte nicht geladen werden.";
  }

  try {
    const snaps = await getDocs(collection(db, "calendar_days", dayIso, "rsvps"));
    const rows = [];

    snaps.forEach((ds) => rows.push(ds.data() || {}));
    rows.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));

    if (!rows.length) {
      if (list) list.innerHTML = `<div class="card">Noch keine RÃƒÂ¼ckmeldungen.</div>`;
      return;
    }

    if (list) {
      list.innerHTML = rows.map((r) => {
        const st = r.status === "confirmed" ? "Ã¢Å“â€¦ BestÃƒÂ¤tigt" : "Ã¢ÂÅ’ Abgelehnt";
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

