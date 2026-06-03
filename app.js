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
  deleteField,
  onSnapshot
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

/* Member Only */
let MEMBER_ONLY_PROFILE = null;
let MEMBER_ONLY_MESSAGES_CACHE = [];
let MEMBER_ONLY_UNSUB = null;
let MEMBER_ONLY_PENDING_IMAGE = "";
let MEMBER_ONLY_PENDING_IMAGE_NAME = "";
let MEMBER_ONLY_BADGE_UNSUB = null;
let MEMBER_ONLY_UNREAD_COUNT = 0;
let MEMBER_ONLY_RECOGNIZED_IMAGES_CACHE = [];

/* Calendar */
let CALENDAR_CURRENT_MONTH = new Date().toISOString().slice(0, 7);
let CALENDAR_SELECTED_DAY = null;
let CALENDAR_CACHE = new Map();
let CALENDAR_MY_RSVP_CACHE = new Map(); // dayIso -> confirmed / declined

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
   MEMBER ONLY HELPERS
===================================================== */

function rankKey(rank = CURRENT_RANK) {
  return String(rank || "member").toLowerCase().trim();
}

function memberOnlyAllowedRanks() {
  return [
    "admin",
    "president",
    "vice_president",
    "sergeant_at_arms",
    "secretary",
    "road_captain",
    "treasurer",
    "member"
  ];
}

function canOpenMemberOnly() {
  return !!CURRENT_UID && memberOnlyAllowedRanks().includes(rankKey());
}

function rankLabel(rank = CURRENT_RANK) {
  const r = rankKey(rank);
  const map = {
    admin: "Admin",
    president: "President",
    vice_president: "Vice President",
    sergeant_at_arms: "Sergeant At Arms",
    secretary: "Secretary",
    road_captain: "Road Captain",
    treasurer: "Treasurer",
    member: "Member",
    prospect: "Prospect",
    hangaround: "Hangaround",
    supporter: "Supporter"
  };
  return map[r] || String(rank || "Member");
}

function rankClass(rank = CURRENT_RANK) {
  const r = rankKey(rank);
  if (r === "admin") return "rank-admin";
  if (r === "president") return "rank-president";
  if (r === "vice_president") return "rank-vice";
  if (r === "sergeant_at_arms") return "rank-sergeant";
  if (r === "secretary") return "rank-secretary";
  if (r === "road_captain") return "rank-road";
  if (r === "treasurer") return "rank-treasurer";
  return "rank-member";
}

function displayMemberOnlyName() {
  return MEMBER_ONLY_PROFILE?.name || "";
}

function canEditMemberOnlyMessage(m) {
  return !!m && (m.createdBy === CURRENT_UID || isAdmin());
}

function memberOnlyDefaultAvatar(name = "") {
  const n = String(name || "?").trim();
  return escapeHtml((n[0] || "?").toUpperCase());
}

function memberOnlyAvatarHtml(profile, name) {
  const img = profile?.photoData || "";
  if (img) {
    return `<img class="mo-avatar-img" src="${escapeAttr(img)}" alt="">`;
  }
  return `<span>${memberOnlyDefaultAvatar(name)}</span>`;
}

function formatDateTime(ts) {
  if (!ts) return "-";
  try {
    return new Date(Number(ts)).toLocaleString("de-DE");
  } catch {
    return "-";
  }
}

function shortTime(ts) {
  if (!ts) return "";
  try {
    return new Date(Number(ts)).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function canChangeMemberOnlyName(lastChangedAt) {
  if (!lastChangedAt) return true;
  const week = 7 * 24 * 60 * 60 * 1000;
  return Date.now() - Number(lastChangedAt || 0) >= week;
}

function nextNameChangeText(lastChangedAt) {
  if (!lastChangedAt) return "Du kannst deinen Namen jetzt setzen.";
  const next = Number(lastChangedAt) + 7 * 24 * 60 * 60 * 1000;
  if (Date.now() >= next) return "Du kannst deinen Namen jetzt ändern.";
  return `Nächste Namensänderung möglich: ${new Date(next).toLocaleString("de-DE")}`;
}

async function loadMemberOnlyProfile() {
  MEMBER_ONLY_PROFILE = null;

  if (!CURRENT_UID) return null;

  try {
    const snap = await getDoc(doc(db, "member_only_profiles", CURRENT_UID));
    MEMBER_ONLY_PROFILE = snap.exists() ? (snap.data() || {}) : null;
    syncMemberOnlySettingsUI();
    return MEMBER_ONLY_PROFILE;
  } catch (e) {
    console.warn("loadMemberOnlyProfile failed:", e);
    syncMemberOnlySettingsUI();
    return null;
  }
}

function syncMemberOnlySettingsUI() {
  const nameInput = $("memberOnlyNameInput");
  const nameHint = $("memberOnlyNameHint");
  const profilePreview = $("memberOnlyProfilePreview");

  if (nameInput) {
    nameInput.value = MEMBER_ONLY_PROFILE?.name || "";
    nameInput.disabled = MEMBER_ONLY_PROFILE?.nameLastChangedAt
      ? !canChangeMemberOnlyName(MEMBER_ONLY_PROFILE.nameLastChangedAt)
      : false;
  }

  if (nameHint) {
    nameHint.innerText = MEMBER_ONLY_PROFILE?.nameLastChangedAt
      ? nextNameChangeText(MEMBER_ONLY_PROFILE.nameLastChangedAt)
      : "Pflicht: Ohne Namen kommst du nicht in Member Only rein.";
  }

  if (profilePreview) {
    const name = MEMBER_ONLY_PROFILE?.name || userNameByUid(CURRENT_UID);
    profilePreview.innerHTML = `
      <div class="mo-profile-preview-avatar">
        ${memberOnlyAvatarHtml(MEMBER_ONLY_PROFILE, name)}
      </div>
      <div>
        <b>${escapeHtml(name || "Kein Name gesetzt")}</b><br>
        <span class="${rankClass()}">${escapeHtml(rankLabel())}</span>
      </div>
    `;
  }
}


function isMemberOnlyVisible() {
  const screen = $("memberOnlyScreen");
  return !!screen && !screen.classList.contains("hidden");
}

function updateMemberOnlyBadge(count) {
  MEMBER_ONLY_UNREAD_COUNT = Math.max(0, Number(count || 0));

  const badge = $("memberOnlyBadge");
  const btn = $("memberOnlyBtn");

  if (!badge || !btn) return;

  if (MEMBER_ONLY_UNREAD_COUNT > 0) {
    badge.innerText = MEMBER_ONLY_UNREAD_COUNT > 99 ? "99+" : String(MEMBER_ONLY_UNREAD_COUNT);
    badge.classList.remove("hidden");
    btn.classList.add("has-badge");
  } else {
    badge.innerText = "";
    badge.classList.add("hidden");
    btn.classList.remove("has-badge");
  }

  try {
    if ("setAppBadge" in navigator && MEMBER_ONLY_UNREAD_COUNT > 0) {
      navigator.setAppBadge(MEMBER_ONLY_UNREAD_COUNT);
    } else if ("clearAppBadge" in navigator && MEMBER_ONLY_UNREAD_COUNT === 0) {
      navigator.clearAppBadge();
    }
  } catch (e) {
    // Nicht jeder Browser unterstützt App-Badges. Der Button-Badge funktioniert trotzdem.
  }
}

function startMemberOnlyBadgeListener() {
  if (!canOpenMemberOnly()) {
    updateMemberOnlyBadge(0);
    return;
  }

  if (MEMBER_ONLY_BADGE_UNSUB) {
    MEMBER_ONLY_BADGE_UNSUB();
    MEMBER_ONLY_BADGE_UNSUB = null;
  }

  const q = query(
    collection(db, "member_only_messages"),
    orderBy("createdAt", "desc"),
    limit(100)
  );

  MEMBER_ONLY_BADGE_UNSUB = onSnapshot(q, (snap) => {
    if (isMemberOnlyVisible()) {
      updateMemberOnlyBadge(0);
      return;
    }

    const lastRead = Number(MEMBER_ONLY_PROFILE?.memberOnlyLastReadAt || 0);
    let count = 0;

    snap.forEach((ds) => {
      const m = ds.data() || {};
      if (m.deleted) return;
      if (m.createdBy === CURRENT_UID) return;
      if (Number(m.createdAt || 0) > lastRead) count++;
    });

    updateMemberOnlyBadge(count);
  }, (e) => {
    console.warn("member only badge listener failed:", e);
  });
}

async function markMemberOnlyRead() {
  if (!CURRENT_UID || !canOpenMemberOnly()) return;

  try {
    const now = Date.now();

    await setDoc(
      doc(db, "member_only_profiles", CURRENT_UID),
      {
        uid: CURRENT_UID,
        rank: CURRENT_RANK || "member",
        memberOnlyLastReadAt: now,
        updatedAt: now
      },
      { merge: true }
    );

    MEMBER_ONLY_PROFILE = {
      ...(MEMBER_ONLY_PROFILE || {}),
      memberOnlyLastReadAt: now
    };

    updateMemberOnlyBadge(0);
  } catch (e) {
    console.warn("markMemberOnlyRead failed:", e);
  }
}


async function saveMemberOnlyNameFromSettings() {
  if (!canOpenMemberOnly()) {
    alert("Member Only ist erst ab Member freigeschaltet.");
    return;
  }

  const input = $("memberOnlyNameInput");
  const name = String(input?.value || "").trim();

  if (!name) return alert("Bitte gib einen Namen ein.");
  if (name.length < 2) return alert("Der Name ist zu kurz.");
  if (name.length > 32) return alert("Der Name darf maximal 32 Zeichen haben.");

  if (MEMBER_ONLY_PROFILE?.nameLastChangedAt && !canChangeMemberOnlyName(MEMBER_ONLY_PROFILE.nameLastChangedAt)) {
    alert(nextNameChangeText(MEMBER_ONLY_PROFILE.nameLastChangedAt));
    return;
  }

  try {
    await setDoc(
      doc(db, "member_only_profiles", CURRENT_UID),
      {
        uid: CURRENT_UID,
        name,
        rank: CURRENT_RANK || "member",
        nameLower: name.toLowerCase(),
        nameLastChangedAt: Date.now(),
        updatedAt: Date.now()
      },
      { merge: true }
    );

    await loadMemberOnlyProfile();
    startMemberOnlyBadgeListener();
    alert("Member-Only-Name gespeichert ✅");
  } catch (e) {
    alert("Name speichern fehlgeschlagen: " + e.message);
  }
}

function resizeImageToDataUrl(file, maxSize = 360, quality = 0.78) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error("Keine Datei gewählt."));
    if (!file.type.startsWith("image/")) return reject(new Error("Bitte ein Bild auswählen."));

    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));

        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;

        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);

        const dataUrl = canvas.toDataURL("image/jpeg", quality);
        resolve(dataUrl);
      };
      img.onerror = () => reject(new Error("Bild konnte nicht gelesen werden."));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error("Datei konnte nicht gelesen werden."));
    reader.readAsDataURL(file);
  });
}

async function saveMemberOnlyPhotoFromSettings(file) {
  if (!canOpenMemberOnly()) {
    alert("Member Only ist erst ab Member freigeschaltet.");
    return;
  }

  if (!file) return;

  try {
    const dataUrl = await resizeImageToDataUrl(file, 360, 0.78);

    if (dataUrl.length > 650000) {
      alert("Bild ist trotz Komprimierung zu groß. Bitte kleineres Bild wählen.");
      return;
    }

    await setDoc(
      doc(db, "member_only_profiles", CURRENT_UID),
      {
        uid: CURRENT_UID,
        rank: CURRENT_RANK || "member",
        photoData: dataUrl,
        photoUpdatedAt: Date.now(),
        updatedAt: Date.now()
      },
      { merge: true }
    );

    await loadMemberOnlyProfile();
    alert("Profilbild gespeichert ✅");
  } catch (e) {
    alert("Profilbild speichern fehlgeschlagen: " + e.message);
  }
}

async function prepareMemberOnlyImage(file) {
  if (!file) return;

  try {
    const dataUrl = await resizeImageToDataUrl(file, 900, 0.78);

    if (dataUrl.length > 850000) {
      alert("Bild ist zu groß. Bitte kleineres Bild wählen.");
      return;
    }

    MEMBER_ONLY_PENDING_IMAGE = dataUrl;
    MEMBER_ONLY_PENDING_IMAGE_NAME = file.name || "Bild";

    const preview = $("memberOnlyImagePreview");
    if (preview) {
      preview.innerHTML = `
        <div class="mo-image-preview">
          <img src="${escapeAttr(dataUrl)}" alt="">
          <button type="button" class="smallbtn danger" onclick="window.clearMemberOnlyImage()">Bild entfernen</button>
        </div>
      `;
    }
  } catch (e) {
    alert("Bild konnte nicht vorbereitet werden: " + e.message);
  }
}

window.clearMemberOnlyImage = () => {
  MEMBER_ONLY_PENDING_IMAGE = "";
  MEMBER_ONLY_PENDING_IMAGE_NAME = "";

  const file = $("memberOnlyImageInput");
  if (file) file.value = "";

  const preview = $("memberOnlyImagePreview");
  if (preview) preview.innerHTML = "";
};

function extractRecognizedFromText(text) {
  const raw = String(text || "");

  const emails = [...new Set((raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []))];

  const phones = [...new Set((raw.match(/(?:\+49|0049|0)[\d\s\-()/]{6,}/g) || [])
    .map(x => x.trim())
    .filter(x => x.replace(/\D/g, "").length >= 7))];

  const urls = [...new Set((raw.match(/https?:\/\/[^\s]+/gi) || []))];

  const addresses = [...new Set((raw.match(/\b[A-ZÄÖÜ][A-Za-zÄÖÜäöüß.\- ]{2,40}(?:straße|str\.|weg|allee|platz|ring|gasse|damm)\s+\d+[a-zA-Z]?(?:,\s*\d{5}\s+[A-Za-zÄÖÜäöüß.\- ]+)?/g) || [])
    .map(x => x.trim()))];

  return { emails, phones, urls, addresses };
}

function extractRecognizedFromMemberMessages() {
  const result = {
    phones: new Set(),
    emails: new Set(),
    addresses: new Set(),
    images: [],
    urls: new Set()
  };

  MEMBER_ONLY_MESSAGES_CACHE.forEach((m) => {
    if (m.deleted) return;

    const found = extractRecognizedFromText(m.text || "");
    found.phones.forEach(x => result.phones.add(x));
    found.emails.forEach(x => result.emails.add(x));
    found.addresses.forEach(x => result.addresses.add(x));
    found.urls.forEach(x => result.urls.add(x));

    if (m.imageData) {
      result.images.push({
        id: m.id,
        by: m.authorName || "-",
        at: m.createdAt || 0,
        src: m.imageData
      });
    }
  });

  return {
    phones: [...result.phones],
    emails: [...result.emails],
    addresses: [...result.addresses],
    urls: [...result.urls],
    images: result.images
  };
}


function memberOnlyImageDateKey(ts) {
  if (!ts) return "unbekannt";

  const d = new Date(Number(ts || 0));
  if (Number.isNaN(d.getTime())) return "unbekannt";

  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");

  return `${y}-${m}-${day}`;
}

function memberOnlyImageDateLabel(key) {
  if (!key || key === "unbekannt") return "Unbekanntes Datum";

  try {
    const d = new Date(`${key}T00:00:00`);
    return d.toLocaleDateString("de-DE", {
      weekday: "long",
      day: "2-digit",
      month: "2-digit",
      year: "numeric"
    });
  } catch {
    return key;
  }
}

function groupMemberOnlyImagesByDate(images) {
  const groups = new Map();

  (images || []).forEach((img) => {
    const key = memberOnlyImageDateKey(img.at);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(img);
  });

  return [...groups.entries()]
    .map(([key, items]) => ({
      key,
      label: memberOnlyImageDateLabel(key),
      items: items.sort((a, b) => Number(b.at || 0) - Number(a.at || 0))
    }))
    .sort((a, b) => {
      if (a.key === "unbekannt") return 1;
      if (b.key === "unbekannt") return -1;
      return String(b.key).localeCompare(String(a.key));
    });
}

function renderMemberOnlyImagesSmallGrid(images) {
  if (!images || !images.length) {
    return `<div class="small-note">Keine Bilder erkannt.</div>`;
  }

  return `
    <div class="mo-detect-images">
      ${images.map((img) => `
        <a href="${escapeAttr(img.src)}" target="_blank" class="mo-detect-img">
          <img src="${escapeAttr(img.src)}" alt="">
          <span>${escapeHtml(img.by)} • ${escapeHtml(formatDateTime(img.at))}</span>
        </a>
      `).join("")}
    </div>
  `;
}

function renderMemberOnlyImageGalleryBlock(images) {
  if (!images || !images.length) {
    return `<div class="small-note">Keine Bilder erkannt.</div>`;
  }

  if (images.length <= 5) {
    return renderMemberOnlyImagesSmallGrid(images);
  }

  return `
    <div class="mo-gallery-tools">
      <div class="small-note">
        Mehr als 5 Bilder erkannt. Die Bilder wurden automatisch nach Datum in Ordner sortiert.
      </div>

      <label class="field-label" for="memberOnlyImageDateSearch">Nach Datum suchen</label>
      <div class="mo-gallery-search-row">
        <input id="memberOnlyImageDateSearch" type="date">
        <button type="button" class="smallbtn gray" onclick="window.clearMemberOnlyImageDateSearch()">Alle</button>
      </div>
    </div>

    <div id="memberOnlyImageFolders" class="mo-image-folders"></div>
  `;
}

function renderMemberOnlyImageFolders() {
  const box = $("memberOnlyImageFolders");
  if (!box) return;

  const dateInput = $("memberOnlyImageDateSearch");
  const filterDate = String(dateInput?.value || "").trim();

  const groups = groupMemberOnlyImagesByDate(MEMBER_ONLY_RECOGNIZED_IMAGES_CACHE)
    .filter((g) => !filterDate || g.key === filterDate);

  if (!groups.length) {
    box.innerHTML = `
      <div class="card mo-gallery-empty">
        Für dieses Datum wurden keine Bilder gefunden.
      </div>
    `;
    return;
  }

  box.innerHTML = groups.map((group) => {
    const cover = group.items[0];

    return `
      <button type="button" class="mo-image-folder" onclick="window.openMemberOnlyImageFolder('${escapeAttr(group.key)}')">
        <div class="mo-folder-cover">
          ${cover?.src ? `<img src="${escapeAttr(cover.src)}" alt="">` : `<span>🖼️</span>`}
          <span class="mo-folder-count">${group.items.length}</span>
        </div>

        <div class="mo-folder-info">
          <b>${escapeHtml(group.label)}</b>
          <span>${group.items.length} Bild${group.items.length === 1 ? "" : "er"}</span>
        </div>
      </button>
    `;
  }).join("");
}

window.clearMemberOnlyImageDateSearch = () => {
  const input = $("memberOnlyImageDateSearch");
  if (input) input.value = "";
  renderMemberOnlyImageFolders();
};

window.openMemberOnlyImageFolder = (dateKey) => {
  const box = $("memberOnlyRecognizedContent");
  if (!box) return;

  const groups = groupMemberOnlyImagesByDate(MEMBER_ONLY_RECOGNIZED_IMAGES_CACHE);
  const group = groups.find((g) => g.key === dateKey);

  if (!group) {
    alert("Ordner nicht gefunden.");
    return;
  }

  box.innerHTML = `
    <div class="card mo-gallery-folder-open">
      <div class="mo-gallery-folder-head">
        <div>
          <h4>🖼️ ${escapeHtml(group.label)}</h4>
          <div class="small-note">${group.items.length} Bild${group.items.length === 1 ? "" : "er"} in diesem Ordner</div>
        </div>

        <button type="button" class="smallbtn gray" onclick="window.backToMemberOnlyImageFolders()">⬅ Ordner</button>
      </div>

      <div class="mo-gallery-open-grid">
        ${group.items.map((img) => `
          <a href="${escapeAttr(img.src)}" target="_blank" class="mo-gallery-open-img">
            <img src="${escapeAttr(img.src)}" alt="">
            <span>${escapeHtml(img.by)} • ${escapeHtml(formatDateTime(img.at))}</span>
          </a>
        `).join("")}
      </div>
    </div>
  `;
};

window.backToMemberOnlyImageFolders = () => {
  window.openMemberOnlyRecognizedModal();

  setTimeout(() => {
    const imagesTitle = $("memberOnlyImageFolders");
    if (imagesTitle) imagesTitle.scrollIntoView({ behavior: "smooth", block: "start" });
  }, 60);
};



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
  await loadMemberOnlyProfile();
  startMemberOnlyBadgeListener();
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

  const memberOnlyBtn = $("memberOnlyBtn");
  if (memberOnlyBtn) memberOnlyBtn.onclick = () => window.openMemberOnly();

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

  const memberOnlyNameSaveBtn = $("memberOnlyNameSaveBtn");
  if (memberOnlyNameSaveBtn) memberOnlyNameSaveBtn.onclick = () => saveMemberOnlyNameFromSettings();

  const memberOnlyPhotoInput = $("memberOnlyPhotoInput");
  if (memberOnlyPhotoInput) {
    memberOnlyPhotoInput.onchange = () => saveMemberOnlyPhotoFromSettings(memberOnlyPhotoInput.files?.[0] || null);
  }

  const memberOnlySendBtn = $("memberOnlySendBtn");
  if (memberOnlySendBtn) memberOnlySendBtn.onclick = () => window.sendMemberOnlyMessage();

  const memberOnlyText = $("memberOnlyText");
  if (memberOnlyText) {
    memberOnlyText.onkeydown = (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        window.sendMemberOnlyMessage();
      }
    };
  }

  const memberOnlyImageInput = $("memberOnlyImageInput");
  if (memberOnlyImageInput) {
    memberOnlyImageInput.onchange = () => prepareMemberOnlyImage(memberOnlyImageInput.files?.[0] || null);
  }

  const memberOnlyMenuBtn = $("memberOnlyMenuBtn");
  if (memberOnlyMenuBtn) memberOnlyMenuBtn.onclick = () => window.openMemberOnlyRecognizedModal();

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
   MEMBER ONLY CHAT
===================================================== */

window.openMemberOnly = async () => {
  if (!canOpenMemberOnly()) {
    alert("Member Only ist erst ab Member freigeschaltet. Hangaround, Prospect und Supporter haben keinen Zugriff.");
    return;
  }

  await loadMemberOnlyProfile();

  if (!displayMemberOnlyName()) {
    alert("Bitte zuerst in den Einstellungen deinen Member-Only-Namen eintragen.");
    openSettingsModal();
    return;
  }

  window.showScreen("memberOnlyScreen");
  await markMemberOnlyRead();
  startMemberOnlyListener();
};

window.closeMemberOnlyRecognizedModal = () => {
  $("memberOnlyRecognizedModal")?.classList.add("hidden");
};

window.openMemberOnlyRecognizedModal = () => {
  const modal = $("memberOnlyRecognizedModal");
  const box = $("memberOnlyRecognizedContent");
  if (!modal || !box) return;

  const found = extractRecognizedFromMemberMessages();
  MEMBER_ONLY_RECOGNIZED_IMAGES_CACHE = found.images || [];

  const listBlock = (title, items, render) => {
    if (!items.length) {
      return `
        <div class="card">
          <h4>${title}</h4>
          <div class="small-note">Nichts erkannt.</div>
        </div>
      `;
    }

    return `
      <div class="card">
        <h4>${title}</h4>
        ${items.map(render).join("")}
      </div>
    `;
  };

  box.innerHTML = `
    ${listBlock("📞 Erkannte Telefonnummern", found.phones, (x) => `
      <a class="mo-detect-row" href="tel:${escapeAttr(x.replace(/\s/g, ""))}">${escapeHtml(x)}</a>
    `)}

    ${listBlock("✉️ Erkannte E-Mails", found.emails, (x) => `
      <a class="mo-detect-row" href="mailto:${escapeAttr(x)}">${escapeHtml(x)}</a>
    `)}

    ${listBlock("📍 Erkannte Adressen", found.addresses, (x) => `
      <a class="mo-detect-row" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(x)}">${escapeHtml(x)}</a>
    `)}

    ${listBlock("🔗 Erkannte Links", found.urls, (x) => `
      <a class="mo-detect-row" target="_blank" rel="noopener" href="${escapeAttr(x)}">${escapeHtml(x)}</a>
    `)}

    <div class="card">
      <h4>🖼️ Erkannte Bilder</h4>
      ${renderMemberOnlyImageGalleryBlock(found.images)}
    </div>
  `;

  modal.classList.remove("hidden");

  const imageDateSearch = $("memberOnlyImageDateSearch");
  if (imageDateSearch) {
    imageDateSearch.oninput = () => renderMemberOnlyImageFolders();
    imageDateSearch.onchange = () => renderMemberOnlyImageFolders();
  }

  renderMemberOnlyImageFolders();
};

function startMemberOnlyListener() {
  const list = $("memberOnlyMessages");
  if (!list) return;

  if (MEMBER_ONLY_UNSUB) {
    MEMBER_ONLY_UNSUB();
    MEMBER_ONLY_UNSUB = null;
  }

  list.innerHTML = `<div class="card">Lade Member Only...</div>`;

  const q = query(
    collection(db, "member_only_messages"),
    orderBy("createdAt", "asc"),
    limit(250)
  );

  MEMBER_ONLY_UNSUB = onSnapshot(q, (snap) => {
    MEMBER_ONLY_MESSAGES_CACHE = [];

    snap.forEach((ds) => {
      MEMBER_ONLY_MESSAGES_CACHE.push({ id: ds.id, ...(ds.data() || {}) });
    });

    renderMemberOnlyMessages();
  }, (e) => {
    list.innerHTML = `<div class="card">Fehler beim Laden: ${escapeHtml(e.message)}</div>`;
  });
}

function renderMemberOnlyMessages() {
  const list = $("memberOnlyMessages");
  if (!list) return;

  if (isMemberOnlyVisible()) {
    updateMemberOnlyBadge(0);
  }

  if (!MEMBER_ONLY_MESSAGES_CACHE.length) {
    list.innerHTML = `
      <div class="card mo-empty">
        Noch keine Nachrichten. Schreib die erste Nachricht in Member Only.
      </div>
    `;
    return;
  }

  list.innerHTML = MEMBER_ONLY_MESSAGES_CACHE.map((m) => {
    const mine = m.createdBy === CURRENT_UID;
    const deleted = !!m.deleted;
    const edited = !!m.editedAt && !deleted;
    const authorName = m.authorName || "Unbekannt";
    const authorRank = m.authorRank || "member";
    const photoData = m.authorPhotoData || "";
    const profile = { photoData };

    const actionBtns = canEditMemberOnlyMessage(m) && !deleted
      ? `
        <div class="mo-msg-actions">
          <button type="button" class="smallbtn gray" onclick="window.editMemberOnlyMessage('${m.id}')">Bearbeiten</button>
          <button type="button" class="smallbtn danger" onclick="window.deleteMemberOnlyMessage('${m.id}')">Löschen</button>
        </div>
      `
      : "";

    const deletedBy = m.deletedByName || userNameByUid(m.deletedByUid) || "-";
    const deletedText = `Nachricht wurde am ${formatDateTime(m.deletedAt)} gelöscht von ${deletedBy}`;

    return `
      <div class="mo-msg ${mine ? "mine" : "other"} ${deleted ? "is-deleted" : ""}">
        <div class="mo-avatar">
          ${memberOnlyAvatarHtml(profile, authorName)}
        </div>

        <div class="mo-bubble">
          <div class="mo-meta">
            <span class="mo-rank ${rankClass(authorRank)}">${escapeHtml(rankLabel(authorRank))}</span>
            <span class="mo-name ${rankClass(authorRank)}">${escapeHtml(authorName)}</span>
            <span class="mo-time">${escapeHtml(shortTime(m.createdAt))}</span>
          </div>

          ${edited ? `<div class="mo-edited">Nachricht bearbeitet</div>` : ""}

          ${deleted ? `
            <div class="mo-deleted-text">${escapeHtml(deletedText)}</div>
          ` : `
            ${m.text ? `<div class="mo-text">${escapeHtml(m.text).replace(/\n/g, "<br>")}</div>` : ""}
            ${m.imageData ? `<img class="mo-message-img" src="${escapeAttr(m.imageData)}" alt="Bild">` : ""}
          `}

          ${actionBtns}
        </div>
      </div>
    `;
  }).join("");

  list.scrollTop = list.scrollHeight;
}

window.sendMemberOnlyMessage = async () => {
  if (!canOpenMemberOnly()) {
    alert("Kein Zugriff auf Member Only.");
    return;
  }

  await loadMemberOnlyProfile();

  const name = displayMemberOnlyName();
  if (!name) {
    alert("Bitte zuerst in den Einstellungen deinen Member-Only-Namen eintragen.");
    openSettingsModal();
    return;
  }

  const input = $("memberOnlyText");
  const text = String(input?.value || "").trim();

  if (!text && !MEMBER_ONLY_PENDING_IMAGE) {
    return;
  }

  if (text.length > 2500) {
    alert("Nachricht ist zu lang. Bitte kürzer schreiben.");
    return;
  }

  try {
    await addDoc(collection(db, "member_only_messages"), {
      text,
      imageData: MEMBER_ONLY_PENDING_IMAGE || "",
      imageName: MEMBER_ONLY_PENDING_IMAGE_NAME || "",
      createdBy: CURRENT_UID,
      authorName: name,
      authorRank: CURRENT_RANK || "member",
      authorPhotoData: MEMBER_ONLY_PROFILE?.photoData || "",
      createdAt: Date.now(),
      editedAt: null,
      editedBy: null,
      deleted: false,
      deletedAt: null,
      deletedByUid: null,
      deletedByName: ""
    });

    if (input) input.value = "";
    window.clearMemberOnlyImage();
  } catch (e) {
    alert("Nachricht senden fehlgeschlagen: " + e.message);
  }
};

window.editMemberOnlyMessage = async (id) => {
  const m = MEMBER_ONLY_MESSAGES_CACHE.find(x => x.id === id);
  if (!m) return alert("Nachricht nicht gefunden.");
  if (!canEditMemberOnlyMessage(m)) return alert("Du darfst diese Nachricht nicht bearbeiten.");
  if (m.deleted) return alert("Gelöschte Nachrichten können nicht bearbeitet werden.");

  const next = prompt("Nachricht bearbeiten:", m.text || "");
  if (next === null) return;

  const text = String(next).trim();
  if (!text && !m.imageData) return alert("Nachricht darf nicht leer sein.");
  if (text.length > 2500) return alert("Nachricht ist zu lang.");

  try {
    await updateDoc(doc(db, "member_only_messages", id), {
      text,
      editedAt: Date.now(),
      editedBy: CURRENT_UID,
      editedByName: displayMemberOnlyName() || userNameByUid(CURRENT_UID)
    });
  } catch (e) {
    alert("Bearbeiten fehlgeschlagen: " + e.message);
  }
};

window.deleteMemberOnlyMessage = async (id) => {
  const m = MEMBER_ONLY_MESSAGES_CACHE.find(x => x.id === id);
  if (!m) return alert("Nachricht nicht gefunden.");
  if (!canEditMemberOnlyMessage(m)) return alert("Du darfst diese Nachricht nicht löschen.");

  if (!confirm("Nachricht wirklich löschen? Der Platzhalter bleibt sichtbar.")) return;

  try {
    await updateDoc(doc(db, "member_only_messages", id), {
      text: "",
      imageData: "",
      deleted: true,
      deletedAt: Date.now(),
      deletedByUid: CURRENT_UID,
      deletedByName: displayMemberOnlyName() || userNameByUid(CURRENT_UID)
    });
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
  if (myStatus === "confirmed") return "Bestätigt";
  if (myStatus === "declined") return "Abgelehnt";
  return "Neu";
}

function calStatusIcon(entry, myStatus, dayIso) {
  if (!entry) return "○";
  if (calIsPastDay(dayIso) || entry.status === "done") return "◌";
  if (myStatus === "confirmed") return "✓";
  if (myStatus === "declined") return "×";
  return "!";
}

function calTypeLabel(type) {
  const t = String(type || "").toLowerCase();
  if (t === "ausfahrt") return "Ausfahrt";
  if (t === "treffen") return "Treffen";
  if (t === "tour") return "Tour";
  if (t === "sonstiges") return "Sonstiges";
  return type || "Termin";
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
    const time = entry?.time ? escapeHtml(entry.time) : "—";
    const meet = entry?.meetPoint ? escapeHtml(entry.meetPoint) : "";
    const required = entry?.required ? `<span class="cal-pill cal-pill-required">Pflicht</span>` : "";

    const preview = entry
      ? `
        <div class="calendar-card-top">
          <span class="calendar-status-dot">${icon}</span>
          <span class="calendar-status-text">${escapeHtml(label)}</span>
        </div>
        <div class="calendar-event-title">${destination}</div>
        <div class="calendar-event-meta">${escapeHtml(type)} • ${time}</div>
        ${meet ? `<div class="calendar-event-place">📍 ${meet}</div>` : ""}
        <div class="calendar-pills">${required}</div>
      `
      : `
        <div class="calendar-card-top">
          <span class="calendar-status-dot">○</span>
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
  const myCalendarStatus = entry ? (CALENDAR_MY_RSVP_CACHE.get(entry.id || CALENDAR_SELECTED_DAY) || "") : "";
  const myStatusText = myCalendarStatus === "confirmed"
    ? " • Du hast bestätigt"
    : (myCalendarStatus === "declined" ? " • Du hast abgelehnt" : "");
  setText("calReadStatus", entry?.status === "done" ? "Abgeschlossen" : (hasEntry ? `Aktiv${myStatusText}` : "Kein Eintrag"));
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

    CALENDAR_MY_RSVP_CACHE.set(CALENDAR_SELECTED_DAY, status);
    renderCalendarGrid(CALENDAR_CURRENT_MONTH);
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
