export type SpecialObject = {
  id: string;
  name: string;
  /** Marker label and chip text. */
  shortName: string;
  description: string;
  color: string;
  orbitalElements: {
    semiMajorAxisAu: number;
    eccentricity: number;
    inclinationDeg: number;
    longitudeAscendingNodeDeg: number;
    argumentPeriapsisDeg: number;
    meanAnomalyAtEpochDeg: number;
    epochJd: number;
  };
};

export const SPECIAL_OBJECTS: SpecialObject[] = [
  {
    id: 'tesla-roadster',
    name: "Musk's Tesla Roadster",
    shortName: 'Roadster',
    description: 'Falcon Heavy dummy payload (2018)',
    color: '#ff4f4f',
    orbitalElements: {
      semiMajorAxisAu: 1.324,
      eccentricity: 0.255,
      inclinationDeg: 1.1,
      longitudeAscendingNodeDeg: 317.2,
      argumentPeriapsisDeg: 177.6,
      meanAnomalyAtEpochDeg: 0,
      epochJd: 2458152.5,
    },
  },
  {
    id: 'apollo-snoopy',
    name: 'Apollo 10 LM (Snoopy)',
    shortName: 'Snoopy',
    description: 'LM-4 Snoopy ascent stage (1969)',
    color: '#d0d0d0',
    orbitalElements: {
      semiMajorAxisAu: 1.0,
      eccentricity: 0.5,
      inclinationDeg: 0.0,
      longitudeAscendingNodeDeg: 0.0,
      argumentPeriapsisDeg: 0.0,
      meanAnomalyAtEpochDeg: 0.0,
      epochJd: 2440366.5,
    },
  },
  {
    id: 'halley',
    name: "Halley's Comet",
    shortName: 'Halley',
    description: '1P/Halley, perihelion 1986 Feb 9',
    color: '#9fe8ff',
    orbitalElements: {
      semiMajorAxisAu: 17.834,
      eccentricity: 0.96714,
      inclinationDeg: 162.26,
      longitudeAscendingNodeDeg: 58.42,
      argumentPeriapsisDeg: 111.33,
      meanAnomalyAtEpochDeg: 0,
      epochJd: 2446470.96,
    },
  },
  {
    id: 'ceres',
    name: 'Ceres',
    shortName: 'Ceres',
    description: 'Dwarf planet in the asteroid belt; perihelion 2022 Dec 7',
    color: '#b8ab98',
    orbitalElements: {
      semiMajorAxisAu: 2.7675,
      eccentricity: 0.0785,
      inclinationDeg: 10.587,
      longitudeAscendingNodeDeg: 80.267,
      argumentPeriapsisDeg: 73.63,
      meanAnomalyAtEpochDeg: 291.4,
      epochJd: 2459600.5,
    },
  },
  {
    id: 'encke',
    name: 'Comet Encke',
    shortName: 'Encke',
    description: '2P/Encke, shortest-period bright comet (3.3 yr); perihelion 2023 Oct 22',
    color: '#9dffc9',
    orbitalElements: {
      semiMajorAxisAu: 2.215,
      eccentricity: 0.8483,
      inclinationDeg: 11.78,
      longitudeAscendingNodeDeg: 334.57,
      argumentPeriapsisDeg: 186.54,
      meanAnomalyAtEpochDeg: 0,
      epochJd: 2460240.1,
    },
  },
  {
    id: 'hale-bopp',
    name: 'Comet Hale-Bopp',
    shortName: 'Hale-Bopp',
    description: 'C/1995 O1, the great comet of 1997; perihelion 1997 Apr 1',
    color: '#82b6ff',
    orbitalElements: {
      semiMajorAxisAu: 186.0,
      eccentricity: 0.995086,
      inclinationDeg: 89.43,
      longitudeAscendingNodeDeg: 282.47,
      argumentPeriapsisDeg: 130.59,
      meanAnomalyAtEpochDeg: 0,
      epochJd: 2450539.63,
    },
  },
  {
    id: 'oumuamua',
    name: 'ʻOumuamua',
    shortName: 'ʻOumuamua',
    description: '1I/2017 U1, first known interstellar object (hyperbolic); perihelion 2017 Sep 9',
    color: '#ffab73',
    orbitalElements: {
      semiMajorAxisAu: -1.2695,
      eccentricity: 1.20113,
      inclinationDeg: 122.74,
      longitudeAscendingNodeDeg: 24.597,
      argumentPeriapsisDeg: 241.81,
      meanAnomalyAtEpochDeg: 0,
      epochJd: 2458006.01,
    },
  },
  {
    id: 'borisov',
    name: '2I/Borisov',
    shortName: 'Borisov',
    description: 'Interstellar comet (hyperbolic); perihelion 2019 Dec 8',
    color: '#d5a8ff',
    orbitalElements: {
      semiMajorAxisAu: -0.85147,
      eccentricity: 3.35653,
      inclinationDeg: 44.0526,
      longitudeAscendingNodeDeg: 308.149,
      argumentPeriapsisDeg: 209.124,
      meanAnomalyAtEpochDeg: 0,
      epochJd: 2458826.05,
    },
  },
];
