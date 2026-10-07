import { Body } from 'astronomy-engine';
import type { EclipseState } from './eclipse';

/** Default core radius (px) for bodies without a magnitude (comets, interstellar objects). */
export const DEFAULT_MARKER_RADIUS = 4;
export const MOON_MARKER_RADIUS = 7;
export const SUN_MARKER_RADIUS = 6.5;

const DEG = Math.PI / 180;

/**
 * Core radius for a body of apparent magnitude `mag`: Venus and Jupiter stand out, Saturn and
 * Mars sit near the old fixed size, and Uranus/Neptune shrink to pinpricks that keep their colour.
 */
export function radiusForMagnitude(mag: number) {
  return Math.min(6.2, Math.max(2.5, 4.4 - 0.42 * mag));
}

/** Bodies whose apparent magnitude sets their marker size (the Sun and Moon are drawn specially). */
export function usesMagnitude(body: Body | null): body is Body {
  return body !== null && body !== Body.Sun && body !== Body.Moon && body !== Body.Earth;
}

type Direction = { azimuth: number; altitude: number };

/**
 * A sky direction `stepDeg` along the great circle from `from` toward `to`. Projecting it gives
 * the on-screen direction of `to` without projecting `to` itself, which may be below the horizon,
 * across the panorama seam or outside the dome.
 */
export function stepToward(from: Direction, to: Direction, stepDeg: number, out: Direction) {
  const fa = from.azimuth * DEG;
  const fe = from.altitude * DEG;
  const ta = to.azimuth * DEG;
  const te = to.altitude * DEG;
  const mx = Math.cos(fe) * Math.cos(fa);
  const my = Math.cos(fe) * Math.sin(fa);
  const mz = Math.sin(fe);
  const sx = Math.cos(te) * Math.cos(ta);
  const sy = Math.cos(te) * Math.sin(ta);
  const sz = Math.sin(te);
  const dot = mx * sx + my * sy + mz * sz;
  let tx = sx - dot * mx;
  let ty = sy - dot * my;
  let tz = sz - dot * mz;
  const length = Math.hypot(tx, ty, tz);
  if (length < 1e-9) {
    out.azimuth = from.azimuth;
    out.altitude = from.altitude;
    return out;
  }
  tx /= length;
  ty /= length;
  tz /= length;
  const c = Math.cos(stepDeg * DEG);
  const s = Math.sin(stepDeg * DEG);
  const qx = mx * c + tx * s;
  const qy = my * c + ty * s;
  const qz = mz * c + tz * s;
  out.altitude = Math.asin(Math.max(-1, Math.min(1, qz))) / DEG;
  out.azimuth = ((Math.atan2(qy, qx) / DEG) % 360 + 360) % 360;
  return out;
}

/**
 * The Moon as it looks: a dim earthshine disc with the lit part facing `sunAngle` (radians, screen
 * space). `phase` is the illuminated fraction; the terminator is a half-ellipse whose width is
 * r·|2·phase − 1|, bulging away from the Sun when gibbous and toward it when a crescent.
 */
export function drawMoonDisc(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  phase: number,
  sunAngle: number,
  litColor: string,
  darkAlpha = 1
) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(sunAngle);
  // The unlit part (earthshine) only shows against a dark sky.
  if (darkAlpha > 0.01) {
    ctx.globalAlpha = darkAlpha;
    ctx.fillStyle = 'rgb(44, 50, 62)';
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  if (phase > 0.01) {
    const terminator = radius * (2 * phase - 1);
    ctx.fillStyle = litColor;
    ctx.beginPath();
    ctx.arc(0, 0, radius, -Math.PI / 2, Math.PI / 2, false);
    if (terminator >= 0) {
      ctx.ellipse(0, 0, terminator, radius, 0, Math.PI / 2, (3 * Math.PI) / 2, false);
    } else {
      ctx.ellipse(0, 0, -terminator, radius, 0, Math.PI / 2, -Math.PI / 2, true);
    }
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/** A warm bloom around the Sun so it reads as a light source, not just another dot. */
export function drawSunGlow(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number) {
  const reach = radius * 5;
  const glow = ctx.createRadialGradient(x, y, radius * 0.5, x, y, reach);
  glow.addColorStop(0, 'rgba(255, 236, 180, 0.6)');
  glow.addColorStop(0.3, 'rgba(255, 205, 110, 0.18)');
  glow.addColorStop(1, 'rgba(255, 190, 90, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(x - reach, y - reach, reach * 2, reach * 2);
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Fixed streamer directions and lengths so the corona holds still from frame to frame. */
const STREAMERS = [0.15, 0.55, 1.05, 1.5, 2.1, 2.6, 3.05, 3.5, 4.0, 4.55, 5.05, 5.6, 6.0].map((angle, i) => ({
  angle,
  length: 1.8 + ((i * 7) % 5) * 0.45,
  width: 0.45 + ((i * 3) % 4) * 0.12,
}));

/**
 * The Sun during an eclipse at marker scale: the Moon's dark disc crossing it (offset by the true
 * separation in solar radii, toward the Moon's real direction on screen), the glow fading with
 * the remaining light, the diamond ring at the edge of totality, and the corona during it.
 */
export function drawEclipsedSun(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  towardMoon: number,
  radius: number,
  eclipse: EclipseState,
  color: string
) {
  const scale = radius / eclipse.sunRadius;
  const offset = eclipse.separation * scale;
  const moonRadius = eclipse.moonRadius * scale;
  const mx = x + Math.cos(towardMoon) * offset;
  const my = y + Math.sin(towardMoon) * offset;
  const light = 1 - eclipse.obscuration;
  const total = eclipse.kind === 'total';
  const corona = total ? 1 : eclipse.moonRadius >= eclipse.sunRadius ? smoothstep(0.985, 0.9995, eclipse.obscuration) : 0;

  ctx.save();
  if (corona > 0) {
    const halo = ctx.createRadialGradient(x, y, radius * 0.9, x, y, radius * 4.2);
    halo.addColorStop(0, `rgba(250, 250, 255, ${0.9 * corona})`);
    halo.addColorStop(0.18, `rgba(225, 232, 255, ${0.38 * corona})`);
    halo.addColorStop(1, 'rgba(200, 215, 255, 0)');
    ctx.fillStyle = halo;
    ctx.fillRect(x - radius * 4.2, y - radius * 4.2, radius * 8.4, radius * 8.4);
    for (const streamer of STREAMERS) {
      const ex = x + Math.cos(streamer.angle) * radius * streamer.length * 1.6;
      const ey = y + Math.sin(streamer.angle) * radius * streamer.length * 1.6;
      // Soft, broad petals rather than spikes: a curved tip and a faint fill read as wispy.
      const ray = ctx.createLinearGradient(x, y, ex, ey);
      ray.addColorStop(0.3, `rgba(232, 238, 255, ${0.11 * corona})`);
      ray.addColorStop(1, 'rgba(232, 238, 255, 0)');
      const nx = -Math.sin(streamer.angle) * radius * streamer.width;
      const ny = Math.cos(streamer.angle) * radius * streamer.width;
      const tx = x + (ex - x) * 0.6;
      const ty = y + (ey - y) * 0.6;
      ctx.fillStyle = ray;
      ctx.beginPath();
      ctx.moveTo(x + nx * 1.6, y + ny * 1.6);
      ctx.quadraticCurveTo(tx + nx * 0.9, ty + ny * 0.9, ex, ey);
      ctx.quadraticCurveTo(tx - nx * 0.9, ty - ny * 0.9, x - nx * 1.6, y - ny * 1.6);
      ctx.closePath();
      ctx.fill();
    }
  }
  if (light > 0.0005) {
    ctx.globalAlpha = Math.min(1, Math.sqrt(light) * 1.2);
    drawSunGlow(ctx, x, y, radius);
    ctx.globalAlpha = 1;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
  // The Moon: only its overlap with the Sun shows by day; in totality the whole black disc does.
  ctx.save();
  if (!total) {
    ctx.beginPath();
    ctx.arc(x, y, radius + 0.5, 0, Math.PI * 2);
    ctx.clip();
  }
  ctx.fillStyle = 'rgb(7, 8, 12)';
  ctx.beginPath();
  ctx.arc(mx, my, moonRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Diamond ring: the last bead of sunlight on the limb just before and after totality.
  const ring = corona > 0 && !total ? smoothstep(0.97, 0.995, eclipse.obscuration) : 0;
  if (ring > 0.01) {
    const bx = x - Math.cos(towardMoon) * radius * 0.95;
    const by = y - Math.sin(towardMoon) * radius * 0.95;
    const bead = ctx.createRadialGradient(bx, by, 0, bx, by, radius * 2.6);
    bead.addColorStop(0, `rgba(255, 255, 255, ${ring})`);
    bead.addColorStop(0.2, `rgba(255, 250, 235, ${0.55 * ring})`);
    bead.addColorStop(1, 'rgba(255, 245, 220, 0)');
    ctx.fillStyle = bead;
    ctx.fillRect(bx - radius * 2.6, by - radius * 2.6, radius * 5.2, radius * 5.2);
  }
  ctx.restore();
}
