/* ============================================================
   state.js — the save store

   Deliberately small. A game of pinball is three balls long and then it
   is over, so almost nothing survives it: the creatures you caught are
   part of the *run*, not the save. What persists is the Collection —
   which species you have registered, which you have caught shiny — plus
   high scores and settings.

   That is the same shape as the original games' Pokédex, and it is why
   there is no creature storage, no candy and no currency anywhere in
   this file.

   Run state lives in game.js and is thrown away on game over.
   ============================================================ */

import { Persist, progressOf } from './persist.js';
import { DB, TYPES, speciesById, effectiveRarityOf } from './data.js';

export const SAVE_VERSION = 1;

/** How many scores each mode's table remembers. */
export const HIGH_SCORES_KEEP = 8;

/** Autosave debounce. Long enough to coalesce a flurry of catches. */
const SAVE_DEBOUNCE_MS = 1_200;

/* ---------------------------------------------------------------
   Blank save
   --------------------------------------------------------------- */

/** One high score table per mode, keyed by type. */
function blankScores() {
  const o = {};
  for (const t of TYPES) o[t] = [];
  return o;
}

function blankStats() {
  return {
    games: 0,
    balls: 0,
    captures: 0,
    shinies: 0,
    evolutions: 0,
    bossWins: 0,
    encounters: 0,
    escapes: 0,
    bestMultiplier: 1,
    bestDiscTier: 0,
    totalScore: 0,
    playMs: 0
  };
}

export function blankSave() {
  return {
    version: SAVE_VERSION,
    createdAt: Date.now(),

    /* ---- the Collection ---- */
    registered: {},     // speciesId -> ms of first registration
    shinyCaught: {},     // speciesId -> true
    caughtCount: {},     // speciesId -> lifetime encounters won
    evolvedCount: {},    // speciesId -> times evolved *into* this form
    bossDefeated: {},    // type -> times beaten

    /* ---- scores ---- */
    highScores: blankScores(),
    best: { score: 0, type: null, at: 0 },

    stats: blankStats(),

    settings: {
      sound: true,
      haptics: true,
      motion: true,          // false mirrors prefers-reduced-motion
      flipperMode: 'halves', // 'halves' | 'buttons'
      leftHanded: false,
      showTrail: true
    },

    ui: {
      lastMode: 'Neutral',
      collectionType: 'Neutral',
      collectionShiny: false
    }
  };
}

/* ---------------------------------------------------------------
   Migration
   --------------------------------------------------------------- */

/**
 * Fold a loaded save onto a blank one so a save written by an older build
 * never arrives missing a key. Anything unrecognised is dropped rather
 * than carried forward.
 */
function migrate(raw) {
  const s = blankSave();
  if (!raw || typeof raw !== 'object') return s;

  s.createdAt = Number(raw.createdAt) || s.createdAt;

  const copyMap = (from, to, cast) => {
    if (!from || typeof from !== 'object') return;
    for (const [k, v] of Object.entries(from)) {
      const val = cast(v);
      if (val !== null) to[k] = val;
    }
  };

  copyMap(raw.registered, s.registered, v => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : Date.now(); });
  copyMap(raw.shinyCaught, s.shinyCaught, v => v ? true : null);
  copyMap(raw.caughtCount, s.caughtCount, v => { const n = Math.round(Number(v)); return Number.isFinite(n) && n > 0 ? n : null; });
  copyMap(raw.evolvedCount, s.evolvedCount, v => { const n = Math.round(Number(v)); return Number.isFinite(n) && n > 0 ? n : null; });
  copyMap(raw.bossDefeated, s.bossDefeated, v => { const n = Math.round(Number(v)); return Number.isFinite(n) && n > 0 ? n : null; });

  if (raw.highScores && typeof raw.highScores === 'object') {
    for (const t of TYPES) {
      const list = Array.isArray(raw.highScores[t]) ? raw.highScores[t] : [];
      s.highScores[t] = list
        .map(e => ({
          score: Math.max(0, Math.round(Number(e?.score) || 0)),
          at: Number(e?.at) || 0,
          caught: Math.max(0, Math.round(Number(e?.caught) || 0)),
          evolved: Math.max(0, Math.round(Number(e?.evolved) || 0)),
          bossWins: Math.max(0, Math.round(Number(e?.bossWins) || 0)),
          discTier: Math.max(0, Math.round(Number(e?.discTier) || 0))
        }))
        .filter(e => e.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, HIGH_SCORES_KEEP);
    }
  }

  if (raw.best && typeof raw.best === 'object') {
    s.best.score = Math.max(0, Math.round(Number(raw.best.score) || 0));
    s.best.type = TYPES.includes(raw.best.type) ? raw.best.type : null;
    s.best.at = Number(raw.best.at) || 0;
  }

  if (raw.stats && typeof raw.stats === 'object') {
    for (const k of Object.keys(s.stats)) {
      const n = Number(raw.stats[k]);
      if (Number.isFinite(n) && n >= 0) s.stats[k] = n;
    }
  }

  if (raw.settings && typeof raw.settings === 'object') {
    for (const k of Object.keys(s.settings)) {
      const v = raw.settings[k];
      if (typeof s.settings[k] === 'boolean' && typeof v === 'boolean') s.settings[k] = v;
      if (typeof s.settings[k] === 'string' && typeof v === 'string') s.settings[k] = v;
    }
    if (!['halves', 'buttons'].includes(s.settings.flipperMode)) s.settings.flipperMode = 'halves';
  }

  if (raw.ui && typeof raw.ui === 'object') {
    if (TYPES.includes(raw.ui.lastMode)) s.ui.lastMode = raw.ui.lastMode;
    if (TYPES.includes(raw.ui.collectionType)) s.ui.collectionType = raw.ui.collectionType;
    s.ui.collectionShiny = !!raw.ui.collectionShiny;
  }

  return s;
}

/* ---------------------------------------------------------------
   The store
   --------------------------------------------------------------- */

export const store = {
  s: blankSave(),
  loaded: false,
  loadSource: 'none',
  /** Set when the save could not be read but a snapshot with progress exists. */
  recoverable: null,
  readFailed: false,

  /** Fired after any change that a view might care about. */
  onChange: null,

  _timer: null,
  _dirty: false,

  /* ---------- lifecycle ---------- */

  async init() {
    await Persist.init();
    const { data, source, readFailed, recoverable } = await Persist.load();

    this.readFailed = !!readFailed;
    this.recoverable = recoverable || null;
    this.loadSource = source;

    // A failed read plus a recoverable snapshot means the save exists and we
    // could not see it. Starting fresh here is what would destroy it, so the
    // store stays blank and *unloaded* until main.js asks the player.
    if (!data && readFailed && recoverable) return this;

    this.s = migrate(data);
    this.loaded = true;
    return this;
  },

  /** Adopt a snapshot or an imported backup as the live save. */
  async adopt(raw, { force = true } = {}) {
    this.s = migrate(raw);
    this.loaded = true;
    await Persist.writeNow(this.s, { force });
    this._emit();
    return this.s;
  },

  /** Start fresh on purpose. `force` gets past the blank-save guard. */
  async startFresh() {
    this.s = blankSave();
    this.loaded = true;
    await Persist.writeNow(this.s, { force: true });
    this._emit();
    return this.s;
  },

  async reset() {
    await Persist.wipe();
    return this.startFresh();
  },

  /* ---------- saving ---------- */

  /**
   * Mark the save dirty. Debounced by default because a busy ball can fire
   * a dozen changes a second; `immediate` is for the moments that matter —
   * a capture, an evolution, game over.
   */
  touch({ immediate = false } = {}) {
    this._dirty = true;
    this._emit();

    if (immediate) return this.flush();

    if (!this._timer) {
      this._timer = setTimeout(() => { this._timer = null; this.flush(); }, SAVE_DEBOUNCE_MS);
    }
    return Promise.resolve(null);
  },

  async flush() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (!this._dirty || !this.loaded) return null;
    this._dirty = false;
    return Persist.writeNow(this.s);
  },

  _emit() { try { this.onChange?.(this.s); } catch { /* a broken view must not break a save */ } },

  progress() { return progressOf(this.s); },

  /* ---------- the Collection ---------- */

  isRegistered(id) { return !!this.s.registered[id]; },
  hasShiny(id) { return !!this.s.shinyCaught[id]; },
  timesCaught(id) { return this.s.caughtCount[id] || 0; },
  timesEvolved(id) { return this.s.evolvedCount[id] || 0; },

  /**
   * First registration wins the "NEW!" banner, so this returns true only
   * once per species for the lifetime of the save.
   */
  register(id) {
    if (!id || this.s.registered[id]) return false;
    this.s.registered[id] = Date.now();
    return true;
  },

  /**
   * Record a capture. Every route into the Collection funnels through here
   * — Encounter Mode, Evolution Mode and boss stages — so the counters can
   * never disagree with the dex.
   *
   * @returns {{isNew:boolean, isNewShiny:boolean}}
   */
  recordCapture(speciesId, { shiny = false, source = 'encounter' } = {}) {
    const sp = speciesById(speciesId);
    if (!sp) return { isNew: false, isNewShiny: false };

    const isNew = this.register(sp.id);
    this.s.caughtCount[sp.id] = (this.s.caughtCount[sp.id] || 0) + 1;

    let isNewShiny = false;
    if (shiny && !this.s.shinyCaught[sp.id]) {
      this.s.shinyCaught[sp.id] = true;
      isNewShiny = true;
    }
    if (shiny) this.s.stats.shinies++;

    this.s.stats.captures++;
    if (source === 'boss') this.s.stats.bossWins++;

    this.touch({ immediate: true });
    return { isNew, isNewShiny };
  },

  /**
   * Record an evolution. The evolved form registers, and a shiny stays shiny
   * through the line — which is the only way an evolved shiny ever enters
   * the Collection, since nothing above Stage 1 can be caught.
   */
  recordEvolution(toSpeciesId, { shiny = false } = {}) {
    const sp = speciesById(toSpeciesId);
    if (!sp) return { isNew: false, isNewShiny: false };

    const isNew = this.register(sp.id);
    this.s.evolvedCount[sp.id] = (this.s.evolvedCount[sp.id] || 0) + 1;
    this.s.stats.evolutions++;

    let isNewShiny = false;
    if (shiny && !this.s.shinyCaught[sp.id]) {
      this.s.shinyCaught[sp.id] = true;
      isNewShiny = true;
    }

    this.touch({ immediate: true });
    return { isNew, isNewShiny };
  },

  recordBossWin(type) {
    if (!TYPES.includes(type)) return;
    this.s.bossDefeated[type] = (this.s.bossDefeated[type] || 0) + 1;
    this.touch({ immediate: true });
  },

  bossWins(type) { return this.s.bossDefeated[type] || 0; },

  /* ---------- counts for the Collection header ---------- */

  registeredCount(type = null) {
    let n = 0;
    for (const sp of DB.species) {
      if (type && sp.type !== type) continue;
      if (this.s.registered[sp.id]) n++;
    }
    return n;
  },

  shinyCount(type = null) {
    let n = 0;
    for (const sp of DB.species) {
      if (type && sp.type !== type) continue;
      if (this.s.shinyCaught[sp.id]) n++;
    }
    return n;
  },

  speciesTotal(type = null) {
    return type ? DB.species.filter(s => s.type === type).length : DB.species.length;
  },

  /** 0..1 across the whole set, for the profile ring. */
  completion() {
    const total = DB.species.length || 1;
    return this.registeredCount() / total;
  },

  /* ---------- encounters that got away ---------- */

  noteEncounter() { this.s.stats.encounters++; this.touch(); },
  noteEscape() { this.s.stats.escapes++; this.touch(); },

  /* ---------- scores ---------- */

  /**
   * File a finished game. Returns the 1-based rank in that mode's table, or
   * null if it did not place, plus whether it is a new overall best.
   */
  endGame({ type, score, caught = 0, evolved = 0, bossWins = 0, discTier = 0, balls = 0, ms = 0, multiplier = 1 }) {
    const s = this.s;
    const clean = Math.max(0, Math.round(Number(score) || 0));

    s.stats.games++;
    s.stats.balls += Math.max(0, Math.round(balls));
    s.stats.totalScore += clean;
    s.stats.playMs += Math.max(0, Math.round(ms));
    s.stats.bestMultiplier = Math.max(s.stats.bestMultiplier, multiplier);
    s.stats.bestDiscTier = Math.max(s.stats.bestDiscTier, discTier);

    let rank = null;
    if (TYPES.includes(type) && clean > 0) {
      const list = s.highScores[type];
      const entry = { score: clean, at: Date.now(), caught, evolved, bossWins, discTier };
      list.push(entry);
      list.sort((a, b) => b.score - a.score);
      list.splice(HIGH_SCORES_KEEP);
      const idx = list.indexOf(entry);
      rank = idx === -1 ? null : idx + 1;
    }

    let isBest = false;
    if (clean > (s.best.score || 0)) {
      s.best = { score: clean, type: type || null, at: Date.now() };
      isBest = true;
    }

    this.touch({ immediate: true });
    return { rank, isBest };
  },

  highScores(type) { return (this.s.highScores[type] || []).slice(); },
  bestFor(type) { return this.s.highScores[type]?.[0]?.score || 0; },

  /* ---------- settings and ui ---------- */

  setting(key) { return this.s.settings[key]; },

  setSetting(key, value) {
    if (!(key in this.s.settings)) return;
    this.s.settings[key] = value;
    this.touch({ immediate: true });
  },

  setUi(key, value) {
    if (!(key in this.s.ui)) return;
    this.s.ui[key] = value;
    this.touch();
  },

  /* ---------- backups ---------- */

  download() { Persist.download(this.s); },
  async linkFile() { return Persist.linkFile(this.s); },

  /**
   * Rarity is only ever read through here so the "own rarity, else the
   * family root's" rule lives in one place.
   */
  rarityOf(id) { return effectiveRarityOf(speciesById(id)); }
};
