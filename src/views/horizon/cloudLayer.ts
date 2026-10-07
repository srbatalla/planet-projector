import { createLayerCanvas } from '../../render/canvas';
import type { SkyProjection } from './projection';
import { blurNoise, makeNoise, NOISE_SIZE, random, sampleBilinear } from './noise';

export type CloudMode = 'off' | 'drift' | 'exposure';

export type CloudLight = {
  /** Sun and Moon directions (degrees) and the Moon's illuminated fraction (0..1). */
  sunAzimuth: number;
  sunAltitude: number;
  moonAzimuth: number;
  moonAltitude: number;
  moonPhase: number;
};

const DEG = Math.PI / 180;
/** Low-resolution buffer size; upscaling with smoothing doubles as the soft cloud edge. */
const TARGET_PIXELS = 16000;
/** Cloud deck geometry, in units of its height above the observer. */
const TEXTURE_SPAN = 12;
const DETAIL_SPAN = 5;
const MIN_ALTITUDE = 1.5;
/** Wind in deck heights per simulated second (≈10 m/s at 2 km). */
const WIND_SPEED = 0.005;
/** Cloud motion never runs faster than this multiple of real time, so time-lapse does not strobe. */
const MAX_DRIFT_SPEEDUP = 600;
/**
 * Long-exposure smear time constant (real seconds). Short enough that clouds move only a couple
 * of their own widths per exposure, so streaks keep contrast instead of averaging to haze.
 */
const EXPOSURE_SECONDS = 1.2;
const MAX_ALPHA = 0.72;
/**
 * Repaints (per-pixel pass + smoothed upscale) run at ~20 Hz; every frame in between blits the
 * cached full-resolution layer 1:1, which is ~8× cheaper than re-filtering the upscale.
 */
const REPAINT_INTERVAL_MS = 48;

const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/**
 * A flat cloud deck drawn in true perspective for the dome or panorama: every low-res pixel is
 * mapped (once per resize) to its sky direction and to the point where that line of sight meets
 * the deck. Each frame two drifting noise layers are sampled there and lit from the Sun and Moon.
 */
export class CloudLayer {
  private readonly noise: Float32Array;
  private readonly noiseBlurred: Float32Array;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  /** Full-resolution cache of the upscaled clouds (backing-store pixels). */
  private display: HTMLCanvasElement | null = null;
  private displayCtx: CanvasRenderingContext2D | null = null;
  private image: ImageData | null = null;
  private lowWidth = 0;
  private lowHeight = 0;
  private scaleX = 1;
  private scaleY = 1;
  // Per-pixel lookup (valid sky pixels only).
  private dirX = new Float32Array(0);
  private dirY = new Float32Array(0);
  private dirZ = new Float32Array(0);
  /** Texture coordinates of the deck point for the broad and the detail layer. */
  private texU = new Float32Array(0);
  private texV = new Float32Array(0);
  private detailU = new Float32Array(0);
  private detailV = new Float32Array(0);
  /** Repaints are throttled (~30 Hz): clouds move slowly and the per-pixel pass is the cost. */
  private sinceRepaintMs = Infinity;
  private pendingRealMs = 0;
  private pendingSimMs = 0;
  private haze = new Float32Array(0);
  /** 0 → sharp texture, 1 → pre-blurred texture (distant deck). */
  private blur = new Float32Array(0);
  private valid = new Uint8Array(0);
  private density = new Float32Array(0);
  private exposure = new Float32Array(0);
  private exposureFresh = true;
  private offsetU = 0;
  private offsetV = 0;
  private readonly windU: number;
  private readonly windV: number;

  constructor(
    private mode: CloudMode,
    private cover: number,
    seed: number
  ) {
    this.noise = makeNoise(seed);
    this.noiseBlurred = blurNoise(this.noise, 10);
    const heading = random(seed ^ 0x9e3779b9)() * Math.PI * 2;
    this.windU = Math.cos(heading);
    this.windV = Math.sin(heading);
  }

  get enabled() {
    return this.mode !== 'off';
  }

  setMode(mode: CloudMode, cover: number) {
    if (mode !== this.mode) {
      this.exposureFresh = true;
    }
    this.mode = mode;
    this.cover = cover;
  }

  /** Rebuild the pixel → deck lookup for a projection of the given logical size. */
  resize(projection: SkyProjection, width: number, height: number, pixelRatio = 1) {
    const scale = Math.max(1, Math.sqrt((width * height) / TARGET_PIXELS));
    this.lowWidth = Math.max(8, Math.round(width / scale));
    this.lowHeight = Math.max(8, Math.round(height / scale));
    this.scaleX = width / this.lowWidth;
    this.scaleY = height / this.lowHeight;
    const n = this.lowWidth * this.lowHeight;
    this.dirX = new Float32Array(n);
    this.dirY = new Float32Array(n);
    this.dirZ = new Float32Array(n);
    this.texU = new Float32Array(n);
    this.texV = new Float32Array(n);
    this.detailU = new Float32Array(n);
    this.detailV = new Float32Array(n);
    this.haze = new Float32Array(n);
    this.blur = new Float32Array(n);
    this.valid = new Uint8Array(n);
    this.density = new Float32Array(n);
    this.exposure = new Float32Array(n);
    this.exposureFresh = true;

    for (let py = 0; py < this.lowHeight; py += 1) {
      for (let px = 0; px < this.lowWidth; px += 1) {
        const i = py * this.lowWidth + px;
        // Pixels a little below the horizon stay valid: the ground layer masks them with a clean
        // edge, instead of the buffer's own stair-stepped boundary showing.
        const sky = projection.unproject((px + 0.5) * this.scaleX, (py + 0.5) * this.scaleY);
        if (!sky) {
          continue;
        }
        const alt = Math.max(MIN_ALTITUDE, sky.altitude) * DEG;
        const az = sky.azimuth * DEG;
        this.valid[i] = 1;
        this.dirX[i] = Math.cos(alt) * Math.sin(az);
        this.dirY[i] = Math.cos(alt) * Math.cos(az);
        this.dirZ[i] = Math.sin(alt);
        // Line of sight meets the deck at horizontal distance 1/tan(alt) (deck heights).
        const distance = 1 / Math.tan(alt);
        const deckU = distance * Math.sin(az);
        const deckV = distance * Math.cos(az);
        this.texU[i] = (deckU / TEXTURE_SPAN) * NOISE_SIZE;
        this.texV[i] = (deckV / TEXTURE_SPAN) * NOISE_SIZE;
        this.detailU[i] = (deckU / DETAIL_SPAN) * NOISE_SIZE + 0.37 * NOISE_SIZE;
        this.detailV[i] = (deckV / DETAIL_SPAN) * NOISE_SIZE + 0.61 * NOISE_SIZE;
        // Distant deck detail is finer than a pixel (and would alias): blend it towards the mean
        // cover, so low sky reads as an even haze band, as it does in a real wide-angle sky.
        this.haze[i] = smoothstep(3, 14, distance);
        this.blur[i] = smoothstep(1.2, 4, distance);
      }
    }

    this.sinceRepaintMs = Infinity;
    this.display = createLayerCanvas(Math.round(width * pixelRatio), Math.round(height * pixelRatio));
    this.displayCtx = this.display.getContext('2d');
    this.canvas = createLayerCanvas(this.lowWidth, this.lowHeight);
    this.ctx = this.canvas.getContext('2d');
    this.image = this.ctx ? this.ctx.createImageData(this.lowWidth, this.lowHeight) : null;
  }

  /** Cloud opacity (0..1) at a logical canvas point; used to put gaps in star trails. */
  densityAt(x: number, y: number) {
    if (!this.enabled || this.lowWidth === 0) {
      return 0;
    }
    const px = Math.min(this.lowWidth - 1, Math.max(0, Math.floor(x / this.scaleX)));
    const py = Math.min(this.lowHeight - 1, Math.max(0, Math.floor(y / this.scaleY)));
    const i = py * this.lowWidth + px;
    return this.mode === 'exposure' ? this.exposure[i] : this.density[i];
  }



  /** Advance the wind and repaint the low-res cloud image. */
  /** Advance and repaint when due; returns whether it repainted this frame. */
  update(realDeltaMs: number, simDeltaMs: number, light: CloudLight, force = false): boolean {
    if (!this.enabled || !this.image || !this.ctx || !this.canvas) {
      return false;
    }
    this.pendingRealMs += Math.max(0, realDeltaMs);
    this.pendingSimMs += simDeltaMs;
    this.sinceRepaintMs += Math.max(0, realDeltaMs);
    if (!force && !this.exposureFresh && this.sinceRepaintMs < REPAINT_INTERVAL_MS) {
      return false;
    }
    const realSeconds = this.pendingRealMs / 1000;
    // Rewinding blows the clouds back the way they came.
    const driftSeconds =
      Math.sign(this.pendingSimMs) * Math.min(Math.abs(this.pendingSimMs) / 1000, realSeconds * MAX_DRIFT_SPEEDUP);
    this.pendingRealMs = 0;
    this.pendingSimMs = 0;
    this.sinceRepaintMs = 0;
    const step = ((WIND_SPEED * driftSeconds) / TEXTURE_SPAN) * NOISE_SIZE;
    this.offsetU += this.windU * step;
    this.offsetV += this.windV * step;
    // Keep offsets small so float precision never degrades over long runs.
    this.offsetU %= NOISE_SIZE * 64;
    this.offsetV %= NOISE_SIZE * 64;

    const cover = Math.min(1, Math.max(0, this.cover));
    const low = 1.02 - cover * 1.1;
    const high = low + 0.22;
    const mean = cover ** 1.3;

    // Lighting terms shared by every pixel.
    const sunAlt = light.sunAltitude;
    const sunX = Math.cos(sunAlt * DEG) * Math.sin(light.sunAzimuth * DEG);
    const sunY = Math.cos(sunAlt * DEG) * Math.cos(light.sunAzimuth * DEG);
    const sunZ = Math.sin(sunAlt * DEG);
    const moonX = Math.cos(light.moonAltitude * DEG) * Math.sin(light.moonAzimuth * DEG);
    const moonY = Math.cos(light.moonAltitude * DEG) * Math.cos(light.moonAzimuth * DEG);
    const moonZ = Math.sin(light.moonAltitude * DEG);
    const day = smoothstep(-2, 12, sunAlt);

    const twilight = smoothstep(-14, -3, sunAlt) * (1 - smoothstep(4, 14, sunAlt));
    // Silver lining: clouds right around a low Sun light up.
    const sunGlow = smoothstep(-8, 0, sunAlt) * (1 - smoothstep(10, 25, sunAlt));
    const moonUp = smoothstep(-3, 8, light.moonAltitude) * (1 - day);
    // Overall silvering follows the Moon's brightness; forward scattering around it stays strong
    // even for a half Moon (the eye adapts), so it follows √phase.
    const moonlight = light.moonPhase * moonUp;
    const moonScatter = Math.sqrt(light.moonPhase) * moonUp;
    const noise = this.noise;
    const blurred = this.noiseBlurred;
    const mask = NOISE_SIZE - 1;
    const offsetU = this.offsetU;
    const offsetV = this.offsetV;
    const detailOffsetU = offsetU * 1.35;
    const detailOffsetV = offsetV * 1.35;
    const span = high - low;
    const middle = (low + high) / 2;

    const exposureBlend = 1 - Math.exp(-realSeconds / EXPOSURE_SECONDS);
    const useExposure = this.mode === 'exposure';
    const data = this.image.data;
    const n = this.lowWidth * this.lowHeight;

    for (let i = 0; i < n; i += 1) {
      const o = i * 4;
      if (!this.valid[i]) {
        data[o + 3] = 0;
        continue;
      }
      // Two layers drifting at different speeds: shapes evolve instead of just sliding.
      const bu = this.texU[i] + offsetU;
      const bv = this.texV[i] + offsetV;
      const du = this.detailU[i] + detailOffsetU;
      const dv = this.detailV[i] + detailOffsetV;
      let value = 0.68 * sampleBilinear(noise, mask, bu, bv) + 0.32 * sampleBilinear(noise, mask, du, dv);
      const blur = this.blur[i];
      let t: number;
      if (blur > 0) {
        const soft = 0.68 * sampleBilinear(blurred, mask, bu, bv) + 0.32 * sampleBilinear(blurred, mask, du, dv);
        value += (soft - value) * blur;
        // Blurred noise hugs its mean, which sits below the cover threshold: thresholding it as
        // sharply as near cloud would empty a ring of sky. A wider ramp keeps the average cover.
        const widened = span * (1 + 2.4 * blur);
        t = Math.min(1, Math.max(0, (value - (middle - widened / 2)) / widened));
      } else {
        t = Math.min(1, Math.max(0, (value - low) / span));
      }
      let d = t * t * (3 - 2 * t);
      d += (mean - d) * this.haze[i];
      this.density[i] = d;

      let shown = d;
      if (useExposure) {
        this.exposure[i] = this.exposureFresh ? d : this.exposure[i] + (d - this.exposure[i]) * exposureBlend;
        // Averaging lowers contrast; stretch it back a little so streaks read as streaks.
        shown = Math.min(1, Math.max(0, (this.exposure[i] - 0.06) * 1.25));
      }

      const toSun = this.dirX[i] * sunX + this.dirY[i] * sunY + this.dirZ[i] * sunZ;
      const toMoon = this.dirX[i] * moonX + this.dirY[i] * moonY + this.dirZ[i] * moonZ;
      // Night silhouette → twilight underside (warm towards the Sun) → overcast day grey.
      const half = Math.max(0, (toSun + 1) / 2);
      const warm = half * half * half;
      // Night clouds keep a faint glow (airglow, distant lights) so they read against the black.
      let r = 40;
      let g = 43;
      let b = 54;
      r += (112 + 143 * warm - r) * twilight;
      g += (80 + 64 * warm - g) * twilight;
      b += (122 - 30 * warm - b) * twilight;
      const dayMix = day * (1 - 0.45 * twilight);
      r += (176 - r) * dayMix;
      g += (182 - g) * dayMix;
      b += (194 - b) * dayMix;
      if (sunGlow > 0 && toSun > 0.75) {
        const near = (toSun - 0.75) * 4;
        const lining = sunGlow * near * near * near;
        r += 120 * lining;
        g += 80 * lining;
        b += 40 * lining;
      }
      let alpha = shown * MAX_ALPHA;
      if (moonUp > 0) {
        // Moonlit clouds: a cool silver overall, brighter on the Moon's side of the sky.
        const m = Math.max(0, (toMoon + 1) / 2);
        const moonGlow = moonlight * (0.35 + 0.65 * m * m * m);
        r += 110 * moonGlow;
        g += 118 * moonGlow;
        b += 134 * moonGlow;
        if (toMoon > 0.6) {
          // Forward scattering: cloud within ~30° of the Moon lights up, thin edges most of all
          // (dense cores block more of the light than they scatter toward us).
          const c2 = toMoon * toMoon;
          const c6 = c2 * c2 * c2;
          const c24 = c6 * c6 * c6 * c6;
          const lobe = moonScatter * (0.6 * c6 + 1.1 * c24) * (1.35 - 0.8 * d);
          r += 215 * lobe;
          g += 220 * lobe;
          b += 228 * lobe;
          alpha = Math.min(1, alpha * (1 + 0.8 * lobe));
        }
      }
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = alpha * 255;
    }
    this.exposureFresh = false;
    this.ctx.putImageData(this.image, 0, 0);
    if (this.display && this.displayCtx) {
      const dctx = this.displayCtx;
      dctx.clearRect(0, 0, this.display.width, this.display.height);
      dctx.imageSmoothingEnabled = true;
      dctx.imageSmoothingQuality = 'low';
      dctx.drawImage(this.canvas, 0, 0, this.display.width, this.display.height);
    }
    return true;
  }

  draw(ctx: CanvasRenderingContext2D, width: number, height: number) {
    if (!this.enabled || !this.canvas) {
      return;
    }
    // The cache already has the canvas's backing size: this is a cheap 1:1 copy.
    ctx.drawImage(this.display ?? this.canvas, 0, 0, width, height);
  }

  /** Draw into another render (snapshots) through the projections' affine relation. */
  drawSnapshot(
    ctx: CanvasRenderingContext2D,
    target: SkyProjection,
    source: SkyProjection,
    sourceWidth: number,
    sourceHeight: number
  ) {
    const map = source.affineTo(target);
    if (!this.enabled || !this.canvas || !map) {
      return;
    }
    ctx.save();
    ctx.transform(map.a, map.b, map.c, map.d, map.e, map.f);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.canvas, 0, 0, sourceWidth, sourceHeight);
    ctx.restore();
  }
}
