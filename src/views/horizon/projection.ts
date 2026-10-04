export type ProjectionKind = 'panorama' | 'dome';
export type Point = { x: number; y: number };

const GROUND_COLOR = '#070707';
/** Translucent so the grid reads the same over a black night and a tinted day sky. */
const GRID_COLOR = 'rgba(255, 255, 255, 0.055)';
const LABEL_COLOR = '#6f6f6f';
const LABEL_FONT = '10px "JetBrains Mono", "Fira Code", ui-monospace, monospace';
const CARDINAL_FONT = '600 11px "JetBrains Mono", "Fira Code", ui-monospace, monospace';
const MIN_ALTITUDE = -10;
const MAX_ALTITUDE = 90;
/** Markers sink this far (px) past the drawn horizon before they count as set. */
const HORIZON_SINK_PX = 8;

/**
 * Maps horizontal coordinates (azimuth/altitude, degrees) to logical canvas pixels and
 * draws the projection-specific grid and ground. All drawing is in logical pixels.
 */
export interface SkyProjection {
  readonly kind: ProjectionKind;
  /** True when a segment crossing azimuth 0/360 must be broken instead of drawn. */
  readonly wrapsAzimuth: boolean;
  setSize(width: number, height: number): void;
  project(azimuth: number, altitude: number, out: Point): Point;
  /** Altitude below which a body is hidden by the ground at this azimuth. */
  cutoffAltitude(azimuth: number): number;
  /** Fills the whole canvas (it doubles as the frame clear). */
  fillSky(ctx: CanvasRenderingContext2D, zenith: string, horizon: string): void;
  /** Logical y above which the ground layer is fully transparent. */
  groundTop(): number;
  drawGrid(ctx: CanvasRenderingContext2D): void;
  drawGround(ctx: CanvasRenderingContext2D): void;
  /**
   * Affine map from this projection's canvas to `target`'s (same kind, other size), or null.
   * Both projections scale linearly with their frame, so bitmaps such as the star-trail layer
   * can be carried into a differently sized render exactly.
   */
  affineTo(target: SkyProjection): DOMMatrix | null;
  /** Sky direction under a logical canvas point, or null where there is no sky (outside the dome). */
  unproject(x: number, y: number): { azimuth: number; altitude: number } | null;
}

export function createProjection(kind: ProjectionKind): SkyProjection {
  return kind === 'dome' ? new DomeProjection() : new PanoramaProjection();
}

const clampAltitude = (altitude: number) => Math.max(MIN_ALTITUDE, Math.min(MAX_ALTITUDE, altitude));

class PanoramaProjection implements SkyProjection {
  readonly kind = 'panorama' as const;
  readonly wrapsAzimuth = true;
  private width = 0;
  private height = 0;
  private paddingTop = 0;
  private usableHeight = 1;
  private curveAmplitude = 0;
  private zeroAltitudeY = 0;

  setSize(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.paddingTop = height > 0 ? Math.max(24, height * 0.04) : 0;
    this.usableHeight = Math.max(1, height - this.paddingTop);
    this.curveAmplitude = Math.min(20, height * 0.03);
    this.zeroAltitudeY = this.mapAltitude(0);
  }

  private mapAltitude(altitude: number) {
    const ratio = (clampAltitude(altitude) - MIN_ALTITUDE) / (MAX_ALTITUDE - MIN_ALTITUDE);
    return this.paddingTop + this.usableHeight * (1 - ratio);
  }

  private unmapAltitude(y: number) {
    const clampedY = Math.max(this.paddingTop, Math.min(this.height, y));
    const ratio = 1 - (clampedY - this.paddingTop) / this.usableHeight;
    return ratio * (MAX_ALTITUDE - MIN_ALTITUDE) + MIN_ALTITUDE;
  }

  private horizonY(x: number) {
    if (this.width <= 0) {
      return this.zeroAltitudeY;
    }
    return this.zeroAltitudeY - Math.sin((x / this.width) * Math.PI) * this.curveAmplitude;
  }

  project(azimuth: number, altitude: number, out: Point) {
    out.x = (azimuth / 360) * this.width;
    out.y = this.mapAltitude(altitude);
    return out;
  }

  cutoffAltitude(azimuth: number) {
    return this.unmapAltitude(this.horizonY((azimuth / 360) * this.width) + HORIZON_SINK_PX);
  }

  fillSky(ctx: CanvasRenderingContext2D, zenith: string, horizon: string) {
    const gradient = ctx.createLinearGradient(0, this.paddingTop, 0, this.zeroAltitudeY);
    gradient.addColorStop(0, zenith);
    gradient.addColorStop(1, horizon);
    ctx.fillStyle = gradient;
    // +1: the backing store is rounded up from logical size and must be fully covered.
    ctx.fillRect(0, 0, this.width + 1, this.height + 1);
  }

  groundTop() {
    // Highest point of the curved horizon, minus the glow that starts 30px above it.
    return this.zeroAltitudeY - this.curveAmplitude + HORIZON_SINK_PX - 30;
  }

  unproject(x: number, y: number) {
    if (this.width <= 0) {
      return null;
    }
    const azimuth = (((x / this.width) * 360) % 360 + 360) % 360;
    return { azimuth, altitude: this.unmapAltitude(y) };
  }

  affineTo(target: SkyProjection): DOMMatrix | null {
    if (!(target instanceof PanoramaProjection) || this.width <= 0) {
      return null;
    }
    const sx = target.width / this.width;
    const sy = target.usableHeight / this.usableHeight;
    return new DOMMatrix([sx, 0, 0, sy, 0, target.paddingTop - this.paddingTop * sy]);
  }

  private traceHorizon(ctx: CanvasRenderingContext2D, offsetY: number) {
    const steps = Math.max(24, Math.floor(this.width / 30));
    ctx.moveTo(0, this.horizonY(0) + offsetY);
    for (let i = 1; i <= steps; i += 1) {
      const x = (i / steps) * this.width;
      ctx.lineTo(x, this.horizonY(x) + offsetY);
    }
  }

  drawGrid(ctx: CanvasRenderingContext2D) {
    ctx.save();
    ctx.strokeStyle = GRID_COLOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let az = 30; az < 360; az += 30) {
      const x = Math.round((az / 360) * this.width) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.height);
    }
    ctx.stroke();

    ctx.setLineDash([2, 6]);
    ctx.beginPath();
    for (let alt = 30; alt < 90; alt += 30) {
      const y = Math.round(this.mapAltitude(alt)) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(this.width, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = LABEL_COLOR;
    ctx.font = LABEL_FONT;
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'right';
    for (let alt = 30; alt < 90; alt += 30) {
      ctx.fillText(`${alt}°`, this.width - 6, this.mapAltitude(alt) - 3);
    }
    ctx.restore();
  }

  drawGround(ctx: CanvasRenderingContext2D) {
    const offset = HORIZON_SINK_PX;
    const base = this.zeroAltitudeY;
    const glowDepth = Math.min(80, this.height * 0.15);
    ctx.save();

    ctx.beginPath();
    this.traceHorizon(ctx, offset);
    ctx.lineTo(this.width, this.height);
    ctx.lineTo(0, this.height);
    ctx.closePath();
    ctx.fillStyle = GROUND_COLOR;
    ctx.fill();

    const gradient = ctx.createLinearGradient(0, base + offset - 30, 0, base + offset + glowDepth);
    gradient.addColorStop(0, 'rgba(255, 255, 255, 0.08)');
    gradient.addColorStop(0.4, 'rgba(255, 255, 255, 0.18)');
    gradient.addColorStop(1, 'rgba(5, 5, 5, 0)');
    ctx.beginPath();
    this.traceHorizon(ctx, offset);
    ctx.lineTo(this.width, base + offset + glowDepth);
    ctx.lineTo(0, base + offset + glowDepth);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    ctx.beginPath();
    this.traceHorizon(ctx, offset);
    ctx.strokeStyle = '#2a2a2a';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Cardinal directions sit just below the horizon line, like a panorama caption.
    ctx.font = CARDINAL_FONT;
    ctx.textBaseline = 'top';
    const labels: [number, string][] = [
      [0, 'N'], [45, 'NE'], [90, 'E'], [135, 'SE'], [180, 'S'], [225, 'SW'], [270, 'W'], [315, 'NW'], [360, 'N'],
    ];
    for (const [az, label] of labels) {
      const x = (az / 360) * this.width;
      const y = this.horizonY(x) + offset + 8;
      if (y + 12 > this.height) {
        continue;
      }
      ctx.textAlign = az === 0 ? 'left' : az === 360 ? 'right' : 'center';
      ctx.fillStyle = label.length === 1 ? '#9a9a9a' : '#4d4d4d';
      ctx.fillText(label, x + (az === 0 ? 6 : az === 360 ? -6 : 0), y);
    }
    ctx.restore();
  }
}

class DomeProjection implements SkyProjection {
  readonly kind = 'dome' as const;
  readonly wrapsAzimuth = false;
  private width = 0;
  private height = 0;
  private cx = 0;
  private cy = 0;
  private radius = 1;
  private cutoff = -2;

  setSize(width: number, height: number) {
    this.width = width;
    this.height = height;
    const margin = Math.max(22, Math.min(width, height) * 0.06);
    this.radius = Math.max(10, Math.min(width, height) / 2 - margin);
    this.cx = width / 2;
    this.cy = height / 2;
    this.cutoff = -(HORIZON_SINK_PX / this.radius) * 90;
  }

  project(azimuth: number, altitude: number, out: Point) {
    const r = ((90 - clampAltitude(altitude)) / 90) * this.radius;
    const theta = (azimuth * Math.PI) / 180;
    // Looking up with north at the top puts east on the left.
    out.x = this.cx - r * Math.sin(theta);
    out.y = this.cy - r * Math.cos(theta);
    return out;
  }

  cutoffAltitude() {
    return this.cutoff;
  }

  fillSky(ctx: CanvasRenderingContext2D, zenith: string, horizon: string) {
    const gradient = ctx.createRadialGradient(this.cx, this.cy, 0, this.cx, this.cy, this.radius);
    gradient.addColorStop(0, zenith);
    gradient.addColorStop(1, horizon);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, this.width + 1, this.height + 1);
  }

  groundTop() {
    return 0;
  }

  unproject(x: number, y: number) {
    const dx = x - this.cx;
    const dy = y - this.cy;
    const altitude = 90 - (Math.hypot(dx, dy) / this.radius) * 90;
    if (altitude < MIN_ALTITUDE) {
      return null;
    }
    let azimuth = (Math.atan2(-dx, -dy) * 180) / Math.PI;
    if (azimuth < 0) {
      azimuth += 360;
    }
    return { azimuth, altitude };
  }

  affineTo(target: SkyProjection): DOMMatrix | null {
    if (!(target instanceof DomeProjection)) {
      return null;
    }
    const k = target.radius / this.radius;
    return new DOMMatrix([k, 0, 0, k, target.cx - this.cx * k, target.cy - this.cy * k]);
  }

  drawGrid(ctx: CanvasRenderingContext2D) {
    const { cx, cy, radius } = this;
    ctx.save();
    ctx.strokeStyle = GRID_COLOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let az = 0; az < 360; az += 30) {
      const theta = (az * Math.PI) / 180;
      const inner = az % 90 === 0 ? 0 : radius / 3;
      ctx.moveTo(cx - inner * Math.sin(theta), cy - inner * Math.cos(theta));
      ctx.lineTo(cx - radius * Math.sin(theta), cy - radius * Math.cos(theta));
    }
    ctx.stroke();

    ctx.setLineDash([2, 6]);
    ctx.beginPath();
    for (let alt = 30; alt < 90; alt += 30) {
      const r = ((90 - alt) / 90) * radius;
      ctx.moveTo(cx + r, cy);
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = LABEL_COLOR;
    ctx.font = LABEL_FONT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (let alt = 30; alt < 90; alt += 30) {
      const r = ((90 - alt) / 90) * radius;
      ctx.fillText(`${alt}°`, cx + 4, cy - r - 7);
    }
    ctx.restore();
  }

  drawGround(ctx: CanvasRenderingContext2D) {
    const { cx, cy, radius } = this;
    const rim = radius + HORIZON_SINK_PX;
    ctx.save();

    ctx.beginPath();
    ctx.rect(0, 0, this.width, this.height);
    ctx.moveTo(cx + rim, cy);
    ctx.arc(cx, cy, rim, 0, Math.PI * 2, true);
    ctx.fillStyle = GROUND_COLOR;
    ctx.fill('evenodd');

    // Radii are clamped: a squeezed canvas (keyboard open on a phone) can make rim < 30.
    const innerGlow = Math.max(0, rim - 30);
    const glow = ctx.createRadialGradient(cx, cy, innerGlow, cx, cy, rim + 40);
    glow.addColorStop(0, 'rgba(255, 255, 255, 0)');
    glow.addColorStop(0.42, 'rgba(255, 255, 255, 0.07)');
    glow.addColorStop(0.45, 'rgba(255, 255, 255, 0.16)');
    glow.addColorStop(1, 'rgba(5, 5, 5, 0)');
    ctx.beginPath();
    ctx.arc(cx, cy, rim + 40, 0, Math.PI * 2);
    ctx.moveTo(cx + innerGlow, cy);
    ctx.arc(cx, cy, innerGlow, 0, Math.PI * 2, true);
    ctx.fillStyle = glow;
    ctx.fill('evenodd');

    ctx.beginPath();
    ctx.arc(cx, cy, rim, 0, Math.PI * 2);
    ctx.strokeStyle = '#2a2a2a';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.font = CARDINAL_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const labelRadius = rim + 12;
    const labels: [number, string][] = [[0, 'N'], [90, 'E'], [180, 'S'], [270, 'W']];
    for (const [az, label] of labels) {
      const theta = (az * Math.PI) / 180;
      ctx.fillStyle = '#9a9a9a';
      ctx.fillText(label, cx - labelRadius * Math.sin(theta), cy - labelRadius * Math.cos(theta));
    }
    ctx.restore();
  }
}
