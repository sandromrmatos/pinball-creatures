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
  EXTRA_BALL_AT, MAX_MULTIPLIER, SHINY_ODDS, SCORE,
  speciesById, lineagePath, evolutionTargets, bossOf, speciesOfType
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
 *   not registered        silhouette, name and type hidden
 *   shiny mode, no shiny  silhouette of the *shiny* art
 */
function collectionCell(sp, { shinyMode, onOpen }) {
  const known = store.isRegistered(sp.id);
  const gotShiny = store.hasShiny(sp.id);
  const got = shinyMode ? gotShiny : known;
  const isBoss = sp.effectiveRarity === 5;

  const classes = ['cell'];
  if (shinyMode) classes.push(got ? 'shiny' : 'shadow');
  else if (!known) classes.push('locked');
  if (isBoss) classes.push('legendary');

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

  return el('button', {
    class: classes.join(' '),
    type: 'button',
    'aria-label': known ? sp.name : 'Not yet registered',
    onclick: () => onOpen(sp)
  },
    rarityPip(sp.effectiveRarity),
    shinyMode && got ? el('span', { class: 'shiny-star', text: '\u2605' }) : null,
    img,
    el('span', { class: 'nm', text: known ? sp.name : '???' }),
    el('span', { class: `sub ${got ? 't-' + sp.type : ''}`, text: got ? sp.type : (known ? sp.type : '???') }),
    el('span', { class: 'stg', text: `S${sp.stage}` })
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
  const shinyMode = !!store.s.ui.collectionShiny;
  const mode = MODES[type];

  const list = speciesOfType(type);
  const total = list.length;
  const have = shinyMode ? store.shinyCount(type) : store.registeredCount(type);

  /* ---- type tabs ---- */
  const tabs = el('div', { class: 'type-tabs' },
    TYPES.map(t => el('button', {
      class: `type-tab t-${t}${t === type ? ' active' : ''}`,
      type: 'button',
      onclick: () => { store.setUi('collectionType', t); renderCollection(); }
    },
      el('b', { text: t }),
      el('small', { text: `${shinyMode ? store.shinyCount(t) : store.registeredCount(t)}/${store.speciesTotal(t)}` })
    ))
  );

  /* ---- header ---- */
  const head = el('div', { class: 'collection-head' },
    el('div', { class: 'ch-title' },
      el('h3', { text: mode.name, style: { color: mode.colour } }),
      el('p', { class: 'muted small', text: mode.blurb })
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
    el('i', { style: { width: `${pct}%`, background: mode.colour } })
  );

  /* ---- the boss, called out ---- */
  const boss = bossOf(type);
  const bossRow = boss ? el('div', { class: 'boss-row' },
    el('span', { class: 'muted small', text: 'Awakening Gate' }),
    el('button', {
      class: `boss-chip${store.isRegistered(boss.id) ? ' got' : ''}`,
      type: 'button',
      onclick: () => openSpecies(boss)
    },
      el('img', { src: boss.imagePath, alt: '', loading: 'lazy' }),
      el('b', { text: store.isRegistered(boss.id) ? boss.name : '???' }),
      store.bossWins(type) > 0
        ? el('small', { text: `beaten ${store.bossWins(type)}\u00d7` })
        : el('small', { class: 'muted', text: 'not beaten' })
    )
  ) : null;

  /* ---- the grid, grouped by stage so lines read top to bottom ---- */
  const grid = el('div', { class: 'grid' },
    list
      .slice()
      .sort((a, b) => (a.stage - b.stage) || (a.order - b.order))
      .map(sp => collectionCell(sp, { shinyMode, onOpen: openSpecies }))
  );

  fill(body, tabs, head, bar, bossRow, grid);
}

/* ---------------------------------------------------------------
   Species sheet
   --------------------------------------------------------------- */

export function openSpecies(sp) {
  renderSpeciesSheet(sp);
  openSheet('sheet-species');
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
        isBoss ? el('span', { class: 'tag legend', text: '\u2726 Gate boss' }) : null,
        shiny ? el('span', { class: 'tag shiny', text: '\u2605 Shiny' }) : null
      ),
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

  const tables = TYPES.map(type => {
    const rows = store.highScores(type);
    const mode = MODES[type];

    return el('div', { class: 'card score-card' },
      el('h4', { style: { color: mode.colour } },
        mode.name,
        el('small', { class: 'muted', text: ` \u00b7 ${type}` })
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

  /* ---- per-mode boss progress ---- */
  const bosses = el('div', { class: 'card' },
    el('h4', { text: 'Awakening Gate' }),
    el('div', { class: 'boss-grid' },
      TYPES.map(t => {
        const b = bossOf(t);
        const wins = store.bossWins(t);
        return el('div', { class: `boss-cell${wins ? ' got' : ''}` },
          b ? el('img', { src: b.imagePath, alt: '', loading: 'lazy' }) : null,
          el('small', { text: b ? (store.isRegistered(b.id) ? b.name : '???') : '\u2014' }),
          el('span', { class: 'muted small', text: wins ? `${wins}\u00d7` : t })
        );
      })
    )
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

  const cards = TYPES.map(type => {
    const mode = MODES[type];
    const boss = bossOf(type);
    const have = store.registeredCount(type);
    const total = store.speciesTotal(type);
    const best = store.bestFor(type);

    return el('button', {
      class: 'mode-card',
      type: 'button',
      style: { '--mode': mode.colour },
      onclick: () => onPick(type)
    },
      el('div', { class: 'mc-top' },
        el('b', { text: mode.name }),
        el('span', { class: `tag t-${type}`, text: type })
      ),
      el('p', { class: 'muted small', text: mode.blurb }),
      el('div', { class: 'mc-foot' },
        el('span', { class: 'muted small', text: `${have}/${total} registered` }),
        best ? el('span', { class: 'muted small', text: `best ${fmtShort(best)}` }) : null,
        boss ? el('span', {
          class: `mc-boss${store.isRegistered(boss.id) ? ' got' : ''}`,
          title: boss.name
        }, el('img', { src: boss.imagePath, alt: '', loading: 'lazy' })) : null
      )
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
      payload.types.map(t => el('button', {
        class: 'shift-card', type: 'button', style: { '--mode': MODES[t].colour },
        onclick: () => { closeSheet('sheet-shift'); onChoose(t); }
      },
        el('b', { text: MODES[t].name }),
        el('small', { class: 'muted', text: `${store.registeredCount(t)}/${store.speciesTotal(t)}` })
      ))
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
  ['C-A-T-C-H', 'Knock down all five drop targets to arm an encounter, then shoot the Awakening Well.'],
  ['Encounter', 'Hit the creature before the clock runs out. Rarer creatures take more hits.'],
  ['A, B, C lanes', 'Roll through all three to upgrade your disc: Capture, Great, Ultra, Master. A better disc needs fewer hits to catch.'],
  ['Ramps', 'Three ramp shots arm Evolution Mode. You can only evolve something you caught this game.'],
  ['Evolution', 'Knock three targets for shards, then hit the creature. Stage 2 and 3 creatures exist nowhere else.'],
  ['Awakening Gate', 'Catch three creatures in one game to open it. Beat the legendary to add it to your Collection.'],
  ['Spinner', 'Builds your multiplier, and every twelve spins banks a table shift.'],
  ['The Collection', 'Everything you register is kept forever. Scores and creatures caught in a game are not \u2014 only the Collection carries over.']
];

export function renderHelp() {
  const body = $('#help-body');
  if (!body) return;
  fill(body,
    el('div', { class: 'rules' },
      RULES.map(([term, text]) => el('div', { class: 'rule' },
        el('b', { text: term }),
        el('span', { class: 'muted small', text })
      ))
    ),
    el('div', { class: 'btn-row' },
      el('button', {
        class: 'btn primary wide', type: 'button', text: 'Full guide \u2014 every detail',
        onclick: () => { renderGuide(); openSheet('sheet-guide'); }
      })
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

  const modeRows = TYPES.map(t => {
    const pool = DB.pools.get(t) || {};
    const counts = [1, 2, 3, 4].map(r => (pool[r] || []).length).join(' / ');
    return [MODES[t].name, t, counts, bossOf(t)?.name || '\u2014'];
  });

  fill(body,
    para('Everything the game does, in order of when you will meet it. Tap a heading to open it.'),

    /* ============ CONTROLS ============ */
    section('Controls',
      defs([
        ['Flippers', 'Tap or hold the left or right half of the screen. Both halves work independently, so you can hold one flipper and tap the other. Swap them in Profile if you would rather the sides were the other way round.'],
        ['Holding a flipper', 'Keeps the bat raised. A ball landing on a raised bat stays there, which is called cradling: it lets you stop, look at the table and pick a shot instead of batting at everything that comes down.'],
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
        ['Shiny', `Every creature rolled has a ${(SHINY_ODDS * 100).toFixed(0)}% chance of being shiny, and a gate boss twice that. Shinies are marked with a star, score a large bonus, and are tracked separately in your Collection.`],
        ['If it gets away', 'Running out of time or losing the ball loses the creature. Nothing else is lost \u2014 arm another encounter and try again.'],
        ['One hit per approach', 'The ball has to leave the creature and come back for the next hit to count, so resting against it does nothing.']
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

    /* ============ THE FIVE TABLES ============ */
    section('The five tables',
      para('Every table shares the same flippers, drain, lanes, bumpers, ramps and Well, so they all handle the same way. Only the centre changes \u2014 and which creatures you can find.'),
      table(['Table', 'Type', 'Pool by rarity 1/2/3/4', 'Gate boss'], modeRows),
      defs([
        ['Wildwood Green', 'The gentle one. Three herd lanes to sweep, two stumps flanking a wide open shot up the middle to the Well. Six of its ten catchables are Common, which makes it the place to start.'],
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
        ['Where the points really are', 'Creatures. A single Epic capture is worth more than a long rally, and a legendary is worth more than everything else on the table put together.']
      ])
    ),

    /* ============ SAVES ============ */
    section('Losing balls, saves and tilt',
      defs([
        ['Balls', `${BALLS_PER_GAME} per game, plus any extras. When they are gone the game is over and the next one starts fresh.`],
        ['Ball save', `The first ${BALL_SAVE_SECONDS} seconds of every ball. Drain inside that and the ball is returned to the plunger. It is used up the moment it fires.`],
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
        ['Silhouettes', 'A creature you have not registered shows as a dark outline with its name hidden, so you can see what is still missing.'],
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
