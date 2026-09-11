/* ============================================================
   render.js — drawing the table

   Canvas 2D, and deliberately generic: almost everything is drawn by
   walking the world's own collider list and styling each one from its
   `meta.role`. Nothing here holds a second copy of the geometry, because
   two copies of a playfield is how you end up with a table that collides
   differently from the way it looks.

   Adding a collider to table.js therefore makes it appear on screen with
   no change here — an unknown role falls back to a plain wall.
   ============================================================ */

import { MODES, DISC_TIERS } from './data.js';
import { TABLE_W, TABLE_H, TAU } from './physics.js';
import { LAYOUT } from './table.js';

/**
 * Device pixel ratio is capped at 2. Phones ship 3x and 4x panels, and the
 * extra pixels cost real frame time on a mid-range Android for a difference
 * nobody can see on a moving pinball.
 */
const MAX_DPR = 2;

/* ---------------------------------------------------------------
   Sprite cache
   --------------------------------------------------------------- */

const sprites = new Map();

/**
 * Load an image once and hand back the same element every time.
 *
 * The entry is created immediately and returned even while it is still
 * loading, so callers can draw unconditionally: `drawImage` with an
 * incomplete image is a no-op rather than an error, and the sprite simply
 * appears a frame or two later.
 */
export function getSprite(path, { fallback = null } = {}) {
  if (!path) return null;
  let img = sprites.get(path);
  if (img) return img;

  img = new Image();
  img.decoding = 'async';
  if (fallback) {
    img.addEventListener('error', () => { if (img.src !== fallback) img.src = fallback; }, { once: true });
  }
  img.src = path;
  sprites.set(path, img);
  return img;
}

export const spriteReady = img => !!img && img.complete && img.naturalWidth > 0;

/** Warm the cache so a capture reveal does not pop in blank. */
export function preloadSprites(paths) {
  for (const p of paths) getSprite(p);
}

/* ---------------------------------------------------------------
   Palette
   --------------------------------------------------------------- */

const BASE = {
  wall: '#4a5578',
  wallLit: '#8fa0d8',
  ink: '#0b1024',
  chrome: '#c9d2f0',
  ball: '#e8ecff'
};

/** Per-role stroke styling, in table units. */
const ROLE = {
  wall: { colour: BASE.wall, width: 1.5 },
  dome: { colour: '#5a6690', width: 1.6 },
  gate: { colour: '#6f7cb0', width: 0.9, dashed: true },
  divider: { colour: '#5b6488', width: 1.1 },
  laneDivider: { colour: '#4a5578', width: 0.9 },
  gimmickWall: { colour: '#59648c', width: 1.3 }
};

/**
 * Roles are resolved through here rather than indexed straight out of ROLE.
 *
 * An unknown role is normal — table.js can add a collider without this file
 * changing — and a bad colour string is silent in canvas: it leaves the
 * previous fillStyle in place, so one typo makes an unrelated shape change
 * colour and nothing reports an error. Validating here keeps that failure
 * local and visible.
 */
function roleStyle(role) {
  const s = ROLE[role];
  if (!s || typeof s.colour !== 'string' || !/^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s.colour)) {
    return { colour: BASE.wall, width: 1.4 };
  }
  return s;
}

/* ---------------------------------------------------------------
   Renderer
   --------------------------------------------------------------- */

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });

    this.dpr = 1;
    this.scale = 1;        // table units -> CSS pixels
    this.originX = 0;      // CSS pixel offset of table (0,0)
    this.originY = 0;

    this.world = null;
    this.parts = null;
    this.mode = MODES.Neutral;

    /** Set false to skip the trail and the glows. */
    this.effects = true;

    this._grad = null;
    this._gradKey = '';
  }

  setTable({ world, parts, mode }) {
    this.world = world;
    this.parts = parts;
    this.mode = mode || MODES.Neutral;
    this._gradKey = '';         // force the backdrop to rebuild for the new palette
    return this;
  }

  /**
   * Size the backing store to the element's real pixel size and work out the
   * table-to-screen transform. Called on resize and on orientation change;
   * cheap enough to call whenever in doubt.
   */
  resize() {
    const c = this.canvas;
    const rect = c.getBoundingClientRect();
    const cssW = Math.max(1, rect.width || c.clientWidth || 1);
    const cssH = Math.max(1, rect.height || c.clientHeight || 1);

    this.dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const pxW = Math.round(cssW * this.dpr);
    const pxH = Math.round(cssH * this.dpr);

    if (c.width !== pxW || c.height !== pxH) { c.width = pxW; c.height = pxH; }

    // Fit the whole table, letterboxed, and centre it.
    this.scale = Math.min(cssW / TABLE_W, cssH / TABLE_H);
    this.originX = (cssW - TABLE_W * this.scale) / 2;
    this.originY = (cssH - TABLE_H * this.scale) / 2;

    this.cssW = cssW;
    this.cssH = cssH;
    this._gradKey = '';
    return this;
  }

  /** Table units -> CSS pixels. Used by input handling for nudge gestures. */
  toScreen(x, y) {
    return { x: this.originX + x * this.scale, y: this.originY + y * this.scale };
  }

  /** CSS pixels -> table units. */
  toTable(x, y) {
    return { x: (x - this.originX) / this.scale, y: (y - this.originY) / this.scale };
  }

  /* ---------------------------------------------------------------
     Frame
     --------------------------------------------------------------- */

  /**
   * Draw one frame.
   *
   * @param {object} view
   *   balls      the balls to draw
   *   encounter  { sp, shiny, x, y, r, meterFrac, flash } or null
   *   plunger    0..1 pull, drawn in the shooter lane
   *   discTier   index into DISC_TIERS, colours the ball
   *   litLetters { bank: [bool x5], lanes: [bool x3] }
   *   shake      0..1, screen shake from a nudge or a big hit
   */
  draw(view = {}) {
    const { ctx } = this;
    if (!this.world) return;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);

    this._backdrop(ctx);

    ctx.save();

    // Screen shake is applied in screen space so it moves the whole cabinet.
    if (view.shake > 0.001) {
      const s = view.shake * 2.2 * this.scale * 0.08;
      ctx.translate((Math.random() - 0.5) * s, (Math.random() - 0.5) * s);
    }

    ctx.translate(this.originX, this.originY);
    ctx.scale(this.scale, this.scale);

    this._playfield(ctx);
    this._ramps(ctx);
    this._colliders(ctx, view);
    this._gimmick(ctx);
    this._bats(ctx);
    if (view.encounter) this._encounter(ctx, view.encounter);
    this._balls(ctx, view);
    if (view.plunger > 0) this._plunger(ctx, view.plunger);

    ctx.restore();
  }

  /* ---- backdrop ---- */

  _backdrop(ctx) {
    const key = `${this.mode.type}|${this.cssW}x${this.cssH}`;
    if (this._gradKey !== key) {
      const g = ctx.createLinearGradient(0, 0, 0, this.cssH);
      g.addColorStop(0, this.mode.deep || '#1a2140');
      g.addColorStop(0.55, '#0e1430');
      g.addColorStop(1, BASE.ink);
      this._grad = g;
      this._gradKey = key;
    }
    ctx.fillStyle = this._grad;
    ctx.fillRect(0, 0, this.cssW, this.cssH);
  }

  /** The playfield surface: a subtle vignette so the table reads as a surface. */
  _playfield(ctx) {
    const D = LAYOUT.dome;

    ctx.save();
    ctx.beginPath();
    // The table outline: dome across the top, straight sides, flat bottom.
    ctx.arc(D.cx, D.cy, D.r, Math.PI, TAU);
    ctx.lineTo(D.cx + D.r, TABLE_H);
    ctx.lineTo(D.cx - D.r, TABLE_H);
    ctx.closePath();

    const g = ctx.createRadialGradient(LAYOUT.centre, 92, 8, LAYOUT.centre, 92, 110);
    g.addColorStop(0, 'rgba(255,255,255,0.055)');
    g.addColorStop(1, 'rgba(0,0,0,0.30)');
    ctx.fillStyle = g;
    ctx.fill();

    // The mode's colour, very faint, so each table feels different at a glance.
    ctx.globalAlpha = 0.06;
    ctx.fillStyle = this.mode.colour;
    ctx.fill();
    ctx.restore();
  }

  /* ---- ramps ---- */

  /**
   * Ramps are drawn, not collided: game.js carries the ball along the path,
   * so there is no geometry for the generic collider pass to pick up.
   */
  _ramps(ctx) {
    if (!this.parts?.ramps) return;

    for (const ramp of this.parts.ramps) {
      const pts = ramp.path;
      if (!pts || pts.length < 2) continue;

      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length - 1; i++) {
        // Quadratic through the midpoints, so the lane reads as a smooth
        // sweep rather than a polyline with visible corners.
        const mx = (pts[i].x + pts[i + 1].x) / 2;
        const my = (pts[i].y + pts[i + 1].y) / 2;
        ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
      }
      ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);

      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.lineWidth = 7.5;
      ctx.stroke();

      ctx.strokeStyle = this._alpha(this.mode.colour, 0.22);
      ctx.lineWidth = 1.1;
      ctx.stroke();

      ctx.restore();

      // The mouth, so it is obvious where to shoot.
      const e = ramp.entrance;
      this._ring(ctx, e.x, e.y, e.r, this._alpha(this.mode.colour, 0.5), 0.8);
    }
  }

  /* ---- generic colliders ---- */

  _colliders(ctx, view) {
    const t = this.world.time;

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const c of this.world.colliders) {
      const lit = c.litUntil > t;

      switch (c.meta?.role) {
        case 'bumper': this._bumper(ctx, c, lit); break;
        case 'bankTarget': this._bankTarget(ctx, c, lit, !!view?.shardMode); break;
        case 'topLane': this._lane(ctx, c, lit, view?.litLetters?.lanes?.[c.meta.index]); break;
        case 'spinner': this._spinner(ctx, c, lit); break;
        case 'saucer': this._saucer(ctx, c, lit); break;
        case 'slingshot': this._slingshot(ctx, c, lit); break;
        case 'post': this._post(ctx, c, lit); break;
        case 'inlane':
        case 'outlane': this._rollover(ctx, c, lit); break;
        case 'rampEntrance': break;                       // drawn with the ramp
        case 'gimmick':
        case 'gimmickWall': break;                        // drawn by _gimmick
        default: this._structural(ctx, c, lit); break;
      }
    }
  }

  /** Walls, dividers, the dome and the lane gate. */
  _structural(ctx, c, lit) {
    if (!c.active) return;
    const style = roleStyle(c.meta?.role);
    const colour = lit ? BASE.wallLit : style.colour;

    ctx.save();
    ctx.strokeStyle = colour;
    ctx.lineWidth = Math.max(style.width, (c.thick || 0.6) * 2);
    if (style.dashed) ctx.setLineDash([2.2, 2.2]);

    if (c.kind === 'seg') {
      ctx.beginPath();
      ctx.moveTo(c.a.x, c.a.y);
      ctx.lineTo(c.b.x, c.b.y);
      ctx.stroke();
    } else if (c.kind === 'arc') {
      ctx.beginPath();
      ctx.arc(c.c.x, c.c.y, c.r, c.a0, c.a0 + c.sweep);
      ctx.stroke();
    } else if (c.kind === 'circle') {
      this._ring(ctx, c.c.x, c.c.y, c.r, colour, style.width);
    }
    ctx.restore();
  }

  _bumper(ctx, c, lit) {
    const { x, y } = c.c;
    ctx.save();

    if (this.effects) {
      const g = ctx.createRadialGradient(x, y, 0.5, x, y, c.r * (lit ? 2.4 : 1.5));
      g.addColorStop(0, this._alpha(this.mode.colour, lit ? 0.85 : 0.4));
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, c.r * (lit ? 2.4 : 1.5), 0, TAU);
      ctx.fill();
    }

    ctx.beginPath();
    ctx.arc(x, y, c.r, 0, TAU);
    ctx.fillStyle = lit ? '#ffffff' : this.mode.deep;
    ctx.fill();
    ctx.lineWidth = 0.9;
    ctx.strokeStyle = this.mode.colour;
    ctx.stroke();

    // Cap highlight, so it reads as a mushroom rather than a flat disc.
    ctx.beginPath();
    ctx.arc(x - c.r * 0.22, y - c.r * 0.26, c.r * 0.42, 0, TAU);
    ctx.fillStyle = lit ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.14)';
    ctx.fill();

    ctx.restore();
  }

  /**
   * A drop target: a lettered plate, sunk into the playfield when down.
   *
   * `shardMode` repaints the whole bank while Evolution Mode is running,
   * because during it these are shard targets rather than the CATCH bank. They
   * are the same five colliders either way, so without a visual change there is
   * nothing on the table telling the player what to shoot — which read as
   * "there are no shards".
   */
  _bankTarget(ctx, c, lit, shardMode = false) {
    const mx = (c.a.x + c.b.x) / 2;
    const my = (c.a.y + c.b.y) / 2;
    const angle = Math.atan2(c.b.y - c.a.y, c.b.x - c.a.x);
    const len = Math.hypot(c.b.x - c.a.x, c.b.y - c.a.y);

    const SHARD = '#ffe680';

    ctx.save();
    ctx.translate(mx, my);
    ctx.rotate(angle);

    const h = c.thick * 2;
    if (c.active) {
      ctx.fillStyle = lit ? '#ffffff' : (shardMode ? SHARD : this.mode.colour);
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    } else {
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    }

    // A glow, so a shard target reads as live from across the table.
    if (c.active && shardMode && this.effects) {
      ctx.shadowColor = SHARD;
      ctx.shadowBlur = 6;
    }

    ctx.beginPath();
    ctx.roundRect(-len / 2, -h / 2, len, h, 0.9);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 0.3;
    ctx.stroke();

    if (c.active) {
      ctx.fillStyle = this.mode.ink;
      ctx.font = `bold ${h * 1.25}px ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      // A diamond in shard mode instead of its CATCH letter: the letter is
      // actively misleading while the bank means something else.
      ctx.fillText(shardMode ? '\u25c6' : (c.meta?.letter || ''), 0, 0.1);
    }

    ctx.restore();
  }

  /** A top lane rollover: a ring, filled once its letter is collected. */
  _lane(ctx, c, lit, collected) {
    const { x, y } = c.c;
    const on = lit || collected;

    this._ring(ctx, x, y, c.r, on ? '#ffffff' : this._alpha(this.mode.colour, 0.55), on ? 1.0 : 0.6);

    if (collected) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, c.r * 0.5, 0, TAU);
      ctx.fillStyle = this.mode.colour;
      ctx.fill();
      ctx.restore();
    }

    if (c.meta?.letter) {
      ctx.save();
      ctx.fillStyle = on ? '#ffffff' : this._alpha('#ffffff', 0.35);
      ctx.font = `bold ${c.r * 1.1}px ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(c.meta.letter, x, y - c.r * 1.9);
      ctx.restore();
    }
  }

  /** The spinner: a vane that reads as spinning while it is being hit. */
  _spinner(ctx, c, lit) {
    const { x, y } = c.c;
    // Spin only while lit, so a still spinner is obviously idle.
    const phase = lit ? (this.world.time * 14) % TAU : 0;
    const squash = Math.abs(Math.cos(phase));

    ctx.save();
    ctx.translate(x, y);
    ctx.strokeStyle = lit ? '#ffffff' : this._alpha(this.mode.colour, 0.6);
    ctx.lineWidth = 0.7;

    ctx.beginPath();
    ctx.moveTo(0, -c.r);
    ctx.lineTo(0, c.r);
    ctx.stroke();

    ctx.beginPath();
    ctx.ellipse(0, 0, Math.max(0.35, c.r * 0.72 * squash), c.r * 0.95, 0, 0, TAU);
    ctx.fillStyle = this._alpha(lit ? '#ffffff' : this.mode.colour, 0.28);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  /** The Awakening Well. */
  _saucer(ctx, c, lit) {
    const { x, y } = c.c;

    ctx.save();
    const g = ctx.createRadialGradient(x, y, 0.5, x, y, c.r);
    g.addColorStop(0, BASE.ink);
    g.addColorStop(0.7, this._alpha(this.mode.deep, 0.95));
    g.addColorStop(1, this._alpha(this.mode.colour, lit ? 0.95 : 0.5));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, c.r, 0, TAU);
    ctx.fill();

    ctx.lineWidth = lit ? 1.1 : 0.7;
    ctx.strokeStyle = lit ? '#ffffff' : this._alpha(this.mode.colour, 0.8);
    ctx.stroke();

    // A slow ring, so the Well always looks live.
    const pulse = 0.5 + 0.5 * Math.sin(this.world.time * 2.4);
    this._ring(ctx, x, y, c.r * (0.45 + pulse * 0.3),
               this._alpha('#ffffff', 0.10 + pulse * 0.18), 0.5);
    ctx.restore();
  }

  _slingshot(ctx, c, lit) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(c.a.x, c.a.y);
    ctx.lineTo(c.b.x, c.b.y);
    ctx.lineWidth = c.thick * 2;
    ctx.strokeStyle = lit ? '#ffffff' : this.mode.colour;
    ctx.stroke();

    if (lit && this.effects) {
      ctx.lineWidth = c.thick * 5;
      ctx.strokeStyle = this._alpha('#ffffff', 0.25);
      ctx.stroke();
    }
    ctx.restore();
  }

  _post(ctx, c, lit) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(c.c.x, c.c.y, c.r, 0, TAU);
    ctx.fillStyle = lit ? '#ffffff' : BASE.chrome;
    ctx.fill();
    ctx.restore();
  }

  _rollover(ctx, c, lit) {
    this._ring(ctx, c.c.x, c.c.y, c.r * 0.8,
               lit ? '#ffffff' : this._alpha(this.mode.colour, 0.38), 0.5);
  }

  /* ---- gimmick ---- */

  _gimmick(ctx) {
    const g = this.parts?.gimmick;
    if (!g) return;
    const t = this.world.time;

    /**
     * A dormant centre is drawn as a ghost of itself.
     *
     * While a mode owns the ball the gimmick stops colliding, and something the
     * ball passes straight through has to look like it. Faded rather than hidden
     * so the table does not appear to lose half its furniture for ten seconds
     * and then grow it back.
     */
    ctx.save();
    if (g.dormant) ctx.globalAlpha *= 0.22;

    for (const c of g.colliders) {
      const lit = c.litUntil > t;
      const kind = c.meta?.kind;

      if (kind === 'vine') {
        // A cut vine is drawn as a stub, so the player can see it regrowing.
        const frac = c.active ? 1 : 0.18;
        ctx.save();
        ctx.strokeStyle = c.active
          ? (lit ? '#ffffff' : this.mode.colour)
          : this._alpha(this.mode.colour, 0.25);
        ctx.lineWidth = c.thick * 2;
        ctx.beginPath();
        ctx.moveTo(c.a.x, c.a.y);
        ctx.lineTo(c.a.x + (c.b.x - c.a.x) * frac, c.a.y + (c.b.y - c.a.y) * frac);
        ctx.stroke();
        ctx.restore();
        continue;
      }

      if (c.kind === 'circle' && !c.sensor) { this._bumper(ctx, c, lit); continue; }
      if (c.kind === 'circle') { this._ring(ctx, c.c.x, c.c.y, c.r, lit ? '#ffffff' : this._alpha(this.mode.colour, 0.5), 0.7); continue; }
      if (c.kind === 'arc') { this._structural(ctx, c, lit); continue; }
      this._structural(ctx, c, lit);
    }

    // The updraught, drawn only while it is actually lifting.
    for (const f of g.fields || []) {
      if (!f.active) continue;
      ctx.save();
      const grad = ctx.createLinearGradient(0, f.y + f.h, 0, f.y);
      grad.addColorStop(0, this._alpha(this.mode.colour, 0.02));
      grad.addColorStop(1, this._alpha(this.mode.colour, 0.24));
      ctx.fillStyle = grad;
      ctx.fillRect(f.x, f.y, f.w, f.h);

      // Streaks that scroll upward at a speed tied to the lift.
      ctx.strokeStyle = this._alpha('#ffffff', 0.16);
      ctx.lineWidth = 0.4;
      for (let i = 0; i < 5; i++) {
        const x = f.x + f.w * ((i + 0.5) / 5);
        const off = (this.world.time * 46 + i * 9) % f.h;
        ctx.beginPath();
        ctx.moveTo(x, f.y + f.h - off);
        ctx.lineTo(x, f.y + f.h - off - 5);
        ctx.stroke();
      }
      ctx.restore();
    }

    ctx.restore();
  }

  /* ---- flippers and rotors ---- */

  /**
   * An inactive bat is faded, which covers both cases that produce one: a gear
   * or disc standing down for a mode, and a flipper killed by a tilt. In both
   * the ball now passes through it, so both have to stop looking solid.
   */
  _bats(ctx) {
    for (const f of this.world.flippers) {
      ctx.save();
      if (!f.active) ctx.globalAlpha *= 0.3;
      this._capsule(ctx, f.pivot, f.tip, f.thick, BASE.chrome, true);
      ctx.restore();
    }

    for (const r of this.world.rotors) {
      ctx.save();
      if (!r.active) ctx.globalAlpha *= 0.22;
      // Both arms, because both of them hit.
      this._capsule(ctx, r.tail, r.tip, r.thick, this.mode.colour, false);
      ctx.save();
      ctx.beginPath();
      ctx.arc(r.pivot.x, r.pivot.y, r.thick * 1.5, 0, TAU);
      ctx.fillStyle = this.mode.deep;
      ctx.fill();
      ctx.strokeStyle = this.mode.colour;
      ctx.lineWidth = 0.5;
      ctx.stroke();
      ctx.restore();

      ctx.restore();
    }
  }

  _capsule(ctx, a, b, thick, colour, withPivot) {
    ctx.save();
    ctx.lineCap = 'round';

    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineWidth = thick * 2;
    ctx.strokeStyle = colour;
    ctx.stroke();

    // A thin highlight along the bat so its angle is readable at a glance.
    ctx.lineWidth = thick * 0.7;
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.stroke();

    if (withPivot) {
      ctx.beginPath();
      ctx.arc(a.x, a.y, thick * 0.75, 0, TAU);
      ctx.fillStyle = BASE.ink;
      ctx.fill();
    }
    ctx.restore();
  }

  /* ---- encounter creature ---- */

  /**
   * The creature being fought for, drawn on the playfield with its capture
   * meter. `flash` is set by game.js on a hit.
   */
  _encounter(ctx, e) {
    const img = getSprite(e.sprite);
    const r = e.r || 11;

    ctx.save();

    if (this.effects) {
      const g = ctx.createRadialGradient(e.x, e.y, r * 0.2, e.x, e.y, r * 1.9);
      g.addColorStop(0, this._alpha(e.shiny ? '#ffe680' : this.mode.colour, 0.5));
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(e.x, e.y, r * 1.9, 0, TAU);
      ctx.fill();
    }

    if (spriteReady(img)) {
      ctx.save();
      if (e.flash > 0) {
        // A white bloom on a hit, which reads far better than a colour shift.
        ctx.globalAlpha = 1;
        ctx.filter = `brightness(${1 + e.flash * 2.5})`;
      }
      ctx.drawImage(img, e.x - r, e.y - r, r * 2, r * 2);
      ctx.restore();
    } else {
      // Silhouette until the sprite arrives, so the target is always visible.
      ctx.beginPath();
      ctx.arc(e.x, e.y, r * 0.8, 0, TAU);
      ctx.fillStyle = this._alpha(this.mode.colour, 0.6);
      ctx.fill();
    }

    /* ---- capture meter ---- */
    const w = r * 2.1;
    const h = 1.5;
    const y = e.y + r * 1.15;
    ctx.beginPath();
    ctx.roundRect(e.x - w / 2, y, w, h, h / 2);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fill();

    const frac = Math.max(0, Math.min(1, e.meterFrac ?? 0));
    if (frac > 0) {
      ctx.beginPath();
      ctx.roundRect(e.x - w / 2, y, w * frac, h, h / 2);
      ctx.fillStyle = e.shiny ? '#ffe680' : this.mode.colour;
      ctx.fill();
    }

    ctx.restore();
  }

  /* ---- balls ---- */

  _balls(ctx, view) {
    const tier = DISC_TIERS[Math.max(0, Math.min(DISC_TIERS.length - 1, view.discTier ?? 0))];

    for (const b of this.world.balls) {
      if (!b.alive) continue;

      /* trail */
      if (this.effects && view.showTrail !== false && b.trail.length > 1) {
        ctx.save();
        ctx.lineCap = 'round';
        for (let i = 1; i < b.trail.length; i++) {
          const a = i / b.trail.length;
          ctx.beginPath();
          ctx.moveTo(b.trail[i - 1].x, b.trail[i - 1].y);
          ctx.lineTo(b.trail[i].x, b.trail[i].y);
          ctx.strokeStyle = this._alpha(tier.colour, a * 0.28);
          ctx.lineWidth = b.r * 1.5 * a;
          ctx.stroke();
        }
        ctx.restore();
      }

      /* body */
      ctx.save();
      const g = ctx.createRadialGradient(
        b.pos.x - b.r * 0.35, b.pos.y - b.r * 0.4, b.r * 0.1,
        b.pos.x, b.pos.y, b.r
      );
      g.addColorStop(0, '#ffffff');
      g.addColorStop(0.45, tier.colour);
      g.addColorStop(1, tier.rim);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(b.pos.x, b.pos.y, b.r, 0, TAU);
      ctx.fill();

      // The disc's seam, rotated by the ball's spin — the only cue that a
      // pinball is rolling rather than sliding.
      ctx.save();
      ctx.translate(b.pos.x, b.pos.y);
      ctx.rotate(b.spin);
      ctx.beginPath();
      ctx.ellipse(0, 0, b.r * 0.9, b.r * 0.28, 0, 0, TAU);
      ctx.strokeStyle = this._alpha(tier.rim, 0.8);
      ctx.lineWidth = 0.35;
      ctx.stroke();
      ctx.restore();

      ctx.restore();
    }
  }

  /* ---- plunger ---- */

  _plunger(ctx, pull) {
    const S = LAYOUT.shooter;
    const x = S.launch.x;
    const top = S.launch.y + 3;
    const travel = 9 * Math.max(0, Math.min(1, pull));

    ctx.save();
    ctx.strokeStyle = this._alpha(this.mode.colour, 0.55 + pull * 0.45);
    ctx.lineWidth = 3.4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x, top + travel);
    ctx.lineTo(x, top + travel + 6);
    ctx.stroke();

    // Compression marks, so the pull reads without a separate gauge.
    ctx.strokeStyle = this._alpha('#ffffff', 0.25);
    ctx.lineWidth = 0.5;
    for (let i = 0; i < 3; i++) {
      const y = top + travel - 2 - i * 2;
      ctx.beginPath();
      ctx.moveTo(x - 2.4, y);
      ctx.lineTo(x + 2.4, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ---------------------------------------------------------------
     Small helpers
     --------------------------------------------------------------- */

  _ring(ctx, x, y, r, colour, width) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.stroke();
    ctx.restore();
  }

  /**
   * A hex colour with an alpha applied.
   *
   * Canvas has no way to set the alpha of a named or hex colour without
   * either building an rgba() string or leaning on globalAlpha, and
   * globalAlpha would also dim whatever else the current path draws.
   */
  _alpha(hex, a) {
    const h = String(hex || '#ffffff').replace('#', '');
    const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h.slice(0, 6);
    const n = parseInt(full, 16);
    if (!Number.isFinite(n)) return `rgba(255,255,255,${a})`;
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
}
