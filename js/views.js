/* ============================================================
   views.js — everything on screen that is not the table

   The Collection, the high score tables, the profile, and the sheets the
   game raises mid-play: mode select, the type-shift offer, the capture and
   evolution reveals, and game over.

   Built with el() rather than template strings, so text always goes
   through textContent and the event wiring sits next to the markup it
   belongs to. Every renderer reads from `store` and `DB` and writes into
   a container that index.html already provides — none of them own state.
   ============================================================ */

import {
  DB, TYPES, MODES, RARITY_NAMES, RARITY_WEIGHTS, DISC_TIERS,
  STAT_KEYS, STAT_LABELS,
  GATE_CATCHES_NEEDED, CAPTURE_METER, CAPTURE_SECONDS, EVOLUTION_SHARDS,
  EVOLUTION_SECONDS, BOSS_SECONDS, BALLS_PER_GAME, BALL_SAVE_SECONDS,
  CAPTURE_BALL_SAVE_SECONDS, SHINY_DOUBLE_AT,
  EXTRA_BALL_AT, MAX_MULTIPLIER, SHINY_ODDS, SCORE,
  speciesById, lineagePath, evolutionTargets, bossOf, bossOfSet, speciesOfType,
  SETS, SET_KEYS, BASE_SET, GALACTIC_UNLOCKS,
  MODE_KEYS, modeSet, modeType, allBossesForMode, VAULT_UNLOCK_REGISTERED
} from './data.js';

import { SPINS_PER_SHIFT } from './game.js';

import { store } from './state.js';
import { SAVE_FILENAME } from './persist.js';
import {
  $, el, fill, fmtScore, fmtShort, fmtDate, fmtDuration,
  openSheet, closeSheet, toast, confirmSheet
} from './ui.js';

/* ---------------------------------------------------------------
   Small shared pieces
   --------------------------------------------------------------- */

/** The coloured rarity pip. Only shown where a rarity means something. */
const rarityPip = rarity =>
  el('span', { class: `rar r-${rarity}`, title: RARITY_NAMES[rarity], text: String(rarity) });

const typeTag = type => el('span', { class: `tag t-${type}`, text: type });

/**
 * A creature cell for the Collection grid.
 *
 * Three states, and they have to be visually distinct at a glance:
 *   registered            full art
 *   not registered        silhouette, dashed, a ? badge, name and type hidden
 *   shiny registered      a gold star, in either view
 *   shiny mode, no shiny  silhouette of the *shiny* art
 *   sealed                padlock, and it cannot appear yet at all
 *
 * The states have to be told apart at arm's length, which is why each one gets a
 * badge and a border treatment rather than only a brightness change: a silhouette
 * on its own was being read as "a dark creature".
 */
function collectionCell(sp, { shinyMode, onOpen, sealed = false }) {
  const known = store.isRegistered(sp.id);
  const gotShiny = store.hasShiny(sp.id);
  const got = shinyMode ? gotShiny : known;
  const isBoss = sp.effectiveRarity === 5;

  const classes = ['cell'];
  if (shinyMode) classes.push(got ? 'shiny' : 'shadow');
  else if (!known) classes.push('locked');
  if (isBoss) classes.push('legendary');
  /* Shiny ownership is marked in the ordinary view too. It used to be visible
     only after toggling to shiny mode, so there was no way to see at a glance
     which of the creatures you had were shiny. */
  if (!shinyMode && known && gotShiny) classes.push('has-shiny');
  /* Sealed is not the same as unregistered, and conflating them would be a lie:
     one means "you have not found it yet", the other "it cannot appear yet". */
  if (sealed && !known) classes.push('sealed');

  const img = el('img', {
    src: shinyMode ? sp.shinyPath : sp.imagePath,
    alt: '',
    loading: 'lazy',
    decoding: 'async'
  });
  // A missing shiny file falls back to the ordinary art rather than showing
  // a broken image.
  if (shinyMode) {
    img.addEventListener('error', () => { img.src = sp.imagePath; }, { once: true });
  }

  /* Spelled out rather than left to colour alone, so a screen reader and a
     colour-blind player get the same three states everyone else does. */
  const label = sealed && !known ? `${sp.name}, not unlocked yet`
    : !known ? 'Not registered yet'
    : shinyMode
      ? `${sp.name}, ${gotShiny ? 'shiny registered' : 'no shiny yet'}`
      : `${sp.name}, registered${gotShiny ? ', shiny too' : ''}`;

  return el('button', {
    class: classes.join(' '),
    type: 'button',
    'aria-label': label,
    title: label,
    onclick: () => onOpen(sp)
  },
    rarityPip(sp.effectiveRarity),
    (shinyMode ? got : (known && gotShiny))
      ? el('span', { class: 'shiny-star', text: '\u2605' })
      : null,
    sealed && !known ? el('span', { class: 'seal', text: '\u{1f512}' })
      : !known ? el('span', { class: 'unseen', text: '?' })
      : null,
    img,
    el('span', { class: 'nm', text: known ? sp.name : 'Not found' }),
    el('span', { class: `sub ${got ? 't-' + sp.type : ''}`, text: got ? sp.type : (known ? sp.type : '\u2014') }),
    el('span', { class: 'stg', text: `S${sp.stage}` })
  );
}

/**
 * A key for the marks on the grid.
 *
 * On screen rather than in the guide, because the question it answers — "what does
 * this cell mean" — is asked while looking at the cells.
 */
function collectionLegend(shinyMode) {
  const item = (cls, glyph, text) => el('span', { class: 'lg-item' },
    el('i', { class: `lg-chip ${cls}`, text: glyph }),
    el('span', { text })
  );

  return el('div', { class: 'collection-legend small' },
    item('lg-shiny', '\u2605', shinyMode ? 'shiny caught' : 'shiny in your Collection'),
    item('lg-unseen', '?', 'not registered'),
    item('lg-seal', '\u{1f512}', 'not unlocked yet')
  );
}

/* ---------------------------------------------------------------
   Collection
   --------------------------------------------------------------- */

/**
 * The dex, one type at a time.
 *
 * Per type rather than all 79 at once because the type *is* the mode here:
 * what you are really looking at is "how far through Rune Sanctum am I", and
 * a single 79-cell grid answers a question nobody asked.
 */
export function renderCollection() {
  const body = $('#collection-body');
  if (!body) return;

  const type = TYPES.includes(store.s.ui.collectionType) ? store.s.ui.collectionType : 'Neutral';
  const setKey = SET_KEYS.includes(store.s.ui.collectionSet) ? store.s.ui.collectionSet : BASE_SET;
  const shinyMode = !!store.s.ui.collectionShiny;
  const set = SETS[setKey];

  const list = speciesOfType(type, setKey);
  const total = list.length;
  const have = shinyMode ? store.shinyCount(type, setKey) : store.registeredCount(type, setKey);

  /**
   * What cannot appear yet, and why.
   *
   * Two different gates, so two rules. Galactic is gated a rarity tier at a time,
   * so it is asked per creature. Exclusives is gated as a whole table, so every
   * creature in it is sealed or open together.
   */
  const openRarities = new Set(store.galacticRarities());
  const owningMode = MODE_KEYS.find(k => modeSet(k) === setKey) || null;

  /**
   * Which table's name heads the page.
   *
   * A set owned by a table is found *there*, not in the type table that happens
   * to share the creature's type — labelling Mystic exclusives "Rune Sanctum"
   * would send the player to a table they can never find them in.
   */
  const headMode = MODES[owningMode || type];
  const sealedFor = sp => {
    if (sp.setKey === BASE_SET) return false;
    if (sp.setKey === 'ga') return !openRarities.has(sp.effectiveRarity);
    const owner = MODE_KEYS.find(k => modeSet(k) === sp.setKey);
    return owner ? !store.modeUnlocked(owner) : false;
  };

  /* ---- set tabs ---- */
  const setTabs = el('div', { class: 'set-tabs' },
    SET_KEYS.map(k => {
      const s = SETS[k];
      const done = shinyMode ? store.shinyCount(null, k) : store.registeredCount(null, k);
      const all = store.speciesTotal(null, k);
      return el('button', {
        class: `set-tab${k === setKey ? ' active' : ''}`,
        type: 'button',
        onclick: () => { store.setUi('collectionSet', k); renderCollection(); }
      },
        el('b', { text: s.name }),
        el('small', { text: `${done}/${all}` })
      );
    })
  );

  /* ---- type tabs ---- */
  const tabs = el('div', { class: 'type-tabs' },
    TYPES.map(t => el('button', {
      class: `type-tab t-${t}${t === type ? ' active' : ''}`,
      type: 'button',
      onclick: () => { store.setUi('collectionType', t); renderCollection(); }
    },
      el('b', { text: t }),
      el('small', {
        text: `${shinyMode ? store.shinyCount(t, setKey) : store.registeredCount(t, setKey)}` +
              `/${store.speciesTotal(t, setKey)}`
      })
    ))
  );

  /**
   * The unlock ladder, shown only on the set it gates.
   *
   * Spelled out rather than left as a locked grid to work out, because the whole
   * point of the ladder is that it tells you what to go and do next.
   */
  const gateNote = setKey === BASE_SET ? null : owningMode ? (() => {
    /* A whole-table gate, so one threshold rather than a ladder. */
    const v = store.vaultProgress();
    return el('div', { class: 'gate-note' },
      el('p', { class: 'small' },
        el('b', { text: `${v.registered} / ${v.required}` }),
        el('span', {
          class: 'muted',
          text: v.unlocked
            ? ` registered across the first two sets \u2014 the ${MODES[owningMode].name} is open.`
            : ` registered across the first two sets \u2014 ${v.needed} more opens the ` +
              `${MODES[owningMode].name}, where every one of these is found.`
        })
      ),
      el('p', { class: 'muted small', text:
        'These are raid exclusives, so nothing here is common in the game they came ' +
        'from. Their rarities are rescaled onto the usual Common to Epic range for ' +
        'this table.' }),
      el('p', { class: 'muted small', text:
        `All five legendaries are available as soon as the table is, one in five each.` })
    );
  })() : (() => {
    const p = store.galacticProgress();
    const rows = GALACTIC_UNLOCKS.map(g => el('li', {
      class: p.unlocked.includes(g.rarity) ? 'open' : 'shut'
    },
      el('b', { text: RARITY_NAMES[g.rarity] }),
      el('span', {
        class: 'muted small',
        text: p.unlocked.includes(g.rarity)
          ? 'unlocked'
          : `${g.registered} Awakening creatures`
      })
    ));

    return el('div', { class: 'gate-note' },
      el('p', { class: 'small' },
        el('b', { text: `${p.registered} / ${p.total}` }),
        el('span', {
          class: 'muted',
          text: p.next
            ? ` Elemental Awakening registered \u2014 ${p.needed} more to unlock ` +
              `${RARITY_NAMES[p.next.rarity]} Galactic creatures.`
            : ' Elemental Awakening registered \u2014 every Galactic tier is open.'
        })
      ),
      el('ul', { class: 'gate-list' }, rows),
      el('p', { class: 'muted small', text:
        'Legendaries are separate: beat a type\u2019s Awakening legendary and its ' +
        'Galactic one joins the gate, at even odds with the first.' })
    );
  })();

  /* ---- header ---- */
  const head = el('div', { class: 'collection-head' },
    el('div', { class: 'ch-title' },
      el('h3', { text: headMode.name, style: { color: headMode.colour } }),
      el('p', { class: 'muted small', text: `${set.name} \u00b7 ${headMode.blurb}` })
    ),
    el('div', { class: 'ch-right' },
      el('span', { class: 'count', text: `${have} / ${total}${shinyMode ? ' shiny' : ''}` }),
      el('button', {
        class: `mini-btn${shinyMode ? ' on' : ''}`,
        type: 'button',
        title: 'Show your shiny collection',
        text: '\u2606 Shiny',
        onclick: () => { store.setUi('collectionShiny', !shinyMode); renderCollection(); }
      })
    )
  );

  /* ---- progress ---- */
  const pct = total ? Math.round((have / total) * 100) : 0;
  const bar = el('div', { class: 'prog' },
    el('i', { style: { width: `${pct}%`, background: headMode.colour } })
  );

  /* ---- the boss, called out ---- */
  const boss = bossOfSet(setKey, type);
  const bossLocked = owningMode
    ? !store.modeUnlocked(owningMode)
    : (setKey !== BASE_SET && !store.galacticBossUnlocked(type));
  const bossKnown = boss ? store.isRegistered(boss.id) : false;

  const bossRow = boss ? el('div', { class: 'boss-row' },
    el('span', { class: 'muted small', text: 'Awakening Gate' }),
    el('button', {
      class: `boss-chip${bossKnown ? ' got' : ''}${bossLocked && !bossKnown ? ' sealed' : ''}`,
      type: 'button',
      onclick: () => openSpecies(boss)
    },
      el('img', { src: boss.imagePath, alt: '', loading: 'lazy' }),
      el('b', { text: bossKnown ? boss.name : '???' }),
      bossKnown
        ? el('small', { text: `registered` })
        : bossLocked
          ? el('small', { class: 'muted', text: `beat ${bossOf(type)?.name || 'the Awakening boss'} first` })
          : el('small', { class: 'muted', text: 'not beaten' })
    ),
    setKey === BASE_SET && store.bossWins(type) > 0
      ? el('small', { class: 'muted', text: `${store.bossWins(type)} gate win${store.bossWins(type) === 1 ? '' : 's'}` })
      : null
  ) : null;

  /* ---- the grid, grouped by stage so lines read top to bottom ---- */
  const grid = el('div', { class: 'grid' },
    list
      .slice()
      .sort((a, b) => (a.stage - b.stage) || (a.order - b.order))
      .map(sp => collectionCell(sp, { shinyMode, onOpen: openSpecies, sealed: sealedFor(sp) }))
  );

  fill(body, setTabs, tabs, head, bar, gateNote, bossRow, collectionLegend(shinyMode), grid);
}

/* ---------------------------------------------------------------
   Species sheet
   --------------------------------------------------------------- */

export function openSpecies(sp) {
  renderSpeciesSheet(sp);
  openSheet('sheet-species');
}

/**
 * Why a creature cannot appear yet, on its own sheet.
 *
 * Shown here rather than only as a padlock in the grid, because the padlock says
 * "not yet" and this says what to go and do about it. Nothing at all for the base
 * set, or for anything already registered — a creature you have caught is not
 * locked, whatever the ladder says.
 */
function sealNote(sp) {
  if (!sp || sp.setKey === BASE_SET || store.isRegistered(sp.id)) return null;

  /* A set owned by a table is gated as one thing: the table. Nothing in it is
     reachable until that opens, legendaries included. */
  const owner = MODE_KEYS.find(k => modeSet(k) === sp.setKey);
  if (owner) {
    if (store.modeUnlocked(owner)) return null;
    const v = store.vaultProgress();
    return el('p', { class: 'sp-seal small' },
      `\u{1f512} Found only in the ${MODES[owner].name}, which opens at ` +
      `${v.required} creatures registered across Elemental Awakening and ` +
      `Galactic Adventures. You have ${v.registered}.`);
  }

  if (sp.effectiveRarity === 5) {
    const base = bossOf(sp.type);
    if (store.galacticBossUnlocked(sp.type)) return null;
    return el('p', { class: 'sp-seal small' },
      `\u{1f512} Beat ${base ? base.name : 'this type\u2019s Awakening legendary'} at the ` +
      'Awakening Gate and this joins that gate alongside it.');
  }

  const p = store.galacticProgress();
  if (p.unlocked.includes(sp.effectiveRarity)) return null;

  const tier = GALACTIC_UNLOCKS.find(g => g.rarity === sp.effectiveRarity);
  if (!tier) return null;

  return el('p', { class: 'sp-seal small' },
    `\u{1f512} ${RARITY_NAMES[tier.rarity]} Galactic creatures unlock at ` +
    `${tier.registered} Elemental Awakening creatures registered. ` +
    `You have ${p.registered}.`);
}

/**
 * The detail sheet. Shows the whole family line whether or not each member is
 * registered, because seeing that there *is* a third stage is the thing that
 * makes you want to go and find it.
 */
export function renderSpeciesSheet(sp) {
  const body = $('#species-body');
  if (!body || !sp) return;

  const known = store.isRegistered(sp.id);
  const shiny = store.hasShiny(sp.id);
  const isBoss = sp.effectiveRarity === 5;

  /* ---- hero ---- */
  const hero = el('div', { class: 'sp-hero' },
    el('img', {
      class: `sp-art${known ? '' : ' locked'}`,
      src: shiny ? sp.shinyPath : sp.imagePath,
      alt: known ? sp.name : ''
    }),
    el('div', { class: 'sp-meta' },
      el('h3', { text: known ? sp.name : '???' }),
      el('div', { class: 'sp-tags' },
        typeTag(sp.type),
        el('span', { class: 'tag', text: sp.stageLabel }),
        el('span', { class: `tag r-${sp.effectiveRarity}`, text: RARITY_NAMES[sp.effectiveRarity] }),
        el('span', { class: 'tag', text: SETS[sp.setKey]?.short || sp.setKey }),
        isBoss ? el('span', { class: 'tag legend', text: '\u2726 Gate boss' }) : null,
        /* Said outright in all three cases. The art alone cannot distinguish
           "registered, no shiny" from "not registered at all". */
        known
          ? el('span', { class: 'tag ok', text: '\u2713 Registered' })
          : el('span', { class: 'tag absent', text: '? Not registered' }),
        known
          ? (shiny
              ? el('span', { class: 'tag shiny', text: '\u2605 Shiny registered' })
              : el('span', { class: 'tag muted-tag', text: '\u2606 No shiny yet' }))
          : null
      ),
      sealNote(sp),
      el('div', { class: 'sp-counts' },
        el('span', {}, el('b', { text: String(store.timesCaught(sp.id)) }), ' caught'),
        el('span', {}, el('b', { text: String(store.timesEvolved(sp.id)) }), ' evolved')
      )
    )
  );

  /* ---- how you get it ---- */
  const howText = isBoss
    ? `Only from the Awakening Gate in ${MODES[sp.type].name}. Catch ${GATE_CATCHES_NEEDED} creatures in one game to open it.`
    : sp.stage === 1
      ? `Encounter Mode in ${MODES[sp.type].name}.`
      : 'Evolution Mode only \u2014 catch its earlier form, then evolve it in the same game.';
  const how = el('p', { class: 'hint', text: howText });

  /* ---- family line ---- */
  const line = lineagePath(sp.id);
  const branches = evolutionTargets(sp.id);
  const chain = line.length > 1 || branches.length > 1
    ? el('div', { class: 'sp-block' },
        el('h4', { text: 'Line' }),
        el('div', { class: 'chain' },
          line.map((member, i) => [
            i > 0 ? el('span', { class: 'arrow', text: '\u2192' }) : null,
            el('button', {
              class: `chain-link${member.id === sp.id ? ' current' : ''}${store.isRegistered(member.id) ? '' : ' locked'}`,
              type: 'button',
              onclick: () => renderSpeciesSheet(member)
            },
              el('img', { src: member.imagePath, alt: '', loading: 'lazy' }),
              el('small', { text: store.isRegistered(member.id) ? member.name : '???' })
            )
          ])
        ),
        branches.length > 1
          ? el('p', { class: 'hint', text: 'This one can go more than one way.' })
          : null
      )
    : null;

  /* ---- stats, purely for flavour ---- */
  const stats = sp.baseStats ? el('div', { class: 'sp-block' },
    el('h4', { text: 'Stats' }),
    el('div', { class: 'stat-rows' },
      STAT_KEYS.map(k => {
        const v = sp.baseStats[k] || 0;
        return el('div', { class: 'stat-row' },
          el('span', { class: 'sl', text: STAT_LABELS[k] }),
          el('span', { class: 'sbar' }, el('i', { style: { width: `${Math.min(100, v / 1.6)}%` } })),
          el('b', { text: String(v) })
        );
      })
    )
  ) : null;

  const moves = sp.moves?.length ? el('div', { class: 'sp-block' },
    el('h4', { text: 'Moves' }),
    el('div', { class: 'move-list' },
      sp.moves.map(m => el('div', { class: 'move' },
        el('b', { text: m.name }),
        el('small', { class: 'muted', text: m.power ? `power ${m.power}` : 'status' })
      ))
    )
  ) : null;

  fill(body, hero, how, chain, stats, moves);
}

/* ---------------------------------------------------------------
   High scores
   --------------------------------------------------------------- */

export function renderScores() {
  const body = $('#scores-body');
  if (!body) return;

  const best = store.s.best;

  const overall = el('div', { class: 'card best-card' },
    el('span', { class: 'muted small', text: 'Best game' }),
    el('b', { class: 'big-score', text: fmtScore(best.score) }),
    el('span', { class: 'muted small', text: best.type ? `${MODES[best.type].name} \u00b7 ${fmtDate(best.at)}` : 'No games yet' })
  );

  const tables = MODE_KEYS.map(key => {
    const rows = store.highScores(key);
    const mode = MODES[key];

    return el('div', { class: 'card score-card' },
      el('h4', { style: { color: mode.colour } },
        mode.name,
        el('small', { class: 'muted', text: ` \u00b7 ${modeType(key) || SETS[modeSet(key)].short}` })
      ),
      rows.length
        ? el('ol', { class: 'score-list' },
            rows.map((r, i) => el('li', {},
              el('span', { class: 'pos', text: `${i + 1}` }),
              el('b', { class: 'sc', text: fmtScore(r.score) }),
              el('span', { class: 'meta muted small' },
                `${r.caught} caught`,
                r.bossWins ? ` \u00b7 ${r.bossWins} boss` : '',
                r.discTier ? ` \u00b7 ${DISC_TIERS[r.discTier].short}` : '',
                ` \u00b7 ${fmtDate(r.at)}`
              )
            ))
          )
        : el('p', { class: 'empty', text: 'Nothing here yet.' })
    );
  });

  fill(body, overall, ...tables);
}

/* ---------------------------------------------------------------
   Profile
   --------------------------------------------------------------- */

export function renderProfile() {
  const body = $('#profile-body');
  if (!body) return;

  const s = store.s;
  const registered = store.registeredCount();
  const total = DB.species.length;
  const pct = Math.round(store.completion() * 100);

  const ring = el('div', { class: 'card ring-card' },
    el('div', { class: 'ring', style: { '--pct': `${pct}` } },
      el('span', { class: 'ring-num', text: `${pct}%` })
    ),
    el('div', { class: 'ring-meta' },
      el('b', { text: `${registered} / ${total}` }),
      el('span', { class: 'muted small', text: 'creatures registered' }),
      el('span', { class: 'muted small', text: `${store.shinyCount()} shiny` })
    )
  );

  const statRows = [
    ['Games played', fmtScore(s.stats.games)],
    ['Balls played', fmtScore(s.stats.balls)],
    ['Captures', fmtScore(s.stats.captures)],
    ['Got away', fmtScore(s.stats.escapes)],
    ['Evolutions', fmtScore(s.stats.evolutions)],
    ['Gate bosses beaten', fmtScore(s.stats.bossWins)],
    ['Shinies', fmtScore(s.stats.shinies)],
    ['Best multiplier', `\u00d7${Math.floor(s.stats.bestMultiplier)}`],
    ['Best disc', DISC_TIERS[Math.min(s.stats.bestDiscTier, DISC_TIERS.length - 1)].name],
    ['Total score', fmtShort(s.stats.totalScore)],
    ['Time played', fmtDuration(s.stats.playMs)]
  ];

  const stats = el('div', { class: 'card stats-grid' },
    statRows.map(([label, value]) => el('div', {},
      el('span', { class: 'muted', text: label }),
      el('b', { text: value })
    ))
  );

  /**
   * Boss progress, one row per set.
   *
   * Both rows, because the second is the reward for finishing the first: seeing
   * the sealed Galactic row is how you learn there is one.
   */
  const bossRows = SET_KEYS.map(key => {
    /* Exclusives are the Raid Vault's five, so the whole row is sealed or open
       together rather than per type. */
    const vaultSet = modeSet('Exclusives') === key;
    const rowSealed = vaultSet && !store.modeUnlocked('Exclusives');

    return el('div', { class: 'boss-set' },
      el('span', { class: 'muted small', text: SETS[key].name }),
      el('div', { class: 'boss-grid' },
        TYPES.map(t => {
          const b = bossOfSet(key, t);
          const known = b ? store.isRegistered(b.id) : false;
          const sealed = vaultSet ? rowSealed
                                  : (key !== BASE_SET && !store.galacticBossUnlocked(t));
          const cls = `boss-cell${known ? ' got' : ''}${sealed && !known ? ' sealed' : ''}`;
          return el('div', { class: cls },
            b ? el('img', { src: b.imagePath, alt: '', loading: 'lazy' }) : null,
            el('small', { text: b ? (known ? b.name : '???') : '\u2014' }),
            el('span', { class: 'muted small', text: known ? '\u2713' : t })
          );
        })
      )
    );
  });

  const bosses = el('div', { class: 'card' },
    el('h4', { text: 'Awakening Gate' }),
    bossRows,
    el('p', { class: 'muted small', text:
      'Beat a type\u2019s Awakening legendary and its Galactic one joins that ' +
      'gate, at even odds with the first. The Raid Vault fields all five of its ' +
      'own at once, one in five each.' })
  );

  fill(body, ring, stats, bosses, renderSettingsCard(), renderSaveCard());
}

/* ---------------------------------------------------------------
   Settings
   --------------------------------------------------------------- */

const TOGGLES = [
  ['sound', 'Sound', 'Synthesised effects. No downloads, no files.'],
  ['haptics', 'Vibration', 'A short buzz on big hits. Ignored where unsupported.'],
  ['showTrail', 'Ball trail', 'Easier to follow a fast ball. Costs a little battery.'],
  ['motion', 'Screen shake', 'Turn off if motion bothers you.'],
  ['leftHanded', 'Swap flippers', 'Left side of the screen works the right flipper.']
];

export function renderSettingsCard() {
  const rows = TOGGLES.map(([key, label, hint]) => el('label', { class: 'opt-toggle' },
    el('input', {
      type: 'checkbox',
      checked: !!store.setting(key),
      onchange: e => {
        store.setSetting(key, e.target.checked);
        window.dispatchEvent(new CustomEvent('settingchange', { detail: { key, value: e.target.checked } }));
      }
    }),
    el('span', {}, el('b', { text: label }), el('small', { class: 'muted', text: hint }))
  ));

  const flipperMode = el('label', { class: 'sel' },
    el('span', { text: 'Flippers' }),
    el('select', {
      onchange: e => store.setSetting('flipperMode', e.target.value)
    },
      el('option', { value: 'halves', text: 'Tap screen halves', selected: store.setting('flipperMode') === 'halves' }),
      el('option', { value: 'buttons', text: 'On-screen buttons', selected: store.setting('flipperMode') === 'buttons' })
    )
  );

  return el('div', { class: 'card' },
    el('h4', { text: 'Settings' }),
    flipperMode,
    ...rows
  );
}

/* ---------------------------------------------------------------
   Save management
   --------------------------------------------------------------- */

export function renderSaveCard() {
  const status = el('p', { class: 'muted small', id: 'save-status', text: 'Checking storage\u2026' });

  const card = el('div', { class: 'card' },
    el('h4', { text: 'Save data' }),
    status,
    el('div', { class: 'btn-row' },
      el('button', {
        class: 'btn', type: 'button', text: 'Link save file on device',
        onclick: async () => {
          try { await store.linkFile(); toast('Save file linked.', { kind: 'good' }); renderProfile(); }
          catch (e) { toast(e.message || 'Could not link a file.', { kind: 'bad' }); }
        }
      }),
      el('button', {
        class: 'btn ghost', type: 'button', text: 'Download backup',
        onclick: () => { store.download(); toast(`Saved ${SAVE_FILENAME}`); }
      })
    ),
    el('div', { class: 'btn-row' },
      el('label', { class: 'btn ghost file-label' },
        'Import backup\u2026',
        el('input', {
          type: 'file', accept: 'application/json,.json', hidden: true,
          onchange: async e => {
            const file = e.target.files?.[0];
            if (!file) return;
            try {
              const data = JSON.parse(await file.text());
              const ok = await confirmSheet({
                title: 'Replace your Collection?',
                body: 'Importing a backup overwrites everything currently saved on this device.',
                confirm: 'Import',
                danger: true
              });
              if (!ok) return;
              await store.adopt(data);
              toast('Backup imported.', { kind: 'good' });
              renderProfile();
              renderCollection();
            } catch {
              toast('That file could not be read.', { kind: 'bad' });
            }
          }
        })
      ),
      el('button', {
        class: 'btn danger', type: 'button', text: 'Reset everything',
        onclick: async () => {
          const ok = await confirmSheet({
            title: 'Reset all progress?',
            body: 'Your whole Collection, every high score and all settings are erased. This cannot be undone.',
            confirm: 'Erase it all',
            danger: true
          });
          if (!ok) return;
          await store.reset();
          toast('Progress reset.');
          renderProfile();
          renderCollection();
          renderScores();
        }
      })
    ),
    el('p', {
      class: 'muted small',
      text: 'Linking a save file writes your Collection straight to device storage, so it survives clearing browser data. Add the game to your home screen for best results.'
    })
  );

  // Filled in asynchronously so the card can render immediately.
  describeSaveStatus().then(text => { status.textContent = text; });
  return card;
}

async function describeSaveStatus() {
  const { Persist } = await import('./persist.js');
  const st = Persist.status();
  const bits = [];

  bits.push(st.persisted ? 'Storage is marked persistent.' : 'Storage is not marked persistent.');
  if (st.linked && st.filePermission === 'granted') bits.push(`Writing to ${st.fileName}.`);
  else if (st.linked) bits.push('A save file is linked but needs permission again.');
  else if (st.supportsFS) bits.push('No device file linked yet.');
  else bits.push('This browser cannot write device files; use a backup instead.');

  const p = store.progress();
  bits.push(`${p.registered} registered, ${p.games} games played.`);
  return bits.join(' ');
}

/* ---------------------------------------------------------------
   Mode picker
   --------------------------------------------------------------- */

/**
 * The screen before a game: pick which type's table to play.
 *
 * Each card shows what that mode's centre does and how far through its
 * creatures you are, because the reason to pick one over another is usually
 * "I still need something from there".
 */
export function renderModePicker(onPick) {
  const body = $('#mode-body');
  if (!body) return;

  const cards = MODE_KEYS.map(key => {
    const mode = MODES[key];
    const set = modeSet(key);
    const type = modeType(key);
    const unlocked = store.modeUnlocked(key);

    /* A set-based table counts its whole set; a type table counts its type. */
    const have = set ? store.registeredCount(null, set) : store.registeredCount(type);
    const total = set ? store.speciesTotal(null, set) : store.speciesTotal(type);
    const best = store.bestFor(key);

    /* Every legendary the table can field, so the Vault shows all five. */
    const bosses = allBossesForMode(key);

    const vault = store.vaultProgress();

    return el('button', {
      class: `mode-card${unlocked ? '' : ' sealed'}`,
      type: 'button',
      style: { '--mode': mode.colour },
      disabled: !unlocked,
      onclick: () => { if (unlocked) onPick(key); }
    },
      el('div', { class: 'mc-top' },
        el('b', { text: mode.name }),
        el('span', {
          class: `tag${type ? ' t-' + type : ' t-any'}`,
          text: type || SETS[set]?.short || 'All types'
        })
      ),
      el('p', { class: 'muted small', text: mode.blurb }),
      unlocked
        ? el('div', { class: 'mc-foot' },
            el('span', { class: 'muted small', text: `${have}/${total} registered` }),
            best ? el('span', { class: 'muted small', text: `best ${fmtShort(best)}` }) : null,
            el('span', { class: 'mc-bosses' },
              bosses.map(b => el('span', {
                class: `mc-boss${store.isRegistered(b.id) ? ' got' : ''}`,
                title: b.name
              }, el('img', { src: b.imagePath, alt: '', loading: 'lazy' })))
            )
          )
        : el('p', { class: 'mc-locked small' },
            `\u{1f512} Register ${vault.needed} more creature${vault.needed === 1 ? '' : 's'} ` +
            `from Elemental Awakening or Galactic Adventures to open this table ` +
            `(${vault.registered} of ${vault.required}).`)
    );
  });

  fill(body, el('div', { class: 'mode-grid' }, cards));
}

/* ---------------------------------------------------------------
   Type shift offer
   --------------------------------------------------------------- */

export function renderShiftOffer(payload, { onChoose, onDecline }) {
  const body = $('#shift-body');
  if (!body) return;

  fill(body,
    el('p', { class: 'hint', text: 'Move to another table. Your score, your disc and everything you have caught come with you.' }),
    el('div', { class: 'shift-grid' },
      payload.types.map(t => {
        const set = modeSet(t);
        const have = set ? store.registeredCount(null, set) : store.registeredCount(t);
        const total = set ? store.speciesTotal(null, set) : store.speciesTotal(t);
        return el('button', {
          class: 'shift-card', type: 'button', style: { '--mode': MODES[t].colour },
          onclick: () => { closeSheet('sheet-shift'); onChoose(t); }
        },
          el('b', { text: MODES[t].name }),
          el('small', { class: 'muted', text: `${have}/${total}` })
        );
      })
    ),
    el('div', { class: 'btn-row' },
      el('button', {
        class: 'btn ghost wide', type: 'button', text: 'Stay here',
        onclick: () => { closeSheet('sheet-shift'); onDecline(); }
      })
    ),
    el('p', { class: 'muted small', text: `${payload.charges} shift${payload.charges === 1 ? '' : 's'} banked. Work the spinner lane for more.` })
  );

  openSheet('sheet-shift');
}

/* ---------------------------------------------------------------
   Reveals
   --------------------------------------------------------------- */

/**
 * The capture / evolution / boss reveal.
 *
 * One renderer for all three because they are the same moment — a creature
 * joining the Collection — and the differences are a headline and a colour.
 */
export function renderReveal(kind, p) {
  const body = $('#reveal-body');
  if (!body) return;

  const sp = kind === 'evolve' ? p.to : p.species;
  if (!sp) return;

  const headline = kind === 'evolve' ? 'Evolved!'
    : kind === 'bossWin' ? 'Legendary caught!'
    : 'Caught!';

  const shiny = !!p.shiny;

  fill(body,
    el('div', { class: `reveal-card${shiny ? ' shiny' : ''}${kind === 'bossWin' ? ' legend' : ''}` },
      p.isNew ? el('div', { class: 'new-banner', text: 'NEW!' }) : null,
      el('span', { class: 'reveal-kind', text: headline }),
      el('img', {
        class: 'reveal-art',
        src: shiny ? sp.shinyPath : sp.imagePath,
        alt: sp.name
      }),
      el('h3', { text: sp.name }),
      el('div', { class: 'reveal-tags' },
        typeTag(sp.type),
        el('span', { class: 'tag', text: sp.stageLabel }),
        el('span', { class: `tag r-${sp.effectiveRarity}`, text: RARITY_NAMES[sp.effectiveRarity] }),
        shiny ? el('span', { class: 'tag shiny', text: '\u2605 Shiny' }) : null
      ),
      kind === 'evolve'
        ? el('p', { class: 'muted small', text: `${p.from.name} became ${sp.name}.` })
        : el('p', { class: 'muted small', text: `+${fmtScore(p.score || 0)}` }),
      p.isNewShiny && !p.isNew
        ? el('p', { class: 'hint', text: 'First shiny of this one.' })
        : null,
      el('button', {
        class: 'btn primary wide', type: 'button', text: 'Nice!',
        onclick: () => closeSheet('sheet-reveal')
      })
    )
  );

  openSheet('sheet-reveal');
}

/* ---------------------------------------------------------------
   Game over
   --------------------------------------------------------------- */

export function renderGameOver(p, { onAgain, onModes }) {
  const body = $('#gameover-body');
  if (!body) return;

  const mode = MODES[p.type];
  const newRegistrations = p.caught
    .map(c => speciesById(c.speciesId))
    .filter(Boolean);

  fill(body,
    el('div', { class: 'go-head' },
      el('span', { class: 'muted small', text: mode.name }),
      el('b', { class: 'big-score', text: fmtScore(p.score) }),
      p.isBest
        ? el('span', { class: 'tag best', text: '\u2605 Best ever' })
        : p.rank
          ? el('span', { class: 'tag', text: `#${p.rank} in ${p.type}` })
          : el('span', { class: 'muted small', text: 'Did not place' })
    ),

    el('div', { class: 'go-stats' },
      el('div', {}, el('b', { text: String(p.catches) }), el('span', { class: 'muted', text: 'caught' })),
      el('div', {}, el('b', { text: String(p.evolutions) }), el('span', { class: 'muted', text: 'evolved' })),
      el('div', {}, el('b', { text: String(p.bossWins) }), el('span', { class: 'muted', text: 'bosses' })),
      el('div', {}, el('b', { text: String(p.escapes) }), el('span', { class: 'muted', text: 'got away' })),
      el('div', {}, el('b', { text: DISC_TIERS[p.discTier].short }), el('span', { class: 'muted', text: 'disc' }))
    ),

    newRegistrations.length
      ? el('div', { class: 'go-caught' },
          el('h4', { text: 'This game' }),
          el('div', { class: 'caught-strip' },
            p.caught.map(c => {
              const sp = speciesById(c.speciesId);
              if (!sp) return null;
              return el('button', {
                class: `caught-chip${c.shiny ? ' shiny' : ''}`,
                type: 'button',
                onclick: () => openSpecies(sp)
              },
                el('img', { src: c.shiny ? sp.shinyPath : sp.imagePath, alt: '', loading: 'lazy' }),
                el('small', { text: sp.name })
              );
            })
          )
        )
      : el('p', { class: 'hint', text: 'Nothing caught. Clear the C-A-T-C-H bank, then shoot the Well.' }),

    el('div', { class: 'btn-row' },
      el('button', { class: 'btn ghost', type: 'button', text: 'Change table', onclick: () => { closeSheet('sheet-gameover'); onModes(); } }),
      el('button', { class: 'btn primary', type: 'button', text: 'Play again', onclick: () => { closeSheet('sheet-gameover'); onAgain(p.type); } })
    )
  );

  openSheet('sheet-gameover');
}

/* ---------------------------------------------------------------
   How to play
   --------------------------------------------------------------- */

const RULES = [
  ['Flippers', 'Tap the left or right half of the screen. Hold to cradle the ball on the bat.'],
  ['Launch', 'Hold anywhere and let go to plunge. The longer you hold, the harder it goes.'],
  ['Nudge', 'Swipe sideways to shove the table. Lean on it and it tilts, and you lose the ball.'],
  ['Lane change', 'Each flipper press slides the lit lanes and letters one place that way. Line up the one you need with wherever the ball is heading.'],
  ['C-A-T-C-H', 'Knock down all five drop targets to arm an encounter, then shoot the Awakening Well.'],
  ['Encounter', 'Hit the creature before the clock runs out. Rarer creatures take more hits.'],
  ['A, B, C lanes', 'Roll through all three to upgrade your disc: Capture, Great, Ultra, Master. A better disc needs fewer hits to catch.'],
  ['Ramps', 'Three ramp shots arm Evolution Mode. You can only evolve something you caught this game.'],
  ['Evolution', 'Knock three targets for shards, then hit the creature. Stage 2 and 3 creatures exist nowhere else.'],
  ['Awakening Gate', 'Catch three creatures in one game to open it. Beat the legendary to add it to your Collection.'],
  ['Spinner', 'Builds your multiplier, and every twelve spins banks a table shift.'],
  ['The Collection', 'Everything you register is kept forever. Scores and creatures caught in a game are not \u2014 only the Collection carries over.']
];

/** The short version, shown at the top of the guide screen. */
function quickRules() {
  return el('div', { class: 'card' },
    el('h4', { text: 'The basics' }),
    el('div', { class: 'rules' },
      RULES.map(([term, text]) => el('div', { class: 'rule' },
        el('b', { text: term }),
        el('span', { class: 'muted small', text })
      ))
    )
  );
}

/* ---------------------------------------------------------------
   Full guide
   --------------------------------------------------------------- */

/**
 * The long version: every feature, with its actual numbers.
 *
 * The numbers are read out of data.js rather than written here. A guide that
 * restates its tuning is a guide that goes quietly wrong the first time
 * anything is re-balanced, and a wrong guide is worse than none.
 *
 * Collapsed sections, because this is genuinely long and nobody wants to
 * scroll past the bit they already know.
 */
export function renderGuide() {
  const body = $('#guide-body');
  if (!body) return;

  /* ---- small builders ---- */

  const para = text => el('p', { class: 'g-p', text });

  const defs = rows => el('dl', { class: 'g-defs' },
    rows.map(([term, text]) => [
      el('dt', { text: term }),
      el('dd', { text })
    ])
  );

  const table = (head, rows) => el('table', { class: 'g-table' },
    el('thead', {}, el('tr', {}, head.map(h => el('th', { text: h })))),
    el('tbody', {}, rows.map(r => el('tr', {}, r.map(c => el('td', { text: String(c) })))))
  );

  const section = (title, ...content) => el('details', { class: 'g-section' },
    el('summary', {}, el('b', { text: title })),
    el('div', { class: 'g-body' }, content)
  );

  /* ---- derived numbers ---- */

  const discRows = DISC_TIERS.map((d, i) => [
    d.name,
    `\u00d7${d.power}`,
    `\u00d7${d.score}`,
    i === 0 ? 'start of every game' : `${i} lane set${i === 1 ? '' : 's'}`
  ]);

  const rarityRows = [1, 2, 3, 4, 5].map(r => [
    `${r} \u00b7 ${RARITY_NAMES[r]}`,
    r === 5 ? 'gate only' : `${RARITY_WEIGHTS[r]}`,
    `${CAPTURE_METER[r]}`,
    `${CAPTURE_SECONDS[r]}s`,
    fmtScore(SCORE.captureRarity[r])
  ]);

  /* Pool sizes are counted per set, because until Galactic is unlocked only the
     first number is what the player will actually meet. */
  const modeRows = TYPES.map(t => {
    const pool = DB.pools.get(t) || {};
    const countFor = key => [1, 2, 3, 4]
      .map(r => (pool[r] || []).filter(s => s.setKey === key).length).join('/');
    return [
      MODES[t].name, t,
      countFor('ea'), countFor('ga'),
      [bossOf(t)?.name, bossOfSet('ga', t)?.name].filter(Boolean).join(' / ') || '\u2014'
    ];
  });

  fill(body,
    quickRules(),

    el('h4', { class: 'g-heading', text: 'Everything, in detail' }),
    para('In roughly the order you will meet it. Tap a heading to open it.'),

    /* ============ CONTROLS ============ */
    section('Controls',
      defs([
        ['Flippers', 'Tap or hold the left or right half of the screen. Both halves work independently, so you can hold one flipper and tap the other. Swap them in Profile if you would rather the sides were the other way round.'],
        ['Holding a flipper', 'Keeps the bat raised. A ball landing on a raised bat stays there, which is called cradling: it lets you stop, look at the table and pick a shot instead of batting at everything that comes down.'],
        ['Lane change', 'Every flipper press slides the lit A-B-C lanes and the lit C-A-T-C-H letters one place sideways \u2014 right flipper moves them right, left flipper moves them left, wrapping round the ends. So you never have to hit a particular lane: line the one you still need up with wherever the ball is already going. If B is lit and the ball is heading for B, press right and it becomes C.'],
        ['Where you hit matters', 'The bat throws hardest at its tip and softest near the pivot, roughly 255 against 175 units per second. A ball caught near the pivot is also more likely to be clipped a second time by the bat sweeping past, which fires it off at an odd angle. Cradle, then shoot from the tip.'],
        ['Launching', 'Press and hold anywhere on the table, then let go. The longer you hold, the harder the plunge. Even the softest one clears the lane, so a light tap is a soft shot rather than a failed one.'],
        ['Nudging', 'Flick sideways across the table. This shoves the whole cabinet and can save a ball that is on its way down an outlane.'],
        ['On-screen buttons', 'If you would rather have visible flipper buttons than screen halves, switch to them in Profile.'],
        ['Keyboard', 'Left and right arrows, or Z and M, work the flippers. Space plunges. N and B nudge. Useful on a desktop.']
      ])
    ),

    /* ============ THE TABLE ============ */
    section('The table, part by part',
      defs([
        ['Flippers and the drain', 'The gap between the flipper tips is about one and a third ball widths. Anything down the middle is gone unless a flipper is there.'],
        ['Outlanes', 'The two channels outside the flippers. A ball down one of these is lost \u2014 unless that side\u2019s kickback is armed, in which case it is fired straight back up.'],
        ['Inlanes', 'The two channels inside the flippers, which feed the ball onto the bat. Rolling through one rearms that side\u2019s kickback, so working the return lanes keeps your saves stocked.'],
        ['Slingshots', 'The two rubber triangles above the flippers. They kick hard and are the main reason a ball comes back at you from nowhere.'],
        ['Pop bumpers', 'Three of them in the dome. They score and nudge your multiplier up, but they also send the ball wherever they like.'],
        ['Top lanes (A, B, C)', 'Three rollovers across the top. Collect all three to upgrade your disc.'],
        ['The C-A-T-C-H bank', 'Five drop targets across the middle. Knock all five down to arm an encounter. The bank then stands back up so you can do it again.'],
        ['The spinner', 'In the left orbit lane. Every pass racks up score and multiplier, and every twelve spins banks a table shift.'],
        ['Ramps', 'One entrance on each side. A ramp carries the ball over the playfield and drops it into the opposite inlane, so a left ramp feeds your right flipper. Three ramp shots arm Evolution Mode.'],
        ['The Awakening Well', 'The saucer in the middle, below the centre. Everything happens here: whatever you have armed starts when the ball drops in. With nothing armed it just scores and spits the ball back out.'],
        ['The centre', 'Different on every table. See "The five tables" below.']
      ])
    ),

    /* ============ DISCS ============ */
    section('Your disc',
      para('The ball is a capture disc, and a better disc catches creatures faster and scores more. Collect all three top lanes to upgrade. Once you are on a Master Disc, completing the lanes pays out instead.'),
      table(['Disc', 'Capture power', 'Score', 'From'], discRows),
      para('Capture power is how much of a creature\u2019s meter one hit removes. A Master Disc takes an Epic down in two hits where a plain disc needs six.')
    ),

    /* ============ ENCOUNTERS ============ */
    section('Encounter Mode \u2014 catching things',
      para('Knock down all five C-A-T-C-H targets, then shoot the Well. A creature appears in the upper playfield and drifts about. Hit it with the ball until its meter is full, before the clock runs out.'),
      para('Only first-stage creatures appear here. Rarer ones take more hits, drift faster and are worth far more.'),
      table(['Rarity', 'Chance', 'Hits', 'Time', 'Score'], rarityRows),
      para('Chance is relative weight, not a percentage, and it is spread across only the rarities that table actually has.'),
      defs([
        ['Shiny', `Every creature rolled has a ${(SHINY_ODDS * 100).toFixed(0)}% chance of being shiny, a gate boss twice that, and everything doubles again once your score passes ${fmtScore(SHINY_DOUBLE_AT)}. You will not miss one: it is announced when it appears, ringed with stars on the table, the mode banner turns gold and says SHINY, and it scores a large bonus. Shinies are tracked separately in your Collection.`],
        ['If it gets away', 'Running out of time or losing the ball loses the creature. Nothing else is lost \u2014 arm another encounter and try again.'],
        ['The centre clears out', 'For as long as a creature is out, the table\u2019s centre gimmick fades and stops touching the ball entirely \u2014 no vines, no ring, no gears, no updraught. The Well goes quiet too. The upper playfield is yours, so a mode can never be lost to a blocked shot.'],
        ['Repeat hits', 'The creature ignores hits for a fifth of a second after each one, so leaning the ball on it does nothing. Every real contact counts, however fast the ball was moving.'],
        ['A save comes with it', `Catching it also hands you ${CAPTURE_BALL_SAVE_SECONDS} seconds of ball save, so you can watch the reveal without defending a drain.`]
      ])
    ),

    /* ============ EVOLUTION ============ */
    section('Evolution Mode \u2014 the only way to get later stages',
      para(`Second and third stage creatures cannot be caught. They exist nowhere except Evolution Mode, which is ${DB.species.filter(s => s.stage > 1).length} of the ${DB.species.length} creatures in the game.`),
      defs([
        ['Arming it', 'Three ramp shots. If you have not caught anything evolvable yet the shot simply pays out instead, so it is never wasted.'],
        ['Starting it', 'Shoot the Well. The game picks the furthest-along creature you have caught this game, so a three-stage line keeps progressing rather than restarting.'],
        ['Doing it', `Knock down any ${EVOLUTION_SHARDS} targets to collect shards, then hit the creature. You have ${EVOLUTION_SECONDS} seconds. Hitting it before the shards are in still scores, it just does not evolve it.`],
        ['In one game', 'You can take a whole three-stage line from first to final form in a single game, as long as you keep arming Evolution Mode.'],
        ['Shinies carry across', 'Evolve a shiny and the evolved form is registered shiny too. It is the only way an evolved shiny can enter your Collection.'],
        ['Important', 'You can only ever evolve something you caught in the game you are playing. Nothing carries over between games except the Collection itself \u2014 exactly like the original games.']
      ])
    ),

    /* ============ BOSSES ============ */
    section('The Awakening Gate \u2014 legendaries',
      para(`Catch ${GATE_CATCHES_NEEDED} creatures in one game and the gate opens. Shoot the Well to face that table\u2019s legendary. It is the only way to get one.`),
      defs([
        ['The fight', `${CAPTURE_METER[5]} hits, ${BOSS_SECONDS} seconds.`],
        ['The shield', `It raises a shield every couple of seconds. Hits while it is up score a little but do no damage, so you cannot just sit on one repeated shot \u2014 you have to keep the ball moving and take your chances when the shield drops.`],
        ['If it escapes', 'The gate closes. Catch three more creatures to open it again.'],
        ['Two promoted bosses', 'Neutral and Celestial have no legendary of their own in the creature list, so Alpakina and Verdanthorn stand in as their gate bosses. That is why neither turns up as an ordinary catch on its table.']
      ])
    ),

    /* ============ SETS ============ */
    section('Three sets of creatures',
      para(`There are ${DB.species.length} creatures in the game, in three sets. Elemental Awakening (${store.speciesTotal(null, 'ea')}) is available from the start. Galactic Adventures (${store.speciesTotal(null, 'ga')}) is earned with it, one rarity at a time. Exclusives (${store.speciesTotal(null, 'ex')}) is a whole extra table, earned with both.`),
      table(['Unlocks', 'Awakening creatures registered'],
        GALACTIC_UNLOCKS.map(g => [`${RARITY_NAMES[g.rarity]} Galactic creatures`, String(g.registered)])),
      defs([
        ['Registered, not caught', 'It counts the creatures in your Collection, so evolving something counts just as much as catching it. Registering Galactic creatures does not help \u2014 only Awakening ones move the ladder.'],
        ['What unlocking does', 'Those creatures join the same rarity pool as their Awakening counterparts. It does not make rare creatures more common; it makes them more varied.'],
        ['Legendaries', 'Separate from the ladder. Beat a type\u2019s Awakening legendary and that type\u2019s Galactic legendary joins its gate. From then on the gate picks between the two at even odds, so the first one is still worth fighting.'],
        ['Already on your device', 'Every picture for both sets is stored the first time you open the game, so an unlock works straight away even with no connection.'],
        ['Where to look', 'The Collection has a tab per set. A creature you have not unlocked yet shows with a padlock, which is different from one you simply have not found.'],
        ['Exclusives', `A sixth table rather than a rarity ladder. Register ${VAULT_UNLOCK_REGISTERED} creatures across Elemental Awakening and Galactic Adventures together and the Raid Vault opens; every Exclusive is found there and nowhere else. Registering Exclusives does not count towards its own threshold.`],
        ['Rescaled rarities', 'Exclusives were raid rewards in the game they came from, so the files only use Rare to Legendary. Left alone the whole set would sit in the two rarest slots and almost never appear, so it is rescaled onto the normal Common to Epic spread \u2014 in the same proportions as the rest of the game. The order is kept: nothing that was rarer at source comes out commoner here.'],
        ['Five legendaries', 'The Raid Vault has its own five, one per type, and unlike the other tables they are all available the moment it opens \u2014 one in five each time you shoot the gate. The table itself was the thing you had to earn.']
      ])
    ),

    /* ============ THE TABLES ============ */
    section('The six tables',
      para('Every table shares the same flippers, drain, lanes, bumpers, ramps and Well, so they all handle the same way. Only the centre changes \u2014 and which creatures you can find.'),
      table(['Table', 'Type', 'Awakening 1/2/3/4', 'Galactic 1/2/3/4', 'Gate legendaries'], modeRows),
      defs([
        ['Wildwood Green', 'The gentle one. Three herd lanes to sweep, two stumps flanking a wide open shot up the middle to the Well. Six of its ten catchables are Common, which makes it the place to start.'],
        ['Raid Vault', `Locked until you have registered ${VAULT_UNLOCK_REGISTERED} creatures across the first two sets. Two rings turn around a core, each with one gap, in opposite directions at different speeds. Both gaps line up only now and then, and the rings glow when they do \u2014 that is the moment to shoot the middle. The core is worth as much as clearing the whole target bank.`],
        ['Rune Sanctum', 'A horseshoe ring around a spinning rune disc. Feed the ball in from below and the disc bats it around; the more you work the spinner, the faster the disc turns.'],
        ['Gale Spire', 'An updraught in the middle that lifts the ball against gravity, gusting on and off every few seconds. Fast, loose and hard to predict.'],
        ['Starbloom Grove', 'Four vines standing across the approach to the Well. Hitting one cuts it, but they grow back after a few seconds, so it is a race: clear a path faster than it closes.'],
        ['Cogwork Foundry', 'Two live gears turning against each other, which speed up as they heat. It scores hardest and drains hardest \u2014 a gear will happily fire the ball straight down the middle.']
      ])
    ),

    /* ============ SHIFTING ============ */
    section('Shifting tables mid-game',
      para(`Every ${SPINS_PER_SHIFT} spins of the spinner banks a table shift. Next time you drop into the Well with nothing else armed, you will be offered a move to another table.`),
      defs([
        ['What comes with you', 'Your score, your disc, your balls remaining and everything you have caught this game.'],
        ['What resets', 'The table itself, so the C-A-T-C-H bank and the top lanes start over, and you get a fresh ball on the plunger.'],
        ['Why bother', 'Each table only has its own type\u2019s creatures. Shifting is how you finish more than one Collection in a single good game.'],
        ['No rush', 'The ball waits in the Well until you decide, and declining keeps the charge for later.']
      ])
    ),

    /* ============ SCORING ============ */
    section('Score, multiplier and extra balls',
      defs([
        ['Multiplier', `Bumpers and the spinner build it, up to \u00d7${MAX_MULTIPLIER}. It resets with each new ball, so it is worth building early in a ball rather than hoarding it.`],
        ['Disc multiplier', 'Your disc tier multiplies everything on top of that, and unlike the multiplier it lasts the whole game.'],
        ['Big awards', 'Captures, evolutions, boss wins, completing the bank and disc upgrades are fixed amounts. They are already large and deliberately do not get multiplied again.'],
        ['Extra balls', `Awarded at ${EXTRA_BALL_AT.map(fmtScore).join(', ')} points, once each per game.`],
        ['Where the points really are', 'Creatures. A single Epic capture is worth more than a long rally, and a legendary is worth more than everything else on the table put together.'],
        ['Shiny odds double', `Past ${fmtScore(SHINY_DOUBLE_AT)} points every creature you meet for the rest of the game is twice as likely to be shiny. It is the one reason to keep pushing a good game rather than starting a fresh one.`]
      ])
    ),

    /* ============ SAVES ============ */
    section('Losing balls, saves and tilt',
      defs([
        ['Balls', `${BALLS_PER_GAME} per game, plus any extras. When they are gone the game is over and the next one starts fresh.`],
        ['Ball save', `The first ${BALL_SAVE_SECONDS} seconds of every ball. Drain inside that and the ball is returned to the plunger. It is used up the moment it fires.`],
        ['Reward save', `Landing a capture, an evolution or a boss also gives you ${CAPTURE_BALL_SAVE_SECONDS} seconds of save, because the ball is always loose and fast at that moment and there is a reveal on screen. You will not lose the ball to the thing you just earned.`],
        ['Kickbacks', 'One per outlane, shown as the arrows at the bottom of the screen. Green means armed. Roll an inlane to rearm that side.'],
        ['Tilt', 'Nudging too hard or too often tilts the table. The flippers go dead and the ball is lost. The warning appears before it happens, so back off when you see it.'],
        ['Ball search', 'If the ball somehow ends up somewhere it cannot get out of, the game will shove it loose by itself after a few seconds. You should never need to restart because of a stuck ball.']
      ])
    ),

    /* ============ COLLECTION ============ */
    section('Your Collection',
      para('This is the only thing that lasts. Scores are recorded, but the creatures you caught in a game are not carried into the next one \u2014 what persists is the record that you caught them.'),
      defs([
        ['Registered', 'Catch or evolve a creature once and it is yours in the Collection forever, even if you never see it again.'],
        ['Reading the grid', 'A key sits under the header. A creature you have not registered is a dark outline with a dashed edge and a ? badge, and its name reads "Not found". A gold star means you have a shiny of it \u2014 shown in the ordinary view as well as the shiny one, so you can see at a glance which of yours are shiny. A padlock means it cannot appear yet at all, which is a different thing from not having found it.'],
        ['Shiny view', 'The star button switches the Collection to shiny mode, which tracks a separate set: which creatures you have caught a shiny of.'],
        ['Stages', 'Cells are grouped by stage, so a family reads down the grid. Tap any creature to see its whole line, including the parts you have not found.'],
        ['Backups', 'Profile has a save file link, a download and an import. Linking a file writes your Collection straight to device storage so it survives clearing browser data. Worth doing once.']
      ])
    ),

    /* ============ OFFLINE ============ */
    section('Playing offline',
      para('The whole game is stored on your device the first time you open it, including every creature picture. After that it runs with no connection at all.'),
      para('Add it to your home screen and it opens like an app, full screen and portrait.')
    )
  );
}
