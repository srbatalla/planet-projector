import { computeStarHorizon, createStarTable, type StarTable } from '../../core/stars';
import { createLayerCanvas } from '../../render/canvas';
import type { Point, SkyProjection } from './projection';

export type StarMode = 'off' | 'points' | 'trails';

/** Magnitude bands: brighter stars get a larger, more opaque mark. */
const BANDS = [
  { maxMag: 0.6, radius: 1.6, alpha: 0.95, trailWidth: 1.3, trailAlpha: 0.75 },
  { maxMag: 1.6, radius: 1.2, alpha: 0.75, trailWidth: 1.0, trailAlpha: 0.5 },
  { maxMag: 99, radius: 0.85, alpha: 0.5, trailWidth: 0.8, trailAlpha: 0.32 },
];
/** Simulated time over which a trail fades by ~63% — roughly a long-exposure frame. */
const TRAIL_FADE_SECONDS = 4 * 3600;
/** Fades are batched until at least this much alpha is removed (limits 8-bit residue). */
const MIN_FADE_STEP = 0.06;
/** Safety net: a frame spanning more than this is never joined (jumps are signalled explicitly). */
const MAX_CONTINUOUS_GAP_MS = 12 * 3600 * 1000;
const SIDEREAL_DAY_MS = 86164091;
/** Fast frames are split so each drawn chord covers at most this much sky rotation. */
const MAX_SUBSTEP_DEG = 3;
const MAX_SUBSTEPS = 32;

export class StarField {
  private readonly table: StarTable = createStarTable();
  private readonly az: Float32Array;
  private readonly alt: Float32Array;
  private readonly prevX: Float32Array;
  private readonly prevY: Float32Array;
  private readonly prevAz: Float32Array;
  private readonly band: Uint8Array;
  private readonly subAz: Float32Array;
  private readonly subAlt: Float32Array;
  private readonly lastX: Float32Array;
  private readonly lastY: Float32Array;
  private readonly lastAz: Float32Array;
  private hasPrev = false;
  private jumpPending = false;
  private prevTimeMs = Number.NaN;
  /**
   * Added to sidereal time after each skip-ahead jump. Jumps land at the same sidereal moment
   * (the next planet rise), which would restart every star trail in the same place; a random
   * rotation of the sky lets successive arcs lay down fresh trails. Zero until the first jump,
   * so without skip-ahead the stars stay astronomically exact.
   */
  private siderealOffsetMs = 0;
  /** Cloud opacity at a logical point: thick cloud hides stars and gaps their trails. */
  private occlusion: ((x: number, y: number) => number) | null = null;
  private trailLayer: HTMLCanvasElement | null = null;
  private trailCtx: CanvasRenderingContext2D | null = null;
  private pendingFade = 0;
  /** Nothing drawn since the layer was created or cleared: skip compositing it. */
  private layerEmpty = true;
  private readonly point: Point = { x: 0, y: 0 };

  constructor(
    private mode: StarMode,
    private latitude: number,
    private longitude: number
  ) {
    const n = this.table.count;
    this.az = new Float32Array(n);
    this.alt = new Float32Array(n);
    this.prevX = new Float32Array(n);
    this.prevY = new Float32Array(n);
    this.prevAz = new Float32Array(n);
    this.band = new Uint8Array(n);
    this.subAz = new Float32Array(n);
    this.subAlt = new Float32Array(n);
    this.lastX = new Float32Array(n);
    this.lastY = new Float32Array(n);
    this.lastAz = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      this.band[i] = BANDS.findIndex((band) => this.table.mag[i] <= band.maxMag);
    }
  }

  setMode(mode: StarMode) {
    if (mode === this.mode) {
      return;
    }
    this.mode = mode;
    this.hasPrev = false;
    if (mode !== 'trails') {
      this.trailLayer = null;
      this.trailCtx = null;
    }
  }

  setOcclusion(occlusion: ((x: number, y: number) => number) | null) {
    this.occlusion = occlusion;
  }

  /** The view skipped ahead: break the trails and turn the sky to a fresh random rotation. */
  markJump() {
    this.jumpPending = true;
  }

  /** Drop the trail layer (resize / projection change): it is rebuilt from the next frame. */
  invalidate() {
    this.trailLayer = null;
    this.trailCtx = null;
    this.hasPrev = false;
  }

  /**
   * Advance to `absoluteTimeMs` and draw. `visibility` (0..1) dims stars in daylight.
   */
  draw(
    ctx: CanvasRenderingContext2D,
    projection: SkyProjection,
    absoluteTimeMs: number,
    visibility: number,
    pixelWidth: number,
    pixelHeight: number,
    pixelRatio: number
  ) {
    if (this.mode === 'off') {
      return;
    }

    if (this.jumpPending) {
      this.jumpPending = false;
      this.hasPrev = false;
      this.siderealOffsetMs = Math.random() * SIDEREAL_DAY_MS;
    }
    const delta = absoluteTimeMs - this.prevTimeMs;
    const gap = Math.abs(delta);
    const continuous = this.hasPrev && gap <= MAX_CONTINUOUS_GAP_MS;
    computeStarHorizon(
      this.table,
      absoluteTimeMs + this.siderealOffsetMs,
      this.latitude,
      this.longitude,
      this.az,
      this.alt
    );

    if (this.mode === 'trails') {
      this.drawTrails(ctx, projection, delta, continuous, visibility, pixelWidth, pixelHeight, pixelRatio);
    }

    if (visibility > 0.02) {
      this.drawPoints(ctx, projection, visibility);
    }

    this.storePositions(projection);
    this.prevTimeMs = absoluteTimeMs;
    this.hasPrev = true;
  }

  private ensureTrailLayer(pixelWidth: number, pixelHeight: number, pixelRatio: number) {
    if (
      !this.trailLayer ||
      this.trailLayer.width !== pixelWidth ||
      this.trailLayer.height !== pixelHeight
    ) {
      this.trailLayer = createLayerCanvas(pixelWidth, pixelHeight);
      this.trailCtx = this.trailLayer.getContext('2d');
      this.trailCtx?.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      this.hasPrev = false;
      this.pendingFade = 0;
      this.layerEmpty = true;
    }
    return this.trailCtx;
  }

  private drawTrails(
    ctx: CanvasRenderingContext2D,
    projection: SkyProjection,
    deltaMs: number,
    continuous: boolean,
    visibility: number,
    pixelWidth: number,
    pixelHeight: number,
    pixelRatio: number
  ) {
    const fresh =
      !this.trailLayer || this.trailLayer.width !== pixelWidth || this.trailLayer.height !== pixelHeight;
    const layerCtx = this.ensureTrailLayer(pixelWidth, pixelHeight, pixelRatio);
    if (!layerCtx || !this.trailLayer) {
      return;
    }

    const gapMs = Math.abs(deltaMs);
    if (continuous && !fresh && gapMs > 0) {
      this.pendingFade = 1 - (1 - this.pendingFade) * Math.exp(-gapMs / 1000 / TRAIL_FADE_SECONDS);
      if (this.layerEmpty) {
        this.pendingFade = 0;
      } else if (this.pendingFade >= MIN_FADE_STEP) {
        layerCtx.save();
        layerCtx.setTransform(1, 0, 0, 1, 0, 0);
        layerCtx.globalCompositeOperation = 'destination-out';
        layerCtx.globalAlpha = this.pendingFade;
        layerCtx.fillRect(0, 0, pixelWidth, pixelHeight);
        layerCtx.restore();
        this.pendingFade = 0;
      }

      if (visibility > 0.02) {
        this.strokeTrailSegments(layerCtx, projection, deltaMs, visibility);
        this.layerEmpty = false;
      }
    }

    if (!this.layerEmpty) {
      ctx.drawImage(this.trailLayer, 0, 0, pixelWidth / pixelRatio, pixelHeight / pixelRatio);
    }
  }

  /**
   * Extend every star's trail from its previous position to the current one. At high speed a
   * frame can turn the sky by tens of degrees, so the motion is split into sub-steps that follow
   * the true circular path instead of one straight chord.
   */
  private strokeTrailSegments(
    layerCtx: CanvasRenderingContext2D,
    projection: SkyProjection,
    deltaMs: number,
    visibility: number
  ) {
    const gapMs = Math.abs(deltaMs);
    const count = this.table.count;
    const wraps = projection.wrapsAzimuth;
    const p = this.point;
    const rotationDeg = (gapMs / 3600000) * 15.041;
    const steps = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(rotationDeg / MAX_SUBSTEP_DEG)));
    const paths = BANDS.map(() => new Path2D());
    this.lastX.set(this.prevX);
    this.lastY.set(this.prevY);
    this.lastAz.set(this.prevAz);

    for (let k = 1; k <= steps; k += 1) {
      let az = this.az;
      let alt = this.alt;
      if (k < steps) {
        computeStarHorizon(
          this.table,
          this.prevTimeMs + this.siderealOffsetMs + (k / steps) * deltaMs,
          this.latitude,
          this.longitude,
          this.subAz,
          this.subAlt
        );
        az = this.subAz;
        alt = this.subAlt;
      }
      for (let i = 0; i < count; i += 1) {
        projection.project(az[i], alt[i], p);
        // Skip below-horizon stretches, wraps past north, fast near-zenith swings, and stretches
        // behind thick cloud (a long exposure records nothing there).
        const skip =
          alt[i] < -2 ||
          (wraps && Math.abs(az[i] - this.lastAz[i]) > 20) ||
          (this.occlusion !== null && this.occlusion(p.x, p.y) > 0.45);
        if (!skip) {
          const path = paths[this.band[i]];
          path.moveTo(this.lastX[i], this.lastY[i]);
          path.lineTo(p.x, p.y);
        }
        this.lastX[i] = p.x;
        this.lastY[i] = p.y;
        this.lastAz[i] = az[i];
      }
    }

    layerCtx.strokeStyle = '#dfe6ff';
    // One segment per star per sub-step; round caps would double-expose every join and bead
    // the trail.
    layerCtx.lineCap = 'butt';
    for (let b = 0; b < BANDS.length; b += 1) {
      layerCtx.globalAlpha = BANDS[b].trailAlpha * visibility;
      layerCtx.lineWidth = BANDS[b].trailWidth;
      layerCtx.stroke(paths[b]);
    }
    layerCtx.globalAlpha = 1;
  }

  /**
   * Draw the current stars into another render (snapshots) without advancing any state: the
   * trail layer is mapped from `source` to `target` (same projection kind, different size).
   */
  drawSnapshot(
    ctx: CanvasRenderingContext2D,
    target: SkyProjection,
    source: SkyProjection,
    visibility: number,
    sourceWidth: number,
    sourceHeight: number
  ) {
    if (this.mode === 'off' || !this.hasPrev) {
      return;
    }
    const map = source.affineTo(target);
    if (this.mode === 'trails' && this.trailLayer && !this.layerEmpty && map) {
      ctx.save();
      ctx.transform(map.a, map.b, map.c, map.d, map.e, map.f);
      ctx.drawImage(this.trailLayer, 0, 0, sourceWidth, sourceHeight);
      ctx.restore();
    }
    if (visibility > 0.02) {
      // Occlusion is sampled in live-canvas coordinates; the snapshot veils stars with its clouds.
      const occlusion = this.occlusion;
      this.occlusion = null;
      this.drawPoints(ctx, target, visibility);
      this.occlusion = occlusion;
    }
  }

  private drawPoints(ctx: CanvasRenderingContext2D, projection: SkyProjection, visibility: number) {
    const p = this.point;
    ctx.fillStyle = '#eef2ff';
    for (let b = 0; b < BANDS.length; b += 1) {
      const { radius, alpha } = BANDS[b];
      ctx.globalAlpha = alpha * visibility;
      ctx.beginPath();
      for (let i = 0; i < this.table.count; i += 1) {
        if (this.band[i] !== b || this.alt[i] < -1) {
          continue;
        }
        projection.project(this.az[i], this.alt[i], p);
        if (this.occlusion !== null && this.occlusion(p.x, p.y) > 0.55) {
          continue;
        }
        ctx.moveTo(p.x + radius, p.y);
        ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      }
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  private storePositions(projection: SkyProjection) {
    const p = this.point;
    for (let i = 0; i < this.table.count; i += 1) {
      projection.project(this.az[i], this.alt[i], p);
      this.prevX[i] = p.x;
      this.prevY[i] = p.y;
      this.prevAz[i] = this.az[i];
    }
  }
}
