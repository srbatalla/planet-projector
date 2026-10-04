import {
  Body,
  EquatorFromVector,
  HelioVector,
  MakeTime,
  RotateVector,
  Rotation_EQJ_EQD,
  Vector,
} from 'astronomy-engine';
import type { SpecialObject } from './specialObjects';

const DEG = Math.PI / 180;
const OBLIQUITY_J2000 = 23.4392911 * DEG;
const COS_OBL = Math.cos(OBLIQUITY_J2000);
const SIN_OBL = Math.sin(OBLIQUITY_J2000);

export type Vec3 = { x: number; y: number; z: number };

/** Mean semi-major axis (AU) and eccentricity, used to size the spirograph frame up front. */
const ORBIT_SHAPE: Partial<Record<Body, { a: number; e: number }>> = {
  [Body.Sun]: { a: 0, e: 0 },
  [Body.Mercury]: { a: 0.387, e: 0.2056 },
  [Body.Venus]: { a: 0.723, e: 0.0068 },
  [Body.Earth]: { a: 1.0, e: 0.0167 },
  [Body.Moon]: { a: 1.0027, e: 0.0167 },
  [Body.Mars]: { a: 1.524, e: 0.0934 },
  [Body.Jupiter]: { a: 5.203, e: 0.0484 },
  [Body.Saturn]: { a: 9.537, e: 0.0539 },
  [Body.Uranus]: { a: 19.19, e: 0.0473 },
  [Body.Neptune]: { a: 30.07, e: 0.0086 },
  [Body.Pluto]: { a: 39.48, e: 0.2488 },
};

export function maxHeliocentricDistance(body: Body): number {
  const shape = ORBIT_SHAPE[body];
  return shape ? shape.a * (1 + shape.e) : 1;
}

/** Aphelion distance; unbounded for parabolic/hyperbolic (interstellar) orbits. */
export function maxSpecialDistance(special: SpecialObject): number {
  const { semiMajorAxisAu: a, eccentricity: e } = special.orbitalElements;
  return e >= 1 ? Number.POSITIVE_INFINITY : a * (1 + e);
}

/** Rotate a J2000 equatorial vector into the J2000 ecliptic plane (in place on `out`). */
export function equatorialToEcliptic(vec: Vec3, out: Vec3): Vec3 {
  const y = vec.y * COS_OBL + vec.z * SIN_OBL;
  const z = -vec.y * SIN_OBL + vec.z * COS_OBL;
  out.x = vec.x;
  out.y = y;
  out.z = z;
  return out;
}

/**
 * Heliocentric J2000-ecliptic position (AU) from two-body Keplerian elements. Elliptic orbits
 * use the mean anomaly at `epochJd`; hyperbolic ones (e > 1, negative a) count from perihelion.
 */
export function keplerPosition(special: SpecialObject, timeMs: number, out: Vec3): Vec3 {
  const el = special.orbitalElements;
  const e = el.eccentricity;
  const a = Math.abs(el.semiMajorAxisAu);
  const jd = timeMs / 86400000 + 2440587.5;
  const meanMotionDeg = 0.9856076686 / Math.pow(a, 1.5);
  const meanAnomaly = (el.meanAnomalyAtEpochDeg + meanMotionDeg * (jd - el.epochJd)) * DEG;

  let xv: number;
  let yv: number;
  if (e > 1) {
    // Hyperbolic Kepler equation: M = e·sinh(H) − H.
    let H = Math.asinh(meanAnomaly / e);
    for (let i = 0; i < 60; i += 1) {
      const delta = (e * Math.sinh(H) - H - meanAnomaly) / (e * Math.cosh(H) - 1);
      H -= delta;
      if (Math.abs(delta) < 1e-12) {
        break;
      }
    }
    xv = a * (e - Math.cosh(H));
    yv = a * Math.sqrt(e * e - 1) * Math.sinh(H);
  } else {
    const M = Math.atan2(Math.sin(meanAnomaly), Math.cos(meanAnomaly));
    let E = e > 0.8 ? Math.PI * Math.sign(M || 1) : M;
    for (let i = 0; i < 50; i += 1) {
      const delta = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
      E -= delta;
      if (Math.abs(delta) < 1e-10) {
        break;
      }
    }
    xv = a * (Math.cos(E) - e);
    yv = a * Math.sqrt(1 - e * e) * Math.sin(E);
  }
  const cO = Math.cos(el.longitudeAscendingNodeDeg * DEG);
  const sO = Math.sin(el.longitudeAscendingNodeDeg * DEG);
  const cw = Math.cos(el.argumentPeriapsisDeg * DEG);
  const sw = Math.sin(el.argumentPeriapsisDeg * DEG);
  const ci = Math.cos(el.inclinationDeg * DEG);
  const si = Math.sin(el.inclinationDeg * DEG);

  out.x = xv * (cO * cw - sO * sw * ci) - yv * (cO * sw + sO * cw * ci);
  out.y = xv * (sO * cw + cO * sw * ci) - yv * (sO * sw - cO * cw * ci);
  out.z = xv * (sw * si) + yv * (cw * si);
  return out;
}

const scratchHelio: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * Geocentric right ascension (hours) and declination (degrees) of date for a Keplerian object,
 * ready for astronomy-engine's Horizon(). Light-time, aberration and topocentric parallax are
 * ignored: under 0.02° even for ʻOumuamua's 0.16 AU pass.
 */
export function specialEquatorOfDate(special: SpecialObject, date: Date) {
  const helio = keplerPosition(special, date.getTime(), scratchHelio);
  const earth = HelioVector(Body.Earth, date);
  const time = MakeTime(date);
  // Ecliptic → J2000 equatorial, then geocentric, then precess/nutate to the equator of date.
  const geocentric = new Vector(
    helio.x - earth.x,
    helio.y * COS_OBL - helio.z * SIN_OBL - earth.y,
    helio.y * SIN_OBL + helio.z * COS_OBL - earth.z,
    time
  );
  const ofDate = EquatorFromVector(RotateVector(Rotation_EQJ_EQD(time), geocentric));
  return { ra: ofDate.ra, dec: ofDate.dec, distanceAu: ofDate.dist };
}
