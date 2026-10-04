import { Body } from 'astronomy-engine';

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
  litColor: string
) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(sunAngle);
  ctx.globalAlpha = 1;
  ctx.fillStyle = 'rgb(44, 50, 62)';
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.fill();
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
