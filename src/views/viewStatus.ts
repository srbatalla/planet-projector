/** Snapshot a view reports to the HUD a few times per second. */
export type ViewStatus = {
  /** Absolute UTC epoch ms of the frame being shown. */
  timeMs: number;
  elapsedMs: number;
  targets: { id: string; label: string; color: string }[];
  /** Ids of targets currently above the horizon (horizon view) or traced (spirograph). */
  visible: string[];
  /** Horizon view is fast-forwarding to the next rise. */
  waiting: boolean;
  /** Cycle limit reached: the image is final. */
  finished: boolean;
  fps: number;
  /** Main-thread time spent in the frame callback. */
  frameWorkMs: number;
  paused: boolean;
};

/**
 * Simulations stop here: JS Dates end at ±8.64e15 ms and ephemeris calls throw past it.
 * (~year 255,000 — reachable within minutes in spirograph overdrive with coarse steps.)
 */
export const MAX_EPOCH_MS = 8e15;
