/* ============================================================
   data.js — creature data and every tuning table

   Pure data and maths. This module imports nothing from the rest of
   the game, which is deliberate: every number worth re-balancing lives
   here, so tuning the game means editing one file.

   Two CSVs are joined on `id_output`, exactly as Search and Go does it:
     • Elemental Awakening Creatures.csv                 — species, images, rarity, evolutions
     • Elemental Awakening Creatures Stats and Moves.csv  — stats and learnsets

   The stats file is only used for flavour on the Collection sheet. There
   is no battling here, so nothing in the physics or scoring reads it.
   ============================================================ */

export const CSV_FILE = 'Elemental Awakening Creatures.csv';
export const STATS_CSV_FILE = 'Elemental Awakening Creatures Stats and Moves.csv';
export const SET_NAME = 'Elemental Awakening';

export const IMAGE_DIR = 'images';
export const SHINY_DIR = 'shiny';

/* ---------------------------------------------------------------
   Types and modes
   --------------------------------------------------------------- */

/**
 * The five types, in the order the mode carousel shows them. Neutral
 * leads because it is the gentlest table and has the shallowest rarity
 * curve — six of its ten catchables are Common.
 */
export const TYPES = ['Neutral', 'Mystic', 'Wind', 'Celestial', 'Mechanic'];

/**
 * Pokémon Pinball changed which creatures you could catch by travelling
 * between map areas. Here the type *is* the area: one mode per type, each
 * with its own catch pool, palette and centre gimmick.
 *
 * `gimmick` names the centre-section behaviour that table.js builds. The
 * geometry around it — flippers, drain, outlanes, slingshots, bumpers,
 * targets, ramps, the saucer — is shared by all five, so the flipper feel
 * is tuned once and never drifts between modes.
 *
 * `colour` is the mode's identity, used by both the canvas renderer and
 * the CSS (mirrored as --t-<type> in styles.css). `ink` is what stays
 * legible printed on top of `colour`.
 */
export const MODES = {
  Neutral: {
    type: 'Neutral',
    name: 'Wildwood Green',
    blurb: 'Open and forgiving. The widest common pool in the game.',
    gimmick: 'herd',
    colour: '#a8b0c8',
    deep: '#2b3350',
    ink: '#0b1024'
  },
  Mystic: {
    type: 'Mystic',
    name: 'Rune Sanctum',
    blurb: 'A full orbit loop. Keep the rune disc spinning for multipliers.',
    gimmick: 'orbit',
    colour: '#b07cff',
    deep: '#2f1d55',
    ink: '#0b1024'
  },
  Wind: {
    type: 'Wind',
    name: 'Gale Spire',
    blurb: 'Updraughts lift the ball. Fast, loose and hard to control.',
    gimmick: 'updraft',
    colour: '#56d2f0',
    deep: '#123c4d',
    ink: '#0b1024'
  },
  Celestial: {
    type: 'Celestial',
    name: 'Starbloom Grove',
    blurb: 'Vines grow across the lanes. Break them before they close.',
    gimmick: 'bloom',
    colour: '#4ade80',
    deep: '#14432a',
    ink: '#0b1024'
  },
  Mechanic: {
    type: 'Mechanic',
    name: 'Cogwork Foundry',
    blurb: 'Two live gears fling the ball. The most violent table here.',
    gimmick: 'gears',
    colour: '#ffb865',
    deep: '#4a2f10',
    ink: '#0b1024'
  }
};

/* The key is what matches a species' `Type` column, so finaliseModes()
   stamps `type` from the key at load time rather than trusting the literal
   above — a typo there would silently empty a mode's catch pool. */

/* ---------------------------------------------------------------
   Rarity
   --------------------------------------------------------------- */

export const RARITY_NAMES = { 1: 'Common', 2: 'Uncommon', 3: 'Rare', 4: 'Epic', 5: 'Legendary' };

/**
 * Encounter weights. Rarity 5 is absent on purpose: a legendary is never
 * rolled, it is the mode's boss and the Awakening Gate is the only way to
 * meet one. Weights are the same shape as Search and Go's so the two games
 * feel consistent, minus that fifth entry.
 */
export const RARITY_WEIGHTS = { 1: 60, 2: 28, 3: 8, 4: 3 };

/**
 * Two of the five types have no rarity 5 in the CSV, so two modes would
 * have had no boss. Rather than edit the shared CSV — Search and Go reads
 * the same file and a rarity change there would move these creatures out
 * of its spawn pools — the promotion lives here, in a table only this game
 * reads.
 *
 * A promoted creature is pulled out of its type's ordinary encounter pool
 * by buildPools(), so it cannot be both the boss and a routine catch.
 */
export const BOSS_OVERRIDES = {
  Neutral: 'Alpakina',
  Celestial: 'Verdanthorn'
};

/** Shiny rate, matching Search and Go's baseline wild odds. */
export const SHINY_ODDS = 0.01;

/**
 * Past this score the shiny rate doubles for the rest of the game.
 *
 * A reward for a long game rather than for grinding short ones. A million is
 * reachable but not routine — it sits between the first extra ball at 500k and
 * the second at 1.5m, so it lands in the middle of a good run rather than at
 * the end of it, and there is still most of a game left to spend it.
 *
 * It is checked against the live score, so it also applies to a boss, whose
 * odds are already doubled and therefore become four times baseline.
 */
export const SHINY_DOUBLE_AT = 1_000_000;

/* ---------------------------------------------------------------
   Discs — the ball tiers
   --------------------------------------------------------------- */

/**
 * The ball is a capture disc, and completing the target bank upgrades it.
 * `power` is how much of a capture meter one hit removes, which is the
 * whole point of upgrading: an Epic needs six ordinary hits or two Master
 * ones. `score` multiplies everything the ball earns.
 *
 * Names follow Search and Go's items so the two games share a vocabulary.
 */
export const DISC_TIERS = [
  { id: 'disc',   name: 'Capture Disc', short: 'Disc',   power: 1,   score: 1,   colour: '#e8ecff', rim: '#98a3c8' },
  { id: 'great',  name: 'Great Disc',   short: 'Great',  power: 1.5, score: 1.5, colour: '#7fd4ff', rim: '#2f8fc7' },
  { id: 'ultra',  name: 'Ultra Disc',   short: 'Ultra',  power: 2,   score: 2,   colour: '#ffd76a', rim: '#c48f18' },
  { id: 'master', name: 'Master Disc',  short: 'Master', power: 3,   score: 3,   colour: '#d7a4ff', rim: '#8b4fd0' }
];

export const MAX_DISC_TIER = DISC_TIERS.length - 1;

/* ---------------------------------------------------------------
   Run structure
   --------------------------------------------------------------- */

/** Three balls, then the game is over and the next one starts fresh. */
export const BALLS_PER_GAME = 3;

/** Seconds of ball save at the start of every ball. */
export const BALL_SAVE_SECONDS = 8;

/**
 * Seconds of ball save granted the moment a capture or an evolution lands.
 *
 * Finishing one of those is the biggest reward in the game and it always ends
 * with the ball loose in the middle of the table, moving fast, with a reveal
 * on screen — which is the worst possible moment to have to defend a drain.
 * Losing the ball to the thing you just earned reads as a punishment for
 * succeeding.
 *
 * Longer than the per-ball save because it has to cover reading the reveal as
 * well as recovering the ball.
 */
export const CAPTURE_BALL_SAVE_SECONDS = 10;

/** Score thresholds that award an extra ball, each awarded once per game. */
export const EXTRA_BALL_AT = [500_000, 1_500_000, 4_000_000];

/** Catches needed in one game before the Awakening Gate opens. */
export const GATE_CATCHES_NEEDED = 3;

/* ---------------------------------------------------------------
   Encounter Mode
   --------------------------------------------------------------- */

/**
 * Capture meter size by rarity — how much "damage" a creature soaks before
 * it is caught. Read together with DISC_TIERS.power: a Common falls to
 * three ordinary hits, an Epic to six, a Legendary to ten.
 */
export const CAPTURE_METER = { 1: 3, 2: 4, 3: 5, 4: 6, 5: 10 };

/** Seconds on the clock, by rarity. Rarer creatures are given a little longer. */
export const CAPTURE_SECONDS = { 1: 30, 2: 32, 3: 35, 4: 40, 5: 75 };

/**
 * How fast the creature drifts around the upper field while you are trying
 * to hit it, in table units per second. Rarer means harder to corner.
 */
export const CAPTURE_DRIFT = { 1: 26, 2: 34, 3: 44, 4: 56, 5: 70 };

/* ---------------------------------------------------------------
   Evolution Mode
   --------------------------------------------------------------- */

/**
 * Evolution is a mode you play, not a cost you pay. The original games
 * had you gather evolution items on the table and then strike the creature,
 * and that is what happens here: no candy, no currency, and it only ever
 * applies to something caught in the game you are playing.
 */
export const EVOLUTION_SHARDS = 3;
export const EVOLUTION_SECONDS = 45;
export const EVOLUTION_METER = 3;

/* ---------------------------------------------------------------
   Boss stages
   --------------------------------------------------------------- */

/** Seconds to break a legendary before it leaves. */
export const BOSS_SECONDS = 75;

/**
 * A boss raises a shield between hits. You have to keep the ball moving
 * rather than settling into one safe shot, which is the whole idea.
 */
export const BOSS_SHIELD_SECONDS = 2.2;

/* ---------------------------------------------------------------
   Scoring
   --------------------------------------------------------------- */

/**
 * Base values, before the disc multiplier and the mode multiplier. Tuned so
 * a competent three-ball game lands in the low millions and the extra-ball
 * thresholds above are reachable but not routine.
 */
export const SCORE = {
  bumper: 120,
  slingshot: 60,
  spinner: 90,
  dropTarget: 750,
  bankComplete: 6_000,
  lane: 400,
  laneSetComplete: 4_000,
  ramp: 1_500,
  rampLoop: 3_500,
  saucer: 2_500,
  discUpgrade: 5_000,
  gimmick: 800,
  captureHit: 1_200,
  captureRarity: { 1: 12_000, 2: 25_000, 3: 50_000, 4: 90_000, 5: 400_000 },
  captureShinyBonus: 100_000,
  captureNewBonus: 20_000,
  evolveShard: 2_000,
  evolveSuccess: 40_000,
  gateOpen: 10_000,
  bossHit: 8_000,
  ballSaveUsed: 0,
  typeShift: 1_500
};

/** Score multiplier ceiling. Bumpers and the spinner step it up. */
export const MAX_MULTIPLIER = 8;

/* ---------------------------------------------------------------
   Small helpers
   --------------------------------------------------------------- */

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const chance = p => Math.random() < p;
export const randRange = (lo, hi) => lo + Math.random() * (hi - lo);
export const pick = arr => arr.length ? arr[Math.floor(Math.random() * arr.length)] : null;

/** Blank, '-' and non-numeric all collapse to null so callers can use `||`. */
const num = v => {
  const s = String(v ?? '').trim();
  if (!s || s === '-') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

const int = v => { const n = num(v); return n === null ? null : Math.round(n); };

/** "Stage 2" → 2. Anything unreadable is treated as a first stage. */
const stageNumber = v => {
  const m = String(v ?? '').match(/(\d+)/);
  return m ? Number(m[1]) : 1;
};

/** `Evolves to` may hold more than one target, separated by commas or "or". */
const splitList = v => String(v ?? '')
  .split(/\s*(?:,|\/|\bor\b)\s*/i)
  .map(s => s.trim())
  .filter(Boolean);

/* ---------------------------------------------------------------
   CSV
   --------------------------------------------------------------- */

/**
 * A small RFC 4180 state machine: double-quoted fields, "" escapes,
 * embedded commas and newlines, CRLF, and a UTF-8 BOM. Ported from
 * Search and Go so both games read the same files identically.
 */
export function parseCSV(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }

    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    if (c === '\r') continue;
    field += c;
  }

  row.push(field);
  rows.push(row);

  // Trailing newlines and spacer rows would otherwise become empty species.
  return rows.filter(r => r.some(v => String(v).trim() !== ''));
}

/**
 * Row 0 is the header. Names are trimmed and lower-cased so every lookup
 * in this file can be written as `r['id_output']` regardless of how the
 * spreadsheet capitalised things.
 */
function toRecords(rows) {
  if (!rows.length) return [];
  const head = rows[0].map(h => String(h).trim().toLowerCase());
  return rows.slice(1).map(r => {
    const o = {};
    head.forEach((h, i) => { o[h] = String(r[i] ?? '').trim(); });
    return o;
  });
}

/** No cache-busting query: it would defeat the service worker and offline play. */
async function fetchText(url) {
  const res = await fetch(encodeURI(url));
  if (!res.ok) throw new Error(`Could not load "${url}" (HTTP ${res.status})`);
  return res.text();
}

/* ---------------------------------------------------------------
   Species
   --------------------------------------------------------------- */

export class Species {
  constructor(o) { Object.assign(this, o); }

  /* encodeURIComponent is what lets "Antheara East.png" resolve. */
  get imagePath() { return `${IMAGE_DIR}/${encodeURIComponent(this.image)}`; }
  get shinyPath() { return `${SHINY_DIR}/${encodeURIComponent(this.image)}`; }
  spritePath(shiny) { return shiny ? this.shinyPath : this.imagePath; }

  get stageLabel() { return `Stage ${this.stage}`; }
  get rarityName() { return RARITY_NAMES[this.effectiveRarity] || null; }

  /** True for anything the Awakening Gate guards. */
  get isBoss() { return this.effectiveRarity === 5; }

  /** True for the 42 creatures Encounter Mode can roll. */
  get isCatchable() { return this.stage === 1 && !this.isBoss; }
}

/* ---------------------------------------------------------------
   The database
   --------------------------------------------------------------- */

export const DB = {
  loaded: false,
  species: [],          // sorted by dex order
  byId: new Map(),
  byName: new Map(),    // lower-cased name -> Species

  evolvesFrom: new Map(),   // childId -> parentId
  familyOf: new Map(),      // memberId -> rootId
  familyMembers: new Map(), // rootId -> [ids, roughly stage order]

  /** type -> { rarity -> [Species] } for Encounter Mode. */
  pools: new Map(),
  /** type -> Species | null */
  bosses: new Map(),

  warnings: []
};

/* ---- lookups ---- */

export const speciesById = id => DB.byId.get(id) || null;
export const speciesByName = name => DB.byName.get(String(name ?? '').trim().toLowerCase()) || null;

export const familyRoot = id => DB.familyOf.get(id) || id;
export const familyRootSpecies = id => speciesById(familyRoot(id));
export const familyMembers = id => (DB.familyMembers.get(familyRoot(id)) || [id]).map(speciesById).filter(Boolean);

/**
 * Only Stage 1 rows carry a rarity in the CSV, so an evolved form inherits
 * its family root's. Same convention as Search and Go, which keeps the
 * Collection reading consistently between the two games.
 */
export function effectiveRarityOf(sp) {
  if (!sp) return 1;
  if (sp.rarity) return sp.rarity;
  const root = familyRootSpecies(sp.id);
  return (root && root.rarity) || 1;
}

/** Every species this one can evolve into. Empty means it is a final form. */
export function evolutionTargets(id) {
  const sp = speciesById(id);
  if (!sp) return [];
  return (sp.evolvesToIds || []).map(speciesById).filter(Boolean);
}

/**
 * The line this species sits on, root first. Walks up to the root, then
 * forward, stopping at the first branch because there is no single answer
 * past one — the Collection sheet shows the branch separately.
 */
export function lineagePath(id) {
  let cur = speciesById(id);
  if (!cur) return [];

  // Two separate cycle guards. Sharing one would make the upward walk block
  // the downward walk: by the time we reach the root, every member of the
  // line is already "seen", and walking forward would stop immediately and
  // return just the root.
  const climbed = new Set([cur.id]);
  while (true) {
    const parentId = DB.evolvesFrom.get(cur.id);
    if (!parentId || climbed.has(parentId)) break;
    const parent = speciesById(parentId);
    if (!parent) break;
    cur = parent;
    climbed.add(cur.id);
  }

  const path = [cur];
  const walked = new Set([cur.id]);
  while (true) {
    const next = evolutionTargets(cur.id);
    if (next.length !== 1 || walked.has(next[0].id)) break;
    cur = next[0];
    walked.add(cur.id);
    path.push(cur);
  }
  return path;
}

/* ---- encounter rolls ---- */

/**
 * Roll a creature for Encounter Mode in the given mode.
 *
 * Weighted by rarity, but only across the rarities that mode actually has:
 * Celestial has no Epic once Verdanthorn is promoted to its boss, and
 * silently folding that weight into nothing would have made every Celestial
 * roll slightly wrong. Reweighting against what is present keeps the
 * distribution honest whatever the CSV holds.
 */
export function rollEncounter(type, { minRarity = 0 } = {}) {
  const byRarity = DB.pools.get(type);
  if (!byRarity) return null;

  const rarities = Object.keys(RARITY_WEIGHTS)
    .map(Number)
    .filter(r => r >= minRarity && (byRarity[r] || []).length);
  if (!rarities.length) return null;

  const total = rarities.reduce((s, r) => s + RARITY_WEIGHTS[r], 0);
  let roll = Math.random() * total;
  for (const r of rarities) {
    roll -= RARITY_WEIGHTS[r];
    if (roll <= 0) return pick(byRarity[r]);
  }
  return pick(byRarity[rarities[rarities.length - 1]]);
}

export const bossOf = type => DB.bosses.get(type) || null;

/** Every creature a mode can produce, boss included. Used by the Collection. */
export function speciesOfType(type) {
  return DB.species.filter(s => s.type === type);
}

/* ---------------------------------------------------------------
   Stats (Collection flavour only)
   --------------------------------------------------------------- */

export const STAT_KEYS = ['hp', 'attack', 'defence', 'speed'];
export const STAT_LABELS = { hp: 'HP', attack: 'Attack', defence: 'Defence', speed: 'Speed' };

function readStats(row, name) {
  if (!row) return null;
  const out = {};
  let ok = false;
  for (const k of STAT_KEYS) {
    const v = int(row[k] ?? (k === 'defence' ? row['defense'] : null));
    if (v && v > 0) { out[k] = v; ok = true; } else out[k] = 50;
  }
  if (!ok) { DB.warnings.push(`${name}: no usable stats, defaulting to 50s`); return null; }
  return out;
}

function readMoves(row, name) {
  if (!row) return [];
  const moves = [];
  for (let slot = 1; slot <= 4; slot++) {
    const mn = String(row[`move${slot} name`] ?? '').trim();
    const power = int(row[`move${slot} power`]);
    const level = int(row[`move${slot} level`]);
    if (!mn && power === null && level === null) continue;
    if (!mn) { DB.warnings.push(`${name}: move slot ${slot} has no name, skipped`); continue; }
    moves.push({ slot, name: mn, power: power ?? 0, level: level ?? 1 });
  }
  return moves.sort((a, b) => (a.level - b.level) || (a.slot - b.slot));
}

/* ---------------------------------------------------------------
   Load
   --------------------------------------------------------------- */

/** Fix up MODES so a typo in a literal cannot break type matching. */
function finaliseModes() {
  for (const key of TYPES) {
    const m = MODES[key];
    if (!m) { DB.warnings.push(`No mode defined for type "${key}"`); continue; }
    m.type = key;               // the key is authoritative, not the literal
    m.key = key;
  }
}

function buildSpecies(records, statsRecords) {
  const statsById = new Map();
  const statsByName = new Map();
  for (const r of statsRecords) {
    if (r['id_output']) statsById.set(r['id_output'], r);
    if (r['name']) statsByName.set(r['name'].toLowerCase(), r);
  }

  const out = [];
  records.forEach((r, idx) => {
    const id = r['id_output'];
    const name = r['name'];
    if (!id || !name) { DB.warnings.push(`Row ${idx + 2} has no id or name, skipped`); return; }

    const type = r['type'] || 'Neutral';
    if (!TYPES.includes(type)) DB.warnings.push(`${name}: unknown type "${type}"`);

    const stats = statsById.get(id) || statsByName.get(name.toLowerCase()) || null;
    if (!stats) DB.warnings.push(`${name}: no stats row found`);

    // Trailing digits of the id are the dex number, which keeps the
    // Collection in the same order as the CSV and as Search and Go.
    const m = String(id).match(/(\d+)\s*$/);

    const sp = new Species({
      id,
      order: m ? Number(m[1]) : idx + 1,
      name,
      stage: stageNumber(r['stage']),
      type,
      image: r['image'] || `${name}.png`,
      rarity: int(r['rarity']),           // null on every evolved form
      evolvesToNames: splitList(r['evolves to']),
      evolvesToIds: [],
      set: SET_NAME,
      baseStats: readStats(stats, name),
      moves: readMoves(stats, name)
    });

    out.push(sp);
  });

  return out.sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id));
}

/** Resolve `Evolves to` names into ids and record one parent per child. */
function linkEvolutions() {
  for (const sp of DB.species) {
    for (const nm of sp.evolvesToNames) {
      const target = speciesByName(nm);
      if (!target) { DB.warnings.push(`${sp.name}: evolves to unknown "${nm}"`); continue; }
      if (target.id === sp.id) { DB.warnings.push(`${sp.name}: evolves to itself, ignored`); continue; }
      if (sp.evolvesToIds.includes(target.id)) continue;

      sp.evolvesToIds.push(target.id);

      if (DB.evolvesFrom.has(target.id) && DB.evolvesFrom.get(target.id) !== sp.id) {
        DB.warnings.push(`${target.name}: two pre-evolutions, keeping ${DB.evolvesFrom.get(target.id)}`);
      } else {
        DB.evolvesFrom.set(target.id, sp.id);
      }
    }
    sp.branching = sp.evolvesToIds.length > 1;
  }
}

/**
 * Families, breadth-first from every root, so a branching line still
 * gathers every descendant into one family and one Collection entry.
 */
function buildFamilies() {
  const roots = DB.species.filter(s => !DB.evolvesFrom.has(s.id));

  for (const root of roots) {
    const members = [];
    const queue = [root.id];
    const seen = new Set(queue);

    while (queue.length && members.length < 24) {
      const id = queue.shift();
      members.push(id);
      DB.familyOf.set(id, root.id);
      for (const childId of (speciesById(id)?.evolvesToIds || [])) {
        if (!seen.has(childId)) { seen.add(childId); queue.push(childId); }
      }
    }
    DB.familyMembers.set(root.id, members);
  }

  // Anything left over (a cycle in the CSV) becomes its own family rather
  // than vanishing from the Collection.
  for (const sp of DB.species) {
    if (!DB.familyOf.has(sp.id)) {
      DB.familyOf.set(sp.id, sp.id);
      DB.familyMembers.set(sp.id, [sp.id]);
      DB.warnings.push(`${sp.name}: not reachable from any root, treated as its own family`);
    }
  }
}

/**
 * Encounter pools and bosses, per type.
 *
 * A promoted boss is removed from its rarity bucket in the same pass that
 * appoints it, so Alpakina and Verdanthorn cannot turn up as an ordinary
 * Epic catch in the mode they now guard.
 */
function buildPools() {
  for (const type of TYPES) {
    const byRarity = { 1: [], 2: [], 3: [], 4: [] };
    let boss = null;

    for (const sp of DB.species) {
      if (sp.type !== type) continue;
      if (sp.stage !== 1 || !sp.rarity) continue;   // evolved forms are earned, not caught
      if (sp.rarity === 5) { boss = sp; continue; }
      if (byRarity[sp.rarity]) byRarity[sp.rarity].push(sp);
      else DB.warnings.push(`${sp.name}: rarity ${sp.rarity} is outside 1-5`);
    }

    if (!boss) {
      const name = BOSS_OVERRIDES[type];
      const promoted = name ? speciesByName(name) : null;
      if (promoted && promoted.type === type) {
        boss = promoted;
        for (const r of Object.keys(byRarity)) {
          byRarity[r] = byRarity[r].filter(s => s.id !== promoted.id);
        }
      } else if (name) {
        DB.warnings.push(`Boss override "${name}" for ${type} not found or is the wrong type`);
      } else {
        DB.warnings.push(`${type} has no legendary and no override, so it has no boss stage`);
      }
    }

    if (boss) boss.promotedBoss = boss.rarity !== 5;
    DB.bosses.set(type, boss);
    DB.pools.set(type, byRarity);
  }
}

/** Stamp the resolved rarity on every species so views never recompute it. */
function stampRarities() {
  for (const sp of DB.species) {
    sp.effectiveRarity = bossOf(sp.type)?.id === sp.id ? 5 : effectiveRarityOf(sp);
  }
}

/**
 * Load and join both CSVs, then build the graphs the game needs.
 *
 * Both files are required. Unlike Search and Go there are no optional sets
 * to degrade gracefully around — without the creature list there is no game,
 * so a failure here is fatal and main.js shows it on the boot screen.
 */
export async function loadDatabase({ csv = CSV_FILE, statsCsv = STATS_CSV_FILE } = {}) {
  DB.warnings.length = 0;
  finaliseModes();

  const [csvText, statsText] = await Promise.all([fetchText(csv), fetchText(statsCsv)]);

  const records = toRecords(parseCSV(csvText));
  const statsRecords = toRecords(parseCSV(statsText));
  if (!records.length) throw new Error(`"${csv}" has no data rows`);

  DB.species = buildSpecies(records, statsRecords);
  DB.byId = new Map(DB.species.map(s => [s.id, s]));
  DB.byName = new Map(DB.species.map(s => [s.name.toLowerCase(), s]));

  DB.evolvesFrom.clear();
  DB.familyOf.clear();
  DB.familyMembers.clear();
  DB.pools.clear();
  DB.bosses.clear();

  linkEvolutions();
  buildFamilies();
  buildPools();
  stampRarities();

  DB.loaded = true;
  if (DB.warnings.length) console.warn('[data]', DB.warnings);
  return DB;
}

/** Every sprite the game can show, for the service worker's precache list. */
export function allSpritePaths() {
  const out = [];
  for (const sp of DB.species) out.push(sp.imagePath, sp.shinyPath);
  return out;
}
