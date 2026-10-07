import { SiderealTime } from 'astronomy-engine';

/**
 * Historical Easter eggs: early spacecraft that pass overhead on their real dates, the Apollo
 * landings marked on the Moon while crews were on the surface, and dated notes. Orbits are
 * rebuilt from published perigee, apogee, inclination and launch time (two-body motion plus the
 * drift caused by Earth's flattening), so passes are plausible rather than exact: atmospheric
 * drag, which shrank these low orbits within weeks, is ignored.
 */

const EARTH_RADIUS_KM = 6378.137;
const MU_KM3_S2 = 398600.4418;
const J2 = 1.08263e-3;
const DEG = Math.PI / 180;
/**
 * Grazing heights (km) over which sunlight fades out into Earth's shadow. Most of the real dimming
 * happens in the lowest few tens of km; the range is stretched so a pass visibly tapers away.
 */
const SHADOW_EDGE_KM = [5, 130];
/** Baikonur launch site. */
const BAIKONUR = { latitude: 45.92, longitude: 63.34 };

export type HistoricSatellite = {
  id: string;
  label: string;
  launchMs: number;
  /** Seconds from launch to orbit insertion (where the orbit begins here). */
  insertionSeconds: number;
  /** End of the orbit: decay or retrofire. */
  endMs: number;
  perigeeKm: number;
  apogeeKm: number;
  inclinationDeg: number;
  site: { latitude: number; longitude: number };
  /** Shown once per run when the launch moment passes (or the run starts soon after it). */
  note: string;
};

export const SATELLITES: HistoricSatellite[] = [
  {
    id: 'sputnik-1',
    label: 'Sputnik 1',
    launchMs: Date.UTC(1957, 9, 4, 19, 28, 34),
    insertionSeconds: 315,
    endMs: Date.UTC(1958, 0, 4),
    perigeeKm: 215,
    apogeeKm: 939,
    inclinationDeg: 65.1,
    site: BAIKONUR,
    note: '4 Oct 1957 · Sputnik 1, the first artificial satellite, is in orbit. Look for it after dusk and before dawn (the bright point people saw was mostly its rocket stage).',
  },
  {
    id: 'sputnik-2',
    label: 'Sputnik 2 · Laika',
    launchMs: Date.UTC(1957, 10, 3, 2, 30, 42),
    insertionSeconds: 300,
    endMs: Date.UTC(1958, 3, 14),
    perigeeKm: 212,
    apogeeKm: 1660,
    inclinationDeg: 65.33,
    site: BAIKONUR,
    note: '3 Nov 1957 · Sputnik 2 carries Laika, the first animal to orbit the Earth.',
  },
  {
    id: 'vostok-1',
    label: 'Vostok 1 · Gagarin',
    launchMs: Date.UTC(1961, 3, 12, 6, 7, 0),
    insertionSeconds: 676,
    // Retrofire over Africa; landing near Engels at 07:55.
    endMs: Date.UTC(1961, 3, 12, 7, 25, 0),
    perigeeKm: 169,
    apogeeKm: 327,
    inclinationDeg: 64.95,
    site: BAIKONUR,
    note: '12 Apr 1961 · Yuri Gagarin in Vostok 1: the first human in space, one orbit in 108 minutes.',
  },
];

export type LunarLanding = {
  id: string;
  label: string;
  touchdownMs: number;
  liftoffMs: number;
  /** Selenographic latitude and longitude of the site, degrees. */
  latitude: number;
  longitude: number;
  note: string;
};

export const LANDINGS: LunarLanding[] = [
  {
    id: 'apollo-11',
    label: 'Apollo 11',
    touchdownMs: Date.UTC(1969, 6, 20, 20, 17, 40),
    liftoffMs: Date.UTC(1969, 6, 21, 17, 54, 0),
    latitude: 0.674,
    longitude: 23.473,
    note: '20 Jul 1969 · Apollo 11 lands in the Sea of Tranquility: “The Eagle has landed.”',
  },
  {
    id: 'apollo-12',
    label: 'Apollo 12',
    touchdownMs: Date.UTC(1969, 10, 19, 6, 54, 35),
    liftoffMs: Date.UTC(1969, 10, 20, 14, 25, 47),
    latitude: -3.012,
    longitude: -23.422,
    note: '19 Nov 1969 · Apollo 12 lands in the Ocean of Storms, a short walk from the Surveyor 3 probe.',
  },
  {
    id: 'apollo-14',
    label: 'Apollo 14',
    touchdownMs: Date.UTC(1971, 1, 5, 9, 18, 11),
    liftoffMs: Date.UTC(1971, 1, 6, 18, 48, 42),
    latitude: -3.645,
    longitude: -17.471,
    note: '5 Feb 1971 · Apollo 14 lands at Fra Mauro, where Alan Shepard will hit two golf balls.',
  },
  {
    id: 'apollo-15',
    label: 'Apollo 15',
    touchdownMs: Date.UTC(1971, 6, 30, 22, 16, 29),
    liftoffMs: Date.UTC(1971, 7, 2, 17, 11, 23),
    latitude: 26.132,
    longitude: 3.634,
    note: '30 Jul 1971 · Apollo 15 lands beside Hadley Rille with the first lunar rover.',
  },
  {
    id: 'apollo-16',
    label: 'Apollo 16',
    touchdownMs: Date.UTC(1972, 3, 21, 2, 23, 35),
    liftoffMs: Date.UTC(1972, 3, 24, 1, 25, 47),
    latitude: -8.973,
    longitude: 15.5,
    note: '21 Apr 1972 · Apollo 16 lands in the Descartes highlands.',
  },
  {
    id: 'apollo-17',
    label: 'Apollo 17',
    touchdownMs: Date.UTC(1972, 11, 11, 19, 54, 57),
    liftoffMs: Date.UTC(1972, 11, 14, 22, 54, 37),
    latitude: 20.191,
    longitude: 30.772,
    note: '11 Dec 1972 · Apollo 17 lands at Taurus–Littrow: the last people to walk on the Moon so far.',
  },
];

/** Dated notes shown when the clock passes them (when the Moon is up, for `needsMoon`). */
export type HistoryNote = { id: string; atMs: number; note: string; needsMoon?: boolean };

export const NOTES: HistoryNote[] = [
  {
    id: 'v2-mw18014',
    // The launch hour is not recorded; the note covers the whole day.
    atMs: Date.UTC(1944, 5, 20, 12, 0, 0),
    note: '20 Jun 1944 · A V-2 test rocket from Peenemünde reaches 176 km: the first human-made object in space.',
  },
  {
    id: 'apollo-11-step',
    atMs: Date.UTC(1969, 6, 21, 2, 56, 15),
    needsMoon: true,
    note: '21 Jul 1969 · Neil Armstrong steps onto the Moon: “That’s one small step for man, one giant leap for mankind.”',
  },
  {
    id: 'apollo-13',
    atMs: Date.UTC(1970, 3, 15, 0, 21, 0),
    needsMoon: true,
    note: '15 Apr 1970 · Crippled Apollo 13 swings round the far side of the Moon, 254 km up, and heads for home.',
  },
];

/** Low-precision Sun direction (equinox of date, unit vector): good to ~0.01°. */
export function sunDirection(timeMs: number, out: number[] = [0, 0, 0]) {
  const n = timeMs / 86400000 + 2440587.5 - 2451545;
  const g = (357.528 + 0.9856003 * n) * DEG;
  const lambda = (280.46 + 0.9856474 * n + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG;
  const epsilon = (23.439 - 0.0000004 * n) * DEG;
  out[0] = Math.cos(lambda);
  out[1] = Math.cos(epsilon) * Math.sin(lambda);
  out[2] = Math.sin(epsilon) * Math.sin(lambda);
  return out;
}

/** Greenwich apparent sidereal angle, radians. */
function siderealAngle(timeMs: number) {
  return SiderealTime(new Date(timeMs)) * 15 * DEG;
}

export type SatelliteSample = {
  azimuth: number;
  altitude: number;
  /**
   * Sunlight reaching the satellite, 0..1: 1 in full sun, falling to 0 as the line to the Sun
   * grazes ever lower through the atmosphere on the way into Earth's shadow.
   */
  sunlight: number;
  /** The Sun's altitude for the observer, degrees: passes show only in a dark enough sky. */
  sunAltitude: number;
};

/** A historic satellite's orbit, ready to be sampled for one observer. */
export class SatelliteOrbit {
  private readonly epochMs: number;
  private readonly a: number;
  private readonly e: number;
  private readonly n: number;
  private readonly inclination: number;
  private readonly raan0: number;
  private readonly perigee0: number;
  private readonly raanRate: number;
  private readonly perigeeRate: number;
  private readonly sun = [0, 0, 0];

  constructor(readonly satellite: HistoricSatellite) {
    this.epochMs = satellite.launchMs + satellite.insertionSeconds * 1000;
    const rp = EARTH_RADIUS_KM + satellite.perigeeKm;
    const ra = EARTH_RADIUS_KM + satellite.apogeeKm;
    this.a = (rp + ra) / 2;
    this.e = (ra - rp) / (ra + rp);
    this.n = Math.sqrt(MU_KM3_S2 / this.a ** 3);
    const i = satellite.inclinationDeg * DEG;
    this.inclination = i;
    // The orbit plane passes over the launch site at launch on a northbound (ascending) pass.
    const lat = satellite.site.latitude * DEG;
    const siteRa = siderealAngle(satellite.launchMs) + satellite.site.longitude * DEG;
    const uSite = Math.asin(Math.min(1, Math.sin(lat) / Math.sin(i)));
    const fromNode = Math.atan2(Math.cos(i) * Math.sin(uSite), Math.cos(uSite));
    this.raan0 = siteRa - fromNode;
    // Insertion (taken as perigee) lies downrange: roughly the ascent's ground distance.
    const downrange = (satellite.insertionSeconds / 600) * 20 * DEG;
    this.perigee0 = uSite + downrange;
    const p = this.a * (1 - this.e * this.e);
    const k = 1.5 * this.n * J2 * (EARTH_RADIUS_KM / p) ** 2;
    this.raanRate = -k * Math.cos(i);
    this.perigeeRate = k * (2 - 2.5 * Math.sin(i) ** 2);
  }

  get startMs() {
    return this.epochMs;
  }

  get endMs() {
    return this.satellite.endMs;
  }

  /** Geocentric position (km, equinox of date) at `timeMs`. */
  position(timeMs: number, out: number[]) {
    const dt = (timeMs - this.epochMs) / 1000;
    const M = this.n * dt;
    let E = M;
    for (let k = 0; k < 6; k += 1) {
      E -= (E - this.e * Math.sin(E) - M) / (1 - this.e * Math.cos(E));
    }
    const nu = 2 * Math.atan2(Math.sqrt(1 + this.e) * Math.sin(E / 2), Math.sqrt(1 - this.e) * Math.cos(E / 2));
    const r = this.a * (1 - this.e * Math.cos(E));
    const u = this.perigee0 + this.perigeeRate * dt + nu;
    const raan = this.raan0 + this.raanRate * dt;
    const cu = Math.cos(u);
    const su = Math.sin(u);
    const ci = Math.cos(this.inclination);
    out[0] = r * (Math.cos(raan) * cu - Math.sin(raan) * su * ci);
    out[1] = r * (Math.sin(raan) * cu + Math.cos(raan) * su * ci);
    out[2] = r * su * Math.sin(this.inclination);
    return out;
  }

  /** Where the satellite is in the observer's sky, whether sunlit, and how dark the sky is. */
  sample(timeMs: number, latitude: number, longitude: number, out: SatelliteSample, scratch: number[]) {
    const sat = this.position(timeMs, scratch);
    const theta = siderealAngle(timeMs) + longitude * DEG;
    const lat = latitude * DEG;
    const up = [Math.cos(lat) * Math.cos(theta), Math.cos(lat) * Math.sin(theta), Math.sin(lat)];
    const east = [-Math.sin(theta), Math.cos(theta), 0];
    const north = [-Math.sin(lat) * Math.cos(theta), -Math.sin(lat) * Math.sin(theta), Math.cos(lat)];
    const dx = sat[0] - EARTH_RADIUS_KM * up[0];
    const dy = sat[1] - EARTH_RADIUS_KM * up[1];
    const dz = sat[2] - EARTH_RADIUS_KM * up[2];
    const range = Math.hypot(dx, dy, dz);
    const dUp = (dx * up[0] + dy * up[1] + dz * up[2]) / range;
    const dEast = (dx * east[0] + dy * east[1]) / range;
    const dNorth = (dx * north[0] + dy * north[1] + dz * north[2]) / range;
    out.altitude = Math.asin(Math.max(-1, Math.min(1, dUp))) / DEG;
    out.azimuth = ((Math.atan2(dEast, dNorth) / DEG) % 360 + 360) % 360;
    const s = sunDirection(timeMs, this.sun);
    const along = sat[0] * s[0] + sat[1] * s[1] + sat[2] * s[2];
    const px = sat[0] - along * s[0];
    const py = sat[1] - along * s[1];
    const pz = sat[2] - along * s[2];
    // Height at which the sunlight grazes past the Earth on its way to the satellite.
    const grazing = along > 0 ? Infinity : Math.hypot(px, py, pz) - EARTH_RADIUS_KM;
    const t = Math.min(1, Math.max(0, (grazing - SHADOW_EDGE_KM[0]) / (SHADOW_EDGE_KM[1] - SHADOW_EDGE_KM[0])));
    out.sunlight = t * t * (3 - 2 * t);
    out.sunAltitude = Math.asin(Math.max(-1, Math.min(1, up[0] * s[0] + up[1] * s[1] + up[2] * s[2]))) / DEG;
    return out;
  }
}
