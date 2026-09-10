/* ============================================================
   table.js — the playfield

   One shared skeleton, five swappable centres. The flippers, drain,
   outlanes, slingshots, bumpers, target bank, orbits, ramps and the
   Awakening Well are identical in every mode, so the flipper feel is
   tuned once and never drifts between them. Only the middle of the
   table changes with the type.

   This module is geometry, nothing else. Colliders carry a
   `meta.role` and game.js decides what a contact is worth — no scoring,
   no rules and no state live here. That split is what lets the table be
   rebuilt for a new mode without touching the rules.

   ------------------------------------------------------------
   COORDINATES: 100 wide x 180 tall, x right, y DOWN, so larger y is
   further from the player and gravity is +y.

        0                  46                        100
     0  +---------------------------------------------+
        |          . - - -  dome  - - - .             |
    20  |     [ lanes A  B  C ]                       |
    32  |        (o)        (o)                       |   pop bumpers
    47  |             (o)                             |
    62  |   [ C ][ A ][ T ][ C ][ H ]  drop targets   |
    80  | S|                              |           |   S = spinner
    92  | |        < gimmick centre >     |     ||    |   || = shooter lane
   104  | (ramp)                    (ramp)|     ||    |
   124  |            (( Well ))           |     ||    |
   142  |   /sling\              /sling\  |     ||    |
   156  |      \flipper    flipper/       |     ||    |
   174  +---------------------------------------------+
              ^ outlane   ^ drain   ^ outlane

   Play area is x 3..82; the shooter lane takes x 82..89 below the dome,
   so the playfield centre is 42.5, not 50.
   ------------------------------------------------------------
   ============================================================ */

import { MODES } from './data.js';
import {
  World, Ball, Flipper, Rotor,
  segment, circle, arc, field, sensorCircle,
  TABLE_W, TABLE_H, TAU
} from './physics.js';

/* ---------------------------------------------------------------
   Layout
   --------------------------------------------------------------- */

/**
 * Every dimension on the table, in one object, so render.js draws exactly
 * what physics.js collides with. Two copies of these numbers is how a
 * playfield ends up looking subtly wrong.
 */
export const LAYOUT = {
  width: TABLE_W,
  height: TABLE_H,

  gravity: 118,
  drainY: 174,

  /** Where the play area sits once the shooter lane is taken out. */
  left: 3,
  right: 82,
  get centre() { return (this.left + this.right) / 2; },   // 42.5

  wallThick: 1.5,

  /* The dome is the ceiling. It spans the full width *including* the shooter
     lane, which is what lets a launched ball curve out of the lane and into
     play — so its radius is tied to where the lane's outer wall sits. */
  dome: { cx: 47, cy: 50, r: 44 },

  /**
   * The shooter lane. Its clear width is what matters, not its nominal one:
   * 9 units between wall centres, less half of each 1.5-thick wall, leaves 6
   * clear for a 4.7-wide ball.
   *
   * An earlier version was 7 wide and left only 4 clear. The ball spawned
   * overlapping both walls at once, the two position corrections fought each
   * other, and it was squeezed straight out of the bottom of the lane —
   * which looked like the plunger not working.
   */
  shooter: {
    x0: 82,          // divider, shared with the right outlane's outer edge
    x1: 91,          // outer wall, and where the dome has to reach
    /**
     * The divider is solid up to `solidTopY`, and from there to `gateTopY` it
     * is a one-way that passes a ball moving LEFT and blocks one moving right.
     *
     * Vertical, not horizontal, and that is the whole point. A horizontal gate
     * across the mouth of the lane is a shelf: a ball rolling down the dome's
     * right-hand side lands on it and parks there forever. A vertical one has
     * no upward face to rest on, and it still does the job — the plunged ball
     * bounces off the dome moving up and to the left and passes straight
     * through, while anything coming back along the dome is turned away before
     * it can drop into the lane.
     *
     * `gateTopY` reaches past the dome (which is at y 23.3 here) so there is no
     * sliver of gap at the top for the ball to find.
     */
    solidTopY: 52,
    gateTopY: 20,
    launch: { x: 86.5, y: 166 },
    /**
     * Impulse range for a soft to full plunge.
     *
     * The floor is not a taste decision: clearing the gate from the launch
     * point means climbing 109 units, which needs
     * sqrt(2 * 118 * 109) = 160 u/s before drag. A minimum of 150 fell short,
     * so the softest plunge dropped back and the plunger looked broken. 190
     * clears it with room, and the range then controls how far around the dome
     * the ball carries rather than whether it gets out at all.
     */
    power: { min: 190, max: 275 }
  },

  topLanes: {
    y: 21,
    xs: [26, 42.5, 59],
    r: 3.1,
    dividerTop: 13,
    dividerBottom: 27,
    dividerXs: [34, 51],
    letters: ['A', 'B', 'C']
  },

  bumpers: [
    { x: 30, y: 32 },
    { x: 55, y: 32 },
    { x: 42.5, y: 47 }
  ],
  bumperR: 4.2,
  bumperKick: 62,

  /**
   * The C-A-T-C-H bank. Five drop targets; clearing it arms an encounter.
   *
   * `slope` is not decoration. A target the ball shoots up into has to present
   * a face across the shot, which in a top-down table means a roughly
   * horizontal segment — and a horizontal segment is a shelf the ball comes to
   * rest on top of. Sloping the bank at 0.25 gives a 14 degree incline,
   * steeper than the targets' friction can hold, so a ball that lands on one
   * slides off instead of parking there.
   *
   * The whole bank sits on ONE line: every target's ends are placed from
   * `slope` about `cx`, so the five of them read as a single continuous
   * incline. Tilting each target individually about its own centre was worse
   * than a flat shelf — it left a notch at every junction between neighbours,
   * and each notch caught the ball perfectly.
   *
   * The rule in game.js that drops a target the moment it is touched is the
   * real defence; this keeps the table sane even with the bank already down.
   */
  bank: {
    cx: 43,
    y: 62,
    slope: 0.25,
    xs: [24, 33.5, 43, 52.5, 62],
    halfWidth: 3.4,
    letters: ['C', 'A', 'T', 'C', 'H']
  },

  /**
   * The orbit lanes down each side.
   *
   * Two clearances decide these numbers, and both were originally too tight:
   * the lane itself (guide to outer wall) and the mouth between the guide's
   * top and the end of the target bank. At guide x 14 the mouth was 5.3 clear
   * against a 4.7 ball and simply wedged it.
   *
   * The guides also splay very slightly *outward* on the way down. Angling
   * them inward narrowed the lane from 7.5 clear at the top to 4.5 at the
   * bottom, so a ball would run halfway down and jam. A lane must never
   * converge in the direction the ball travels.
   */
  orbits: {
    leftGuide: { ax: 12, ay: 64, bx: 13, by: 100 },
    rightGuide: { ax: 73, ay: 64, bx: 72, by: 100 },
    spinner: { x: 7.4, y: 82, r: 3.2 }
  },

  gimmick: { cx: 42.5, cy: 92, r: 16 },

  /**
   * The Awakening Well: every mode starts from this saucer.
   *
   * `exit` is the corridor the ball travels through when the Well spits it
   * back out, and it is a hard constraint on every gimmick: NO COLLIDER WITH
   * A KICK MAY SIT IN IT.
   *
   * A bumper here is not merely annoying, it is a lock. The Well ejects
   * upwards, so a bumper above it is struck from below, its contact normal
   * points straight back down, and its kick drives the ball into the hole it
   * just left — which ejects it into the bumper again, forever. Wildwood
   * Green shipped with its stump at (42.5, 100), 24 units directly above the
   * Well, and did exactly that.
   *
   * Walls and vertical bars are fine: they deflect sideways. Rotors are fine
   * too, and are not in `colliders` anyway — an arm always adds tangential
   * velocity, so it cannot produce a repeating trajectory.
   */
  saucer: {
    x: 42.5,
    y: 124,
    r: 5.6,
    exit: { halfWidth: 8, top: 98 }
  },

  ramps: [
    {
      id: 'ramp-left',
      side: 'left',
      entrance: { x: 8, y: 104, r: 4 },
      /* Drawn as a raised lane over the playfield and, like a real
         crossover ramp, it feeds the *opposite* inlane. */
      path: [{ x: 8, y: 104 }, { x: 6, y: 78 }, { x: 14, y: 54 }, { x: 40, y: 40 },
             { x: 66, y: 52 }, { x: 70, y: 96 }, { x: 65.2, y: 146 }],
      exit: { x: 65.2, y: 146, vx: 0, vy: 30 },
      seconds: 1.15
    },
    {
      id: 'ramp-right',
      side: 'right',
      entrance: { x: 77, y: 104, r: 4 },
      path: [{ x: 77, y: 104 }, { x: 79, y: 78 }, { x: 71, y: 54 }, { x: 45, y: 40 },
             { x: 19, y: 52 }, { x: 15, y: 96 }, { x: 19.8, y: 146 }],
      exit: { x: 19.8, y: 146, vx: 0, vy: 30 },
      seconds: 1.15
    }
  ],

  /**
   * Slingshots sit between each inlane and its flipper.
   *
   * Three constraints fix these, and each one broke something when it was
   * missed:
   *
   * 1. Clear of the inlane. Using the slingshot's inner edge as the inlane's
   *    wall pinched the ball in a wedge half a unit wide, because the inlane's
   *    other side converges on the flipper pivot.
   * 2. Clear of the flipper's *shot line*. A ball leaving the left bat travels
   *    up and to the right at about 24 degrees from vertical. With the inner
   *    vertex at (37,139) that line passed 2.6 units from it, so a good save
   *    clipped the slingshot's corner and was kicked straight back down at the
   *    drain. Pulled back to (34,137) the line clears it by 6.5.
   * 3. Clear of the raised bat, so a full flip never swings into it.
   *
   * The short lower edge is also given a real slope: nearly horizontal, it is
   * another shelf for the ball to sit on.
   */
  slingshots: [
    { side: 'left', a: { x: 26, y: 123 }, b: { x: 34, y: 137 }, c: { x: 26, y: 134 } },
    { side: 'right', a: { x: 59, y: 123 }, b: { x: 51, y: 137 }, c: { x: 59, y: 134 } }
  ],
  slingKick: 58,

  /**
   * The lower funnel: outer walls, then the divider between each outlane and
   * inlane.
   *
   * Each divider runs *to its flipper's pivot*, not to a point near it. Ending
   * short leaves a narrow V between the divider's end cap and the pivot post
   * that a ball can neither pass through nor roll out of — it just sits there
   * and the game is over without the ball draining. Aimed at the pivot, the
   * divider surface flows into the post and a ball rolling down it carries on
   * over the post and onto the bat, which is what the inlane is for.
   *
   * The top of each divider also has to clear the outer wall by more than a
   * ball: at x 10 the outlane mouth was 4.55 clear against 4.7 and caught it.
   */
  lower: {
    leftWall: [{ x: 3, y: 118 }, { x: 3, y: 138 }, { x: 13, y: 170 }],
    rightWall: [{ x: 82, y: 138 }, { x: 72, y: 170 }],
    leftDivider: { a: { x: 11.5, y: 124 }, b: { x: 22, y: 156 } },
    rightDivider: { a: { x: 73.5, y: 124 }, b: { x: 63, y: 156 } },
    postR: 1.7,
    inlaneRollovers: [{ x: 25, y: 148, side: 'left' }, { x: 60, y: 148, side: 'right' }],
    outlanes: [{ x: 13, y: 163, r: 3.4, side: 'left' }, { x: 71, y: 163, r: 3.4, side: 'right' }],
    kickbackImpulse: 210
  },

  /**
   * Flippers rest pointing inward and slightly down, with a 0.95 rad throw.
   *
   * The pivots are placed from the drain outwards, not the other way round.
   * What has to be right is the *clear* opening between the tips, and a
   * flipper is a capsule, so that opening is
   *
   *     tip separation - 2 x thickness
   *
   * At 17 long and 0.42 rad each tip sits 15.51 out from its pivot, so pivots
   * 41 apart give tips 9.98 apart and 6.18 clear — about 1.3 ball widths,
   * which is what a real drain looks like.
   *
   * Forgetting the thickness term is not a small error: pivots 37 apart give
   * tips 6 apart, which *looks* like it passes a 4.7 ball but leaves only 2.2
   * clear. The drain is then sealed, and balls pile up balanced on the tips
   * instead of draining.
   */
  flippers: {
    length: 17,
    thick: 1.9,
    left: { pivot: { x: 22, y: 156 }, restAngle: 0.42, range: -0.95 },
    right: { pivot: { x: 63, y: 156 }, restAngle: Math.PI - 0.42, range: 0.95 }
  }
};

/* ---------------------------------------------------------------
   Small builders
   --------------------------------------------------------------- */

const wall = (ax, ay, bx, by, extra = {}) => segment(ax, ay, bx, by, {
  thick: LAYOUT.wallThick,
  restitution: 0.34,
  friction: 0.04,
  meta: { role: 'wall' },
  ...extra
});

/** A chain of walls through a list of points. */
function chain(points, extra = {}) {
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    out.push(wall(points[i].x, points[i].y, points[i + 1].x, points[i + 1].y, extra));
  }
  return out;
}

/* ---------------------------------------------------------------
   The shared skeleton
   --------------------------------------------------------------- */

function buildShell(world, parts) {
  const L = LAYOUT;

  /* ---- dome ---- */
  // The upper semicircle, from (3,50) round to (89,50). One arc rather than a
  // chain of segments so the ball does not tick over a joint on every orbit.
  parts.dome = arc(L.dome.cx, L.dome.cy, L.dome.r, Math.PI, Math.PI, {
    thick: L.wallThick,
    restitution: 0.36,
    friction: 0.03,
    meta: { role: 'dome' }
  });
  world.add(parts.dome);

  /* ---- side walls ---- */
  // The dome's ends land on the left wall and the shooter lane's outer wall,
  // so the boundary is closed everywhere without a seam for the ball to find.
  world.add(
    wall(L.left, L.dome.cy, L.left, 118),                            // left, down to the funnel
    wall(L.shooter.x1, L.dome.cy, L.shooter.x1, L.drainY),           // outer edge of the shooter lane
    wall(L.shooter.x0, L.shooter.solidTopY, L.shooter.x0, L.drainY)  // the divider
  );

  /* ---- shooter lane gate ---- */
  // Vertical and one-way: out of the lane freely, never back in. See the
  // rationale on LAYOUT.shooter.
  parts.laneGate = segment(
    L.shooter.x0, L.shooter.solidTopY,
    L.shooter.x0, L.shooter.gateTopY,
    {
      thick: 0.7,
      restitution: 0.2,
      oneWay: { x: -1, y: 0 },
      meta: { role: 'gate' }
    }
  );
  world.add(parts.laneGate);
}

function buildTopLanes(world, parts) {
  const T = LAYOUT.topLanes;

  parts.topLanes = T.xs.map((x, i) => sensorCircle(x, T.y, T.r, {
    id: `lane-${i}`,
    cooldownFor: 0.5,
    meta: { role: 'topLane', index: i, letter: T.letters[i] }
  }));

  // Short dividers so they behave like lanes rather than one wide mouth.
  const dividers = T.dividerXs.map(x => wall(x, T.dividerTop, x, T.dividerBottom, {
    thick: 0.8,
    meta: { role: 'laneDivider' }
  }));

  world.add(parts.topLanes, dividers);
}

function buildBumpers(world, parts) {
  parts.bumpers = LAYOUT.bumpers.map((b, i) => circle(b.x, b.y, LAYOUT.bumperR, {
    id: `bumper-${i}`,
    restitution: 0.3,
    friction: 0.02,
    kick: LAYOUT.bumperKick,
    cooldownFor: 0.11,
    meta: { role: 'bumper', index: i }
  }));
  world.add(parts.bumpers);
}

function buildBank(world, parts) {
  const B = LAYOUT.bank;

  /**
   * Drop targets are ordinary segments whose `active` the game flips to
   * false when they are knocked down. Physics needs no concept of a target;
   * an inactive collider is simply not there.
   */
  /** Height of the bank's single sloping line at any x. */
  const lineY = x => B.y + (x - B.cx) * B.slope;

  parts.bank = B.xs.map((x, i) => segment(
    x - B.halfWidth, lineY(x - B.halfWidth),
    x + B.halfWidth, lineY(x + B.halfWidth),
    {
      id: `bank-${i}`,
      thick: 1.1,
      restitution: 0.28,
      friction: 0.1,
      cooldownFor: 0.12,
      meta: { role: 'bankTarget', index: i, letter: B.letters[i] }
    }
  ));
  world.add(parts.bank);
}

function buildOrbits(world, parts) {
  const O = LAYOUT.orbits;

  world.add(
    wall(O.leftGuide.ax, O.leftGuide.ay, O.leftGuide.bx, O.leftGuide.by),
    wall(O.rightGuide.ax, O.rightGuide.ay, O.rightGuide.bx, O.rightGuide.by)
  );

  parts.spinner = sensorCircle(O.spinner.x, O.spinner.y, O.spinner.r, {
    id: 'spinner',
    // Short window: a fast ball through the lane should register several
    // revolutions, the way a real spinner racks up.
    cooldownFor: 0.07,
    meta: { role: 'spinner' }
  });
  world.add(parts.spinner);
}

function buildSaucer(world, parts) {
  const S = LAYOUT.saucer;

  /**
   * A sensor, not a hole: the game decides whether to swallow the ball. If
   * it were a collider the ball would bounce off the thing it is supposed
   * to fall into.
   */
  parts.saucer = sensorCircle(S.x, S.y, S.r, {
    id: 'saucer',
    cooldownFor: 0.4,
    meta: { role: 'saucer' }
  });
  world.add(parts.saucer);
}

function buildRamps(world, parts) {
  parts.ramps = LAYOUT.ramps.map(r => {
    const entrance = sensorCircle(r.entrance.x, r.entrance.y, r.entrance.r, {
      id: r.id,
      cooldownFor: 0.5,
      meta: { role: 'rampEntrance', ramp: r.id, side: r.side }
    });
    world.add(entrance);
    return { ...r, entrance };
  });
}

function buildLower(world, parts) {
  const L = LAYOUT.lower;

  world.add(chain(L.leftWall), chain(L.rightWall));

  /* ---- inlane / outlane dividers, each capped with a rubber post ---- */
  const dividers = [L.leftDivider, L.rightDivider].map((d, i) =>
    wall(d.a.x, d.a.y, d.b.x, d.b.y, {
      id: `divider-${i}`,
      thick: 1.1,
      restitution: 0.4,
      meta: { role: 'divider', side: i === 0 ? 'left' : 'right' }
    })
  );

  const posts = [LAYOUT.lower.leftDivider, LAYOUT.lower.rightDivider].map((d, i) =>
    circle(d.a.x, d.a.y, L.postR, {
      id: `post-${i}`,
      restitution: 0.62,       // a live rubber, so a grazing shot changes line
      friction: 0.02,
      meta: { role: 'post' }
    })
  );

  world.add(dividers, posts);

  /* ---- slingshots ---- */
  parts.slingshots = LAYOUT.slingshots.map((s, i) => {
    // Only the long inward face kicks; the two short sides are plain wall.
    const face = segment(s.a.x, s.a.y, s.b.x, s.b.y, {
      id: `sling-${s.side}`,
      thick: 1.2,
      restitution: 0.42,
      kick: LAYOUT.slingKick,
      cooldownFor: 0.14,
      meta: { role: 'slingshot', side: s.side, index: i }
    });
    world.add(face, wall(s.b.x, s.b.y, s.c.x, s.c.y, { thick: 1 }), wall(s.c.x, s.c.y, s.a.x, s.a.y, { thick: 1 }));
    return face;
  });

  /* ---- inlane rollovers ---- */
  parts.inlanes = L.inlaneRollovers.map(r => {
    const s = sensorCircle(r.x, r.y, 3, {
      id: `inlane-${r.side}`,
      cooldownFor: 0.6,
      meta: { role: 'inlane', side: r.side }
    });
    world.add(s);
    return s;
  });

  /* ---- outlane sensors, which double as the kickback triggers ---- */
  parts.outlanes = L.outlanes.map(o => {
    const s = sensorCircle(o.x, o.y, o.r, {
      id: `outlane-${o.side}`,
      cooldownFor: 0.8,
      meta: { role: 'outlane', side: o.side }
    });
    world.add(s);
    return s;
  });
}

function buildFlippers(world, parts) {
  const F = LAYOUT.flippers;

  const make = (cfg, side) => world.addFlipper(new Flipper({
    id: `flipper-${side}`,
    side,
    pivot: cfg.pivot,
    length: F.length,
    thick: F.thick,
    restAngle: cfg.restAngle,
    range: cfg.range
  }));

  parts.flippers = {
    left: make(F.left, 'left'),
    right: make(F.right, 'right')
  };

  // A post on each pivot. Without it a ball can work its way behind the bat
  // and out through the gap to the inlane divider.
  world.add(
    circle(F.left.pivot.x, F.left.pivot.y, F.thick, { restitution: 0.3, meta: { role: 'post' } }),
    circle(F.right.pivot.x, F.right.pivot.y, F.thick, { restitution: 0.3, meta: { role: 'post' } })
  );
}

/* ---------------------------------------------------------------
   Gimmicks — the swappable centre, one per type
   --------------------------------------------------------------- */

/**
 * Every gimmick returns the same shape so game.js can drive it without
 * knowing which one it has:
 *
 *   { id, label, colliders[], rotors[], fields[], state, update(dt), reset() }
 *
 * `update` is called once per rendered frame with real elapsed seconds, not
 * per physics step: these are presentation-level timers, and running them at
 * 240 Hz would only burn battery.
 */

function gimmickHerd(world) {
  const G = LAYOUT.gimmick;
  const laneY = G.cy - 8;
  const xs = [G.cx - 10, G.cx, G.cx + 10];

  const lanes = xs.map((x, i) => sensorCircle(x, laneY, 3, {
    id: `herd-${i}`,
    cooldownFor: 0.5,
    meta: { role: 'gimmick', kind: 'herdLane', index: i }
  }));

  const dividers = [G.cx - 5, G.cx + 5].map(x =>
    wall(x, laneY - 6, x, laneY + 6, { thick: 0.8, meta: { role: 'gimmickWall' } })
  );

  /**
   * Two stumps flanking the meadow, held well clear of the Well's exit
   * corridor.
   *
   * There was one stump, in the middle, at (G.cx, G.cy + 8) — which put a
   * kicking bumper 24 units directly above the Awakening Well. The Well ejects
   * upwards, so the ball hit the stump from below, the contact normal pointed
   * straight back down, and the kick drove it into the hole it had just left.
   * Which ejected it into the stump again, indefinitely. See
   * LAYOUT.saucer.exit.
   *
   * Flanking them is better anyway: Wildwood Green is the gentle table, and a
   * wide open shot up the middle to the Well suits it.
   */
  const stumps = [-1, 1].map((s, i) => circle(G.cx + s * 16, G.cy + 8, 4.2, {
    id: `herd-stump-${i}`,
    restitution: 0.34,
    kick: 54,
    cooldownFor: 0.12,
    meta: { role: 'gimmick', kind: 'herdStump', index: i }
  }));

  world.add(lanes, dividers, stumps);

  const state = { lit: [false, false, false] };

  return {
    id: 'herd',
    label: 'Herd Lanes',
    colliders: [...lanes, ...stumps],
    rotors: [],
    fields: [],
    state,
    /** Which lanes are lit is scored by game.js; nothing here is timed. */
    update() {},
    reset() { state.lit = [false, false, false]; }
  };
}

function gimmickOrbit(world) {
  const G = LAYOUT.gimmick;

  /**
   * A horseshoe, open at the bottom, so the ball is fed in from the flippers
   * and can always fall back out. A fully enclosed ring would leave the disc
   * as the only way out.
   *
   * The mouth starts at 0.40 of a turn rather than 0.28 so the ring's end cap
   * clears the Well's exit corridor. At 0.28 that cap sat at (39.5, 107.7),
   * directly in front of the Well — half blocking the shot into it, and standing
   * in the path of every ball it ejected.
   */
  const ring = arc(G.cx, G.cy, G.r, 0.40 * TAU, 0.60 * TAU, {
    id: 'orbit-ring',
    thick: 1.1,
    restitution: 0.44,
    friction: 0.02,
    meta: { role: 'gimmick', kind: 'orbitRing' }
  });

  /* The rune disc. Length 8 against a ring at 16 leaves 4.25 units of
     clearance for a 4.7-wide ball, so it *just* cannot slip past — the disc
     always eventually bats it back out rather than trapping it forever. */
  const disc = new Rotor({
    id: 'orbit-disc',
    pivot: { x: G.cx, y: G.cy },
    length: 8,
    thick: 1.4,
    omega: 6,
    restitution: 0.46
  });
  world.addRotor(disc);

  const rollovers = [-1, 1].map((s, i) => sensorCircle(G.cx + s * 12, G.cy + 6, 2.8, {
    id: `orbit-roll-${i}`,
    cooldownFor: 0.4,
    meta: { role: 'gimmick', kind: 'orbitRollover', index: i }
  }));

  world.add(ring, rollovers);

  const state = { spins: 0 };

  return {
    id: 'orbit',
    label: 'Rune Sanctum',
    colliders: [ring, ...rollovers],
    rotors: [disc],
    fields: [],
    state,
    /** Speeds up as the mode heats, which game.js drives via state.spins. */
    update() { disc.omega = 6 + Math.min(state.spins, 12) * 0.35; },
    reset() { state.spins = 0; disc.omega = 6; }
  };
}

function gimmickUpdraft(world) {
  const G = LAYOUT.gimmick;

  /* An updraught strong enough to beat gravity but not to pin the ball to
     the dome: 250 against 118 gives a net lift of about 132 u/s^2. */
  const draught = field(G.cx - 11, G.cy - 16, 22, 32, 0, -250, {
    id: 'updraft',
    meta: { role: 'gimmick', kind: 'updraft' }
  });

  // Funnels, so the lift is something you shoot into rather than drift over.
  const funnels = [
    wall(G.cx - 15, G.cy + 14, G.cx - 11, G.cy - 4, { meta: { role: 'gimmickWall' } }),
    wall(G.cx + 15, G.cy + 14, G.cx + 11, G.cy - 4, { meta: { role: 'gimmickWall' } })
  ];

  const eye = sensorCircle(G.cx, G.cy - 12, 3.4, {
    id: 'updraft-eye',
    cooldownFor: 0.5,
    meta: { role: 'gimmick', kind: 'updraftEye' }
  });

  world.add(draught, funnels, eye);

  const state = { on: true, timer: 0, period: 3.4, onFraction: 0.62 };

  return {
    id: 'updraft',
    label: 'Gale Spire',
    colliders: [eye],
    rotors: [],
    fields: [draught],
    state,
    /**
     * Gusts rather than a constant lift. A permanent updraught turns the
     * whole table into a holding pattern; an intermittent one is a shot you
     * have to time.
     */
    update(dt) {
      state.timer += dt;
      if (state.timer >= state.period) state.timer -= state.period;
      state.on = state.timer < state.period * state.onFraction;
      draught.active = state.on;
    },
    reset() { state.timer = 0; state.on = true; draught.active = true; }
  };
}

function gimmickBloom(world) {
  const G = LAYOUT.gimmick;

  /**
   * Four vines standing across the approach to the Well. They grow back on a
   * timer and a standing vine blocks the shot, so the centre of Starbloom
   * Grove is a race: clear them faster than they return.
   *
   * Upright bars set at uneven spacings, rather than the fan of radial spokes
   * this started as. Two reasons, both learned the hard way. Radial spokes
   * converge as they approach the hub, so however wide the fan looks at its
   * outer edge there is always a radius further in where neighbouring spokes
   * are closer together than the ball is wide, and it wedges between them for
   * good. And anything sloped is a surface the ball can settle on, whereas an
   * upright bar has no upward face at all.
   *
   * The gaps — 6.5, 9.5, 6.5 clear against a 4.7 ball — are threadable, which
   * is the point: the centre gap is the generous one and the two flanking it
   * ask for a decent shot.
   */
  const vineXs = [G.cx - 13.5, G.cx - 5.5, G.cx + 5.5, G.cx + 13.5];

  const vines = vineXs.map((x, i) => segment(x, G.cy - 10, x, G.cy + 8, {
    id: `vine-${i}`,
    thick: 1.5,
    restitution: 0.3,
    friction: 0.14,
    cooldownFor: 0.2,
    meta: { role: 'gimmick', kind: 'vine', index: i }
  }));

  const heart = sensorCircle(G.cx, G.cy, 3.6, {
    id: 'bloom-heart',
    cooldownFor: 0.5,
    meta: { role: 'gimmick', kind: 'bloomHeart' }
  });

  world.add(vines, heart);

  const state = { regrow: vines.map(() => 0), regrowSeconds: 6.5 };

  return {
    id: 'bloom',
    label: 'Starbloom Grove',
    colliders: [...vines, heart],
    rotors: [],
    fields: [],
    state,
    vines,
    update(dt) {
      vines.forEach((v, i) => {
        if (v.active) return;
        state.regrow[i] -= dt;
        if (state.regrow[i] <= 0) v.active = true;
      });
    },
    /** Called by game.js when a vine is struck. */
    cut(index) {
      const v = vines[index];
      if (!v || !v.active) return false;
      v.active = false;
      state.regrow[index] = state.regrowSeconds;
      return true;
    },
    reset() {
      vines.forEach(v => { v.active = true; });
      state.regrow = vines.map(() => 0);
    }
  };
}

function gimmickGears(world) {
  const G = LAYOUT.gimmick;

  /**
   * Two live gears turning against each other. This is the most violent
   * centre in the game on purpose: a gear holds its angular velocity
   * whatever it hits, so it will happily fire the ball straight down the
   * middle. Cogwork Foundry scores hardest and drains hardest.
   */
  const gears = [
    new Rotor({ id: 'gear-left', pivot: { x: G.cx - 10, y: G.cy }, length: 8.5, thick: 1.5, omega: 7, restitution: 0.5 }),
    new Rotor({ id: 'gear-right', pivot: { x: G.cx + 10, y: G.cy }, length: 8.5, thick: 1.5, omega: -7, restitution: 0.5, angle: Math.PI / 2 })
  ];
  gears.forEach(g => world.addRotor(g));

  // Hubs, so a ball cannot sit dead centre where the arms never reach it.
  const hubs = gears.map((g, i) => circle(g.pivot.x, g.pivot.y, 2.6, {
    id: `gear-hub-${i}`,
    restitution: 0.34,
    meta: { role: 'gimmickWall' }
  }));

  const vent = sensorCircle(G.cx, G.cy + 12, 3.2, {
    id: 'gear-vent',
    cooldownFor: 0.45,
    meta: { role: 'gimmick', kind: 'gearVent' }
  });

  world.add(hubs, vent);

  const state = { heat: 0 };

  return {
    id: 'gears',
    label: 'Cogwork Foundry',
    colliders: [...hubs, vent],
    rotors: gears,
    fields: [],
    state,
    /** Heat winds the gears up; game.js adds heat on hits and it bleeds off. */
    update(dt) {
      state.heat = Math.max(0, state.heat - dt * 0.35);
      const boost = 1 + Math.min(state.heat, 4) * 0.14;
      gears[0].omega = 7 * boost;
      gears[1].omega = -7 * boost;
    },
    reset() { state.heat = 0; gears[0].omega = 7; gears[1].omega = -7; }
  };
}

const GIMMICKS = {
  herd: gimmickHerd,
  orbit: gimmickOrbit,
  updraft: gimmickUpdraft,
  bloom: gimmickBloom,
  gears: gimmickGears
};

/* ---------------------------------------------------------------
   Assembly
   --------------------------------------------------------------- */

/**
 * Build a complete playfield for a mode.
 *
 * A fresh World every time, rather than swapping colliders in an existing
 * one: a mode change is rare, and rebuilding removes any chance of a stale
 * collider, a spinning rotor or a half-dropped target surviving into the
 * next mode.
 *
 * @returns {{world: World, parts: object, layout: object, mode: object}}
 */
export function buildTable(type) {
  const mode = MODES[type] || MODES.Neutral;

  const world = new World({ gravity: LAYOUT.gravity, drainY: LAYOUT.drainY });
  const parts = { type: mode.type };

  buildShell(world, parts);
  buildTopLanes(world, parts);
  buildBumpers(world, parts);
  buildBank(world, parts);
  buildOrbits(world, parts);
  buildSaucer(world, parts);
  buildRamps(world, parts);
  buildLower(world, parts);
  buildFlippers(world, parts);

  const make = GIMMICKS[mode.gimmick] || GIMMICKS.herd;
  parts.gimmick = make(world);

  return { world, parts, layout: LAYOUT, mode };
}

/** A ball placed in the shooter lane, ready to plunge. */
export function newBall() {
  const L = LAYOUT.shooter;
  const b = new Ball({ x: L.launch.x, y: L.launch.y });
  b.held = true;
  return b;
}

/**
 * Launch power for a 0..1 plunge. Deliberately non-linear at the bottom so a
 * light tap still clears the gate — a plunge that fails to leave the lane
 * reads as a broken control rather than a soft shot.
 */
export function launchImpulse(pull) {
  const p = Math.max(0, Math.min(1, pull));
  const { min, max } = LAYOUT.shooter.power;
  return min + (max - min) * (0.35 * p + 0.65 * p * p);
}
