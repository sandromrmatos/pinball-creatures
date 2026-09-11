/* ============================================================
   main.js — boot and wiring

   Nothing in here decides anything. It loads the data, builds the
   objects, connects input to game.js and game.js's events to views.js,
   and runs the animation frame loop.

   Load order matters and is deliberate: the creature data has to be in
   place before a table can be built, and the save has to be read before
   the Collection can be drawn — so both are awaited on the boot screen
   rather than papered over with empty states.
   ============================================================ */

import { loadDatabase, DB, TYPES, MODES, DISC_TIERS, allSpritePaths } from './data.js';
import { store } from './state.js';
import { Persist } from './persist.js';
import { Renderer, preloadSprites } from './render.js';
import { Game, PHASE } from './game.js';
import { audio } from './audio.js';
import {
  $, $$, el, fill, show, fmtScore, fmtClock,
  showScreen, screenName, openSheet, closeSheet, closeAllSheets, sheetOpen,
  wireSheets, toast, confirmSheet, setHaptics, buzz
} from './ui.js';
import {
  renderCollection, renderScores, renderProfile, renderModePicker,
  renderShiftOffer, renderReveal, renderGameOver, renderGuide, openSpecies
} from './views.js';

/* ---------------------------------------------------------------
   Boot
   --------------------------------------------------------------- */

const boot = {
  msg: (text) => { const n = $('#boot-msg'); if (n) n.textContent = text; },
  fail: (text) => {
    const n = $('#boot-msg');
    if (n) { n.textContent = text; n.classList.add('boot-error'); }
    $('#boot')?.classList.add('failed');
  }
};

let renderer = null;
let game = null;

async function main() {
  /* ---- data ---- */
  boot.msg('Loading creature data\u2026');
  try {
    await loadDatabase();
  } catch (e) {
    boot.fail(`Could not load the creature data. ${e.message}`);
    return;
  }

  /* ---- save ---- */
  boot.msg('Reading your Collection\u2026');
  await store.init();

  if (!store.loaded) {
    // The save could not be read but a snapshot with progress exists. Starting
    // fresh here would put a blank account on top of real progress, so ask.
    const snap = store.recoverable;
    const useIt = await confirmSheet({
      title: 'Restore your Collection?',
      body: `Your save could not be read, but a backup from ${new Date(snap.savedAt).toLocaleString()} is here with ${snap.progress.registered} creatures registered.`,
      confirm: 'Restore it',
      cancel: 'Start fresh'
    });
    if (useIt) await store.adopt(snap.data);
    else await store.startFresh();
  }

  /* ---- settings take effect before anything is drawn or heard ---- */
  applySettings();

  /* ---- objects ---- */
  renderer = new Renderer($('#table')).resize();
  game = new Game({ onEvent: handleGameEvent, audio });

  wireSheets();
  wireNav();
  wireTableInput();
  wireWindow();

  renderCollection();
  renderScores();
  renderProfile();
  renderGuide();
  renderModePicker(type => startGame(type));

  /* ---- show the app ---- */
  $('#boot')?.classList.add('gone');
  $('#app')?.classList.remove('hidden');
  showScreen('table');
  requestAnimationFrame(frame);

  // An idle table behind the menu, so the game is never a blank rectangle.
  game.previewTable(store.s.ui.lastMode || 'Neutral');
  syncTable();
  renderer.resize();
  openSheet('sheet-mode');

  /* ---- sprites, in the background ---- */
  // Warmed after the app is interactive: a capture reveal that pops in blank
  // is worse than a slightly later warm-up.
  setTimeout(() => preloadSprites(allSpritePaths().slice(0, 40)), 1200);

  registerServiceWorker();
}

/* ---------------------------------------------------------------
   The loop
   --------------------------------------------------------------- */

let lastFrame = 0;

function frame(now) {
  requestAnimationFrame(frame);

  // Only the table screen animates. A ball must never drain while the player
  // is reading their Collection.
  const onTable = screenName() === 'table';
  if (!onTable) { lastFrame = now; return; }

  if (game.run && !game.paused) game.update(now);

  renderer.draw(game.run ? game.view() : { discTier: 0 });

  // The HUD is DOM, so it is refreshed at a human rate rather than every frame.
  if (now - lastFrame > 90) { lastFrame = now; updateHud(); }
}

/* ---------------------------------------------------------------
   HUD
   --------------------------------------------------------------- */

function updateHud() {
  const h = game.hud();
  const wrap = $('#hud');
  if (!wrap) return;

  show(wrap, !!h);
  if (!h) return;

  $('#hud-score').textContent = fmtScore(h.score);
  $('#hud-mode').textContent = h.mode.name;
  $('#hud-mode').style.color = h.mode.colour;
  $('#hud-ball').textContent = `Ball ${h.ballNumber}`;
  $('#hud-balls').textContent = '\u25cf'.repeat(Math.max(0, Math.min(6, h.ballsLeft)));
  $('#hud-mult').textContent = `\u00d7${Math.floor(h.multiplier)}`;
  $('#hud-disc').textContent = h.disc.short;
  $('#hud-disc').style.color = h.disc.colour;

  /* ---- CATCH and lane letters ---- */
  // During Evolution Mode the bank collects shards, so showing CATCH there is
  // worse than showing nothing: it tells the player to do the wrong thing.
  const shardMode = h.sub?.kind === 'evolution';
  if (shardMode) {
    const have = h.sub.shards;
    paintLetters('#hud-bank', '\u25c6'.repeat(h.sub.shardsNeeded),
                 Array.from({ length: h.sub.shardsNeeded }, (_, i) => i < have));
  } else {
    paintLetters('#hud-bank', 'CATCH', h.bank);
  }
  $('#hud-bank').classList.toggle('shards', shardMode);
  paintLetters('#hud-lanes', 'ABC', h.lanes);

  /* ---- what is armed ---- */
  const armed = $('#hud-armed');
  const armedText = h.armed.boss ? '\u2726 GATE OPEN \u2014 shoot the Well'
    : h.armed.evolution ? '\u21ba EVOLVE ready \u2014 shoot the Well'
    : h.armed.encounter ? '\u25c9 CATCH ready \u2014 shoot the Well'
    : '';
  armed.textContent = armedText;
  show(armed, !!armedText);

  /* ---- the mode banner ---- */
  const sub = $('#hud-sub');
  if (h.sub) {
    const s = h.sub;
    const label = s.kind === 'evolution'
      ? `Evolving \u00b7 ${s.shards}/${s.shardsNeeded} shards`
      : s.kind === 'boss'
        ? `${s.name}${s.shielded ? ' \u00b7 SHIELDED' : ''}`
        : `${s.name}${s.shiny ? ' \u2605' : ''}`;
    $('#hud-sub-label').textContent = label;
    $('#hud-sub-time').textContent = fmtClock(s.seconds);
    const frac = s.kind === 'evolution'
      ? s.shards / s.shardsNeeded
      : s.meterMax ? 1 - s.meter / s.meterMax : 0;
    $('#hud-sub-bar').style.width = `${Math.round(frac * 100)}%`;
    sub.classList.toggle('shielded', !!s.shielded);
    show(sub, true);
  } else {
    show(sub, false);
  }

  /* ---- ball save and tilt ---- */
  const save = $('#hud-save');
  show(save, h.ballSave > 0);
  if (h.ballSave > 0) save.textContent = `SAVE ${Math.ceil(h.ballSave)}`;

  const tilt = $('#hud-tilt');
  show(tilt, h.tilt > 0.05);
  tilt.textContent = h.tilted ? 'TILT' : 'careful\u2026';
  tilt.classList.toggle('tilted', h.tilted);

  /* ---- kickbacks ---- */
  $('#hud-kb-left').classList.toggle('on', h.kickback.left);
  $('#hud-kb-right').classList.toggle('on', h.kickback.right);
}

/** Paint a row of letter chips, lit where collected. */
function paintLetters(sel, letters, lit) {
  const host = $(sel);
  if (!host) return;
  const chars = [...letters];
  // Rebuilt when the count OR the glyphs change: the bank switches between
  // CATCH and three shard diamonds, and both are five-then-three characters,
  // so counting alone would leave the old letters in place.
  const current = [...host.children].map(n => n.textContent).join('');
  if (host.childElementCount !== chars.length || current !== letters) {
    fill(host, chars.map(ch => el('span', { class: 'letter', text: ch })));
  }
  [...host.children].forEach((node, i) => node.classList.toggle('on', !!lit[i]));
}

/* ---------------------------------------------------------------
   Game events
   --------------------------------------------------------------- */

function handleGameEvent(type, p) {
  switch (type) {
    case 'capture':
      buzz([18, 40, 18]);
      renderReveal('capture', p);
      renderCollection();
      break;

    case 'evolve':
      buzz([18, 40, 18]);
      renderReveal('evolve', p);
      renderCollection();
      break;

    case 'bossWin':
      buzz([30, 60, 30, 60, 30]);
      renderReveal('bossWin', p);
      renderCollection();
      renderProfile();
      break;

    case 'escape':
      toast(`${p.species.name} got away.`, { kind: 'bad' });
      break;

    case 'bossFled':
      toast(`${p.species.name} vanished.`, { kind: 'bad' });
      break;

    case 'evolutionFailed':
      toast('Evolution failed.', { kind: 'bad' });
      break;

    case 'armed':
      if (p.what === 'boss') toast('Awakening Gate open! Shoot the Well.', { kind: 'good', ms: 3200 });
      else if (p.what === 'evolution') toast('Evolution ready. Shoot the Well.', { kind: 'good' });
      else toast('Encounter ready. Shoot the Well.', { kind: 'good' });
      break;

    case 'discUpgrade':
      toast(`${p.disc.name}!`, { kind: 'good' });
      buzz(24);
      break;

    case 'evolutionStart':
      // Spelling out the two steps, because the mode reuses the drop target
      // bank and nothing else on the table explains that.
      toast(`Evolving ${p.from.name}: knock ${p.needed} targets, then hit it.`,
            { kind: 'good', ms: 4200 });
      break;

    case 'evolutionReady':
      toast('Shards ready \u2014 now hit the creature!', { kind: 'good', ms: 3200 });
      buzz(20);
      break;

    case 'extraBall':
      toast('Extra ball!', { kind: 'good', ms: 3000 });
      buzz([24, 50, 24]);
      break;

    case 'ballSave':
      toast('Ball saved.');
      break;

    /**
     * Announced rather than left to the HUD counter alone. It arrives at the
     * same moment as a capture or evolution reveal, which is exactly when the
     * player is not looking at the corner of the screen, and the whole value of
     * the save is knowing it is there.
     */
    case 'ballSaveGranted':
      toast(`Ball save \u00b7 ${Math.round(p.seconds)}s`, { kind: 'good' });
      break;

    case 'shinyBoost':
      toast('1,000,000 \u2014 shiny odds doubled.', { kind: 'good', ms: 3200 });
      break;

    case 'tilt':
      toast('TILT \u2014 flippers dead until the next ball.', { kind: 'bad', ms: 3000 });
      buzz([60, 40, 60]);
      break;

    case 'shiftCharged':
      toast('Table shift banked. Shoot the Well.', { kind: 'good' });
      break;

    case 'shiftOffer':
      // Pausing is handled by the sheetchange listener, which covers every
      // sheet including this one.
      renderShiftOffer(p, {
        onChoose: t => { game.chooseShift(t); syncTable(); },
        onDecline: () => game.declineShift()
      });
      break;

    case 'typeShift':
      syncTable();
      toast(`${p.mode.name}`, { kind: 'good' });
      break;

    case 'ballLost':
      buzz(40);
      break;

    case 'gameOver':
      renderScores();
      renderProfile();
      renderGameOver(p, {
        onAgain: t => startGame(t),
        onModes: () => { renderModePicker(t => startGame(t)); openSheet('sheet-mode'); }
      });
      renderGuide();      // the pool counts and boss names it quotes have moved on
      break;

    default:
      break;
  }
}

/** Point the renderer at whatever table the game is now using. */
function syncTable() {
  renderer.setTable({ world: game.world, parts: game.parts, mode: game.mode });
  document.body.dataset.mode = game.mode.type;
}

/* ---------------------------------------------------------------
   Starting a game
   --------------------------------------------------------------- */

function startGame(type) {
  closeAllSheets();
  audio.unlock();
  game.start(TYPES.includes(type) ? type : 'Neutral');
  syncTable();
  showScreen('table');
  updateHud();
}

/* ---------------------------------------------------------------
   Navigation
   --------------------------------------------------------------- */

function wireNav() {
  for (const btn of $$('.nav-btn')) {
    btn.addEventListener('click', () => {
      audio.unlock();
      audio.play('tap');
      const name = btn.dataset.screen;
      showScreen(name);
      if (name === 'collection') renderCollection();
      if (name === 'scores') renderScores();
      if (name === 'profile') renderProfile();
      if (name === 'guide') renderGuide();
    });
  }

  $('#btn-modes')?.addEventListener('click', async () => {
    if (game.run && game.phase !== PHASE.GAME_OVER) {
      const ok = await confirmSheet({
        title: 'Leave this game?',
        body: 'The ball, the score and anything caught this game are lost. Your Collection is not.',
        confirm: 'Leave',
        danger: true
      });
      if (!ok) return;
      game.abandon();
    }
    renderModePicker(t => startGame(t));
    openSheet('sheet-mode');
  });

  /* The game pauses whenever the table is not the screen you are looking at. */
  window.addEventListener('screenchange', e => {
    if (!game) return;
    if (e.detail.screen === 'table' && !sheetOpen()) game.resume();
    else game.pause();
  });

  /**
   * And whenever anything is covering the table.
   *
   * This is the important one. The game raises sheets itself mid-ball — a
   * capture reveal, an evolution, a boss win, the shift offer — and the ball
   * used to carry on behind them. Reading the reveal of a creature you had just
   * caught could cost you the ball you caught it with.
   *
   * Handled here in one place rather than at each call site so a sheet added
   * later cannot forget to do it.
   */
  window.addEventListener('sheetchange', e => {
    if (!game) return;
    if (e.detail.any) game.pause();
    else if (screenName() === 'table') game.resume();
  });

  window.addEventListener('settingchange', () => applySettings());
}

/**
 * Push the saved settings into the things that act on them.
 *
 * One function called both at boot and on every change, rather than each
 * setting being applied where it is toggled — otherwise a setting works after
 * you change it but not when the app is reopened, which is the classic way
 * this breaks.
 */
function applySettings() {
  audio.setEnabled(!!store.setting('sound'));
  setHaptics(!!store.setting('haptics'));
  if (renderer) renderer.effects = store.setting('motion') !== false;
  // The on-screen flipper buttons are shown by CSS off this attribute.
  document.body.dataset.flippers = store.setting('flipperMode') || 'halves';
}

/* ---------------------------------------------------------------
   Table input
   --------------------------------------------------------------- */

/**
 * Multi-touch, and the rules are simple by necessity — a thumb is not a mouse.
 *
 *   • Left half / right half of the canvas works that flipper. Every finger
 *     is tracked separately so both flippers can be held at once, which is
 *     not optional on a pinball table.
 *   • Before launch, any touch winds the plunger and letting go fires it.
 *   • A quick sideways drag nudges. It has to be a real drag, or every
 *     slightly imprecise flipper tap would shove the table.
 *
 * Keyboard is wired too, because it makes the game testable on a desktop.
 */
function wireTableInput() {
  const surface = $('#table-wrap');
  if (!surface) return;

  /** touchId -> { side, startX, startY, startT, nudged } */
  const touches = new Map();

  const NUDGE_DISTANCE = 34;      // CSS px of sideways travel to count as a shove
  const NUDGE_MAX_MS = 320;       // and it has to be quick

  const sideFor = clientX => {
    const rect = surface.getBoundingClientRect();
    const left = clientX - rect.left < rect.width / 2;
    const swap = !!store.setting('leftHanded');
    return (left !== swap) ? 'left' : 'right';
  };

  /**
   * Is this touch on a control rather than on the playfield?
   *
   * The HUD sits inside #table-wrap, so a tap on one of its buttons also
   * reaches this handler — which flipped, plunged, and called preventDefault(),
   * killing the click before the button ever saw it. The buttons were
   * effectively untappable on a touchscreen.
   *
   * The on-screen flipper buttons are matched too; they have their own
   * listeners, so letting this handler also fire would flip twice.
   */
  const onControl = target =>
    !!(target instanceof Element) && !!target.closest('button, a, input, select, [data-flip]');

  const down = (id, x, y) => {
    audio.unlock();
    if (!game.run) return;

    if (game.phase === PHASE.PLUNGE) {
      game.plungeStart();
      touches.set(id, { side: null, startX: x, startY: y, startT: performance.now(), nudged: false });
      return;
    }

    const side = sideFor(x);
    touches.set(id, { side, startX: x, startY: y, startT: performance.now(), nudged: false });
    game.flip(side, true);
  };

  const move = (id, x, y) => {
    const t = touches.get(id);
    if (!t || t.nudged) return;

    const dx = x - t.startX;
    const dt = performance.now() - t.startT;
    if (Math.abs(dx) >= NUDGE_DISTANCE && dt <= NUDGE_MAX_MS) {
      t.nudged = true;
      game.nudge(Math.sign(dx) * -1);       // shoving right moves the ball left
    }
  };

  const up = id => {
    const t = touches.get(id);
    if (!t) return;
    touches.delete(id);

    if (game.phase === PHASE.PLUNGE) { game.plungeRelease(); return; }
    if (t.side) {
      // Only release the flipper if no other finger is still holding that side.
      const stillHeld = [...touches.values()].some(o => o.side === t.side);
      if (!stillHeld) game.flip(t.side, false);
    }
  };

  /* ---- touch ---- */
  surface.addEventListener('touchstart', e => {
    if (onControl(e.target)) return;      // let the button have it
    e.preventDefault();
    for (const t of e.changedTouches) down(t.identifier, t.clientX, t.clientY);
  }, { passive: false });

  surface.addEventListener('touchmove', e => {
    for (const t of e.changedTouches) move(t.identifier, t.clientX, t.clientY);
  }, { passive: true });

  const endTouch = e => {
    for (const t of e.changedTouches) up(t.identifier);
  };
  surface.addEventListener('touchend', endTouch, { passive: true });
  surface.addEventListener('touchcancel', endTouch, { passive: true });

  /* ---- mouse, for desktop ---- */
  surface.addEventListener('mousedown', e => {
    if (onControl(e.target)) return;
    e.preventDefault();
    down('mouse', e.clientX, e.clientY);
  });
  window.addEventListener('mousemove', e => move('mouse', e.clientX, e.clientY));
  window.addEventListener('mouseup', () => up('mouse'));

  /* ---- on-screen buttons, for players who prefer them ---- */
  for (const btn of $$('[data-flip]')) {
    const side = btn.dataset.flip;
    const press = e => { e.preventDefault(); audio.unlock(); game.flip(side, true); };
    const release = () => game.flip(side, false);
    btn.addEventListener('touchstart', press, { passive: false });
    btn.addEventListener('touchend', release, { passive: true });
    btn.addEventListener('mousedown', press);
    btn.addEventListener('mouseup', release);
    btn.addEventListener('mouseleave', release);
  }

  /* ---- keyboard ---- */
  const keySide = e => {
    if (e.code === 'ArrowLeft' || e.code === 'KeyZ') return 'left';
    if (e.code === 'ArrowRight' || e.code === 'KeyM') return 'right';
    return null;
  };

  window.addEventListener('keydown', e => {
    if (sheetOpen() || screenName() !== 'table') return;
    audio.unlock();

    const side = keySide(e);
    if (side) { e.preventDefault(); game.flip(side, true); return; }

    if (e.code === 'Space' || e.code === 'ArrowDown') {
      e.preventDefault();
      if (game.phase === PHASE.PLUNGE) game.plungeStart();
      return;
    }
    if (e.code === 'KeyN') { e.preventDefault(); game.nudge(-1); }
    if (e.code === 'KeyB') { e.preventDefault(); game.nudge(1); }
  });

  window.addEventListener('keyup', e => {
    const side = keySide(e);
    if (side) { game.flip(side, false); return; }
    if ((e.code === 'Space' || e.code === 'ArrowDown') && game.phase === PHASE.PLUNGE) {
      game.plungeRelease();
    }
  });
}

/* ---------------------------------------------------------------
   Window plumbing
   --------------------------------------------------------------- */

function wireWindow() {
  const resize = () => renderer?.resize();
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 250));

  /* Leaving the app pauses it and flushes the save. A backgrounded tab gets
     no frames anyway, and coming back to a drained ball would be unfair. */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      game?.pause();
      audio.suspend();
      store.flush();
    } else if (screenName() === 'table') {
      game?.resume();
      audio.resume();
    }
  });

  window.addEventListener('pagehide', () => store.flush());

  /* Android's back gesture should close a sheet before it leaves the game. */
  window.addEventListener('popstate', () => {
    if (sheetOpen()) { closeSheet(); history.pushState(null, '', location.href); }
  });
  history.pushState(null, '', location.href);
}

/* ---------------------------------------------------------------
   Service worker
   --------------------------------------------------------------- */

/**
 * Registered after boot, never before: a service worker install competes for
 * bandwidth with the data the boot screen is waiting on.
 */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol === 'file:') return;      // never available from file://

  navigator.serviceWorker.register('sw.js').then(reg => {
    reg.addEventListener('updatefound', () => {
      const fresh = reg.installing;
      fresh?.addEventListener('statechange', () => {
        if (fresh.state === 'installed' && navigator.serviceWorker.controller) {
          toast('Update ready. Reopen the game to use it.', { ms: 4000 });
        }
      });
    });
  }).catch(() => {
    // Offline play is a bonus, not a requirement to get going.
  });
}

/* ---------------------------------------------------------------
   Go
   --------------------------------------------------------------- */

main().catch(e => {
  console.error(e);
  boot.fail(`Something went wrong starting up. ${e.message}`);
});
