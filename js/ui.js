/* ============================================================
   ui.js — DOM helpers, screens, sheets and toasts

   No framework and no template-string markup: everything is built with
   `el()`, the same helper Search and Go uses. It keeps the markup and the
   event wiring in one place and makes text injection impossible by default,
   because text always goes through textContent.
   ============================================================ */

/* ---------------------------------------------------------------
   Queries
   --------------------------------------------------------------- */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ---------------------------------------------------------------
   Element builder
   --------------------------------------------------------------- */

/**
 * el('div', { class: 'card', onclick: fn }, 'text', el('b', null, 'bold'))
 *
 * Recognised props:
 *   class / className   a class string
 *   text                textContent (never innerHTML)
 *   html                innerHTML, for the handful of places that need an
 *                       entity or a <br>; never pass user or file data here
 *   style               an object of camelCase style properties
 *   dataset             an object of data-* values
 *   on<event>           an event listener
 *   anything else       setAttribute, or a direct property for known ones
 *
 * Null and false children are skipped, so `cond && el(...)` reads cleanly.
 */
export function el(tag, props, ...children) {
  const node = document.createElement(tag);

  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;

      if (k === 'class' || k === 'className') { node.className = v; continue; }
      if (k === 'text') { node.textContent = v; continue; }
      if (k === 'html') { node.innerHTML = v; continue; }
      if (k === 'style' && typeof v === 'object') { Object.assign(node.style, v); continue; }
      if (k === 'dataset' && typeof v === 'object') { Object.assign(node.dataset, v); continue; }
      if (k.startsWith('on') && typeof v === 'function') { node.addEventListener(k.slice(2), v); continue; }
      if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') { node[k] = v; continue; }

      node.setAttribute(k, v === true ? '' : v);
    }
  }

  for (const c of children.flat(4)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }

  return node;
}

/** Replace a container's contents in one go. */
export function fill(node, ...children) {
  if (!node) return node;
  node.replaceChildren();
  for (const c of children.flat(4)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const show = (node, on = true) => { node?.classList.toggle('hidden', !on); };

/* ---------------------------------------------------------------
   Formatting
   --------------------------------------------------------------- */

const groups = new Intl.NumberFormat('en-GB');

/** Scores are the loudest thing on screen, so they always get separators. */
export const fmtScore = n => groups.format(Math.max(0, Math.round(Number(n) || 0)));

/** Compact form for tight chips: 1.2M, 340K. */
export function fmtShort(n) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  if (v >= 10_000_000) return `${Math.round(v / 1_000_000)}M`;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 100_000) return `${Math.round(v / 1000)}K`;
  if (v >= 10_000) return `${(v / 1000).toFixed(1)}K`;
  return groups.format(v);
}

/** Seconds as m:ss, for timers. */
export function fmtClock(seconds) {
  const s = Math.max(0, Math.ceil(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function fmtDate(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Milliseconds as "3h 12m", for the played-time stat. */
export function fmtDuration(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${total}s`;
}

/* ---------------------------------------------------------------
   Screens
   --------------------------------------------------------------- */

let currentScreen = null;

/**
 * Exactly one `.screen` is visible at a time. The table canvas is one of
 * them, and game.js pauses when it is not the current screen — a ball
 * must never drain while the player is reading their Collection.
 */
export function showScreen(name) {
  const target = $(`#screen-${name}`);
  if (!target) return currentScreen;

  for (const s of $$('.screen')) s.classList.toggle('active', s === target);
  for (const b of $$('.nav-btn')) b.classList.toggle('active', b.dataset.screen === name);

  currentScreen = name;
  document.body.dataset.screen = name;
  window.dispatchEvent(new CustomEvent('screenchange', { detail: { screen: name } }));
  return name;
}

export const screenName = () => currentScreen;

/* ---------------------------------------------------------------
   Sheets
   --------------------------------------------------------------- */

const sheetStack = [];

/**
 * Announce that something is covering the screen.
 *
 * The game listens for this and pauses. It has to be driven from here rather
 * than from each caller, because a sheet can be raised by the game itself in
 * the middle of a ball — a capture reveal, for instance — and every one of
 * those is a moment where the player is reading rather than playing. Leaving it
 * to callers is how the capture reveal came to sit over a live table and cost
 * people the ball they had just caught something with.
 */
/**
 * Confirm dialogs are counted separately from sheets.
 *
 * confirmSheet builds its own markup rather than going through openSheet, so it
 * never appears in `sheetStack`. Deriving `any` from the stack alone therefore
 * reported "nothing is open" while a confirm was on screen — so a confirm did
 * not pause the game, and closing one *resumed* a game that a sheet underneath
 * it had legitimately paused.
 */
let modalCount = 0;

function announceSheets(id, open) {
  window.dispatchEvent(new CustomEvent('sheetchange', {
    detail: {
      id,
      open,
      depth: sheetStack.length,
      any: sheetStack.length + modalCount > 0
    }
  }));
}

/** True while anything at all is covering the screen. */
export const anythingOpen = () => sheetStack.length + modalCount > 0;

export function openSheet(id) {
  const node = $(`#${id}`);
  if (!node) return;
  node.classList.remove('hidden');
  if (!sheetStack.includes(id)) sheetStack.push(id);
  document.body.classList.add('sheet-open');
  announceSheets(id, true);
}

export function closeSheet(id) {
  const node = id ? $(`#${id}`) : ($(`#${sheetStack[sheetStack.length - 1]}`) || null);
  if (!node) return;
  node.classList.add('hidden');
  const idx = sheetStack.indexOf(node.id);
  if (idx !== -1) sheetStack.splice(idx, 1);
  // Symmetrical with confirmSheet: a confirm can outlive the sheet it was
  // raised from, so the backdrop class must survive until nothing is left.
  if (!anythingOpen()) document.body.classList.remove('sheet-open');
  announceSheets(node.id, false);
}

export function closeAllSheets() {
  while (sheetStack.length) closeSheet(sheetStack[sheetStack.length - 1]);
}

export const sheetOpen = () => sheetStack.length > 0;

/**
 * One listener for every backdrop and close button, delegated from the
 * document so sheets built later still close.
 */
export function wireSheets() {
  document.addEventListener('click', e => {
    const closer = e.target.closest('[data-close]');
    if (closer) { closeSheet(closer.dataset.close || undefined); return; }
  });

  window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && sheetStack.length) { e.preventDefault(); closeSheet(); }
  });
}

/* ---------------------------------------------------------------
   Toasts
   --------------------------------------------------------------- */

let toastHost = null;

/**
 * Short, non-blocking messages. Capped at three on screen: during a busy
 * ball these can arrive faster than anyone can read them, and a tall stack
 * covers the table.
 */
export function toast(message, { kind = 'info', ms = 2200 } = {}) {
  if (!toastHost) {
    toastHost = $('#toasts') || document.body.appendChild(el('div', { id: 'toasts', class: 'toasts' }));
  }

  while (toastHost.children.length >= 3) toastHost.firstElementChild.remove();

  const node = el('div', { class: `toast ${kind}`, role: 'status', text: message });
  toastHost.append(node);

  requestAnimationFrame(() => node.classList.add('in'));
  setTimeout(() => {
    node.classList.remove('in');
    setTimeout(() => node.remove(), 260);
  }, ms);

  return node;
}

/* ---------------------------------------------------------------
   Confirm
   --------------------------------------------------------------- */

/**
 * A promise-based confirm built from our own markup, because the native
 * dialog blocks the render loop and looks wrong inside an installed app.
 */
export function confirmSheet({ title, body, confirm = 'OK', cancel = 'Cancel', danger = false }) {
  return new Promise(resolve => {
    const done = value => {
      wrap.remove();
      modalCount = Math.max(0, modalCount - 1);
      // Only clear the class if nothing is left underneath: a confirm can be
      // raised on top of a real sheet.
      if (!anythingOpen()) document.body.classList.remove('sheet-open');
      // Same announcement as a real sheet: this covers the screen too, and it
      // can be raised mid-ball.
      announceSheets('confirm', false);
      resolve(value);
    };

    const wrap = el('div', { class: 'modal-wrap' },
      el('div', { class: 'modal-backdrop', onclick: () => done(false) }),
      el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
        el('h3', { text: title }),
        body ? el('p', { class: 'muted small', text: body }) : null,
        el('div', { class: 'btn-row' },
          el('button', { class: 'btn ghost', text: cancel, onclick: () => done(false) }),
          el('button', { class: `btn ${danger ? 'danger' : 'primary'}`, text: confirm, onclick: () => done(true) })
        )
      )
    );

    document.body.append(wrap);
    modalCount++;
    document.body.classList.add('sheet-open');
    announceSheets('confirm', true);
  });
}

/* ---------------------------------------------------------------
   Haptics
   --------------------------------------------------------------- */

let hapticsOn = true;

export const setHaptics = on => { hapticsOn = !!on; };

/** Silently does nothing where the Vibration API is unsupported, e.g. iOS. */
export function buzz(pattern = 12) {
  if (!hapticsOn) return;
  try { navigator.vibrate?.(pattern); } catch { /* ignore */ }
}

/* ---------------------------------------------------------------
   Misc
   --------------------------------------------------------------- */

/** Wrap an <img> so a missing sprite falls back instead of showing a broken icon. */
export function sprite(src, { fallback = null, alt = '', cls = '' } = {}) {
  const img = el('img', { src, alt, class: cls, loading: 'lazy', decoding: 'async' });
  if (fallback) {
    img.addEventListener('error', () => { img.src = fallback; }, { once: true });
  }
  return img;
}

/** Runs `fn` on the next frame, coalescing repeat calls within that frame. */
export function nextFrame(fn) {
  let queued = false;
  return (...args) => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; fn(...args); });
  };
}
