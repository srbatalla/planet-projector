import { LANDINGS, NOTES, SATELLITES, SatelliteOrbit, type LunarLanding, type SatelliteSample } from '../../core/history';
import { BEHIND_CAMERA, type Point, type SkyProjection } from './projection';

/** Recorded passes fade over this much simulated time, like star trails. */
const FADE_MS = 3 * 3600 * 1000;
const WINDOW_MS = 3 * FADE_MS;
/** Sampling: coarse while far below the horizon, fine (smooth arcs) near and above it. */
const COARSE_MS = 20000;
const FINE_MS = 2000;
const NEAR_HORIZON = -12;
/** A pass shows only once the observer's sky is dark enough for a sunlit satellite to stand out. */
const DARK_SUN_ALTITUDE = -4;
const BANDS = 6;

/** `light`: how brightly it shows (sunlit and against a dark enough sky), 0..1. */
type TrackPoint = { t: number; az: number; alt: number; light: number };

type Track = {
  orbit: SatelliteOrbit;
  points: TrackPoint[];
  /** Samples cover [from, until]. */
  from: number;
  until: number;
};

type HistoryEvent = { id: string; from: number; to: number; note: string; needsMoon: boolean };

/**
 * Easter eggs in the horizon views: historic satellites streak across the sky on their real
 * dates (sunlit, against a dark sky, cut off by Earth's shadow), and dated notes are announced
 * once per run when the clock passes them.
 */
export class HistoryLayer {
  private readonly tracks: Track[];
  private readonly events: HistoryEvent[];
  private readonly fired = new Set<string>();
  private readonly sample: SatelliteSample = { azimuth: 0, altitude: 0, sunlight: 0, sunAltitude: 0 };
  private readonly scratch = [0, 0, 0];
  private readonly point: Point = { x: 0, y: 0 };
  private lastMs = Number.NaN;

  constructor(
    private readonly latitude: number,
    private readonly longitude: number,
    private readonly moonAltitudeAt: (timeMs: number) => number,
    private readonly onEvent: (note: string) => void
  ) {
    this.tracks = SATELLITES.map((satellite) => ({ orbit: new SatelliteOrbit(satellite), points: [], from: 0, until: Number.NaN }));
    this.events = [
      ...SATELLITES.map((satellite) => ({
        id: satellite.id,
        from: satellite.launchMs,
        to: Math.min(satellite.endMs, satellite.launchMs + 36 * 3600 * 1000),
        note: satellite.note,
        needsMoon: false,
      })),
      ...LANDINGS.map((landing) => ({ id: landing.id, from: landing.touchdownMs, to: landing.liftoffMs, note: landing.note, needsMoon: true })),
      ...NOTES.map((note) => {
        // The V-2's hour is unknown, so its note spans the day; the others last an hour or two.
        const span = note.needsMoon ? 2 * 3600 * 1000 : 12 * 3600 * 1000;
        return { id: note.id, from: note.atMs - (note.needsMoon ? 0 : span), to: note.atMs + span, note: note.note, needsMoon: note.needsMoon === true };
      }),
    ];
  }

  /** Lunar landing in progress at `timeMs` (crew on the surface), for marking the Moon. */
  landingAt(timeMs: number): LunarLanding | null {
    for (const landing of LANDINGS) {
      if (timeMs >= landing.touchdownMs && timeMs <= landing.liftoffMs) {
        return landing;
      }
    }
    return null;
  }

  /** Advance to `nowMs`: fire notes the clock has passed and extend satellite tracks. */
  update(nowMs: number) {
    const previous = Number.isNaN(this.lastMs) ? nowMs : this.lastMs;
    this.lastMs = nowMs;
    const lo = Math.min(previous, nowMs);
    const hi = Math.max(previous, nowMs);
    for (const event of this.events) {
      if (this.fired.has(event.id) || hi < event.from || lo > event.to) {
        continue;
      }
      const at = Math.max(event.from, Math.min(event.to, nowMs));
      if (event.needsMoon && this.moonAltitudeAt(at) < 0) {
        continue;
      }
      this.fired.add(event.id);
      this.onEvent(event.note);
    }
    for (const track of this.tracks) {
      this.extend(track, nowMs);
    }
  }

  private extend(track: Track, nowMs: number) {
    const start = track.orbit.startMs;
    const end = track.orbit.endMs;
    if (nowMs < start || nowMs > end + WINDOW_MS) {
      track.points.length = 0;
      track.until = Number.NaN;
      return;
    }
    // First frame, rewound past the recorded stretch, or jumped far ahead: start recording now,
    // like every other trail (nothing is drawn for time the run did not play through).
    if (Number.isNaN(track.until) || nowMs < track.from || nowMs - track.until > WINDOW_MS) {
      track.points.length = 0;
      track.from = Math.max(start, nowMs - 60000);
      track.until = track.from;
    } else if (nowMs < track.until) {
      while (track.points.length > 0 && track.points[track.points.length - 1].t > nowMs) {
        track.points.pop();
      }
      track.until = nowMs;
    }
    const stop = Math.min(nowMs, end);
    let t = track.until;
    let previousAlt = -90;
    let previousT = t;
    let fine = false;
    while (t <= stop) {
      track.orbit.sample(t, this.latitude, this.longitude, this.sample, this.scratch);
      const alt = this.sample.altitude;
      if (!fine && alt >= NEAR_HORIZON && previousAlt < NEAR_HORIZON && t > previousT) {
        // Coarse step overshot into a pass: back up and take it finely.
        fine = true;
        t = previousT + FINE_MS;
        continue;
      }
      fine = alt >= NEAR_HORIZON;
      if (alt >= -3) {
        const light = this.sample.sunAltitude < DARK_SUN_ALTITUDE ? this.sample.sunlight : 0;
        track.points.push({ t, az: this.sample.azimuth, alt, light });
        // Its note, on the first pass the run actually shows (if the launch did not announce it).
        const satellite = track.orbit.satellite;
        if (light > 0.5 && alt > 3 && !this.fired.has(satellite.id)) {
          this.fired.add(satellite.id);
          this.onEvent(satellite.note);
        }
      }
      previousAlt = alt;
      previousT = t;
      t += fine ? FINE_MS : COARSE_MS;
    }
    track.until = Math.max(track.until, Math.min(t, stop));
    // Forget what has faded.
    const keepFrom = nowMs - WINDOW_MS;
    let drop = 0;
    while (drop < track.points.length && track.points[drop].t < keepFrom) {
      drop += 1;
    }
    if (drop > 0) {
      track.points.splice(0, drop);
      track.from = keepFrom;
    }
  }

  /**
   * Draw recorded passes (fading with age) and label any satellite in view right now. Near Earth's
   * shadow a pass dims and warms to sunset colours, as its last sunlight crosses the atmosphere.
   */
  draw(ctx: CanvasRenderingContext2D, projection: SkyProjection, nowMs: number) {
    const p = this.point;
    for (const track of this.tracks) {
      const points = track.points;
      if (points.length < 2) {
        continue;
      }
      // Bands: brightness level × colour (0 sunlit white, 1 reddened near the shadow).
      const paths = Array.from({ length: BANDS * 2 }, () => new Path2D());
      let drew = false;
      let prevX = 0;
      let prevY = 0;
      let prevOk = false;
      let prevT = 0;
      let prevLight = 0;
      for (const point of points) {
        projection.project(point.az, point.alt, p);
        const ok = point.alt >= projection.cutoffAltitude(point.az) && p.x !== BEHIND_CAMERA && point.t <= nowMs;
        if (ok && prevOk && point.t - prevT <= FINE_MS * 1.5) {
          const light = (point.light + prevLight) / 2;
          const fade = Math.exp(-Math.max(0, nowMs - point.t) / FADE_MS) * light;
          if (fade > 0.03) {
            const band = Math.min(BANDS - 1, Math.floor(fade * BANDS));
            const warm = light < 0.85 ? 1 : 0;
            paths[warm * BANDS + band].moveTo(prevX, prevY);
            paths[warm * BANDS + band].lineTo(p.x, p.y);
            drew = true;
          }
        }
        prevX = p.x;
        prevY = p.y;
        prevOk = ok;
        prevT = point.t;
        prevLight = point.light;
      }
      if (!drew) {
        continue;
      }
      ctx.save();
      ctx.lineCap = 'round';
      for (let index = 0; index < paths.length; index += 1) {
        const alpha = ((index % BANDS) + 0.5) / BANDS;
        ctx.strokeStyle = index < BANDS ? '#fff6e0' : '#ffb37a';
        ctx.globalAlpha = 0.16 * alpha;
        ctx.lineWidth = 4;
        ctx.stroke(paths[index]);
        ctx.globalAlpha = 0.9 * alpha;
        ctx.lineWidth = 1.3;
        ctx.stroke(paths[index]);
      }
      // The satellite itself while it is in view.
      const head = points[points.length - 1];
      if (head.light > 0.05 && nowMs - head.t <= FINE_MS * 1.5 && head.alt >= projection.cutoffAltitude(head.az)) {
        projection.project(head.az, head.alt, p);
        if (p.x !== BEHIND_CAMERA) {
          ctx.globalAlpha = head.light;
          ctx.fillStyle = head.light < 0.85 ? '#ffc896' : '#fffaf0';
          ctx.beginPath();
          ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2);
          ctx.fill();
          ctx.font = '11px "JetBrains Mono", "Fira Code", ui-monospace, monospace';
          ctx.fillStyle = 'rgba(255, 244, 220, 0.85)';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'bottom';
          ctx.fillText(track.orbit.satellite.label, p.x + 8, p.y - 5);
        }
      }
      ctx.restore();
    }
  }
}
