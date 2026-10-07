import { AIRGLOW, azimuthDelta, Landscape, NIGHT_LIGHT, type LandscapeKind, type SceneFrame, type SceneLight, type Vec3 } from './landscape';

export type ProjectionKind = 'panorama' | 'dome' | 'perspective';
export type Point = { x: number; y: number };

/** Camera and landscape for the perspective (Scene) projection. */
export type SceneOptions = {
  /** Azimuth the camera faces, degrees. */
  heading: number;
  /** Altitude of the frame centre, degrees. */
  tilt: number;
  /** Diagonal field of view, degrees (like a lens's 35 mm-equivalent angle). */
  fov: number;
  landscape: LandscapeKind;
  seed: number;
};

/** Where directions behind the camera land: far off-canvas, never NaN (gradients reject NaN). */
export const BEHIND_CAMERA = -1e5;

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
  /** Ground drawn every frame (it changes with the light) rather than cached once per size. */
  readonly dynamicGround: boolean;
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
  /**
   * False for directions behind the camera (perspective only): a line to such a point must not
   * be drawn, since it would cut across the frame.
   */
  isInFront(azimuth: number, altitude: number): boolean;
  /** Sun, Moon and sky colours for projections whose ground and sky respond to light. */
  setLighting?(light: SceneLight): void;
  /** Re-aim a camera projection in place (Scene panning), keeping its landscape. */
  setCamera?(heading: number, tilt: number, fov: number): void;
  /** Altitude of drawn terrain at an azimuth (Scene): bodies below it are hidden, not set. */
  skyline?(azimuth: number): number;
  /**
   * How the whole frame sways at this moment (a camera on a boat): roll in radians, a vertical
   * offset in logical pixels, and the zoom that keeps the frame's corners covered at the worst
   * of the swell; null when the camera is steady.
   */
  frameMotion?(nowMs: number): { roll: number; offsetY: number; zoom: number } | null;
  /** Things fixed to the camera rather than the world (the boat), drawn last. */
  drawForeground?(ctx: CanvasRenderingContext2D): void;
}

export function createProjection(kind: ProjectionKind, scene?: SceneOptions): SkyProjection {
  if (kind === 'perspective' && scene) {
    return new PerspectiveProjection(scene);
  }
  return kind === 'dome' ? new DomeProjection() : new PanoramaProjection();
}

const clampAltitude = (altitude: number) => Math.max(MIN_ALTITUDE, Math.min(MAX_ALTITUDE, altitude));

class PanoramaProjection implements SkyProjection {
  readonly kind = 'panorama' as const;
  readonly wrapsAzimuth = true;
  readonly dynamicGround = false;
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

  isInFront() {
    return true;
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
  readonly dynamicGround = false;
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

  isInFront() {
    return true;
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

const DEG = Math.PI / 180;
/** Directions within ~88° of the view axis count as in front; beyond that coordinates explode. */
const MIN_DEPTH = 0.035;
const SCENE_LABEL_FONT = '600 10px "JetBrains Mono", "Fira Code", ui-monospace, monospace';

/**
 * A camera's view: rectilinear (gnomonic) projection about a heading and tilt, like a real lens.
 * Great circles, including the horizon, map to straight lines, so star trails curve around the
 * pole exactly as in a long-exposure photograph. A procedural landscape stands in front.
 */
/** Landscapes are generated once per kind and place (a few ms each) and reused across rebuilds. */
const landscapeCache = new Map<string, Landscape>();

function landscapeFor(kind: LandscapeKind, seed: number) {
  const key = `${kind}:${seed}`;
  let landscape = landscapeCache.get(key);
  if (!landscape) {
    if (landscapeCache.size >= 6) {
      landscapeCache.delete(landscapeCache.keys().next().value as string);
    }
    landscape = new Landscape(kind, seed);
    landscapeCache.set(key, landscape);
  }
  return landscape;
}

class PerspectiveProjection implements SkyProjection, SceneFrame {
  readonly kind = 'perspective' as const;
  readonly wrapsAzimuth = false;
  readonly dynamicGround = true;
  width = 0;
  height = 0;
  focal = 1;
  heading = 0;
  tilt = 0;
  private fov = 80;
  private cx = 0;
  private cy = 0;
  // Camera basis in (north, east, up) components: forward, right and up.
  private f = [1, 0, 0];
  private r = [0, 1, 0];
  private u = [0, 0, 1];
  private readonly landscape: Landscape;
  private light: SceneLight = NIGHT_LIGHT;
  private readonly scratch: Point = { x: 0, y: 0 };

  constructor(scene: SceneOptions) {
    this.landscape = landscapeFor(scene.landscape, scene.seed);
    this.setCamera(scene.heading, scene.tilt, scene.fov);
  }

  setCamera(heading: number, tilt: number, fov: number) {
    this.heading = ((heading % 360) + 360) % 360;
    this.tilt = Math.max(-30, Math.min(80, tilt));
    this.fov = Math.max(10, Math.min(150, fov));
    const h = this.heading * DEG;
    const t = this.tilt * DEG;
    this.f = [Math.cos(t) * Math.cos(h), Math.cos(t) * Math.sin(h), Math.sin(t)];
    this.r = [-Math.sin(h), Math.cos(h), 0];
    this.u = [-Math.sin(t) * Math.cos(h), -Math.sin(t) * Math.sin(h), Math.cos(t)];
    if (this.width > 0) {
      this.setSize(this.width, this.height);
    }
  }

  setSize(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.cx = width / 2;
    this.cy = height / 2;
    this.focal = Math.max(1, Math.hypot(width, height) / 2 / Math.tan((this.fov * DEG) / 2));
  }

  setLighting(light: SceneLight) {
    this.light = light;
  }

  halfSpan() {
    return Math.atan(((this.width / 2) * Math.cos(this.tilt * DEG)) / this.focal) / DEG;
  }

  project(azimuth: number, altitude: number, out: Point) {
    const ca = Math.cos(altitude * DEG);
    const n = ca * Math.cos(azimuth * DEG);
    const e = ca * Math.sin(azimuth * DEG);
    const up = Math.sin(altitude * DEG);
    const depth = n * this.f[0] + e * this.f[1] + up * this.f[2];
    if (depth <= MIN_DEPTH) {
      out.x = BEHIND_CAMERA;
      out.y = BEHIND_CAMERA;
      return out;
    }
    out.x = this.cx + (this.focal * (n * this.r[0] + e * this.r[1])) / depth;
    out.y = this.cy - (this.focal * (n * this.u[0] + e * this.u[1] + up * this.u[2])) / depth;
    return out;
  }

  toCamera(north: number, east: number, up: number, out: Vec3) {
    out.x = north * this.r[0] + east * this.r[1];
    out.y = north * this.u[0] + east * this.u[1] + up * this.u[2];
    out.z = north * this.f[0] + east * this.f[1] + up * this.f[2];
    return out;
  }

  cameraToScreen(x: number, y: number, z: number, out: Point) {
    out.x = this.cx + (this.focal * x) / z;
    out.y = this.cy - (this.focal * y) / z;
    return out;
  }

  isInFront(azimuth: number, altitude: number) {
    const ca = Math.cos(altitude * DEG);
    const depth =
      ca * Math.cos(azimuth * DEG) * this.f[0] + ca * Math.sin(azimuth * DEG) * this.f[1] + Math.sin(altitude * DEG) * this.f[2];
    return depth > MIN_DEPTH;
  }

  unproject(x: number, y: number) {
    const dx = (x - this.cx) / this.focal;
    const dy = -(y - this.cy) / this.focal;
    const n = this.f[0] + dx * this.r[0] + dy * this.u[0];
    const e = this.f[1] + dx * this.r[1] + dy * this.u[1];
    const up = this.f[2] + dy * this.u[2];
    const length = Math.hypot(n, e, up);
    let azimuth = Math.atan2(e, n) / DEG;
    if (azimuth < 0) {
      azimuth += 360;
    }
    return { azimuth, altitude: Math.asin(up / length) / DEG };
  }

  /**
   * Rises and sets are tracked at the true horizon, as in the other views, so arcs start below
   * the horizon whichever view recorded them. The landscape is drawn over the sky, so a body
   * behind a ridge is still hidden by it.
   */
  cutoffAltitude() {
    return -(HORIZON_SINK_PX / this.focal) * (180 / Math.PI);
  }

  skyline(azimuth: number) {
    return this.landscape.skyline(azimuth);
  }

  frameMotion(nowMs: number) {
    const motion = this.landscape.motion(nowMs);
    if (!motion) {
      return null;
    }
    const range = this.landscape.motionRange();
    const aspect = Math.max(this.width / this.height, this.height / this.width);
    const zoom =
      Math.cos(range.roll * DEG) +
      aspect * Math.sin(range.roll * DEG) +
      (2 * this.focal * Math.tan(range.pitch * DEG)) / Math.max(1, Math.min(this.width, this.height)) +
      0.01;
    return { roll: motion.roll * DEG, offsetY: this.focal * Math.tan(motion.pitch * DEG), zoom };
  }

  drawForeground(ctx: CanvasRenderingContext2D) {
    this.landscape.drawForeground(ctx, this, this.light);
  }

  /** Screen y of an altitude straight ahead (clamped short of the camera's vanishing limit). */
  private altitudeY(altitude: number) {
    const offset = Math.max(-80, Math.min(80, altitude - this.tilt));
    return this.cy - this.focal * Math.tan(offset * DEG);
  }

  fillSky(ctx: CanvasRenderingContext2D, zenith: string, horizon: string) {
    const horizonY = this.altitudeY(0);
    const gradient = ctx.createLinearGradient(0, this.altitudeY(Math.min(75, this.tilt + 70)), 0, horizonY);
    gradient.addColorStop(0, zenith);
    gradient.addColorStop(1, horizon);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, this.width + 1, this.height + 1);

    const light = this.light;
    // Airglow and distant light low in the night sky, so ridgelines read as silhouettes.
    const night = 1 - Math.min(1, Math.max(0, (light.sunAltitude + 12) / 9));
    if (night > 0.02) {
      const glow = ctx.createLinearGradient(0, this.altitudeY(18), 0, horizonY);
      glow.addColorStop(0, `rgba(${AIRGLOW.join(', ')}, 0)`);
      glow.addColorStop(1, `rgba(${AIRGLOW.join(', ')}, ${0.85 * night})`);
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, this.width + 1, Math.min(this.height, horizonY + 2));
    }

    // A low Sun lights the sky around it: warm at sunrise and sunset, behind the ridges.
    const sunAlt = light.sunTrueAltitude;
    const sunGlow =
      Math.min(1, Math.max(0, (sunAlt + 10) / 8)) * (1 - Math.min(1, Math.max(0, (sunAlt - 4) / 16))) * (1 - light.eclipse);
    const delta = azimuthDelta(light.sunAzimuth, this.heading);
    if (sunGlow > 0.02 && Math.abs(delta) < 120) {
      const p = this.project(this.heading + Math.max(-80, Math.min(80, delta)), Math.max(-1, sunAlt), this.scratch);
      const radius = Math.max(this.width, this.height) * 0.7;
      const warm = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius);
      warm.addColorStop(0, `rgba(255, 168, 96, ${0.32 * sunGlow})`);
      warm.addColorStop(0.35, `rgba(240, 120, 90, ${0.12 * sunGlow})`);
      warm.addColorStop(1, 'rgba(200, 100, 110, 0)');
      ctx.fillStyle = warm;
      ctx.fillRect(0, 0, this.width + 1, this.height + 1);
    }
    // Totality: sunset all round the horizon, from sunlit air beyond the Moon's shadow.
    const ring = Math.min(1, Math.max(0, (light.eclipse - 0.55) / 0.4));
    if (ring > 0.02) {
      const band = ctx.createLinearGradient(0, this.altitudeY(14), 0, horizonY);
      band.addColorStop(0, 'rgba(255, 150, 90, 0)');
      band.addColorStop(0.7, `rgba(240, 130, 80, ${0.16 * ring})`);
      band.addColorStop(1, `rgba(255, 175, 110, ${0.34 * ring})`);
      ctx.fillStyle = band;
      ctx.fillRect(0, 0, this.width + 1, Math.min(this.height, horizonY + 2));
    }
  }

  groundTop() {
    return 0;
  }

  /** A viewfinder has no grid. */
  drawGrid() {}

  drawGround(ctx: CanvasRenderingContext2D) {
    this.landscape.draw(ctx, this, this.light);
    // Compass points along the foot of the frame, for orientation when composing.
    const p = this.scratch;
    const half = this.halfSpan();
    ctx.save();
    ctx.font = SCENE_LABEL_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(160, 160, 160, 0.45)';
    const labels: [number, string][] = [
      [0, 'N'], [45, 'NE'], [90, 'E'], [135, 'SE'], [180, 'S'], [225, 'SW'], [270, 'W'], [315, 'NW'],
    ];
    for (const [azimuth, label] of labels) {
      if (Math.abs(azimuthDelta(azimuth, this.heading)) < half - 2) {
        this.project(azimuth, 0, p);
        ctx.fillText(label, p.x, this.height - 10);
      }
    }
    ctx.restore();
  }

  affineTo(target: SkyProjection): DOMMatrix | null {
    if (
      !(target instanceof PerspectiveProjection) ||
      target.heading !== this.heading ||
      target.tilt !== this.tilt ||
      target.fov !== this.fov
    ) {
      return null;
    }
    const k = target.focal / this.focal;
    return new DOMMatrix([k, 0, 0, k, target.cx - this.cx * k, target.cy - this.cy * k]);
  }
}
