/* ============================================================
   audio.js — every sound in the game, synthesised

   No audio files at all. A pinball table's whole vocabulary is clicks,
   pings, thuds and sweeps, which WebAudio makes from a couple of
   oscillators and a noise burst — so the game ships without a single
   byte of audio to download, cache or keep offline. That matters here
   more than usual: the service worker has 158 sprites to precache
   already.

   Two things it has to respect:

     • Browsers refuse to start an AudioContext until the player has
       interacted with the page, so the context is created lazily on the
       first gesture rather than at load. Calling play() before that is
       silently ignored, not an error.
     • A pinball table can fire a dozen sounds a second. A voice cap
       stops that turning into clipping mush.
   ============================================================ */

/** Voices allowed to overlap. Past this, new sounds are dropped. */
const MAX_VOICES = 14;

/** Master level. Deliberately low: a phone speaker distorts easily. */
const MASTER_GAIN = 0.34;

export class Audio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = true;
    this.voices = 0;
    this.unlocked = false;
  }

  /* ---------------------------------------------------------------
     Lifecycle
     --------------------------------------------------------------- */

  /**
   * Create the context. Must be called from a real user gesture — a tap, a
   * key press — or the browser will create it suspended and nothing will
   * sound. Safe to call repeatedly.
   */
  unlock() {
    if (this.ctx) {
      // Coming back from a background tab leaves it suspended.
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return this;
    }

    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return this;

    try {
      this.ctx = new Ctx({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.gain.value = MASTER_GAIN;
      this.master.connect(this.ctx.destination);
      this.unlocked = true;
    } catch {
      this.ctx = null;      // no audio is survivable; a crash is not
    }
    return this;
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this.enabled ? MASTER_GAIN : 0, this.ctx.currentTime, 0.02);
    }
    return this;
  }

  suspend() { this.ctx?.suspend?.().catch(() => {}); }
  resume() { this.ctx?.resume?.().catch(() => {}); }

  get ready() { return !!this.ctx && this.enabled && this.ctx.state === 'running'; }

  /* ---------------------------------------------------------------
     Primitives
     --------------------------------------------------------------- */

  /** Book a voice, or refuse. Every primitive goes through this. */
  _take(seconds) {
    if (!this.ready || this.voices >= MAX_VOICES) return false;
    this.voices++;
    setTimeout(() => { this.voices = Math.max(0, this.voices - 1); }, seconds * 1000 + 40);
    return true;
  }

  /**
   * A pitched blip with an exponential decay.
   *
   * Gain is ramped rather than switched, because setting gain to 0 abruptly
   * produces an audible click — which on a table already full of clicks is
   * indistinguishable from a bug.
   */
  _blip({ freq = 440, to = null, dur = 0.09, type = 'square', gain = 0.5, delay = 0 } = {}) {
    if (!this._take(dur + delay)) return;

    const t0 = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (to && to !== freq) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t0 + dur);

    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + Math.min(0.012, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    osc.connect(g).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  /** A filtered noise burst: thuds, drains, the plunger. */
  _noise({ dur = 0.12, gain = 0.4, freq = 900, q = 1, type = 'lowpass', sweepTo = null, delay = 0 } = {}) {
    if (!this._take(dur + delay)) return;

    const t0 = this.ctx.currentTime + delay;
    const frames = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buf = this.ctx.createBuffer(1, frames, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;

    const src = this.ctx.createBufferSource();
    src.buffer = buf;

    const filter = this.ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(freq, t0);
    filter.Q.value = q;
    if (sweepTo) filter.frequency.exponentialRampToValueAtTime(Math.max(60, sweepTo), t0 + dur);

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    src.connect(filter).connect(g).connect(this.master);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  }

  /** An arpeggio, for the moments worth celebrating. */
  _arp(freqs, { step = 0.075, dur = 0.16, type = 'triangle', gain = 0.4 } = {}) {
    freqs.forEach((f, i) => this._blip({ freq: f, dur, type, gain, delay: i * step }));
  }

  /* ---------------------------------------------------------------
     The sounds
     --------------------------------------------------------------- */

  /**
   * Play a named sound. Unknown names are ignored on purpose: game.js calls
   * this from the middle of a ball, and a missing sound must never be able to
   * interrupt play.
   */
  play(name, opts = {}) {
    if (!this.ready) return;

    switch (name) {
      /* ---- flippers and walls ---- */
      case 'flipper':
        this._noise({ dur: 0.05, gain: 0.30, freq: 2600, sweepTo: 900, type: 'bandpass', q: 1.4 });
        break;

      case 'bumper':
        this._blip({ freq: 660, to: 990, dur: 0.07, type: 'square', gain: 0.34 });
        break;

      case 'sling':
        this._blip({ freq: 420, to: 700, dur: 0.05, type: 'sawtooth', gain: 0.28 });
        break;

      case 'spinner':
        // Pitched up as the spinner keeps going, so a good rip audibly climbs.
        this._blip({ freq: 780 + Math.random() * 180, dur: 0.035, type: 'square', gain: 0.16 });
        break;

      case 'target':
        this._blip({ freq: 1180, to: 880, dur: 0.06, type: 'square', gain: 0.30 });
        break;

      case 'lane':
        this._blip({ freq: 1560, dur: 0.05, type: 'triangle', gain: 0.24 });
        break;

      /* ---- the plunger and the Well ---- */
      case 'plunge': {
        const power = typeof opts.power === 'number' ? opts.power : 1;
        this._noise({ dur: 0.16, gain: 0.34, freq: 300 + power * 900, sweepTo: 160 });
        this._blip({ freq: 150 + power * 130, to: 90, dur: 0.14, type: 'sawtooth', gain: 0.22 });
        break;
      }

      case 'saucer':
        this._blip({ freq: 300, to: 900, dur: 0.2, type: 'sine', gain: 0.34 });
        break;

      case 'kickout':
        this._blip({ freq: 220, to: 520, dur: 0.12, type: 'sawtooth', gain: 0.32 });
        this._noise({ dur: 0.08, gain: 0.26, freq: 1500, sweepTo: 400 });
        break;

      case 'kickback':
        this._noise({ dur: 0.13, gain: 0.40, freq: 700, sweepTo: 2200, type: 'bandpass', q: 0.9 });
        this._blip({ freq: 180, to: 620, dur: 0.13, type: 'square', gain: 0.28 });
        break;

      /* ---- progress ---- */
      case 'bankComplete':
        this._arp([660, 880, 1320], { step: 0.06, dur: 0.14 });
        break;

      case 'upgrade':
        this._arp([523, 659, 784, 1047], { step: 0.055, dur: 0.16, type: 'square', gain: 0.32 });
        break;

      case 'lanesComplete':
        this._arp([700, 1050], { step: 0.05 });
        break;

      case 'ramp':
        this._blip({ freq: 300, to: 1400, dur: 0.28, type: 'sine', gain: 0.28 });
        break;

      case 'multiplier':
        this._arp([880, 1320], { step: 0.05, dur: 0.11, type: 'square', gain: 0.28 });
        break;

      case 'gate':
        // Something has opened: low, wide and slow, so it does not sound like
        // another target.
        this._blip({ freq: 110, to: 440, dur: 0.5, type: 'sawtooth', gain: 0.3 });
        this._arp([440, 554, 659, 880], { step: 0.1, dur: 0.3, type: 'triangle', gain: 0.26 });
        break;

      /* ---- creatures ---- */
      case 'encounter':
        this._arp([392, 523, 659], { step: 0.09, dur: 0.22, type: 'triangle', gain: 0.34 });
        break;

      case 'creatureHit':
        this._blip({ freq: 900, to: 300, dur: 0.1, type: 'square', gain: 0.34 });
        this._noise({ dur: 0.07, gain: 0.24, freq: 1800, sweepTo: 500 });
        break;

      case 'capture':
        if (opts.shiny) {
          this._arp([784, 988, 1319, 1568, 2093], { step: 0.085, dur: 0.34, type: 'triangle', gain: 0.34 });
        } else {
          this._arp([523, 659, 784, 1047], { step: 0.085, dur: 0.28, type: 'triangle', gain: 0.34 });
        }
        break;

      case 'escape':
        this._blip({ freq: 520, to: 130, dur: 0.42, type: 'sine', gain: 0.28 });
        break;

      case 'evolutionStart':
        this._arp([330, 440, 550], { step: 0.1, dur: 0.26, type: 'sine', gain: 0.3 });
        break;

      case 'evolve':
        this._arp([392, 523, 659, 784, 1047, 1319], { step: 0.08, dur: 0.3, type: 'triangle', gain: 0.34 });
        break;

      /* ---- bosses ---- */
      case 'bossStart':
        this._blip({ freq: 90, to: 220, dur: 0.7, type: 'sawtooth', gain: 0.34 });
        this._arp([220, 262, 330], { step: 0.16, dur: 0.4, type: 'sawtooth', gain: 0.24 });
        break;

      case 'bossHit':
        this._blip({ freq: 320, to: 90, dur: 0.16, type: 'sawtooth', gain: 0.38 });
        this._noise({ dur: 0.12, gain: 0.3, freq: 900, sweepTo: 200 });
        break;

      case 'shielded':
        // Deliberately dull, so a blocked hit is obviously not a hit.
        this._noise({ dur: 0.09, gain: 0.24, freq: 420, q: 3, type: 'bandpass' });
        break;

      case 'bossWin':
        this._arp([262, 330, 392, 523, 659, 784, 1047], { step: 0.1, dur: 0.42, type: 'triangle', gain: 0.36 });
        break;

      /* ---- balls and the game ---- */
      case 'ballSave':
        this._arp([660, 880, 660], { step: 0.08, dur: 0.16, type: 'sine', gain: 0.32 });
        break;

      case 'extraBall':
        this._arp([523, 784, 1047, 1568], { step: 0.09, dur: 0.3, type: 'triangle', gain: 0.36 });
        break;

      case 'drain':
        this._blip({ freq: 240, to: 60, dur: 0.5, type: 'sine', gain: 0.32 });
        this._noise({ dur: 0.3, gain: 0.22, freq: 600, sweepTo: 90 });
        break;

      case 'gameOver':
        this._arp([440, 349, 294, 220], { step: 0.19, dur: 0.42, type: 'triangle', gain: 0.32 });
        break;

      case 'nudge':
        this._noise({ dur: 0.08, gain: 0.28, freq: 260, q: 1.5 });
        break;

      case 'tilt':
        this._blip({ freq: 180, to: 70, dur: 0.6, type: 'square', gain: 0.34 });
        this._noise({ dur: 0.4, gain: 0.26, freq: 400, sweepTo: 80 });
        break;

      /* ---- interface ---- */
      case 'tap':
        this._blip({ freq: 1200, dur: 0.03, type: 'triangle', gain: 0.18 });
        break;

      case 'back':
        this._blip({ freq: 700, to: 500, dur: 0.06, type: 'triangle', gain: 0.16 });
        break;

      default:
        break;      // an unnamed sound is not worth interrupting a ball for
    }
  }
}

/** One instance is plenty; the game is not going to want two mixers. */
export const audio = new Audio();
