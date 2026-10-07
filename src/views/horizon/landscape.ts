import { createLayerCanvas } from '../../render/canvas';
import { random } from './noise';
import type { Point } from './projection';

export type LandscapeKind = 'mountains' | 'lake' | 'boat';

/** What lights the scene: Sun and Moon directions (degrees) and the sky's colours (0–255 RGB). */
export type SceneLight = {
  /** How bright the day is, as a Sun altitude: lowered during a solar eclipse. */
  sunAltitude: number;
  /** Where the Sun actually is (for glints, glows and rim light). */
  sunTrueAltitude: number;
  /** Solar eclipse darkness, 0..1. */
  eclipse: number;
  sunAzimuth: number;
  moonAltitude: number;
  moonAzimuth: number;
  /** Moonlight strength, 0..1 (phase × altitude). */
  moonLight: number;
  horizon: number[];
  zenith: number[];
};

export const NIGHT_LIGHT: SceneLight = {
  sunAltitude: -90,
  sunTrueAltitude: -90,
  eclipse: 0,
  sunAzimuth: 0,
  moonAltitude: -90,
  moonAzimuth: 0,
  moonLight: 0,
  horizon: [5, 5, 6],
  zenith: [5, 5, 5],
};

/** The camera frame the landscape is drawn through (a perspective projection). */
export interface SceneFrame {
  readonly width: number;
  readonly height: number;
  /** Focal length in logical pixels. */
  readonly focal: number;
  readonly heading: number;
  readonly tilt: number;
  project(azimuth: number, altitude: number, out: Point): Point;
  /** Azimuth half-width of the frame along the horizon, degrees. */
  halfSpan(): number;
  /** Camera space of a world vector (north, east, up): `x` right, `y` up, `z` depth along the view. */
  toCamera(north: number, east: number, up: number, out: Vec3): Vec3;
  /** Screen point of a camera-space point in front of the camera (z > 0). */
  cameraToScreen(x: number, y: number, z: number, out: Point): Point;
}

export type Vec3 = { x: number; y: number; z: number };

const RES = 10;
/** Eye above the water in the rowboat, metres (the sea surface for waves). */
const EYE_ABOVE_WATER = 0.8;
/** Where a direction behind the camera projects (matches projection.ts's BEHIND_CAMERA). */
const BEHIND = -1e5;
/** Rowboat swell, degrees: a slow and a quick component for roll and for pitch. */
const ROWBOAT_ROLL = [1.8, 0.55];
const ROWBOAT_PITCH = [0.7, 0.25];
const N = 360 * RES;
const DEG = Math.PI / 180;
/** Faint airglow and distant light low in the night sky, so ridges read as silhouettes. */
export const AIRGLOW = [26, 29, 40];

type Tree = { az: number; base: number; height: number; width: number; round: boolean; seed: number };

type LayerSpec = {
  base: number;
  amplitude: number;
  frequencies: number[];
  sharp: number;
  exponent: number;
  /** How far the layer is blended toward the horizon sky (aerial perspective). */
  haze: number;
  /** Ridgelines catch a rim of light when the Sun or Moon is low behind them. */
  rim: number;
  /** Height (degrees) of the grass fringe along the top edge. */
  grass?: number;
  trees?: { perDegree: number; heights: [number, number]; roundShare: number };
  /** Fill down to the horizon (a far shore across water) instead of to the bottom of the frame. */
  shore?: boolean;
};

type Layer = {
  profile: Float32Array;
  haze: number;
  rim: number;
  trees: Tree[];
  shore: boolean;
};

type KindSpec = {
  layers: LayerSpec[];
  /** Layers drawn before the water's reflection (the far shore); the rest stand in front of it. */
  reflectAfter?: number;
  /** Open water from a boat: wavier reflections, a glitter path under the Moon or Sun, a rocking view. */
  sea?: boolean;
};

/**
 * Each landscape is a few ridgelines from far to near: distance shows as haze and smaller
 * features, and the nearest layer carries grass and trees big enough to frame the sky.
 */
const KINDS: Record<LandscapeKind, KindSpec> = {
  mountains: {
    layers: [
      { base: 1, amplitude: 17, frequencies: [2, 3, 5, 8, 13, 21, 34, 55, 89], sharp: 0.8, exponent: 2.1, haze: 0.62, rim: 1 },
      { base: 0.3, amplitude: 8, frequencies: [3, 5, 9, 15, 24, 40, 64], sharp: 0.6, exponent: 1.7, haze: 0.4, rim: 0.7 },
      {
        base: -0.6, amplitude: 3, frequencies: [2, 4, 7, 12, 20], sharp: 0.2, exponent: 1.3, haze: 0.2, rim: 0.3,
        trees: { perDegree: 1.4, heights: [0.5, 1.4], roundShare: 0.05 },
      },
      {
        base: -9, amplitude: 5, frequencies: [1, 2, 3, 5, 8], sharp: 0, exponent: 1.2, haze: 0.04, rim: 0.1, grass: 0.45,
        trees: { perDegree: 0.12, heights: [4, 11], roundShare: 0.1 },
      },
    ],
  },
  lake: {
    layers: [
      { base: 1, amplitude: 14, frequencies: [2, 3, 5, 8, 13, 21, 34, 55], sharp: 0.75, exponent: 2, haze: 0.6, rim: 1, shore: true },
      {
        base: 0.15, amplitude: 2.5, frequencies: [3, 6, 11, 19, 31], sharp: 0.3, exponent: 1.4, haze: 0.36, rim: 0.5, shore: true,
        trees: { perDegree: 1.6, heights: [0.35, 0.9], roundShare: 0.1 },
      },
      {
        base: -12, amplitude: 3.5, frequencies: [1, 2, 4, 7, 11], sharp: 0.1, exponent: 1.3, haze: 0.04, rim: 0.1, grass: 0.4,
        trees: { perDegree: 0.1, heights: [5, 12], roundShare: 0.15 },
      },
    ],
    reflectAfter: 2,
  },
  boat: {
    // Open sea; a few low islands far off break the horizon here and there.
    layers: [{ base: 0.03, amplitude: 1.6, frequencies: [2, 3, 5, 8, 13], sharp: 0.45, exponent: 5, haze: 0.62, rim: 0.6, shore: true }],
    reflectAfter: 1,
    sea: true,
  },
};

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const mix = (a: number[], b: number[], t: number) => a.map((v, i) => v + (b[i] - v) * t);
const rgb = (c: number[], alpha = 1) =>
  alpha >= 1 ? `rgb(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0})` : `rgba(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0}, ${alpha})`;

/** Signed azimuth difference in (−180, 180]. */
export const azimuthDelta = (a: number, b: number) => ((((a - b) % 360) + 540) % 360) - 180;

/**
 * Periodic skyline (degrees of altitude, one sample per 0.1° of azimuth) from summed sines with
 * integer frequencies, so it wraps seamlessly at north. `sharp` mixes in ridged terms
 * (1 − |sin|) that give pointed peaks over rounded valleys; `exponent` > 1 makes peaks rarer.
 */
function ridgeProfile(rand: () => number, spec: LayerSpec) {
  const terms = spec.frequencies.map((k) => ({ k, weight: 1 / k ** 0.85, phase: rand() * Math.PI * 2 }));
  const total = terms.reduce((sum, term) => sum + term.weight, 0);
  const out = new Float32Array(N);
  for (let i = 0; i < N; i += 1) {
    const theta = (i / N) * Math.PI * 2;
    let v = 0;
    for (const term of terms) {
      const s = Math.sin(term.k * theta + term.phase);
      v += term.weight * (spec.sharp * (1 - Math.abs(s)) + (1 - spec.sharp) * (0.5 + 0.5 * s));
    }
    out[i] = spec.base + spec.amplitude * (v / total) ** spec.exponent;
    if (spec.shore) {
      // A far shore never dips below the waterline.
      out[i] = Math.max(0.05, out[i]);
    }
  }
  return out;
}

function sample(profile: Float32Array, azimuth: number) {
  const x = (((azimuth % 360) + 360) % 360) * RES;
  const i = Math.floor(x);
  const t = x - i;
  return profile[i % N] * (1 - t) + profile[(i + 1) % N] * t;
}

/** Trees along a ridge in groves and clearings: exponential spacing thinned by a slow wave. */
function scatterTrees(rand: () => number, profile: Float32Array, spec: NonNullable<LayerSpec['trees']>): Tree[] {
  const grove = [1, 2, 5].map((k) => ({ k, phase: rand() * Math.PI * 2 }));
  const trees: Tree[] = [];
  let az = rand() * 2;
  while (az < 360) {
    const theta = az * DEG;
    const density = grove.reduce((sum, g) => sum + Math.sin(g.k * theta + g.phase), 0) / grove.length;
    if (rand() < smoothstep(-0.35, 0.45, density)) {
      const round = rand() < spec.roundShare;
      const height = spec.heights[0] + (spec.heights[1] - spec.heights[0]) * rand() ** 1.6;
      trees.push({
        az,
        base: sample(profile, az) - height * 0.06,
        height,
        width: height * (round ? 0.6 + 0.2 * rand() : 0.4 + 0.16 * rand()),
        round,
        seed: Math.floor(rand() * 1e9),
      });
    }
    az += -Math.log(1 - rand() * 0.999) / spec.perDegree;
  }
  return trees;
}

/**
 * A procedural landscape in front of the sky, anchored to real azimuths (turning the camera
 * pans across the same hills): ridgelines fading into the distance, trees, a grassy foreground,
 * optionally a lake mirroring the sky, and a few tall trees close to the viewer. Lit from the
 * sky: hazy blue by day, warm-backlit at sunset, silhouettes at night, cool under a bright Moon.
 */
export class Landscape {
  private readonly layers: Layer[];
  private readonly grass: Float32Array;
  private readonly grassHeight: number;
  private readonly reflectAfter: number;
  /** Seen from a boat on open water. */
  readonly sea: boolean;
  /** Which way the boat's bow points (degrees): fixed for the place, so turning pans across it. */
  private readonly boatHeading: number;
  /** Wave crests on the sea around the boat (polar, metres), fixed in the world. */
  private readonly waves: { distance: number; azimuth: number; length: number; alpha: number; rate: number; phase: number }[] = [];
  private readonly skylineProfile: Float32Array;
  private readonly point: Point = { x: 0, y: 0 };
  private readonly point2: Point = { x: 0, y: 0 };
  private mirror: HTMLCanvasElement | null = null;

  constructor(readonly kind: LandscapeKind, seed: number) {
    const rand = random(seed);
    const spec = KINDS[kind] ?? KINDS.mountains;
    this.layers = spec.layers.map((layer) => {
      const profile = ridgeProfile(rand, layer);
      return {
        profile,
        haze: layer.haze,
        rim: layer.rim,
        trees: layer.trees ? scatterTrees(rand, profile, layer.trees) : [],
        shore: layer.shore === true,
      };
    });
    // Grass on the nearest layer: mostly short blades with the odd tall stem.
    const nearest = spec.layers[spec.layers.length - 1];
    this.grassHeight = nearest.grass ?? 0;
    this.grass = new Float32Array(N);
    for (let i = 0; i < N; i += 1) {
      this.grass[i] = rand() ** 2.5;
    }
    if (this.grassHeight > 0) {
      const last = this.layers[this.layers.length - 1];
      for (let i = 0; i < N; i += 1) {
        last.profile[i] += this.grassHeight * this.grass[i];
      }
    }
    this.reflectAfter = spec.reflectAfter ?? -1;
    this.sea = spec.sea === true;
    this.boatHeading = rand() * 360;
    if (this.sea) {
      for (let i = 0; i < 700; i += 1) {
        // Log-spaced in distance (3 m to 1.5 km), so crests thin out evenly toward the horizon.
        const distance = 3 * 500 ** rand();
        this.waves.push({
          distance,
          azimuth: rand() * 360,
          length: distance * (0.03 + 0.05 * rand()),
          alpha: 0.12 + 0.2 * rand(),
          rate: 0.5 + 0.9 * rand(),
          phase: rand() * Math.PI * 2,
        });
      }
    }
    this.skylineProfile = new Float32Array(N);
    for (let i = 0; i < N; i += 1) {
      let top = -90;
      for (const layer of this.layers) {
        top = Math.max(top, layer.profile[i]);
      }
      this.skylineProfile[i] = top;
    }
  }

  /** Altitude of the skyline (ridges, not trees) at an azimuth: where bodies rise and set. */
  skyline(azimuth: number) {
    return sample(this.skylineProfile, azimuth);
  }

  draw(ctx: CanvasRenderingContext2D, frame: SceneFrame, light: SceneLight) {
    const half = frame.halfSpan() + 8;
    const step = Math.max(1 / RES, 1.2 / (frame.focal * DEG));
    const from = frame.heading - half;
    const to = frame.heading + half;
    const night = 1 - smoothstep(-12, -3, light.sunAltitude);
    const haze = mix(light.horizon, AIRGLOW, night * 0.85).map((v, i) => Math.max(v, light.horizon[i]));
    const base = groundColor(light);
    const p = this.point;
    frame.project(frame.heading, 0, p);
    const horizonY = p.y;

    ctx.save();
    for (let index = 0; index < this.layers.length; index += 1) {
      if (index === this.reflectAfter) {
        this.drawReflection(ctx, frame, horizonY, light);
      }
      const layer = this.layers[index];
      const color = mix(base, haze, layer.haze);
      ctx.beginPath();
      this.traceRidge(ctx, frame, layer.profile, from, to, step, layer.shore ? horizonY : frame.height + 4);
      for (const tree of layer.trees) {
        if (Math.abs(azimuthDelta(tree.az, frame.heading)) <= half + tree.width) {
          this.traceTree(ctx, frame, tree);
        }
      }
      // Darker toward the foot of each layer, as ridges recede into shadowed valleys.
      const gradient = ctx.createLinearGradient(0, Math.min(horizonY, frame.height) - frame.focal * 0.06, 0, frame.height);
      gradient.addColorStop(0, rgb(color));
      gradient.addColorStop(1, rgb(mix(color, base, 0.55).map((v) => v * 0.8)));
      ctx.fillStyle = gradient;
      ctx.fill();
      this.drawRim(ctx, frame, light, layer, from, to, step);
    }
    if (this.reflectAfter >= this.layers.length) {
      this.drawReflection(ctx, frame, horizonY, light);
    }

    ctx.restore();
  }

  /**
   * Still water below the far shore: everything drawn so far above the waterline (sky, trails,
   * the far ridges) is mirrored into it in thin strips that sway slightly, then darkened.
   */
  private drawReflection(ctx: CanvasRenderingContext2D, frame: SceneFrame, horizonY: number, light: SceneLight) {
    const canvas = ctx.canvas;
    const m = ctx.getTransform();
    const scale = m.d;
    const shore = Math.round(horizonY * scale + m.f);
    const depth = Math.min(canvas.height - shore, shore);
    if (depth <= 2) {
      return;
    }
    if (!this.mirror || this.mirror.width !== canvas.width || this.mirror.height < depth) {
      this.mirror = createLayerCanvas(canvas.width, depth);
    }
    const mirrorCtx = this.mirror.getContext('2d');
    if (!mirrorCtx) {
      return;
    }
    mirrorCtx.clearRect(0, 0, this.mirror.width, this.mirror.height);
    mirrorCtx.drawImage(canvas, 0, shore - depth, canvas.width, depth, 0, 0, canvas.width, depth);

    ctx.save();
    // Device pixels, flipped about the waterline.
    ctx.setTransform(1, 0, 0, -1, 0, 2 * shore);
    const strip = Math.max(3, Math.round(4.5 * scale));
    const time = performance.now() / 1000;
    // Open sea breaks the mirror up far more than a sheltered lake.
    const [amplitude, growth, frequency, speed] = this.sea ? [1.2, 11, 0.2, 1.7] : [0.4, 3.5, 0.09, 0.8];
    for (let k = 0; k < depth; k += strip) {
      const h = Math.min(strip, depth - k);
      // Ripples grow toward the viewer (further below the waterline).
      const sway = Math.sin(k * frequency / scale + time * speed) * (amplitude + (k / depth) * growth) * scale;
      // Waves also tilt each strip's facet, picking up sky from a little higher or lower.
      const tilt = this.sea ? Math.round(Math.sin(k * 0.37 / scale + time * 2.3) * (k / depth) * 5 * scale) : 0;
      const source = Math.max(0, Math.min(depth - h, depth - k - h + tilt));
      ctx.drawImage(this.mirror, 0, source, canvas.width, h, sway, shore - k - h, canvas.width, h);
    }
    ctx.restore();

    // Water absorbs: darker and a little bluer further from the shore.
    const tint = mix(groundColor(light), this.sea ? [3, 8, 16] : [6, 10, 18], 0.5);
    const reach = depth / scale;
    const water = ctx.createLinearGradient(0, horizonY, 0, horizonY + reach);
    water.addColorStop(0, rgb(tint, this.sea ? 0.5 : 0.35));
    water.addColorStop(1, rgb(tint, this.sea ? 0.92 : 0.75));
    ctx.fillStyle = water;
    ctx.fillRect(0, horizonY, frame.width + 1, reach + 1);
    // Below what the sky above can mirror (horizon high in the frame): plain dark water.
    if (horizonY + reach < frame.height) {
      ctx.fillStyle = rgb(tint);
      ctx.fillRect(0, horizonY + reach, frame.width + 1, frame.height - horizonY - reach + 1);
    }
    if (this.sea) {
      this.drawWaves(ctx, frame, light, time);
      this.drawGlitter(ctx, frame, light);
    }
    // A faint bright line where the far shore meets the water.
    ctx.fillStyle = rgb(mix(light.horizon, [255, 255, 255], 0.1), 0.12);
    ctx.fillRect(0, horizonY, frame.width + 1, 1);
  }

  /**
   * Wave crests catching the sky's light, laid out on the sea surface itself (fixed in the world,
   * running across the wind) and projected through the camera: panning moves across them and
   * perspective packs the distant ones toward the horizon. Each crest swells and fades in place.
   */
  private drawWaves(ctx: CanvasRenderingContext2D, frame: SceneFrame, light: SceneLight, time: number) {
    const crest = mix(mix(light.horizon, AIRGLOW, 0.5), [255, 255, 255], 0.35);
    const half = frame.halfSpan() + 6;
    const wind = (this.boatHeading + 70) * DEG;
    // Crests run across the wind.
    const along = [-Math.sin(wind), Math.cos(wind)];
    const a: Vec3 = { x: 0, y: 0, z: 0 };
    const b: Vec3 = { x: 0, y: 0, z: 0 };
    const p = this.point;
    const q = this.point2;
    ctx.save();
    ctx.strokeStyle = rgb(crest);
    ctx.lineCap = 'round';
    for (const wave of this.waves) {
      if (Math.abs(azimuthDelta(wave.azimuth, frame.heading)) > half) {
        continue;
      }
      const swell = Math.sin(time * wave.rate + wave.phase);
      if (swell <= 0.15) {
        continue;
      }
      const n = wave.distance * Math.cos(wave.azimuth * DEG);
      const e = wave.distance * Math.sin(wave.azimuth * DEG);
      const halfLength = (wave.length / 2) * (0.6 + 0.4 * swell);
      frame.toCamera(n - along[0] * halfLength, e - along[1] * halfLength, -EYE_ABOVE_WATER, a);
      frame.toCamera(n + along[0] * halfLength, e + along[1] * halfLength, -EYE_ABOVE_WATER, b);
      if (a.z < 0.1 || b.z < 0.1) {
        continue;
      }
      frame.cameraToScreen(a.x, a.y, a.z, p);
      frame.cameraToScreen(b.x, b.y, b.z, q);
      ctx.globalAlpha = wave.alpha * (swell - 0.15);
      ctx.lineWidth = Math.max(0.8, Math.min(3, 12 / wave.distance));
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(q.x, q.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * The Moon's (or a low Sun's) road across the water: glints scattered about the specular point
   * in angle (depression below the horizon and azimuth either side of the light), so the road
   * belongs to the sea and sky rather than the screen. Narrow far off, widening toward the boat.
   */
  private drawGlitter(ctx: CanvasRenderingContext2D, frame: SceneFrame, light: SceneLight) {
    const day = smoothstep(-2, 12, light.sunAltitude);
    const sources: [number, number, number, number[]][] = [];
    if (light.moonAltitude > 0 && light.moonLight > 0.03) {
      sources.push([light.moonAzimuth, light.moonAltitude, light.moonLight * (1 - day), [228, 236, 252]]);
    }
    const sunAlt = light.sunTrueAltitude;
    if (sunAlt > -2) {
      // A setting Sun throws the strongest, most golden road of all; an eclipse dims it away.
      const low = 1 - smoothstep(4, 30, sunAlt);
      const eclipsed = (1 - light.eclipse) ** 2;
      sources.push([light.sunAzimuth, sunAlt, smoothstep(-2.5, 0.5, sunAlt) * (0.7 + 0.5 * low) * eclipsed, mix([255, 248, 232], [255, 176, 96], low)]);
    }
    const p = this.point;
    const bucket = Math.floor(performance.now() / 90);
    const half = frame.halfSpan() + 30;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const [azimuth, altitude, strength, color] of sources) {
      if (strength < 0.03 || Math.abs(azimuthDelta(azimuth, frame.heading)) > half) {
        continue;
      }
      const rand = random(bucket * 7919 + Math.round(azimuth));
      const gauss = () => (rand() + rand() + rand() - 1.5) / 1.5;
      const centre = Math.max(0.15, altitude * 0.6);
      const pixelsPerDegree = frame.focal * DEG;
      ctx.fillStyle = rgb(color);
      for (let k = 0; k < 230; k += 1) {
        // Depression below the horizon: around the specular point, with a tail toward the boat.
        const depression = Math.max(0.04, centre + Math.abs(gauss()) * (1.5 + 0.5 * altitude) + rand() ** 5 * 22);
        const spread = gauss() * (0.25 + 0.8 * depression);
        frame.project(azimuth + spread, -depression, p);
        if (p.x === BEHIND) {
          continue;
        }
        const scale = Math.min(1, depression / 12);
        const length = (1.5 + scale * 16 * rand()) * Math.min(1.5, pixelsPerDegree / 15);
        ctx.globalAlpha = Math.min(1, 1.3 * strength * Math.max(0, 1 - Math.abs(spread) / (0.25 + 0.8 * depression) / 1.6) * (0.25 + 0.75 * rand()));
        ctx.fillRect(p.x - length / 2, p.y, length, 1 + scale * 1.6);
      }
    }
    ctx.restore();
  }

  /** A small boat bobs: roll and pitch (degrees) in a quick, irregular swell, or null on land. */
  motion(nowMs: number): { roll: number; pitch: number } | null {
    if (!this.sea) {
      return null;
    }
    const t = nowMs / 1000;
    return {
      roll: ROWBOAT_ROLL[0] * Math.sin((2 * Math.PI * t) / 4.7) + ROWBOAT_ROLL[1] * Math.sin((2 * Math.PI * t) / 2.2 + 1.3),
      pitch: ROWBOAT_PITCH[0] * Math.sin((2 * Math.PI * t) / 3.9 + 0.4) + ROWBOAT_PITCH[1] * Math.sin((2 * Math.PI * t) / 1.8),
    };
  }

  /** The largest roll and pitch `motion` can reach (degrees), so the frame can be cropped to fit. */
  motionRange() {
    return this.sea
      ? { roll: ROWBOAT_ROLL[0] + ROWBOAT_ROLL[1], pitch: ROWBOAT_PITCH[0] + ROWBOAT_PITCH[1] }
      : { roll: 0, pitch: 0 };
  }

  /**
   * The rowboat you are sitting in, as real 3D geometry around the eye: a small wooden boat
   * (about 3.5 m) seen from the middle seat, with its bow on a fixed heading so looking around
   * pans across it. Varnished gunwale, seats, a flat transom, and two oars resting in their
   * oarlocks with the blades trailing on the water. Drawn after the world has been rocked and not
   * rocked itself: you move with the boat, the sea does not.
   */
  drawForeground(ctx: CanvasRenderingContext2D, frame: SceneFrame, light: SceneLight) {
    if (!this.sea) {
      return;
    }
    const day = smoothstep(-4, 12, light.sunAltitude);
    const night = 1 - smoothstep(-12, -3, light.sunAltitude);
    const skyLight = mix(light.horizon, AIRGLOW, night);
    // Wood: warm brown by day, a dark silhouette at night that still picks up sky and moonlight.
    const shade = groundColor(light);
    const wood = mix(mix(shade, [28, 20, 15], 0.5), [96, 66, 42], day * 0.75);
    const inside = wood.map((v) => v * 0.62);
    const cap = mix(wood, skyLight, 0.25);
    const shine = mix(skyLight, [255, 255, 255], 0.35 + 0.2 * light.moonLight);
    const heading = this.boatHeading * DEG;
    const fwd = [Math.cos(heading), Math.sin(heading)];
    const stb = [-Math.sin(heading), Math.cos(heading)];
    // Boat frame: x forward, y to starboard, z up from the gunwale, metres. Eye: on the middle seat.
    const eye = { x: -0.25, z: 0.45 };
    const camera = (x: number, y: number, z: number, out: Vec3) => {
      const bx = x - eye.x;
      const bz = z - eye.z;
      return frame.toCamera(bx * fwd[0] + y * stb[0], bx * fwd[1] + y * stb[1], bz, out);
    };
    const near = 0.03;
    const a: Vec3 = { x: 0, y: 0, z: 0 };
    const b: Vec3 = { x: 0, y: 0, z: 0 };
    const p = this.point;

    /** Straight edges stay straight in this projection: clip to the near plane, project the ends. */
    const segment = (from: number[], to: number[]) => {
      camera(from[0], from[1], from[2], a);
      camera(to[0], to[1], to[2], b);
      if (a.z < near && b.z < near) {
        return;
      }
      if (a.z < near || b.z < near) {
        const t = (near - a.z) / (b.z - a.z);
        const cx = a.x + (b.x - a.x) * t;
        const cy = a.y + (b.y - a.y) * t;
        if (a.z < near) {
          a.x = cx;
          a.y = cy;
          a.z = near;
        } else {
          b.x = cx;
          b.y = cy;
          b.z = near;
        }
      }
      frame.cameraToScreen(a.x, a.y, a.z, p);
      ctx.moveTo(p.x, p.y);
      frame.cameraToScreen(b.x, b.y, b.z, p);
      ctx.lineTo(p.x, p.y);
    };
    /** A face, clipped against the near plane (Sutherland–Hodgman) before projecting. */
    const polygon = (points: number[][]) => {
      const cam = points.map(([x, y, z]) => camera(x, y, z, { x: 0, y: 0, z: 0 }));
      const clipped: Vec3[] = [];
      for (let i = 0; i < cam.length; i += 1) {
        const current = cam[i];
        const next = cam[(i + 1) % cam.length];
        if (current.z >= near) {
          clipped.push(current);
        }
        if ((current.z >= near) !== (next.z >= near)) {
          const t = (near - current.z) / (next.z - current.z);
          clipped.push({ x: current.x + (next.x - current.x) * t, y: current.y + (next.y - current.y) * t, z: near });
        }
      }
      if (clipped.length < 3) {
        return;
      }
      clipped.forEach((point, i) => {
        frame.cameraToScreen(point.x, point.y, point.z, p);
        if (i === 0) {
          ctx.moveTo(p.x, p.y);
        } else {
          ctx.lineTo(p.x, p.y);
        }
      });
      ctx.closePath();
    };
    /**
     * A round spar from `from` to `to` as two crossed ribbons (one flat, one upright): real
     * geometry, so it tapers with distance and keeps its thickness from any viewing angle.
     */
    const rod = (from: number[], to: number[], radius: number, fill: string) => {
      const d = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
      const length = Math.hypot(d[0], d[1], d[2]) || 1;
      const u = d.map((v) => v / length);
      let h = [u[1], -u[0], 0];
      const hl = Math.hypot(h[0], h[1]);
      h = hl < 1e-3 ? [1, 0, 0] : [h[0] / hl, h[1] / hl, 0];
      const v = [u[1] * h[2] - u[2] * h[1], u[2] * h[0] - u[0] * h[2], u[0] * h[1] - u[1] * h[0]];
      // Each ribbon is filled on its own: crossing paths of opposite winding would cancel.
      ctx.fillStyle = fill;
      for (const side of [h, v]) {
        const o = side.map((c) => c * radius);
        ctx.beginPath();
        polygon([
          [from[0] + o[0], from[1] + o[1], from[2] + o[2]],
          [to[0] + o[0], to[1] + o[1], to[2] + o[2]],
          [to[0] - o[0], to[1] - o[1], to[2] - o[2]],
          [from[0] - o[0], from[1] - o[1], from[2] - o[2]],
        ]);
        ctx.fill();
      }
    };

    // Hull plan: a pointed bow, widest just aft of the middle, a flat transom. The sheer (top
    // edge) rises toward the bow.
    const bow = 1.75;
    const stern = -1.75;
    const halfBeam = (x: number) =>
      x >= -0.2 ? 0.7 * Math.max(0, 1 - ((x + 0.2) / (bow + 0.2)) ** 2) ** 0.75 : 0.7 - 0.2 * ((x + 0.2) / (stern + 0.2)) ** 2;
    const sheer = (x: number) => 0.16 * Math.max(0, x / bow) ** 2 + 0.05 * Math.max(0, x / stern) ** 2;
    const rim: number[][] = [];
    for (let x = stern; x <= bow + 1e-9; x += 0.1) {
      rim.push([x, halfBeam(x), sheer(x)]);
    }
    for (let x = bow; x >= stern - 1e-9; x -= 0.1) {
      rim.push([x, -halfBeam(x), sheer(x)]);
    }

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // The inside of the hull, seen over and within the gunwale.
    ctx.beginPath();
    polygon(rim);
    ctx.fillStyle = rgb(inside);
    ctx.fill();
    // Ribs: curved frames down the inside of the hull, every 35 cm.
    ctx.beginPath();
    for (let x = stern + 0.3; x < bow - 0.3; x += 0.35) {
      for (const side of [1, -1]) {
        const w = halfBeam(x);
        const z0 = sheer(x);
        segment([x, side * w, z0], [x, side * w * 0.8, z0 - 0.3]);
        segment([x, side * w * 0.8, z0 - 0.3], [x, side * w * 0.35, z0 - 0.5]);
      }
    }
    ctx.strokeStyle = rgb(wood.map((v) => v * 0.8), 0.6);
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // Seats (thwarts) across the boat, and the transom at the stern.
    const seat = (x: number) => {
      const w = halfBeam(x) * 0.86;
      const z = sheer(x) - 0.2;
      polygon([[x - 0.12, -w, z], [x - 0.12, w, z], [x + 0.12, w, z], [x + 0.12, -w, z]]);
    };
    ctx.beginPath();
    seat(1.0);
    seat(-0.25);
    seat(-1.35);
    ctx.fillStyle = rgb(wood);
    ctx.fill();
    ctx.beginPath();
    polygon([[stern, -halfBeam(stern), sheer(stern)], [stern, halfBeam(stern), sheer(stern)], [stern, halfBeam(stern) * 0.6, -0.4], [stern, -halfBeam(stern) * 0.6, -0.4]]);
    ctx.fillStyle = rgb(wood.map((v) => v * 0.85));
    ctx.fill();

    // Varnished gunwale all round: a 6 cm cap rail (a band of real width on top of the sheer),
    // with light along its outer edge.
    const inner = (point: number[]) => {
      const w = Math.abs(point[1]);
      const k = w > 0.08 ? (w - 0.06) / w : 0;
      return [point[0], point[1] * k, point[2] - 0.012];
    };
    ctx.beginPath();
    for (let i = 0; i + 1 < rim.length; i += 1) {
      polygon([rim[i], rim[i + 1], inner(rim[i + 1]), inner(rim[i])]);
    }
    ctx.fillStyle = rgb(cap);
    ctx.fill();
    ctx.beginPath();
    for (let i = 0; i + 1 < rim.length; i += 1) {
      segment(rim[i], rim[i + 1]);
    }
    ctx.strokeStyle = rgb(shine, 0.35);
    ctx.lineWidth = 1.2;
    ctx.stroke();
    // The stem post at the bow.
    rod([bow, 0, sheer(bow) - 0.05], [bow + 0.05, 0, sheer(bow) + 0.12], 0.035, rgb(cap));

    // Oars resting in their oarlocks, blades trailing aft on the water.
    for (const side of [1, -1]) {
      const lock = [-0.25, side * halfBeam(-0.25), sheer(-0.25) + 0.03];
      // The shaft runs through the lock: inboard to the handle, outboard and aft to the water.
      const out = [-0.42, side * 0.9, -0.17];
      const outLength = Math.hypot(out[0], out[1], out[2]);
      const dir = out.map((v) => v / outLength);
      const handle = lock.map((v, i) => v - dir[i] * 0.6);
      const tip = lock.map((v, i) => v + dir[i] * 2.0);
      const dx = tip[0] - lock[0];
      const dy = tip[1] - lock[1];
      const dz = tip[2] - lock[2];
      const length = Math.hypot(dx, dy, dz);
      const blade = [lock[0] + (dx * (length - 0.55)) / length, lock[1] + (dy * (length - 0.55)) / length, lock[2] + (dz * (length - 0.55)) / length];
      rod(handle, blade, 0.022, rgb(mix(wood, cap, 0.5)));
      // Blade: widening flat paddle, lying almost flat on the water.
      const px = -dy / Math.hypot(dx, dy);
      const py = dx / Math.hypot(dx, dy);
      ctx.beginPath();
      polygon([
        [blade[0] + px * 0.035, blade[1] + py * 0.035, blade[2]],
        [tip[0] + px * 0.08, tip[1] + py * 0.08, tip[2]],
        [tip[0] - px * 0.08, tip[1] - py * 0.08, tip[2]],
        [blade[0] - px * 0.035, blade[1] - py * 0.035, blade[2]],
      ]);
      ctx.fillStyle = rgb(mix(wood, cap, 0.5));
      ctx.fill();
      // Oarlock: a little bronze crutch on the gunwale, its horns either side of the shaft.
      const bronze = rgb(mix(mix(wood, [120, 90, 50], 0.4), shine, 0.08));
      rod([lock[0] - 0.03, lock[1], lock[2] - 0.035], [lock[0] - 0.03, lock[1], lock[2] + 0.03], 0.005, bronze);
      rod([lock[0] + 0.03, lock[1], lock[2] - 0.035], [lock[0] + 0.03, lock[1], lock[2] + 0.03], 0.005, bronze);
    }
    ctx.restore();
  }

  private traceRidge(
    ctx: CanvasRenderingContext2D,
    frame: SceneFrame,
    profile: Float32Array,
    from: number,
    to: number,
    step: number,
    floorY: number | null
  ) {
    const p = this.point;
    let firstX = 0;
    let lastX = 0;
    for (let az = from, first = true; az <= to + 1e-9; az += step, first = false) {
      frame.project(az, sample(profile, az), p);
      if (first) {
        ctx.moveTo(p.x, p.y);
        firstX = p.x;
      } else {
        ctx.lineTo(p.x, p.y);
      }
      lastX = p.x;
    }
    if (floorY !== null) {
      ctx.lineTo(lastX, floorY);
      ctx.lineTo(firstX, floorY);
      ctx.closePath();
    }
  }

  /**
   * A tree as a sub-path, drawn along its projected vertical axis (a straight line in this
   * projection, so tall trees lean in like converging verticals in a tilted photo).
   */
  private traceTree(ctx: CanvasRenderingContext2D, frame: SceneFrame, tree: Tree) {
    const b = frame.project(tree.az, tree.base, this.point);
    const bx = b.x;
    const by = b.y;
    const t = frame.project(tree.az, tree.base + tree.height, this.point2);
    const ax = t.x - bx;
    const ay = t.y - by;
    const length = Math.hypot(ax, ay);
    if (!(length > 0.8) || length > frame.height * 20) {
      return;
    }
    const ux = ax / length;
    const uy = ay / length;
    // Perpendicular, pointing right on screen; half-width in pixels.
    const vx = -uy;
    const vy = ux;
    const halfWidth = (length * tree.width) / tree.height / 2;
    const at = (x: number, y: number, move = false) => {
      const px = bx + ux * y * length + vx * x * halfWidth;
      const py = by + uy * y * length + vy * x * halfWidth;
      if (move) {
        ctx.moveTo(px, py);
      } else {
        ctx.lineTo(px, py);
      }
    };
    const rand = random(tree.seed);

    if (tree.round) {
      // Broadleaf: a short trunk under a crown.
      at(-0.07, 0, true);
      at(-0.05, 0.45);
      at(0.05, 0.45);
      at(0.07, 0);
      ctx.closePath();
      // Crown: one lumpy outline (a few overlapping bulges plus fine leafy jitter), traced
      // clockwise like every other shape here so overlaps never cancel under the nonzero fill.
      const points = Math.max(24, Math.min(120, Math.round(length / 2)));
      const bulges = [2 + Math.floor(rand() * 2), 5 + Math.floor(rand() * 3)].map((k) => ({ k, phase: rand() * Math.PI * 2 }));
      for (let i = 0; i <= points; i += 1) {
        const theta = Math.PI * 2 * (1 - i / points);
        const lump =
          1 + 0.16 * Math.sin(bulges[0].k * theta + bulges[0].phase) + 0.1 * Math.sin(bulges[1].k * theta + bulges[1].phase) + 0.18 * (rand() - 0.5);
        at(Math.cos(theta) * lump * 0.85, 0.66 + Math.sin(theta) * lump * 0.3, i === 0);
      }
      ctx.closePath();
      return;
    }

    // Conifer: many soft tiers of drooping branches, narrowing to a spire. The tier count grows
    // with on-screen size so near trees look feathery rather than jagged.
    const tiers = Math.max(6, Math.min(70, Math.round(length / 5)));
    const trunk = 0.06;
    const rise = (1 - trunk) / tiers;
    const left: [number, number][] = [];
    const right: [number, number][] = [];
    for (let j = 0; j < tiers; j += 1) {
      const t0 = j / tiers;
      const y = trunk + (1 - trunk) * t0;
      const envelope = (1 - t0) ** 0.9;
      for (const side of [left, right]) {
        const gap = rand() < 0.07 ? 0.5 : 1;
        const reach = envelope * (0.82 + 0.36 * rand()) * gap;
        // Tip droops below where the branch leaves the trunk; the inner point keeps it full.
        side.push([reach, y - rise * 0.35], [reach * (0.55 + 0.2 * rand()), y + rise * 0.5]);
      }
    }
    at(-0.05, -0.02, true);
    at(-0.05, trunk);
    for (const [x, y] of left) {
      at(-x, y);
    }
    at(0, 1);
    for (let i = right.length - 1; i >= 0; i -= 1) {
      at(right[i][0], right[i][1]);
    }
    at(0.05, trunk);
    at(0.05, -0.02);
    ctx.closePath();
  }

  /**
   * Backlighting: a thin bright edge along a ridgeline when the Sun (warm) or a bright Moon
   * (silver) is low behind it, strongest near the light's azimuth.
   */
  private drawRim(
    ctx: CanvasRenderingContext2D,
    frame: SceneFrame,
    light: SceneLight,
    layer: Layer,
    from: number,
    to: number,
    step: number
  ) {
    const sources: [number, number, number[]][] = [];
    const sunRim = smoothstep(-7, -0.5, light.sunTrueAltitude) * (1 - smoothstep(6, 22, light.sunTrueAltitude)) * (1 - light.eclipse);
    if (sunRim > 0.02) {
      sources.push([light.sunAzimuth, sunRim, [255, 196, 130]]);
    }
    const moonRim = light.moonLight * (1 - smoothstep(-6, 2, light.sunAltitude)) * (1 - smoothstep(12, 35, light.moonAltitude));
    if (moonRim > 0.02 && light.moonAltitude > -3) {
      sources.push([light.moonAzimuth, moonRim * 0.8, [205, 218, 240]]);
    }
    const p = this.point;
    for (const [azimuth, strength, color] of sources) {
      const delta = azimuthDelta(azimuth, frame.heading);
      if (Math.abs(delta) > 120) {
        continue;
      }
      const alpha = strength * layer.rim;
      if (alpha < 0.02) {
        continue;
      }
      // Horizontal gradient centred on the light (clamped in front of the camera if it is to one side).
      frame.project(frame.heading + Math.max(-80, Math.min(80, delta)), 0, p);
      const spread = frame.focal * Math.tan(32 * DEG);
      const gradient = ctx.createLinearGradient(p.x - spread, 0, p.x + spread, 0);
      gradient.addColorStop(0, rgb(color, 0));
      gradient.addColorStop(0.5, rgb(color, Math.min(1, alpha * 0.9)));
      gradient.addColorStop(1, rgb(color, 0));
      ctx.beginPath();
      this.traceRidge(ctx, frame, layer.profile, from, to, step, null);
      ctx.strokeStyle = gradient;
      ctx.lineJoin = 'round';
      ctx.lineWidth = 3.5;
      ctx.globalAlpha = 0.25;
      ctx.stroke();
      ctx.lineWidth = 1.2;
      ctx.globalAlpha = 1;
      ctx.stroke();
    }
  }
}

/**
 * Colour of unhazed ground under the current light: near black on a moonless night, cool and
 * faintly visible under a bright Moon, dim violet-grey at twilight, muted green-grey by day.
 */
function groundColor(light: SceneLight) {
  const day = smoothstep(-3, 14, light.sunAltitude);
  const twilight = smoothstep(-14, -2, light.sunAltitude) * (1 - day);
  let color = [3, 3, 5];
  color = mix(color, [17, 17, 24], twilight * 0.7);
  color = mix(color, [24, 31, 28], day);
  const moon = light.moonLight * (1 - day) * (1 - twilight * 0.5);
  return color.map((v, i) => v + moon * [8, 11, 17][i]);
}
