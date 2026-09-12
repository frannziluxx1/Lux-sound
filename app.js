/* =========================================================
   LUX SOUND LAB — app.js
   Single-page app with real History-API routes (/, /search,
   /library, /albums/:name, /artists/:name, /playlists/:id,
   /liked, /recently-played, /local-music, /queue, /equalizer,
   /profile, /settings, /privacy, /about). One <audio>-backed
   playback engine shared by every route, so a song keeps
   playing across navigation.
   ========================================================= */

(() => {
"use strict";

const $  = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => [...root.querySelectorAll(sel)];

/* ============================== state ============================== */
const state = {
  tracks: [],
  queue: [],
  queueIndex: -1,
  currentTrack: null,
  isPlaying: false,
  shuffle: false,
  repeat: false,
  liked: [],
  recent: [], // [{songId, at}]
  objectUrls: new Map(),
  db: null,
  dbReady: false,
  audioContext: null,
  filters: [],
  preampGain: null,
  compressorNode: null,
  analyser: null,
  eqEnabled: true,
  eqGains: [0,0,0,0,0,0,0],
  eqPreamp: 0,
  customPreset: null,
  playlists: [], // {id, name, description, songIds, createdAt}
  profile: { name: "Music Lover", username: "musiclover", avatar: null },
  settings: {
    theme: "dark", accent: 262, compact: false, autoplay: true, crossfade: 0,
    normalize: false, notifications: false, showHistory: true, volume: 80, muted: false,
  },
  recentSearches: [],
  route: "/",
  routeParams: {},
  currentEntity: null, // artist/album/playlist name or id currently viewed
};

const K = {
  liked: "lux_liked", recent: "lux_recent", settings: "lux_settings", eq: "lux_eq",
  profile: "lux_profile", searches: "lux_searches",
};

/* ============================== fallback art ============================== */
const DEFAULT_ART = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#c084fc"/><stop offset=".5" stop-color="#7c5cff"/><stop offset="1" stop-color="#0d3974"/></linearGradient>
    <radialGradient id="r"><stop offset="0" stop-color="#ffffff" stop-opacity=".3"/><stop offset="1" stop-color="#000000" stop-opacity=".2"/></radialGradient>
  </defs>
  <rect width="800" height="800" rx="170" fill="url(#g)"/>
  <circle cx="400" cy="400" r="270" fill="url(#r)" stroke="#ffffff" stroke-opacity=".22" stroke-width="4"/>
  <circle cx="400" cy="400" r="150" fill="none" stroke="#ffffff" stroke-opacity=".12" stroke-width="3"/>
  <circle cx="400" cy="400" r="65" fill="#10111a" stroke="#ffffff" stroke-opacity=".22" stroke-width="5"/>
  <path d="M335 390c30-55 78-72 130-45 23 12 38 31 45 56" fill="none" stroke="#ffffff" stroke-width="19" stroke-linecap="round"/>
  <circle cx="400" cy="400" r="9" fill="#ffffff"/>
</svg>`;
const DEFAULT_ART_URL = "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(DEFAULT_ART);

const DEFAULT_AVATAR = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#c084fc"/><stop offset=".5" stop-color="#7c5cff"/><stop offset="1" stop-color="#347dff"/></linearGradient></defs>
  <rect width="400" height="400" rx="200" fill="url(#bg)"/>
  <circle cx="200" cy="145" r="68" fill="#e9e7ef" fill-opacity=".92"/>
  <path d="M75 350c13-82 57-123 125-123s112 41 125 123" fill="#e9e7ef" fill-opacity=".92"/>
</svg>`;
const DEFAULT_AVATAR_URL = "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(DEFAULT_AVATAR);

function artworkHTML(url = null) {
  if (!url) return `<div class="artwork-fallback"><svg class="icon"><use href="#i-music"/></svg></div>`;
  return `<img src="${escapeAttr(url)}" alt="" loading="lazy" onerror="this.style.display='none';this.parentElement.querySelector('.artwork-fallback').style.display='grid';">
    <div class="artwork-fallback" style="display:none"><svg class="icon"><use href="#i-music"/></svg></div>`;
}
function escapeHTML(v) { return String(v ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;"); }
function escapeAttr(v) { return escapeHTML(v); }
function uid() { return "id" + Date.now().toString(36) + Math.random().toString(36).slice(2,8); }

/* ============================== toast ============================== */
let toastTimer;
function toast(message, type = "info") {
  const el = $("#toast");
  const iconId = type === "error" ? "i-alert" : type === "success" ? "i-check" : "i-info";
  el.className = "toast show" + (type === "error" ? " error" : "");
  el.innerHTML = `<svg class="icon"><use href="#${iconId}"/></svg><span>${escapeHTML(message)}</span>`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), type === "error" ? 5200 : 3000);
}

/* ============================== modal ============================== */
let modalResolve = null;
function showModal(title, text, confirmText = "Continue", fieldHTML = "", { hideCancel=false, stack=false } = {}) {
  $("#modalTitle").textContent = title;
  $("#modalText").textContent = text;
  $("#modalConfirm").textContent = confirmText;
  $("#modalFieldWrap").innerHTML = fieldHTML;
  $("#modalCancel").style.display = hideCancel ? "none" : "";
  $("#modalActionsRow").classList.toggle("stack", stack);
  $("#modalBackdrop").classList.add("open");
  return new Promise(resolve => { modalResolve = resolve; });
}
function closeModal(result) {
  $("#modalBackdrop").classList.remove("open");
  if (modalResolve) { modalResolve(result); modalResolve = null; }
}
$("#modalCancel").addEventListener("click", () => closeModal(false));
$("#modalConfirm").addEventListener("click", () => closeModal(true));
$("#modalBackdrop").addEventListener("click", e => { if (e.target === $("#modalBackdrop")) closeModal(false); });

/* ============================== IndexedDB ============================== */
const DB_NAME = "LuxSoundLabDB", DB_VERSION = 1, STORE_SONGS = "tracks", STORE_PLAYLISTS = "playlists";

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) { reject(new Error("IndexedDB not supported")); return; }
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (err) { reject(err); return; }
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_SONGS)) {
        const s = db.createObjectStore(STORE_SONGS, { keyPath: "id" });
        s.createIndex("libraryKey", "libraryKey", { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_PLAYLISTS)) db.createObjectStore(STORE_PLAYLISTS, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB failed to open"));
    req.onblocked = () => reject(new Error("IndexedDB blocked by another tab"));
  });
}
function dbPut(store, obj) {
  return new Promise((resolve, reject) => {
    if (!state.db) { reject(new Error("no database")); return; }
    const tx = state.db.transaction(store, "readwrite");
    tx.objectStore(store).put(obj);
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
}
function dbGetAll(store) {
  return new Promise((resolve, reject) => {
    if (!state.db) { resolve([]); return; }
    const tx = state.db.transaction(store, "readonly");
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result || []); req.onerror = () => reject(req.error);
  });
}
function dbDelete(store, id) {
  return new Promise((resolve, reject) => {
    if (!state.db) { resolve(); return; }
    const tx = state.db.transaction(store, "readwrite");
    tx.objectStore(store).delete(id);
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
}
function dbClear(store) {
  return new Promise((resolve, reject) => {
    if (!state.db) { resolve(); return; }
    const tx = state.db.transaction(store, "readwrite");
    tx.objectStore(store).clear();
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
}

/* ============================== localStorage ============================== */
function loadStorage() {
  try { state.liked = JSON.parse(localStorage.getItem(K.liked) || "[]"); } catch { state.liked = []; }
  try { state.recent = JSON.parse(localStorage.getItem(K.recent) || "[]"); } catch { state.recent = []; }
  try { state.settings = { ...state.settings, ...JSON.parse(localStorage.getItem(K.settings) || "{}") }; } catch {}
  try {
    const eq = JSON.parse(localStorage.getItem(K.eq) || "null");
    if (eq) { state.eqGains = eq.gains || state.eqGains; state.eqPreamp = eq.preamp || 0; state.eqEnabled = eq.enabled !== false; state.customPreset = eq.custom || null; }
  } catch {}
  try { state.profile = { ...state.profile, ...JSON.parse(localStorage.getItem(K.profile) || "{}") }; } catch {}
  try { state.recentSearches = JSON.parse(localStorage.getItem(K.searches) || "[]"); } catch { state.recentSearches = []; }
}
function saveLiked() { try { localStorage.setItem(K.liked, JSON.stringify(state.liked)); } catch {} }
function saveRecent() { try { localStorage.setItem(K.recent, JSON.stringify(state.recent)); } catch {} }
function saveSettings() { try { localStorage.setItem(K.settings, JSON.stringify(state.settings)); } catch {} }
function saveEq() { try { localStorage.setItem(K.eq, JSON.stringify({ gains: state.eqGains, preamp: state.eqPreamp, enabled: state.eqEnabled, custom: state.customPreset })); } catch {} }
function saveProfile() { try { localStorage.setItem(K.profile, JSON.stringify(state.profile)); } catch (e) { toast("Could not save profile — your avatar image may be too large for local storage.", "error"); } }
function saveSearches() { try { localStorage.setItem(K.searches, JSON.stringify(state.recentSearches)); } catch {} }

/* ============================== track helpers ============================== */
function makeTrackId(file) { return [file.name, file.size, file.lastModified, file.type].join("::"); }
function makeLibraryKey(file) { return [file.name.toLowerCase().trim(), file.size, file.lastModified].join("|"); }
function stripExt(name) { return name.replace(/\.[^/.]+$/, ""); }
function cleanPart(s) { return s.replace(/[_]+/g, " ").replace(/\s+/g, " ").trim(); }
function parseTitleArtist(fileName) {
  const base = stripExt(fileName);
  for (const sep of [" - ", " – ", " — "]) {
    if (base.includes(sep)) {
      const parts = base.split(sep);
      const artist = cleanPart(parts[0]);
      const title = cleanPart(parts.slice(1).join(sep));
      return { title: title || cleanPart(base), artist: artist || "Unknown Artist" };
    }
  }
  return { title: cleanPart(base.replace(/-/g, " ")) || "Unknown Track", artist: "Unknown Artist" };
}
function isAudioFile(file) {
  if (file.type && file.type.startsWith("audio/")) return true;
  return /\.(mp3|m4a|aac|wav|ogg|flac|opus|webm)$/i.test(file.name);
}
function createTrack(file) {
  const parsed = parseTitleArtist(file.name);
  return {
    id: makeTrackId(file), libraryKey: makeLibraryKey(file), name: file.name,
    title: parsed.title, artist: parsed.artist, album: "Unknown Album",
    type: file.type || "audio/*", size: file.size, lastModified: file.lastModified,
    artwork: null, blob: file, importedAt: Date.now(),
  };
}
function getTrackById(id) { return state.tracks.find(t => t.id === id); }
function getTrackURL(track) {
  if (state.objectUrls.has(track.id)) return state.objectUrls.get(track.id);
  const url = URL.createObjectURL(track.blob);
  state.objectUrls.set(track.id, url);
  return url;
}
function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B","KB","MB","GB"]; let i = 0; let n = bytes;
  while (n >= 1024 && i < units.length-1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i>0 ? 1 : 0)} ${units[i]}`;
}
function formatDate(ts) { if (!ts) return "—"; const d = new Date(ts); return d.toLocaleDateString(undefined, { month:"short", day:"numeric", year:"numeric" }); }

/* ============================== library load ============================== */
async function loadLibrary() {
  try {
    state.db = await openDatabase();
    state.dbReady = true;
    state.tracks = (await dbGetAll(STORE_SONGS)) || [];
    state.playlists = (await dbGetAll(STORE_PLAYLISTS)) || [];
  } catch (error) {
    console.warn("Persistent storage unavailable:", error);
    state.dbReady = false; state.tracks = []; state.playlists = [];
  }
}

/* ============================== import pipeline ============================== */
function openFilePicker() { $("#musicInput").value = ""; $("#musicInput").click(); }

async function importFiles(fileList) {
  const files = [...fileList].filter(isAudioFile);
  if (!files.length) { toast("No supported music files were found in that selection. Try MP3, WAV, M4A/AAC or OGG.", "error"); return; }

  const existingKeys = new Set(state.tracks.map(t => t.libraryKey));
  const newFiles = files.filter(f => !existingKeys.has(makeLibraryKey(f)));
  if (!newFiles.length) { toast("Those exact files are already in your library.", "info"); return; }

  const progress = $("#importProgress"), fill = $("#importProgressFill"), status = $("#importStatus"), percent = $("#importPercent");
  progress.classList.add("show");

  let succeeded = 0, failed = 0;
  for (const file of newFiles) {
    const track = createTrack(file);
    try {
      if (state.dbReady) await dbPut(STORE_SONGS, track);
      state.tracks.push(track);
      succeeded++;
    } catch (error) {
      console.error("Could not persist:", file.name, error);
      state.tracks.push(track); succeeded++; failed++;
    }
    const value = Math.round((succeeded / newFiles.length) * 100);
    fill.style.width = `${value}%`; percent.textContent = `${value}%`;
    status.textContent = `Importing ${succeeded} of ${newFiles.length}`;
  }
  setTimeout(() => progress.classList.remove("show"), 500);

  renderRoute();
  navigate("/library");

  if (!state.dbReady) {
    toast(`${succeeded} song${succeeded===1?"":"s"} added for this session — persistent storage isn't available, so your library won't survive a refresh. See Settings for details.`, "error");
  } else if (failed) {
    toast(`${succeeded} song${succeeded===1?"":"s"} added, but ${failed} couldn't be saved permanently.`, "error");
  } else {
    toast(`${succeeded} song${succeeded===1?"":"s"} imported.`, "success");
  }
}

async function requestFolderAccess() {
  if ("showDirectoryPicker" in window) {
    try {
      const directory = await window.showDirectoryPicker({ mode: "read" });
      const files = [];
      async function scan(handle) {
        for await (const entry of handle.values()) {
          if (entry.kind === "file") { const file = await entry.getFile(); if (isAudioFile(file)) files.push(file); }
          else if (entry.kind === "directory") await scan(entry);
        }
      }
      await scan(directory);
      if (!files.length) { toast("No supported audio files found in that folder.", "info"); return; }
      await importFiles(files);
      return;
    } catch (error) {
      if (error?.name === "AbortError") return;
      if (error?.name === "NotAllowedError" || error?.name === "SecurityError") {
        toast("Music access was not granted. Please allow file access and try again.", "error");
        return;
      }
      console.warn("Directory picker failed, falling back to file picker:", error);
    }
  }
  openFilePicker();
}

/* ============================== onboarding ============================== */
function hideOnboarding() { $("#onboarding").style.display = "none"; }
function showOnboarding() { $("#onboarding").style.display = "flex"; }
$("#btnAllowAccess").addEventListener("click", async () => { hideOnboarding(); await requestFolderAccess(); });
$("#btnNotNow").addEventListener("click", () => { hideOnboarding(); navigate("/"); });
$("#musicInput").addEventListener("change", e => importFiles(e.target.files));
$("#folderInput").addEventListener("change", e => importFiles(e.target.files));

/* ============================== ROUTER ============================== */
const ROUTES = ["/", "/search", "/library", "/albums", "/albums/:name", "/artists", "/artists/:name",
  "/playlists", "/playlists/:id", "/liked", "/recently-played", "/local-music", "/queue", "/equalizer",
  "/profile", "/settings", "/privacy", "/about", "/now-playing"];

function matchRoute(path) {
  const clean = path.replace(/\/+$/, "") || "/";
  for (const pattern of ROUTES) {
    const patternParts = pattern.split("/").filter(Boolean);
    const pathParts = clean.split("/").filter(Boolean);
    if (pattern === "/" && clean === "/") return { pattern, params: {} };
    if (patternParts.length !== pathParts.length) continue;
    let ok = true; const params = {};
    for (let i = 0; i < patternParts.length; i++) {
      if (patternParts[i].startsWith(":")) params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
      else if (patternParts[i] !== pathParts[i]) { ok = false; break; }
    }
    if (ok) return { pattern, params };
  }
  return null;
}

function navigate(path, { replace = false } = {}) {
  if (path === "/now-playing") { openNowPlaying(); return; }
  if (replace) history.replaceState({}, "", path); else history.pushState({}, "", path);
  renderRoute();
}
window.addEventListener("popstate", renderRoute);

function pageIdForPattern(pattern) {
  const map = {
    "/": "page-home", "/search": "page-search", "/library": "page-library",
    "/albums": "page-albums", "/albums/:name": "page-album-detail",
    "/artists": "page-artists", "/artists/:name": "page-artist-detail",
    "/playlists": "page-playlists", "/playlists/:id": "page-playlist-detail",
    "/liked": "page-liked", "/recently-played": "page-recent", "/local-music": "page-local-music",
    "/queue": "page-queue", "/equalizer": "page-equalizer", "/profile": "page-profile",
    "/settings": "page-settings", "/privacy": "page-privacy", "/about": "page-about",
  };
  return map[pattern] || "page-404";
}

function renderRoute() {
  const path = location.pathname;
  const match = matchRoute(path) || { pattern: "/404", params: {} };
  state.route = match.pattern; state.routeParams = match.params;
  const pageId = pageIdForPattern(match.pattern);

  $$(".page").forEach(p => p.classList.toggle("active", p.id === pageId));
  $$("[data-route]").forEach(el => {
    if (el.classList.contains("nav-item") || el.classList.contains("mobile-nav-item")) {
      el.classList.toggle("active", el.dataset.route === match.pattern || (el.dataset.route === match.pattern.split("/:")[0] && match.pattern.includes(":")));
    }
  });

  if (match.pattern === "/artists/:name") renderArtistDetail(match.params.name);
  else if (match.pattern === "/albums/:name") renderAlbumDetail(match.params.name);
  else if (match.pattern === "/playlists/:id") renderPlaylistDetail(match.params.id);
  else renderPageContent(match.pattern);

  window.scrollTo({ top: 0, behavior: "auto" });
}

/* Link-click delegation: any element with data-route becomes an in-app link */
document.addEventListener("click", e => {
  const el = e.target.closest("[data-route]");
  if (!el) return;
  e.preventDefault();
  navigate(el.dataset.route);
});

/* ============================== per-route rendering dispatch ============================== */
function renderPageContent(pattern) {
  if (pattern === "/") renderHome();
  else if (pattern === "/search") renderSearchPage();
  else if (pattern === "/library") renderLibraryPage();
  else if (pattern === "/albums") renderAlbumsGrid();
  else if (pattern === "/artists") renderArtistsGrid();
  else if (pattern === "/playlists") renderPlaylistsGrid();
  else if (pattern === "/liked") renderLikedPage();
  else if (pattern === "/recently-played") renderRecentPage();
  else if (pattern === "/local-music") renderLocalMusicPage();
  else if (pattern === "/queue") renderQueuePage();
  else if (pattern === "/equalizer") renderEqualizerPage();
  else if (pattern === "/profile") renderProfilePage();
  else if (pattern === "/settings") renderSettingsPage();
}

/* ============================== playback engine ==============================
   Two <audio> elements act as ONE coordinated player (never independent,
   never fighting): exactly one is "active" (drives the UI, progress bar,
   and queue-advance logic) at any instant. The inactive element only ever
   plays during a real crossfade — a gain-ramped overlap on the shared Web
   Audio graph — and is silent/paused otherwise. This is what lets
   Settings › Playback › Crossfade actually do something instead of being
   a decorative slider. */
state.audioA = $("#audio"); state.audioB = $("#audioB"); state.activeEl = state.audioA;
state.gainA = null; state.gainB = null;
state._crossfadeTriggered = false;

function activeAudio() { return state.activeEl || state.audioA; }
function inactiveAudio() { return activeAudio() === state.audioA ? state.audioB : state.audioA; }
function gainNodeFor(el) { return el === state.audioA ? state.gainA : state.gainB; }
function stopAllAudio() {
  [state.audioA, state.audioB].forEach(el => { if (!el) return; try { el.pause(); el.removeAttribute("src"); } catch {} });
  state._crossfadeTriggered = false;
}

async function playTrack(track, list = state.tracks) {
  if (!track) return;
  state.currentTrack = track;
  state.queue = [...list];
  state.queueIndex = state.queue.findIndex(t => t.id === track.id);
  if (state.queueIndex < 0) state.queueIndex = 0;

  ensureAudioGraph();
  const fadeSec = state.settings.crossfade || 0;
  const prevEl = activeAudio();
  const prevWasPlaying = prevEl && !prevEl.paused && !prevEl.ended;
  const doCrossfade = fadeSec > 0 && prevWasPlaying && !!state.audioContext;
  const nextEl = doCrossfade ? inactiveAudio() : prevEl;

  try {
    nextEl.src = getTrackURL(track);
    nextEl.currentTime = 0;
    if (state.audioContext) gainNodeFor(nextEl).gain.setValueAtTime(doCrossfade ? 0 : 1, state.audioContext.currentTime);
    await nextEl.play();
    state.isPlaying = true;

    if (doCrossfade) {
      const ctx = state.audioContext, now = ctx.currentTime;
      const prevGain = gainNodeFor(prevEl), nextGain = gainNodeFor(nextEl);
      prevGain.gain.cancelScheduledValues(now); prevGain.gain.setValueAtTime(prevGain.gain.value, now); prevGain.gain.linearRampToValueAtTime(0, now + fadeSec);
      nextGain.gain.cancelScheduledValues(now); nextGain.gain.setValueAtTime(0, now); nextGain.gain.linearRampToValueAtTime(1, now + fadeSec);
      setTimeout(() => { try { prevEl.pause(); } catch {} }, fadeSec * 1000 + 60);
    } else if (state.audioContext) {
      const other = nextEl === state.audioA ? state.audioB : state.audioA;
      try { other.pause(); } catch {}
      gainNodeFor(other).gain.setValueAtTime(0, state.audioContext.currentTime);
      gainNodeFor(nextEl).gain.setValueAtTime(1, state.audioContext.currentTime);
    }

    state.activeEl = nextEl;
    state._crossfadeTriggered = false;
    recordPlay(track);
    updatePlayerUI();
    $("#miniPlayer").classList.add("show");
    maybeNotify(track);
  } catch (error) {
    console.error(error);
    toast("This audio file could not be played. It may be an unsupported or corrupted format.", "error");
  }
}

async function togglePlay() {
  if (!state.currentTrack) {
    if (state.tracks.length) await playTrack(state.tracks[0], state.tracks);
    else toast("Import music first.", "info");
    return;
  }
  const audio = activeAudio();
  if (state.audioContext?.state === "suspended") { try { await state.audioContext.resume(); } catch {} }
  if (audio.paused) { try { await audio.play(); state.isPlaying = true; } catch { toast("Playback was blocked — tap play again.", "error"); } }
  else { audio.pause(); state.isPlaying = false; }
  updatePlayerUI();
}

async function nextTrack(auto = false) {
  if (!state.queue.length) return;
  let index;
  if (state.shuffle) { do { index = Math.floor(Math.random()*state.queue.length); } while (state.queue.length>1 && index===state.queueIndex); }
  else {
    index = state.queueIndex + 1;
    if (index >= state.queue.length) {
      if (auto && !state.repeat && !state.settings.autoplay) return; // stop at end of queue
      index = 0;
    }
  }
  await playTrack(state.queue[index], state.queue);
}
async function previousTrack() {
  const audio = activeAudio();
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  if (!state.queue.length) return;
  let index = state.queueIndex - 1;
  if (index < 0) index = state.queue.length - 1;
  await playTrack(state.queue[index], state.queue);
}

function bindAudioElement(el) {
  el.addEventListener("play", () => { if (el === activeAudio()) { state.isPlaying = true; updatePlayerUI(); } });
  el.addEventListener("pause", () => { if (el === activeAudio()) { state.isPlaying = false; updatePlayerUI(); } });
  el.addEventListener("timeupdate", () => {
    if (el !== activeAudio()) return;
    updateProgress();
    const fadeSec = state.settings.crossfade || 0;
    if (fadeSec > 0 && !state._crossfadeTriggered && el.duration && !state.repeat && state.queue.length > 1) {
      const remaining = el.duration - el.currentTime;
      if (remaining > 0 && remaining <= fadeSec) { state._crossfadeTriggered = true; nextTrack(true); }
    }
  });
  el.addEventListener("loadedmetadata", () => { if (el === activeAudio()) updateProgress(); });
  el.addEventListener("ended", async () => {
    if (el !== activeAudio()) return; // tail end of a fading-out previous track — ignore
    if (state.repeat) { el.currentTime = 0; try { await el.play(); } catch {} return; }
    if (!state._crossfadeTriggered) await nextTrack(true);
  });
  el.addEventListener("error", () => { if (el === activeAudio() && state.currentTrack) toast("Playback error on this track — skipping.", "error"); });
}
bindAudioElement(state.audioA);
bindAudioElement(state.audioB);

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds/60), s = Math.floor(seconds%60).toString().padStart(2,"0");
  return `${m}:${s}`;
}
function updateProgress() {
  const audio = activeAudio();
  const duration = audio.duration || 0, current = audio.currentTime || 0;
  const value = duration ? (current/duration)*100 : 0;
  $("#mainProgress").value = value;
  $("#currentTime").textContent = formatTime(current);
  $("#durationTime").textContent = formatTime(duration);
  $("#miniProgress").style.width = `${value}%`;
}
$("#mainProgress").addEventListener("input", e => {
  const audio = activeAudio();
  if (!audio.duration) return;
  audio.currentTime = (Number(e.target.value)/100) * audio.duration;
});

function updatePlayerUI() {
  const track = state.currentTrack, playing = state.isPlaying;
  $("#mainPlayIcon").innerHTML = `<use href="#i-${playing?"pause":"play"}"></use>`;
  $("#miniPlayIcon").innerHTML = `<use href="#i-${playing?"pause":"play"}"></use>`;
  $("#vinyl").classList.toggle("playing", playing);
  if (!track) {
    $("#miniTitle").textContent = "Nothing playing"; $("#miniArtist").textContent = "Choose a song";
    $("#nowTitle").textContent = "Nothing playing"; $("#nowArtist").textContent = "Choose a song from your library";
    return;
  }
  $("#miniTitle").textContent = track.title; $("#miniArtist").textContent = track.artist;
  $("#nowTitle").textContent = track.title; $("#nowArtist").textContent = track.artist;
  $("#miniArtwork").innerHTML = artworkHTML(track.artwork);
  $("#vinylArtwork").innerHTML = artworkHTML(track.artwork);
  $("#nowBg").style.backgroundImage = `url("${track.artwork || DEFAULT_ART_URL}")`;
  const liked = state.liked.includes(track.id);
  $("#nowLike").classList.toggle("liked", liked);
  $("#miniLike").classList.toggle("liked", liked);
  $("#shuffleBtn").classList.toggle("active", state.shuffle);
  $("#repeatBtn").classList.toggle("active", state.repeat);
}

function toggleLike(id) {
  const i = state.liked.indexOf(id);
  if (i >= 0) { state.liked.splice(i,1); toast("Removed from Liked Songs.", "info"); }
  else { state.liked.push(id); toast("Added to Liked Songs.", "success"); }
  saveLiked(); updatePlayerUI(); renderRoute();
}

function recordPlay(track) {
  state.recent.unshift({ songId: track.id, at: Date.now() });
  state.recent = state.recent.slice(0, 200);
  saveRecent();
}
function clearHistory() { state.recent = []; saveRecent(); renderRoute(); toast("Listening history cleared.", "info"); }

/* ============================== now playing drawer ============================== */
function openNowPlaying() { $("#nowPlaying").classList.add("open"); document.body.style.overflow = "hidden"; updatePlayerUI(); }
function closeNowPlaying() { $("#nowPlaying").classList.remove("open"); document.body.style.overflow = ""; }

/* ============================== search ============================== */
function searchAll(query) {
  const q = query.trim().toLowerCase();
  if (!q) return { songs: [], artists: [], albums: [], playlists: [] };
  const songs = state.tracks.filter(t => [t.title,t.artist,t.album,t.name].join(" ").toLowerCase().includes(q));
  const artists = getArtists().filter(([name]) => name.toLowerCase().includes(q));
  const albums = getAlbums().filter(([name]) => name.toLowerCase().includes(q));
  const playlists = state.playlists.filter(p => p.name.toLowerCase().includes(q));
  return { songs, artists, albums, playlists };
}
function recordSearch(q) {
  q = q.trim(); if (!q) return;
  state.recentSearches = [q, ...state.recentSearches.filter(s => s.toLowerCase() !== q.toLowerCase())].slice(0, 8);
  saveSearches();
}
function renderSearchPage() {
  const input = $("#globalSearchInput");
  $("#globalSearchClear").classList.toggle("show", !!input.value);
  const wrap = $("#searchResultsWrap");
  const q = input.value.trim();
  if (!q) {
    wrap.innerHTML = "";
    $("#recentSearchRow").style.display = state.recentSearches.length ? "flex" : "none";
    $("#recentSearchChips").innerHTML = state.recentSearches.map(s => `<button class="chip" data-fill="${escapeAttr(s)}">${escapeHTML(s)}</button>`).join("");
    $$("#recentSearchChips [data-fill]").forEach(chip => chip.addEventListener("click", () => { input.value = chip.dataset.fill; renderSearchPage(); input.focus(); }));
    return;
  }
  $("#recentSearchRow").style.display = "none";
  const { songs, artists, albums, playlists } = searchAll(q);
  const nothing = !songs.length && !artists.length && !albums.length && !playlists.length;
  if (nothing) {
    wrap.innerHTML = `<div class="empty-state"><div class="empty-icon"><svg class="icon"><use href="#i-search"/></svg></div><h3>No results for "${escapeHTML(q)}"</h3><p>Try a different search term, or import more music.</p></div>`;
    return;
  }
  let html = "";
  if (songs.length) html += `<div class="section"><div class="section-head"><h2 class="section-title">Songs</h2></div><div class="track-list" id="srSongs"></div></div>`;
  if (artists.length) html += `<div class="section"><div class="section-head"><h2 class="section-title">Artists</h2></div><div class="card-grid" id="srArtists"></div></div>`;
  if (albums.length) html += `<div class="section"><div class="section-head"><h2 class="section-title">Albums</h2></div><div class="card-grid" id="srAlbums"></div></div>`;
  if (playlists.length) html += `<div class="section"><div class="section-head"><h2 class="section-title">Playlists</h2></div><div class="card-grid" id="srPlaylists"></div></div>`;
  wrap.innerHTML = html;
  if (songs.length) renderTrackList($("#srSongs"), songs);
  if (artists.length) { $("#srArtists").innerHTML = artists.map(([name,list]) => artistCardHTML(name,list)).join(""); bindArtistCards($("#srArtists")); }
  if (albums.length) { $("#srAlbums").innerHTML = albums.map(([name,list]) => albumCardHTML(name,list)).join(""); bindAlbumCards($("#srAlbums")); }
  if (playlists.length) { $("#srPlaylists").innerHTML = playlists.map(playlistCardHTML).join(""); bindPlaylistCards($("#srPlaylists")); }
}
$("#globalSearchInput").addEventListener("input", () => renderSearchPage());
$("#globalSearchInput").addEventListener("change", e => recordSearch(e.target.value));
$("#globalSearchClear").addEventListener("click", () => { $("#globalSearchInput").value = ""; renderSearchPage(); });
$("#clearRecentSearch").addEventListener("click", () => { state.recentSearches = []; saveSearches(); renderSearchPage(); });
$("#headerSearch").addEventListener("click", () => { navigate("/search"); setTimeout(() => $("#globalSearchInput").focus(), 150); });

/* ============================== track list render ============================== */
function renderTrackList(container, tracks, opts = {}) {
  if (!container) return;
  if (!tracks.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon"><svg class="icon"><use href="#i-music"/></svg></div>
        <h3>${opts.emptyTitle || "Your library is empty"}</h3>
        <p>${opts.emptyDesc || "Import music from your device to get started."}</p>
        <button class="primary-btn" id="empty-import-cta"><svg class="icon"><use href="#i-upload"/></svg> Import Music</button>
      </div>`;
    $("#empty-import-cta", container)?.addEventListener("click", () => requestFolderAccess());
    return;
  }
  container.innerHTML = tracks.map(track => {
    const playing = state.currentTrack?.id === track.id;
    const liked = state.liked.includes(track.id);
    return `
      <div class="track-row ${playing?"is-playing":""}" data-track-id="${escapeAttr(track.id)}">
        <div class="artwork track-art">${artworkHTML(track.artwork)}</div>
        <div class="track-main">
          <div class="track-title">${playing?'<span class="playing-dot"></span>':''}${escapeHTML(track.title)}</div>
          <div class="track-artist">${escapeHTML(track.artist)}</div>
          ${opts.showMeta ? `<div class="track-meta-extra">${(track.type||"").split("/").pop()?.toUpperCase()||"AUDIO"} · ${formatBytes(track.size)} · Added ${formatDate(track.importedAt)}</div>` : ""}
        </div>
        <div class="track-actions">
          <button class="round-action ${liked?'liked':''}" title="Like" data-like="${escapeAttr(track.id)}"><svg class="icon"><use href="#i-heart"/></svg></button>
          <button class="round-action" title="Add to playlist" data-addqueue-menu="${escapeAttr(track.id)}"><svg class="icon"><use href="#i-add-playlist"/></svg></button>
          <button class="round-action play-row" title="Play" data-id="${escapeAttr(track.id)}"><svg class="icon"><use href="#i-${playing && state.isPlaying ? "pause" : "play"}"/></svg></button>
          <button class="round-action delete-row" title="Remove" data-id="${escapeAttr(track.id)}"><svg class="icon"><use href="#i-x"/></svg></button>
        </div>
      </div>`;
  }).join("");
}

document.addEventListener("click", async event => {
  const playButton = event.target.closest(".play-row");
  if (playButton) {
    const track = getTrackById(playButton.dataset.id);
    if (!track) return;
    if (state.currentTrack?.id === playButton.dataset.id) await togglePlay();
    else await playTrack(track, contextListForCurrentRoute());
    renderRoute();
    return;
  }
  const likeButton = event.target.closest("[data-like]");
  if (likeButton) { toggleLike(likeButton.dataset.like); return; }

  const menuButton = event.target.closest("[data-addqueue-menu]");
  if (menuButton) { openTrackMenu(menuButton.dataset.addqueueMenu); return; }

  const deleteButton = event.target.closest(".delete-row");
  if (deleteButton) { await removeTrack(deleteButton.dataset.id); return; }

  const trackRow = event.target.closest(".track-row");
  if (trackRow && !event.target.closest(".track-actions")) {
    const track = getTrackById(trackRow.dataset.trackId);
    if (track) await playTrack(track, contextListForCurrentRoute());
  }
});

function contextListForCurrentRoute() {
  if (state.route === "/liked") return state.liked.map(getTrackById).filter(Boolean);
  if (state.route === "/recently-played") return dedupeRecentTracks();
  if (state.route === "/artists/:name" && state.currentEntity) return state.tracks.filter(t => t.artist === state.currentEntity);
  if (state.route === "/albums/:name" && state.currentEntity) return state.tracks.filter(t => (t.album||"Unknown Album") === state.currentEntity);
  if (state.route === "/playlists/:id" && state.currentEntity) { const pl = state.playlists.find(p=>p.id===state.currentEntity); return pl ? pl.songIds.map(getTrackById).filter(Boolean) : state.tracks; }
  return state.tracks;
}
function dedupeRecentTracks() {
  const seen = new Set(); const out = [];
  for (const r of state.recent) { if (!seen.has(r.songId)) { const t = getTrackById(r.songId); if (t) { seen.add(r.songId); out.push(t); } } }
  return out;
}

function openTrackMenu(trackId) {
  const track = getTrackById(trackId);
  if (!track) return;
  const items = state.playlists.length
    ? state.playlists.map(p => `<div class="playlist-pick-item" data-pl="${escapeAttr(p.id)}"><svg class="icon icon-sm"><use href="#i-list"/></svg> ${escapeHTML(p.name)}</div>`).join("")
    : `<p style="color:var(--muted);font-size:12.5px">You don't have any playlists yet.</p>`;
  showModal(track.title, "Add to a playlist, or create a new one.", "New Playlist", `<div class="playlist-pick-list">${items}</div>`, { hideCancel: false });
  $$(".playlist-pick-item").forEach(item => item.addEventListener("click", async () => {
    await addSongToPlaylist(item.dataset.pl, trackId);
    closeModal(false);
    toast("Added to playlist.", "success");
  }));
  $("#modalConfirm").onclick = () => { closeModal(false); openCreatePlaylistModal(trackId); };
}

async function removeTrack(id) {
  const track = getTrackById(id);
  if (!track) return;
  const confirmed = await showModal("Remove song?", `"${track.title}" will be removed from your Lux Sound Lab library.`, "Remove");
  restoreModalDefaults();
  if (!confirmed) return;
  if (state.objectUrls.has(id)) { URL.revokeObjectURL(state.objectUrls.get(id)); state.objectUrls.delete(id); }
  if (state.dbReady) { try { await dbDelete(STORE_SONGS, id); } catch (e) { console.warn(e); } }
  state.tracks = state.tracks.filter(t => t.id !== id);
  state.liked = state.liked.filter(x => x !== id);
  state.recent = state.recent.filter(r => r.songId !== id);
  state.playlists.forEach(p => { p.songIds = p.songIds.filter(x => x !== id); });
  saveLiked(); saveRecent();
  if (state.dbReady) for (const p of state.playlists) { try { await dbPut(STORE_PLAYLISTS, p); } catch {} }
  if (state.currentTrack?.id === id) {
    stopAllAudio();
    state.currentTrack = null; state.isPlaying = false;
    $("#miniPlayer").classList.remove("show");
    updatePlayerUI();
  }
  renderRoute();
  toast("Song removed from your library.", "info");
}
function restoreModalDefaults() { $("#modalCancel").style.display = ""; $("#modalActionsRow").classList.remove("stack"); $("#modalConfirm").onclick = () => closeModal(true); }

/* ============================== home ============================== */
function renderHome() {
  const hr = new Date().getHours();
  $("#greetingLabel").textContent = hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : "Good evening";

  const recentTracks = dedupeRecentTracks();
  const continueEl = $("#continueListeningCard");
  if (state.currentTrack) {
    continueEl.innerHTML = `<div class="track-row" data-track-id="${escapeAttr(state.currentTrack.id)}">
      <div class="artwork track-art">${artworkHTML(state.currentTrack.artwork)}</div>
      <div class="track-main"><div class="track-title">${escapeHTML(state.currentTrack.title)}</div><div class="track-artist">${escapeHTML(state.currentTrack.artist)}</div></div>
      <div class="track-actions"><button class="round-action play-small" id="continuePlayBtn"><svg class="icon"><use href="#i-${state.isPlaying?'pause':'play'}"/></svg></button></div>
    </div>`;
    $("#continuePlayBtn").addEventListener("click", e => { e.stopPropagation(); togglePlay(); });
  } else {
    continueEl.innerHTML = `<div class="empty-state" style="padding:26px"><p style="margin:0">Nothing playing yet — pick a song from your library to get started.</p></div>`;
  }

  renderTrackCardsInto($("#homeRecentRail"), recentTracks.slice(0,10), { emptyText: "Songs you play will show up here." });
  const recentlyAdded = [...state.tracks].sort((a,b)=>b.importedAt-a.importedAt).slice(0,10);
  renderTrackCardsInto($("#homeRecentAddedRail"), recentlyAdded, { emptyText: "Import music to see it here." });

  const plRail = $("#homePlaylistsRail");
  plRail.innerHTML = state.playlists.length ? state.playlists.slice(0,10).map(playlistCardHTML).join("") : `<div class="empty-state" style="min-width:100%"><h3>No playlists yet</h3><p>Create one from the Playlists page.</p></div>`;
  bindPlaylistCards(plRail);

  $("#homeSongCount").textContent = `${state.tracks.length} songs`;
  $("#homeArtistCount").textContent = `${getArtists().length} artists`;
  $("#homeAlbumCount").textContent = `${getAlbums().length} albums`;
  $("#homePlaylistCount").textContent = `${state.playlists.length} playlists`;
}
function renderTrackCardsInto(el, tracks, { emptyText }) {
  if (!tracks.length) { el.innerHTML = `<div class="empty-state" style="min-width:100%"><p style="margin:0">${escapeHTML(emptyText)}</p></div>`; return; }
  el.innerHTML = tracks.map(t => `
    <div class="music-card" data-song="${escapeAttr(t.id)}">
      <div class="artwork music-card-art">${artworkHTML(t.artwork)}</div>
      <button class="card-play-btn" data-play="${escapeAttr(t.id)}"><svg class="icon icon-sm"><use href="#i-play"/></svg></button>
      <div class="music-card-info"><div class="music-card-title">${escapeHTML(t.title)}</div><div class="music-card-artist">${escapeHTML(t.artist)}</div></div>
    </div>`).join("");
  $$("[data-play]", el).forEach(btn => btn.addEventListener("click", async e => { e.stopPropagation(); const t = getTrackById(btn.dataset.play); if (t) await playTrack(t, tracks); }));
  $$("[data-song]", el).forEach(card => card.addEventListener("click", async () => { const t = getTrackById(card.dataset.song); if (t) await playTrack(t, tracks); }));
}

/* ============================== library ============================== */
let librarySort = "added";
function sortedLibrary(query) {
  let list = query ? state.tracks.filter(t => [t.title,t.artist,t.album,t.name].join(" ").toLowerCase().includes(query.toLowerCase())) : state.tracks.slice();
  if (librarySort === "added") list.sort((a,b) => b.importedAt - a.importedAt);
  else if (librarySort === "played") {
    const order = new Map(); state.recent.forEach((r,i) => { if (!order.has(r.songId)) order.set(r.songId, i); });
    list.sort((a,b) => (order.has(a.id)?order.get(a.id):Infinity) - (order.has(b.id)?order.get(b.id):Infinity));
  }
  else if (librarySort === "alpha") list.sort((a,b) => a.title.localeCompare(b.title));
  else if (librarySort === "artist") list.sort((a,b) => a.artist.localeCompare(b.artist));
  else if (librarySort === "album") list.sort((a,b) => (a.album||"").localeCompare(b.album||""));
  return list;
}
function renderLibraryPage() {
  $("#libraryCount").textContent = `${state.tracks.length} ${state.tracks.length===1?"song":"songs"} on this device.`;
  $("#librarySearchClear").classList.toggle("show", !!$("#librarySearch").value);
  renderTrackList($("#libraryList"), sortedLibrary($("#librarySearch").value));
}
$("#librarySearch").addEventListener("input", renderLibraryPage);
$("#librarySearchClear").addEventListener("click", () => { $("#librarySearch").value = ""; renderLibraryPage(); });
$$(".filter-row [data-sort]", document).forEach(() => {}); // placeholder (bound below after DOM ready via delegation)
document.addEventListener("click", e => {
  const sortBtn = e.target.closest("#page-library [data-sort]");
  if (!sortBtn) return;
  librarySort = sortBtn.dataset.sort;
  $$("#page-library .tab-btn").forEach(b => b.classList.toggle("active", b === sortBtn));
  renderLibraryPage();
});

/* ============================== artists / albums ============================== */
function getArtists() {
  const map = new Map();
  state.tracks.forEach(t => { const n = t.artist||"Unknown Artist"; if (!map.has(n)) map.set(n, []); map.get(n).push(t); });
  return [...map.entries()];
}
function getAlbums() {
  const map = new Map();
  state.tracks.forEach(t => { const a = t.album||"Unknown Album"; if (!map.has(a)) map.set(a, []); map.get(a).push(t); });
  return [...map.entries()];
}
function artistCardHTML(name, tracks) {
  return `<div class="music-card" data-artist="${escapeAttr(name)}">
    <div class="artwork music-card-art">${artworkHTML(tracks[0]?.artwork)}</div>
    <div class="music-card-info"><div class="music-card-title">${escapeHTML(name)}</div><div class="music-card-artist">${tracks.length} ${tracks.length===1?"song":"songs"}</div></div>
  </div>`;
}
function albumCardHTML(name, tracks) {
  return `<div class="music-card" data-album="${escapeAttr(name)}">
    <div class="artwork music-card-art">${artworkHTML(tracks[0]?.artwork)}</div>
    <div class="music-card-info"><div class="music-card-title">${escapeHTML(name)}</div><div class="music-card-artist">${tracks.length} ${tracks.length===1?"song":"songs"}</div></div>
  </div>`;
}
function bindArtistCards(root) { $$("[data-artist]", root).forEach(c => c.addEventListener("click", () => navigate(`/artists/${encodeURIComponent(c.dataset.artist)}`))); }
function bindAlbumCards(root) { $$("[data-album]", root).forEach(c => c.addEventListener("click", () => navigate(`/albums/${encodeURIComponent(c.dataset.album)}`))); }

function renderArtistsGrid() {
  const artists = getArtists();
  $("#artistGrid").innerHTML = artists.length ? artists.map(([n,l]) => artistCardHTML(n,l)).join("") : `<div class="empty-state" style="grid-column:1/-1"><h3>No artists yet</h3><p>Import music to build your artist library.</p></div>`;
  bindArtistCards($("#artistGrid"));
}
function renderAlbumsGrid() {
  const albums = getAlbums();
  $("#albumGrid").innerHTML = albums.length ? albums.map(([n,l]) => albumCardHTML(n,l)).join("") : `<div class="empty-state" style="grid-column:1/-1"><h3>No albums yet</h3><p>Import music to build your album library.</p></div>`;
  bindAlbumCards($("#albumGrid"));
}

function renderArtistDetail(name) {
  state.currentEntity = name;
  const tracks = state.tracks.filter(t => t.artist === name);
  const albums = new Set(tracks.map(t => t.album||"Unknown Album"));
  $("#artistName").textContent = name;
  $("#artistHeroArt").innerHTML = `<img src="${tracks[0]?.artwork || DEFAULT_ART_URL}" alt="">`;
  $("#artistSongCount").textContent = tracks.length;
  $("#artistAlbumCount").textContent = albums.size;
  $("#artistPlaylistCount").textContent = state.playlists.filter(p => p.songIds.some(id => tracks.some(t=>t.id===id))).length;
  renderTrackList($("#artistSongsList"), tracks.slice(0,10));
  const albumEntries = [...albums].map(a => [a, tracks.filter(t => (t.album||"Unknown Album")===a)]);
  $("#artistAlbumsRail").innerHTML = albumEntries.length ? albumEntries.map(([a,l]) => albumCardHTML(a,l)).join("") : `<div class="empty-state" style="min-width:100%"><h3>No albums</h3><p>This artist has no album info yet.</p></div>`;
  bindAlbumCards($("#artistAlbumsRail"));
}
$("#artistBack").addEventListener("click", () => navigate("/artists"));
$("#artistPlayBtn").addEventListener("click", async () => { const t = state.tracks.filter(x=>x.artist===state.currentEntity); if (t.length) await playTrack(t[0], t); });

function renderAlbumDetail(name) {
  state.currentEntity = name;
  const tracks = state.tracks.filter(t => (t.album||"Unknown Album") === name);
  $("#albumName").textContent = name;
  $("#albumHeroArt").innerHTML = `<img src="${tracks[0]?.artwork || DEFAULT_ART_URL}" alt="">`;
  $("#albumSongCount").textContent = tracks.length;
  $("#albumArtistName").textContent = tracks[0]?.artist || "—";
  const totalSec = tracks.reduce((s,t) => s + (t.duration||0), 0);
  $("#albumDuration").textContent = formatTime(totalSec);
  renderTrackList($("#albumSongsList"), tracks);
}
$("#albumBack").addEventListener("click", () => navigate("/albums"));
$("#albumPlayBtn").addEventListener("click", async () => { const t = state.tracks.filter(x=>(x.album||"Unknown Album")===state.currentEntity); if (t.length) await playTrack(t[0], t); });

/* ============================== playlists ============================== */
function playlistCardHTML(pl) {
  const tracks = pl.songIds.map(getTrackById).filter(Boolean);
  return `<div class="music-card playlist-card" data-playlist="${escapeAttr(pl.id)}">
    <div class="artwork music-card-art">${tracks[0] ? artworkHTML(tracks[0].artwork) : `<div class="artwork-fallback"><svg class="icon"><use href="#i-list"/></svg></div>`}</div>
    <div class="music-card-info"><div class="music-card-title">${escapeHTML(pl.name)}</div><div class="music-card-artist">${tracks.length} ${tracks.length===1?"song":"songs"}</div></div>
  </div>`;
}
function bindPlaylistCards(root) { $$("[data-playlist]", root).forEach(c => c.addEventListener("click", () => navigate(`/playlists/${c.dataset.playlist}`))); }

function renderPlaylistsGrid() {
  $("#playlistsGrid").innerHTML = state.playlists.length ? state.playlists.map(playlistCardHTML).join("")
    : `<div class="empty-state" style="grid-column:1/-1"><h3>You haven't created any playlists yet.</h3><p>Group your favorite local tracks together.</p><button class="primary-btn" id="plEmptyCta">Create Playlist</button></div>`;
  bindPlaylistCards($("#playlistsGrid"));
  $("#plEmptyCta")?.addEventListener("click", openCreatePlaylistModal);
}
$("#btnNewPlaylist").addEventListener("click", () => openCreatePlaylistModal());

function openCreatePlaylistModal(addSongIdAfter = null) {
  showModal("Create Playlist", "Give it a name — you can add songs right after.", "Create",
    `<div class="modal-field"><label for="plNameInput">Name</label><input id="plNameInput" type="text" placeholder="My Playlist"></div>
     <div class="modal-field"><label for="plDescInput">Description (optional)</label><textarea id="plDescInput" rows="2" placeholder="What's this playlist for?"></textarea></div>`);
  setTimeout(() => $("#plNameInput")?.focus(), 50);
  $("#modalConfirm").onclick = async () => {
    const name = $("#plNameInput")?.value.trim() || "New Playlist";
    const description = $("#plDescInput")?.value.trim() || "";
    const pl = { id: uid(), name, description, songIds: addSongIdAfter ? [addSongIdAfter] : [], createdAt: Date.now() };
    state.playlists.push(pl);
    if (state.dbReady) { try { await dbPut(STORE_PLAYLISTS, pl); } catch (e) { console.warn(e); } }
    closeModal(true); restoreModalDefaults();
    toast(`Playlist "${name}" created.`, "success");
    navigate(`/playlists/${pl.id}`);
  };
}
async function addSongToPlaylist(playlistId, songId) {
  const pl = state.playlists.find(p => p.id === playlistId);
  if (!pl) return;
  if (!pl.songIds.includes(songId)) pl.songIds.push(songId);
  if (state.dbReady) { try { await dbPut(STORE_PLAYLISTS, pl); } catch (e) { console.warn(e); } }
  renderRoute();
}
async function removeSongFromPlaylist(playlistId, songId) {
  const pl = state.playlists.find(p => p.id === playlistId);
  if (!pl) return;
  pl.songIds = pl.songIds.filter(id => id !== songId);
  if (state.dbReady) { try { await dbPut(STORE_PLAYLISTS, pl); } catch (e) { console.warn(e); } }
  renderPlaylistDetail(playlistId);
}

function renderPlaylistDetail(id) {
  state.currentEntity = id;
  const pl = state.playlists.find(p => p.id === id);
  if (!pl) { navigate("/playlists", { replace: true }); return; }
  const tracks = pl.songIds.map(getTrackById).filter(Boolean);
  $("#playlistName").textContent = pl.name;
  $("#playlistHeroArt").innerHTML = tracks[0] ? `<img src="${tracks[0].artwork || DEFAULT_ART_URL}" alt="">` : `<img src="${DEFAULT_ART_URL}" alt="">`;
  $("#playlistSongCount").textContent = tracks.length;
  const totalSec = tracks.reduce((s,t)=>s+(t.duration||0),0);
  $("#playlistDuration").textContent = formatTime(totalSec);

  if (!tracks.length) {
    $("#playlistSongsList").innerHTML = `<div class="empty-state"><h3>No songs yet</h3><p>Add songs from any track's "Add to playlist" button.</p></div>`;
  } else {
    renderTrackList($("#playlistSongsList"), tracks);
    $$("#playlistSongsList .delete-row").forEach(btn => {
      // In a playlist, the "x" removes from the playlist rather than deleting the song from the library.
      btn.title = "Remove from playlist";
      btn.replaceWith(btn.cloneNode(true)); // strip the generic delete-row handler bound above
    });
    $$('#playlistSongsList [title="Remove from playlist"]').forEach(btn => {
      btn.addEventListener("click", async e => { e.stopPropagation(); await removeSongFromPlaylist(id, btn.dataset.id); });
    });
  }
}
$("#playlistBack").addEventListener("click", () => navigate("/playlists"));
$("#playlistPlayBtn").addEventListener("click", async () => {
  const pl = state.playlists.find(p => p.id === state.currentEntity);
  const tracks = pl ? pl.songIds.map(getTrackById).filter(Boolean) : [];
  if (tracks.length) await playTrack(tracks[0], tracks); else toast("This playlist is empty.", "info");
});
$("#playlistShuffleBtn").addEventListener("click", async () => {
  const pl = state.playlists.find(p => p.id === state.currentEntity);
  let tracks = pl ? pl.songIds.map(getTrackById).filter(Boolean) : [];
  if (!tracks.length) { toast("This playlist is empty.", "info"); return; }
  tracks = tracks.slice().sort(() => Math.random()-0.5);
  state.shuffle = true;
  await playTrack(tracks[0], tracks);
});
$("#playlistRenameBtn").addEventListener("click", () => {
  const pl = state.playlists.find(p => p.id === state.currentEntity);
  if (!pl) return;
  showModal("Rename Playlist", "", "Save", `<div class="modal-field"><label for="plRenameInput">Name</label><input id="plRenameInput" type="text" value="${escapeAttr(pl.name)}"></div>`);
  setTimeout(() => $("#plRenameInput")?.select(), 50);
  $("#modalConfirm").onclick = async () => {
    pl.name = $("#plRenameInput").value.trim() || pl.name;
    if (state.dbReady) { try { await dbPut(STORE_PLAYLISTS, pl); } catch {} }
    closeModal(true); restoreModalDefaults();
    renderPlaylistDetail(pl.id);
  };
});
$("#playlistDeleteBtn").addEventListener("click", async () => {
  const pl = state.playlists.find(p => p.id === state.currentEntity);
  if (!pl) return;
  const confirmed = await showModal("Delete playlist?", `"${pl.name}" will be permanently deleted.`, "Delete");
  restoreModalDefaults();
  if (!confirmed) return;
  state.playlists = state.playlists.filter(p => p.id !== pl.id);
  if (state.dbReady) { try { await dbDelete(STORE_PLAYLISTS, pl.id); } catch {} }
  toast("Playlist deleted.", "info");
  navigate("/playlists");
});

/* ============================== liked / recent / local-music ============================== */
function renderLikedPage() {
  const tracks = state.liked.map(getTrackById).filter(Boolean);
  $("#likedCount").textContent = `${tracks.length} ${tracks.length===1?"song":"songs"}`;
  renderTrackList($("#likedList"), tracks, { emptyTitle: "Songs you love will appear here.", emptyDesc: "Tap the heart on any song to save it here." });
}
$("#likedPlayAllBtn").addEventListener("click", async () => {
  const tracks = state.liked.map(getTrackById).filter(Boolean);
  if (tracks.length) await playTrack(tracks[0], tracks); else toast("No liked songs yet.", "info");
});
$("#likedShuffleBtn").addEventListener("click", async () => {
  let tracks = state.liked.map(getTrackById).filter(Boolean);
  if (!tracks.length) { toast("No liked songs yet.", "info"); return; }
  tracks = tracks.slice().sort(() => Math.random()-0.5);
  state.shuffle = true;
  await playTrack(tracks[0], tracks);
});

function renderRecentPage() {
  if (!state.settings.showHistory) {
    $("#recentList").innerHTML = `<div class="empty-state"><h3>History is hidden</h3><p>Recently played visibility is turned off in Settings › Privacy.</p></div>`;
    return;
  }
  renderTrackList($("#recentList"), dedupeRecentTracks(), { emptyTitle: "Nothing played yet", emptyDesc: "Your recently played tracks will show up here." });
}
$("#clearHistoryBtn").addEventListener("click", async () => {
  const confirmed = await showModal("Clear listening history?", "This can't be undone.", "Clear History");
  restoreModalDefaults();
  if (confirmed) clearHistory();
});

function renderLocalMusicPage() {
  renderTrackList($("#localMusicList"), [...state.tracks].sort((a,b)=>b.importedAt-a.importedAt), { showMeta: true, emptyTitle: "No local files yet", emptyDesc: "Files you import from this device will appear here with their metadata." });
}

/* ============================== queue page ============================== */
function renderQueuePage() {
  const nowWrap = $("#queueNowWrap");
  if (!state.currentTrack) {
    nowWrap.innerHTML = `<div class="empty-state"><h3>Nothing playing</h3><p>Play a song to start building a queue.</p></div>`;
    $("#queueUpNextList").innerHTML = "";
    return;
  }
  nowWrap.innerHTML = `<div class="queue-now-card">
    <div class="artwork track-art">${artworkHTML(state.currentTrack.artwork)}</div>
    <div class="track-main"><div class="track-title">${escapeHTML(state.currentTrack.title)}</div><div class="track-artist">${escapeHTML(state.currentTrack.artist)}</div></div>
    <button class="round-action play-small" id="queueNowPlayToggle"><svg class="icon"><use href="#i-${state.isPlaying?'pause':'play'}"/></svg></button>
  </div>`;
  $("#queueNowPlayToggle").addEventListener("click", togglePlay);

  const upNext = state.queue.slice(state.queueIndex+1);
  const listEl = $("#queueUpNextList");
  if (!upNext.length) { listEl.innerHTML = `<p style="color:var(--muted);font-size:13px">Nothing queued after this.</p>`; return; }
  listEl.innerHTML = upNext.map((t,i) => `
    <div class="queue-item" draggable="true" data-idx="${state.queueIndex+1+i}">
      <span class="drag-handle"><svg class="icon icon-sm"><use href="#i-list"/></svg></span>
      <div class="artwork track-art">${artworkHTML(t.artwork)}</div>
      <div class="qmeta"><strong>${escapeHTML(t.title)}</strong><span>${escapeHTML(t.artist)}</span></div>
      <button class="round-action" data-qremove="${state.queueIndex+1+i}"><svg class="icon icon-sm"><use href="#i-x"/></svg></button>
    </div>`).join("");
  $$("[data-qremove]", listEl).forEach(btn => btn.addEventListener("click", e => {
    e.stopPropagation();
    const idx = +btn.dataset.qremove;
    state.queue.splice(idx, 1);
    renderQueuePage();
  }));
  $$(".queue-item", listEl).forEach(item => {
    item.addEventListener("click", async e => { if (e.target.closest("[data-qremove]")) return; await playTrack(state.queue[+item.dataset.idx], state.queue); });
    item.addEventListener("dragstart", () => item.classList.add("dragging"));
    item.addEventListener("dragend", () => item.classList.remove("dragging"));
    item.addEventListener("dragover", e => e.preventDefault());
    item.addEventListener("drop", () => {
      const dragging = $(".queue-item.dragging", listEl);
      if (!dragging || dragging === item) return;
      const from = +dragging.dataset.idx, to = +item.dataset.idx;
      const [moved] = state.queue.splice(from, 1);
      state.queue.splice(to, 0, moved);
      if (from === state.queueIndex) state.queueIndex = to;
      renderQueuePage();
    });
  });
}
$("#queueClearBtn").addEventListener("click", () => {
  state.queue = state.queueIndex >= 0 ? state.queue.slice(0, state.queueIndex+1) : [];
  renderQueuePage();
  toast("Queue cleared.", "info");
});
$("#queueSaveAsPlaylistBtn").addEventListener("click", () => {
  if (!state.queue.length) { toast("Your queue is empty.", "info"); return; }
  showModal("Save Queue as Playlist", "Name your new playlist.", "Save", `<div class="modal-field"><label for="qplName">Name</label><input id="qplName" type="text" placeholder="My Playlist"></div>`);
  setTimeout(() => $("#qplName")?.focus(), 50);
  $("#modalConfirm").onclick = async () => {
    const name = $("#qplName")?.value.trim() || "My Playlist";
    const pl = { id: uid(), name, description: "", songIds: state.queue.map(t=>t.id), createdAt: Date.now() };
    state.playlists.push(pl);
    if (state.dbReady) { try { await dbPut(STORE_PLAYLISTS, pl); } catch {} }
    closeModal(true); restoreModalDefaults();
    toast(`Saved as "${name}".`, "success");
  };
});
$("#queueBtn").addEventListener("click", () => navigate("/queue"));

/* ============================== equalizer (Web Audio) ============================== */
const EQ_FREQS = [60, 150, 400, 1000, 2400, 6000, 15000];
const EQ_PRESETS = {
  Flat: [0,0,0,0,0,0,0], "Bass Boost": [7,6,3,0,-1,-2,-2], "Bass Reducer": [-6,-5,-2,0,0,0,0],
  Vocal: [-3,-2,1,4,4,2,0], "Treble Boost": [0,0,-1,0,2,5,6], "Treble Reducer": [0,0,0,0,-2,-5,-6],
  Pop: [-1,2,4,3,0,-1,-1], Rock: [5,4,2,-1,1,3,4], Classical: [3,2,0,0,-1,2,3],
};

function applyNormalizeGains() {
  if (!state.dryGain) return;
  // Dry/wet crossfade between the raw signal and the compressed ("normalized")
  // signal — this lets the Normalize toggle flip instantly without ever
  // rebuilding the graph (which would require a second createMediaElementSource
  // call on the same <audio> element, and that throws — an element can only
  // ever be captured as a Web Audio source once in its lifetime).
  state.dryGain.gain.value = state.settings.normalize ? 0 : 1;
  state.wetGain.gain.value = state.settings.normalize ? 1 : 0;
}

function ensureAudioGraph() {
  if (state.audioContext) return;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;
  try {
    state.audioContext = new AudioContext();

    // Two independently-gained sources (for real crossfade) merge into one shared
    // EQ/analyser chain, so both the equalizer and visualizer work no matter
    // which of the two elements is currently active.
    state.gainA = state.audioContext.createGain();
    state.gainB = state.audioContext.createGain();
    state.gainA.gain.value = 1; state.gainB.gain.value = 0;
    const sourceA = state.audioContext.createMediaElementSource(state.audioA);
    const sourceB = state.audioContext.createMediaElementSource(state.audioB);
    sourceA.connect(state.gainA); sourceB.connect(state.gainB);

    state.preampGain = state.audioContext.createGain();
    state.preampGain.gain.value = Math.pow(10, (state.eqPreamp||0)/20);
    state.gainA.connect(state.preampGain); state.gainB.connect(state.preampGain);

    state.filters = EQ_FREQS.map((freq, i) => {
      const f = state.audioContext.createBiquadFilter();
      f.type = i===0 ? "lowshelf" : i===EQ_FREQS.length-1 ? "highshelf" : "peaking";
      f.frequency.value = freq; f.Q.value = 1; f.gain.value = state.eqEnabled ? (state.eqGains[i]||0) : 0;
      return f;
    });
    state.compressorNode = state.audioContext.createDynamicsCompressor();
    state.compressorNode.threshold.value = -24; state.compressorNode.knee.value = 20;
    state.compressorNode.ratio.value = 8; state.compressorNode.attack.value = 0.01; state.compressorNode.release.value = 0.25;

    state.dryGain = state.audioContext.createGain();
    state.wetGain = state.audioContext.createGain();

    state.analyser = state.audioContext.createAnalyser();
    state.analyser.fftSize = 1024; state.analyser.smoothingTimeConstant = 0.82;

    let node = state.preampGain;
    for (const f of state.filters) { node.connect(f); node = f; }
    // node now = last filter output; split into dry path and compressed ("normalized") path.
    node.connect(state.dryGain);
    node.connect(state.compressorNode);
    state.compressorNode.connect(state.wetGain);
    state.dryGain.connect(state.analyser);
    state.wetGain.connect(state.analyser);
    applyNormalizeGains();
    state.analyser.connect(state.audioContext.destination);
    startWaveform();
  } catch (error) {
    console.warn("Web Audio graph unavailable:", error);
  }
}

function renderEqualizerPage() {
  $("#eqEnabledToggle").classList.toggle("on", state.eqEnabled);
  const bandsEl = $("#eqBands");
  bandsEl.innerHTML = `
    <div class="eq-band preamp"><span class="eq-val" id="preampVal">${state.eqPreamp>0?"+":""}${state.eqPreamp}dB</span>
      <input type="range" min="-12" max="12" value="${state.eqPreamp}" id="preampSlider"><span class="eq-freq">PRE</span></div>
    ${EQ_FREQS.map((freq,i) => `
      <div class="eq-band">
        <span class="eq-val" data-eq-val="${i}">${state.eqGains[i]>0?"+":""}${state.eqGains[i]}dB</span>
        <input type="range" min="-12" max="12" value="${state.eqGains[i]}" data-eq="${i}">
        <span class="eq-freq">${freq>=1000?(freq/1000)+"k":freq}Hz</span>
      </div>`).join("")}`;
  $("#preampSlider").addEventListener("input", e => {
    state.eqPreamp = +e.target.value; saveEq();
    if (state.preampGain) state.preampGain.gain.value = Math.pow(10, state.eqPreamp/20);
    $("#preampVal").textContent = `${state.eqPreamp>0?"+":""}${state.eqPreamp}dB`;
  });
  $$("[data-eq]", bandsEl).forEach(input => input.addEventListener("input", e => {
    const i = +e.target.dataset.eq, v = +e.target.value;
    state.eqGains[i] = v; saveEq();
    if (state.filters[i]) state.filters[i].gain.value = state.eqEnabled ? v : 0;
    $(`[data-eq-val="${i}"]`).textContent = `${v>0?"+":""}${v}dB`;
    markCustomPresetActive();
  }));

  const presetNames = [...Object.keys(EQ_PRESETS), "Custom"];
  $("#eqPresets").innerHTML = presetNames.map(name => `<button class="tab-btn" data-preset="${escapeAttr(name)}">${name}</button>`).join("");
  $$("#eqPresets [data-preset]").forEach(btn => btn.addEventListener("click", () => {
    const name = btn.dataset.preset;
    const gains = name === "Custom" ? (state.customPreset || EQ_PRESETS.Flat) : EQ_PRESETS[name];
    state.eqGains = gains.slice(); saveEq();
    state.eqGains.forEach((v,i) => { if (state.filters[i]) state.filters[i].gain.value = state.eqEnabled ? v : 0; });
    renderEqualizerPage();
  }));
}
function markCustomPresetActive() { $$("#eqPresets .tab-btn").forEach(b => b.classList.toggle("active", b.dataset.preset === "Custom")); }
$("#eqEnabledToggle").addEventListener("click", () => {
  state.eqEnabled = !state.eqEnabled; saveEq();
  state.eqGains.forEach((v,i) => { if (state.filters[i]) state.filters[i].gain.value = state.eqEnabled ? v : 0; });
  renderEqualizerPage();
});
$("#eqResetBtn").addEventListener("click", () => {
  state.eqGains = EQ_PRESETS.Flat.slice(); state.eqPreamp = 0; saveEq();
  if (state.preampGain) state.preampGain.gain.value = 1;
  state.eqGains.forEach((v,i) => { if (state.filters[i]) state.filters[i].gain.value = 0; });
  renderEqualizerPage();
});
$("#eqSaveCustomBtn").addEventListener("click", () => {
  state.customPreset = state.eqGains.slice(); saveEq();
  toast("Saved current settings as your Custom preset.", "success");
  renderEqualizerPage();
  markCustomPresetActive();
});
$("#eqShortcutBtn").addEventListener("click", () => navigate("/equalizer"));

function startWaveform() {
  const canvas = $("#waveCanvas");
  const ctx = canvas.getContext("2d");
  function loop() {
    requestAnimationFrame(loop);
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0,0,w,h);
    if (!state.analyser || !state.isPlaying) { ctx.fillStyle = "rgba(255,255,255,.12)"; for (let x=0;x<w;x+=6) ctx.fillRect(x,h/2-1,3,2); return; }
    const data = new Uint8Array(state.analyser.frequencyBinCount);
    state.analyser.getByteFrequencyData(data);
    const bars = 56, step = Math.floor(data.length/bars)||1, bw = w/bars;
    for (let i=0;i<bars;i++) {
      const v = data[i*step]/255, bh = Math.max(2, v*h);
      const grad = ctx.createLinearGradient(0,h,0,0);
      grad.addColorStop(0, "#c084fc"); grad.addColorStop(1, "#347dff");
      ctx.fillStyle = grad; ctx.globalAlpha = 0.5 + v*0.5;
      ctx.fillRect(i*bw+1, (h-bh)/2, bw-2, bh);
    }
    ctx.globalAlpha = 1;
  }
  loop();
}

/* ============================== profile ============================== */
function applyProfileEverywhere() {
  $("#profileDisplayName").textContent = state.profile.name;
  $("#profileUsername").textContent = "@" + state.profile.username;
  $("#settingsProfileSummary").textContent = `${state.profile.name} · @${state.profile.username}`;
  const avatarHTML = `<img src="${state.profile.avatar || DEFAULT_AVATAR_URL}" alt="">`;
  $("#headerAvatar").innerHTML = avatarHTML;
  $("#bigAvatar").innerHTML = avatarHTML;
}
function renderProfilePage() {
  applyProfileEverywhere();
  $("#profileSongs").textContent = state.tracks.length;
  $("#profileArtists").textContent = getArtists().length;
  $("#profilePlaylists").textContent = state.playlists.length;
  $("#profileLikedSub").textContent = `${state.liked.length} songs`;
  $("#profilePlaylistSub").textContent = `${state.playlists.length} playlists`;
  $("#statLikedCount").textContent = state.liked.length;
  $("#statTotalPlays").textContent = state.recent.length;
  $("#statUniquePlayed").textContent = new Set(state.recent.map(r=>r.songId)).size;
}
function openEditProfileModal() {
  let pendingAvatar = state.profile.avatar;
  showModal("Edit Profile", "", "Save",
    `<div class="avatar-edit-wrap">
      <div class="avatar-edit-preview" id="avatarPreviewBtn"><img id="avatarPreviewImg" src="${pendingAvatar || DEFAULT_AVATAR_URL}" alt=""><div class="avatar-edit-overlay"><svg class="icon icon-sm"><use href="#i-edit"/></svg></div></div>
      <button class="secondary-btn" id="avatarChangeBtn" type="button" style="padding:8px 14px;font-size:12px">Change Photo</button>
    </div>
    <div class="modal-field"><label for="profileNameInput">Display Name</label><input id="profileNameInput" type="text" value="${escapeAttr(state.profile.name)}"></div>
    <div class="modal-field"><label for="profileUsernameInput">Username</label><input id="profileUsernameInput" type="text" value="${escapeAttr(state.profile.username)}"></div>`);
  const pickAvatar = () => $("#avatarInput").click();
  $("#avatarPreviewBtn").addEventListener("click", pickAvatar);
  $("#avatarChangeBtn").addEventListener("click", pickAvatar);
  const onAvatarChange = async e => {
    const file = e.target.files[0]; if (!file) return;
    try {
      pendingAvatar = await resizeImageToDataURL(file, 240);
      $("#avatarPreviewImg").src = pendingAvatar;
    } catch { toast("Couldn't read that image.", "error"); }
  };
  $("#avatarInput").addEventListener("change", onAvatarChange);
  $("#modalConfirm").onclick = () => {
    state.profile.name = $("#profileNameInput").value.trim() || state.profile.name;
    state.profile.username = ($("#profileUsernameInput").value.trim() || state.profile.username).replace(/^@/, "");
    state.profile.avatar = pendingAvatar;
    saveProfile();
    applyProfileEverywhere();
    renderProfilePage();
    $("#avatarInput").removeEventListener("change", onAvatarChange);
    closeModal(true); restoreModalDefaults();
    toast("Profile updated.", "success");
  };
}
function resizeImageToDataURL(file, size) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext("2d");
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2, sy = (img.height - side) / 2;
        ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
$("#profileEditBtn").addEventListener("click", openEditProfileModal);
$("#settingsEditProfileBtn").addEventListener("click", openEditProfileModal);
$("#headerProfile").addEventListener("click", () => navigate("/profile"));

/* ============================== settings ============================== */
function applyTheme() {
  const mode = state.settings.theme;
  const resolved = mode === "system" ? (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark") : mode;
  document.documentElement.setAttribute("data-theme", resolved);
  document.documentElement.style.setProperty("--accent-h", state.settings.accent);
}
if (window.matchMedia) {
  try { window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => { if (state.settings.theme === "system") applyTheme(); }); } catch {}
}
const ACCENT_CHOICES = [262, 156, 205, 16, 340];
function renderSettingsPage() {
  $$("#themeRow .theme-swatch").forEach(btn => btn.classList.toggle("active", btn.dataset.themeChoice === state.settings.theme));
  $("#accentSwatches").innerHTML = ACCENT_CHOICES.map(h => `<div class="color-swatch ${state.settings.accent==h?'active':''}" style="background:hsl(${h},85%,62%)" data-hue="${h}"></div>`).join("");
  $$("#accentSwatches .color-swatch").forEach(sw => sw.addEventListener("click", () => { state.settings.accent = +sw.dataset.hue; saveSettings(); applyTheme(); renderSettingsPage(); }));
  $("#settingCompact").classList.toggle("on", state.settings.compact);
  $("#settingAutoplay").classList.toggle("on", state.settings.autoplay);
  $("#settingCrossfade").value = state.settings.crossfade;
  $("#settingNormalize").classList.toggle("on", state.settings.normalize);
  $("#settingNotifications").classList.toggle("on", state.settings.notifications);
  $("#settingShowHistory").classList.toggle("on", state.settings.showHistory);
  $("#storageDetail").textContent = state.dbReady
    ? "Imported audio is stored locally in this browser (IndexedDB)."
    : "Persistent storage is unavailable in this session — songs stay only until you refresh. Serve Lux Sound Lab from a local web server (not by double-clicking the file) to fix this.";
}
$$("#themeRow .theme-swatch").forEach(btn => btn.addEventListener("click", () => { state.settings.theme = btn.dataset.themeChoice; saveSettings(); applyTheme(); renderSettingsPage(); }));
$("#settingCompact").addEventListener("click", () => { state.settings.compact = !state.settings.compact; saveSettings(); renderSettingsPage(); });
$("#settingAutoplay").addEventListener("click", () => { state.settings.autoplay = !state.settings.autoplay; saveSettings(); renderSettingsPage(); });
$("#settingCrossfade").addEventListener("input", e => { state.settings.crossfade = +e.target.value; saveSettings(); });
$("#settingNormalize").addEventListener("click", () => {
  state.settings.normalize = !state.settings.normalize; saveSettings();
  applyNormalizeGains();
  toast(state.settings.normalize ? "Volume normalization on." : "Volume normalization off.", "info");
  renderSettingsPage();
});
$("#settingShowHistory").addEventListener("click", () => { state.settings.showHistory = !state.settings.showHistory; saveSettings(); renderSettingsPage(); });
$("#settingImportFiles").addEventListener("click", () => openFilePicker());
$("#settingChooseFolder").addEventListener("click", () => requestFolderAccess());
$("#settingClearHistory").addEventListener("click", async () => {
  const confirmed = await showModal("Clear listening history?", "This can't be undone.", "Clear History"); restoreModalDefaults();
  if (confirmed) clearHistory();
});
$("#clearLibraryBtn").addEventListener("click", async () => {
  const confirmed = await showModal("Clear local library?", "This removes imported music from this browser's local storage. Your original files on the device are not deleted.", "Clear Library"); restoreModalDefaults();
  if (!confirmed) return;
  if (state.dbReady) { try { await dbClear(STORE_SONGS); } catch {} }
  state.objectUrls.forEach(url => URL.revokeObjectURL(url)); state.objectUrls.clear();
  state.tracks = []; state.liked = []; state.recent = [];
  saveLiked(); saveRecent();
  if (state.currentTrack) { stopAllAudio(); state.currentTrack = null; state.isPlaying = false; $("#miniPlayer").classList.remove("show"); }
  renderRoute();
  toast("Local library cleared.", "info");
});

/* Notifications */
async function toggleNotificationSetting() {
  if (!state.settings.notifications) {
    if (!("Notification" in window)) { toast("This browser doesn't support notifications.", "error"); return; }
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { toast("Notification permission wasn't granted.", "error"); return; }
    state.settings.notifications = true;
  } else {
    state.settings.notifications = false;
  }
  saveSettings(); renderSettingsPage();
}
$("#settingNotifications").addEventListener("click", toggleNotificationSetting);
function maybeNotify(track) {
  if (!state.settings.notifications || !("Notification" in window) || Notification.permission !== "granted") return;
  try { new Notification(track.title, { body: track.artist, tag: "lux-sound-lab-playback" }); } catch {}
}

/* ============================== privacy page ============================== */
$("#privacyBack").addEventListener("click", () => navigate("/settings"));
$("#privacyClearHistory").addEventListener("click", async () => {
  const confirmed = await showModal("Clear listening history?", "This can't be undone.", "Clear History"); restoreModalDefaults();
  if (confirmed) clearHistory();
});
$("#privacyClearAll").addEventListener("click", async () => {
  const confirmed = await showModal("Clear all local app data?", "This removes your library, playlists, liked songs, profile and settings from this browser. This can't be undone.", "Clear Everything"); restoreModalDefaults();
  if (!confirmed) return;
  if (state.dbReady) { try { await dbClear(STORE_SONGS); await dbClear(STORE_PLAYLISTS); } catch {} }
  state.objectUrls.forEach(url => URL.revokeObjectURL(url)); state.objectUrls.clear();
  Object.values(K).forEach(key => { try { localStorage.removeItem(key); } catch {} });
  location.reload();
});

/* ============================== about page ============================== */
$("#aboutBack").addEventListener("click", () => navigate("/settings"));

/* ============================== header / mini / now-playing controls ============================== */
$("#importMusicBtn").addEventListener("click", () => requestFolderAccess());
$("#openLibraryBtn").addEventListener("click", () => navigate("/library"));
$("#miniOpen").addEventListener("click", openNowPlaying);
$("#miniPlay").addEventListener("click", togglePlay);
$("#miniNext").addEventListener("click", () => nextTrack());
$("#miniLike").addEventListener("click", () => { if (state.currentTrack) toggleLike(state.currentTrack.id); });

$("#closeNowPlaying").addEventListener("click", closeNowPlaying);
$("#mainPlay").addEventListener("click", togglePlay);
$("#nextBtn").addEventListener("click", () => nextTrack());
$("#previousBtn").addEventListener("click", previousTrack);
$("#nowLike").addEventListener("click", () => { if (state.currentTrack) toggleLike(state.currentTrack.id); });
$("#shuffleBtn").addEventListener("click", () => { state.shuffle = !state.shuffle; toast(state.shuffle?"Shuffle enabled.":"Shuffle disabled.", "info"); updatePlayerUI(); });
$("#repeatBtn").addEventListener("click", () => { state.repeat = !state.repeat; toast(state.repeat?"Repeat enabled.":"Repeat disabled.", "info"); updatePlayerUI(); });
/* ============================== volume / mute (applies to both elements so
   whichever is active — or mid-crossfade — reflects the same device volume) ============================== */
function applyVolume() {
  const vol = state.settings.muted ? 0 : (state.settings.volume / 100);
  [state.audioA, state.audioB].forEach(el => { if (el) el.volume = vol; });
  $("#muteIcon").innerHTML = `<use href="#i-${state.settings.muted || state.settings.volume===0 ? 'volume-mute' : 'volume'}"></use>`;
  $("#volumeSlider").value = state.settings.volume;
}
$("#volumeSlider").addEventListener("input", e => {
  state.settings.volume = +e.target.value;
  if (state.settings.volume > 0) state.settings.muted = false;
  saveSettings(); applyVolume();
});
$("#muteBtn").addEventListener("click", () => { state.settings.muted = !state.settings.muted; saveSettings(); applyVolume(); });
$("#shareBtn").addEventListener("click", async () => {
  if (!state.currentTrack) { toast("Nothing is playing.", "info"); return; }
  const text = `${state.currentTrack.title} — ${state.currentTrack.artist}`;
  if (navigator.share) { try { await navigator.share({ title: state.currentTrack.title, text }); } catch {} }
  else { try { await navigator.clipboard.writeText(text); toast("Song information copied.", "success"); } catch { toast(text, "info"); } }
});
$("#nowMore").addEventListener("click", async () => {
  if (!state.currentTrack) return;
  openTrackMenu(state.currentTrack.id);
});

let touchStartY = 0;
$("#nowPlaying").addEventListener("touchstart", e => { touchStartY = e.touches[0].clientY; }, { passive: true });
$("#nowPlaying").addEventListener("touchend", e => { if (e.changedTouches[0].clientY - touchStartY > 100 && touchStartY < 250) closeNowPlaying(); }, { passive: true });

document.addEventListener("keydown", e => {
  const tag = document.activeElement?.tagName;
  if (e.code === "Space" && !["INPUT","TEXTAREA"].includes(tag)) { e.preventDefault(); togglePlay(); }
  if (e.key === "Escape") { closeNowPlaying(); closeModal(false); }
  if (!["INPUT","TEXTAREA"].includes(tag)) {
    if (e.code === "ArrowRight") activeAudio().currentTime += 10;
    if (e.code === "ArrowLeft") activeAudio().currentTime = Math.max(0, activeAudio().currentTime - 10);
    if (e.code === "KeyN") nextTrack();
    if (e.code === "KeyP") previousTrack();
    if (e.code === "KeyS") $("#shuffleBtn").click();
  }
});

/* ============================== media session ============================== */
function updateMediaSession(track) {
  if (!("mediaSession" in navigator) || !track) return;
  navigator.mediaSession.metadata = new MediaMetadata({ title: track.title, artist: track.artist, album: track.album });
  navigator.mediaSession.setActionHandler("play", togglePlay);
  navigator.mediaSession.setActionHandler("pause", togglePlay);
  navigator.mediaSession.setActionHandler("nexttrack", () => nextTrack());
  navigator.mediaSession.setActionHandler("previoustrack", previousTrack);
}
const _origUpdatePlayerUI = updatePlayerUI;

/* ============================== init ============================== */
async function init() {
  loadStorage();
  applyTheme();
  applyProfileEverywhere();
  applyVolume();

  await loadLibrary();

  if (state.tracks.length) hideOnboarding(); else showOnboarding();
  if (!state.dbReady) {
    $("#onbNote").textContent = "Note: this browser session can't persist your library (IndexedDB is unavailable). Songs will still play, but won't survive a refresh — try opening Lux Sound Lab from a local web server instead of double-clicking the file.";
  }

  renderRoute();
  updatePlayerUI();
}

init();

})();
