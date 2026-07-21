/**
 * Notification clearer for Google Chat — API-driven.
 *
 * Injects a "Clear notifications" pill next to the "New chat" pill in the
 * sidebar. On click it hits the local gchat api server (default
 * http://localhost:9555) to:
 *   1. GET  /api/notifications         → list unread items
 *   2. POST /api/notifications/mark    → mark each as read in parallel
 *
 * This is ~100x faster than DOM automation and doesn't depend on
 * chat.google.com's markup. The server handles all auth via the extension
 * bridge (XSRF forwarded from this same extension).
 *
 * While running, the button switches to "Stop (n/total · pp%)" and clicks
 * cancel the in-flight batch (in-flight requests still complete).
 */

(() => {
  const BTN_ID = "gchat-clear-notifications-btn";
  const WRAP_ID = BTN_ID + "-wrap";
  const LOG_PREFIX = "[GChat Clear]";
  // Defaults — user can override via the settings gear in the picker.
  // The installer bakes these values into API_BASE_DEFAULT / BRIDGE_PORT_DEFAULT.
  const API_BASE_DEFAULT = "http://localhost:9555";
  const BRIDGE_PORT_DEFAULT = 9556;
  const CONCURRENCY = 8;
  const REPO_URL = "https://github.com/Schachte/google-chat-clear-notifications";
  const README_URL = `${REPO_URL}#troubleshooting`;
  const HEALTH_POLL_MS = 5000;
  // Toggle verbose logging by setting localStorage.gchatClearDebug = "1"
  const DEBUG = (() => { try { return localStorage.getItem("gchatClearDebug") === "1"; } catch { return false; } })();
  if (DEBUG) console.log(`${LOG_PREFIX} script loaded in`, window.location.href);

  // Mutable at runtime. Populated from chrome.storage.local on load.
  let API_BASE = API_BASE_DEFAULT;
  let BRIDGE_PORT = BRIDGE_PORT_DEFAULT;

  function loadSettings() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(["apiBase", "bridgePort", "pickerMode", "hideRead", "typeFilter"], (v) => {
          if (typeof v?.apiBase === "string" && /^https?:\/\/.+:\d+$/.test(v.apiBase)) {
            API_BASE = v.apiBase;
          }
          if (typeof v?.bridgePort === "number" && v.bridgePort >= 1024 && v.bridgePort <= 65535) {
            BRIDGE_PORT = v.bridgePort;
          }
          if (v?.pickerMode === "all" || v?.pickerMode === "unread") {
            picker.mode = v.pickerMode;
          }
          if (typeof v?.hideRead === "boolean") {
            picker.hideRead = v.hideRead;
          }
          if (v?.typeFilter === "all" || v?.typeFilter === "dm" || v?.typeFilter === "space") {
            picker.typeFilter = v.typeFilter;
          }
          if (DEBUG) console.log(`${LOG_PREFIX} settings loaded: API_BASE=${API_BASE} BRIDGE_PORT=${BRIDGE_PORT} mode=${picker.mode} hideRead=${picker.hideRead} typeFilter=${picker.typeFilter}`);
          resolve();
        });
      } catch { resolve(); }
    });
  }

  async function saveSettings(newApiBase, newBridgePort) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set({ apiBase: newApiBase, bridgePort: newBridgePort }, () => {
          API_BASE = newApiBase;
          BRIDGE_PORT = newBridgePort;
          // Nudge background.js to reconnect on the new bridge port.
          try {
            chrome.runtime.sendMessage({ type: "SET_PORT", port: newBridgePort });
          } catch (e) {
            if (DEBUG) console.warn(`${LOG_PREFIX} could not notify background:`, e.message);
          }
          resolve();
        });
      } catch { resolve(); }
    });
  }

  // ── Favorites ─────────────────────────────────────────────────────────────
  // A favorite = { id, name, itemIds: [] }. itemIds are matched against fresh
  // fetchUnread() at run time; missing IDs (already-read rooms) are skipped.
  let favorites = [];

  function loadFavorites() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(["favorites"], (v) => {
          favorites = Array.isArray(v?.favorites) ? v.favorites : [];
          if (DEBUG) console.log(`${LOG_PREFIX} loaded ${favorites.length} favorite(s)`);
          resolve();
        });
      } catch { resolve(); }
    });
  }

  function persistFavorites() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set({ favorites }, () => resolve());
      } catch { resolve(); }
    });
  }

  async function addFavorite(name, itemIds) {
    const id = `fav_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    favorites.push({ id, name: name.trim(), itemIds: [...itemIds] });
    await persistFavorites();
    return id;
  }

  async function removeFavorite(id) {
    favorites = favorites.filter((f) => f.id !== id);
    await persistFavorites();
  }

  async function renameFavorite(id, name) {
    const f = favorites.find((x) => x.id === id);
    if (f) { f.name = name.trim(); await persistFavorites(); }
  }

  const ICON_CLEAR = `
    <svg xmlns="http://www.w3.org/2000/svg" height="20" width="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M19.36 2.72 20.78 4.14 15.06 9.85l-1.42-1.42zM11.29 7.05l4.24 4.24-8.49 8.49-4.24-4.24zM4 20l3 1 5-5-4-4-5 5zM17 14v2h5v-2zM15.24 17.66l1.41-1.41 3.54 3.54-1.41 1.41zM20 8.5V6.5h-5v2z"/>
    </svg>`;
  const ICON_STOP = `
    <svg xmlns="http://www.w3.org/2000/svg" height="20" width="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="1.5"/>
    </svg>`;

  // ── Anchor discovery ───────────────────────────────────────────────────────
  const ANCHOR_XPATH = "/html/body/div[2]/div[2]/div[1]/div[1]/div[2]/div/c-wiz/div[1]/div";
  const NEW_CHAT_LABELS = [
    "new chat", "new conversation", "start chat", "start a chat",
    "compose", "new message",
  ];

  function xpathFirst(xpath, root = document) {
    try {
      return document.evaluate(xpath, root, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
    } catch { return null; }
  }

  function findNewChatWrapper() {
    const byXPath = xpathFirst(ANCHOR_XPATH);
    if (byXPath?.querySelector("button")) return byXPath;
    for (const btn of document.querySelectorAll("button")) {
      const values = [
        (btn.textContent || "").trim(),
        (btn.getAttribute("aria-label") || "").trim(),
        (btn.getAttribute("data-tooltip") || "").trim(),
        (btn.getAttribute("title") || "").trim(),
      ].map((v) => v.toLowerCase());
      if (NEW_CHAT_LABELS.some((l) => values.includes(l))) {
        let cur = btn;
        for (let i = 0; i < 6 && cur; i++) {
          const parent = cur.parentElement;
          if (parent?.parentElement?.tagName === "C-WIZ") return cur;
          cur = parent;
        }
        return btn.parentElement?.parentElement || btn.parentElement;
      }
    }
    return null;
  }

  // ── API calls ──────────────────────────────────────────────────────────────
  async function apiFetch(path, opts = {}) {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
      ...opts,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${text.substring(0, 200)}`);
    }
    return res.json();
  }

  async function fetchUnread() {
    // Response shape (from api-server.ts):
    //   { unreadDMs, badgedSpaces, unreadSpaces, subscribedSpaces, ... }
    const data = await apiFetch("/api/notifications");
    const buckets = [
      data.unreadDMs,
      data.badgedSpaces,
      data.unreadSpaces,
      data.subscribedSpaces,
    ].filter(Array.isArray);
    const seen = new Set();
    const items = [];
    for (const bucket of buckets) {
      for (const it of bucket) {
        if (it && it.id && !seen.has(it.id)) {
          seen.add(it.id);
          items.push(it);
        }
      }
    }
    if (DEBUG) console.debug(`${LOG_PREFIX} buckets: dm=${data.unreadDMs?.length||0} badged=${data.badgedSpaces?.length||0} spaces=${data.unreadSpaces?.length||0} subscribed=${data.subscribedSpaces?.length||0}`);
    return items;
  }

  // Fetch every room + DM the user is a member of. Merges with the unread
  // list so unread flags are preserved on rooms that appear in both.
  async function fetchAllRooms() {
    const [all, unread] = await Promise.all([
      apiFetch("/api/spaces"),
      fetchUnread().catch(() => []),
    ]);
    const unreadIds = new Set(unread.map((u) => u.id));
    const items = [];
    const seen = new Set();
    const push = (arr, type) => {
      if (!Array.isArray(arr)) return;
      for (const it of arr) {
        if (!it?.id || seen.has(it.id)) continue;
        seen.add(it.id);
        items.push({ id: it.id, name: it.name, type: it.type || type, unread: unreadIds.has(it.id) });
      }
    };
    push(all.spaces, "space");
    push(all.dms, "dm");
    // Any unread not in spaces/dms lists (edge case) — include them.
    for (const it of unread) {
      if (!seen.has(it.id)) {
        seen.add(it.id);
        items.push({ ...it, unread: true });
      }
    }
    if (DEBUG) console.debug(`${LOG_PREFIX} all rooms: total=${items.length} unread=${unread.length}`);
    return items;
  }

  async function markRead(item) {
    return apiFetch("/api/notifications/mark", {
      method: "POST",
      body: JSON.stringify({ groupId: item.id, action: "read" }),
    });
  }

  // ── Server health ──────────────────────────────────────────────────────────
  const health = {
    connected: null, // null=unknown, true=OK, false=down
    lastError: "",
    lastCheck: 0,
  };

  async function checkHealth() {
    try {
      const res = await fetch(`${API_BASE}/health`, { method: "GET", cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      health.connected = true;
      health.lastError = "";
    } catch (err) {
      health.connected = false;
      // Normalize the common browser error into something actionable.
      const raw = err?.message || String(err);
      if (/Failed to fetch|NetworkError|TypeError/.test(raw)) {
        health.lastError = `Can't reach ${API_BASE}. Is ./start.sh running?`;
      } else {
        health.lastError = raw;
      }
    }
    health.lastCheck = Date.now();
    return health.connected;
  }

  // ── Parallel worker pool with cancellation ─────────────────────────────────
  const state = {
    running: false,
    cancelRequested: false,
    phase: "idle", // idle | loading | loaded | clearing | done
    processed: 0,
    failed: 0,
    total: 0,
  };

  async function processPool(items, worker, concurrency, onProgress) {
    let idx = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (idx < items.length && !state.cancelRequested) {
        const i = idx++;
        const item = items[i];
        try {
          const r = await worker(item);
          if (r?.success === false) state.failed++;
          else state.processed++;
        } catch (err) {
          state.failed++;
          console.warn(`${LOG_PREFIX} mark-read failed for ${item.id}:`, err.message);
        }
        onProgress?.();
      }
    });
    await Promise.all(workers);
  }

  // ── Button rendering ───────────────────────────────────────────────────────
  const ICON_SPINNER = `
    <svg xmlns="http://www.w3.org/2000/svg" height="18" width="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true" style="animation:gchat-spin 900ms linear infinite;">
      <path d="M12 3 A9 9 0 0 1 21 12" opacity="0.9"/>
      <path d="M21 12 A9 9 0 0 1 12 21" opacity="0.4"/>
      <path d="M12 21 A9 9 0 0 1 3 12" opacity="0.15"/>
    </svg>`;

  // Inject spinner keyframes once.
  (function injectStyles() {
    if (document.getElementById("gchat-clear-styles")) return;
    const style = document.createElement("style");
    style.id = "gchat-clear-styles";
    style.textContent = "@keyframes gchat-spin { to { transform: rotate(360deg); } }";
    document.documentElement.appendChild(style);
  })();

  function renderButton(btn) {
    const icon = btn.querySelector(".gchat-icon");
    const label = btn.querySelector(".gchat-label");
    const bar = btn.querySelector(".gchat-progress-bar");

    // Phase-driven messages
    let iconHtml = ICON_CLEAR;
    let labelText = "Clear notifications";
    let mode = "clear";
    let bg = "transparent";
    let color = "#9aa0a6";
    let pct = 0;

    switch (state.phase) {
      case "loading":
        iconHtml = ICON_SPINNER;
        labelText = "Loading rooms…";
        mode = "busy";
        bg = "rgba(138,180,248,0.10)";
        color = "#8ab4f8";
        break;
      case "loaded": {
        iconHtml = ICON_SPINNER;
        const n = state.total;
        labelText = n === 1 ? "1 room loaded" : `${n} rooms & chats loaded`;
        mode = "busy";
        bg = "rgba(138,180,248,0.10)";
        color = "#8ab4f8";
        break;
      }
      case "clearing": {
        iconHtml = ICON_STOP;
        const finished = state.processed + state.failed;
        pct = state.total > 0 ? Math.min(100, Math.round((finished / state.total) * 100)) : 0;
        labelText = state.total
          ? `Clearing notifications… (${finished}/${state.total}) · ${pct}%`
          : `Clearing notifications… (${finished})`;
        mode = "stop";
        bg = "rgba(220,90,90,0.12)";
        color = "#f28b82";
        break;
      }
      case "idle":
      case "done":
      default:
        break;
    }

    icon.innerHTML = iconHtml;
    label.textContent = labelText;
    btn.dataset.mode = mode;
    btn.setAttribute("aria-label", labelText + (mode === "stop" ? " — click to stop" : ""));
    btn.setAttribute("title", mode === "stop" ? "Click to stop" : labelText);
    btn.style.background = bg;
    btn.style.color = color;
    if (bar) bar.style.width = pct + "%";
  }

  function flash(btn, msg, isError = false) {
    const tip = btn.querySelector(".gchat-clear-tip");
    if (!tip) return;
    tip.textContent = msg;
    tip.style.background = isError ? "#5c2b2b" : "#333";
    tip.style.color = isError ? "#ffd0d0" : "#eee";
    tip.style.opacity = "1";
    setTimeout(() => (tip.style.opacity = "0"), 2500);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ── Main clear action (API-driven) ─────────────────────────────────────────
  // If `presetItems` is passed, skip the fetch phase (used by the room picker).
  async function clearAllNotifications(btn, presetItems = null) {
    if (state.running) return;
    state.running = true;
    state.cancelRequested = false;
    state.processed = 0;
    state.failed = 0;
    state.total = 0;
    state.phase = presetItems ? "loaded" : "loading";
    renderButton(btn);

    try {
      let items;
      if (presetItems) {
        items = presetItems;
        state.total = items.length;
        renderButton(btn);
      } else {
        if (DEBUG) console.log(`${LOG_PREFIX} fetching unread from ${API_BASE}/api/notifications`);
        items = await fetchUnread();
        state.total = items.length;
        state.phase = "loaded";
        renderButton(btn);
        if (DEBUG) console.log(`${LOG_PREFIX} ${items.length} unread items to clear`);
      }

      if (items.length === 0) {
        await sleep(500);
        state.phase = "done";
        renderButton(btn);
        flash(btn, "All caught up — nothing to clear");
        return;
      }

      // Short beat so the user actually sees "N rooms loaded" before it flips.
      await sleep(400);
      state.phase = "clearing";
      renderButton(btn);

      const t0 = performance.now();
      await processPool(items, markRead, CONCURRENCY, () => renderButton(btn));
      const dt = ((performance.now() - t0) / 1000).toFixed(1);

      state.phase = "done";
      const msg = state.cancelRequested
        ? `Stopped at ${state.processed}/${state.total}`
        : `Cleared ${state.processed}${state.failed ? ` · ${state.failed} failed` : ""} in ${dt}s`;
      if (DEBUG) console.log(`${LOG_PREFIX} ${msg}`);
      flash(btn, msg, state.failed > 0);
    } catch (err) {
      console.error(`${LOG_PREFIX} error`, err);
      const hint = err.message.includes("Failed to fetch") || err.message.includes("NetworkError")
        ? "Server not running — start ./start.sh"
        : err.message;
      flash(btn, hint, true);
    } finally {
      state.running = false;
      state.cancelRequested = false;
      state.phase = "idle";
      renderButton(btn);
    }
  }

  function handleClick(btn) {
    if (state.running) {
      state.cancelRequested = true;
      const label = btn.querySelector(".gchat-label");
      if (label) label.textContent = "Stopping…";
    } else {
      clearAllNotifications(btn);
    }
  }

  // ── Room picker (multi-select subset) ──────────────────────────────────────
  const picker = {
    open: false,
    items: [],               // full fetched list (respects mode)
    selected: new Set(),     // item.id
    filter: "",
    mode: "unread",          // "unread" | "all"
    hideRead: false,         // only relevant when mode==="all"
    typeFilter: "all",       // "all" | "dm" | "space"
    // Pre-fetched cache so tab counts render immediately without a switch.
    counts: { unread: null, all: null },
    // Non-null when editing a favorite's rooms.
    editingFavId: null,
    outsideClickHandler: null,
    keydownHandler: null,
    _favMenuOutside: null,
    _favPanelOutside: null,
    _favPanelKey: null,
  };

  async function fetchForMode() {
    return picker.mode === "all" ? fetchAllRooms() : fetchUnread();
  }

  function updateModeUi(wrap) {
    const unreadBtn = wrap.querySelector(".gchat-mode-unread");
    const allBtn    = wrap.querySelector(".gchat-mode-all");
    const active    = picker.mode;
    const setActive = (btn, on) => {
      if (!btn) return;
      btn.style.background = on ? "rgba(138,180,248,0.15)" : "transparent";
      btn.style.color      = on ? "#8ab4f8" : "#9aa0a6";
      btn.style.fontWeight = on ? "500" : "400";
      // Also tint the count badge on the active tab
      const badge = btn.querySelector("span");
      if (badge) {
        badge.style.background = on ? "rgba(138,180,248,0.20)" : "rgba(255,255,255,0.06)";
        badge.style.color      = on ? "#8ab4f8" : "#9aa0a6";
      }
    };
    setActive(unreadBtn, active === "unread");
    setActive(allBtn,    active === "all");
    // Show the "Hide read" toggle only in All mode.
    const hideWrap = wrap.querySelector(".gchat-hide-read-wrap");
    const hideCb   = wrap.querySelector(".gchat-hide-read");
    if (hideWrap) hideWrap.style.display = active === "all" ? "inline-flex" : "none";
    if (hideCb) hideCb.checked = !!picker.hideRead;
    // Type filter segment highlight
    const setActiveSimple = (btn, on) => {
      if (!btn) return;
      btn.style.background = on ? "rgba(138,180,248,0.15)" : "transparent";
      btn.style.color      = on ? "#8ab4f8" : "#9aa0a6";
      btn.style.fontWeight = on ? "500" : "400";
    };
    setActiveSimple(wrap.querySelector(".gchat-type-all"),   picker.typeFilter === "all");
    setActiveSimple(wrap.querySelector(".gchat-type-dm"),    picker.typeFilter === "dm");
    setActiveSimple(wrap.querySelector(".gchat-type-space"), picker.typeFilter === "space");
  }

  function updateModeCounts(wrap) {
    const uEl = wrap.querySelector(".gchat-mode-unread-count");
    const aEl = wrap.querySelector(".gchat-mode-all-count");
    // Refresh cache from whatever data we currently have.
    if (picker.mode === "unread") {
      picker.counts.unread = picker.items.length;
    } else {
      picker.counts.all = picker.items.length;
      picker.counts.unread = picker.items.filter((it) => it.unread).length;
    }
    const fmt = (n) => (n == null ? "…" : String(n));
    if (uEl) uEl.textContent = fmt(picker.counts.unread);
    if (aEl) aEl.textContent = fmt(picker.counts.all);
  }

  function iconForType(type) {
    // 'dm' → speech-bubble, 'space' → hash, other → generic
    if (type === "dm") {
      return `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;
    }
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M20 8h-3V4H8v4H5v12h15V8zM10 6h5v2h-5V6zm8 12H6V10h12v8z"/></svg>`;
  }

  async function openPicker(wrap) {
    if (!wrap) return;
    if (health.connected === false) {
      flash(wrap.querySelector(`#${BTN_ID}`), health.lastError || "Server not reachable", true);
      return;
    }
    // Full picker and mini fav panel are mutually exclusive.
    closeFavPanel(wrap);
    picker.open = true;
    picker.filter = "";
    picker.selected.clear();
    const panel = wrap.querySelector(".gchat-picker");
    const search = wrap.querySelector(".gchat-picker-search");
    const list = wrap.querySelector(".gchat-picker-list");
    const chev = wrap.querySelector(".gchat-chev");
    if (!panel || !list) return;

    panel.style.display = "block";
    if (chev) chev.style.color = "#e8eaed";
    list.innerHTML = `<div class="gchat-picker-empty" style="padding:16px;text-align:center;color:#9aa0a6;font-size:12px;">Loading rooms…</div>`;

    // Wire once — panel elements are recreated each buildButton so it's safe.
    wirePickerEvents(wrap);
    updateModeUi(wrap);
    renderFavorites(wrap);

    // If the server is known-down, skip the fetch and show a hint so the
    // user can focus on editing settings.
    if (health.connected === false) {
      list.innerHTML = `<div class="gchat-picker-empty" style="padding:16px;text-align:center;color:#f28b82;font-size:12px;">Server unreachable — edit ports in Settings below.</div>`;
      return;
    }

    try {
      picker.items = await fetchForMode();
    } catch (err) {
      list.innerHTML = `<div class="gchat-picker-empty" style="padding:16px;text-align:center;color:#f28b82;font-size:12px;">${err.message || "Failed to load"}</div>`;
      return;
    }
    renderPickerList(wrap);
    if (search) { search.focus(); search.select(); }
  }

  function closePicker(wrap) {
    if (!wrap) return;
    picker.open = false;
    // Discard any pending edit-mode work when the picker closes.
    if (picker.editingFavId != null) exitEditMode(wrap);
    closeFavMenu(wrap);
    const panel = wrap.querySelector(".gchat-picker");
    const chev = wrap.querySelector(".gchat-chev");
    const settingsPanel = wrap.querySelector(".gchat-settings-panel");
    const settingsBtn = wrap.querySelector(".gchat-picker-settings");
    if (panel) panel.style.display = "none";
    if (chev) chev.style.color = "";
    if (settingsPanel) settingsPanel.style.display = "none";
    if (settingsBtn) settingsBtn.style.color = "";
    // Detach global listeners
    if (picker.outsideClickHandler) {
      document.removeEventListener("mousedown", picker.outsideClickHandler, true);
      picker.outsideClickHandler = null;
    }
    if (picker.keydownHandler) {
      document.removeEventListener("keydown", picker.keydownHandler, true);
      picker.keydownHandler = null;
    }
  }

  function togglePicker(wrap) {
    if (picker.open) closePicker(wrap);
    else openPicker(wrap);
  }

  function filteredPickerItems() {
    const q = picker.filter.trim().toLowerCase();
    const tf = picker.typeFilter;
    let list = picker.items;
    // Type filter (DM / Space / all)
    if (tf === "dm" || tf === "space") {
      list = list.filter((it) => it.type === tf);
    }
    // "Hide read" only meaningful in All mode; in Unread mode everything is unread.
    if (picker.mode === "all" && picker.hideRead) {
      list = list.filter((it) => it.unread);
    }
    if (q) {
      list = list.filter((it) => (it.name || it.id || "").toLowerCase().includes(q));
    }
    // Sort: in All mode unread first, then by name (case-insensitive).
    // In Unread mode just alphabetical.
    const byName = (a, b) => (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" });
    if (picker.mode === "all") {
      list = [...list].sort((a, b) => {
        const ua = a.unread ? 0 : 1;
        const ub = b.unread ? 0 : 1;
        if (ua !== ub) return ua - ub;
        return byName(a, b);
      });
    } else {
      list = [...list].sort(byName);
    }
    return list;
  }

  function renderFavorites(wrap) {
    const strip = wrap.querySelector(".gchat-picker-favs");
    if (!strip) return;
    if (favorites.length === 0) {
      strip.style.display = "none";
      strip.innerHTML = "";
      return;
    }
    strip.style.display = "flex";
    strip.innerHTML =
      `<span style="color:#9aa0a6;font-size:11px;margin-right:2px;">Favorites:</span>` +
      favorites.map((f) => `
        <span class="gchat-fav-chip" data-fav-id="${escapeAttr(f.id)}" style="
          display:inline-flex;align-items:center;gap:2px;
          background:rgba(138,180,248,0.10);border:1px solid rgba(138,180,248,0.25);
          color:#8ab4f8;border-radius:12px;padding:2px 2px 2px 8px;font-size:11px;
        ">
          <button class="gchat-fav-run" data-fav-id="${escapeAttr(f.id)}"
            title="Clear ${f.itemIds.length} saved room(s)"
            style="
              background:transparent;border:0;color:inherit;cursor:pointer;
              padding:0;font:inherit;display:inline-flex;align-items:center;gap:4px;
            ">
            <span class="gchat-fav-name" style="max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
              ${escapeHtml(f.name)}
            </span>
            <span style="color:#9aa0a6;font-size:10px;">${f.itemIds.length}</span>
          </button>
          <button class="gchat-fav-menu" data-fav-id="${escapeAttr(f.id)}" title="Options" style="
            background:transparent;border:0;color:#9aa0a6;cursor:pointer;
            padding:0 4px;font:inherit;line-height:1;font-size:14px;
          ">&#8942;</button>
        </span>
      `).join("");
  }

  // ── Favorites mini panel (opened from the star split segment) ─────────────
  function renderFavPanel(wrap) {
    const body = wrap.querySelector(".gchat-fav-panel-body");
    if (!body) return;
    if (favorites.length === 0) {
      body.innerHTML = `
        <div style="padding:16px;text-align:center;color:#9aa0a6;font-size:12px;">
          No favorites yet.<br>
          <span style="color:#c8c8c8;">Save one from the room picker.</span>
        </div>`;
      return;
    }
    body.innerHTML = favorites.map((f) => `
      <div class="gchat-fav-row" data-fav-id="${escapeAttr(f.id)}" style="
        display:flex;align-items:center;gap:8px;
        padding:8px 12px;cursor:pointer;
      ">
        <span style="flex:0 0 auto;color:#8ab4f8;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/>
          </svg>
        </span>
        <span style="flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(f.name)}</span>
        <span style="flex:0 0 auto;font-size:11px;color:#9aa0a6;">${f.itemIds.length}</span>
        <button class="gchat-fav-panel-menu" data-fav-id="${escapeAttr(f.id)}" title="Options" style="
          flex:0 0 auto;background:transparent;border:0;color:#9aa0a6;cursor:pointer;
          padding:0 4px;font:inherit;line-height:1;font-size:14px;
        ">&#8942;</button>
      </div>
    `).join("");
    // Row click clears favorite; ⋮ button opens the popover.
    body.querySelectorAll(".gchat-fav-row").forEach((row) => {
      row.addEventListener("click", async (e) => {
        if (e.target.closest(".gchat-fav-panel-menu")) return; // menu handles itself
        e.preventDefault();
        const fav = favorites.find((f) => f.id === row.dataset.favId);
        if (!fav) return;
        closeFavPanel(wrap);
        await runFavorite(wrap, fav);
      });
      row.addEventListener("mouseenter", () => row.style.background = "rgba(255,255,255,0.06)");
      row.addEventListener("mouseleave", () => row.style.background = "transparent");
    });
    body.querySelectorAll(".gchat-fav-panel-menu").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        openFavMenu(wrap, btn.getAttribute("data-fav-id"), btn);
      });
    });
  }

  function openFavPanel(wrap) {
    if (health.connected === false) {
      flash(wrap.querySelector(`#${BTN_ID}`), health.lastError || "Server not reachable", true);
      return;
    }
    const fp = wrap.querySelector(".gchat-fav-panel");
    if (!fp) return;
    // Close the main picker if it's open (they're mutually exclusive).
    if (picker.open) closePicker(wrap);
    renderFavPanel(wrap);
    fp.style.display = "block";
    const starBtn = wrap.querySelector(".gchat-star");
    if (starBtn) starBtn.style.color = "#e8eaed";
    // Outside click + Escape close it.
    picker._favPanelOutside = (e) => {
      if (!wrap.contains(e.target)) closeFavPanel(wrap);
    };
    picker._favPanelKey = (e) => {
      if (e.key !== "Escape") return;
      if (wrap.querySelector(".gchat-fav-popover")) return closeFavMenu(wrap);
      e.preventDefault();
      closeFavPanel(wrap);
    };
    document.addEventListener("mousedown", picker._favPanelOutside, true);
    document.addEventListener("keydown", picker._favPanelKey, true);
  }

  function closeFavPanel(wrap) {
    const fp = wrap.querySelector(".gchat-fav-panel");
    if (fp) fp.style.display = "none";
    const starBtn = wrap.querySelector(".gchat-star");
    if (starBtn) starBtn.style.color = "";
    closeFavMenu(wrap);
    if (picker._favPanelOutside) {
      document.removeEventListener("mousedown", picker._favPanelOutside, true);
      picker._favPanelOutside = null;
    }
    if (picker._favPanelKey) {
      document.removeEventListener("keydown", picker._favPanelKey, true);
      picker._favPanelKey = null;
    }
  }

  function toggleFavPanel(wrap) {
    const fp = wrap.querySelector(".gchat-fav-panel");
    if (fp && fp.style.display === "block") closeFavPanel(wrap);
    else openFavPanel(wrap);
  }

  async function runFavorite(wrap, fav) {
    // Close any open panels FIRST so the button is visible for the animation.
    closePicker(wrap);
    closeFavPanel(wrap);
    const btn = wrap.querySelector(`#${BTN_ID}`);
    if (!btn || state.running) return;

    // Enter loading phase immediately so the user sees feedback while the
    // notifications endpoint is being hit. We'll flip to "loaded" once we
    // know the actual count, or bail out cleanly on error / empty set.
    state.running = true;
    state.cancelRequested = false;
    state.processed = 0;
    state.failed = 0;
    state.total = 0;
    state.phase = "loading";
    renderButton(btn);

    let fresh;
    try {
      fresh = await fetchUnread();
    } catch (err) {
      state.running = false;
      state.phase = "idle";
      renderButton(btn);
      flash(btn, err.message || "Fetch failed", true);
      return;
    }

    const idSet = new Set(fav.itemIds);
    const chosen = fresh.filter((it) => idSet.has(it.id));
    if (chosen.length === 0) {
      state.running = false;
      state.phase = "idle";
      renderButton(btn);
      flash(btn, `Nothing to clear in "${fav.name}"`, false);
      return;
    }

    // Reset the running flag so clearAllNotifications can take over cleanly.
    state.running = false;
    await clearAllNotifications(btn, chosen);
  }

  async function enterEditMode(wrap, fav) {
    picker.editingFavId = fav.id;
    // Switch to All mode so every room is browsable.
    picker.mode = "all";
    picker.selected = new Set(fav.itemIds);
    picker.filter = "";
    try { chrome.storage.local.set({ pickerMode: "all" }); } catch {}
    updateModeUi(wrap);
    updateEditBanner(wrap);
    const list = wrap.querySelector(".gchat-picker-list");
    if (list) list.innerHTML = `<div class="gchat-picker-empty" style="padding:16px;text-align:center;color:#9aa0a6;font-size:12px;">Loading all rooms…</div>`;
    try {
      picker.items = await fetchForMode();
    } catch (err) {
      if (list) list.innerHTML = `<div class="gchat-picker-empty" style="padding:16px;text-align:center;color:#f28b82;font-size:12px;">${err.message || "Failed to load"}</div>`;
      return;
    }
    updateModeCounts(wrap);
    renderPickerList(wrap);
  }

  function exitEditMode(wrap) {
    picker.editingFavId = null;
    picker.selected.clear();
    updateEditBanner(wrap);
    renderPickerList(wrap);
  }

  function updateEditBanner(wrap) {
    let banner = wrap.querySelector(".gchat-edit-banner");
    const editing = picker.editingFavId != null;
    const clearBtn = wrap.querySelector(".gchat-pick-clear");
    const saveFavBtn = wrap.querySelector(".gchat-pick-save-fav");
    const favStrip = wrap.querySelector(".gchat-picker-favs");
    if (editing) {
      const fav = favorites.find((f) => f.id === picker.editingFavId);
      if (!banner) {
        banner = document.createElement("div");
        banner.className = "gchat-edit-banner";
        banner.style.cssText = `
          display:flex;align-items:center;gap:8px;
          padding:6px 10px;background:rgba(138,180,248,0.08);
          border-bottom:1px solid rgba(138,180,248,0.20);
          color:#8ab4f8;font-size:12px;
        `;
        // Insert at top of the panel body (right after header).
        const panel = wrap.querySelector(".gchat-picker");
        const hdr = panel?.querySelector(".gchat-picker-hdr");
        if (panel && hdr) panel.insertBefore(banner, hdr.nextSibling);
      }
      banner.innerHTML = `
        <span style="flex:1 1 auto;">Editing “${escapeHtml(fav?.name || "")}” — check rooms to include</span>
        <button class="gchat-edit-cancel" type="button" style="
          background:transparent;border:1px solid rgba(255,255,255,0.10);color:#9aa0a6;
          padding:3px 8px;border-radius:4px;cursor:pointer;font:inherit;
        ">Cancel</button>
        <button class="gchat-edit-save" type="button" style="
          background:rgba(138,180,248,0.15);border:1px solid rgba(138,180,248,0.35);color:#8ab4f8;
          padding:3px 8px;border-radius:4px;cursor:pointer;font:500 inherit;
        ">Save</button>
      `;
      if (favStrip) favStrip.style.display = "none";
      // Hide the normal footer actions to avoid confusion during edit.
      if (clearBtn) clearBtn.style.display = "none";
      if (saveFavBtn) saveFavBtn.style.display = "none";
    } else {
      if (banner) banner.remove();
      if (favStrip) renderFavorites(wrap); // restores display state
      if (clearBtn) clearBtn.style.display = "";
      if (saveFavBtn) saveFavBtn.style.display = "";
    }
  }

  function closeFavMenu(wrap) {
    const menu = wrap.querySelector(".gchat-fav-popover");
    if (menu) menu.remove();
    if (picker._favMenuOutside) {
      document.removeEventListener("mousedown", picker._favMenuOutside, true);
      picker._favMenuOutside = null;
    }
  }

  function openFavMenu(wrap, favId, anchorBtn) {
    closeFavMenu(wrap);
    const fav = favorites.find((f) => f.id === favId);
    if (!fav) return;
    const menu = document.createElement("div");
    menu.className = "gchat-fav-popover";
    menu.dataset.favId = favId;
    menu.style.cssText = `
      position:absolute;z-index:1002;
      background:#1f1f1f;border:1px solid rgba(255,255,255,0.10);
      border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,0.35);
      min-width:150px;padding:4px 0;
      font:12px 'Google Sans',Roboto,sans-serif;color:#e8eaed;
    `;
    const item = (label, action, danger) => `
      <button class="gchat-fav-act" data-act="${action}" style="
        display:block;width:100%;text-align:left;
        background:transparent;border:0;color:${danger ? "#f28b82" : "#e8eaed"};
        padding:6px 12px;cursor:pointer;font:inherit;
      ">${label}</button>`;
    menu.innerHTML =
      item(`Clear now (${fav.itemIds.length})`, "run") +
      item("Edit rooms…", "edit") +
      item("Rename…", "rename") +
      `<div style="height:1px;background:rgba(255,255,255,0.08);margin:4px 0;"></div>` +
      item("Delete", "delete", true);

    // Position under the chip's menu button.
    const wrapRect = wrap.getBoundingClientRect();
    const btnRect  = anchorBtn.getBoundingClientRect();
    menu.style.top  = `${btnRect.bottom - wrapRect.top + 4}px`;
    menu.style.left = `${btnRect.left  - wrapRect.left}px`;
    wrap.appendChild(menu);

    // Hover styling
    menu.querySelectorAll(".gchat-fav-act").forEach((btn) => {
      btn.addEventListener("mouseenter", () => btn.style.background = "rgba(255,255,255,0.06)");
      btn.addEventListener("mouseleave", () => btn.style.background = "transparent");
    });

    // Outside click closes menu (but doesn't propagate to close picker).
    picker._favMenuOutside = (e) => {
      if (!menu.contains(e.target)) closeFavMenu(wrap);
    };
    // Defer so the click that opened the menu doesn't immediately close it.
    setTimeout(() => document.addEventListener("mousedown", picker._favMenuOutside, true), 0);
  }

  function renderPickerList(wrap) {
    const list = wrap.querySelector(".gchat-picker-list");
    const count = wrap.querySelector(".gchat-picker-count");
    const clearBtn = wrap.querySelector(".gchat-pick-clear");
    const saveFavBtn = wrap.querySelector(".gchat-pick-save-fav");
    if (!list) return;

    const filtered = filteredPickerItems();
    if (count) {
      count.textContent = picker.selected.size
        ? `${picker.selected.size} / ${picker.items.length} selected`
        : `${picker.items.length} rooms`;
    }
    if (clearBtn) {
      const n = picker.selected.size;
      clearBtn.disabled = n === 0;
      clearBtn.style.opacity = n === 0 ? "0.55" : "1";
      clearBtn.style.cursor  = n === 0 ? "not-allowed" : "pointer";
      clearBtn.textContent = n ? `Clear ${n} selected` : "Clear selected";
    }
    if (saveFavBtn) {
      const n = picker.selected.size;
      saveFavBtn.disabled = n === 0;
      saveFavBtn.style.opacity = n === 0 ? "0.5" : "1";
      saveFavBtn.style.cursor  = n === 0 ? "not-allowed" : "pointer";
    }

    if (picker.items.length === 0) {
      list.innerHTML = `<div class="gchat-picker-empty" style="padding:16px;text-align:center;color:#9aa0a6;font-size:12px;">No unread rooms</div>`;
      return;
    }
    if (filtered.length === 0) {
      list.innerHTML = `<div class="gchat-picker-empty" style="padding:16px;text-align:center;color:#9aa0a6;font-size:12px;">No matches for “${escapeHtml(picker.filter)}”</div>`;
      return;
    }

    // Build with section headers. Sections split by (unread-state, type).
    // Row order is already unread-first, alpha-within, so a single left-to-right
    // pass emits headers whenever the section key changes.
    const sectionKey = (it) => {
      const bucket = picker.mode === "all" ? (it.unread ? "unread" : "read") : "unread";
      const t = it.type === "dm" ? "dm" : "space";
      return `${bucket}:${t}`;
    };
    const sectionLabel = (key) => {
      const [bucket, t] = key.split(":");
      const name = t === "dm" ? "Direct messages" : "Spaces";
      // In All mode, prefix so users can tell unread vs read sections apart.
      if (picker.mode === "all") return bucket === "unread" ? `Unread · ${name}` : `Read · ${name}`;
      return name;
    };
    const headerHtml = (label, count) => `
      <div class="gchat-picker-section" style="
        display:flex;align-items:center;gap:6px;
        padding:6px 10px;font-size:10px;letter-spacing:.06em;text-transform:uppercase;
        color:#9aa0a6;background:#1f1f1f;
        border-bottom:1px solid rgba(255,255,255,0.06);
        position:sticky;top:0;z-index:2;
      ">
        <span style="flex:1 1 auto;">${escapeHtml(label)}</span>
        <span style="flex:0 0 auto;color:#5f6368;">${count}</span>
      </div>`;

    // Count rows per section for the header badges.
    const sectionCounts = new Map();
    for (const it of filtered) {
      const k = sectionKey(it);
      sectionCounts.set(k, (sectionCounts.get(k) || 0) + 1);
    }

    let currentSection = null;
    const rows = [];
    for (const it of filtered) {
      const k = sectionKey(it);
      if (k !== currentSection) {
        currentSection = k;
        rows.push(headerHtml(sectionLabel(k), sectionCounts.get(k)));
      }
      const sel = picker.selected.has(it.id);
      const name = it.name || it.id;
      const type = (it.type === "dm") ? "DM" : (it.type === "space") ? "Space" : "Room";
      const isRead = picker.mode === "all" && it.unread === false;
      const nameColor = isRead ? "#9aa0a6" : "#e8eaed";
      const dot = (picker.mode === "all" && it.unread)
        ? `<span title="Unread" style="flex:0 0 auto;width:6px;height:6px;border-radius:50%;background:#8ab4f8;"></span>`
        : `<span style="flex:0 0 auto;width:6px;height:6px;"></span>`;
      rows.push(`
        <label class="gchat-picker-row" data-id="${escapeAttr(it.id)}" style="
          display:flex;align-items:center;gap:8px;
          padding:6px 10px;cursor:pointer;
          background:${sel ? "rgba(138,180,248,0.10)" : "transparent"};
        ">
          <input type="checkbox" ${sel ? "checked" : ""} style="
            flex:0 0 auto;accent-color:#8ab4f8;cursor:pointer;
          "/>
          ${dot}
          <span style="flex:0 0 auto;color:#9aa0a6;">${iconForType(it.type)}</span>
          <span style="flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${nameColor};" title="${escapeAttr(name)}">${escapeHtml(name)}</span>
          <span style="flex:0 0 auto;font-size:11px;color:#9aa0a6;">${type}</span>
        </label>
      `);
    }
    list.innerHTML = rows.join("");

    // Row click toggles selection (label + checkbox handle it, but we want the
    // click on the row background too and to avoid double-toggle).
    list.querySelectorAll(".gchat-picker-row").forEach((row) => {
      row.addEventListener("click", (e) => {
        const cb = row.querySelector("input[type=checkbox]");
        // Native label click already toggles the checkbox. Only sync state.
        // Use requestAnimationFrame so we read the post-toggle state.
        requestAnimationFrame(() => {
          const id = row.dataset.id;
          if (cb && cb.checked) picker.selected.add(id);
          else picker.selected.delete(id);
          row.style.background = cb?.checked ? "rgba(138,180,248,0.10)" : "transparent";
          // Update footer/count without full re-render (cheap path)
          updatePickerFooter(wrap);
        });
      });
    });
  }

  function updatePickerFooter(wrap) {
    const count = wrap.querySelector(".gchat-picker-count");
    const clearBtn = wrap.querySelector(".gchat-pick-clear");
    if (count) {
      count.textContent = picker.selected.size
        ? `${picker.selected.size} / ${picker.items.length} selected`
        : `${picker.items.length} rooms`;
    }
    if (clearBtn) {
      const n = picker.selected.size;
      clearBtn.disabled = n === 0;
      clearBtn.style.opacity = n === 0 ? "0.55" : "1";
      clearBtn.style.cursor  = n === 0 ? "not-allowed" : "pointer";
      clearBtn.textContent = n ? `Clear ${n} selected` : "Clear selected";
    }
  }

  function wirePickerEvents(wrap) {
    const panel = wrap.querySelector(".gchat-picker");
    const search = wrap.querySelector(".gchat-picker-search");
    const allBtn = wrap.querySelector(".gchat-pick-all");
    const noneBtn = wrap.querySelector(".gchat-pick-none");
    const cancelBtn = wrap.querySelector(".gchat-pick-cancel");
    const clearBtn = wrap.querySelector(".gchat-pick-clear");
    const refreshBtn = wrap.querySelector(".gchat-picker-refresh");
    const settingsBtn = wrap.querySelector(".gchat-picker-settings");
    const settingsPanel = wrap.querySelector(".gchat-settings-panel");
    const setApi = wrap.querySelector(".gchat-set-api");
    const setBridge = wrap.querySelector(".gchat-set-bridge");
    const setSave = wrap.querySelector(".gchat-set-save");
    const setReset = wrap.querySelector(".gchat-set-reset");

    // Guard against double-wiring
    if (panel?.dataset.wired === "1") return;
    if (panel) panel.dataset.wired = "1";

    search?.addEventListener("input", () => {
      picker.filter = search.value;
      renderPickerList(wrap);
    });
    refreshBtn?.addEventListener("click", async (e) => {
      e.preventDefault();
      const list = wrap.querySelector(".gchat-picker-list");
      refreshBtn.style.transform = "rotate(360deg)";
      setTimeout(() => { refreshBtn.style.transform = ""; }, 400);
      if (list) list.innerHTML = `<div class="gchat-picker-empty" style="padding:16px;text-align:center;color:#9aa0a6;font-size:12px;">Refreshing…</div>`;
      try {
        picker.items = await fetchForMode();
        renderPickerList(wrap);
      } catch (err) {
        if (list) list.innerHTML = `<div class="gchat-picker-empty" style="padding:16px;text-align:center;color:#f28b82;font-size:12px;">${err.message || "Failed to load"}</div>`;
      }
    });

    // Mode toggle: switch between Unread and All rooms.
    const modeSeg = wrap.querySelector(".gchat-mode-seg");
    modeSeg?.addEventListener("click", async (e) => {
      const btn = e.target.closest("button[data-mode]");
      if (!btn) return;
      e.preventDefault();
      const next = btn.getAttribute("data-mode");
      if (next === picker.mode) return;
      picker.mode = next;
      picker.selected.clear();
      try { chrome.storage.local.set({ pickerMode: next }); } catch {}
      updateModeUi(wrap);
      const list = wrap.querySelector(".gchat-picker-list");
      if (list) list.innerHTML = `<div class="gchat-picker-empty" style="padding:16px;text-align:center;color:#9aa0a6;font-size:12px;">Loading${next === "all" ? " all rooms" : ""}…</div>`;
      try {
        picker.items = await fetchForMode();
        renderPickerList(wrap);
      } catch (err) {
        if (list) list.innerHTML = `<div class="gchat-picker-empty" style="padding:16px;text-align:center;color:#f28b82;font-size:12px;">${err.message || "Failed to load"}</div>`;
      }
    });
    settingsBtn?.addEventListener("click", (e) => {
      e.preventDefault();
      if (!settingsPanel) return;
      const showing = settingsPanel.style.display === "block";
      settingsPanel.style.display = showing ? "none" : "block";
      settingsBtn.style.color = showing ? "" : "#e8eaed";
      if (!showing) {
        if (setApi) setApi.value = API_BASE;
        if (setBridge) setBridge.value = String(BRIDGE_PORT);
      }
    });
    setReset?.addEventListener("click", async (e) => {
      e.preventDefault();
      if (setApi) setApi.value = API_BASE_DEFAULT;
      if (setBridge) setBridge.value = String(BRIDGE_PORT_DEFAULT);
    });
    setSave?.addEventListener("click", async (e) => {
      e.preventDefault();
      const apiVal = (setApi?.value || "").trim() || API_BASE_DEFAULT;
      const bridgeVal = parseInt(setBridge?.value, 10) || BRIDGE_PORT_DEFAULT;
      if (!/^https?:\/\/.+:\d+$/.test(apiVal)) {
        flash(wrap.querySelector(`#${BTN_ID}`), "Invalid API URL (e.g. http://localhost:9555)", true);
        return;
      }
      if (bridgeVal < 1024 || bridgeVal > 65535) {
        flash(wrap.querySelector(`#${BTN_ID}`), "Bridge port must be 1024-65535", true);
        return;
      }
      await saveSettings(apiVal, bridgeVal);
      if (settingsPanel) settingsPanel.style.display = "none";
      if (settingsBtn) settingsBtn.style.color = "";
      // Re-check health with new API_BASE.
      await checkHealth();
      renderStatus();
      flash(wrap.querySelector(`#${BTN_ID}`), "Settings saved", false);
    });
    allBtn?.addEventListener("click", (e) => {
      e.preventDefault();
      for (const it of filteredPickerItems()) picker.selected.add(it.id);
      renderPickerList(wrap);
    });
    noneBtn?.addEventListener("click", (e) => {
      e.preventDefault();
      picker.selected.clear();
      renderPickerList(wrap);
    });
    cancelBtn?.addEventListener("click", (e) => {
      e.preventDefault();
      closePicker(wrap);
    });
    clearBtn?.addEventListener("click", async (e) => {
      e.preventDefault();
      if (picker.selected.size === 0) return;
      const chosen = picker.items.filter((it) => picker.selected.has(it.id));
      closePicker(wrap);
      const btn = wrap.querySelector(`#${BTN_ID}`);
      await clearAllNotifications(btn, chosen);
    });

    // Save current selection as a favorite.
    const saveFavBtn = wrap.querySelector(".gchat-pick-save-fav");
    saveFavBtn?.addEventListener("click", async (e) => {
      e.preventDefault();
      if (picker.selected.size === 0) return;
      const chosen = picker.items.filter((it) => picker.selected.has(it.id));
      const suggested = chosen.length === 1
        ? chosen[0].name
        : `${chosen.length} rooms`;
      const name = prompt("Name this favorite:", suggested);
      if (!name || !name.trim()) return;
      await addFavorite(name, chosen.map((c) => c.id));
      renderFavorites(wrap);
      flash(wrap.querySelector(`#${BTN_ID}`), `Saved "${name.trim()}"`, false);
    });

    // Click a favorite chip → clear its saved rooms. Delegated because chips
    // are re-rendered whenever favorites change.
    // Edit-mode banner: Save / Cancel.
    wrap.addEventListener("click", async (e) => {
      const saveBtn = e.target.closest(".gchat-edit-save");
      if (saveBtn) {
        e.preventDefault();
        const favId = picker.editingFavId;
        const fav = favorites.find((f) => f.id === favId);
        if (!fav) return exitEditMode(wrap);
        fav.itemIds = [...picker.selected];
        await persistFavorites();
        flash(wrap.querySelector(`#${BTN_ID}`), `Updated "${fav.name}" (${fav.itemIds.length})`, false);
        exitEditMode(wrap);
        return;
      }
      const cancelBtn = e.target.closest(".gchat-edit-cancel");
      if (cancelBtn) {
        e.preventDefault();
        exitEditMode(wrap);
      }
    });

    // Delegate favorites interactions at the wrap level so the popover
    // (which is a sibling of the strip) is also covered.
    wrap.addEventListener("click", async (e) => {
      // 1) Menu action inside the popover
      const act = e.target.closest(".gchat-fav-act");
      if (act) {
        e.preventDefault();
        e.stopPropagation();
        const popover = act.closest(".gchat-fav-popover");
        const favId = popover?.dataset.favId;
        const fav = favorites.find((f) => f.id === favId);
        closeFavMenu(wrap);
        if (!fav) return;
        const action = act.getAttribute("data-act");
        if (action === "run") {
          await runFavorite(wrap, fav);
        } else if (action === "edit") {
          await enterEditMode(wrap, fav);
        } else if (action === "rename") {
          const next = prompt("Rename favorite:", fav.name);
          if (next && next.trim() && next.trim() !== fav.name) {
            await renameFavorite(fav.id, next);
            renderFavorites(wrap);
          }
        } else if (action === "delete") {
          if (confirm(`Delete favorite "${fav.name}"?`)) {
            await removeFavorite(fav.id);
            renderFavorites(wrap);
          }
        }
        return;
      }
      // 2) Menu (⋮) button on a chip
      const menuBtn = e.target.closest(".gchat-fav-menu");
      if (menuBtn) {
        e.preventDefault();
        e.stopPropagation();
        openFavMenu(wrap, menuBtn.getAttribute("data-fav-id"), menuBtn);
        return;
      }
      // 3) Run button (chip name)
      const runBtn = e.target.closest(".gchat-fav-run");
      if (runBtn) {
        e.preventDefault();
        const fav = favorites.find((f) => f.id === runBtn.getAttribute("data-fav-id"));
        if (fav) await runFavorite(wrap, fav);
        return;
      }
    });

    // Outside click + Escape close the picker.
    picker.outsideClickHandler = (e) => {
      if (!wrap.contains(e.target)) closePicker(wrap);
    };
    picker.keydownHandler = (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      // Escape backs out of edit mode first, then closes menu, then picker.
      if (picker.editingFavId != null) return exitEditMode(wrap);
      if (wrap.querySelector(".gchat-fav-popover")) return closeFavMenu(wrap);
      closePicker(wrap);
    };
    document.addEventListener("mousedown", picker.outsideClickHandler, true);
    document.addEventListener("keydown", picker.keydownHandler, true);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;", "'":"&#39;" }[c]));
  }
  function escapeAttr(s) { return escapeHtml(s); }

  // Chevron icon for the split-button picker toggle.
  const ICON_CHEVRON = `
    <svg xmlns="http://www.w3.org/2000/svg" height="14" width="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M7 10l5 5 5-5H7z"/>
    </svg>`;
  const ICON_STAR = `
    <svg xmlns="http://www.w3.org/2000/svg" height="14" width="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/>
    </svg>`;

  // ── Button injection ───────────────────────────────────────────────────────
  // Full-width split button placed BELOW the "New chat" pill:
  //   [ • icon  Clear notifications        ][ ⌄ ]
  //   ↑ main action (clear all)              ↑ opens room picker
  function buildButton() {
    const wrap = document.createElement("div");
    wrap.id = WRAP_ID;
    wrap.style.cssText = `
      display:block;width:100%;box-sizing:border-box;
      padding:8px 12px 4px 12px;position:relative;
    `;

    // Split-button shell — visually one control, semantically two <button>s.
    const shell = document.createElement("div");
    shell.className = "gchat-btn-shell";
    shell.style.cssText = `
      display:flex;align-items:stretch;
      width:100%;box-sizing:border-box;
      border:1px solid rgba(255,255,255,0.08);border-radius:8px;
      background:transparent;color:#9aa0a6;
      font:500 14px/1.2 'Google Sans',Roboto,system-ui,sans-serif;
      position:relative;overflow:hidden;
      transition:background 120ms ease,color 120ms ease,border-color 120ms ease;
    `;
    const setHoverState = (on) => {
      if (btn.dataset.mode === "stop") return;
      shell.style.background   = on ? "rgba(255,255,255,0.06)" : "transparent";
      shell.style.color        = on ? "#e8eaed" : "#9aa0a6";
      shell.style.borderColor  = on ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.08)";
    };
    shell.addEventListener("mouseenter", () => setHoverState(true));
    shell.addEventListener("mouseleave", () => setHoverState(false));

    // Main action button: clear ALL unread. Icon + label.
    const btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.type = "button";
    btn.style.cssText = `
      flex:1 1 auto;display:flex;align-items:center;gap:10px;
      padding:10px 12px;
      background:transparent;color:inherit;border:none;
      font:inherit;cursor:pointer;
      min-width:0;
    `;
    btn.innerHTML = `
      <span class="gchat-status-dot" title="Checking server…" style="
        display:inline-flex;flex:0 0 auto;width:8px;height:8px;border-radius:50%;
        background:#9aa0a6;box-shadow:0 0 0 0 rgba(154,160,166,0.4);
        transition:background 200ms ease,box-shadow 200ms ease;
      "></span>
      <span class="gchat-icon" style="display:inline-flex;flex:0 0 auto;width:18px;height:18px;">${ICON_CLEAR}</span>
      <span class="gchat-label" style="flex:1 1 auto;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">Clear notifications</span>
    `;

    // Vertical divider factory
    const makeDivider = () => {
      const d = document.createElement("span");
      d.style.cssText = `
        flex:0 0 auto;width:1px;align-self:stretch;
        background:rgba(255,255,255,0.08);
      `;
      return d;
    };

    // Star button: opens the favorites-first mini panel.
    const starBtn = document.createElement("button");
    starBtn.className = "gchat-star";
    starBtn.type = "button";
    starBtn.setAttribute("aria-label", "Favorites");
    starBtn.setAttribute("title", "Favorites");
    starBtn.style.cssText = `
      flex:0 0 auto;display:flex;align-items:center;justify-content:center;
      padding:0 10px;background:transparent;color:inherit;border:none;
      cursor:pointer;
    `;
    starBtn.innerHTML = ICON_STAR;

    // Chevron button: opens the room picker dropdown.
    const chevBtn = document.createElement("button");
    chevBtn.className = "gchat-chev";
    chevBtn.type = "button";
    chevBtn.setAttribute("aria-label", "Clear specific rooms");
    chevBtn.setAttribute("title", "Clear specific rooms");
    chevBtn.style.cssText = `
      flex:0 0 auto;display:flex;align-items:center;justify-content:center;
      padding:0 10px;background:transparent;color:inherit;border:none;
      cursor:pointer;
    `;
    chevBtn.innerHTML = ICON_CHEVRON;

    // Progress bar underline (still under the whole shell)
    const bar = document.createElement("span");
    bar.className = "gchat-progress-bar";
    bar.style.cssText = `
      position:absolute;left:0;right:0;bottom:0;height:2px;width:0%;
      background:#8ab4f8;
      transition:width 120ms linear;pointer-events:none;
    `;

    shell.appendChild(btn);
    shell.appendChild(makeDivider());
    shell.appendChild(starBtn);
    shell.appendChild(makeDivider());
    shell.appendChild(chevBtn);
    shell.appendChild(bar);

    // ── Error panel (server down) ───────────────────────────────────────
    const errPanel = document.createElement("div");
    errPanel.className = "gchat-err-panel";
    errPanel.style.cssText = `
      display:none;margin:6px 0 0 0;padding:8px 10px;
      background:rgba(220,90,90,0.08);border:1px solid rgba(220,90,90,0.25);
      border-radius:6px;color:#f28b82;
      font:12px/1.4 'Google Sans',Roboto,system-ui,sans-serif;
    `;
    errPanel.innerHTML = `
      <div class="gchat-err-msg" style="margin-bottom:4px;font-weight:500;"></div>
      <div style="color:#c8b2b2;">
        Start the server with <code style="background:rgba(255,255,255,0.06);padding:1px 4px;border-radius:3px;">./start.sh</code>
        or see
        <a class="gchat-help-link" href="${README_URL}" target="_blank" rel="noopener noreferrer"
           style="color:#8ab4f8;text-decoration:underline;">troubleshooting</a>.
      </div>
      <div style="display:flex;gap:6px;margin-top:6px;">
        <button class="gchat-err-settings" type="button" style="
          background:transparent;border:1px solid rgba(255,255,255,0.15);color:#e8eaed;
          padding:4px 10px;border-radius:5px;cursor:pointer;
          font:12px 'Google Sans',Roboto,sans-serif;
          display:inline-flex;align-items:center;gap:5px;
        ">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96a7.03 7.03 0 0 0-1.62-.94l-.36-2.54A.5.5 0 0 0 13.87 2h-3.84a.5.5 0 0 0-.5.42l-.36 2.54a7.03 7.03 0 0 0-1.62.94l-2.39-.96a.5.5 0 0 0-.61.22L2.63 8.48a.5.5 0 0 0 .12.61l2.03 1.58c-.04.31-.06.63-.06.94 0 .31.02.63.06.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32a.5.5 0 0 0 .61.22l2.39-.96c.5.38 1.05.7 1.62.94l.36 2.54a.5.5 0 0 0 .5.42h3.84a.5.5 0 0 0 .5-.42l.36-2.54c.57-.24 1.11-.55 1.62-.94l2.39.96a.5.5 0 0 0 .61-.22l1.92-3.32a.5.5 0 0 0-.12-.61l-2.03-1.58zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z"/>
          </svg>
          Edit ports
        </button>
        <button class="gchat-err-retry" type="button" style="
          background:transparent;border:1px solid rgba(255,255,255,0.15);color:#e8eaed;
          padding:4px 10px;border-radius:5px;cursor:pointer;
          font:12px 'Google Sans',Roboto,sans-serif;
        ">Retry</button>
      </div>
    `;

    // ── Room picker dropdown panel ──────────────────────────────────────
    const panel = document.createElement("div");
    panel.className = "gchat-picker";
    panel.style.cssText = `
      display:none;margin:6px 0 0 0;
      background:#1f1f1f;border:1px solid rgba(255,255,255,0.10);border-radius:8px;
      color:#e8eaed;
      font:13px/1.3 'Google Sans',Roboto,system-ui,sans-serif;
      max-height:340px;overflow:hidden;
      box-shadow:0 6px 18px rgba(0,0,0,0.4);
    `;
    panel.innerHTML = `
      <div class="gchat-picker-hdr" style="
        display:flex;align-items:center;gap:8px;
        padding:8px 10px;border-bottom:1px solid rgba(255,255,255,0.08);
      ">
        <input class="gchat-picker-search" type="text" placeholder="Filter rooms…"
          style="
            flex:1 1 auto;padding:6px 8px;
            background:rgba(255,255,255,0.04);color:#e8eaed;
            border:1px solid rgba(255,255,255,0.08);border-radius:6px;
            font:inherit;outline:none;min-width:0;
          " />
        <button class="gchat-picker-refresh" type="button" title="Refresh rooms"
          style="
            flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;
            width:28px;height:28px;padding:0;
            background:transparent;color:#9aa0a6;
            border:1px solid rgba(255,255,255,0.08);border-radius:6px;cursor:pointer;
            transition:transform 400ms ease,color 120ms ease,background 120ms ease;
          ">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M17.65 6.35A7.958 7.958 0 0 0 12 4a8 8 0 1 0 7.75 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
          </svg>
        </button>
        <button class="gchat-picker-settings" type="button" title="Settings"
          style="
            flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;
            width:28px;height:28px;padding:0;
            background:transparent;color:#9aa0a6;
            border:1px solid rgba(255,255,255,0.08);border-radius:6px;cursor:pointer;
            transition:color 120ms ease,background 120ms ease;
          ">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96a7.03 7.03 0 0 0-1.62-.94l-.36-2.54A.5.5 0 0 0 13.87 2h-3.84a.5.5 0 0 0-.5.42l-.36 2.54a7.03 7.03 0 0 0-1.62.94l-2.39-.96a.5.5 0 0 0-.61.22L2.63 8.48a.5.5 0 0 0 .12.61l2.03 1.58c-.04.31-.06.63-.06.94 0 .31.02.63.06.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32a.5.5 0 0 0 .61.22l2.39-.96c.5.38 1.05.7 1.62.94l.36 2.54a.5.5 0 0 0 .5.42h3.84a.5.5 0 0 0 .5-.42l.36-2.54c.57-.24 1.11-.55 1.62-.94l2.39.96a.5.5 0 0 0 .61-.22l1.92-3.32a.5.5 0 0 0-.12-.61l-2.03-1.58zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z"/>
          </svg>
        </button>
        <span class="gchat-picker-count" style="flex:0 0 auto;color:#9aa0a6;font-size:12px;"></span>
      </div>
      <div class="gchat-settings-panel" style="
        display:none;padding:10px;border-bottom:1px solid rgba(255,255,255,0.08);
        background:rgba(255,255,255,0.02);
      ">
        <div style="display:flex;flex-direction:column;gap:8px;">
          <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:#9aa0a6;">
            <span style="flex:0 0 90px;">API URL</span>
            <input class="gchat-set-api" type="text" placeholder="${API_BASE_DEFAULT}"
              style="
                flex:1 1 auto;padding:5px 8px;
                background:rgba(255,255,255,0.04);color:#e8eaed;
                border:1px solid rgba(255,255,255,0.10);border-radius:5px;
                font:12px 'Google Sans',Roboto,monospace;outline:none;min-width:0;
              " />
          </label>
          <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:#9aa0a6;">
            <span style="flex:0 0 90px;">Bridge port</span>
            <input class="gchat-set-bridge" type="number" min="1024" max="65535" placeholder="${BRIDGE_PORT_DEFAULT}"
              style="
                flex:1 1 auto;padding:5px 8px;
                background:rgba(255,255,255,0.04);color:#e8eaed;
                border:1px solid rgba(255,255,255,0.10);border-radius:5px;
                font:12px 'Google Sans',Roboto,monospace;outline:none;min-width:0;
              " />
          </label>
          <div style="font-size:11px;color:#9aa0a6;line-height:1.4;">
            The local server must run on these ports. Re-run <code style="background:rgba(255,255,255,0.06);padding:1px 4px;border-radius:3px;">./install.sh</code> or set env vars if you change them.
          </div>
          <div style="display:flex;gap:6px;justify-content:flex-end;">
            <button class="gchat-set-reset" type="button" style="
              background:transparent;border:1px solid rgba(255,255,255,0.10);color:#9aa0a6;
              padding:4px 10px;border-radius:5px;cursor:pointer;font:12px 'Google Sans',Roboto,sans-serif;
            ">Reset</button>
            <button class="gchat-set-save" type="button" style="
              background:rgba(138,180,248,0.15);border:1px solid rgba(138,180,248,0.35);color:#8ab4f8;
              padding:4px 10px;border-radius:5px;cursor:pointer;font:500 12px 'Google Sans',Roboto,sans-serif;
            ">Save</button>
          </div>
        </div>
      </div>
      <div class="gchat-picker-mode" style="
        display:flex;gap:8px;padding:6px 10px;
        border-bottom:1px solid rgba(255,255,255,0.06);
        font-size:12px;align-items:center;
      ">
        <div class="gchat-mode-seg" role="tablist" style="
          display:inline-flex;background:rgba(255,255,255,0.04);
          border:1px solid rgba(255,255,255,0.08);border-radius:6px;overflow:hidden;
        ">
          <button class="gchat-mode-unread" type="button" role="tab" data-mode="unread" style="
            background:transparent;border:0;color:#9aa0a6;
            padding:3px 10px;cursor:pointer;font:inherit;
            display:inline-flex;align-items:center;gap:5px;
          ">Unread <span class="gchat-mode-unread-count" style="
            font-size:10px;color:#9aa0a6;background:rgba(255,255,255,0.06);
            padding:1px 5px;border-radius:8px;min-width:14px;text-align:center;
          "></span></button>
          <button class="gchat-mode-all" type="button" role="tab" data-mode="all" style="
            background:transparent;border:0;color:#9aa0a6;
            padding:3px 10px;cursor:pointer;font:inherit;
            border-left:1px solid rgba(255,255,255,0.08);
            display:inline-flex;align-items:center;gap:5px;
          ">All <span class="gchat-mode-all-count" style="
            font-size:10px;color:#9aa0a6;background:rgba(255,255,255,0.06);
            padding:1px 5px;border-radius:8px;min-width:14px;text-align:center;
          "></span></button>
        </div>
      </div>
      <div class="gchat-picker-type" style="
        display:flex;gap:8px;padding:6px 10px;
        border-bottom:1px solid rgba(255,255,255,0.06);
        font-size:12px;align-items:center;
      ">
        <div class="gchat-type-seg" role="tablist" style="
          display:inline-flex;background:rgba(255,255,255,0.04);
          border:1px solid rgba(255,255,255,0.08);border-radius:6px;overflow:hidden;
        ">
          <button class="gchat-type-all" type="button" role="tab" data-type="all" style="
            background:transparent;border:0;color:#9aa0a6;
            padding:3px 10px;cursor:pointer;font:inherit;
          ">All</button>
          <button class="gchat-type-dm" type="button" role="tab" data-type="dm" style="
            background:transparent;border:0;color:#9aa0a6;
            padding:3px 10px;cursor:pointer;font:inherit;
            border-left:1px solid rgba(255,255,255,0.08);
          ">DMs</button>
          <button class="gchat-type-space" type="button" role="tab" data-type="space" style="
            background:transparent;border:0;color:#9aa0a6;
            padding:3px 10px;cursor:pointer;font:inherit;
            border-left:1px solid rgba(255,255,255,0.08);
          ">Spaces</button>
        </div>
        <label class="gchat-hide-read-wrap" style="
          display:none;align-items:center;gap:5px;cursor:pointer;
          color:#9aa0a6;font-size:12px;user-select:none;margin-left:auto;
        ">
          <input class="gchat-hide-read" type="checkbox" style="accent-color:#8ab4f8;cursor:pointer;" />
          Hide read
        </label>
      </div>
      <div class="gchat-picker-favs" style="
        display:none;gap:6px;padding:6px 10px;flex-wrap:wrap;
        border-bottom:1px solid rgba(255,255,255,0.06);
        font-size:12px;align-items:center;
      "></div>
      <div class="gchat-picker-bulk" style="
        display:flex;gap:6px;padding:6px 10px;
        border-bottom:1px solid rgba(255,255,255,0.06);
        font-size:12px;align-items:center;
      ">
        <button class="gchat-pick-all" type="button"  style="
          background:transparent;border:1px solid rgba(255,255,255,0.10);color:#9aa0a6;
          padding:3px 8px;border-radius:4px;cursor:pointer;font:inherit;
        ">Select all</button>
        <button class="gchat-pick-none" type="button" style="
          background:transparent;border:1px solid rgba(255,255,255,0.10);color:#9aa0a6;
          padding:3px 8px;border-radius:4px;cursor:pointer;font:inherit;
        ">Clear</button>
        <span style="flex:1 1 auto;"></span>
        <button class="gchat-pick-save-fav" type="button" title="Save current selection as a favorite" disabled style="
          background:transparent;border:1px solid rgba(255,255,255,0.10);color:#9aa0a6;
          padding:3px 8px;border-radius:4px;cursor:pointer;font:inherit;
          display:inline-flex;align-items:center;gap:4px;opacity:0.5;
        ">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/>
          </svg>
          Save as favorite
        </button>
      </div>
      <div class="gchat-picker-list" style="
        max-height:220px;overflow-y:auto;padding:0;
      ">
        <div class="gchat-picker-empty" style="
          padding:16px;text-align:center;color:#9aa0a6;font-size:12px;
        ">Loading rooms…</div>
      </div>
      <div class="gchat-picker-ftr" style="
        display:flex;gap:8px;padding:8px 10px;
        border-top:1px solid rgba(255,255,255,0.08);
      ">
        <button class="gchat-pick-cancel" type="button" style="
          flex:1 1 auto;background:transparent;border:1px solid rgba(255,255,255,0.10);
          color:#9aa0a6;padding:6px 10px;border-radius:6px;cursor:pointer;font:inherit;
        ">Cancel</button>
        <button class="gchat-pick-clear" type="button" disabled style="
          flex:1 1 auto;background:rgba(138,180,248,0.15);
          border:1px solid rgba(138,180,248,0.35);
          color:#8ab4f8;padding:6px 10px;border-radius:6px;cursor:pointer;
          font:500 inherit;
        ">Clear selected</button>
      </div>
    `;

    // ── Toast tooltip below button ──────────────────────────────────────
    const tip = document.createElement("span");
    tip.className = "gchat-clear-tip";
    tip.style.cssText = `
      position:absolute;top:100%;left:12px;right:12px;margin-top:4px;
      padding:6px 10px;font:12px 'Google Sans',Roboto,sans-serif;
      background:#333;color:#eee;border-radius:6px;
      opacity:0;transition:opacity 200ms ease;
      pointer-events:none;text-align:center;z-index:1000;
    `;

    // ── Favorites-first mini panel ──────────────────────────────────────
    const favPanel = document.createElement("div");
    favPanel.className = "gchat-fav-panel";
    favPanel.style.cssText = `
      display:none;position:absolute;left:12px;right:12px;top:100%;margin-top:4px;
      background:#1f1f1f;border:1px solid rgba(255,255,255,0.10);border-radius:8px;
      color:#e8eaed;
      font:13px/1.3 'Google Sans',Roboto,system-ui,sans-serif;
      box-shadow:0 6px 18px rgba(0,0,0,0.4);
      z-index:999;
    `;
    // Body gets populated by renderFavPanel() when opened.
    favPanel.innerHTML = `
      <div class="gchat-fav-panel-body"></div>
      <div style="border-top:1px solid rgba(255,255,255,0.08);padding:4px 0;">
        <button class="gchat-fav-open-all" type="button" style="
          display:block;width:100%;text-align:left;
          background:transparent;border:0;color:#e8eaed;cursor:pointer;
          padding:8px 12px;font:inherit;
        ">All rooms…</button>
        <button class="gchat-fav-open-settings" type="button" style="
          display:block;width:100%;text-align:left;
          background:transparent;border:0;color:#e8eaed;cursor:pointer;
          padding:8px 12px;font:inherit;
        ">Settings…</button>
      </div>
    `;

    wrap.appendChild(shell);
    wrap.appendChild(errPanel);
    wrap.appendChild(panel);
    wrap.appendChild(favPanel);
    wrap.appendChild(tip);

    // Wire events
    btn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      handleClick(btn);
    });
    chevBtn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      togglePicker(wrap);
    });
    starBtn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      toggleFavPanel(wrap);
    });
    // "All rooms…" jumps from the mini panel into the full picker.
    favPanel.querySelector(".gchat-fav-open-all")?.addEventListener("click", (e) => {
      e.preventDefault();
      closeFavPanel(wrap);
      openPicker(wrap);
    });
    // "Settings…" opens the picker and immediately expands the settings section.
    favPanel.querySelector(".gchat-fav-open-settings")?.addEventListener("click", async (e) => {
      e.preventDefault();
      closeFavPanel(wrap);
      await openSettings(wrap);
    });
    // Error-panel Settings button: works even when server is unreachable.
    errPanel.querySelector(".gchat-err-settings")?.addEventListener("click", async (e) => {
      e.preventDefault();
      await openSettings(wrap, /*allowWhenDown*/ true);
    });
    // Error-panel Retry: force a health check right now.
    errPanel.querySelector(".gchat-err-retry")?.addEventListener("click", async (e) => {
      e.preventDefault();
      const rBtn = e.currentTarget;
      const orig = rBtn.textContent;
      rBtn.textContent = "Retrying…";
      rBtn.disabled = true;
      await checkHealth();
      renderStatus();
      rBtn.textContent = orig;
      rBtn.disabled = false;
    });

    return wrap;
  }

  // Open the picker + expand the settings section. When allowWhenDown is true,
  // bypass the "server not reachable" gate so the user can edit ports even
  // when the connection is failing.
  async function openSettings(wrap, allowWhenDown = false) {
    await openPickerFor(wrap, { allowWhenDown });
    const sp = wrap.querySelector(".gchat-settings-panel");
    const sb = wrap.querySelector(".gchat-picker-settings");
    const apiIn = wrap.querySelector(".gchat-set-api");
    const brIn  = wrap.querySelector(".gchat-set-bridge");
    if (sp) sp.style.display = "block";
    if (sb) sb.style.color = "#e8eaed";
    if (apiIn) apiIn.value = API_BASE;
    if (brIn) brIn.value = String(BRIDGE_PORT);
  }

  // Wrapper around openPicker that optionally allows opening when the server
  // is unreachable (for settings-editing purposes).
  async function openPickerFor(wrap, { allowWhenDown = false } = {}) {
    if (!allowWhenDown) return openPicker(wrap);
    if (health.connected !== false) return openPicker(wrap);
    // Bypass the down-gate: manually enter the "open picker but with an empty
    // list + hint" path. openPicker handles this via the health check inside.
    const prev = health.connected;
    health.connected = null; // treated as "unknown" so the gate passes
    try { await openPicker(wrap); }
    finally {
      health.connected = prev;
      // openPicker already set list to the "unreachable" message when it
      // saw connected===false, but our flip made it show "Loading rooms…".
      // Fix it up now.
      const list = wrap.querySelector(".gchat-picker-list");
      if (list && health.connected === false) {
        list.innerHTML = `<div class="gchat-picker-empty" style="padding:16px;text-align:center;color:#f28b82;font-size:12px;">Server unreachable — edit ports in Settings below.</div>`;
      }
    }
  }

  // ── Status dot rendering ───────────────────────────────────────────────────
  function renderStatus() {
    const wrap = document.getElementById(WRAP_ID);
    if (!wrap) return;
    const dot = wrap.querySelector(".gchat-status-dot");
    const shell = wrap.querySelector(".gchat-btn-shell");
    const btn = wrap.querySelector(`#${BTN_ID}`);
    const chev = wrap.querySelector(".gchat-chev");
    const errPanel = wrap.querySelector(".gchat-err-panel");
    const errMsg = wrap.querySelector(".gchat-err-msg");
    if (!dot || !btn) return;

    const setDisabled = (d) => {
      const cursor = d ? "not-allowed" : "pointer";
      const opacity = d ? "0.55" : "1";
      btn.disabled = d;
      if (chev) chev.disabled = d;
      btn.style.cursor = cursor;
      if (chev) chev.style.cursor = cursor;
      if (shell) shell.style.opacity = opacity;
    };

    // Always show the concrete ports so misconfiguration (e.g. stale storage
    // pointing at an old default like :7891) is immediately visible.
    const portInfo = `API ${API_BASE} · WS :${BRIDGE_PORT}`;
    if (health.connected === true) {
      dot.style.background = "#34a853"; // green
      dot.style.boxShadow = "0 0 0 3px rgba(52,168,83,0.15)";
      dot.title = `Server connected\n${portInfo}`;
      setDisabled(false);
      if (errPanel) errPanel.style.display = "none";
    } else if (health.connected === false) {
      dot.style.background = "#ea4335"; // red
      dot.style.boxShadow = "0 0 0 3px rgba(234,67,53,0.15)";
      dot.title = `${health.lastError || "Server not reachable"}\n${portInfo}`;
      if (!state.running) setDisabled(true);
      if (errPanel && errMsg) {
        errMsg.textContent = `${health.lastError || "Server not reachable"} (${portInfo})`;
        errPanel.style.display = "block";
      }
    } else {
      // Unknown / initial state
      dot.style.background = "#fbbc04"; // amber
      dot.style.boxShadow = "0 0 0 3px rgba(251,188,4,0.12)";
      dot.title = `Checking server…\n${portInfo}`;
      setDisabled(false);
      if (errPanel) errPanel.style.display = "none";
    }
  }

  let injectAttempts = 0;
  function tryInject() {
    if (document.getElementById(BTN_ID)) return true;
    injectAttempts++;
    const anchor = findNewChatWrapper();
    if (!anchor) {
      if (injectAttempts === 1 || injectAttempts % 25 === 0) {
        if (DEBUG) console.debug(`${LOG_PREFIX} anchor not found (attempt ${injectAttempts})`);
      }
      return false;
    }

    // We want the button as a FULL-WIDTH row below the New chat action bar.
    // The anchor is the wrapper containing the New chat button. Walk up until
    // we hit an element whose parent is either C-WIZ or is a vertical (block/
    // column) container — that's where we can safely insert our own row.
    let insertAfter = anchor;
    for (let i = 0; i < 4 && insertAfter?.parentElement; i++) {
      const p = insertAfter.parentElement;
      const cs = getComputedStyle(p);
      const dir = cs.flexDirection;
      // Parent is C-WIZ or is a vertical flex/block → good insertion point
      if (p.tagName === "C-WIZ" || cs.display === "block" || dir === "column") break;
      insertAfter = p;
    }
    if (!insertAfter?.parentElement) {
      if (DEBUG) console.debug(`${LOG_PREFIX} no valid parent to insert after`);
      return false;
    }

    const wrap = buildButton();
    insertAfter.parentElement.insertBefore(wrap, insertAfter.nextSibling);
    if (DEBUG) console.log(`${LOG_PREFIX} button injected after ${injectAttempts} attempt(s)`);
    // Kick off health polling now that the button is on the page.
    startHealthPolling();
    return true;
  }

  // ── Health polling ─────────────────────────────────────────────────────────
  let healthTimer = null;
  function startHealthPolling() {
    if (healthTimer) return;
    const tick = async () => {
      await checkHealth();
      renderStatus();
    };
    tick(); // first check immediately
    healthTimer = setInterval(tick, HEALTH_POLL_MS);
  }

  async function start() {
    // Load persisted settings (API_BASE, BRIDGE_PORT) before anything that
    // hits the local server, so the first health check uses correct values.
    await loadSettings();
    await loadFavorites();

    // Try immediately, then again via a MutationObserver + slow poll. Both
    // disconnect once the button is present so we don't stay attached to a
    // fast-mutating SPA subtree forever.
    if (tryInject()) return;

    const obs = new MutationObserver(() => {
      if (document.getElementById(BTN_ID)) {
        obs.disconnect();
        clearInterval(poll);
        return;
      }
      tryInject();
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });

    let ticks = 0;
    const poll = setInterval(() => {
      ticks++;
      if (document.getElementById(BTN_ID) || ticks > 60) {
        clearInterval(poll);
        obs.disconnect();
        return;
      }
      tryInject();
    }, 1000);
  }

  window.__gchatClear = {
    inject: tryInject,
    findAnchor: findNewChatWrapper,
    fetchUnread,
    state,
    picker,
    run: () => {
      const btn = document.getElementById(BTN_ID);
      if (btn) return clearAllNotifications(btn);
      console.warn(`${LOG_PREFIX} button not injected; try __gchatClear.inject()`);
    },
    openPicker: () => {
      const wrap = document.getElementById(WRAP_ID);
      if (wrap) openPicker(wrap);
    },
    stop: () => { state.cancelRequested = true; },
    ping: async () => {
      try {
        const r = await fetch(`${API_BASE}/api/notifications`);
        console.log(`${LOG_PREFIX} server ping: HTTP ${r.status}`);
        return r.ok;
      } catch (e) {
        console.error(`${LOG_PREFIX} server unreachable at ${API_BASE}:`, e.message);
        return false;
      }
    },
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
