/* ============================================================
   data.js — creature data and every tuning table

   Pure data and maths. This module imports nothing from the rest of
   the game, which is deliberate: every number worth re-balancing lives
   here, so tuning the game means editing one file.

   Creatures come from Search and Go's CSVs, joined on `id_output` exactly as
   that game does it. See SETS below for the files.

   Stats and learnsets are only flavour on the Collection sheet. There is no
   battling here, so nothing in the physics or scoring reads them.
   ============================================================ */

export const IMAGE_DIR = 'images';
export const SHINY_DIR = 'shiny';

/* ---------------------------------------------------------------
   Sets
   --------------------------------------------------------------- */

/**
 * The creature sets, in dex order.
 *
 * Elemental Awakening splits species and stats across two files; the others carry
 * both on one row, so `statsCsv` is null and the same records are used for the
 * join. Exclusives is spread over three files in Search and Go, which is why
 * `csvs` is a list — they are one set here regardless of how they are filed
 * there.
 *
 * `order` keeps the dexes from interleaving. Every set numbers its `id_output`
 * from 1, so sorting on that alone would shuffle them together.
 *
 * All sets share `images/` and `shiny/`. Their sprite filenames are disjoint —
 * tools\downscale-sprites.ps1 refuses to run if that ever stops being true — and
 * one flat folder per variant keeps Species.imagePath a plain filename join.
 */
export const SETS = {
  ea: {
    key: 'ea',
    order: 0,
    name: 'Elemental Awakening',
    short: 'Awakening',
    csvs: ['Elemental Awakening Creatures.csv'],
    statsCsv: 'Elemental Awakening Creatures Stats and Moves.csv'
  },
  ga: {
    key: 'ga',
    order: 1,
    name: 'Galactic Adventures',
    short: 'Galactic',
    csvs: ['Galactic Adventures.csv'],
    statsCsv: null,
    /**
     * This set is earned a rarity tier at a time, so its members are filtered at
     * roll time against what the player has unlocked. Flagged here rather than
     * named in rollEncounter, so a set gated some other way — Exclusives is gated
     * as a whole table — is not accidentally caught by the same rule.
     */
    rarityLadder: true
  },
  ex: {
    key: 'ex',
    order: 2,
    name: 'Exclusives',
    short: 'Exclusive',
    csvs: [
      'Raid Exclusive - Search and Go.csv',
      'Exclusives2.csv'
    ],
    /**
     * The table's legendaries, filed separately at source and kept separate here.
     *
     * Listing them rather than picking rarity 5 out of the ordinary files is what
     * lets the rest of the set be rescaled all the way down: the three creatures
     * that were Legendary in the raid files become ordinary Epic catches, because
     * these five are the legendaries now.
     */
    bossCsvs: ['Exclusives3.csv'],
    statsCsv: null,
    /**
     * Exclusives were raid rewards in Search and Go, so nothing in the set is
     * common there: the catchable files only use rarities 3 to 5. Left alone, the
     * whole set would sit in the rarest buckets and almost never be rolled.
     *
     * `remapRarity` rescales them onto the full 1-4 range instead. See
     * remapSetRarities for how the shape is chosen.
     */
    remapRarity: true
  }
};

/** Set keys in dex order. `ea` is the base set and is always available. */
export const SET_KEYS = Object.keys(SETS).sort((a, b) => SETS[a].order - SETS[b].order);
export const BASE_SET = 'ea';

/* ---------------------------------------------------------------
   Unlocking Galactic Adventures
   --------------------------------------------------------------- */

/**
 * Galactic Adventures is earned with the base set, one rarity tier at a time.
 *
 * Gated on creatures *registered* from Elemental Awakening rather than on score
 * or games played, so the reward for finishing one Collection is the start of
 * the next. 50 of 79 is most of the easy half; 70 asks for nearly all of it,
 * including the four legendaries behind the gate.
 *
 * A tier unlocks the Galactic creatures *of that rarity*, which then share the
 * rarity bucket with their Elemental counterparts — so unlocking Common does not
 * make Commons any more likely, it makes them more varied.
 */
export const GALACTIC_UNLOCKS = [
  { rarity: 1, registered: 50 },
  { rarity: 2, registered: 60 },
  { rarity: 3, registered: 65 },
  { rarity: 4, registered: 70 }
];

/** Which Galactic rarities are open at this many Elemental registrations. */
export function galacticRaritiesUnlocked(baseRegistered) {
  const n = Math.max(0, Math.round(Number(baseRegistered) || 0));
  return GALACTIC_UNLOCKS.filter(g => n >= g.registered).map(g => g.rarity);
}

/** The next tier to work towards, or null once they are all open. */
export function nextGalacticUnlock(baseRegistered) {
  const n = Math.max(0, Math.round(Number(baseRegistered) || 0));
  return GALACTIC_UNLOCKS.find(g => n < g.registered) || null;
}

/**
 * The rarity a Galactic creature is gated behind.
 *
 * Evolved forms have no rarity of their own, so they follow their family's —
 * evolving something you were allowed to catch must never be blocked.
 */
export function galacticGateRarity(sp) {
  if (!sp || sp.setKey !== 'ga') return 0;
  return effectiveRarityOf(sp);
}

/* ---------------------------------------------------------------
   Unlocking the Raid Vault
   --------------------------------------------------------------- */

/**
 * The Exclusives table opens on total registrations across the first two sets.
 *
 * A whole table rather than a rarity tier, so it is one threshold rather than a
 * ladder. 100 of the 156 in Elemental Awakening and Galactic Adventures together
 * means the player has finished the base set and made real progress into the one
 * it unlocks — which is the point at which a third thing to do is welcome rather
 * than a distraction.
 *
 * Counted across both, not either: it is the reward for the pair of them.
 */
export const VAULT_UNLOCK_REGISTERED = 100;

/** The sets that count towards it. Exclusives cannot unlock itself. */
export const VAULT_UNLOCK_SETS = ['ea', 'ga'];

/** The mode key the threshold gates. */
export const VAULT_MODE = 'Exclusives';

export const vaultUnlocked = registered =>
  (Math.max(0, Math.round(Number(registered) || 0))) >= VAULT_UNLOCK_REGISTERED;

/* ---------------------------------------------------------------
   Rescaling a set's rarities
   --------------------------------------------------------------- */

/**
 * Target share of each rarity in a rescaled set, measured off the game's own
 * pools rather than invented.
 *
 * Across Elemental Awakening and Galactic Adventures the 72 catchable first
 * stages sit at 23 Common, 19 Uncommon, 19 Rare, 11 Epic — so roughly
 * 32 / 26 / 26 / 15 per cent. A rescaled set is cut to the same shape, which is
 * what keeps the Vault feeling like the rest of the game rather than a pile of
 * Epics.
 */
export const RARITY_SHAPE = { 1: 0.32, 2: 0.26, 3: 0.26, 4: 0.16 };

/**
 * Rescale one set's first-stage rarities onto the full 1-4 range.
 *
 * Exclusives were raid rewards, so the source files only use 3, 4 and 5. Shifting
 * them down by two would leave nothing at Epic and nothing to chase; picking new
 * rarities by hand would be 25 numbers to maintain against a CSV that can change.
 *
 * So it is a rule instead: rank the set's catchable first stages by source rarity
 * and then by stat total, and cut that ranking into buckets sized by
 * RARITY_SHAPE. Ranking by rarity first preserves the source's own ordering — a
 * source Legendary can never come out commoner than a source Rare — and the stat
 * total breaks ties within a tier the same way the boss promotions do. The id is
 * the final tiebreak so the order is total and the result is identical on every
 * load.
 *
 * Anything from the set's `bossCsvs` is left alone. Those are the table's
 * legendaries and are never rolled, so they keep rarity 5 — which is also what
 * frees the three source Legendaries in the catchable files to come down to Epic.
 */
function remapSetRarities(species, setKey) {
  const ranked = species
    .filter(sp => sp.setKey === setKey && sp.stage === 1 && sp.rarity && !sp.setBoss)
    .sort((a, b) =>
      (a.rarity - b.rarity) ||
      (statTotal(a) - statTotal(b)) ||
      a.id.localeCompare(b.id));

  if (!ranked.length) return;

  /* Largest-remainder, so the buckets always add back up to the set size however
     the shares round. Taking Math.round on each independently does not. */
  const n = ranked.length;
  const tiers = [1, 2, 3, 4];
  const exact = tiers.map(r => n * RARITY_SHAPE[r]);
  const sizes = exact.map(Math.floor);
  let left = n - sizes.reduce((s, v) => s + v, 0);

  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; left > 0; k++, left--) sizes[order[k % order.length].i]++;

  let at = 0;
  tiers.forEach((r, i) => {
    for (let k = 0; k < sizes[i]; k++, at++) {
      ranked[at].sourceRarity = ranked[at].rarity;
      ranked[at].rarity = r;
    }
  });

  // Anything left over by a rounding accident keeps the last tier rather than
  // being dropped from the pools entirely.
  for (; at < n; at++) {
    ranked[at].sourceRarity = ranked[at].rarity;
    ranked[at].rarity = 4;
  }
}

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
  },

  /**
   * The sixth table, and the first that is not a type.
   *
   * Its pool is a whole *set* rather than a type, so its creatures span all five
   * types — which is the point of it. That is why `type` is null and `set` is
   * filled in: buildPools reads one or the other, and every view that used to
   * assume "mode key = species type" now asks the mode.
   */
  Exclusives: {
    type: null,
    set: 'ex',
    name: 'Raid Vault',
    blurb: 'Two rotating vault rings. Every creature here is a raid exclusive.',
    gimmick: 'vault',
    colour: '#ff6f9c',
    deep: '#4d1230',
    ink: '#0b1024'
  }
};

/**
 * Every playable table, in carousel order.
 *
 * Kept separate from TYPES because the two stopped being the same thing when the
 * Exclusives table arrived. TYPES is what a *creature* is; MODE_KEYS is what you
 * can *play*. Conflating them is how a sixth table would silently acquire a
 * species type it does not have.
 */
export const MODE_KEYS = [...TYPES, 'Exclusives'];

/** The set a mode draws its pool from, or null if it draws from a type. */
export const modeSet = key => MODES[key]?.set || null;

/** The species type a mode is built around, or null for a set-based table. */
export const modeType = key => MODES[key]?.type || null;

/* For type tables the key is also what matches a species' `Type` column, so
   finaliseModes() stamps `type` from the key at load time rather than trusting
   the literal above — a typo there would silently empty a mode's catch pool. */

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
 *
 * Keyed by set, because each set appoints its own boss per type. Galactic
 * Adventures has no rarity 5 Neutral at all — and no rarity 4 either — so
 * Goggly is promoted: it is the highest-statted Neutral first stage with no
 * evolutions, which is structurally what every real legendary in both sets is.
 */
export const BOSS_OVERRIDES = {
  ea: {
    Neutral: 'Alpakina',
    Celestial: 'Verdanthorn'
  },
  ga: {
    Neutral: 'Goggly'
  }
};

/**
 * The gate picks uniformly among whichever legendaries a table currently has.
 *
 * Uniform rather than a table of weights, because that already produces both
 * rules asked for and cannot drift out of step with the number of candidates: a
 * type table with its Elemental and Galactic legendaries unlocked is 50/50, and
 * the Raid Vault with its five is 20% each. A seventh would be 1 in 7 without
 * anyone having to remember to change a constant.
 */
export const bossOddsFor = count => (count > 0 ? 1 / count : 0);

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
  /* The Raid Vault core: both rings threaded while their mouths lined up. Priced
     with completing the target bank, because it asks for at least as much. */
  vaultCore: 7_500,
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

  get setName() { return SETS[this.setKey]?.name || this.setKey; }

  /** True for anything the Awakening Gate guards, in either set. */
  get isBoss() { return this.effectiveRarity === 5; }

  /** True for anything Encounter Mode can roll, unlocks aside. */
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

  /**
   * type -> { rarity -> [Species] } for Encounter Mode.
   *
   * Both sets share these buckets. Which members are actually reachable depends
   * on the player's unlocks, and that is decided at roll time by rollEncounter
   * rather than baked in here — the pools are data, the gates are progress.
   */
  pools: new Map(),
  /** setKey -> (type -> Species | null) */
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
export function rollEncounter(type, { minRarity = 0, galacticRarities = [] } = {}) {
  const byRarity = DB.pools.get(type);
  if (!byRarity) return null;

  /**
   * Locked Galactic creatures are filtered out *before* the weights are worked
   * out, not after the roll.
   *
   * Rolling first and rejecting afterwards would either need a retry loop or
   * would silently return nothing, and both change the distribution. Filtering
   * first keeps the one property this function exists to guarantee: the weights
   * are always reweighted against what is actually reachable.
   */
  const open = new Set(galacticRarities);
  const reachable = sp =>
    !SETS[sp.setKey]?.rarityLadder || open.has(sp.effectiveRarity);

  const buckets = {};
  for (const r of Object.keys(RARITY_WEIGHTS).map(Number)) {
    buckets[r] = (byRarity[r] || []).filter(reachable);
  }

  const rarities = Object.keys(RARITY_WEIGHTS)
    .map(Number)
    .filter(r => r >= minRarity && buckets[r].length);
  if (!rarities.length) return null;

  const total = rarities.reduce((s, r) => s + RARITY_WEIGHTS[r], 0);
  let roll = Math.random() * total;
  for (const r of rarities) {
    roll -= RARITY_WEIGHTS[r];
    if (roll <= 0) return pick(buckets[r]);
  }
  return pick(buckets[rarities[rarities.length - 1]]);
}

/** The base set's boss for a type. The one the Awakening Gate always offers. */
export const bossOf = type => DB.bosses.get(BASE_SET)?.get(type) || null;

/** A set's boss for a type. */
export const bossOfSet = (setKey, type) => DB.bosses.get(setKey)?.get(type) || null;

/** The Galactic boss for a type, which beating the Elemental one unlocks. */
export const galacticBossOf = type => bossOfSet('ga', type);

/** Every legendary a table can ever field, available or not. */
export function allBossesForMode(modeKey) {
  const mode = MODES[modeKey];
  if (!mode) return [];

  // A set-based table fields that set's legendary for every type: the Raid
  // Vault's five come from the one file, one per type.
  if (mode.set) return TYPES.map(t => bossOfSet(mode.set, t)).filter(Boolean);

  const owned = setsOwnedByAMode();
  return SET_KEYS
    .filter(k => !owned.has(k))
    .map(k => bossOfSet(k, mode.type))
    .filter(Boolean);
}

/**
 * Every legendary a table's gate could produce right now.
 *
 * Returned as a list rather than pre-rolled so the caller owns the randomness,
 * which is what lets the tests pin it down. On a type table the Galactic
 * legendary has to be earned; the Raid Vault's five are all available at once,
 * because the table itself is what had to be earned.
 */
export function bossChoicesFor(modeKey, { galacticUnlocked = false } = {}) {
  const mode = MODES[modeKey];
  if (!mode) return [];
  const all = allBossesForMode(modeKey);
  if (mode.set) return all;
  return all.filter(b => b.setKey === BASE_SET || galacticUnlocked);
}

/** Every creature a mode can produce, boss included. Used by the Collection. */
export function speciesOfType(type, setKey = null) {
  return DB.species.filter(s => s.type === type && (!setKey || s.setKey === setKey));
}

/** Every species in a set. */
export const speciesOfSet = setKey => DB.species.filter(s => s.setKey === setKey);

/* ---------------------------------------------------------------
   Stats (Collection flavour only)
   --------------------------------------------------------------- */

export const STAT_KEYS = ['hp', 'attack', 'defence', 'speed'];

/**
 * Summed base stats, and 0 when a species has none.
 *
 * Added up here rather than read from the CSVs' own Total column, which is not
 * reliable across the sets — some rows carry the family's total rather than their
 * own. Everything that ranks creatures by strength (the boss promotions, the
 * Exclusives rarity rescale) uses this, so they all rank the same way.
 */
export const statTotal = sp =>
  sp?.baseStats ? STAT_KEYS.reduce((s, k) => s + (sp.baseStats[k] || 0), 0) : 0;
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

function buildSpecies(records, statsRecords, set) {
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
    if (!id || !name) {
      DB.warnings.push(`${set.name}: row ${idx + 2} has no id or name, skipped`);
      return;
    }

    const type = r['type'] || 'Neutral';
    if (!TYPES.includes(type)) DB.warnings.push(`${name}: unknown type "${type}"`);

    const stats = statsById.get(id) || statsByName.get(name.toLowerCase()) || null;
    if (!stats) DB.warnings.push(`${set.name}: ${name} has no stats row`);

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
      setKey: set.key,
      setOrder: set.order,
      baseStats: readStats(stats, name),
      moves: readMoves(stats, name)
    });

    out.push(sp);
  });

  return out;
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
 * Sets that belong to one table rather than feeding the five type tables.
 *
 * Derived from MODES rather than flagged on the set, so there is one source of
 * truth. Without this, Exclusives creatures would also turn up in the ordinary
 * type tables, because they carry real types.
 */
const setsOwnedByAMode = () =>
  new Set(MODE_KEYS.map(k => MODES[k]?.set).filter(Boolean));

/**
 * The legendary each set fields for each type.
 *
 * Every set has one per type, either because the source file marks it rarity 5 or
 * because BOSS_OVERRIDES promotes one. A promoted creature is removed from the
 * ordinary pools by buildModePools, so it cannot be both the boss and a routine
 * catch.
 */
function buildBosses() {
  for (const key of SET_KEYS) DB.bosses.set(key, new Map());

  for (const key of SET_KEYS) {
    for (const type of TYPES) {
      /* A set that files its legendaries separately is believed over rarity: after
         the rescale the catchable files hold no rarity 5 at all, and relying on
         that having already happened would be a load-order trap. */
      const mine = sp => sp.setKey === key && sp.type === type && sp.stage === 1;
      let boss =
        DB.species.find(sp => mine(sp) && sp.setBoss) ||
        DB.species.find(sp => mine(sp) && sp.rarity === 5) ||
        null;

      if (!boss) {
        const name = BOSS_OVERRIDES[key]?.[type];
        const promoted = name ? speciesByName(name) : null;
        if (promoted && promoted.type === type && promoted.setKey === key) {
          boss = promoted;
        } else if (name) {
          DB.warnings.push(
            `${SETS[key].name}: boss override "${name}" for ${type} is missing, ` +
            'the wrong type or in the wrong set');
        } else {
          DB.warnings.push(
            `${SETS[key].name}: ${type} has no legendary and no override, so it has no boss`);
        }
      }

      if (boss) boss.promotedBoss = boss.rarity !== 5;
      DB.bosses.get(key).set(type, boss);
    }
  }
}

/**
 * Encounter pools, one per playable table.
 *
 * A type table draws every creature of its type from the sets that feed type
 * tables; the Exclusives table draws its whole set regardless of type. Bosses are
 * excluded here rather than at roll time, so a legendary can never turn up as an
 * ordinary catch in the table it guards.
 */
function buildModePools() {
  const owned = setsOwnedByAMode();

  const bossIds = new Set();
  for (const key of SET_KEYS) {
    for (const boss of DB.bosses.get(key).values()) if (boss) bossIds.add(boss.id);
  }

  for (const key of MODE_KEYS) {
    const mode = MODES[key];
    const byRarity = { 1: [], 2: [], 3: [], 4: [] };

    for (const sp of DB.species) {
      const mine = mode.set ? sp.setKey === mode.set
                            : (sp.type === mode.type && !owned.has(sp.setKey));
      if (!mine) continue;
      if (sp.stage !== 1 || !sp.rarity) continue;   // evolved forms are earned, not caught
      if (sp.rarity === 5 || bossIds.has(sp.id)) continue;
      if (byRarity[sp.rarity]) byRarity[sp.rarity].push(sp);
      else DB.warnings.push(`${sp.name}: rarity ${sp.rarity} is outside 1-5`);
    }

    DB.pools.set(key, byRarity);
  }
}

/**
 * Stamp the resolved rarity on every species so views never recompute it.
 *
 * A boss in either set reads as rarity 5, promoted or not, because that is what
 * the player meets: a legendary behind the gate.
 */
function stampRarities() {
  const bossIds = new Set();
  for (const key of SET_KEYS) {
    for (const boss of DB.bosses.get(key).values()) if (boss) bossIds.add(boss.id);
  }

  for (const sp of DB.species) {
    sp.effectiveRarity = bossIds.has(sp.id) ? 5 : effectiveRarityOf(sp);
  }
}

/**
 * Load every set, then build the graphs the game needs.
 *
 * The base set is required: without it there is no game, so a failure there is
 * fatal and main.js shows it on the boot screen. A later set is not — if
 * Galactic Adventures fails to load, the game is still entirely playable, so it
 * degrades to a warning rather than taking the whole boot down with it.
 *
 * Sets are loaded in parallel but assembled in dex order, so `order` decides the
 * Collection's layout rather than whichever fetch happened to finish first.
 */
export async function loadDatabase({ sets = SET_KEYS } = {}) {
  DB.warnings.length = 0;
  finaliseModes();

  const wanted = sets.filter(k => SETS[k]);

  const loaded = await Promise.all(wanted.map(async key => {
    const set = SETS[key];
    const bossCsvs = set.bossCsvs || [];
    try {
      const [texts, bossTexts, statsText] = await Promise.all([
        Promise.all(set.csvs.map(fetchText)),
        Promise.all(bossCsvs.map(fetchText)),
        set.statsCsv ? fetchText(set.statsCsv) : Promise.resolve(null)
      ]);

      /* A set can be spread over several files — Exclusives is three. They are
         concatenated in the order listed, so the dex reads the way the files do,
         with the legendaries last. */
      const records = texts.flatMap(t => toRecords(parseCSV(t)));
      const bossRecords = bossTexts.flatMap(t => toRecords(parseCSV(t)));
      if (!records.length) throw new Error(`${set.name} has no data rows`);

      // Only Elemental Awakening files its stats separately; the rest carry them
      // on the same row, so the records join against themselves.
      const all = records.concat(bossRecords);
      const statsRecords = statsText ? toRecords(parseCSV(statsText)) : all;

      const species = buildSpecies(records, statsRecords, set);
      const bosses = buildSpecies(bossRecords, statsRecords, set);
      for (const sp of bosses) sp.setBoss = true;

      return { key, species: species.concat(bosses) };
    } catch (e) {
      if (key === BASE_SET) throw e;
      DB.warnings.push(`${set.name} could not be loaded, so it is unavailable: ${e.message}`);
      return { key, species: [] };
    }
  }));

  /**
   * Dex order: sets in `order`, and within a set the order its files list.
   *
   * `order` is renumbered rather than trusted, because a multi-file set restarts
   * its numbering in every file — Exclusives runs 1-19, then 20-44, then 1-5 for
   * the legendaries. Sorting on the id's trailing digits would drop those five
   * bosses in among the first five raid creatures. Renumbering makes "the order
   * the files are listed in" the single rule, which for the single-file sets is
   * exactly what they had before.
   */
  DB.species = loaded
    .sort((a, b) => SETS[a.key].order - SETS[b.key].order)
    .flatMap(l => l.species);
  DB.species.forEach((sp, i) => { sp.order = i + 1; });

  /* Ids and names have to be unique across sets, because everything downstream
     — the save file most of all — keys on them. A clash would silently merge two
     creatures into one Collection entry. */
  const ids = new Set();
  const names = new Map();
  for (const sp of DB.species) {
    if (ids.has(sp.id)) DB.warnings.push(`Duplicate id "${sp.id}" (${sp.name})`);
    ids.add(sp.id);
    const lower = sp.name.toLowerCase();
    if (names.has(lower)) {
      DB.warnings.push(
        `Name "${sp.name}" is in both ${names.get(lower)} and ${sp.setName}, ` +
        'so evolution links between them are ambiguous');
    }
    names.set(lower, sp.setName);
  }

  DB.byId = new Map(DB.species.map(s => [s.id, s]));
  DB.byName = new Map(DB.species.map(s => [s.name.toLowerCase(), s]));

  DB.evolvesFrom.clear();
  DB.familyOf.clear();
  DB.familyMembers.clear();
  DB.pools.clear();
  DB.bosses.clear();

  linkEvolutions();
  buildFamilies();

  /* Rescaling has to happen before the pools are cut, and after the families are
     linked so an evolved form inherits the rescaled rarity rather than the
     source one. */
  for (const key of SET_KEYS) {
    if (SETS[key].remapRarity) remapSetRarities(DB.species, key);
  }

  buildBosses();
  buildModePools();
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
