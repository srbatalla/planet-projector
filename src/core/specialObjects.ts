export type SpecialObject = {
  id: string;
  name: string;
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
];
