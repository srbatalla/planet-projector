import { Body, Equator, Horizon, type Observer } from 'astronomy-engine';

const DEG = Math.PI / 180;
const AU_KM = 149597870.7;
const SUN_RADIUS_KM = 695700;
const MOON_RADIUS_KM = 1737.4;
/** The Moon gains on the Sun by ~0.55°/h; a margin below that keeps the skip-ahead safe. */
const RELATIVE_MOTION_DEG_PER_HOUR = 0.7;

export type EclipseKind = 'partial' | 'annular' | 'total';

/** A solar eclipse as seen by the observer at one moment. */
export type EclipseState = {
  kind: EclipseKind;
  /** Fraction of the Sun's disc covered by the Moon, 0..1. */
  obscuration: number;
  /**
   * How dark the eclipse makes the day, 0..1: the logarithm of the remaining sunlight, so a 90%
   * partial eclipse only dims it a little and the sky falls to twilight just before totality.
   */
  darkness: number;
  /** Centre-to-centre separation and apparent radii, degrees. */
  separation: number;
  sunRadius: number;
  moonRadius: number;
  sun: { azimuth: number; altitude: number };
  moon: { azimuth: number; altitude: number };
};

/** Area of the Sun's disc (radius R) covered by the Moon's (radius r) at centre distance d, as a fraction. */
function coveredFraction(R: number, r: number, d: number) {
  if (d >= R + r) {
    return 0;
  }
  if (d <= Math.abs(R - r)) {
    return r >= R ? 1 : (r * r) / (R * R);
  }
  const a = r * r * Math.acos((d * d + r * r - R * R) / (2 * d * r));
  const b = R * R * Math.acos((d * d + R * R - r * r) / (2 * d * R));
  const c = 0.5 * Math.sqrt((-d + r + R) * (d + r - R) * (d - r + R) * (d + r + R));
  return Math.min(1, (a + b - c) / (Math.PI * R * R));
}

/**
 * Solar eclipses for one observer, from topocentric Sun and Moon positions and distances (so
 * totality, annularity and the local path are right). Far from new Moon it costs nothing; near
 * it, two ephemeris calls per frame, skipped for hours at a time while the Moon is well clear.
 */
export class EclipseModel {
  private readonly date = new Date();
  /** Last time the Moon was found far from the Sun, and how long that stays true. */
  private clearAtMs = Number.NaN;
  private clearForMs = 0;

  constructor(private readonly observer: Observer) {}

  at(timeMs: number, moonPhase: number): EclipseState | null {
    // Only a thin crescent-to-new Moon can be anywhere near the Sun.
    if (moonPhase > 0.03) {
      return null;
    }
    if (Math.abs(timeMs - this.clearAtMs) < this.clearForMs) {
      return null;
    }
    this.date.setTime(timeMs);
    const sunEq = Equator(Body.Sun, this.date, this.observer, true, true);
    const moonEq = Equator(Body.Moon, this.date, this.observer, true, true);
    const raS = sunEq.ra * 15 * DEG;
    const raM = moonEq.ra * 15 * DEG;
    const decS = sunEq.dec * DEG;
    const decM = moonEq.dec * DEG;
    const cosSep = Math.sin(decS) * Math.sin(decM) + Math.cos(decS) * Math.cos(decM) * Math.cos(raS - raM);
    const separation = Math.acos(Math.max(-1, Math.min(1, cosSep))) / DEG;
    const sunRadius = Math.asin(SUN_RADIUS_KM / (sunEq.dist * AU_KM)) / DEG;
    const moonRadius = Math.asin(MOON_RADIUS_KM / (moonEq.dist * AU_KM)) / DEG;
    if (separation >= sunRadius + moonRadius) {
      this.clearAtMs = timeMs;
      this.clearForMs = (Math.max(0, separation - sunRadius - moonRadius - 0.05) / RELATIVE_MOTION_DEG_PER_HOUR) * 3600000;
      return null;
    }
    const sunH = Horizon(this.date, this.observer, sunEq.ra, sunEq.dec, 'normal');
    if (sunH.altitude < -1.5) {
      return null;
    }
    const moonH = Horizon(this.date, this.observer, moonEq.ra, moonEq.dec, 'normal');
    const obscuration = coveredFraction(sunRadius, moonRadius, separation);
    const light = 1 - obscuration;
    const darkness = Math.max(0, Math.min(1, Math.log10(1 / Math.max(light, 1e-4)) / 4));
    const central = separation <= Math.abs(sunRadius - moonRadius);
    return {
      kind: central ? (moonRadius >= sunRadius ? 'total' : 'annular') : 'partial',
      obscuration,
      darkness,
      separation,
      sunRadius,
      moonRadius,
      sun: { azimuth: sunH.azimuth, altitude: sunH.altitude },
      moon: { azimuth: moonH.azimuth, altitude: moonH.altitude },
    };
  }
}

/** The Sun altitude the sky looks like under an eclipse: totality is deep twilight. */
export function eclipsedSunAltitude(sunAltitude: number, eclipse: EclipseState | null) {
  if (!eclipse || eclipse.darkness <= 0) {
    return sunAltitude;
  }
  const totality = -7.5;
  return sunAltitude <= totality ? sunAltitude : sunAltitude + (totality - sunAltitude) * eclipse.darkness;
}
