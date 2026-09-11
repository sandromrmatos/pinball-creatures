/* ============================================================
   physics.js — the pinball solver

   A pinball table is a much narrower problem than general 2D physics: one
   or two circles bouncing off static walls, a handful of round bumpers, and
   two capsules that rotate about a pivot. Nothing stacks, nothing rests on
   anything dynamic, and nothing needs a joint. So this is not a rigid-body
   engine — it is a swept circle against a list of shapes, which is both far
   less code and far easier to make *feel* right.

   Two things matter more than anything else here:

   1. The ball must never pass through a wall. At full speed a pinball moves
      further in one 60 Hz frame than its own diameter, which is exactly how
      balls escape tables. The fix is a fixed 240 Hz step plus adaptive
      sub-stepping inside it, so no integration step ever moves the ball more
      than a fraction of its radius.

   2. A flipper has to *throw* the ball, not bounce it. That means resolving
      the collision against the flipper surface's own velocity at the contact
      point (ω × r), not against a static wall. Get this wrong and the table
      feels dead no matter what the restitution is.

   Units are table units, not pixels: the table is TABLE_W x TABLE_H and the
   renderer scales. Keeping physics in its own space means the feel does not
   change with screen size.
   ============================================================ */

/* ---------------------------------------------------------------
   Table space
   --------------------------------------------------------------- */

/** Portrait, roughly the proportions of a real cabinet playfield. */
export const TABLE_W = 100;
export const TABLE_H = 180;

/* ---------------------------------------------------------------
   Vectors — plain {x, y} objects, no class, no allocation discipline
   beyond keeping the hot loop free of garbage.
   --------------------------------------------------------------- */

export const vec = (x = 0, y = 0) => ({ x, y });
export const vlen = a => Math.hypot(a.x, a.y);
export const vlen2 = a => a.x * a.x + a.y * a.y;
export const vdot = (a, b) => a.x * b.x + a.y * b.y;
export const vadd = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
export const vsub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
export const vmul = (a, s) => ({ x: a.x * s, y: a.y * s });
export const vdist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function vnorm(a) {
  const l = Math.hypot(a.x, a.y);
  return l > 1e-9 ? { x: a.x / l, y: a.y / l } : { x: 0, y: 0 };
}

/** Perpendicular, rotated a quarter turn anticlockwise. */
export const vperp = a => ({ x: -a.y, y: a.x });

export const TAU = Math.PI * 2;

/** Angle folded into [0, TAU), so arc span tests work across the 0 seam. */
export function wrapAngle(a) {
  let r = a % TAU;
  if (r < 0) r += TAU;
  return r;
}

/* ---------------------------------------------------------------
   Tuning
   --------------------------------------------------------------- */

/**
 * Fixed physics rate. High enough that a fast ball moves under half its
 * radius per step, which is what keeps it inside the table.
 */
export const PHYS_HZ = 240;
export const PHYS_DT = 1 / PHYS_HZ;

/** If the accumulator ever falls this far behind, drop the backlog rather
    than spiral: a long stall (app backgrounded, GC pause) must not fast
    forward the ball into a drain. */
export const MAX_STEPS_PER_FRAME = 12;

/**
 * Terminal speed, as a safety net rather than a design value.
 *
 * For scale: a ball dropped the full height of the table under standard
 * gravity arrives at about 218 u/s, and a strong flipper shot leaves at
 * roughly 260. This ceiling only exists to stop a pathological case — a ball
 * pinched between a gear and a wall — from compounding into a rocket.
 */
export const MAX_SPEED = 330;

/** Below this the ball is treated as at rest against a surface, which stops
    the endless micro-bouncing you otherwise get in a shallow trough. */
const REST_SPEED = 1.6;

/**
 * How much of a surface's friction survives a resting contact.
 *
 * Coulomb friction has a static regime: a ball on a slope is held for good
 * whenever tan(angle) is under mu x (1 + e). With the flipper's rubber at
 * mu 0.5 that angle is 30 degrees, and even a plain wall at mu 0.05 holds
 * anything under 4 — so the ball would park on a lowered flipper, on a target
 * face, or in the crook of a funnel and stay there. On a table where gravity
 * *is* the playfield's incline, that is simply wrong: if a surface is tilted at
 * all the ball has to keep creeping down it.
 *
 * Raising gravity does not help, which is worth knowing before reaching for it:
 * the holding force and the pull along the slope both scale with gravity, so the
 * angle at which the ball sticks is identical at any incline. The grip is the
 * only thing that can be changed.
 *
 * The reason it is wrong is that a pinball rolls. Rolling resistance is a small
 * fraction of sliding friction, and this is the fraction. It puts the holding
 * angle at about a tenth of a degree on a wall and one degree on flipper
 * rubber — near enough to "any slope at all keeps the ball moving", which is
 * the behaviour being asked for.
 *
 * Cradling a ball on a raised flipper still works, and works for the right
 * reason: the ball rolls *down* the raised bat towards the pivot and settles in
 * the pocket between the bat and the inlane wall, held by geometry rather than
 * by grip. On a lowered bat it rolls the other way, off the tip and towards the
 * drain, which is exactly what a real table does.
 *
 * Only resting contacts are scaled. A real impact — a flipper swinging into the
 * ball, a shot into a target — has a large normal speed and keeps the full
 * friction, so the grip that makes a tip shot differ from a base shot is
 * untouched.
 */
const ROLLING_GRIP = 0.03;

/* ---------------------------------------------------------------
   Ball
   --------------------------------------------------------------- */

export class Ball {
  constructor({ x = TABLE_W / 2, y = TABLE_H / 2, r = 2.35, mass = 1 } = {}) {
    this.pos = vec(x, y);
    this.vel = vec(0, 0);
    this.r = r;
    this.mass = mass;

    /** Set false to take the ball out of play without removing it. */
    this.alive = true;
    /** Held still by a kicker, a saucer or the plunger lane. */
    this.held = false;

    /** Recent positions for the motion trail. Newest last. */
    this.trail = [];
    this._trailTick = 0;

    /** Set by the world each step, read by the renderer for spin. */
    this.spin = 0;

    /** Anything the game wants to hang on a ball, e.g. which gimmick owns it. */
    this.tag = null;
  }

  get speed() { return vlen(this.vel); }

  setVel(x, y) { this.vel.x = x; this.vel.y = y; return this; }

  addVel(x, y) { this.vel.x += x; this.vel.y += y; return this; }

  moveTo(x, y) { this.pos.x = x; this.pos.y = y; this.trail.length = 0; return this; }

  /** Stop dead. Used by saucers and the plunger lane. */
  freeze() { this.vel.x = 0; this.vel.y = 0; return this; }
}

/* ---------------------------------------------------------------
   Colliders
   --------------------------------------------------------------- */

let nextId = 1;

/**
 * Every collider shares this envelope. `active` is how the game turns a
 * drop target or a vine off without rebuilding the table, and `onHit`
 * is where scoring lives — physics never knows what a point is.
 */
function base(o) {
  return {
    id: o.id || `c${nextId++}`,
    kind: o.kind,
    active: o.active !== false,
    restitution: o.restitution ?? 0.42,
    friction: o.friction ?? 0.05,
    /** Extra impulse along the contact normal. What makes a bumper a bumper. */
    kick: o.kick ?? 0,
    /** Ignored by collision, fires onHit when the ball enters. */
    sensor: !!o.sensor,
    /** Blocks only from one side; the vector points the way through. */
    oneWay: o.oneWay || null,
    onHit: o.onHit || null,
    /** Free-form, for the renderer: colour, label, flash state. */
    meta: o.meta || {},
    /** Cooldown so a resting ball does not machine-gun a sensor. */
    cooldown: 0,
    cooldownFor: o.cooldownFor ?? 0.08,
    /** Set by the solver each time it fires, for flash effects. */
    litUntil: 0
  };
}

/**
 * A capsule: the segment a→b inflated by `thick`. Every wall, rail, rubber
 * and lane divider on the table is one of these. Rounded ends are not a
 * compromise — they are what stops a ball catching on a corner where two
 * walls meet.
 */
export function segment(ax, ay, bx, by, o = {}) {
  return {
    ...base({ ...o, kind: 'seg' }),
    a: vec(ax, ay),
    b: vec(bx, by),
    thick: o.thick ?? 0.6
  };
}

/** A round post, bumper or peg. Give it `kick` to make it pop. */
export function circle(cx, cy, r, o = {}) {
  return { ...base({ ...o, kind: 'circle' }), c: vec(cx, cy), r };
}

/**
 * A curved wall: radius `r` about `c`, starting at `a0` and sweeping
 * anticlockwise by `sweep` radians. Used for orbit loops and the arched
 * top of the table, where a chain of segments would leave the ball
 * clicking over every joint.
 */
export function arc(cx, cy, r, a0, sweep, o = {}) {
  return {
    ...base({ ...o, kind: 'arc' }),
    c: vec(cx, cy),
    r,
    a0: wrapAngle(a0),
    sweep: Math.min(Math.abs(sweep), TAU),
    thick: o.thick ?? 0.6
  };
}

/** Fires onHit while the ball overlaps. No collision response. */
export function sensorCircle(cx, cy, r, o = {}) {
  return { ...base({ ...o, kind: 'circle', sensor: true }), c: vec(cx, cy), r };
}

export function sensorRect(x, y, w, h, o = {}) {
  return { ...base({ ...o, kind: 'rect', sensor: true }), x, y, w, h };
}

/**
 * A region that accelerates the ball while it is inside — the Gale Spire's
 * updraught, and the gentle inward push that keeps an orbit loop tracking.
 * Not a collider: it never touches velocity through a normal.
 */
export function field(x, y, w, h, ax, ay, o = {}) {
  return { ...base({ ...o, kind: 'field', sensor: true }), x, y, w, h, ax, ay };
}

/* ---------------------------------------------------------------
   Flipper
   --------------------------------------------------------------- */

/**
 * A capsule rotating about `pivot`, swinging between `restAngle` and
 * `restAngle + range`. Angles are measured the usual screen way: x right,
 * y down, so positive angles rotate clockwise on screen.
 *
 * `up` is the *commanded* state. The flipper accelerates towards its
 * commanded end stop rather than teleporting, because the ball has to be
 * able to meet the flipper mid-swing — that is where a live catch and a
 * proper launch come from.
 */
export class Flipper {
  /**
   * Defaults matter here, so they are chosen rather than guessed.
   *
   * The launch speed a flipper produces is close to
   *
   *     surface speed x (1 + restitution)  =  omega x contact radius x (1 + e)
   *
   * because the ball is nearly at rest when the bat arrives, so the whole
   * surface velocity is relative velocity. That single line drives both
   * numbers below.
   *
   * The design target is a full tip shot of about 250 u/s. Reaching the top of
   * the table from the flippers needs sqrt(2 * 132 * 138) = 191 u/s, so 250 is
   * a decisive shot with headroom, and it stays well clear of MAX_SPEED — a
   * flipper that pins every shot against the clamp makes aiming meaningless.
   *
   * With length 17 and a 0.95 rad throw, omega 14 and e 0.15 give
   * 14 x 16 x 1.15 = 258 at the tip and about 97 at the base, so where you
   * catch the ball on the bat genuinely changes the shot. The swing takes
   * 0.95 / 14 = 68 ms, in the range a real solenoid does it.
   *
   * `restitution` is low on purpose, and not only for the sums: a bat that
   * barely bounces is what lets a player dead-bounce and trap the ball, which
   * is most of the skill in holding a table.
   *
   * `friction` is high because a flipper face is rubber, and here it earns its
   * keep twice. Grip is what stops the ball sliding out along the bat during
   * the swing, and that sliding is what flattens the difference between a base
   * shot and a tip shot. At 0.14 the two were within 30% of each other and
   * where you caught the ball hardly mattered.
   */
  constructor({
    pivot, length = 17, thick = 1.9,
    restAngle, range,
    upSpeed = 14, downSpeed = 9.5,
    restitution = 0.15, friction = 0.5,
    side = 'left', id = null
  }) {
    this.id = id || `flip-${side}`;
    this.side = side;
    this.pivot = vec(pivot.x, pivot.y);
    this.length = length;
    this.thick = thick;

    this.restAngle = restAngle;
    this.range = range;             // signed: which way it swings
    this.angle = restAngle;
    this.omega = 0;

    this.upSpeed = upSpeed;
    this.downSpeed = downSpeed;
    this.restitution = restitution;
    this.friction = friction;

    this.up = false;
    this.active = true;

    /** True on the step the flipper reached its raised stop, for the sound. */
    this.justSnapped = false;
  }

  get endAngle() { return this.restAngle + this.range; }

  /** The moving end of the capsule. */
  get tip() {
    return vec(
      this.pivot.x + Math.cos(this.angle) * this.length,
      this.pivot.y + Math.sin(this.angle) * this.length
    );
  }

  /**
   * Rotate towards the commanded stop at a constant rate. Constant rate,
   * not eased: a real flipper is a solenoid slamming into a stop, and easing
   * the last few degrees is what makes a soft, unsatisfying table.
   */
  update(dt) {
    this.justSnapped = false;
    if (!this.active) { this.omega = 0; return; }

    const target = this.up ? this.endAngle : this.restAngle;
    const rate = (this.up ? this.upSpeed : this.downSpeed) * Math.sign(this.range || 1);
    const before = this.angle;

    if (this.up) {
      this.angle = this.range > 0 ? Math.min(target, this.angle + Math.abs(rate) * dt)
                                  : Math.max(target, this.angle - Math.abs(rate) * dt);
    } else {
      this.angle = this.range > 0 ? Math.max(target, this.angle - Math.abs(rate) * dt)
                                  : Math.min(target, this.angle + Math.abs(rate) * dt);
    }

    this.omega = dt > 0 ? (this.angle - before) / dt : 0;
    if (this.up && this.angle === target && before !== target) this.justSnapped = true;
  }

  /** Velocity of the flipper's surface at a world point: ω × r, in 2D. */
  velocityAt(p) {
    const rx = p.x - this.pivot.x;
    const ry = p.y - this.pivot.y;
    return vec(-this.omega * ry, this.omega * rx);
  }

  /** 0 at rest, 1 fully raised. The renderer uses it, not the raw angle. */
  get travel() {
    if (!this.range) return 0;
    return Math.abs((this.angle - this.restAngle) / this.range);
  }
}

/* ---------------------------------------------------------------
   Rotor
   --------------------------------------------------------------- */

/**
 * A capsule that spins continuously instead of being flipped: the Cogwork
 * Foundry's gears and the Rune Sanctum's disc.
 *
 * It deliberately presents the same surface as Flipper — `pivot`, `tip`,
 * `thick`, `active`, `restitution`, `friction`, `velocityAt()`, `update()` —
 * because the collision response for a rotating capsule is identical. The
 * solver resolves both from one code path (World._resolveBats) rather than
 * carrying a second, near-duplicate implementation that could drift.
 *
 * A rotor is a hazard as much as a feature: it holds its angular velocity
 * whatever it hits, so it will happily fire the ball straight at the drain.
 */
export class Rotor {
  constructor({
    pivot, length = 10, thick = 1.6,
    omega = 6, angle = 0,
    restitution = 0.5, friction = 0.1,
    id = null
  }) {
    this.id = id || `rotor-${nextId++}`;
    this.pivot = vec(pivot.x, pivot.y);
    this.length = length;
    this.thick = thick;

    /** Radians per second. Negative spins the other way. */
    this.omega = omega;
    this.angle = angle;

    this.restitution = restitution;
    this.friction = friction;
    this.active = true;

    /** Rotors are double-ended, so both arms hit. */
    this.doubleEnded = true;
  }

  get tip() {
    return vec(
      this.pivot.x + Math.cos(this.angle) * this.length,
      this.pivot.y + Math.sin(this.angle) * this.length
    );
  }

  /** The opposite arm, only used when doubleEnded. */
  get tail() {
    return vec(
      this.pivot.x - Math.cos(this.angle) * this.length,
      this.pivot.y - Math.sin(this.angle) * this.length
    );
  }

  update(dt) { this.angle = wrapAngle(this.angle + this.omega * dt); }

  velocityAt(p) {
    const rx = p.x - this.pivot.x;
    const ry = p.y - this.pivot.y;
    return vec(-this.omega * ry, this.omega * rx);
  }
}

/* ---------------------------------------------------------------
   Closest-point helpers
   --------------------------------------------------------------- */

/** Closest point on the segment a→b to p, clamped to the ends. */
function closestOnSegment(p, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  if (len2 < 1e-12) return { x: a.x, y: a.y, t: 0 };
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return { x: a.x + abx * t, y: a.y + aby * t, t };
}

const insideRect = (p, r, rect) =>
  p.x + r > rect.x && p.x - r < rect.x + rect.w &&
  p.y + r > rect.y && p.y - r < rect.y + rect.h;

/* ---------------------------------------------------------------
   World
   --------------------------------------------------------------- */

export class World {
  constructor({ gravity = 132, drainY = TABLE_H + 6 } = {}) {
    /** Downward acceleration in table units per second squared. */
    this.gravity = gravity;
    this.drainY = drainY;

    this.colliders = [];
    this.fields = [];
    this.balls = [];

    /**
     * Every rotating capsule, player-driven or not. Flippers and rotors
     * collide identically, so the solver walks this one list; `flippers` and
     * `rotors` are views onto it for the parts of the game that care which
     * is which (input only touches flippers, the renderer draws them
     * differently).
     */
    this.bats = [];
    this.flippers = [];
    this.rotors = [];

    /** Global velocity damping per second — the felt of the playfield. */
    this.damping = 0.06;

    /** Nudge state. A nudge shifts the whole table for a moment. */
    this.nudge = vec(0, 0);
    this.tilt = 0;
    this.tilted = false;

    /** Filled each step, drained by the game and the renderer. */
    this.events = [];

    this.time = 0;
    /** Total fixed steps taken. Exposed so tests can prove that a given
        amount of simulated time costs the same work at any frame rate. */
    this.steps = 0;
    this._acc = 0;
  }

  /* ---- construction ---- */

  add(...colliders) {
    for (const c of colliders.flat(3)) {
      if (!c) continue;
      if (c.kind === 'field') this.fields.push(c);
      else this.colliders.push(c);
    }
    return this;
  }

  addFlipper(f) { this.bats.push(f); this.flippers.push(f); return f; }

  addRotor(r) { this.bats.push(r); this.rotors.push(r); return r; }

  addBall(b) { this.balls.push(b); return b; }

  removeBall(b) {
    const i = this.balls.indexOf(b);
    if (i !== -1) this.balls.splice(i, 1);
  }

  /**
   * Take a collider back out. Used for things that exist only for the length
   * of a mode — the creature in an encounter, a boss's shield — where leaving
   * a deactivated collider behind would slowly grow the list every mode.
   */
  remove(collider) {
    if (!collider) return false;
    for (const list of [this.colliders, this.fields]) {
      const i = list.indexOf(collider);
      if (i !== -1) { list.splice(i, 1); return true; }
    }
    return false;
  }

  /** Drop every collider and field but keep the flippers and balls. */
  clearColliders() { this.colliders.length = 0; this.fields.length = 0; }

  byId(id) { return this.colliders.find(c => c.id === id) || this.fields.find(c => c.id === id) || null; }

  /* ---- stepping ---- */

  /**
   * Advance by real elapsed time, in fixed PHYS_DT slices.
   *
   * The accumulator is what makes the table behave identically on a 60 Hz
   * phone and a 120 Hz one. The backlog cap is what stops a background tab
   * coming back and running two seconds of physics in one frame.
   */
  advance(elapsed) {
    this._acc += Math.min(elapsed, MAX_STEPS_PER_FRAME * PHYS_DT);
    let steps = 0;
    while (this._acc >= PHYS_DT && steps < MAX_STEPS_PER_FRAME) {
      this.step(PHYS_DT);
      this._acc -= PHYS_DT;
      steps++;
    }
    // Fraction of a step left over, for render interpolation.
    return this._acc / PHYS_DT;
  }

  step(dt) {
    this.time += dt;
    this.steps++;

    for (const b of this.bats) b.update(dt);
    for (const c of this.colliders) if (c.cooldown > 0) c.cooldown -= dt;

    // A nudge is a brief acceleration of the whole cabinet, so it decays fast.
    if (this.nudge.x || this.nudge.y) {
      const decay = Math.exp(-dt * 9);
      this.nudge.x *= decay;
      this.nudge.y *= decay;
      if (Math.abs(this.nudge.x) < 0.01) this.nudge.x = 0;
      if (Math.abs(this.nudge.y) < 0.01) this.nudge.y = 0;
    }
    if (this.tilt > 0) this.tilt = Math.max(0, this.tilt - dt * 0.55);

    for (const ball of this.balls) {
      if (!ball.alive || ball.held) continue;
      this._stepBall(ball, dt);
    }
  }

  /**
   * One ball, one step, sub-divided so it never moves far enough to skip a
   * wall. `sub` is derived from the ball's own speed, so a slow ball costs
   * one iteration and only a screaming one pays for eight.
   */
  _stepBall(ball, dt) {
    const speed = ball.speed;
    const maxTravel = ball.r * 0.4;
    const sub = Math.max(1, Math.min(8, Math.ceil((speed * dt) / maxTravel)));
    const h = dt / sub;

    for (let i = 0; i < sub; i++) {
      /* ---- forces ---- */
      let ax = this.nudge.x;
      let ay = this.gravity + this.nudge.y;

      for (const f of this.fields) {
        if (!f.active) continue;
        if (insideRect(ball.pos, ball.r * 0.5, f)) {
          ax += f.ax;
          ay += f.ay;
          this._fire(f, ball, null);
        }
      }

      ball.vel.x += ax * h;
      ball.vel.y += ay * h;

      /* ---- drag ---- */
      const drag = 1 - this.damping * h;
      ball.vel.x *= drag;
      ball.vel.y *= drag;

      /* ---- clamp ---- */
      const sp = ball.speed;
      if (sp > MAX_SPEED) {
        const k = MAX_SPEED / sp;
        ball.vel.x *= k;
        ball.vel.y *= k;
      }

      /* ---- integrate ---- */
      ball.pos.x += ball.vel.x * h;
      ball.pos.y += ball.vel.y * h;

      /* ---- resolve ---- */
      this._resolveStatic(ball, h);
      this._resolveBats(ball, h);
    }

    /* ---- spin, purely cosmetic ---- */
    ball.spin += (ball.vel.x / Math.max(ball.r, 0.1)) * dt;

    /* ---- trail ---- */
    if (++ball._trailTick % 3 === 0) {
      ball.trail.push(vec(ball.pos.x, ball.pos.y));
      if (ball.trail.length > 14) ball.trail.shift();
    }
  }

  /* ---- static colliders ---- */

  _resolveStatic(ball, dt) {
    for (const c of this.colliders) {
      if (!c.active) continue;

      let n = null;      // unit normal, from surface towards the ball
      let depth = 0;     // how far they overlap

      if (c.kind === 'seg') {
        const cp = closestOnSegment(ball.pos, c.a, c.b);
        const dx = ball.pos.x - cp.x, dy = ball.pos.y - cp.y;
        const d = Math.hypot(dx, dy);
        const rad = ball.r + c.thick;
        if (d < rad) {
          depth = rad - d;
          // Degenerate case: the centre sits exactly on the segment. Use the
          // segment's own perpendicular so the ball is pushed somewhere sane
          // instead of nowhere.
          n = d > 1e-6 ? vec(dx / d, dy / d) : vnorm(vperp(vsub(c.b, c.a)));
        }

      } else if (c.kind === 'circle') {
        const dx = ball.pos.x - c.c.x, dy = ball.pos.y - c.c.y;
        const d = Math.hypot(dx, dy);
        const rad = ball.r + c.r;
        if (d < rad) {
          depth = rad - d;
          n = d > 1e-6 ? vec(dx / d, dy / d) : vec(0, -1);
        }

      } else if (c.kind === 'arc') {
        const dx = ball.pos.x - c.c.x, dy = ball.pos.y - c.c.y;
        const d = Math.hypot(dx, dy);
        if (d > 1e-6) {
          const within = wrapAngle(Math.atan2(dy, dx) - c.a0) <= c.sweep;
          const gap = Math.abs(d - c.r);
          const rad = ball.r + c.thick;
          if (within && gap < rad) {
            depth = rad - gap;
            // Push out the way the ball already is: outside the ring stays
            // outside, inside stays inside.
            const sign = d >= c.r ? 1 : -1;
            n = vec((dx / d) * sign, (dy / d) * sign);
          }
        }

      } else if (c.kind === 'rect') {
        if (insideRect(ball.pos, ball.r, c)) { this._fire(c, ball, null); }
        continue;
      }

      if (!n) continue;

      /* A sensor reports and gets out of the way. */
      if (c.sensor) { this._fire(c, ball, n); continue; }

      /* One-way gates: pass freely in the permitted direction. */
      if (c.oneWay && vdot(ball.vel, c.oneWay) > 0) continue;

      this._respond(ball, c, n, depth, c.restitution, c.friction, null, dt);
      this._fire(c, ball, n);
    }
  }

  /* ---- rotating capsules: flippers and rotors ---- */

  /**
   * One path for both, because the response is the same: find the closest
   * point on the bat, take the surface velocity there, and let _respond do
   * the rest. A rotor is simply a bat whose angular velocity never stops.
   */
  _resolveBats(ball, dt) {
    for (const bat of this.bats) {
      if (!bat.active) continue;

      // A rotor is double-ended, so both arms have to be tested.
      const ends = bat.doubleEnded ? [bat.tip, bat.tail] : [bat.tip];

      for (const end of ends) {
        const cp = closestOnSegment(ball.pos, bat.pivot, end);
        const dx = ball.pos.x - cp.x, dy = ball.pos.y - cp.y;
        const d = Math.hypot(dx, dy);
        const rad = ball.r + bat.thick;
        if (d >= rad) continue;

        const n = d > 1e-6 ? vec(dx / d, dy / d) : vnorm(vperp(vsub(end, bat.pivot)));
        const surfaceV = bat.velocityAt(cp);

        this._respond(ball, bat, n, rad - d, bat.restitution, bat.friction, surfaceV, dt);

        this.events.push({
          type: bat instanceof Flipper ? 'flipper' : 'rotor',
          id: bat.id,
          bat,
          ball,
          // Contact distance along the bat, 0 at the pivot and 1 at the end.
          along: cp.t,
          speed: ball.speed
        });
      }
    }
  }

  /**
   * The one place velocity changes on contact.
   *
   * Everything is done in the surface's frame of reference: subtract the
   * surface velocity, reflect, then add it back. For a static wall the
   * surface velocity is zero and this reduces to an ordinary bounce; for a
   * flipper mid-swing it is what launches the ball. The same three lines
   * therefore cover a wall, a rubber, a spinning gear and a live flipper,
   * which is the reason there is no separate flipper impulse hack anywhere.
   */
  _respond(ball, source, n, depth, restitution, friction, surfaceV, dt) {
    /* ---- positional correction, always ---- */
    if (depth > 0) {
      ball.pos.x += n.x * depth;
      ball.pos.y += n.y * depth;
    }

    /* ---- into the surface's frame ---- */
    let rvx = ball.vel.x, rvy = ball.vel.y;
    if (surfaceV) { rvx -= surfaceV.x; rvy -= surfaceV.y; }

    const vn = rvx * n.x + rvy * n.y;

    // Separating already: a moving surface can catch up with a ball that is
    // technically leaving, and reflecting then would suck it back in.
    if (vn > 0 && !surfaceV) return;

    if (vn < 0) {
      // Low-speed contacts get almost no restitution, so a ball settles into
      // a trough instead of buzzing in it.
      const resting = Math.abs(vn) < REST_SPEED;
      const e = resting ? restitution * 0.25 : restitution;

      // A resting ball rolls rather than slides, so it keeps only a fraction of
      // the grip. See ROLLING_GRIP: this is what stops it parking on a slope.
      const mu = resting ? friction * ROLLING_GRIP : friction;

      /* Normal impulse per unit mass. Always non-negative here. */
      const jn = -(1 + e) * vn;

      /* Tangential part, with Coulomb friction: the most the surface can take
         out of the sliding speed is mu times the normal impulse.
         
         This has to be proportional to the normal impulse rather than a flat
         fraction of the tangential velocity. A fractional decay is applied
         once per sub-step, so a ball in continuous contact — resting on a
         flipper, trickling down an outlane — gets it 240 times a second and
         freezes solid where it should be rolling away. That produced balls
         balanced motionless on a flipper tip forever.
         
         Scaling by the normal impulse gives the behaviour surfaces actually
         have: a hard hit is gripped, a resting touch is barely held at all. */
      const tx = rvx - vn * n.x;
      const ty = rvy - vn * n.y;
      const tLen = Math.hypot(tx, ty);

      const drop = Math.min(mu * jn, tLen);
      const keep = tLen > 1e-9 ? (tLen - drop) / tLen : 0;

      rvx = tx * keep + (vn + jn) * n.x;
      rvy = ty * keep + (vn + jn) * n.y;
    }

    /* ---- back into world space ---- */
    ball.vel.x = rvx + (surfaceV ? surfaceV.x : 0);
    ball.vel.y = rvy + (surfaceV ? surfaceV.y : 0);

    /* ---- active kick: bumpers, slingshots, kickbacks ---- */
    const kick = source.kick || 0;
    if (kick > 0) {
      ball.vel.x += n.x * kick;
      ball.vel.y += n.y * kick;
    }

    const sp = ball.speed;
    if (sp > MAX_SPEED) {
      const k = MAX_SPEED / sp;
      ball.vel.x *= k;
      ball.vel.y *= k;
    }
  }

  /**
   * Report a contact, at most once per cooldown window. Without the window a
   * ball resting against a target would score thousands of times a second.
   */
  _fire(c, ball, n) {
    if (c.cooldown > 0) return;
    c.cooldown = c.cooldownFor;
    c.litUntil = this.time + 0.16;

    this.events.push({ type: 'hit', id: c.id, collider: c, ball, normal: n, speed: ball.speed });
    if (c.onHit) {
      try { c.onHit(ball, c, this); }
      catch (e) { console.error('[physics] collider onHit threw', c.id, e); }
    }
  }

  /* ---- nudge ---- */

  /**
   * Shove the cabinet. Each nudge adds to a tilt meter that decays; lean on
   * it and the table tilts, which the game turns into a dead ball. Without
   * the meter, nudging would simply be a free extra control.
   */
  applyNudge(x, y, { tiltCost = 0.34 } = {}) {
    if (this.tilted) return false;
    this.nudge.x += x;
    this.nudge.y += y;
    this.tilt += tiltCost;
    if (this.tilt >= 1) {
      this.tilted = true;
      this.events.push({ type: 'tilt' });
      return false;
    }
    return true;
  }

  resetTilt() { this.tilt = 0; this.tilted = false; }

  /* ---- events ---- */

  /** Take the event list and clear it, so nothing is processed twice. */
  drainEvents() {
    const out = this.events;
    this.events = [];
    return out;
  }
}
