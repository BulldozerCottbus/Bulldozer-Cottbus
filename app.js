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
  document.querySelectorAll(".container").forEach((s) => s.classList.add("hidden"));
  const target = $(id);
  if (target) target.classList.remove("hidden");
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
  const postInfoBtn = $("postInfoBtn");
  if (postInfoBtn) postInfoBtn.classList.remove("hidden");
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
  const modal = $("settingsModal");
  if (!modal) return;

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
    if (!confirm("Info wirklich löschen?")) return;

    await deleteDoc(doc(db, "infos", id));

    window.closeInfoModal();
    await loadInfos();
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
        ? ` | läuft ab: ${new Date(d.expiresAt).toLocaleString("de-DE")}`
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
              <button class="smallbtn danger" type="button" onclick="window.deleteInfo('${id}')">Löschen</button>
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
        ? `<button class="smallbtn danger" type="button" onclick="window.deleteChangelogEntry('${ds.id}')">Löschen</button>`
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
  if (!confirm("Eintrag wirklich löschen?")) return;

  try {
    await deleteDoc(doc(db, "changelog", id));
    await loadChangelog();
  } catch (e) {
    alert("Löschen fehlgeschlagen: " + e.message);
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
      : "Frei";

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

  setText("calDayModalTitle", `📅 ${calHumanDate(dayIso)}`);

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
  setText("calReadCost", entry?.cost != null && entry?.cost !== "" ? `${Number(entry.cost).toFixed(2)}€` : "-");
  setText("calReadType", entry?.type || "-");
  setText("calReadStatus", entry?.status === "done" ? "Abgeschlossen" : (hasEntry ? "Aktiv" : "Kein Eintrag"));
  setText("calReadNote", entry?.note || "-");
  setText("calReadRequired", entry?.required ? "✅ Ja" : "—");
  setText("calReadMax", entry?.maxParticipants ? String(entry.maxParticipants) : "—");

  const linkBox = $("calReadLink");
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

  const updated = entry?.updatedAt ? new Date(entry.updatedAt).toLocaleString("de-DE") : "—";
  setText("calReadUpdated", updated);

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
      : "Nur berechtigte Rollen können diesen Tag bearbeiten. Du kannst unten bestätigen oder ablehnen.";
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
  const cost = Number($("calCost")?.value || 0);
  const meetPoint = $("calMeetPoint")?.value?.trim() || "";
  const type = $("calType")?.value || "ausfahrt";
  const note = $("calNote")?.value?.trim() || "";
  const required = !!$("calRequired")?.checked;
  const maxParticipants = Number($("calMaxParticipants")?.value || 0);
  const routeLink = ($("calRouteLink")?.value || "").trim();

  if (!destination) return alert("Bitte 'Ausfahrt nach / Termin' eintragen.");

  const payload = {
    date: CALENDAR_SELECTED_DAY,
    month: CALENDAR_SELECTED_DAY.slice(0, 7),
    destination,
    time,
    cost,
    meetPoint,
    type,
    note,
    required,
    maxParticipants: maxParticipants > 0 ? maxParticipants : 0,
    routeLink,
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
        time: Date.now()
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
    if (snap.exists()) fillCalendarDayModal({ id: snap.id, ...(snap.data() || {}) });
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
