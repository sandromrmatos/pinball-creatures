/* ============================================================
   game.js — the rules

   Everything that turns a bouncing circle into a game: three balls, the
   score, what each target is worth, and the three sub-modes the Awakening
   Well leads to.

   The split from table.js is deliberate and strict. The table knows only
   geometry and stamps a `meta.role` on each collider; this module reads
   those roles and decides what a contact means. So retuning the rules never
   moves a wall, and moving a wall never changes a score.

   State lives in two places and only two:
     • `run`  — the current game. Thrown away completely at game over,
                because a game of pinball is three balls long and nothing
                but the Collection survives it.
     • store  — the save. Only ever written through recordCapture,
                recordEvolution, recordBossWin and endGame.
   ============================================================ */

import {
  MODES, TYPES, SCORE, DISC_TIERS, MAX_DISC_TIER, MAX_MULTIPLIER,
  BALLS_PER_GAME, BALL_SAVE_SECONDS, CAPTURE_BALL_SAVE_SECONDS,
  EXTRA_BALL_AT, GATE_CATCHES_NEEDED,
  CAPTURE_METER, CAPTURE_SECONDS, CAPTURE_DRIFT,
  EVOLUTION_SHARDS, EVOLUTION_SECONDS,
  BOSS_SECONDS, BOSS_SHIELD_SECONDS,
  SHINY_ODDS, SHINY_DOUBLE_AT,
  rollEncounter, bossOf, speciesById, evolutionTargets,
  chance, clamp, pick, randRange
} from './data.js';

import { circle } from './physics.js';
import { buildTable, newBall, launchImpulse, LAYOUT } from './table.js';
import { store } from './state.js';

/* ---------------------------------------------------------------
   Phases
   --------------------------------------------------------------- */

export const PHASE = {
  IDLE: 'idle',              // no game in progress
  PLUNGE: 'plunge',          // ball sitting in the shooter lane
  PLAY: 'play',              // ordinary play
  SAUCER: 'saucer',          // ball held in the Well, deciding what happens
  ENCOUNTER: 'encounter',
  EVOLUTION: 'evolution',
  BOSS: 'boss',
  BALL_LOST: 'ballLost',     // short beat between balls
  GAME_OVER: 'gameOver'
};

/* These are exported so the tests can use the real values rather than
   restating them, which is how a test quietly stops matching the game. */

/** Seconds the ball is held in the Well before a mode begins. */
export const SAUCER_HOLD = 0.7;

/** Seconds between losing a ball and the next one appearing. */
export const BALL_LOST_PAUSE = 1.6;

/** How hard the Well spits the ball back out. */
export const SAUCER_KICK = 205;

/**
 * The Well ejects at an angle from vertical, alternating sides each time.
 *
 * Never straight up, for two reasons. A vertical ejection sends the ball back
 * along the line it arrived on, which is dull; and if anything above the Well
 * returns it — a bumper struck from below drives it straight back down — the
 * result is a permanent loop rather than a bad bounce.
 */
export const SAUCER_EJECT_ANGLE = 0.26;

/**
 * A re-entry sooner than this counts as a failed ejection, and the next one
 * leaves at a wider angle. Escalating like this means no layout mistake can
 * hard-lock the ball: by the third attempt it is fired out almost sideways.
 */
export const SAUCER_RELOCK_MS = 2600;
export const SAUCER_MAX_ESCALATION = 3;

/** A ramp entrance ignores a ball that is barely trickling into it. */
export const RAMP_MIN_SPEED = 55;

/**
 * Ball search: the last resort against a ball that cannot get out of
 * something.
 *
 * Real machines do this — if nothing has happened for a while they fire the
 * coils to shake the ball loose. Here the trigger is confinement rather than
 * silence, because the failure this catches is the opposite of silence: a ball
 * bouncing busily between two features forever, scoring the whole time.
 *
 * The box is deliberately small and the wait long, because the point is to
 * catch a lock rather than to police confined play. A true lock repeats almost
 * exactly: the Well-to-bumper cycle covered about 16 by 17 units. Genuine
 * confined play wanders much further — a ball circulating the Cogwork Foundry's
 * gears roams the whole 32-unit gimmick zone, and at 26 by 36 this fired on it
 * during ordinary play.
 *
 * Even a false positive only costs a nudge, but a guard that goes off during a
 * good rally is a guard nobody trusts.
 */
export const SEARCH_BOX_W = 20;
export const SEARCH_BOX_H = 26;
export const SEARCH_AFTER_MS = 18_000;

/**
 * Spins needed to charge one type shift.
 *
 * Pokémon Pinball let you change which area you were fishing in, and this is
 * that mechanic: work the spinner lane and the Well will offer to move you to
 * another type, keeping your score and your disc. It is charged rather than
 * free because a shift rebuilds the table and re-serves the ball, so it wants
 * to be a decision rather than something you can do every time you pass.
 */
export const SPINS_PER_SHIFT = 12;

/**
 * The box the encounter creature drifts around in: the middle of the upper
 * playfield, clear of the dome and well above the flippers, so it is always
 * a shot rather than something that wanders into the drain.
 */
const CREATURE_BOX = { x0: 16, x1: 69, y0: 44, y1: 108 };

/* ---------------------------------------------------------------
   Game
   --------------------------------------------------------------- */

export class Game {
  /**
   * @param {object} opts
   *   onEvent(type, payload)  fired for anything the UI or audio cares about
   *   audio                   optional; anything with play(name, opts)
   */
  constructor({ onEvent = null, audio = null } = {}) {
    this.onEvent = onEvent;
    this.audio = audio;

    this.phase = PHASE.IDLE;
    this.paused = false;

    this.world = null;
    this.parts = null;
    this.mode = MODES.Neutral;

    this.run = null;
    this.sub = null;          // encounter / evolution / boss state
    this.ball = null;
    this._pausedAt = 0;

    /** Screen shake and hit flashes, decayed here so render stays dumb. */
    this.shake = 0;

    this._lastNow = 0;
    this._plunge = { pulling: false, pull: 0 };
    this._ramp = null;        // { ramp, t }
    this._saucerUntil = 0;
    this._ballLostUntil = 0;
    /** True while the Well is holding the ball waiting on a shift decision. */
    this._awaitingShift = false;

    /* Well ejection state: which way it fired last, when, and how many times
       the ball has come straight back. */
    this._saucerSide = -1;
    this._lastSaucerExit = -Infinity;
    this._saucerLocks = 0;

    /* Ball search: where the ball has been confined, and since when. */
    this._penBox = null;
    this._penSince = 0;
    this._searches = 0;

    /**
     * Contacts with the creature, filled by the solver and drained by whichever
     * mode is running. See _creatureContacts for why it is a queue.
     */
    this._creatureHits = [];
  }

  /* ---------------------------------------------------------------
     Lifecycle
     --------------------------------------------------------------- */

  /** Build a table and start a fresh three-ball game. */
  start(type = 'Neutral') {
    const chosen = TYPES.includes(type) ? type : 'Neutral';
    this._buildTable(chosen);

    this.run = {
      type: chosen,
      score: 0,
      ballNumber: 1,
      ballsLeft: BALLS_PER_GAME,
      multiplier: 1,
      discTier: 0,

      /** Which CATCH letters are down and which top lanes are collected. */
      bank: this.parts.bank.map(() => false),
      lanes: this.parts.topLanes.map(() => false),

      rampShots: 0,
      spins: 0,
      shiftCharges: 0,
      catches: 0,
      evolutions: 0,
      bossWins: 0,
      escapes: 0,

      encounterArmed: false,
      evolutionArmed: false,
      gateArmed: false,

      /**
       * What was caught *this game*. Evolution Mode draws only from here:
       * you evolve something you caught in the same game, exactly as the
       * original games did, which is why nothing about it touches the save.
       */
      caught: [],
      nextUid: 1,

      extraBallsAwarded: [],
      ballSaveFor: 0,
      kickback: { left: true, right: true },

      startedAt: Date.now(),
      playMs: 0
    };

    store.setUi('lastMode', chosen);
    this._emit('gameStart', { type: chosen, mode: this.mode });
    this._serveBall();
    return this;
  }

  /**
   * Build a table without starting a game, so the menu has something behind
   * it. There is no run, so update() does nothing and the ball never moves —
   * it is purely something for the renderer to draw.
   */
  previewTable(type = 'Neutral') {
    return this._buildTable(TYPES.includes(type) ? type : 'Neutral');
  }

  /** Abandon the current game without filing a score. */
  abandon() {
    this.phase = PHASE.IDLE;
    this.run = null;
    this.sub = null;
    this.ball = null;
    this._emit('idle', {});
  }

  _buildTable(type) {
    const built = buildTable(type);
    this.world = built.world;
    this.parts = built.parts;
    this.mode = built.mode;
    return built;
  }

  /**
   * Switch mode mid-game.
   *
   * The table is rebuilt, which loses the ball in flight, so this is only
   * ever reached from the Well — the ball is already held there and about to
   * be re-served anyway. Carrying the run's score and progress across is the
   * whole point: it is a change of area, not a new game.
   */
  shiftType(type) {
    if (!this.run || !TYPES.includes(type) || type === this.run.type) return false;

    this._buildTable(type);
    this.run.type = type;
    // The bank and lanes belong to the table, so they reset with it.
    this.run.bank = this.parts.bank.map(() => false);
    this.run.lanes = this.parts.topLanes.map(() => false);

    store.setUi('lastMode', type);
    this._award(SCORE.typeShift);
    this._emit('typeShift', { type, mode: this.mode });
    this._serveBall();
    return true;
  }

  /* ---------------------------------------------------------------
     Balls
     --------------------------------------------------------------- */

  _serveBall() {
    this.world.balls.length = 0;
    this.ball = this.world.addBall(newBall());
    this.world.resetTilt();

    this._ramp = null;
    this._awaitingShift = false;
    this._saucerLocks = 0;
    this._lastSaucerExit = -Infinity;
    this._penBox = null;
    this._searches = 0;
    this._plunge = { pulling: false, pull: 0 };
    this.run.ballSaveFor = BALL_SAVE_SECONDS;
    this.run.kickback = { left: true, right: true };

    this.phase = PHASE.PLUNGE;
    this._emit('ballReady', {
      ballNumber: this.run.ballNumber,
      ballsLeft: this.run.ballsLeft
    });
  }

  /** Begin pulling the plunger. */
  plungeStart() {
    if (this.phase !== PHASE.PLUNGE) return;
    this._plunge.pulling = true;
  }

  /** Release, launching at whatever was wound up. */
  plungeRelease() {
    if (this.phase !== PHASE.PLUNGE) return;
    const pull = this._plunge.pull;
    this._plunge = { pulling: false, pull: 0 };

    this.ball.held = false;
    this.ball.setVel(0, -launchImpulse(pull));
    // Back to whatever was running, which after a ball save mid-mode is not PLAY.
    this.phase = this._playPhase();

    this._sound('plunge', { power: pull });
    this._emit('launch', { pull });
  }

  /* ---------------------------------------------------------------
     Input
     --------------------------------------------------------------- */

  flip(side, down) {
    const f = this.parts?.flippers?.[side];
    if (!f || !this.run) return;
    if (this.world.tilted) return;

    const was = f.up;
    f.up = !!down;
    if (down && !was) {
      this._sound('flipper', { side });
      this._laneChange(side === 'right' ? 1 : -1);
    }
  }

  /** A sideways shove. Too many in quick succession tilts the table. */
  nudge(dx = 0, dy = 0) {
    if (!this.run || this.phase === PHASE.PLUNGE) return false;
    const ok = this.world.applyNudge(dx * 46, dy * 46);
    if (!ok && this.world.tilted) {
      this._emit('tilt', {});
      this._sound('tilt');
      // A tilted table kills the flippers; the ball is on its own.
      this.parts.flippers.left.up = false;
      this.parts.flippers.right.up = false;
      this.parts.flippers.left.active = false;
      this.parts.flippers.right.active = false;
    } else if (ok) {
      this.shake = Math.min(1, this.shake + 0.35);
      this._sound('nudge');
    }
    return ok;
  }

  pause() {
    if (this.paused) return;
    this.paused = true;
    this._pausedAt = performance.now();

    // Drop the flippers. A finger can still be on the screen when something
    // covers it, and coming back to a flipper stuck up is both wrong and a
    // free ball save.
    if (this.parts?.flippers) {
      this.parts.flippers.left.up = false;
      this.parts.flippers.right.up = false;
    }
  }

  /**
   * Resume, and carry every pending deadline forward by however long the pause
   * lasted.
   *
   * `_lastNow = 0` alone stops the physics fast-forwarding, but the timers that
   * hold absolute timestamps — the Well's hold, the pause between balls, the
   * ball-search window — would all be in the past on the far side of a pause
   * and fire at once. Reading a capture reveal for twenty seconds would have
   * triggered a ball search the instant it closed.
   *
   * rAF timestamps share performance.now()'s origin, so the two are directly
   * comparable.
   */
  resume() {
    if (!this.paused) return;
    const gap = this._pausedAt ? performance.now() - this._pausedAt : 0;
    this._pausedAt = 0;

    if (gap > 0) {
      this._saucerUntil += gap;
      this._ballLostUntil += gap;
      this._penSince += gap;
      this._lastSaucerExit += gap;
    }

    this.paused = false;
    this._lastNow = 0;
  }

  /* ---------------------------------------------------------------
     The loop
     --------------------------------------------------------------- */

  /**
   * Advance the game. Call once per animation frame with the timestamp.
   *
   * The physics is fixed-step inside world.advance; everything else here is
   * frame-rate dependent presentation and timers, which is why they take the
   * real elapsed time rather than a physics step.
   */
  update(nowMs) {
    if (this.paused || !this.run) { this._lastNow = nowMs; return; }

    const dt = this._lastNow ? Math.min((nowMs - this._lastNow) / 1000, 0.1) : 0;
    this._lastNow = nowMs;
    if (dt <= 0) return;

    this.run.playMs += dt * 1000;

    /* ---- plunger wind-up ---- */
    if (this.phase === PHASE.PLUNGE && this._plunge.pulling) {
      this._plunge.pull = Math.min(1, this._plunge.pull + dt * 1.6);
    }

    /* ---- between balls ---- */
    if (this.phase === PHASE.BALL_LOST) {
      if (nowMs >= this._ballLostUntil) this._nextBall();
      return;
    }
    if (this.phase === PHASE.GAME_OVER || this.phase === PHASE.IDLE) return;

    /* ---- ball save countdown ---- */
    if (this.run.ballSaveFor > 0 && this.phase !== PHASE.PLUNGE) {
      this.run.ballSaveFor = Math.max(0, this.run.ballSaveFor - dt);
    }

    /* ---- ramp traversal takes the ball out of the simulation ---- */
    if (this._ramp) this._advanceRamp(dt);

    /* ---- physics ---- */
    this.world.advance(dt);
    this.parts.gimmick.update(dt);

    /* ---- consequences ---- */
    this._handleEvents();

    if (this.phase === PHASE.SAUCER) this._updateSaucer(nowMs);

    /**
     * The live mode is driven off `sub`, not off `phase`.
     *
     * This is the third bug of one kind: `phase` and `sub` are two records of
     * the same fact and they drift, and whenever they do the mode is left alive
     * but never updated again — creature frozen, clock frozen, hits ignored.
     * First the Well's guard omitted EVOLUTION. Then a ball save fired mid-mode,
     * set the phase to PLUNGE and orphaned the mode the same way, which is
     * trivial to hit now that a capture hands out ten seconds of save: catch
     * something, drain inside the save, and the next mode you start is dead.
     *
     * Dispatching on the sub-mode itself ends the whole class. There is no phase
     * a mode can be hidden behind, because the phase is no longer asked.
     */
    if (this.sub) {
      if (this.sub.kind === 'encounter') this._updateEncounter(dt);
      else if (this.sub.kind === 'evolution') this._updateEvolution(dt);
      else if (this.sub.kind === 'boss') this._updateBoss(dt);
    }

    this._ballSearch(nowMs);
    this._checkDrain();

    /* ---- decay ---- */
    this.shake = Math.max(0, this.shake - dt * 2.6);
    if (this.sub && this.sub.flash > 0) this.sub.flash = Math.max(0, this.sub.flash - dt * 4);
  }

  /* ---------------------------------------------------------------
     Collision consequences
     --------------------------------------------------------------- */

  /**
   * One switch over `meta.role`, which is the only place the rules meet the
   * table. Anything the table adds with a known role is scored here; an
   * unknown role is silently ignored rather than throwing mid-ball.
   */
  _handleEvents() {
    for (const ev of this.world.drainEvents()) {
      if (ev.type === 'tilt') { this._emit('tilt', {}); continue; }
      if (ev.type === 'flipper' || ev.type === 'rotor') continue;
      if (ev.type !== 'hit') continue;

      const role = ev.collider.meta?.role;
      const c = ev.collider;

      switch (role) {
        case 'bumper':
          this._award(SCORE.bumper);
          this._bumpMultiplier(0.05);
          this.shake = Math.min(1, this.shake + 0.10);
          this._sound('bumper');
          break;

        case 'slingshot':
          this._award(SCORE.slingshot);
          this._sound('sling');
          break;

        case 'spinner':
          this.run.spins++;
          this._award(SCORE.spinner);
          this._bumpMultiplier(0.08);
          if (this.parts.gimmick.state) this.parts.gimmick.state.spins = this.run.spins;
          if (this.run.spins % SPINS_PER_SHIFT === 0) {
            this.run.shiftCharges++;
            this._emit('shiftCharged', { charges: this.run.shiftCharges });
          }
          this._sound('spinner');
          break;

        case 'bankTarget':
          this._hitBankTarget(c);
          break;

        case 'topLane':
          this._hitTopLane(c);
          break;

        case 'rampEntrance':
          this._enterRamp(c, ev.ball, ev.speed);
          break;

        case 'saucer':
          this._enterSaucer(ev.ball);
          break;

        case 'inlane':
          this._award(SCORE.lane);
          // Passing an inlane rearms that side's kickback, so working the
          // return lanes is what keeps your saves stocked.
          this.run.kickback[c.meta.side] = true;
          this._emit('kickbackArmed', { side: c.meta.side });
          break;

        case 'outlane':
          this._hitOutlane(c, ev.ball);
          break;

        case 'gimmick':
          this._hitGimmick(c);
          break;

        /**
         * The creature. Queued rather than acted on, because what a contact is
         * worth depends on the mode and only the mode knows: damage in an
         * encounter, a shard check in an evolution, a shield test on a boss.
         * Drained a few lines later by _creatureContacts.
         */
        case 'creature':
          if (this.sub) this._creatureHits.push({ x: ev.ball.pos.x, y: ev.ball.pos.y });
          break;

        default:
          break;
      }
    }
  }

  /* ---- targets ---- */

  /**
   * A drop target falls the instant it is touched.
   *
   * That is the rule, and it is also the table's main defence against a ball
   * settling on top of one: a standing target the ball can rest against
   * stops being there the moment they touch.
   */
  /**
   * Lane change. A flipper press slides the lit pattern one place sideways.
   *
   * The classic pinball courtesy, applied to both rows: the right flipper
   * shifts everything one to the right and the left flipper one to the left,
   * wrapping around the ends. If the only lane you still need is C and the ball
   * is heading for B, press right and B becomes the one you need.
   *
   * The pattern moves, not the lit set — so a single lit B pressed right leaves
   * a single lit C, and a CATCH bank missing only T, pressed left, is missing
   * only A. That is the same operation for both rows and needs no special case
   * for how many are lit.
   *
   * The bank has to move its colliders with it, because for the drop targets the
   * pattern *is* physical: `run.bank[i]` and `parts.bank[i].active` are two
   * views of one fact and letting them drift would show a standing target the
   * game thought was down.
   *
   * No completion check afterwards, and none is needed: both rows reset
   * themselves the instant they fill, so neither can ever be sitting one short
   * of complete with a rotation available to finish it.
   */
  _laneChange(dir) {
    if (!this.run) return;

    const roll = arr => arr.map((_, i) => arr[(i - dir + arr.length) % arr.length]);

    this.run.lanes = roll(this.run.lanes);
    this.run.bank = roll(this.run.bank);
    this.parts.bank.forEach((t, i) => { t.active = !this.run.bank[i]; });
  }

  _hitBankTarget(c) {
    const i = c.meta.index;
    if (!c.active) return;

    c.active = false;
    this.run.bank[i] = true;
    this._award(SCORE.dropTarget);
    this._sound('target');

    // During Evolution Mode the bank is the shard bank instead. Keyed off the
    // sub-mode, not the phase, for the reason given in update().
    if (this.sub?.kind === 'evolution') {
      this.sub.shards = Math.min(EVOLUTION_SHARDS, this.sub.shards + 1);
      this._award(SCORE.evolveShard);
      this._emit('evolutionShard', { shards: this.sub.shards, needed: EVOLUTION_SHARDS });
      if (this.sub.shards >= EVOLUTION_SHARDS) this._emit('evolutionReady', {});
    }

    this._emit('bankLetter', { index: i, letters: this.run.bank.slice() });

    if (this.run.bank.every(Boolean)) this._completeBank();
  }

  _completeBank() {
    this._award(SCORE.bankComplete, { mult: false });
    // Reset so the bank can be cleared again for another encounter.
    this.parts.bank.forEach(t => { t.active = true; });
    this.run.bank = this.parts.bank.map(() => false);

    if (!this.run.encounterArmed) {
      this.run.encounterArmed = true;
      this._emit('armed', { what: 'encounter' });
    }
    this._sound('bankComplete');
    this._emit('bankComplete', {});
  }

  _hitTopLane(c) {
    const i = c.meta.index;
    if (this.run.lanes[i]) { this._award(SCORE.lane); return; }

    this.run.lanes[i] = true;
    this._award(SCORE.lane);
    this._sound('lane');
    this._emit('laneLetter', { index: i, lanes: this.run.lanes.slice() });

    if (this.run.lanes.every(Boolean)) {
      this.run.lanes = this.parts.topLanes.map(() => false);
      this._award(SCORE.laneSetComplete, { mult: false });
      this._upgradeDisc();
    }
  }

  /** Completing the top lanes upgrades the disc, up to the Master Disc. */
  _upgradeDisc() {
    if (this.run.discTier >= MAX_DISC_TIER) {
      // Already maxed: pay out instead, so the shot never becomes worthless.
      this._award(SCORE.discUpgrade, { mult: false });
      this._emit('lanesComplete', { tier: this.run.discTier, upgraded: false });
      return;
    }
    this.run.discTier++;
    this._award(SCORE.discUpgrade, { mult: false });
    this._sound('upgrade');
    this._emit('discUpgrade', {
      tier: this.run.discTier,
      disc: DISC_TIERS[this.run.discTier]
    });
  }

  _hitOutlane(c, ball) {
    const side = c.meta.side;
    this._award(SCORE.lane, { mult: false });

    if (this.run.kickback[side]) {
      this.run.kickback[side] = false;
      // Straight back up the outlane, which is what a kickback does.
      ball.setVel(randRange(-14, 14), -LAYOUT.lower.kickbackImpulse);
      this.shake = Math.min(1, this.shake + 0.45);
      this._sound('kickback');
      this._emit('kickback', { side });
    }
  }

  _hitGimmick(c) {
    const kind = c.meta.kind;
    const g = this.parts.gimmick;
    this._award(SCORE.gimmick);

    if (kind === 'vine') {
      if (g.cut?.(c.meta.index)) {
        this._award(SCORE.gimmick, { mult: false });
        this._emit('gimmick', { kind, cleared: g.vines.every(v => !v.active) });
      }
      return;
    }

    if (kind === 'gearVent' && g.state) {
      g.state.heat = Math.min(6, g.state.heat + 1);
    }

    if (kind === 'herdLane' && g.state?.lit) {
      g.state.lit[c.meta.index] = true;
      if (g.state.lit.every(Boolean)) {
        g.reset();
        this._award(SCORE.laneSetComplete, { mult: false });
        this._bumpMultiplier(0.5);
      }
    }

    if (kind === 'orbitRollover') this._bumpMultiplier(0.1);

    if (kind === 'updraftEye') this._award(SCORE.gimmick, { mult: false });

    this._emit('gimmick', { kind });
  }

  /* ---- ramps ---- */

  /**
   * Ramps are not colliders. A ball that enters one is taken out of the
   * simulation and walked along a path, then dropped into the opposite
   * inlane. Modelling a raised ramp as geometry in a top-down table would
   * mean the ball colliding with a lane it is supposed to be riding above.
   */
  _enterRamp(entrance, ball, speed) {
    if (this._ramp || ball.held) return;
    if (speed < RAMP_MIN_SPEED) return;      // a trickle is not a ramp shot

    const ramp = this.parts.ramps.find(r => r.id === entrance.meta.ramp);
    if (!ramp) return;

    ball.held = true;
    ball.freeze();
    this._ramp = { ramp, t: 0 };

    this.run.rampShots++;
    this._award(SCORE.ramp);
    this._sound('ramp');
    this._emit('ramp', { id: ramp.id, shots: this.run.rampShots });

    // Three ramp shots arm Evolution Mode.
    if (this.run.rampShots > 0 && this.run.rampShots % 3 === 0 && !this.run.evolutionArmed) {
      if (this._evolvable().length) {
        this.run.evolutionArmed = true;
        this._emit('armed', { what: 'evolution' });
      } else {
        // Nothing to evolve yet, so pay for the shot instead of arming a mode
        // the player cannot use.
        this._award(SCORE.rampLoop, { mult: false });
      }
    }
  }

  _advanceRamp(dt) {
    const { ramp } = this._ramp;
    this._ramp.t += dt / ramp.seconds;

    const pts = ramp.path;
    const t = clamp(this._ramp.t, 0, 1);
    const span = (pts.length - 1) * t;
    const i = Math.min(pts.length - 2, Math.floor(span));
    const f = span - i;

    this.ball.moveTo(
      pts[i].x + (pts[i + 1].x - pts[i].x) * f,
      pts[i].y + (pts[i + 1].y - pts[i].y) * f
    );

    if (this._ramp.t >= 1) {
      this.ball.held = false;
      this.ball.moveTo(ramp.exit.x, ramp.exit.y);
      this.ball.setVel(ramp.exit.vx, ramp.exit.vy);
      this._ramp = null;
      this._award(SCORE.rampLoop, { mult: false });
    }
  }

  /* ---- the Well ---- */

  _enterSaucer(ball) {
    if (this.phase === PHASE.SAUCER || ball.held) return;

    /**
     * While a mode owns the ball the Well is inert.
     *
     * Guarded on `this.sub` rather than by listing phases, which is how this
     * broke: the list read ENCOUNTER and BOSS and quietly omitted EVOLUTION.
     * Dropping into the Well mid-evolution re-entered the saucer, found nothing
     * armed, and kicked the ball out with the default phase of PLAY — leaving
     * the evolution state live but never updated again. The creature froze, the
     * clock froze, hits stopped counting, and its collider was orphaned in the
     * world for the rest of the game.
     *
     * Keyed off the sub-mode itself, a fourth mode cannot reintroduce it.
     */
    if (this.sub) return;

    // A ball back in the Well this quickly did not really get away, so the next
    // ejection leaves at a wider angle. Anything slower is an ordinary shot and
    // resets the escalation.
    const sinceExit = this._lastNow - this._lastSaucerExit;
    this._saucerLocks = sinceExit < SAUCER_RELOCK_MS
      ? Math.min(SAUCER_MAX_ESCALATION, this._saucerLocks + 1)
      : 0;

    ball.held = true;
    ball.freeze();
    ball.moveTo(LAYOUT.saucer.x, LAYOUT.saucer.y);

    this.phase = PHASE.SAUCER;
    this._saucerUntil = this._lastNow + SAUCER_HOLD * 1000;

    this._award(SCORE.saucer);
    this._sound('saucer');
    this._emit('saucer', {
      armed: this._armedMode(),
      encounter: this.run.encounterArmed,
      evolution: this.run.evolutionArmed,
      gate: this.run.gateArmed
    });
  }

  /** Boss first, then evolution, then an encounter. Rarest opportunity wins. */
  _armedMode() {
    if (this.run.gateArmed) return 'boss';
    if (this.run.evolutionArmed && this._evolvable().length) return 'evolution';
    if (this.run.encounterArmed) return 'encounter';
    return null;
  }

  _updateSaucer(nowMs) {
    if (this._awaitingShift) return;         // held until the player answers
    if (nowMs < this._saucerUntil) return;

    const armed = this._armedMode();
    if (armed === 'boss') this._startBoss();
    else if (armed === 'evolution') this._startEvolution();
    else if (armed === 'encounter') this._startEncounter();
    else if (this.run.shiftCharges > 0) this._offerShift();
    else this._kickOutOfSaucer();
  }

  /**
   * Kick the ball back out into play.
   *
   * `phase` is a parameter because the three modes all begin by returning the
   * ball to the table and then own the phase themselves. Hard-coding PLAY here
   * meant every caller had to set its phase back immediately afterwards, which
   * left a window where the phase was briefly wrong.
   */
  _kickOutOfSaucer({ phase = PHASE.PLAY } = {}) {
    /* Alternate sides, and widen the angle every time the ball comes straight
       back. By the third attempt it leaves at nearly 60 degrees, which no
       vertical loop can survive. See SAUCER_EJECT_ANGLE. */
    this._saucerSide = -(this._saucerSide || -1);
    const angle = SAUCER_EJECT_ANGLE * (1 + this._saucerLocks) * this._saucerSide;

    const sin = Math.sin(angle);
    const cos = Math.cos(angle);

    this.ball.held = false;
    // Start off the centre line too, so the ball is not launched along exactly
    // the line it arrived on.
    this.ball.moveTo(
      LAYOUT.saucer.x + sin * (LAYOUT.saucer.r + this.ball.r + 0.4),
      LAYOUT.saucer.y - cos * (LAYOUT.saucer.r + this.ball.r + 0.4)
    );
    this.ball.setVel(sin * SAUCER_KICK, -cos * SAUCER_KICK);

    this._lastSaucerExit = this._lastNow;
    this.phase = phase;
    this.shake = Math.min(1, this.shake + 0.3);
    this._sound('kickout');

    if (this._saucerLocks > 0) {
      this._emit('saucerRetry', { attempt: this._saucerLocks, angle });
    }
  }

  /* ---- type shift ---- */

  /**
   * Offer a change of type. The ball stays held in the Well indefinitely:
   * a held ball cannot drain, so there is no need for a timeout, and giving
   * the player as long as they like to choose is kinder than a countdown on
   * a decision that costs a charge.
   */
  _offerShift() {
    this._awaitingShift = true;
    this._emit('shiftOffer', {
      current: this.run.type,
      charges: this.run.shiftCharges,
      types: TYPES.filter(t => t !== this.run.type)
    });
  }

  /** Accept the offer. Consumes a charge and rebuilds the table. */
  chooseShift(type) {
    if (!this._awaitingShift || !this.run) return false;
    if (!TYPES.includes(type) || type === this.run.type) return false;

    this._awaitingShift = false;
    this.run.shiftCharges--;
    return this.shiftType(type);
  }

  /** Decline, and keep the charge for next time. */
  declineShift() {
    if (!this._awaitingShift) return false;
    this._awaitingShift = false;
    this._kickOutOfSaucer();
    return true;
  }

  /* ---------------------------------------------------------------
     Encounter Mode
     --------------------------------------------------------------- */

  _startEncounter() {
    const sp = rollEncounter(this.run.type);
    if (!sp) { this._kickOutOfSaucer(); return; }

    this.run.encounterArmed = false;
    store.noteEncounter();

    const rarity = sp.effectiveRarity;
    const shiny = chance(this._shinyOdds());

    this.sub = {
      kind: 'encounter',
      sp,
      shiny,
      rarity,
      meterMax: CAPTURE_METER[rarity],
      meter: CAPTURE_METER[rarity],
      seconds: CAPTURE_SECONDS[rarity],
      flash: 0,
      x: LAYOUT.centre,
      y: 84,
      vx: chance(0.5) ? -CAPTURE_DRIFT[rarity] : CAPTURE_DRIFT[rarity],
      vy: CAPTURE_DRIFT[rarity] * 0.45,
      r: 11,
      collider: null
    };

    this._spawnCreatureCollider();
    this._kickOutOfSaucer({ phase: PHASE.ENCOUNTER });

    this._sound('encounter', { rarity, shiny });
    this._emit('encounterStart', {
      species: sp, shiny, rarity,
      seconds: this.sub.seconds,
      meterMax: this.sub.meterMax
    });
  }

  /**
   * The creature is a real collider, so the ball bounces off it rather than
   * passing through — that contact is the whole mode. It is safe to have one
   * out in the open field because it never stops drifting, so the ball cannot
   * settle against it.
   */
  _spawnCreatureCollider() {
    const s = this.sub;

    /**
     * Drop any contacts left over from the last mode.
     *
     * Hits are queued by _handleEvents and drained by _creatureContacts, and
     * the two do not have to happen in the same frame. A contact still sitting
     * in the queue when a mode ends would otherwise be credited to the next
     * creature, which is a free hit on something the ball never touched.
     */
    this._creatureHits.length = 0;

    /**
     * The centre of the table stands down for the whole mode.
     *
     * Every one of the five centres is something that blocks or bats the ball
     * around the middle of the playfield, which is precisely where the creature
     * drifts. Left standing, a mode can be lost to a wall of vines or the orbit
     * ring without the player ever getting a clean shot. Paired with the
     * despawn below so it cannot be left switched off.
     */
    this.parts.gimmick.setDormant(true);

    s.collider = circle(s.x, s.y, s.r * 0.72, {
      id: 'creature',
      restitution: 0.5,
      friction: 0.05,
      kick: 26,
      cooldownFor: 0.22,
      meta: { role: 'creature' }
    });
    this.world.add(s.collider);
  }

  _despawnCreatureCollider() {
    if (this.sub?.collider) this.world.remove(this.sub.collider);
    if (this.sub) this.sub.collider = null;

    // The centre comes back, and any contact not yet credited is dropped: it
    // belonged to a creature that is no longer there.
    this._creatureHits.length = 0;
    this.parts.gimmick.setDormant(false);
  }

  _updateEncounter(dt) {
    const s = this.sub;
    if (!s) return;

    this._driftCreature(s, dt);

    // Contacts come from the solver, so every bounce is counted exactly once
    // however fast the ball was going. See _creatureContacts.
    this._creatureContacts(s, hit => {
      s.meter = Math.max(0, s.meter - DISC_TIERS[this.run.discTier].power);
      s.flash = 1;
      this.shake = Math.min(1, this.shake + 0.3);
      this._award(SCORE.captureHit);
      this._sound('creatureHit');
      this._emit('encounterHit', {
        meter: s.meter, meterMax: s.meterMax, at: hit
      });
    });

    if (s.meter <= 0) { this._capture(); return; }

    // The clock only runs while the ball is reachable. See _ballInPlay.
    if (!this._ballInPlay()) return;
    s.seconds -= dt;
    if (s.seconds <= 0) this._escape('time');
  }

  _capture() {
    const s = this.sub;
    const sp = s.sp;

    const { isNew, isNewShiny } = store.recordCapture(sp.id, {
      shiny: s.shiny,
      source: 'encounter'
    });

    this.run.catches++;
    this.run.caught.push({
      uid: `r${this.run.nextUid++}`,
      speciesId: sp.id,
      shiny: s.shiny
    });

    let gained = SCORE.captureRarity[s.rarity] || SCORE.captureRarity[1];
    if (s.shiny) gained += SCORE.captureShinyBonus;
    if (isNew) gained += SCORE.captureNewBonus;
    this._award(gained, { mult: false });

    this._despawnCreatureCollider();
    this.sub = null;
    this.phase = PHASE.PLAY;
    this._rewardBallSave();

    this._sound('capture', { shiny: s.shiny, isNew });
    this._emit('capture', {
      species: sp, shiny: s.shiny, isNew, isNewShiny,
      rarity: s.rarity, score: gained,
      catches: this.run.catches
    });

    this._maybeArmGate();
  }

  _escape(reason) {
    const s = this.sub;
    if (!s) return;

    this._despawnCreatureCollider();
    this.sub = null;
    if (this.phase !== PHASE.BALL_LOST) this.phase = PHASE.PLAY;

    this.run.escapes++;
    store.noteEscape();
    this._sound('escape');
    this._emit('escape', { species: s.sp, reason });
  }

  /** Three catches in one game open the Awakening Gate. */
  _maybeArmGate() {
    if (this.run.gateArmed || this.run.catches < GATE_CATCHES_NEEDED) return;
    if (!bossOf(this.run.type)) return;      // this mode has no legendary

    this.run.gateArmed = true;
    this._award(SCORE.gateOpen, { mult: false });
    this._sound('gate');
    this._emit('armed', { what: 'boss', boss: bossOf(this.run.type) });
  }

  /* ---------------------------------------------------------------
     Evolution Mode
     --------------------------------------------------------------- */

  /** Everything caught this game that has somewhere to evolve to. */
  _evolvable() {
    if (!this.run) return [];
    return this.run.caught.filter(c => evolutionTargets(c.speciesId).length > 0);
  }

  _startEvolution() {
    const options = this._evolvable();
    if (!options.length) { this._kickOutOfSaucer(); return; }

    // The furthest-along creature first, so a chain keeps progressing rather
    // than the player re-evolving the same first stage.
    const chosen = options.reduce((best, c) => {
      const stage = speciesById(c.speciesId)?.stage ?? 1;
      const bestStage = speciesById(best.speciesId)?.stage ?? 1;
      return stage > bestStage ? c : best;
    }, options[0]);

    const from = speciesById(chosen.speciesId);
    const targets = evolutionTargets(from.id);

    this.run.evolutionArmed = false;

    // A fresh bank to knock down for shards.
    this.parts.bank.forEach(t => { t.active = true; });
    this.run.bank = this.parts.bank.map(() => false);

    this.sub = {
      kind: 'evolution',
      entry: chosen,
      from,
      to: targets.length > 1 ? pick(targets) : targets[0],
      shiny: chosen.shiny,
      shards: 0,
      seconds: EVOLUTION_SECONDS,
      flash: 0,
      x: LAYOUT.centre,
      y: 84,
      vx: 30,
      vy: 14,
      r: 11,
      collider: null
    };

    this._spawnCreatureCollider();
    this._kickOutOfSaucer({ phase: PHASE.EVOLUTION });

    this._sound('evolutionStart');
    this._emit('evolutionStart', {
      from, to: this.sub.to, shiny: chosen.shiny,
      shards: 0, needed: EVOLUTION_SHARDS,
      seconds: EVOLUTION_SECONDS
    });
  }

  _updateEvolution(dt) {
    const s = this.sub;
    if (!s) return;

    this._driftCreature(s, dt);

    this._creatureContacts(s, () => {
      s.flash = 1;
      this.shake = Math.min(1, this.shake + 0.25);
      if (s.shards >= EVOLUTION_SHARDS) { this._evolve(); return; }
      // Not ready: the hit still scores, so the shot is never wasted.
      this._award(SCORE.captureHit, { mult: false });
      this._sound('creatureHit');
    });

    if (!this.sub) return;      // _evolve cleared it

    if (!this._ballInPlay()) return;
    s.seconds -= dt;
    if (s.seconds <= 0) this._evolutionFailed('time');
  }

  _evolve() {
    const s = this.sub;
    const { isNew, isNewShiny } = store.recordEvolution(s.to.id, { shiny: s.shiny });

    // The run's own record follows the creature, so a three-stage line can be
    // taken all the way in one game.
    const entry = this.run.caught.find(c => c.uid === s.entry.uid);
    if (entry) entry.speciesId = s.to.id;

    this.run.evolutions++;
    this._award(SCORE.evolveSuccess, { mult: false });

    this._despawnCreatureCollider();
    this.sub = null;
    this.phase = PHASE.PLAY;
    this._rewardBallSave();

    this._sound('evolve', { isNew });
    this._emit('evolve', { from: s.from, to: s.to, shiny: s.shiny, isNew, isNewShiny });
  }

  _evolutionFailed(reason) {
    const s = this.sub;
    if (!s) return;
    this._despawnCreatureCollider();
    this.sub = null;
    if (this.phase !== PHASE.BALL_LOST) this.phase = PHASE.PLAY;
    this._emit('evolutionFailed', { from: s.from, to: s.to, reason });
  }

  /* ---------------------------------------------------------------
     Boss stage
     --------------------------------------------------------------- */

  _startBoss() {
    const boss = bossOf(this.run.type);
    if (!boss) { this._kickOutOfSaucer(); return; }

    this.run.gateArmed = false;
    const shiny = chance(this._shinyOdds() * 2);   // a legendary is worth the better odds

    this.sub = {
      kind: 'boss',
      sp: boss,
      shiny,
      rarity: 5,
      meterMax: CAPTURE_METER[5],
      meter: CAPTURE_METER[5],
      seconds: BOSS_SECONDS,
      shielded: false,
      shieldTimer: BOSS_SHIELD_SECONDS,
      flash: 0,
      x: LAYOUT.centre,
      y: 78,
      vx: CAPTURE_DRIFT[5],
      vy: CAPTURE_DRIFT[5] * 0.4,
      r: 13,
      collider: null
    };

    this._spawnCreatureCollider();
    this._kickOutOfSaucer({ phase: PHASE.BOSS });

    this._sound('bossStart');
    this._emit('bossStart', {
      species: boss, shiny,
      seconds: BOSS_SECONDS,
      meterMax: this.sub.meterMax
    });
  }

  _updateBoss(dt) {
    const s = this.sub;
    if (!s) return;

    /* The shield is what stops a boss being one safe repeated shot. It runs on
       the same terms as the clock: not while the ball is out of reach, or the
       player would come back from a ball save to a shield they never saw go up. */
    if (this._ballInPlay()) {
      s.shieldTimer -= dt;
      if (s.shieldTimer <= 0) {
        s.shielded = !s.shielded;
        s.shieldTimer = BOSS_SHIELD_SECONDS * (s.shielded ? 0.8 : 1.2);
        this._emit('bossShield', { shielded: s.shielded });
      }
    }

    this._driftCreature(s, dt);

    this._creatureContacts(s, () => {
      s.flash = 1;
      this.shake = Math.min(1, this.shake + 0.4);

      if (s.shielded) {
        this._award(SCORE.bumper);
        this._sound('shielded');
        this._emit('bossBlocked', {});
        return;
      }

      s.meter = Math.max(0, s.meter - DISC_TIERS[this.run.discTier].power);
      this._award(SCORE.bossHit);
      this._sound('bossHit');
      this._emit('bossHit', { meter: s.meter, meterMax: s.meterMax });
    });

    if (s.meter <= 0) { this._bossWin(); return; }

    if (!this._ballInPlay()) return;
    s.seconds -= dt;
    if (s.seconds <= 0) this._bossFled();
  }

  _bossWin() {
    const s = this.sub;
    const { isNew, isNewShiny } = store.recordCapture(s.sp.id, {
      shiny: s.shiny, source: 'boss'
    });
    store.recordBossWin(this.run.type);

    this.run.bossWins++;
    this.run.catches++;
    this.run.caught.push({
      uid: `r${this.run.nextUid++}`,
      speciesId: s.sp.id,
      shiny: s.shiny
    });

    let gained = SCORE.captureRarity[5];
    if (s.shiny) gained += SCORE.captureShinyBonus;
    if (isNew) gained += SCORE.captureNewBonus;
    this._award(gained, { mult: false });

    this._despawnCreatureCollider();
    this.sub = null;
    this.phase = PHASE.PLAY;
    // A boss win is a capture in every other respect, so it earns the same save.
    this._rewardBallSave();

    this._sound('bossWin', { shiny: s.shiny });
    this._emit('bossWin', {
      species: s.sp, shiny: s.shiny, isNew, isNewShiny, score: gained
    });
  }

  _bossFled() {
    const s = this.sub;
    this._despawnCreatureCollider();
    this.sub = null;
    if (this.phase !== PHASE.BALL_LOST) this.phase = PHASE.PLAY;
    this._sound('escape');
    this._emit('bossFled', { species: s.sp });
  }

  /* ---------------------------------------------------------------
     Rewards shared by all three modes
     --------------------------------------------------------------- */

  /**
   * The phase the game belongs in with the ball loose: the running mode's, or
   * plain PLAY if nothing is running.
   *
   * Anywhere the ball is returned to play has to ask this rather than assume
   * PLAY, or it silently ends a mode that is still very much alive.
   */
  _playPhase() {
    if (!this.sub) return PHASE.PLAY;
    if (this.sub.kind === 'encounter') return PHASE.ENCOUNTER;
    if (this.sub.kind === 'evolution') return PHASE.EVOLUTION;
    return PHASE.BOSS;
  }

  /**
   * True while the player can actually reach the creature.
   *
   * A mode's clock is held whenever they cannot — held in the plunger after a
   * ball save, most of all. Letting it run there would mean losing a creature
   * to a ball that was saved, in a lane the player has to sit in, which is the
   * opposite of what a save is for. Nothing is gained by stalling either: the
   * only way to finish a mode is to put the ball back in play.
   */
  _ballInPlay() {
    return !!this.ball && this.ball.alive && !this.ball.held;
  }

  /**
   * The live shiny rate, doubled once the game passes SHINY_DOUBLE_AT.
   *
   * Read at the moment a creature is rolled rather than latched when the
   * threshold is crossed, so it is always in step with the score on screen.
   */
  _shinyOdds() {
    return SHINY_ODDS * (this.run.score >= SHINY_DOUBLE_AT ? 2 : 1);
  }

  /**
   * Hand back a ball save, for landing a capture, an evolution or a boss.
   *
   * `Math.max` rather than an assignment: a capture inside the opening ball
   * save must not shorten it. Skipped while the ball is already in the plunger
   * lane, where a save would tick away unused before the plunge.
   */
  _rewardBallSave() {
    if (!this.run || this.phase === PHASE.PLUNGE) return;
    const was = this.run.ballSaveFor;
    this.run.ballSaveFor = Math.max(was, CAPTURE_BALL_SAVE_SECONDS);
    if (this.run.ballSaveFor > was) {
      this._emit('ballSaveGranted', { seconds: this.run.ballSaveFor });
    }
  }

  /* ---------------------------------------------------------------
     Creature movement and contact, shared by all three modes
     --------------------------------------------------------------- */

  _driftCreature(s, dt) {
    s.x += s.vx * dt;
    s.y += s.vy * dt;

    // Bounce inside the box, and keep the collider with it.
    if (s.x < CREATURE_BOX.x0) { s.x = CREATURE_BOX.x0; s.vx = Math.abs(s.vx); }
    if (s.x > CREATURE_BOX.x1) { s.x = CREATURE_BOX.x1; s.vx = -Math.abs(s.vx); }
    if (s.y < CREATURE_BOX.y0) { s.y = CREATURE_BOX.y0; s.vy = Math.abs(s.vy); }
    if (s.y > CREATURE_BOX.y1) { s.y = CREATURE_BOX.y1; s.vy = -Math.abs(s.vy); }

    if (s.collider) { s.collider.c.x = s.x; s.collider.c.y = s.y; }
  }

  /**
   * Fire `onHit` for every contact the solver reported since the last frame.
   *
   * The contact *is* the bounce. The solver detects it inside its own
   * sub-stepped loop, so the hit and the bounce are the same event by
   * construction and cannot disagree about how many landed. The collider's
   * 0.22 s cooldown is what stops a ball leaning on the creature from
   * machine-gunning it.
   *
   * This used to measure the distance from the ball to the creature once per
   * frame instead, and that was a race the fast shots lost. The counting shell
   * is only about a unit thick, so a glancing hit at speed crosses it in
   * roughly 20 ms — less than a frame at 60 Hz, and nowhere near a frame on a
   * phone that has just dropped one. The ball visibly bounced off the creature,
   * because physics runs at 240 Hz and saw it, and then the frame sample found
   * the ball already clear and counted nothing. Sampling a continuous world at
   * frame rate cannot be made reliable by widening the shell; the fix is to
   * stop sampling.
   */
  _creatureContacts(s, onHit) {
    if (!s.collider) { this._creatureHits.length = 0; return; }

    // Spliced out one at a time: onHit can end the mode — a capture, an
    // evolution — and anything still queued then belongs to nothing.
    while (this._creatureHits.length) {
      const hit = this._creatureHits.shift();
      onHit(hit);
      if (!this.sub || this.sub !== s) { this._creatureHits.length = 0; return; }
    }
  }

  /* ---------------------------------------------------------------
     Ball search
     --------------------------------------------------------------- */

  /**
   * Watch for a ball that has stopped going anywhere, and shove it.
   *
   * The box grows to contain wherever the ball has been. While it stays small
   * the ball is going nowhere; the moment it exceeds SEARCH_BOX_W or _H the
   * timer restarts, so ordinary play never trips this.
   *
   * This is a safety net, not a mechanism. It exists because the table has five
   * swappable centres, and the Wildwood Green stump proved that one badly
   * placed collider is enough to make the game unplayable in a way no static
   * "does the ball come to rest" test can see — the ball was moving the whole
   * time, and scoring.
   */
  _ballSearch(nowMs) {
    /**
     * The Well counts as live play, and a held ball pauses the box rather than
     * clearing it.
     *
     * This matters more than it looks. The lock this guard exists for cycled
     * through the Well every 0.85 seconds, and the Well holds the ball for 0.7
     * of that. Resetting on `held` — or excluding the SAUCER phase — restarted
     * the box on every single cycle, so the guard could never have fired on the
     * very bug it was written for.
     */
    const live = this.phase === PHASE.PLAY || this.phase === PHASE.SAUCER ||
                 this.phase === PHASE.ENCOUNTER || this.phase === PHASE.EVOLUTION ||
                 this.phase === PHASE.BOSS;
    if (!live) { this._penBox = null; return; }

    const ball = this.ball;
    if (!ball || !ball.alive) { this._penBox = null; return; }

    // Held: keep the box and keep the clock running, but do not sample a
    // position the player has no control over.
    if (ball.held) return;

    const p = ball.pos;
    if (!this._penBox) {
      this._penBox = { x0: p.x, x1: p.x, y0: p.y, y1: p.y };
      this._penSince = nowMs;
      return;
    }

    const box = this._penBox;
    box.x0 = Math.min(box.x0, p.x);
    box.x1 = Math.max(box.x1, p.x);
    box.y0 = Math.min(box.y0, p.y);
    box.y1 = Math.max(box.y1, p.y);

    // Roamed far enough to be playing properly: start watching again from here.
    if ((box.x1 - box.x0) > SEARCH_BOX_W || (box.y1 - box.y0) > SEARCH_BOX_H) {
      this._penBox = { x0: p.x, x1: p.x, y0: p.y, y1: p.y };
      this._penSince = nowMs;
      return;
    }

    if (nowMs - this._penSince < SEARCH_AFTER_MS) return;

    /* Confined for too long. Shove it, away from the nearest side wall so the
       push has somewhere to go, and escalate if it does not take. */
    this._searches++;
    const away = p.x < LAYOUT.centre ? 1 : -1;
    const power = 60 + this._searches * 40;

    ball.addVel(away * power, -power * 0.75);
    this.shake = Math.min(1, this.shake + 0.5);

    this._penBox = null;
    this._sound('kickback');
    this._emit('ballSearch', { attempt: this._searches, box: { ...box } });
  }

  /* ---------------------------------------------------------------
     Draining and game over
     --------------------------------------------------------------- */

  _checkDrain() {
    if (this.phase === PHASE.PLUNGE || this.phase === PHASE.BALL_LOST) return;
    if (!this.ball || this.ball.held) return;
    if (this.ball.pos.y <= this.world.drainY) return;

    /* ---- ball save ---- */
    if (this.run.ballSaveFor > 0 && !this.world.tilted) {
      this.run.ballSaveFor = 0;
      this.ball.moveTo(LAYOUT.shooter.launch.x, LAYOUT.shooter.launch.y);
      this.ball.freeze();
      this.ball.held = true;
      this.phase = PHASE.PLUNGE;
      this._plunge = { pulling: false, pull: 0 };
      this._sound('ballSave');
      this._emit('ballSave', {});
      return;
    }

    /* Anything in progress ends with the ball — and only with a ball genuinely
       lost, which is why this sits below the save. Keyed off the sub-mode rather
       than the phase for the same reason update() is. */
    if (this.sub?.kind === 'encounter') this._escape('drain');
    else if (this.sub?.kind === 'evolution') this._evolutionFailed('drain');
    else if (this.sub?.kind === 'boss') this._bossFled();

    this.ball.alive = false;
    this.phase = PHASE.BALL_LOST;
    this._ballLostUntil = this._lastNow + BALL_LOST_PAUSE * 1000;

    this._sound('drain');
    this._emit('ballLost', {
      ballNumber: this.run.ballNumber,
      ballsLeft: this.run.ballsLeft - 1,
      tilted: this.world.tilted
    });
  }

  _nextBall() {
    this.run.ballsLeft--;

    // Flippers come back after a tilt; the penalty was the ball.
    this.parts.flippers.left.active = true;
    this.parts.flippers.right.active = true;

    if (this.run.ballsLeft <= 0) { this._gameOver(); return; }

    this.run.ballNumber++;
    // The multiplier is a per-ball reward, so it resets with the ball.
    this.run.multiplier = 1;
    this._serveBall();
  }

  _gameOver() {
    this.phase = PHASE.GAME_OVER;

    const result = store.endGame({
      type: this.run.type,
      score: this.run.score,
      caught: this.run.catches,
      evolved: this.run.evolutions,
      bossWins: this.run.bossWins,
      discTier: this.run.discTier,
      balls: this.run.ballNumber,
      ms: this.run.playMs,
      multiplier: this.run.multiplier
    });

    this._sound('gameOver');
    this._emit('gameOver', {
      type: this.run.type,
      score: this.run.score,
      catches: this.run.catches,
      evolutions: this.run.evolutions,
      bossWins: this.run.bossWins,
      escapes: this.run.escapes,
      discTier: this.run.discTier,
      caught: this.run.caught.slice(),
      rank: result.rank,
      isBest: result.isBest
    });
  }

  /* ---------------------------------------------------------------
     Scoring
     --------------------------------------------------------------- */

  /**
   * Add to the score.
   *
   * `mult: false` for the big one-off awards — completing the bank, a
   * capture, an evolution. Those are already sized for the moment, and
   * running them through an x8 multiplier as well makes the difference
   * between a good game and a lucky one far too wide.
   */
  _award(base, { mult = true } = {}) {
    if (!this.run) return 0;
    const disc = DISC_TIERS[this.run.discTier].score;
    const gained = Math.round(base * disc * (mult ? this.run.multiplier : 1));

    const before = this.run.score;
    this.run.score += gained;
    this._emit('score', { score: this.run.score, gained });

    // Announced on the crossing rather than polled, so it is said once.
    if (before < SHINY_DOUBLE_AT && this.run.score >= SHINY_DOUBLE_AT) {
      this._emit('shinyBoost', { score: this.run.score, odds: this._shinyOdds() });
    }

    this._checkExtraBall();
    return gained;
  }

  _bumpMultiplier(by) {
    if (!this.run) return;
    const before = Math.floor(this.run.multiplier);
    this.run.multiplier = Math.min(MAX_MULTIPLIER, this.run.multiplier + by);
    const after = Math.floor(this.run.multiplier);
    if (after > before) {
      this._sound('multiplier');
      this._emit('multiplier', { multiplier: after });
    }
  }

  _checkExtraBall() {
    for (const threshold of EXTRA_BALL_AT) {
      if (this.run.score < threshold) break;
      if (this.run.extraBallsAwarded.includes(threshold)) continue;
      this.run.extraBallsAwarded.push(threshold);
      this.run.ballsLeft++;
      this._sound('extraBall');
      this._emit('extraBall', { threshold, ballsLeft: this.run.ballsLeft });
    }
  }

  /* ---------------------------------------------------------------
     The view the renderer needs
     --------------------------------------------------------------- */

  /** Everything render.js needs for a frame, and nothing it does not. */
  view() {
    const s = this.sub;
    return {
      discTier: this.run?.discTier ?? 0,
      shake: this.shake,
      plunger: this.phase === PHASE.PLUNGE ? this._plunge.pull : 0,
      showTrail: store.setting('showTrail') !== false,
      litLetters: {
        bank: this.run?.bank ?? [],
        lanes: this.run?.lanes ?? []
      },
      /**
       * During Evolution Mode the drop target bank is the shard bank. It has to
       * look different, or there is nothing on the table to tell you what to
       * shoot — the targets are identical to the ones that spell CATCH.
       */
      shardMode: s?.kind === 'evolution',
      encounter: s ? {
        sprite: s.shiny ? (s.sp || s.from).shinyPath : (s.sp || s.from).imagePath,
        shiny: s.shiny,
        x: s.x, y: s.y, r: s.r,
        meterFrac: s.kind === 'evolution'
          ? s.shards / EVOLUTION_SHARDS
          : 1 - (s.meter / s.meterMax),
        flash: s.flash,
        shielded: !!s.shielded
      } : null
    };
  }

  /** A compact snapshot for the HUD. */
  hud() {
    if (!this.run) return null;
    const s = this.sub;
    return {
      phase: this.phase,
      type: this.run.type,
      mode: this.mode,
      score: this.run.score,
      ballNumber: this.run.ballNumber,
      ballsLeft: this.run.ballsLeft,
      multiplier: this.run.multiplier,
      disc: DISC_TIERS[this.run.discTier],
      discTier: this.run.discTier,
      bank: this.run.bank.slice(),
      lanes: this.run.lanes.slice(),
      catches: this.run.catches,
      spins: this.run.spins,
      shiftCharges: this.run.shiftCharges,
      awaitingShift: this._awaitingShift,
      ballSave: this.run.ballSaveFor,
      kickback: { ...this.run.kickback },
      tilted: this.world.tilted,
      tilt: this.world.tilt,
      armed: {
        encounter: this.run.encounterArmed,
        evolution: this.run.evolutionArmed && this._evolvable().length > 0,
        boss: this.run.gateArmed
      },
      sub: s ? {
        kind: s.kind,
        name: (s.sp || s.to)?.name,
        seconds: Math.max(0, s.seconds),
        meter: s.meter ?? 0,
        meterMax: s.meterMax ?? 0,
        shards: s.shards ?? 0,
        shardsNeeded: EVOLUTION_SHARDS,
        shielded: !!s.shielded,
        shiny: !!s.shiny
      } : null
    };
  }

  /* ---------------------------------------------------------------
     Plumbing
     --------------------------------------------------------------- */

  _emit(type, payload) {
    try { this.onEvent?.(type, payload); }
    catch (e) { console.error('[game] event handler threw', type, e); }
  }

  _sound(name, opts) {
    try { this.audio?.play?.(name, opts); }
    catch { /* audio must never break a ball in play */ }
  }
}
