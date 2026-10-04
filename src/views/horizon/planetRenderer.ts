import { Observer } from 'astronomy-engine';
import { InterpolatedHorizonTrack, type HorizonSample } from '../../core/astro';
import { equatorSource, type SkyTarget } from '../targets';
import type { SkyProjection } from './projection';
import { strokeTrail, TrailPath, type TrailStyle } from './trailPath';

type HistoryTrail = {
  path: TrailPath;
  /** Sim time the sweep completed (its newest point): bounds how much fresh glow remains. */
  committedAtMs: number;
  /** Cycles since completion; drives brightness (1 − (age/P)²) and removal at P. */
  age: number;
  /** Completion remainder still being eased into `age` (keeps one sweep = one cycle). */
  pendingAge: number;
  /** Present in the view's displayed history layer; otherwise drawn directly each frame. */
  inFront: boolean;
  /** Drawn into the history layer currently being rebuilt. */
  inBack: boolean;
};

export type PlanetRendererConfig = {
  target: SkyTarget;
  observer: Observer;
  baseTimestamp: number;
  trailPersistence: number;
  azimuthCheckpointInterval: number;
  activeFadeRate: number;
  /** Brightness a trail keeps once its fresh glow has faded (only with a fade rate). */
  settledBrightness: number;
  cycleLimit: number;
  lineWidth: number;
  trailStyle: TrailStyle;
};

type VisibilityTest = (sample: HorizonSample) => boolean;

/** Age changes smaller than this (in cycles) are batched into one history-layer rebuild. */
const AGE_REBUILD_STEP = 0.05;
/** A completed sweep's remaining fraction of a cycle is eased in at this rate (cycles per ms). */
const AGE_CATCHUP_PER_MS = 1 / 400;
const ALPHA_BANDS = 16;
/** Below this, a trail's fresh glow is invisible and only its settled streak remains. */
const MIN_GLOW_ALPHA = 0.004;
/** ≤ ~0.2px in either projection on large screens: visually identical, far fewer vertices. */
const SIMPLIFY_TOLERANCE_DEG = 0.02;

/**
 * Trail state and aging for a single body: one vector active sweep plus a list of completed
 * sweeps that fade out over `trailPersistence` cycles.
 *
 * Brightness is continuous in time for every trail, live or completed:
 *   alpha = cycleAlpha(age) · (settled + (1 − settled) · e^(−fadeRate · pointAge))
 * so completing a sweep changes nothing on screen, old sweep ends cannot stack up bright, and a
 * trail is removed exactly when cycleAlpha reaches zero. The settled part is static and lives in
 * the view's cached history layer; only the decaying glow of recent sweeps is redrawn per frame.
 */
export class PlanetRenderer {
  private activePath = new TrailPath(256);
  private nextActiveSimplifyAt = 96;
  private historyTrails: HistoryTrail[] = [];
  private lastVisibleSample: HorizonSample | null = null;
  private lastVisibleTimeMs = 0;
  /** Azimuth travelled since the last aging checkpoint (degrees). */
  private azimuthSinceCheckpoint = 0;
  private azimuthAgeThisCycle = 0;
  private ageSinceRebuild = 0;
  private completedCycles = 0;
  private readonly track: InterpolatedHorizonTrack;
  private cachedSampleTimeMs = Number.NaN;
  private cachedSample: HorizonSample | null = null;

  /** Set whenever the history layer would look different; cleared by the view after compositing. */
  historyDirty = false;
  readonly color: string;

  constructor(
    private config: PlanetRendererConfig,
    private isSampleVisible: VisibilityTest
  ) {
    this.color = config.target.color;
    const source = equatorSource(config.target, config.observer);
    this.track = new InterpolatedHorizonTrack(source.equatorAt, source.nodeMinutes, config.observer);
  }

  get target(): SkyTarget {
    return this.config.target;
  }

  setStyle(lineWidth: number, trailStyle: TrailStyle, settledBrightness: number) {
    this.config.lineWidth = lineWidth;
    this.config.trailStyle = trailStyle;
    this.config.settledBrightness = settledBrightness;
    this.historyDirty = true;
  }

  getLastVisibleSample(): HorizonSample | null {
    return this.lastVisibleSample;
  }

  getLastVisibleTimeMs() {
    return this.lastVisibleTimeMs;
  }

  setLastVisibleSample(sample: HorizonSample | null, timeMs: number = 0) {
    this.lastVisibleSample = sample;
    this.lastVisibleTimeMs = timeMs;
  }

  hasActivePaint(): boolean {
    return this.activePath.length > 1;
  }

  clearActiveTrail() {
    this.activePath.clear();
  }

  /**
   * Samples are memoised per sim time: the render pass asks for the same instant several
   * times (aging, markers, preview) and each ephemeris evaluation is comparatively costly.
   */
  computeSampleAt(simTimeMs: number): HorizonSample {
    if (simTimeMs === this.cachedSampleTimeMs && this.cachedSample) {
      return this.cachedSample;
    }
    const sample = this.track.sample(this.config.baseTimestamp + simTimeMs);
    this.cachedSampleTimeMs = simTimeMs;
    this.cachedSample = sample;
    return sample;
  }

  paintSegment(a: HorizonSample, aTimeMs: number, b: HorizonSample, bTimeMs: number) {
    const path = this.activePath;
    if (path.length === 0 || path.lastTime !== aTimeMs) {
      path.push(a.azimuth, a.altitude, aTimeMs, true);
    }

    // A long rise from below the horizon is subdivided so the trail hugs the ground.
    const altitudeDelta = Math.abs(b.altitude - a.altitude);
    const azDelta = Math.abs(b.azimuth - a.azimuth);
    if (azDelta <= 180 && altitudeDelta > 8 && !this.isSampleVisible(a) && this.isSampleVisible(b)) {
      const subdivisions = Math.ceil(altitudeDelta / 4);
      for (let i = 1; i < subdivisions; i += 1) {
        const t = i / subdivisions;
        path.push(
          a.azimuth + (b.azimuth - a.azimuth) * t,
          a.altitude + (b.altitude - a.altitude) * t,
          aTimeMs + (bTimeMs - aTimeMs) * t,
          false
        );
      }
    }

    path.push(b.azimuth, b.altitude, bTimeMs, false);
    this.ageByAzimuth(azDelta > 180 ? 360 - azDelta : azDelta);

    // Keep the live sweep lean too (amortised: re-simplify each time it doubles).
    if (path.length >= this.nextActiveSimplifyAt) {
      this.activePath = path.simplifiedCopy(SIMPLIFY_TOLERANCE_DEG);
      this.nextActiveSimplifyAt = Math.max(96, this.activePath.length * 2);
    }
  }

  /**
   * History ages by the azimuth the body sweeps, applied in checkpoint-sized increments.
   * Accumulated per painted segment so it advances with simulated motion, not frame timing.
   */
  private ageByAzimuth(azimuthDelta: number) {
    this.azimuthSinceCheckpoint += azimuthDelta;
    const checkpointInterval = Math.max(1, this.config.azimuthCheckpointInterval);
    if (this.azimuthSinceCheckpoint < checkpointInterval) {
      return;
    }
    const ageIncrement = this.azimuthSinceCheckpoint / 360;
    this.azimuthSinceCheckpoint = 0;
    this.azimuthAgeThisCycle += ageIncrement;
    for (let i = 0; i < this.historyTrails.length; i += 1) {
      this.historyTrails[i].age += ageIncrement;
    }
    this.noteAging(ageIncrement);
  }

  private noteAging(amount: number) {
    this.ageSinceRebuild += amount;
    if (this.ageSinceRebuild >= AGE_REBUILD_STEP) {
      this.historyDirty = true;
    }
  }

  /** A body that never sets (circumpolar) still completes a cycle every full turn of azimuth. */
  hasCompletedFullTurn() {
    return this.azimuthAgeThisCycle >= 1;
  }

  commitActiveTrailToHistory(commitTimeMs: number): boolean {
    if (!this.hasActivePaint()) {
      this.activePath.clear();
      return false;
    }

    // A sweep that covered less than a full turn still counts as one cycle: older trails get
    // the remainder (eased in by update()) so they stay exactly one cycle apart.
    const remainder = Math.max(0, 1 - this.azimuthAgeThisCycle);
    for (let i = 0; i < this.historyTrails.length; i += 1) {
      this.historyTrails[i].pendingAge += remainder;
    }
    this.pruneHistory();

    this.historyTrails.push({
      path: this.activePath.simplifiedCopy(SIMPLIFY_TOLERANCE_DEG),
      committedAtMs: commitTimeMs,
      age: 0,
      pendingAge: 0,
      inFront: false,
      inBack: false,
    });
    this.completedCycles += 1;
    this.historyDirty = true;

    this.activePath.clear();
    this.nextActiveSimplifyAt = 96;
    this.azimuthAgeThisCycle = 0;
    return true;
  }

  /** Per-frame bookkeeping: eases pending age into trails and removes fully faded ones. */
  update(frameMs: number) {
    const step = frameMs * AGE_CATCHUP_PER_MS;
    let applied = 0;
    let finished = false;
    for (let i = 0; i < this.historyTrails.length; i += 1) {
      const trail = this.historyTrails[i];
      if (trail.pendingAge > 0) {
        const delta = Math.min(trail.pendingAge, step);
        trail.age += delta;
        trail.pendingAge -= delta;
        applied = Math.max(applied, delta);
        finished ||= trail.pendingAge <= 0;
      }
    }
    if (applied > 0) {
      this.noteAging(applied);
      if (finished) {
        this.historyDirty = true;
      }
    }
    this.pruneHistory();
  }

  private pruneHistory() {
    for (let i = this.historyTrails.length - 1; i >= 0; i -= 1) {
      if (this.historyTrails[i].age >= this.config.trailPersistence) {
        this.historyTrails.splice(i, 1);
        this.historyDirty = true;
      }
    }
  }

  private cycleAlpha(trail: HistoryTrail) {
    const ratio = trail.age / this.config.trailPersistence;
    return Math.max(0, 1 - ratio * ratio);
  }

  /** Settled level: without a fade there is no glow, so trails stay at full brightness. */
  private get settled() {
    return this.config.activeFadeRate > 0 ? Math.min(1, Math.max(0, this.config.settledBrightness)) : 1;
  }

  /** Draw every trail's settled streak into the history layer being rebuilt; returns how many showed. */
  drawHistory(ctx: CanvasRenderingContext2D, projection: SkyProjection) {
    this.ageSinceRebuild = 0;
    const settled = this.settled;
    let drawn = 0;
    for (let i = 0; i < this.historyTrails.length; i += 1) {
      const trail = this.historyTrails[i];
      const alpha = this.cycleAlpha(trail) * settled;
      if (alpha > 0.005) {
        strokeTrail(ctx, projection, trail.path, {
          color: this.color,
          lineWidth: this.config.lineWidth,
          alpha,
          fadeRate: 0,
          referenceMs: 0,
          style: this.config.trailStyle,
          bands: 1,
        });
        drawn += 1;
      }
      trail.inBack = true;
    }
    return drawn;
  }

  /** The rebuilt layer is now displayed: whatever was drawn into it is on screen. */
  promoteBackLayer() {
    for (let i = 0; i < this.historyTrails.length; i += 1) {
      this.historyTrails[i].inFront = this.historyTrails[i].inBack;
      this.historyTrails[i].inBack = false;
    }
  }

  /** The history layers were discarded (resize, projection change): nothing is composited. */
  resetCompositeState() {
    for (let i = 0; i < this.historyTrails.length; i += 1) {
      this.historyTrails[i].inFront = false;
      this.historyTrails[i].inBack = false;
    }
  }

  /**
   * Per-frame part of the history, newest first: trails not yet in the cached layer are drawn
   * whole; composited ones only get their still-decaying glow on top. Stops at the first
   * composited trail whose glow has gone (older ones have even less).
   */
  drawLiveHistory(ctx: CanvasRenderingContext2D, projection: SkyProjection, nowMs: number) {
    const rate = this.config.activeFadeRate;
    const settled = this.settled;
    for (let i = this.historyTrails.length - 1; i >= 0; i -= 1) {
      const trail = this.historyTrails[i];
      const alpha = this.cycleAlpha(trail);
      if (!trail.inFront) {
        this.strokeLive(ctx, projection, trail.path, alpha, nowMs, false);
        continue;
      }
      if (rate <= 0) {
        break;
      }
      const headGlow = alpha * (1 - settled) * Math.exp((-rate * Math.abs(nowMs - trail.committedAtMs)) / 1000);
      if (headGlow < MIN_GLOW_ALPHA) {
        break;
      }
      this.strokeLive(ctx, projection, trail.path, alpha, nowMs, true);
    }
  }

  /** Everything this body has drawn, straight onto `ctx` (snapshots): no compositing state changes. */
  drawSnapshot(ctx: CanvasRenderingContext2D, projection: SkyProjection, nowMs: number) {
    for (let i = 0; i < this.historyTrails.length; i += 1) {
      const trail = this.historyTrails[i];
      this.strokeLive(ctx, projection, trail.path, this.cycleAlpha(trail), nowMs, false);
    }
    this.drawActive(ctx, projection, nowMs);
  }

  drawActive(ctx: CanvasRenderingContext2D, projection: SkyProjection, nowMs: number) {
    this.strokeLive(ctx, projection, this.activePath, 1, nowMs, false);
  }

  private strokeLive(
    ctx: CanvasRenderingContext2D,
    projection: SkyProjection,
    path: TrailPath,
    alpha: number,
    nowMs: number,
    glowOnly: boolean
  ) {
    strokeTrail(ctx, projection, path, {
      color: this.color,
      lineWidth: this.config.lineWidth,
      alpha,
      fadeRate: this.config.activeFadeRate,
      referenceMs: nowMs,
      style: this.config.trailStyle,
      bands: ALPHA_BANDS,
      fadeFloor: this.settled,
      glowOnly,
    });
  }

  reset() {
    this.lastVisibleSample = null;
    this.lastVisibleTimeMs = 0;
    this.activePath.clear();
    this.historyTrails = [];
    this.historyDirty = true;
    this.azimuthSinceCheckpoint = 0;
    this.azimuthAgeThisCycle = 0;
    this.completedCycles = 0;
  }

  hasReachedCycleLimit(): boolean {
    return this.config.cycleLimit > 0 && this.completedCycles >= this.config.cycleLimit;
  }
}
