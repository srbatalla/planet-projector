import { BEHIND_CAMERA, type Point, type SkyProjection } from './projection';

/**
 * Growable polyline in horizontal coordinates. Trails are kept as vectors rather than
 * full-screen bitmaps so memory stays tiny, resizes re-project crisply, and the active
 * sweep fade is computed per segment instead of with a full-screen destination-out pass.
 */
const MAX_SIMPLIFIED_SPAN_DEG = 4;

export class TrailPath {
  az: Float32Array;
  alt: Float32Array;
  /** Simulation time (ms since view start) at which each point was reached. */
  time: Float64Array;
  /** 1 when the point starts a new sub-path (no segment from the previous point). */
  breaks: Uint8Array;
  length = 0;

  constructor(capacity = 128) {
    this.az = new Float32Array(capacity);
    this.alt = new Float32Array(capacity);
    this.time = new Float64Array(capacity);
    this.breaks = new Uint8Array(capacity);
  }

  get lastTime() {
    return this.length > 0 ? this.time[this.length - 1] : Number.NaN;
  }

  push(azimuth: number, altitude: number, timeMs: number, breakBefore: boolean) {
    if (this.length === this.az.length) {
      this.grow(this.az.length * 2);
    }
    const i = this.length;
    this.az[i] = azimuth;
    this.alt[i] = altitude;
    this.time[i] = timeMs;
    this.breaks[i] = breakBefore || i === 0 ? 1 : 0;
    this.length += 1;
  }

  clear() {
    this.length = 0;
  }

  /**
   * Right-sized copy for the history list, simplified with Ramer–Douglas–Peucker in
   * azimuth/altitude space. Stroke cost scales with vertex count, and smooth arcs sampled
   * every few minutes carry many near-collinear points.
   */
  simplifiedCopy(toleranceDeg: number): TrailPath {
    const keep = new Uint8Array(this.length);
    // Unwrapped azimuth so sub-paths crossing north measure true distances.
    const unwrapped = new Float64Array(this.length);
    let start = 0;
    for (let i = 0; i <= this.length; i += 1) {
      if (i === this.length || (i > start && this.breaks[i] === 1)) {
        this.markSimplified(start, i - 1, unwrapped, keep, toleranceDeg);
        start = i;
      }
      if (i < this.length) {
        if (i === start) {
          unwrapped[i] = this.az[i];
        } else {
          let delta = this.az[i] - this.az[i - 1];
          if (delta > 180) delta -= 360;
          else if (delta < -180) delta += 360;
          unwrapped[i] = unwrapped[i - 1] + delta;
        }
      }
    }

    let count = 0;
    for (let i = 0; i < this.length; i += 1) {
      count += keep[i];
    }
    const copy = new TrailPath(Math.max(1, count));
    for (let i = 0; i < this.length; i += 1) {
      if (keep[i]) {
        copy.push(this.az[i], this.alt[i], this.time[i], this.breaks[i] === 1);
      }
    }
    return copy;
  }

  private markSimplified(first: number, last: number, x: Float64Array, keep: Uint8Array, tolerance: number) {
    if (last < first) {
      return;
    }
    keep[first] = 1;
    keep[last] = 1;
    const y = this.alt;
    const stack = [first, last];
    while (stack.length > 0) {
      const b = stack.pop() as number;
      const a = stack.pop() as number;
      const dx = x[b] - x[a];
      const dy = y[b] - y[a];
      const length = Math.hypot(dx, dy) || 1e-9;
      let worst = -1;
      let worstDistance = tolerance;
      for (let i = a + 1; i < b; i += 1) {
        const distance = Math.abs(dy * (x[i] - x[a]) - dx * (y[i] - y[a])) / length;
        if (distance > worstDistance) {
          worstDistance = distance;
          worst = i;
        }
      }
      // A chord that is straight in az/alt is an arc in the dome projection, so long spans are
      // split regardless: ≤ MAX_SIMPLIFIED_SPAN_DEG keeps the on-screen error under ~0.2px.
      if (worst < 0 && b - a > 1 && length > MAX_SIMPLIFIED_SPAN_DEG) {
        worst = (a + b) >> 1;
      }
      if (worst >= 0) {
        keep[worst] = 1;
        stack.push(a, worst, worst, b);
      }
    }
  }

  private grow(capacity: number) {
    const az = new Float32Array(capacity);
    const alt = new Float32Array(capacity);
    const time = new Float64Array(capacity);
    const breaks = new Uint8Array(capacity);
    az.set(this.az);
    alt.set(this.alt);
    time.set(this.time);
    breaks.set(this.breaks);
    this.az = az;
    this.alt = alt;
    this.time = time;
    this.breaks = breaks;
  }
}

export type TrailStyle = 'line' | 'glow';

export type StrokeOptions = {
  color: string;
  lineWidth: number;
  /** Overall layer opacity (history age). */
  alpha: number;
  /** Exponential fade per simulated second applied by point age; 0 disables. */
  fadeRate: number;
  /** Simulation time the fade is measured against. */
  referenceMs: number;
  style: TrailStyle;
  /** The fade is quantised into this many alpha bands: one stroke call per band. */
  bands: number;
  /**
   * Brightness a point settles to once its fresh glow has decayed:
   * alpha = base · (floor + (1 − floor) · e^(−fadeRate · age)).
   */
  fadeFloor?: number;
  /**
   * Draw only the decaying glow, on top of the same trail already drawn at `alpha · floor`
   * (source-over), so the two layers together equal the full formula.
   */
  glowOnly?: boolean;
};

const MIN_VISIBLE_ALPHA = 0.01;
const scratch: Point = { x: 0, y: 0 };

export function strokeTrail(
  ctx: CanvasRenderingContext2D,
  projection: SkyProjection,
  path: TrailPath,
  options: StrokeOptions
) {
  if (path.length < 2 || options.alpha < MIN_VISIBLE_ALPHA) {
    return;
  }
  ctx.strokeStyle = options.color;
  ctx.lineJoin = 'round';
  // Butt caps throughout: the trail is stroked as several alpha bands, and round caps would
  // overlap at every band boundary, leaving bright beads (very visible on the wide glow pass).
  ctx.lineCap = 'butt';
  if (options.style === 'glow') {
    strokePass(ctx, projection, path, options, options.lineWidth * 3.5, 0.18);
  }
  strokePass(ctx, projection, path, options, options.lineWidth, 1);
}

function strokePass(
  ctx: CanvasRenderingContext2D,
  projection: SkyProjection,
  path: TrailPath,
  options: StrokeOptions,
  lineWidth: number,
  passAlpha: number
) {
  const { az, alt, time, breaks } = path;
  const { fadeRate, referenceMs, bands } = options;
  const floor = Math.min(1, Math.max(0, options.fadeFloor ?? 0));
  const glowOnly = options.glowOnly === true;
  // Source-over: base b then glow g gives b + g(1 − b), so the glow alpha is scaled to match.
  const glowScale = (1 - floor) / Math.max(1e-3, 1 - options.alpha * floor);
  const baseAlpha = options.alpha * passAlpha;
  const wraps = projection.wrapsAzimuth;
  ctx.lineWidth = lineWidth;

  let band = -1;
  let open = false;
  let prevX = 0;
  let prevY = 0;
  let prevAz = 0;
  let prevAlt = 0;
  let havePrev = false;
  let prevFront = true;

  for (let i = 0; i < path.length; i += 1) {
    projection.project(az[i], alt[i], scratch);
    const x = scratch.x;
    const y = scratch.y;
    // A camera view cannot draw toward a point behind it: the line would cut across the frame.
    const front = x !== BEHIND_CAMERA;
    const isBreak = breaks[i] === 1 || !havePrev || !front || !prevFront;

    if (!isBreak) {
      // Age is time distance, so a rewinding trail fades behind the body just the same.
      const fade = fadeRate > 0 ? Math.exp((-fadeRate * Math.abs(referenceMs - time[i])) / 1000) : 1;
      const segmentBand = fade >= 1 ? bands : Math.floor(fade * bands);
      const glow = fade >= 1 ? 1 : (segmentBand + 0.5) / bands;
      const segmentAlpha = glowOnly
        ? baseAlpha * glow * glowScale
        : baseAlpha * (floor + (1 - floor) * glow);

      if (segmentAlpha < MIN_VISIBLE_ALPHA) {
        if (open) {
          ctx.stroke();
          open = false;
        }
      } else {
        if (segmentBand !== band || !open) {
          if (open) {
            ctx.stroke();
          }
          band = segmentBand;
          ctx.globalAlpha = segmentAlpha;
          ctx.beginPath();
          ctx.moveTo(prevX, prevY);
          open = true;
        }
        // Raw deltas past the threshold cover both fast swings and wraps past north.
        if (wraps && Math.abs(az[i] - prevAz) > WIDE_AZIMUTH_DEG) {
          lineToAlongSky(ctx, projection, prevAz, prevAlt, az[i], alt[i]);
        } else {
          ctx.lineTo(x, y);
        }
      }
    } else if (open) {
      ctx.stroke();
      open = false;
    }

    prevX = x;
    prevY = y;
    prevAz = az[i];
    prevAlt = alt[i];
    prevFront = front;
    havePrev = true;
  }

  if (open) {
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/**
 * In the panorama a straight az/alt chord is wrong when azimuth swings fast (passes near the
 * zenith) or wraps past north. Follow the great circle instead, lifting the pen at the frame edge.
 */
const WIDE_AZIMUTH_DEG = 12;
const DEG = Math.PI / 180;

function lineToAlongSky(
  ctx: CanvasRenderingContext2D,
  projection: SkyProjection,
  az1: number,
  alt1: number,
  az2: number,
  alt2: number
) {
  const ax = Math.cos(alt1 * DEG) * Math.cos(az1 * DEG);
  const ay = Math.cos(alt1 * DEG) * Math.sin(az1 * DEG);
  const az = Math.sin(alt1 * DEG);
  const bx = Math.cos(alt2 * DEG) * Math.cos(az2 * DEG);
  const by = Math.cos(alt2 * DEG) * Math.sin(az2 * DEG);
  const bz = Math.sin(alt2 * DEG);
  const omega = Math.acos(Math.max(-1, Math.min(1, ax * bx + ay * by + az * bz)));
  const sinOmega = Math.sin(omega);

  let delta = Math.abs(az2 - az1);
  if (delta > 180) delta = 360 - delta;
  const steps = Math.max(2, Math.ceil(delta / 6));
  let lastAz = az1;
  for (let k = 1; k <= steps; k += 1) {
    const t = k / steps;
    let wa = 1 - t;
    let wb = t;
    if (sinOmega > 1e-6) {
      wa = Math.sin((1 - t) * omega) / sinOmega;
      wb = Math.sin(t * omega) / sinOmega;
    }
    const x = wa * ax + wb * bx;
    const y = wa * ay + wb * by;
    const z = wa * az + wb * bz;
    let subAz = Math.atan2(y, x) / DEG;
    if (subAz < 0) subAz += 360;
    const subAlt = Math.asin(Math.max(-1, Math.min(1, z / (Math.hypot(x, y, z) || 1)))) / DEG;
    projection.project(subAz, subAlt, scratch);
    if (Math.abs(subAz - lastAz) > 180) {
      ctx.moveTo(scratch.x, scratch.y);
    } else {
      ctx.lineTo(scratch.x, scratch.y);
    }
    lastAz = subAz;
  }
}
