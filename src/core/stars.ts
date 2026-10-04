/**
 * Bright-star catalog (J2000 RA hours, Dec degrees, visual magnitude) and a fast
 * horizontal-coordinate transform. Precession is ignored (~0.4° drift over decades),
 * which is well below what the horizon view can resolve.
 */
const CATALOG: [string, number, number, number][] = [
  ['Sirius', 6.752, -16.716, -1.46],
  ['Canopus', 6.399, -52.696, -0.74],
  ['Rigil Kentaurus', 14.66, -60.834, -0.27],
  ['Arcturus', 14.261, 19.182, -0.05],
  ['Vega', 18.616, 38.784, 0.03],
  ['Capella', 5.278, 45.998, 0.08],
  ['Rigel', 5.242, -8.202, 0.13],
  ['Procyon', 7.655, 5.225, 0.34],
  ['Achernar', 1.629, -57.237, 0.46],
  ['Betelgeuse', 5.919, 7.407, 0.5],
  ['Hadar', 14.064, -60.373, 0.61],
  ['Altair', 19.846, 8.868, 0.76],
  ['Acrux', 12.443, -63.099, 0.76],
  ['Aldebaran', 4.599, 16.509, 0.86],
  ['Antares', 16.49, -26.432, 0.96],
  ['Spica', 13.42, -11.161, 0.97],
  ['Pollux', 7.755, 28.026, 1.14],
  ['Fomalhaut', 22.961, -29.622, 1.16],
  ['Deneb', 20.69, 45.28, 1.25],
  ['Mimosa', 12.795, -59.689, 1.25],
  ['Regulus', 10.139, 11.967, 1.35],
  ['Adhara', 6.977, -28.972, 1.5],
  ['Castor', 7.577, 31.888, 1.58],
  ['Shaula', 17.56, -37.104, 1.62],
  ['Gacrux', 12.519, -57.113, 1.63],
  ['Bellatrix', 5.419, 6.35, 1.64],
  ['Elnath', 5.438, 28.608, 1.65],
  ['Miaplacidus', 9.22, -69.717, 1.68],
  ['Alnilam', 5.604, -1.202, 1.69],
  ['Alnair', 22.137, -46.961, 1.74],
  ['Alnitak', 5.679, -1.943, 1.77],
  ['Alioth', 12.9, 55.96, 1.77],
  ['Dubhe', 11.062, 61.751, 1.79],
  ['Mirfak', 3.405, 49.861, 1.8],
  ['Regor', 8.159, -47.337, 1.83],
  ['Wezen', 7.14, -26.393, 1.83],
  ['Kaus Australis', 18.403, -34.385, 1.85],
  ['Sargas', 17.622, -42.998, 1.86],
  ['Avior', 8.375, -59.51, 1.86],
  ['Alkaid', 13.792, 49.313, 1.86],
  ['Menkalinan', 5.992, 44.948, 1.9],
  ['Atria', 16.811, -69.028, 1.91],
  ['Alhena', 6.629, 16.399, 1.92],
  ['Peacock', 20.427, -56.735, 1.94],
  ['Polaris', 2.53, 89.264, 1.98],
  ['Mirzam', 6.378, -17.956, 1.98],
  ['Alphard', 9.46, -8.659, 1.98],
  ['Hamal', 2.12, 23.462, 2.0],
  ['Algieba', 10.333, 19.842, 2.01],
  ['Diphda', 0.727, -17.987, 2.04],
  ['Nunki', 18.921, -26.297, 2.05],
  ['Mirach', 1.163, 35.621, 2.05],
  ['Menkent', 14.111, -36.37, 2.06],
  ['Alpheratz', 0.14, 29.091, 2.06],
  ['Rasalhague', 17.582, 12.56, 2.08],
  ['Kochab', 14.845, 74.156, 2.08],
  ['Saiph', 5.796, -9.67, 2.09],
  ['Almach', 2.065, 42.33, 2.1],
  ['Algol', 3.136, 40.956, 2.12],
  ['Denebola', 11.818, 14.572, 2.13],
  ['Suhail', 9.133, -43.433, 2.21],
  ['Aspidiske', 9.285, -59.275, 2.21],
  ['Mizar', 13.399, 54.925, 2.23],
  ['Sadr', 20.37, 40.257, 2.23],
  ['Alphecca', 15.578, 26.715, 2.23],
  ['Mintaka', 5.533, -0.299, 2.23],
  ['Schedar', 0.675, 56.537, 2.24],
  ['Eltanin', 17.943, 51.489, 2.24],
  ['Naos', 8.06, -40.003, 2.25],
  ['Caph', 0.153, 59.15, 2.28],
  ['Dschubba', 16.006, -22.622, 2.29],
  ['Larawag', 16.836, -34.293, 2.29],
  ['Alpha Lupi', 14.699, -47.388, 2.3],
  ['Eta Centauri', 14.592, -42.158, 2.31],
  ['Merak', 11.031, 56.383, 2.37],
  ['Izar', 14.75, 27.074, 2.37],
  ['Enif', 21.736, 9.875, 2.38],
  ['Ankaa', 0.438, -42.306, 2.4],
  ['Scheat', 23.063, 28.083, 2.42],
  ['Phecda', 11.897, 53.695, 2.44],
  ['Navi', 0.945, 60.717, 2.47],
  ['Aljanah', 20.77, 33.97, 2.48],
  ['Markab', 23.079, 15.205, 2.49],
  ['Menkar', 3.038, 4.09, 2.53],
  ['Zosma', 11.235, 20.524, 2.56],
  ['Arneb', 5.546, -17.822, 2.58],
  ['Ascella', 19.044, -29.88, 2.6],
  ['Zubeneschamali', 15.283, -9.383, 2.61],
  ['Unukalhai', 15.738, 6.426, 2.63],
  ['Sheratan', 1.911, 20.808, 2.64],
  ['Phact', 5.661, -34.074, 2.65],
  ['Muphrid', 13.911, 18.398, 2.68],
  ['Ruchbah', 1.43, 60.235, 2.68],
  ['Tarazed', 19.771, 10.613, 2.72],
  ['Porrima', 12.694, -1.449, 2.74],
  ['Imai', 12.252, -58.749, 2.79],
  ['Algenib', 0.22, 15.184, 2.83],
  ['Vindemiatrix', 13.036, 10.959, 2.83],
  ['Alcyone', 3.791, 24.105, 2.87],
  ['Deneb Algedi', 21.784, -16.127, 2.87],
  ['Acamar', 2.971, -40.305, 2.88],
  ['Sadalmelik', 22.096, -0.32, 2.95],
  ['Albireo', 19.512, 27.96, 3.08],
];

const DEG = Math.PI / 180;

export type StarTable = {
  count: number;
  ra: Float64Array; // radians
  sinDec: Float64Array;
  cosDec: Float64Array;
  mag: Float32Array;
};

export function createStarTable(): StarTable {
  const count = CATALOG.length;
  const table: StarTable = {
    count,
    ra: new Float64Array(count),
    sinDec: new Float64Array(count),
    cosDec: new Float64Array(count),
    mag: new Float32Array(count),
  };
  CATALOG.forEach(([, raHours, decDeg, mag], i) => {
    table.ra[i] = raHours * 15 * DEG;
    table.sinDec[i] = Math.sin(decDeg * DEG);
    table.cosDec[i] = Math.cos(decDeg * DEG);
    table.mag[i] = mag;
  });
  return table;
}

/** Local mean sidereal time in radians for a UTC epoch-ms timestamp and east longitude. */
export function localSiderealRadians(timeMs: number, longitudeDeg: number): number {
  const daysSinceJ2000 = timeMs / 86400000 + 2440587.5 - 2451545.0;
  const gmstDeg = 280.46061837 + 360.98564736629 * daysSinceJ2000;
  const lst = ((gmstDeg + longitudeDeg) % 360 + 360) % 360;
  return lst * DEG;
}

/**
 * Fill azimuth/altitude (degrees) for every star in the table.
 * Azimuth is measured from north through east, matching astronomy-engine.
 */
export function computeStarHorizon(
  table: StarTable,
  timeMs: number,
  latitudeDeg: number,
  longitudeDeg: number,
  outAz: Float32Array,
  outAlt: Float32Array
) {
  const lst = localSiderealRadians(timeMs, longitudeDeg);
  const sinLat = Math.sin(latitudeDeg * DEG);
  const cosLat = Math.cos(latitudeDeg * DEG);
  for (let i = 0; i < table.count; i += 1) {
    const hourAngle = lst - table.ra[i];
    const sinH = Math.sin(hourAngle);
    const cosH = Math.cos(hourAngle);
    const sinDec = table.sinDec[i];
    const cosDec = table.cosDec[i];
    const sinAlt = sinLat * sinDec + cosLat * cosDec * cosH;
    outAlt[i] = Math.asin(Math.max(-1, Math.min(1, sinAlt))) / DEG;
    let az = Math.atan2(-cosDec * sinH, sinDec * cosLat - cosDec * sinLat * cosH) / DEG;
    if (az < 0) {
      az += 360;
    }
    outAz[i] = az;
  }
}
