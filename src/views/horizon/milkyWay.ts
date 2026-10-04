import { localSiderealRadians } from '../../core/stars';
import { makeNoise, NOISE_SIZE, sampleBilinear } from './noise';
import type { SkyProjection } from './projection';
import { SkyRaster } from './skyRaster';

const DEG = Math.PI / 180;
/** IAU rotation from J2000 equatorial to galactic coordinates (row-major). */
const T = [
  -0.0548755604, -0.873437090, -0.4838350155,
  0.4941094279, -0.4448296300, 0.7469822445,
  -0.8676661490, -0.1980763734, 0.4559837762,
];
/** Galaxy map in (longitude, latitude): 0.5° per texel, latitudes ±45°. */
const MAP_W = 720;
const MAP_H = 180;
const MAP_LAT = 45;
const REPAINT_INTERVAL_MS = 48;
/** Sky rotation (radians, ≈0.4°) worth a repaint: a fraction of a low-res pixel on the soft band. */
const MIN_TURN = 0.007;
const MAX_ALPHA = 0.42;

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Brightness of the Milky Way by galactic longitude/latitude: a thin bright disk with a softer
 * halo, the bulge toward Sagittarius, the Cygnus star cloud, mottled star clouds and the dark
 * Great Rift dust lane. Built once; looked up per pixel.
 */
function buildGalaxyMap(seed: number) {
  const noise = makeNoise(seed);
  const brightness = new Float32Array(MAP_W * MAP_H);
  const warmth = new Float32Array(MAP_W * MAP_H);
  const mask = NOISE_SIZE - 1;
  for (let y = 0; y < MAP_H; y += 1) {
    const b = MAP_LAT - (y + 0.5) * (2 * MAP_LAT / MAP_H);
    for (let x = 0; x < MAP_W; x += 1) {
      let l = (x + 0.5) * (360 / MAP_W);
      if (l > 180) l -= 360;
      // Noise in galactic coordinates (wraps around in longitude).
      const u = (x / MAP_W) * NOISE_SIZE * 3;
      const v = (y / MAP_H) * NOISE_SIZE * 0.75;
      const mottle = 0.5 + 1.0 * sampleBilinear(noise, mask, u, v);
      const fine = sampleBilinear(noise, mask, u * 3.1 + 91, v * 3.1 + 37);
      // Bright thin disk inside a broad soft band (the visible river is ~20–30° wide).
      const core = Math.exp(-((b / 6) ** 2));
      const disk = 0.6 * Math.exp(-((b / 15) ** 2));
      const along = 0.32 + 0.68 * Math.exp(-((l / 60) ** 2)) + 0.22 * Math.exp(-(((l - 78) / 24) ** 2));
      const bulge = 0.8 * Math.exp(-((l / 14) ** 2) - (b / 9) ** 2) * (0.55 + 0.45 * mottle);
      const riftWindow = smoothstep(-45, -30, l) * (1 - smoothstep(60, 75, l));
      const rift = Math.exp(-(((b - 1.8) / 3.2) ** 2)) * riftWindow * (0.5 + 0.5 * fine);
      // Dust absorbs everything behind it, bulge included, so the lanes stay visible in the core.
      const value = ((core + disk) * along * mottle + bulge) * (1 - 0.75 * rift);
      // Soft shoulder rather than a clamp: the bulge keeps its structure instead of saturating
      // into a flat cap (most visible when the panorama stretches it across the zenith).
      brightness[y * MAP_W + x] = 1 - Math.exp(-1.25 * value);
      warmth[y * MAP_W + x] = Math.exp(-((l / 40) ** 2));
    }
  }
  return { brightness, warmth };
}

let sharedMap: ReturnType<typeof buildGalaxyMap> | null = null;

/**
 * The Milky Way band, placed by real galactic coordinates and turning with the sky. Each repaint
 * rotates every pixel's direction by local sidereal time into equatorial and then galactic
 * coordinates and samples the galaxy map; atmospheric extinction dims it toward the horizon.
 */
export class MilkyWayLayer {
  private readonly raster = new SkyRaster(14000);
  /** Per pixel: direction in hour-angle form (cos δ cos H, cos δ sin H, sin δ) and extinction. */
  private hA = new Float32Array(0);
  private hB = new Float32Array(0);
  private hC = new Float32Array(0);
  private extinction = new Float32Array(0);
  private sinceRepaintMs = Infinity;
  private dirty = true;
  private paintedLst = 0;
  private shownVisibility = 0;
  private readonly map: ReturnType<typeof buildGalaxyMap>;

  constructor(
    private enabled: boolean,
    private readonly latitude: number,
    private readonly longitude: number
  ) {
    sharedMap ??= buildGalaxyMap(20251);
    this.map = sharedMap;
  }

  setEnabled(enabled: boolean) {
    if (enabled !== this.enabled) {
      this.dirty = true;
    }
    this.enabled = enabled;
  }

  resize(projection: SkyProjection, width: number, height: number, pixelRatio: number) {
    const raster = this.raster;
    raster.resize(projection, width, height, pixelRatio);
    const n = raster.size;
    this.hA = new Float32Array(n);
    this.hB = new Float32Array(n);
    this.hC = new Float32Array(n);
    this.extinction = new Float32Array(n);
    const sinLat = Math.sin(this.latitude * DEG);
    const cosLat = Math.cos(this.latitude * DEG);
    for (let i = 0; i < n; i += 1) {
      if (!raster.valid[i]) {
        continue;
      }
      const alt = raster.altitude[i] * DEG;
      const az = raster.azimuth[i] * DEG;
      const north = Math.cos(alt) * Math.cos(az);
      const east = Math.cos(alt) * Math.sin(az);
      const up = Math.sin(alt);
      this.hA[i] = cosLat * up - sinLat * north;
      this.hB[i] = -east;
      this.hC[i] = sinLat * up + cosLat * north;
      this.extinction[i] = smoothstep(-2, 22, raster.altitude[i]);
    }
    this.dirty = true;
  }

  /**
   * Repaint for the sky at `absoluteTimeMs`; `visibility` (0..1) covers twilight and moonlight.
   * The band only moves as the sky turns, so slow playback repaints rarely; `allowRepaint` lets
   * the view keep this from landing in the same frame as a cloud repaint.
   */
  update(realDeltaMs: number, absoluteTimeMs: number, visibility: number, force = false, allowRepaint = true) {
    this.shownVisibility = visibility;
    if (!this.enabled || visibility < 0.02 || !this.raster.image) {
      return;
    }
    this.sinceRepaintMs += Math.max(0, realDeltaMs);
    const lst = localSiderealRadians(absoluteTimeMs, this.longitude);
    if (!this.dirty) {
      let turn = Math.abs(lst - this.paintedLst) % (2 * Math.PI);
      turn = Math.min(turn, 2 * Math.PI - turn);
      if (turn < MIN_TURN && !force) {
        return;
      }
      if (!force && (!allowRepaint || this.sinceRepaintMs < REPAINT_INTERVAL_MS)) {
        return;
      }
    }
    this.dirty = false;
    this.paintedLst = lst;
    this.sinceRepaintMs = 0;
    const c = Math.cos(lst);
    const s = Math.sin(lst);
    const { brightness, warmth } = this.map;
    const data = this.raster.image.data;
    const n = this.raster.size;
    for (let i = 0; i < n; i += 1) {
      const o = i * 4;
      if (!this.raster.valid[i]) {
        data[o + 3] = 0;
        continue;
      }
      // Hour angle → right ascension (α = LST − H), then into galactic coordinates.
      const ex = this.hA[i] * c + this.hB[i] * s;
      const ey = this.hA[i] * s - this.hB[i] * c;
      const ez = this.hC[i];
      const gx = T[0] * ex + T[1] * ey + T[2] * ez;
      const gy = T[3] * ex + T[4] * ey + T[5] * ez;
      const gz = T[6] * ex + T[7] * ey + T[8] * ez;
      const b = Math.asin(Math.max(-1, Math.min(1, gz))) / DEG;
      if (b <= -MAP_LAT || b >= MAP_LAT) {
        data[o + 3] = 0;
        continue;
      }
      let l = Math.atan2(gy, gx) / DEG;
      if (l < 0) l += 360;
      const mx = Math.min(MAP_W - 1, Math.floor(l * (MAP_W / 360)));
      const my = Math.min(MAP_H - 1, Math.floor((MAP_LAT - b) * (MAP_H / (2 * MAP_LAT))));
      const k = my * MAP_W + mx;
      const glow = brightness[k] * this.extinction[i];
      const warm = warmth[k];
      data[o] = 168 + 58 * warm;
      data[o + 1] = 182 + 34 * warm;
      data[o + 2] = 214 - 18 * warm;
      data[o + 3] = glow * MAX_ALPHA * 255;
    }
    this.raster.commit();
  }

  draw(ctx: CanvasRenderingContext2D, width: number, height: number) {
    if (!this.enabled || this.shownVisibility < 0.02) {
      return;
    }
    ctx.save();
    ctx.globalAlpha = Math.min(1, this.shownVisibility);
    this.raster.draw(ctx, width, height);
    ctx.restore();
  }

  drawSnapshot(
    ctx: CanvasRenderingContext2D,
    target: SkyProjection,
    source: SkyProjection,
    sourceWidth: number,
    sourceHeight: number
  ) {
    if (!this.enabled || this.shownVisibility < 0.02) {
      return;
    }
    ctx.save();
    ctx.globalAlpha = Math.min(1, this.shownVisibility);
    this.raster.drawSnapshot(ctx, target, source, sourceWidth, sourceHeight);
    ctx.restore();
  }
}
