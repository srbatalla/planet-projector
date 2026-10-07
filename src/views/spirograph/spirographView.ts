import { Body, HelioVector } from 'astronomy-engine';
import { CanvasSurface, createLayerCanvas, observeResize } from '../../render/canvas';
import { getPlanetColor } from '../horizon/planetColors';
import { type SpecialObject } from '../../core/specialObjects';
import {
  equatorialToEcliptic,
  keplerPosition,
  maxHeliocentricDistance,
  maxSpecialDistance,
  type Vec3,
} from '../../core/orbits';
import { MAX_EPOCH_MS, type ViewStatus } from '../viewStatus';
import { drawMarkerLabel, LabelLayout, MARKER_LABEL_FONT } from '../../render/labels';

export type SpiroColorMode = 'planet' | 'spectrum' | 'mono';

export type SpiroVisuals = {
  colorMode: SpiroColorMode;
  glow: boolean;
  lineWidth: number;
  /** Rotational copies of the pattern (1 = physical only). */
  symmetry: number;
  mirror: boolean;
  /** Draw chords between bodies every `connectDays` (the "planetary dance"). */
  connect: boolean;
  connectDays: number;
  /** Trail half-life in simulated years; 0 keeps everything. */
  fadeYears: number;
  zoom: number;
  labels: boolean;
  /** Distance labels ("1 AU") on the reference rings. */
  auLabels: boolean;
};

type SpirographConfig = {
  bodies: Body[];
  startTime: Date;
  stepMinutes: number;
  playbackSpeed: number;
  perspectiveBody: Body;
  specials: SpecialObject[];
  visuals: SpiroVisuals;
  onZoomChange?: (zoom: number) => void;
};

type Trace = {
  key: string;
  label: string;
  body: Body | null;
  special: SpecialObject | null;
  color: string;
  rgb: [number, number, number];
  hueOffset: number;
  maxDistance: number;
  /** Decimated sample store (AU, ecliptic plane) used to re-render after resize / restyle. */
  xs: Float32Array;
  ys: Float32Array;
  steps: Int32Array;
  count: number;
  stride: number;
  /** Full-resolution samples not yet inked: [x, y, step, ...], first entry is the last inked point. */
  fresh: number[];
  previewX: number;
  previewY: number;
  hasSample: boolean;
};

const STORE_CAPACITY = 1 << 18;
const CHORD_CAPACITY = 1 << 16;
/** Re-render budget: total segment draws (points × symmetric copies) per full redraw. */
const REDRAW_SEGMENT_BUDGET = 600000;
const SPECTRUM_PERIOD_DAYS = 365.25 * 6;
const COLOR_CHUNK = 24;
const FRAME_FILL = 0.46;
const SPECIAL_FIT_CAP_AU = 6;
const MAX_FRAME_DELTA_MS = 100;
/** Overdrive simulates until frame work reaches this, leaving room for drawing (min 3ms). */
const OVERDRIVE_FRAME_TARGET_MS = 14;
/** Frame-work targets scale down on high-refresh displays (share of the measured frame interval). */
const FRAME_TARGET_SHARE = 0.85;
const STEP_BUDGET_FRAME_SHARE = 0.6;
/** Finite speeds can also ask for tens of thousands of steps a frame; past this, time is dropped. */
const STEP_BUDGET_MS = 10;
const LN2 = Math.LN2;

const hexToRgb = (hex: string): [number, number, number] => {
  const value = parseInt(hex.replace('#', ''), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
};

export class SpirographView {
  private surface: CanvasSurface;
  private ink: HTMLCanvasElement | null = null;
  private inkCtx: CanvasRenderingContext2D | null = null;
  private referenceLayer: HTMLCanvasElement | null = null;
  /** Zoom the ink layer was rendered at; differs from config zoom mid-gesture. */
  private inkZoom = 1;
  private animationHandle: number | null = null;
  private lastFrameTime: number | null = null;
  private readonly stepMs: number;
  private readonly baseTimestamp: number;
  private readonly labelLayout = new LabelLayout();
  private stepIndex = 0;
  private remainderMs = 0;
  private traces: Trace[] = [];
  private playbackSpeed = 1;
  private readonly perspectiveBody: Body;
  private paused = false;
  private started = false;
  private finished = false;
  private pendingFade = 0;
  private baseScale = 1;
  private disconnectResize: (() => void) | null = null;
  private redrawHandle: number | null = null;

  private chordX1 = new Float32Array(CHORD_CAPACITY);
  private chordY1 = new Float32Array(CHORD_CAPACITY);
  private chordX2 = new Float32Array(CHORD_CAPACITY);
  private chordY2 = new Float32Array(CHORD_CAPACITY);
  private chordStep = new Int32Array(CHORD_CAPACITY);
  private chordPair = new Uint16Array(CHORD_CAPACITY);
  private chordCount = 0;
  private chordStride = 1;
  private freshChordStart = 0;
  private pairs: [number, number][] = [];

  private readonly reference: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly scratch: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly reusableDate = new Date();
  private frameIntervalEma = 16.7;
  private frameWorkEma = 0;
  private drawCostEma = 2;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pinchStartDistance = 0;
  private pinchStartZoom = 1;

  constructor(private container: HTMLElement, private config: SpirographConfig) {
    this.stepMs = Math.max(1, this.config.stepMinutes * 60 * 1000);
    this.baseTimestamp = this.config.startTime.getTime();
    this.perspectiveBody = this.config.perspectiveBody;

    const canvas = document.createElement('canvas');
    canvas.style.touchAction = 'none';
    this.container.appendChild(canvas);
    this.surface = new CanvasSurface(canvas);

    this.syncTraces(this.config.bodies, this.config.specials);
    this.updatePlaybackSpeed(this.config.playbackSpeed);
    this.computeScale();
    this.attachGestures(canvas);
  }

  get canvas() {
    return this.surface.canvas;
  }

  start() {
    if (this.started) {
      return;
    }
    this.started = true;
    this.disconnectResize = observeResize(this.container, this.handleResize);
    this.rebuildLayers();
    this.scheduleFrame();
  }

  stop() {
    if (this.animationHandle !== null) {
      cancelAnimationFrame(this.animationHandle);
      this.animationHandle = null;
    }
    if (this.redrawHandle !== null) {
      window.clearTimeout(this.redrawHandle);
      this.redrawHandle = null;
    }
    this.disconnectResize?.();
    this.disconnectResize = null;
    this.started = false;
  }

  setPaused(paused: boolean) {
    if (paused === this.paused) {
      return;
    }
    this.paused = paused;
    if (paused) {
      if (this.animationHandle !== null) {
        cancelAnimationFrame(this.animationHandle);
        this.animationHandle = null;
      }
    } else {
      this.lastFrameTime = null;
      this.scheduleFrame();
    }
  }

  private scheduleFrame() {
    if (this.animationHandle === null && this.started && !this.paused) {
      this.animationHandle = requestAnimationFrame(this.loop);
    }
  }

  /**
   * Negative speeds rewind: the pattern keeps drawing, now into the past. ±Infinity is
   * Maximum Overdrive in either direction.
   */
  updatePlaybackSpeed(newSpeed: number) {
    const previousDirection = this.direction;
    const sign = newSpeed < 0 ? -1 : 1;
    const magnitude = Math.abs(newSpeed);
    this.playbackSpeed = Number.isFinite(magnitude) && magnitude > 0
      ? sign * Math.max(1, magnitude)
      : sign * Number.POSITIVE_INFINITY;
    this.config.playbackSpeed = this.playbackSpeed;
    if (this.direction !== previousDirection) {
      this.remainderMs = 0;
      // The date-range stop only applies in the direction that hit it.
      this.finished = false;
    }
  }

  private get direction() {
    return this.playbackSpeed < 0 ? -1 : 1;
  }

  /** Add/remove planets and special objects live; retained traces keep their history. */
  updateTargets(newBodies: Body[], specials: SpecialObject[]) {
    const unique = Array.from(new Set(newBodies)).filter((body) => body !== this.perspectiveBody);
    this.config.bodies = unique;
    this.config.specials = specials;
    this.syncTraces(unique, specials);
    // Pair indices refer to positions in the trace list, so stored chords are now meaningless.
    this.resetChords();
    this.computeScale();
    this.redrawAll();
  }

  private resetChords() {
    this.chordCount = 0;
    this.chordStride = 1;
    this.freshChordStart = 0;
  }

  updateVisuals(visuals: SpiroVisuals) {
    const previous = this.config.visuals;
    this.config.visuals = visuals;
    if (visuals.connect !== previous.connect || visuals.connectDays !== previous.connectDays) {
      this.resetChords();
    }
    this.computeScale();
    this.redrawAll();
  }

  getStatus(): ViewStatus {
    const elapsedMs =
      this.stepIndex * this.stepMs + (Number.isFinite(this.playbackSpeed) ? this.direction * this.remainderMs : 0);
    return {
      timeMs: this.baseTimestamp + elapsedMs,
      elapsedMs,
      targets: this.traces.map((trace) => ({ id: trace.key, label: trace.label, color: trace.color })),
      visible: this.traces.map((trace) => trace.key),
      waiting: false,
      finished: this.finished,
      fps: this.frameIntervalEma > 0 ? 1000 / this.frameIntervalEma : 0,
      frameWorkMs: this.frameWorkEma,
      paused: this.paused,
    };
  }

  // ---------------------------------------------------------------- traces

  private syncTraces(bodies: Body[], specials: SpecialObject[]) {
    const existing = new Map(this.traces.map((trace) => [trace.key, trace]));
    const next: Trace[] = [];
    for (const body of bodies) {
      if (body === this.perspectiveBody) {
        continue;
      }
      next.push(existing.get(body) ?? this.createTrace(body, null));
    }
    for (const special of specials) {
      next.push(existing.get(special.id) ?? this.createTrace(null, special));
    }
    next.forEach((trace, index) => {
      trace.hueOffset = (index * 360) / Math.max(1, next.length);
    });
    this.traces = next;
    this.pairs = this.computePairs(next.length);

    // New traces start at the current instant.
    for (const trace of next) {
      if (!trace.hasSample) {
        this.sampleTrace(trace, this.stepIndex);
      }
    }
  }

  private computePairs(n: number): [number, number][] {
    const pairs: [number, number][] = [];
    if (n < 2) {
      return pairs;
    }
    if (n <= 4) {
      for (let i = 0; i < n; i += 1) {
        for (let j = i + 1; j < n; j += 1) {
          pairs.push([i, j]);
        }
      }
      return pairs;
    }
    for (let i = 0; i < n; i += 1) {
      pairs.push([i, (i + 1) % n]);
    }
    return pairs;
  }

  private createTrace(body: Body | null, special: SpecialObject | null): Trace {
    const color = special ? special.color : getPlanetColor(body as Body);
    const maxTarget = special ? maxSpecialDistance(special) : maxHeliocentricDistance(body as Body);
    return {
      key: special ? special.id : (body as string),
      label: special ? special.shortName : (body as string),
      body,
      special,
      color,
      rgb: hexToRgb(color),
      hueOffset: 0,
      maxDistance: maxTarget + maxHeliocentricDistance(this.perspectiveBody),
      xs: new Float32Array(1024),
      ys: new Float32Array(1024),
      steps: new Int32Array(1024),
      count: 0,
      stride: 1,
      fresh: [],
      previewX: 0,
      previewY: 0,
      hasSample: false,
    };
  }

  private heliocentric(body: Body, time: Date, out: Vec3) {
    if (body === Body.Sun) {
      out.x = 0;
      out.y = 0;
      out.z = 0;
      return out;
    }
    return equatorialToEcliptic(HelioVector(body, time), out);
  }

  private referenceAt(timeMs: number) {
    this.reusableDate.setTime(timeMs);
    this.heliocentric(this.perspectiveBody, this.reusableDate, this.reference);
  }

  /** Position relative to the perspective body; call referenceAt(timeMs) first. */
  private relativePosition(trace: Trace, timeMs: number, out: Vec3) {
    if (trace.special) {
      keplerPosition(trace.special, timeMs, out);
    } else {
      this.reusableDate.setTime(timeMs);
      this.heliocentric(trace.body as Body, this.reusableDate, out);
    }
    out.x -= this.reference.x;
    out.y -= this.reference.y;
    return out;
  }

  private sampleTrace(trace: Trace, step: number) {
    const timeMs = this.baseTimestamp + step * this.stepMs;
    this.referenceAt(timeMs);
    const p = this.relativePosition(trace, timeMs, this.scratch);
    trace.fresh.length = 0;
    trace.fresh.push(p.x, p.y, step);
    trace.previewX = p.x;
    trace.previewY = p.y;
    trace.hasSample = true;
    this.store(trace, p.x, p.y, step);
  }

  private store(trace: Trace, x: number, y: number, step: number) {
    if (trace.count > 0 && (step - trace.steps[0]) % trace.stride !== 0) {
      return;
    }
    if (trace.count === trace.xs.length) {
      if (trace.xs.length < STORE_CAPACITY) {
        const size = trace.xs.length * 2;
        const xs = new Float32Array(size);
        const ys = new Float32Array(size);
        const steps = new Int32Array(size);
        xs.set(trace.xs);
        ys.set(trace.ys);
        steps.set(trace.steps);
        trace.xs = xs;
        trace.ys = ys;
        trace.steps = steps;
      } else {
        // Full: keep every other sample and halve the storage rate from now on.
        let j = 0;
        for (let i = 0; i < trace.count; i += 2) {
          trace.xs[j] = trace.xs[i];
          trace.ys[j] = trace.ys[i];
          trace.steps[j] = trace.steps[i];
          j += 1;
        }
        trace.count = j;
        trace.stride *= 2;
        if ((step - trace.steps[0]) % trace.stride !== 0) {
          return;
        }
      }
    }
    trace.xs[trace.count] = x;
    trace.ys[trace.count] = y;
    trace.steps[trace.count] = step;
    trace.count += 1;
  }

  /**
   * Chords are stored for every pair at each connect event. Strides and compaction act on whole
   * events (never individual pairs) so every pair keeps the same density.
   */
  private storeChord(x1: number, y1: number, x2: number, y2: number, step: number, pair: number) {
    const event = Math.round(step / this.connectSteps());
    if (event % this.chordStride !== 0) {
      return;
    }
    if (this.chordCount === CHORD_CAPACITY) {
      const keepEvery = this.chordStride * 2;
      const connectSteps = this.connectSteps();
      let j = 0;
      let freshStart = this.chordCount;
      for (let i = 0; i < this.chordCount; i += 1) {
        if (i === this.freshChordStart) {
          freshStart = j;
        }
        if (Math.round(this.chordStep[i] / connectSteps) % keepEvery !== 0) {
          continue;
        }
        this.chordX1[j] = this.chordX1[i];
        this.chordY1[j] = this.chordY1[i];
        this.chordX2[j] = this.chordX2[i];
        this.chordY2[j] = this.chordY2[i];
        this.chordStep[j] = this.chordStep[i];
        this.chordPair[j] = this.chordPair[i];
        j += 1;
      }
      this.chordCount = j;
      this.freshChordStart = Math.min(freshStart, j);
      this.chordStride = keepEvery;
      if (event % this.chordStride !== 0) {
        return;
      }
    }
    const i = this.chordCount;
    this.chordX1[i] = x1;
    this.chordY1[i] = y1;
    this.chordX2[i] = x2;
    this.chordY2[i] = y2;
    this.chordStep[i] = step;
    this.chordPair[i] = pair;
    this.chordCount += 1;
  }

  // ---------------------------------------------------------------- simulation

  private loop = (timestamp: number) => {
    this.animationHandle = null;
    const workStart = performance.now();
    if (this.lastFrameTime === null) {
      this.lastFrameTime = timestamp;
    }
    const rawDelta = timestamp - this.lastFrameTime;
    this.lastFrameTime = timestamp;
    if (rawDelta > 0) {
      this.frameIntervalEma += (Math.min(rawDelta, 1000) - this.frameIntervalEma) * 0.05;
    }
    const deltaTime = Math.min(rawDelta, MAX_FRAME_DELTA_MS);

    const stepBefore = this.stepIndex;
    this.advanceSimulation(deltaTime);
    const drawStart = performance.now();
    this.applyFade(Math.abs(this.stepIndex - stepBefore) * this.stepMs);
    this.flushInk();
    this.render();
    this.drawCostEma += (performance.now() - drawStart - this.drawCostEma) * 0.1;
    this.frameWorkEma += (performance.now() - workStart - this.frameWorkEma) * 0.05;
    this.scheduleFrame();
  };

  private advanceSimulation(deltaTime: number) {
    if (deltaTime <= 0 || this.traces.length === 0 || this.finished) {
      return;
    }

    if (!Number.isFinite(this.playbackSpeed)) {
      const start = performance.now();
      const frameTarget = Math.min(OVERDRIVE_FRAME_TARGET_MS, this.frameIntervalEma * FRAME_TARGET_SHARE);
      const budget = Math.max(2, Math.min(10, frameTarget - this.drawCostEma));
      let iterations = 0;
      while (iterations < 30000 && !this.finished && performance.now() - start < budget) {
        this.processStep();
        iterations += 1;
      }
      this.remainderMs = 0;
      return;
    }

    this.remainderMs += deltaTime * Math.abs(this.playbackSpeed);
    const steps = Math.floor(this.remainderMs / this.stepMs);
    const budgetEnd =
      performance.now() + Math.min(STEP_BUDGET_MS, this.frameIntervalEma * STEP_BUDGET_FRAME_SHARE);
    for (let i = 0; i < steps && !this.finished; i += 1) {
      this.remainderMs -= this.stepMs;
      this.processStep();
      if ((i & 15) === 15 && performance.now() > budgetEnd) {
        this.remainderMs = Math.min(this.remainderMs, this.stepMs * 0.999);
        break;
      }
    }
  }

  private connectSteps() {
    return Math.max(1, Math.round((this.config.visuals.connectDays * 1440) / this.config.stepMinutes));
  }

  private processStep() {
    const next = this.stepIndex + this.direction;
    if (Math.abs(this.baseTimestamp + next * this.stepMs) > MAX_EPOCH_MS) {
      this.finished = true;
      this.remainderMs = 0;
      return;
    }
    this.stepIndex = next;
    const step = this.stepIndex;
    const timeMs = this.baseTimestamp + step * this.stepMs;
    this.referenceAt(timeMs);
    const p = this.scratch;

    for (const trace of this.traces) {
      this.relativePosition(trace, timeMs, p);
      trace.fresh.push(p.x, p.y, step);
      trace.previewX = p.x;
      trace.previewY = p.y;
      this.store(trace, p.x, p.y, step);
    }

    const visuals = this.config.visuals;
    if (visuals.connect && this.pairs.length > 0 && step % this.connectSteps() === 0) {
      for (let k = 0; k < this.pairs.length; k += 1) {
        const a = this.traces[this.pairs[k][0]];
        const b = this.traces[this.pairs[k][1]];
        this.storeChord(a.previewX, a.previewY, b.previewX, b.previewY, step, k);
      }
    }
  }

  private updatePreview() {
    if (!Number.isFinite(this.playbackSpeed) || this.remainderMs <= 0) {
      return;
    }
    const timeMs = this.baseTimestamp + this.stepIndex * this.stepMs + this.direction * this.remainderMs;
    this.referenceAt(timeMs);
    for (const trace of this.traces) {
      const p = this.relativePosition(trace, timeMs, this.scratch);
      trace.previewX = p.x;
      trace.previewY = p.y;
    }
  }

  // ---------------------------------------------------------------- drawing

  /**
   * Fit the farthest planet. Special objects count only up to max(6 AU, that planet), so a comet
   * with a 370 AU aphelion (or an interstellar visitor) does not shrink everything to a dot;
   * their outer arcs leave the frame and zoom brings them back.
   */
  private computeScale() {
    this.baseScale = this.baseScaleFor(this.surface.width, this.surface.height);
  }

  private baseScaleFor(width: number, height: number) {
    let planetDistance = 0;
    for (const trace of this.traces) {
      if (!trace.special) {
        planetDistance = Math.max(planetDistance, trace.maxDistance);
      }
    }
    const specialCap = Math.max(SPECIAL_FIT_CAP_AU, planetDistance);
    let maxDistance = planetDistance;
    for (const trace of this.traces) {
      if (trace.special) {
        maxDistance = Math.max(maxDistance, Math.min(trace.maxDistance, specialCap));
      }
    }
    const fit = FRAME_FILL * Math.min(width, height);
    return maxDistance > 0 ? fit / maxDistance : fit;
  }

  /** Live scale (markers follow the gesture immediately). */
  private get scale() {
    return this.baseScale * this.config.visuals.zoom;
  }

  /** Scale the ink and reference layers were rendered at; only changes on a full redraw. */
  private get inkScale() {
    return this.baseScale * this.inkZoom;
  }

  private traceColor(trace: Trace, step: number) {
    const mode = this.config.visuals.colorMode;
    if (mode === 'mono') {
      return '#ece8dc';
    }
    if (mode === 'spectrum') {
      const days = (step * this.stepMs) / 86400000;
      const hue = (trace.hueOffset + (days / SPECTRUM_PERIOD_DAYS) * 360) % 360;
      return `hsl(${hue.toFixed(1)}, 90%, 64%)`;
    }
    return trace.color;
  }

  private chordColor(pairIndex: number, step: number) {
    const mode = this.config.visuals.colorMode;
    const [i, j] = this.pairs[pairIndex] ?? [0, 0];
    const a = this.traces[i];
    const b = this.traces[j];
    if (!a || !b || mode === 'mono') {
      return '#ece8dc';
    }
    if (mode === 'spectrum') {
      const days = (step * this.stepMs) / 86400000;
      const hue = ((a.hueOffset + b.hueOffset) / 2 + (days / SPECTRUM_PERIOD_DAYS) * 360) % 360;
      return `hsl(${hue.toFixed(1)}, 85%, 70%)`;
    }
    const r = (a.rgb[0] + b.rgb[0]) >> 1;
    const g = (a.rgb[1] + b.rgb[1]) >> 1;
    const bl = (a.rgb[2] + b.rgb[2]) >> 1;
    return `rgb(${r}, ${g}, ${bl})`;
  }

  /** Transforms for every symmetric copy, in logical pixels about the canvas centre. */
  private symmetryTransforms(): DOMMatrix[] {
    const { symmetry, mirror } = this.config.visuals;
    const n = Math.max(1, Math.round(symmetry));
    const cx = this.surface.width / 2;
    const cy = this.surface.height / 2;
    const ratio = this.surface.pixelRatio;
    const transforms: DOMMatrix[] = [];
    for (let k = 0; k < n; k += 1) {
      const angle = (360 * k) / n;
      const base = new DOMMatrix().scale(ratio, ratio).translate(cx, cy).rotate(angle);
      transforms.push(base.translate(-cx, -cy));
      if (mirror) {
        transforms.push(base.scale(1, -1).translate(-cx, -cy));
      }
    }
    return transforms;
  }

  private ensureInk() {
    const { width, height } = this.surface.canvas;
    if (!this.ink || this.ink.width !== width || this.ink.height !== height) {
      this.ink = createLayerCanvas(width, height);
      this.inkCtx = this.ink.getContext('2d');
    }
    return this.inkCtx;
  }

  private applyFade(simDeltaMs: number) {
    const fadeYears = this.config.visuals.fadeYears;
    const ctx = this.inkCtx;
    if (fadeYears <= 0 || simDeltaMs <= 0 || !ctx || !this.ink) {
      return;
    }
    const years = simDeltaMs / (365.25 * 86400000);
    this.pendingFade = 1 - (1 - this.pendingFade) * Math.exp((-LN2 * years) / fadeYears);
    if (this.pendingFade < 0.03) {
      return;
    }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.globalAlpha = Math.min(1, this.pendingFade);
    ctx.fillRect(0, 0, this.ink.width, this.ink.height);
    ctx.restore();
    this.pendingFade = 0;
  }

  private fadeFactor(step: number) {
    const fadeYears = this.config.visuals.fadeYears;
    if (fadeYears <= 0) {
      return 1;
    }
    const ageYears = (Math.abs(this.stepIndex - step) * this.stepMs) / (365.25 * 86400000);
    return Math.exp((-LN2 * ageYears) / fadeYears);
  }

  private prepareInkStyle(ctx: CanvasRenderingContext2D) {
    const { glow } = this.config.visuals;
    ctx.globalCompositeOperation = glow ? 'lighter' : 'source-over';
    ctx.lineJoin = 'round';
    // Butt caps: runs are stroked in chunks and per frame, and overlapping round caps would
    // double-expose every join (visible as bright beads, especially with additive glow).
    ctx.lineCap = 'butt';
  }

  /**
   * Stroke a run of [x, y, step] triples (AU) onto the ink layer in colour chunks, once per
   * symmetric copy. `alphaOf` lets a re-render reproduce the trail fade by age.
   */
  private strokeRun(
    ctx: CanvasRenderingContext2D,
    trace: Trace,
    run: ArrayLike<number>,
    pointCount: number,
    transforms: DOMMatrix[],
    alphaOf: (step: number) => number
  ) {
    if (pointCount < 2) {
      return;
    }
    const { glow, lineWidth } = this.config.visuals;
    const scale = this.inkScale;
    const cx = this.surface.width / 2;
    const cy = this.surface.height / 2;
    const baseAlpha = glow ? 0.55 : 0.85;
    ctx.lineWidth = lineWidth;

    for (let start = 0; start < pointCount - 1; start += COLOR_CHUNK) {
      const end = Math.min(pointCount - 1, start + COLOR_CHUNK);
      const path = new Path2D();
      path.moveTo(cx + run[start * 3] * scale, cy - run[start * 3 + 1] * scale);
      for (let i = start + 1; i <= end; i += 1) {
        path.lineTo(cx + run[i * 3] * scale, cy - run[i * 3 + 1] * scale);
      }
      const step = run[end * 3 + 2];
      const alpha = baseAlpha * alphaOf(step);
      if (alpha < 0.01) {
        continue;
      }
      ctx.strokeStyle = this.traceColor(trace, step);
      ctx.globalAlpha = alpha;
      for (const transform of transforms) {
        ctx.setTransform(transform.a, transform.b, transform.c, transform.d, transform.e, transform.f);
        ctx.stroke(path);
      }
    }
  }

  /** Stroke chords per pair (each pair has its own colour), thinning by whole connect events. */
  private strokeChords(
    ctx: CanvasRenderingContext2D,
    from: number,
    to: number,
    eventStride: number,
    transforms: DOMMatrix[],
    alphaOf: (step: number) => number
  ) {
    if (to <= from) {
      return;
    }
    const scale = this.inkScale;
    const cx = this.surface.width / 2;
    const cy = this.surface.height / 2;
    const baseAlpha = this.config.visuals.glow ? 0.24 : 0.34;
    const connectSteps = this.connectSteps();
    ctx.lineWidth = Math.max(0.5, this.config.visuals.lineWidth * 0.5);

    for (let pair = 0; pair < this.pairs.length; pair += 1) {
      let path: Path2D | null = null;
      let count = 0;
      let lastStep = 0;
      const flush = () => {
        const alpha = baseAlpha * alphaOf(lastStep);
        if (path && alpha >= 0.01) {
          ctx.strokeStyle = this.chordColor(pair, lastStep);
          ctx.globalAlpha = alpha;
          for (const t of transforms) {
            ctx.setTransform(t.a, t.b, t.c, t.d, t.e, t.f);
            ctx.stroke(path);
          }
        }
        path = null;
        count = 0;
      };
      for (let i = from; i < to; i += 1) {
        if (this.chordPair[i] !== pair) {
          continue;
        }
        if (eventStride > 1 && Math.round(this.chordStep[i] / connectSteps) % (eventStride * this.chordStride) !== 0) {
          continue;
        }
        path ??= new Path2D();
        path.moveTo(cx + this.chordX1[i] * scale, cy - this.chordY1[i] * scale);
        path.lineTo(cx + this.chordX2[i] * scale, cy - this.chordY2[i] * scale);
        lastStep = this.chordStep[i];
        count += 1;
        if (count >= COLOR_CHUNK) {
          flush();
        }
      }
      flush();
    }
  }

  /** Ink only the samples produced since the last frame. */
  private flushInk() {
    const ctx = this.ensureInk();
    if (!ctx) {
      return;
    }
    const transforms = this.symmetryTransforms();
    ctx.save();
    this.prepareInkStyle(ctx);
    const full = () => 1;

    if (this.freshChordStart < this.chordCount) {
      this.strokeChords(ctx, this.freshChordStart, this.chordCount, 1, transforms, full);
      this.freshChordStart = this.chordCount;
    }

    for (const trace of this.traces) {
      const points = trace.fresh.length / 3;
      if (points >= 2) {
        this.strokeRun(ctx, trace, trace.fresh, points, transforms, full);
        const last = trace.fresh.length - 3;
        trace.fresh.splice(0, last);
      }
    }
    ctx.restore();
  }

  /** Re-render everything from the sample store (resize, restyle, zoom, planet changes). */
  private redrawAll() {
    if (this.redrawHandle !== null) {
      window.clearTimeout(this.redrawHandle);
      this.redrawHandle = null;
    }
    const ctx = this.ensureInk();
    if (!ctx || !this.ink) {
      return;
    }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, this.ink.width, this.ink.height);
    ctx.restore();
    this.inkZoom = this.config.visuals.zoom;
    this.pendingFade = 0;
    this.buildReferenceLayer();

    const transforms = this.symmetryTransforms();
    let totalPoints = this.chordCount;
    for (const trace of this.traces) {
      totalPoints += trace.count;
    }
    const decimate = Math.max(1, Math.ceil((totalPoints * transforms.length) / REDRAW_SEGMENT_BUDGET));
    const alphaOf = (step: number) => this.fadeFactor(step);

    ctx.save();
    this.prepareInkStyle(ctx);
    if (this.config.visuals.connect) {
      this.strokeChords(ctx, 0, this.chordCount, decimate, transforms, alphaOf);
    }
    this.freshChordStart = this.chordCount;

    const chunk = 4096;
    const run = new Float64Array((chunk + 1) * 3);
    for (const trace of this.traces) {
      let n = 0;
      for (let i = 0; i < trace.count; i += decimate) {
        run[n * 3] = trace.xs[i];
        run[n * 3 + 1] = trace.ys[i];
        run[n * 3 + 2] = trace.steps[i];
        n += 1;
        if (n === chunk + 1) {
          this.strokeRun(ctx, trace, run, n, transforms, alphaOf);
          run.copyWithin(0, chunk * 3, (chunk + 1) * 3);
          n = 1;
        }
      }
      // Bridge from the last stored sample to the live tip so the line stays continuous.
      const freshCount = trace.fresh.length / 3;
      if (freshCount > 0 && n < chunk + 1) {
        run[n * 3] = trace.fresh[0];
        run[n * 3 + 1] = trace.fresh[1];
        run[n * 3 + 2] = trace.fresh[2];
        n += 1;
      }
      this.strokeRun(ctx, trace, run, n, transforms, alphaOf);
    }
    ctx.restore();
    this.renderStill();
  }

  private scheduleRedraw() {
    if (this.redrawHandle !== null) {
      window.clearTimeout(this.redrawHandle);
    }
    this.redrawHandle = window.setTimeout(() => {
      this.redrawHandle = null;
      this.redrawAll();
    }, 160);
  }

  private rebuildLayers() {
    this.computeScale();
    this.redrawAll();
  }

  private buildReferenceLayer() {
    const ratio = this.surface.pixelRatio;
    const layer = createLayerCanvas(this.surface.canvas.width, this.surface.canvas.height);
    const ctx = layer.getContext('2d');
    this.referenceLayer = layer;
    if (!ctx) {
      return;
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.drawReference(ctx, this.surface.width, this.surface.height, this.inkScale);
  }

  /** Crosshair, round-AU rings with labels, and the perspective body at the centre. */
  private drawReference(ctx: CanvasRenderingContext2D, width: number, height: number, scale: number) {
    const cx = width / 2;
    const cy = height / 2;
    const outer = Math.hypot(width, height) / 2;

    // Rings at round AU distances; spacing adapts so roughly five fit inside the frame.
    if (!(scale > 0)) {
      return;
    }
    const fitRadiusAu = (FRAME_FILL * Math.min(width, height)) / scale;
    const spacing = [0.1, 0.25, 0.5, 1, 2, 5, 10, 20].find((s) => fitRadiusAu / s <= 6) ?? 20;
    ctx.strokeStyle = '#161616';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - outer, cy);
    ctx.lineTo(cx + outer, cy);
    ctx.moveTo(cx, cy - outer);
    ctx.lineTo(cx, cy + outer);
    ctx.stroke();

    ctx.font = '10px "JetBrains Mono", "Fira Code", ui-monospace, monospace';
    ctx.fillStyle = '#4a4a4a';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    for (let au = spacing; au * scale < outer; au += spacing) {
      const r = au * scale;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
      if (r > 18 && this.config.visuals.auLabels) {
        ctx.fillText(`${Number(au.toFixed(2))} AU`, cx + 4, cy - r - 2);
      }
    }

    ctx.fillStyle = getPlanetColor(this.perspectiveBody);
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  /**
   * Render the current state into a new canvas of any logical size (e.g. a phone-shaped
   * portrait for snapshots): rings and tips are redrawn at the new scale, and the ink layer is
   * scaled about the centre to match (a small enlargement at most on phones).
   */
  renderSnapshot(width: number, height: number, into?: HTMLCanvasElement): HTMLCanvasElement {
    const ratio = this.surface.pixelRatio;
    // `into` lets a recording redraw the same frame canvas every animation frame.
    const canvas = into ?? createLayerCanvas(Math.round(width * ratio), Math.round(height * ratio));
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return canvas;
    }
    ctx.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
    ctx.fillStyle = '#050505';
    ctx.fillRect(0, 0, width + 1, height + 1);
    const scale = this.baseScaleFor(width, height) * this.config.visuals.zoom;
    this.drawReference(ctx, width, height, scale);
    if (this.ink && this.inkScale > 0) {
      const k = scale / this.inkScale;
      ctx.save();
      ctx.translate(width / 2, height / 2);
      ctx.scale(k, k);
      ctx.translate(-this.surface.width / 2, -this.surface.height / 2);
      ctx.drawImage(this.ink, 0, 0, this.surface.width, this.surface.height);
      ctx.restore();
    }
    this.drawTips(ctx, width, height, scale);
    return canvas;
  }

  private renderStill() {
    if (this.paused && this.started) {
      this.render();
    }
  }

  private render() {
    const ctx = this.surface.context;
    const width = this.surface.width;
    const height = this.surface.height;
    this.surface.clear();

    // Mid-gesture the live zoom runs ahead of the ink: scale both layers about the centre until
    // the crisp redraw lands.
    const ratio = this.config.visuals.zoom / this.inkZoom;
    const w = width * ratio;
    const h = height * ratio;
    const x = (width - w) / 2;
    const y = (height - h) / 2;
    if (this.referenceLayer) {
      ctx.drawImage(this.referenceLayer, x, y, w, h);
    }
    if (this.ink) {
      ctx.drawImage(this.ink, x, y, w, h);
    }

    this.updatePreview();
    this.drawTips(ctx, width, height);
  }

  private drawTips(ctx: CanvasRenderingContext2D, width: number, height: number, scale = this.scale) {
    const cx = width / 2;
    const cy = height / 2;
    const layout = this.labelLayout;
    layout.reset();
    for (const trace of this.traces) {
      if (trace.hasSample) {
        layout.addMarker(cx + trace.previewX * scale, cy - trace.previewY * scale, 5);
      }
    }
    ctx.save();
    ctx.lineCap = 'round';
    for (const trace of this.traces) {
      if (!trace.hasSample) {
        continue;
      }
      const x = cx + trace.previewX * scale;
      const y = cy - trace.previewY * scale;
      const color = this.traceColor(trace, this.stepIndex);

      // Preview extension from the last inked sample to the interpolated position.
      const n = trace.fresh.length;
      if (n >= 3) {
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.6;
        ctx.lineWidth = this.config.visuals.lineWidth;
        ctx.beginPath();
        ctx.moveTo(cx + trace.fresh[n - 3] * scale, cy - trace.fresh[n - 2] * scale);
        ctx.lineTo(x, y);
        ctx.stroke();
      }

      ctx.fillStyle = color;
      ctx.globalAlpha = 0.18;
      ctx.beginPath();
      ctx.arc(x, y, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.arc(x, y, 6.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();

      if (this.config.visuals.labels) {
        ctx.font = MARKER_LABEL_FONT;
        ctx.globalAlpha = 0.85;
        drawMarkerLabel(ctx, trace.label, color, x, y, width, 9, layout);
      }
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------- interaction

  private setZoom(zoom: number) {
    const clamped = Math.max(0.25, Math.min(40, zoom));
    if (clamped === this.config.visuals.zoom) {
      return;
    }
    this.config.visuals = { ...this.config.visuals, zoom: clamped };
    this.config.onZoomChange?.(clamped);
    this.renderStill();
    this.scheduleRedraw();
  }

  private attachGestures(canvas: HTMLCanvasElement) {
    canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        this.setZoom(this.config.visuals.zoom * Math.exp(-event.deltaY * 0.0015));
      },
      { passive: false }
    );
    canvas.addEventListener('dblclick', () => this.setZoom(1));

    const distance = () => {
      const [a, b] = Array.from(this.pointers.values());
      return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
    };
    canvas.addEventListener('pointerdown', (event) => {
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (this.pointers.size === 2) {
        this.pinchStartDistance = distance();
        this.pinchStartZoom = this.config.visuals.zoom;
      }
    });
    canvas.addEventListener('pointermove', (event) => {
      if (!this.pointers.has(event.pointerId)) {
        return;
      }
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (this.pointers.size === 2 && this.pinchStartDistance > 0) {
        this.setZoom(this.pinchStartZoom * (distance() / this.pinchStartDistance));
      }
    });
    const release = (event: PointerEvent) => {
      this.pointers.delete(event.pointerId);
      if (this.pointers.size < 2) {
        this.pinchStartDistance = 0;
      }
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
  }

  private handleResize = () => {
    if (!this.surface.resize()) {
      return;
    }
    this.ink = null;
    this.inkCtx = null;
    this.rebuildLayers();
  };
}
