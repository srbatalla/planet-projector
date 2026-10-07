import { Body, Illumination, Observer, SearchAltitude } from 'astronomy-engine';
import { computeHorizonPoint, type HorizonSample } from '../../core/astro';
import { CanvasSurface, createLayerCanvas, observeResize } from '../../render/canvas';
import { drawMarkerLabel, LabelLayout, MARKER_LABEL_FONT } from '../../render/labels';
import { PlanetRenderer } from './planetRenderer';
import { BEHIND_CAMERA, createProjection, type Point, type ProjectionKind, type SkyProjection } from './projection';
import { NIGHT_LIGHT, type LandscapeKind, type SceneLight } from './landscape';
import { daylightWash, moonlightStrength, NIGHT_SKY, skyColors, skyColorValues, starVisibility } from './sky';
import { StarField, type StarMode } from './starField';
import { CloudLayer, type CloudMode } from './cloudLayer';
import { MilkyWayLayer } from './milkyWay';
import { EclipseModel, eclipsedSunAltitude, type EclipseState } from './eclipse';
import { HistoryLayer } from './historyLayer';
import {
  DEFAULT_MARKER_RADIUS,
  drawEclipsedSun,
  drawMoonDisc,
  drawSunGlow,
  MOON_MARKER_RADIUS,
  radiusForMagnitude,
  stepToward,
  SUN_MARKER_RADIUS,
  usesMagnitude,
} from './markers';
import type { TrailStyle } from './trailPath';
import { MAX_EPOCH_MS, type ViewStatus } from '../viewStatus';
import type { SkyTarget } from '../targets';

export type HorizonVisuals = {
  projection: ProjectionKind;
  stars: StarMode;
  skyTint: boolean;
  lineWidth: number;
  trailStyle: TrailStyle;
  /** Brightness trails keep once their fresh glow fades (with a sweep fade rate). */
  settledBrightness: number;
  labels: boolean;
  clouds: CloudMode;
  cloudCover: number;
  milkyWay: boolean;
  /** Camera and landscape for the perspective (Scene) projection. */
  scene: { heading: number; tilt: number; fov: number; landscape: LandscapeKind };
};

type MultiPlanetViewConfig = {
  targets: SkyTarget[];
  observer: Observer;
  sampleMinutes: number;
  startTime: Date;
  playbackSpeed: number;
  jumpSetting: number;
  trailPersistence: number;
  cycleLimit: number;
  activeFadeRate: number;
  azimuthCheckpointInterval: number;
  visuals: HorizonVisuals;
  /** Scene camera moved by a drag, pinch or wheel on the sky (so settings and the link follow). */
  onSceneCameraChange?: (camera: { heading: number; tilt: number; fov: number }) => void;
  /** A historical Easter egg came into play (a spacecraft launch, a Moon landing): its note. */
  onHistoryEvent?: (note: string) => void;
};

/**
 * Inside the polar circles bodies can stay up for most of a day (or never set): their arcs are not
 * filled in from the rise at a start or landing, which would draw near-full circles at once.
 */
const POLAR_CIRCLE_LATITUDE = 66.56;
/** No rise within this long before a start: the body never set, so its trail opens where it is. */
const MAX_BACKFILL_MS = 23 * 3600 * 1000;

/** With the day/night sky, skip-ahead lands only once the Sun is this far down (civil dusk). */
const NIGHT_LANDING_ALTITUDE = -6;

/** Scene camera limits for gestures (degrees). */
const TILT_RANGE: [number, number] = [-10, 60];
const FOV_RANGE: [number, number] = [25, 120];

type VisibilityState = {
  sample: HorizonSample;
  timeMs: number;
  horizonAlt: number;
  visibilityValue: number;
};

type VisiblePlanetSample = {
  renderer: PlanetRenderer;
  previewSample: HorizonSample;
};

type PendingEntry = {
  sample: HorizonSample;
  timeMs: number;
};

const MAX_LOOKAHEAD_HOURS = 400;
/** Longer frames (background tab, debugger) are clamped so we never simulate a burst of steps. */
const MAX_FRAME_DELTA_MS = 100;
/**
 * Main-thread budget for simulation steps per frame. Past it the leftover time is dropped:
 * slow devices see a slower sky instead of a feedback loop of ever-longer frames.
 */
const STEP_BUDGET_MS = 8;
/** …and never more than this share of the measured frame interval (120 Hz displays get ~4 ms). */
const STEP_BUDGET_FRAME_SHARE = 0.5;

export class MultiPlanetView {
  private surface: CanvasSurface;
  private animationHandle: number | null = null;
  private lastFrameTime: number | null = null;
  private readonly stepMs: number;
  private readonly baseTimestamp: number;

  // Simulation state
  private simTimeMs = 0;
  private remainderMs = 0;
  private jumpSetting: number;
  private paused = false;
  private started = false;

  // Planet renderers - one per enabled body
  private planetRenderers: PlanetRenderer[] = [];

  // Projection, static layers and the shared history composite
  private projection: SkyProjection;
  private groundLayer: HTMLCanvasElement | null = null;
  /** Displayed history composite, and the one being rebuilt a body at a time. */
  private historyLayer: HTMLCanvasElement | null = null;
  private backLayer: HTMLCanvasElement | null = null;
  private backCtx: CanvasRenderingContext2D | null = null;
  private readonly flushCtx = createLayerCanvas(1, 1).getContext('2d');
  private historyLayerDirty = true;
  private historyHasContent = false;
  private backHasContent = false;
  private rebuildQueue: PlanetRenderer[] = [];
  private rebuildCursor = -1;
  private lastHistoryRebuildAt = -Infinity;
  private historyRebuildCostMs = 0;
  private readonly starField: StarField;
  private readonly cloudLayer: CloudLayer;
  private readonly milkyWay: MilkyWayLayer;
  private moonPhase = 0;
  private moonPhaseAtMs = Number.NaN;
  private readonly markerSun = { azimuth: 0, altitude: -90, atMs: Number.NaN };
  private readonly markerStep = { azimuth: 0, altitude: 0 };
  /** Planet marker radii from apparent magnitude, refreshed for one body per frame. */
  private readonly markerRadii = new Map<PlanetRenderer, { radius: number; atMs: number }>();
  private markerRefreshCursor = 0;
  private readonly labelLayout = new LabelLayout();
  private lastSimDeltaMs = 0;
  private readonly sunObserverDate = new Date();

  private completedPassRenderers = new Set<PlanetRenderer>();
  private finishedRenderers = new Set<PlanetRenderer>();
  private pendingEntryTargets = new Map<PlanetRenderer, PendingEntry>();
  private pendingJumpSetting: number | null = null;
  private spawnWithoutHistory = new Set<PlanetRenderer>();
  private simulationFrozen = false;
  private readonly point: Point = { x: 0, y: 0 };
  private readonly isVisible = (sample: HorizonSample) => this.isSampleVisible(sample);

  // Frame statistics (exponential moving averages)
  private frameIntervalEma = 16.7;
  private frameWorkEma = 0;
  private lastFrameDurationMs = 16;
  private lastVisible: VisiblePlanetSample[] = [];
  private readonly eclipseModel: EclipseModel;
  private readonly history: HistoryLayer;
  /** Solar eclipse at the observer for the frame last rendered (null most of the time). */
  private eclipse: EclipseState | null = null;
  private rockBuffer: HTMLCanvasElement | null = null;
  /** Clock for the boat's swell: runs with real time while playing, holds still while paused. */
  private swellMs = 0;
  /** While the Scene camera is moving, trails are drawn live instead of from the stale cache. */
  private cameraMovingUntil = 0;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private gesture: { heading: number; tilt: number; fov: number; x: number; y: number; distance: number; focal: number } | null = null;
  private dragged = false;
  private pendingCamera: { heading: number; tilt: number; fov: number } | null = null;
  private cameraFrame: number | null = null;
  private disconnectResize: (() => void) | null = null;

  constructor(private container: HTMLElement, private config: MultiPlanetViewConfig) {
    this.stepMs = Math.max(1, this.config.sampleMinutes * 60 * 1000);
    this.baseTimestamp = this.config.startTime.getTime();
    this.jumpSetting = this.config.jumpSetting;
    this.eclipseModel = new EclipseModel(this.config.observer);
    this.history = new HistoryLayer(
      this.config.observer.latitude,
      this.config.observer.longitude,
      (timeMs) => computeHorizonPoint({ body: Body.Moon, observer: this.config.observer, time: new Date(timeMs) }).altitude,
      (note) => this.config.onHistoryEvent?.(note)
    );

    const canvas = document.createElement('canvas');
    this.container.appendChild(canvas);
    this.surface = new CanvasSurface(canvas);

    this.projection = this.makeProjection();
    this.projection.setSize(this.surface.width, this.surface.height);
    this.starField = new StarField(
      config.visuals.stars,
      config.observer.latitude,
      config.observer.longitude
    );
    // Seeded by the start minute: the same run always has the same weather.
    this.cloudLayer = new CloudLayer(
      config.visuals.clouds,
      config.visuals.cloudCover,
      Math.floor(this.baseTimestamp / 60000)
    );
    this.cloudLayer.resize(this.projection, this.surface.width, this.surface.height, this.surface.pixelRatio);
    this.starField.setOcclusion((x, y) => this.cloudLayer.densityAt(x, y));
    this.milkyWay = new MilkyWayLayer(config.visuals.milkyWay, config.observer.latitude, config.observer.longitude);
    this.milkyWay.resize(this.projection, this.surface.width, this.surface.height, this.surface.pixelRatio);

    this.createPlanetRenderers();
    this.simulationFrozen = this.planetRenderers.length === 0;
    this.rebuildStaticLayers();
    this.attachCameraGestures(canvas);
  }

  get canvas() {
    return this.surface.canvas;
  }

  /** The projection for the current visuals; the Scene's landscape is seeded by the location. */
  private makeProjection() {
    const { latitude, longitude } = this.config.observer;
    const seed = Math.round((latitude + 90) * 1000) * 7919 + Math.round((longitude + 180) * 1000);
    return createProjection(this.config.visuals.projection, { ...this.config.visuals.scene, seed });
  }

  /** Sun, Moon and sky colours for projections whose landscape responds to light. */
  private sceneLight(
    sun: { altitude: number; azimuth: number },
    moon: { altitude: number; azimuth: number; light: number },
    trueSunAltitude = sun.altitude
  ): SceneLight {
    if (!this.config.visuals.skyTint) {
      return NIGHT_LIGHT;
    }
    const colors = skyColorValues(sun.altitude, moon.light);
    return {
      sunAltitude: sun.altitude,
      sunTrueAltitude: trueSunAltitude,
      eclipse: this.eclipse?.darkness ?? 0,
      sunAzimuth: sun.azimuth,
      moonAltitude: moon.altitude,
      moonAzimuth: moon.azimuth,
      moonLight: moon.light,
      horizon: colors.horizon,
      zenith: colors.zenith,
    };
  }

  private createPlanetRenderers() {
    for (const target of this.config.targets) {
      this.planetRenderers.push(this.createRenderer(target));
    }
  }

  private createRenderer(target: SkyTarget) {
    return new PlanetRenderer(
      {
        target,
        observer: this.config.observer,
        baseTimestamp: this.baseTimestamp,
        trailPersistence: this.config.trailPersistence,
        azimuthCheckpointInterval: this.config.azimuthCheckpointInterval,
        activeFadeRate: this.config.activeFadeRate,
        cycleLimit: this.config.cycleLimit,
        lineWidth: this.config.visuals.lineWidth,
        trailStyle: this.config.visuals.trailStyle,
        settledBrightness: this.config.visuals.settledBrightness,
      },
      this.isVisible
    );
  }

  private destroyRenderer(renderer: PlanetRenderer) {
    renderer.reset();
    this.spawnWithoutHistory.delete(renderer);
    this.finishedRenderers.delete(renderer);
    this.historyLayerDirty = true;
  }

  start() {
    if (this.started) {
      return;
    }
    this.started = true;
    this.disconnectResize = observeResize(this.container, this.handleResize);

    if (this.planetRenderers.length > 0) {
      this.seedInitialEntries();
    }
    this.scheduleFrame();
  }

  /**
   * Start at the chosen moment. Bodies already up have their arcs filled in from where they rose,
   * so every trail climbs out of the horizon; the rest wait for their rise. With skip-ahead on and
   * nothing up, the run goes straight to the first rise (after dark with the day/night sky).
   */
  private seedInitialEntries() {
    const anyUp = this.planetRenderers.some((renderer) => this.isSampleDrawable(renderer.computeSampleAt(this.simTimeMs)));
    if (!anyUp && this.jumpSetting !== 1) {
      let earliest: number | null = null;
      for (const renderer of this.planetRenderers) {
        const entry = this.seekNextVisibleSample(renderer, this.simTimeMs, 0);
        if (entry && (earliest === null || this.isEarlierInPlay(entry.timeMs, earliest))) {
          earliest = entry.timeMs;
        }
      }
      if (earliest !== null) {
        this.simTimeMs = this.chooseNightLanding(earliest);
        this.remainderMs = 0;
      }
    }
    this.seedRenderersAt(this.simTimeMs);
  }

  /**
   * With the day/night sky on, skip-ahead never lands in daylight: a rise during the day is
   * picked up at that evening's dusk instead, so every cut goes from night to night and the sky
   * keeps a steady rhythm. Returns `timeMs` unchanged when it is already dark (or in polar day).
   */
  private nightLanding(timeMs: number): number {
    // Tracing the Sun means following its day, so its rises are left where they are.
    if (!this.config.visuals.skyTint || this.planetRenderers.some((renderer) => renderer.target.body === Body.Sun)) {
      return timeMs;
    }
    const date = new Date(this.baseTimestamp + timeMs);
    const sun = computeHorizonPoint({ body: Body.Sun, observer: this.config.observer, time: date });
    if (sun.altitude <= NIGHT_LANDING_ALTITUDE) {
      return timeMs;
    }
    const dusk = SearchAltitude(Body.Sun, this.config.observer, -1, date, 2, NIGHT_LANDING_ALTITUDE);
    return dusk ? dusk.date.getTime() - this.baseTimestamp : timeMs;
  }

  /**
   * Paint a body's arc from where it rose (in play order) up to `timeMs`, step by step along its
   * real path, so a trail that is already up still climbs out of the horizon. Inside the polar
   * circles, or for a body that has not set for a day, the trail opens where the body is instead.
   */
  private backfillArc(renderer: PlanetRenderer, timeMs: number) {
    const now = renderer.computeSampleAt(timeMs);
    const entry = this.findArcEntryPoint(renderer, timeMs);
    const polar = Math.abs(this.config.observer.latitude) >= POLAR_CIRCLE_LATITUDE;
    const neverSet = this.isSampleVisible(entry.sample) && Math.abs(timeMs - entry.timeMs) >= MAX_BACKFILL_MS;
    if (polar || neverSet) {
      renderer.setLastVisibleSample(now, timeMs);
      return;
    }
    const step = this.direction * this.stepMs;
    let previous = entry.sample;
    let previousTime = entry.timeMs;
    for (let t = entry.timeMs + step; this.isEarlierInPlay(t, timeMs); t += step) {
      const sample = renderer.computeSampleAt(t);
      renderer.paintSegment(previous, previousTime, sample, t);
      previous = sample;
      previousTime = t;
    }
    if (previousTime !== timeMs) {
      renderer.paintSegment(previous, previousTime, now, timeMs);
    }
    renderer.setLastVisibleSample(now, timeMs);
  }

  /**
   * Night landing for a rise at `riseMs`. If nothing is up at that dusk (every body rises and
   * sets by day), look on to the next rise and its dusk, so a cut never lands on an empty night.
   */
  private chooseNightLanding(riseMs: number): number {
    let candidate = riseMs;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const landing = this.nightLanding(candidate);
      if (landing === candidate) {
        return landing;
      }
      let nextRise: number | null = null;
      for (const renderer of this.planetRenderers) {
        if (this.finishedRenderers.has(renderer)) {
          continue;
        }
        if (this.isSampleDrawable(renderer.computeSampleAt(landing))) {
          return landing;
        }
        const entry = this.seekNextVisibleSample(renderer, landing, 0);
        if (entry && (nextRise === null || entry.timeMs < nextRise)) {
          nextRise = entry.timeMs;
        }
      }
      if (nextRise === null) {
        return landing;
      }
      candidate = nextRise;
    }
    return this.nightLanding(candidate);
  }

  /** Start every body afresh at `timeMs` (the current sim time): see `initializeRendererEntry`. */
  private seedRenderersAt(timeMs: number) {
    this.simTimeMs = timeMs;
    this.pendingEntryTargets.clear();
    this.completedPassRenderers.clear();
    this.spawnWithoutHistory.clear();
    for (const renderer of this.planetRenderers) {
      if (!this.finishedRenderers.has(renderer)) {
        this.initializeRendererEntry(renderer);
      }
    }
  }

  stop() {
    if (this.animationHandle !== null) {
      cancelAnimationFrame(this.animationHandle);
      this.animationHandle = null;
    }
    this.disconnectResize?.();
    this.disconnectResize = null;
    this.started = false;
  }

  setPaused(paused: boolean) {
    if (paused === this.paused) {
      return;
    }
    this.paused = paused;
    if (paused) {
      if (this.animationHandle !== null) {
        cancelAnimationFrame(this.animationHandle);
        this.animationHandle = null;
      }
    } else {
      this.lastFrameTime = null;
      this.scheduleFrame();
    }
  }

  private scheduleFrame() {
    if (this.animationHandle === null && this.started && !this.paused) {
      this.animationHandle = requestAnimationFrame(this.loop);
    }
  }

  /** +1 forward, −1 rewinding (negative playback speed). */
  private get direction() {
    return this.config.playbackSpeed < 0 ? -1 : 1;
  }

  /** Sim time shown this frame: the last step plus progress toward the next, in play direction. */
  private get previewTimeMs() {
    return this.simTimeMs + this.direction * this.remainderMs;
  }

  updatePlaybackSpeed(newSpeed: number) {
    const previousDirection = this.direction;
    const magnitude = Math.max(1, Math.abs(newSpeed));
    this.config.playbackSpeed = newSpeed < 0 ? -magnitude : magnitude;
    if (this.direction !== previousDirection) {
      this.reverseDirection();
    }
  }

  /**
   * Time changed direction. Bodies on screen keep drawing (their trail now grows back along
   * where they came from); bodies waiting for their next arc re-seek it in the new direction.
   * Skip-ahead only runs forward, so sweep tracking starts afresh.
   */
  private reverseDirection() {
    this.remainderMs = 0;
    this.pendingEntryTargets.clear();
    this.completedPassRenderers.clear();
    this.spawnWithoutHistory.clear();
    for (const renderer of this.planetRenderers) {
      if (!this.finishedRenderers.has(renderer) && !renderer.getLastVisibleSample()) {
        this.initializeRendererEntry(renderer);
      }
    }
    this.starField.markJump();
  }

  /** True when `a` comes before `b` in the current playback direction. */
  private isEarlierInPlay(a: number, b: number) {
    return this.direction > 0 ? a < b : a > b;
  }

  updateVisuals(visuals: HorizonVisuals) {
    const previous = this.config.visuals;
    this.config.visuals = visuals;
    const sceneChanged =
      visuals.projection === 'perspective' &&
      (Object.keys(visuals.scene) as (keyof HorizonVisuals['scene'])[]).some((key) => visuals.scene[key] !== previous.scene[key]);
    const cameraOnly =
      sceneChanged &&
      previous.projection === 'perspective' &&
      visuals.scene.landscape === previous.scene.landscape &&
      this.projection.setCamera !== undefined;
    if (cameraOnly) {
      this.aimCamera();
    } else if (visuals.projection !== previous.projection || sceneChanged) {
      this.projection = this.makeProjection();
      this.projection.setSize(this.surface.width, this.surface.height);
      this.rebuildStaticLayers();
      this.starField.invalidate();
      this.cloudLayer.resize(this.projection, this.surface.width, this.surface.height, this.surface.pixelRatio);
      this.milkyWay.resize(this.projection, this.surface.width, this.surface.height, this.surface.pixelRatio);
    }
    this.starField.setMode(visuals.stars);
    this.cloudLayer.setMode(visuals.clouds, visuals.cloudCover);
    this.milkyWay.setEnabled(visuals.milkyWay);
    if (
      visuals.lineWidth !== previous.lineWidth ||
      visuals.trailStyle !== previous.trailStyle ||
      visuals.settledBrightness !== previous.settledBrightness
    ) {
      for (const renderer of this.planetRenderers) {
        renderer.setStyle(visuals.lineWidth, visuals.trailStyle, visuals.settledBrightness);
      }
    }
    this.historyLayerDirty = true;
    this.renderStill();
  }

  updateJumpSetting(newSetting: number) {
    const normalized = Math.min(12, Math.max(1, Math.round(newSetting)));
    if (this.pendingJumpSetting === null && normalized === this.jumpSetting) {
      return;
    }

    if (this.pendingJumpSetting !== null && normalized === this.pendingJumpSetting) {
      return;
    }

    if (normalized === this.jumpSetting) {
      const hadPending = this.pendingJumpSetting !== null;
      this.pendingJumpSetting = null;
      if (hadPending && this.jumpSetting === 1) {
        this.completedPassRenderers.clear();
      }
      return;
    }

    const wasPending = this.pendingJumpSetting !== null;
    this.pendingJumpSetting = normalized;

    if (this.jumpSetting === 1 && !wasPending) {
      this.completedPassRenderers.clear();
      for (const renderer of this.planetRenderers) {
        const sample = renderer.computeSampleAt(this.simTimeMs);
        if (!this.isSampleDrawable(sample)) {
          this.completedPassRenderers.add(renderer);
        }
      }
    }
  }

  /** Add/remove planets and special objects live; existing trails are kept for retained targets. */
  updateTargets(newTargets: SkyTarget[]) {
    const uniqueTargets = newTargets.filter(
      (target, index) => newTargets.findIndex((other) => other.id === target.id) === index
    );
    const previousCount = this.planetRenderers.length;
    this.config.targets = uniqueTargets;

    const existingMap = new Map<string, PlanetRenderer>();
    for (const renderer of this.planetRenderers) {
      existingMap.set(renderer.target.id, renderer);
    }

    const retained = new Set<PlanetRenderer>();
    const newRenderers: PlanetRenderer[] = [];
    const additions: PlanetRenderer[] = [];

    for (const target of uniqueTargets) {
      const renderer = existingMap.get(target.id);
      if (renderer) {
        newRenderers.push(renderer);
        retained.add(renderer);
      } else {
        const created = this.createRenderer(target);
        newRenderers.push(created);
        additions.push(created);
      }
    }

    for (const renderer of this.planetRenderers) {
      if (!retained.has(renderer)) {
        this.destroyRenderer(renderer);
        this.completedPassRenderers.delete(renderer);
        this.pendingEntryTargets.delete(renderer);
      }
    }

    this.planetRenderers = newRenderers;
    this.markerRadii.clear();

    if (this.planetRenderers.length === 0) {
      this.simulationFrozen = true;
      this.pendingEntryTargets.clear();
      this.completedPassRenderers.clear();
      this.spawnWithoutHistory.clear();
      this.renderStill();
      return;
    }

    if (previousCount === 0) {
      this.simulationFrozen = false;
      this.reseedAfterPlanetActivation();
      this.renderStill();
      return;
    }

    for (const renderer of additions) {
      this.initializeRendererEntry(renderer);
    }
    this.simulationFrozen = this.finishedRenderers.size >= this.planetRenderers.length;
    this.renderStill();
  }

  getStatus(): ViewStatus {
    const timeMs = this.baseTimestamp + this.previewTimeMs;
    const visible = this.lastVisible.map((entry) => entry.renderer.target.id);
    const finished = this.planetRenderers.length > 0 && this.finishedRenderers.size >= this.planetRenderers.length;
    return {
      timeMs,
      elapsedMs: timeMs - this.baseTimestamp,
      targets: this.config.targets.map(({ id, label, color }) => ({ id, label, color })),
      visible,
      waiting: !finished && visible.length === 0 && this.jumpSetting !== 1 && this.planetRenderers.length > 0,
      finished,
      fps: this.frameIntervalEma > 0 ? 1000 / this.frameIntervalEma : 0,
      frameWorkMs: this.frameWorkEma,
      paused: this.paused,
      eclipse: this.eclipse
        ? { kind: this.eclipse.kind, obscuration: this.eclipse.obscuration }
        : null,
    };
  }

  private initializeRendererEntry(renderer: PlanetRenderer) {
    renderer.clearActiveTrail();
    renderer.setLastVisibleSample(null);
    this.spawnWithoutHistory.delete(renderer);

    const currentSample = renderer.computeSampleAt(this.simTimeMs);
    if (this.isSampleDrawable(currentSample)) {
      this.backfillArc(renderer, this.simTimeMs);
      return;
    }

    const entryPoint = this.seekNextVisibleSample(renderer, this.simTimeMs, 0);
    if (entryPoint) {
      this.pendingEntryTargets.set(renderer, entryPoint);
    }
  }

  /** The first body joins an empty sky: the same as a start, at the current moment. */
  private reseedAfterPlanetActivation() {
    this.seedInitialEntries();
  }

  private findNextFutureEntryPoint(renderer: PlanetRenderer, fromTimeMs: number) {
    const exitScanLimit = Math.ceil((48 * 3600 * 1000) / Math.max(1, this.stepMs));
    let searchTime = fromTimeMs;

    for (let i = 0; i < exitScanLimit; i += 1) {
      const sample = renderer.computeSampleAt(searchTime);
      if (!this.isSampleDrawable(sample)) {
        break;
      }
      searchTime += this.direction * this.stepMs;
    }

    return this.seekNextVisibleSample(renderer, searchTime, 0);
  }

  private loop = (timestamp: number) => {
    this.animationHandle = null;
    const workStart = performance.now();
    if (this.lastFrameTime === null) {
      this.lastFrameTime = timestamp;
    }

    const rawDelta = timestamp - this.lastFrameTime;
    this.lastFrameTime = timestamp;
    if (rawDelta > 0) {
      this.frameIntervalEma += (Math.min(rawDelta, 1000) - this.frameIntervalEma) * 0.05;
    }
    const deltaTime = Math.min(rawDelta, MAX_FRAME_DELTA_MS);
    this.lastFrameDurationMs = deltaTime;

    this.lastSimDeltaMs = deltaTime * this.config.playbackSpeed;
    this.advanceSimulation(this.lastSimDeltaMs);
    this.render();
    this.frameWorkEma += (performance.now() - workStart - this.frameWorkEma) * 0.05;
    this.scheduleFrame();
  };

  private advanceSimulation(deltaSimMs: number) {
    if (deltaSimMs === 0 || this.simulationFrozen || this.planetRenderers.length === 0) {
      return;
    }

    // remainderMs is progress toward the next step in the current direction (always ≥ 0).
    this.remainderMs += Math.abs(deltaSimMs);
    const stepsToProcess = Math.floor(this.remainderMs / this.stepMs);
    const budgetEnd =
      performance.now() + Math.min(STEP_BUDGET_MS, this.frameIntervalEma * STEP_BUDGET_FRAME_SHARE);
    for (let i = 0; i < stepsToProcess && !this.simulationFrozen; i += 1) {
      this.remainderMs -= this.stepMs;
      this.processStep(this.stepMs);
      if ((i & 3) === 3 && performance.now() > budgetEnd) {
        this.remainderMs = Math.min(this.remainderMs, this.stepMs * 0.999);
        break;
      }
    }
    if (this.simulationFrozen) {
      this.remainderMs = 0;
    }
  }

  private processStep(stepMs: number) {
    const direction = this.direction;
    if (Math.abs(this.baseTimestamp + this.simTimeMs + direction * stepMs) > MAX_EPOCH_MS) {
      this.simulationFrozen = true;
      return;
    }
    this.simTimeMs += direction * stepMs;

    // Skip-ahead is forward-only: rewinding just plays every arc back continuously.
    const jumpEnabled = this.jumpSetting !== 1 && direction > 0;
    const trackingSweeps = jumpEnabled || this.pendingJumpSetting !== null;

    for (const renderer of this.planetRenderers) {
      if (this.finishedRenderers.has(renderer)) {
        continue;
      }
      if (trackingSweeps && this.completedPassRenderers.has(renderer)) {
        continue;
      }

      const pendingEntry = this.pendingEntryTargets.get(renderer);
      if (pendingEntry) {
        if (this.isEarlierInPlay(this.simTimeMs, pendingEntry.timeMs)) {
          continue;
        }
        renderer.setLastVisibleSample(pendingEntry.sample, pendingEntry.timeMs);
        this.pendingEntryTargets.delete(renderer);
        this.spawnWithoutHistory.delete(renderer);
      }

      const sample = renderer.computeSampleAt(this.simTimeMs);

      if (!this.isSampleDrawable(sample)) {
        // Planet set: retire this sweep into history and wait for the next rise.
        if (renderer.getLastVisibleSample()) {
          this.commitRenderer(renderer);
          renderer.setLastVisibleSample(null);
          if (trackingSweeps) {
            this.completedPassRenderers.add(renderer);
          }
        }
        continue;
      }

      let lastSample = renderer.getLastVisibleSample();
      let lastTimeMs = renderer.getLastVisibleTimeMs();
      if (!lastSample) {
        if (this.spawnWithoutHistory.has(renderer)) {
          this.spawnWithoutHistory.delete(renderer);
          renderer.setLastVisibleSample(sample, this.simTimeMs);
          continue;
        }

        // Reconstruct the arc entry so the next segment rises from the horizon
        const entryPoint = this.findArcEntryPoint(renderer, this.simTimeMs);
        renderer.setLastVisibleSample(entryPoint.sample, entryPoint.timeMs);
        lastSample = entryPoint.sample;
        lastTimeMs = entryPoint.timeMs;
      }

      renderer.paintSegment(lastSample, lastTimeMs, sample, this.simTimeMs);
      renderer.setLastVisibleSample(sample, this.simTimeMs);

      if (renderer.hasCompletedFullTurn()) {
        this.commitRenderer(renderer);
      }
    }

    if (this.finishedRenderers.size >= this.planetRenderers.length) {
      this.simulationFrozen = true;
      return;
    }

    let sweepComplete = trackingSweeps;
    if (sweepComplete) {
      for (const renderer of this.planetRenderers) {
        if (!this.completedPassRenderers.has(renderer) && !this.finishedRenderers.has(renderer)) {
          sweepComplete = false;
          break;
        }
      }
    }

    if (sweepComplete) {
      const appliedSetting = this.applyPendingJumpSetting();
      if (appliedSetting !== null) {
        if (appliedSetting !== 1) {
          this.performCoordinatedJump();
        } else {
          this.pendingEntryTargets.clear();
          this.completedPassRenderers.clear();
        }
      } else if (jumpEnabled) {
        this.performCoordinatedJump();
      }
    }
  }

  private commitRenderer(renderer: PlanetRenderer) {
    renderer.commitActiveTrailToHistory(this.simTimeMs);
    if (renderer.hasReachedCycleLimit()) {
      this.finishedRenderers.add(renderer);
      renderer.setLastVisibleSample(null);
    }
  }

  private performCoordinatedJump() {
    const jumpMs = this.getJumpMilliseconds();
    let earliestCrossingTime: number | null = null;
    const crossingInfos = new Map<PlanetRenderer, PendingEntry>();

    // Find the earliest horizon crossing among all planets
    for (const renderer of this.planetRenderers) {
      if (this.finishedRenderers.has(renderer)) {
        continue;
      }
      const crossingInfo = this.seekNextVisibleSample(renderer, this.simTimeMs, jumpMs);
      if (crossingInfo) {
        crossingInfos.set(renderer, crossingInfo);
        if (earliestCrossingTime === null || this.isEarlierInPlay(crossingInfo.timeMs, earliestCrossingTime)) {
          earliestCrossingTime = crossingInfo.timeMs;
        }
      }
    }

    if (earliestCrossingTime === null) {
      // No planet will be visible in lookahead window
      return;
    }

    // Warp to the earliest crossing, or to the following dusk if that rise is in daylight.
    const landing = this.chooseNightLanding(earliestCrossingTime);
    this.simTimeMs = landing;
    this.remainderMs = 0;
    if (landing !== earliestCrossingTime) {
      this.seedRenderersAt(landing);
    } else {
      this.syncRenderersToEntryPoints(crossingInfos, earliestCrossingTime);
    }
    this.starField.markJump();
  }

  private syncRenderersToEntryPoints(
    entryPoints: Map<PlanetRenderer, PendingEntry>,
    anchorTime: number
  ) {
    this.pendingEntryTargets.clear();
    this.completedPassRenderers.clear();
    this.spawnWithoutHistory.clear();
    const entryEpsilon = Math.max(1, this.stepMs / 4);

    for (const renderer of this.planetRenderers) {
      renderer.clearActiveTrail();
      const entryPoint = entryPoints.get(renderer);
      if (entryPoint && Math.abs(entryPoint.timeMs - anchorTime) <= entryEpsilon) {
        renderer.setLastVisibleSample(entryPoint.sample, entryPoint.timeMs);
      } else if (entryPoint) {
        renderer.setLastVisibleSample(null);
        this.pendingEntryTargets.set(renderer, entryPoint);
      } else {
        renderer.setLastVisibleSample(null);
      }
    }
  }

  private applyPendingJumpSetting(): number | null {
    if (this.pendingJumpSetting === null) {
      return null;
    }

    const nextSetting = this.pendingJumpSetting;
    this.pendingJumpSetting = null;
    this.jumpSetting = nextSetting;
    this.config.jumpSetting = nextSetting;
    return nextSetting;
  }

  private seekNextVisibleSample(
    renderer: PlanetRenderer,
    fromTimeMs: number,
    jumpMs: number
  ): { sample: HorizonSample; timeMs: number } | null {
    const maxIterations = Math.ceil(
      (MAX_LOOKAHEAD_HOURS * 3600 * 1000) / Math.max(1, this.stepMs)
    );

    const direction = this.direction;
    let timeMs = fromTimeMs + direction * jumpMs;
    for (let i = 0; i < maxIterations; i += 1) {
      const sample = renderer.computeSampleAt(timeMs);
      if (this.isSampleDrawable(sample)) {
        return this.findArcEntryPoint(renderer, timeMs);
      }

      // Adaptive stepping
      const cutoff = this.projection.cutoffAltitude(sample.azimuth);
      const depthBelowHorizon = cutoff - sample.altitude;
      let adaptiveStep = this.stepMs;

      if (depthBelowHorizon > 30) {
        adaptiveStep = 6 * 3600 * 1000;
      } else if (depthBelowHorizon > 15) {
        adaptiveStep = 2 * 3600 * 1000;
      } else if (depthBelowHorizon > 5) {
        adaptiveStep = 30 * 60 * 1000;
      }

      timeMs += direction * adaptiveStep;
    }

    return null;
  }

  private findArcEntryPoint(
    renderer: PlanetRenderer,
    foundTimeMs: number
  ): { sample: HorizonSample; timeMs: number } {
    // "Entry" is where the arc begins in play order: before the found time when playing
    // forward (the rise), after it when rewinding (the set).
    const coarseStepMs = 30 * 60 * 1000 * this.direction;
    const maxCoarseSteps = Math.ceil((24 * 3600 * 1000) / Math.abs(coarseStepMs));
    const searchSpan = maxCoarseSteps * Math.abs(coarseStepMs);

    let upperState = this.evaluateVisibilityState(renderer, foundTimeMs);
    let lowerState = upperState;

    if (upperState.visibilityValue >= 0) {
      let bracketFound = false;
      for (let i = 0; i < maxCoarseSteps && !bracketFound; i += 1) {
        const candidateTime = upperState.timeMs - coarseStepMs;
        if (Math.abs(candidateTime - foundTimeMs) > searchSpan) break;

        const candidate = this.evaluateVisibilityState(renderer, candidateTime);
        if (candidate.visibilityValue < 0) {
          lowerState = candidate;
          bracketFound = true;
          break;
        }
        upperState = candidate;
      }

      if (!bracketFound) {
        return { sample: upperState.sample, timeMs: upperState.timeMs };
      }
    } else {
      let bracketFound = false;
      for (let i = 0; i < maxCoarseSteps; i += 1) {
        const candidateTime = lowerState.timeMs + coarseStepMs;
        if (Math.abs(candidateTime - foundTimeMs) > searchSpan) break;

        const candidate = this.evaluateVisibilityState(renderer, candidateTime);
        if (candidate.visibilityValue >= 0) {
          upperState = candidate;
          bracketFound = true;
          break;
        }
        lowerState = candidate;
      }

      if (!bracketFound) {
        return { sample: lowerState.sample, timeMs: lowerState.timeMs };
      }
    }

    const entryState = this.refineHorizonCrossing(renderer, lowerState, upperState);
    return { sample: entryState.sample, timeMs: entryState.timeMs };
  }

  private evaluateVisibilityState(renderer: PlanetRenderer, timeMs: number): VisibilityState {
    const sample = renderer.computeSampleAt(timeMs);
    const horizonAlt = this.projection.cutoffAltitude(sample.azimuth);
    return {
      sample,
      timeMs,
      horizonAlt,
      visibilityValue: sample.altitude - horizonAlt,
    };
  }

  private refineHorizonCrossing(
    renderer: PlanetRenderer,
    lowerState: VisibilityState,
    upperState: VisibilityState
  ): VisibilityState {
    let low = lowerState;
    let high = upperState;
    const resolutionMs = Math.min(this.stepMs, 60 * 1000);
    const maxIterations = 12;

    // `low` is the not-yet-visible side, `high` the visible one; they may be in either time order.
    for (let i = 0; i < maxIterations && Math.abs(high.timeMs - low.timeMs) > resolutionMs; i += 1) {
      const midTimeMs = (low.timeMs + high.timeMs) / 2;
      const midState = this.evaluateVisibilityState(renderer, midTimeMs);
      if (midState.visibilityValue < 0) {
        low = midState;
      } else {
        high = midState;
      }
    }

    if (low.visibilityValue >= 0) {
      const awayFromVisible = Math.sign(low.timeMs - high.timeMs) || -1;
      const nudgedTime = low.timeMs + (awayFromVisible * resolutionMs) / 4;
      const nudgedState = this.evaluateVisibilityState(renderer, nudgedTime);
      if (nudgedState.visibilityValue < 0) {
        low = nudgedState;
      }
    }

    return low;
  }

  private getJumpMilliseconds(): number {
    const setting = Math.max(1, this.jumpSetting);

    if (setting === 1) return this.stepMs;
    if (setting === 2) return 0;

    if (setting <= 6) {
      const weeks = setting - 2;
      return weeks * 7 * 24 * 3600 * 1000;
    }

    const monthSteps = setting - 6;
    const months = Math.min(monthSteps, 12);
    return months * 30 * 24 * 3600 * 1000;
  }

  /** Redraw without advancing time (paused edits, resizes). */
  private renderStill() {
    if (this.paused && this.started) {
      this.render();
    }
  }

  private render() {
    const previewTime = this.previewTimeMs;
    for (const renderer of this.planetRenderers) {
      if (!this.paused) {
        renderer.update(this.lastFrameDurationMs);
      }
      if (renderer.historyDirty) {
        this.historyLayerDirty = true;
      }
    }

    const ctx = this.surface.context;
    const width = this.surface.width;
    const height = this.surface.height;
    const absoluteTime = this.baseTimestamp + previewTime;
    const moon = this.computeMoon(absoluteTime);
    const visuals = this.config.visuals;
    // During a solar eclipse the sky, clouds and landscape are lit as if the Sun were lower.
    this.eclipse = this.eclipseModel.at(absoluteTime, this.moonPhaseAt(absoluteTime));
    const trueSun = this.computeSun(absoluteTime);
    const sun = { azimuth: trueSun.azimuth, altitude: eclipsedSunAltitude(trueSun.altitude, this.eclipse) };
    const sunAltitude = sun.altitude;

    this.projection.setLighting?.(this.sceneLight(sun, moon, trueSun.altitude));
    // Every full-canvas raster op counts on phones: the sky fill replaces the clear, and the
    // grid is a handful of hairlines drawn directly rather than another full-screen blit.
    if (visuals.skyTint) {
      const colors = skyColors(sunAltitude, moon.light);
      this.projection.fillSky(ctx, colors.zenith, colors.horizon);
      this.drawMoonGlow(ctx, this.projection, moon, sunAltitude);
    } else if (this.projection.dynamicGround) {
      this.projection.fillSky(ctx, NIGHT_SKY.zenith, NIGHT_SKY.horizon);
    } else {
      this.surface.clear(NIGHT_SKY.zenith);
    }

    this.projection.drawGrid(ctx);
    // Clouds repaint their buffer now (drawn later, over the trails) so the Milky Way can skip
    // repainting in the same frame: two full-sky repaints at once is a visible hitch on phones.
    let cloudsRepainted = false;
    if (this.cloudLayer.enabled) {
      cloudsRepainted = this.cloudLayer.update(
        this.paused ? 0 : this.lastFrameDurationMs,
        this.paused ? 0 : this.lastSimDeltaMs,
        this.cloudLight(sun, moon),
        this.paused
      );
    }
    // The Milky Way needs real darkness: it fades with twilight and drowns in moonlight.
    if (visuals.milkyWay) {
      const darkness = visuals.skyTint ? starVisibility(sunAltitude) * (1 - 0.85 * moon.light) : 1;
      this.milkyWay.update(
        this.paused ? 0 : this.lastFrameDurationMs,
        absoluteTime,
        darkness,
        this.paused,
        !cloudsRepainted
      );
      this.milkyWay.draw(ctx, this.surface.width, this.surface.height);
    }
    this.starField.draw(
      ctx,
      this.projection,
      absoluteTime,
      visuals.skyTint ? starVisibility(sunAltitude, moon.light) : 1,
      this.surface.canvas.width,
      this.surface.canvas.height,
      this.surface.pixelRatio,
      visuals.skyTint ? daylightWash(sunAltitude) : 0
    );
    this.drawSkyMoon(ctx, this.projection, moon, absoluteTime);
    this.drawSkyEclipse(ctx, this.projection);

    // A rebuild started mid-pan would already be stale; wait until the camera settles.
    if (performance.now() >= this.cameraMovingUntil) {
      this.advanceHistoryRebuild();
    }
    if (this.historyHasContent) {
      this.blitLayer(this.historyLayer);
    }
    for (const renderer of this.planetRenderers) {
      renderer.drawLiveHistory(ctx, this.projection, previewTime);
    }

    for (const renderer of this.planetRenderers) {
      renderer.drawActive(ctx, this.projection, previewTime);
    }
    this.history.update(absoluteTime);
    this.history.draw(ctx, this.projection, absoluteTime);

    // Clouds veil the trails beneath them; markers and labels stay on top.
    if (this.cloudLayer.enabled) {
      this.cloudLayer.draw(ctx, this.surface.width, this.surface.height);
    }

    const visiblePlanets = this.collectVisiblePlanetSamples(previewTime);
    this.lastVisible = visiblePlanets;
    this.refreshMarkerRadii(absoluteTime);
    this.drawPreviewSegments(visiblePlanets);
    this.drawMarkers(visiblePlanets);
    if (this.projection.dynamicGround) {
      this.projection.drawGround(ctx);
    } else {
      this.blitGround();
    }
    // On a boat the world sways while the boat stays put: rock what is drawn so far, draw the
    // names in the same frame, then the deck on top.
    if (!this.paused) {
      this.swellMs += this.lastFrameDurationMs;
    }
    const motion = this.projection.frameMotion?.(this.swellMs) ?? null;
    if (motion) {
      this.rockCanvas(this.surface.canvas, motion, width, height);
      ctx.save();
      this.applyRock(ctx, motion, width, height);
      this.drawMarkerLabels(visiblePlanets);
      ctx.restore();
    } else {
      this.drawMarkerLabels(visiblePlanets);
    }
    this.projection.drawForeground?.(ctx);
  }

  /**
   * Render the current moment into a new canvas of any logical size (e.g. a phone-shaped
   * portrait for snapshots) without disturbing the live view: vectors are re-projected and the
   * star-trail bitmap is carried over through the projections' affine relation.
   */
  renderSnapshot(width: number, height: number, into?: HTMLCanvasElement): HTMLCanvasElement {
    const ratio = this.surface.pixelRatio;
    // `into` lets a recording redraw the same frame canvas every animation frame.
    const canvas = into ?? createLayerCanvas(Math.round(width * ratio), Math.round(height * ratio));
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return canvas;
    }
    ctx.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
    const projection = this.makeProjection();
    projection.setSize(width, height);
    const previewTime = this.previewTimeMs;
    const absoluteTime = this.baseTimestamp + previewTime;
    const visuals = this.config.visuals;
    const trueSun = this.computeSun(absoluteTime);
    const sun = { azimuth: trueSun.azimuth, altitude: eclipsedSunAltitude(trueSun.altitude, this.eclipse) };
    const sunAltitude = sun.altitude;
    const moon = this.computeMoon(absoluteTime);
    projection.setLighting?.(this.sceneLight(sun, moon, trueSun.altitude));

    if (visuals.skyTint) {
      const colors = skyColors(sunAltitude, moon.light);
      projection.fillSky(ctx, colors.zenith, colors.horizon);
      this.drawMoonGlow(ctx, projection, moon, sunAltitude);
    } else if (projection.dynamicGround) {
      projection.fillSky(ctx, NIGHT_SKY.zenith, NIGHT_SKY.horizon);
    } else {
      ctx.fillStyle = NIGHT_SKY.zenith;
      ctx.fillRect(0, 0, width + 1, height + 1);
    }
    projection.drawGrid(ctx);
    this.milkyWay.drawSnapshot(ctx, projection, this.projection, this.surface.width, this.surface.height);
    this.starField.drawSnapshot(
      ctx,
      projection,
      this.projection,
      visuals.skyTint ? starVisibility(sunAltitude, moon.light) : 1,
      this.surface.width,
      this.surface.height
    );
    this.drawSkyMoon(ctx, projection, moon, absoluteTime);
    this.drawSkyEclipse(ctx, projection);
    for (const renderer of this.planetRenderers) {
      renderer.drawSnapshot(ctx, projection, previewTime);
    }
    this.history.draw(ctx, projection, absoluteTime);
    this.cloudLayer.drawSnapshot(ctx, projection, this.projection, this.surface.width, this.surface.height);
    const visiblePlanets = this.lastVisible;
    this.drawPreviewSegments(visiblePlanets, ctx, projection);
    this.drawMarkers(visiblePlanets, ctx, projection);
    projection.drawGround(ctx);
    // Recordings rock with the boat; a still snapshot stays level.
    const motion = into ? projection.frameMotion?.(this.swellMs) ?? null : null;
    if (motion) {
      this.rockCanvas(canvas, motion, width, height);
      ctx.save();
      this.applyRock(ctx, motion, width, height);
      this.drawMarkerLabels(visiblePlanets, ctx, projection, width);
      ctx.restore();
    } else {
      this.drawMarkerLabels(visiblePlanets, ctx, projection, width);
    }
    projection.drawForeground?.(ctx);
    return canvas;
  }

  /** Only the band that can contain ground pixels is composited (the panorama's bottom strip). */
  private blitGround() {
    const layer = this.groundLayer;
    if (!layer) {
      return;
    }
    const ratio = this.surface.pixelRatio;
    const top = Math.max(0, Math.floor(this.projection.groundTop()));
    const height = this.surface.height - top;
    if (height <= 0) {
      return;
    }
    this.surface.context.drawImage(
      layer,
      0, top * ratio, layer.width, Math.min(layer.height - top * ratio, height * ratio),
      0, top, this.surface.width, height
    );
  }

  private computeSunAltitude(absoluteTimeMs: number) {
    return this.computeSun(absoluteTimeMs).altitude;
  }

  /** The Sun's position when something needs it (sky tint, cloud lighting); otherwise "night". */
  private computeSun(absoluteTimeMs: number) {
    const visuals = this.config.visuals;
    if (!visuals.skyTint && visuals.clouds === 'off') {
      return { altitude: -90, azimuth: 0 };
    }
    this.sunObserverDate.setTime(absoluteTimeMs);
    const sample = computeHorizonPoint({ body: Body.Sun, observer: this.config.observer, time: this.sunObserverDate });
    return { altitude: sample.altitude, azimuth: sample.azimuth };
  }

  /**
   * The Moon's position and light, when the sky or clouds use it. Its phase changes slowly, so
   * it is recomputed only once per simulated hour.
   */
  private computeMoon(absoluteTimeMs: number) {
    const visuals = this.config.visuals;
    if (!visuals.skyTint && visuals.clouds === 'off') {
      return { altitude: -90, azimuth: 0, phase: 0, light: 0 };
    }
    this.sunObserverDate.setTime(absoluteTimeMs);
    const sample = computeHorizonPoint({ body: Body.Moon, observer: this.config.observer, time: this.sunObserverDate });
    const phase = this.moonPhaseAt(absoluteTimeMs);
    return {
      altitude: sample.altitude,
      azimuth: sample.azimuth,
      phase,
      light: moonlightStrength(sample.altitude, phase),
    };
  }

  /** Illuminated fraction of the Moon; it changes slowly, so it is cached per simulated hour. */
  private moonPhaseAt(absoluteTimeMs: number) {
    if (!(Math.abs(absoluteTimeMs - this.moonPhaseAtMs) < 3600000)) {
      this.sunObserverDate.setTime(absoluteTimeMs);
      this.moonPhase = Illumination(Body.Moon, this.sunObserverDate).phase_fraction;
      this.moonPhaseAtMs = absoluteTimeMs;
    }
    return this.moonPhase;
  }

  /**
   * Keep magnitude-based marker sizes current: missing entries are filled at once, then one stale
   * body (over 6 simulated hours old) is refreshed per frame so fast playback never stalls.
   */
  private refreshMarkerRadii(absoluteTimeMs: number) {
    const renderers = this.planetRenderers;
    const count = renderers.length;
    let refreshed = false;
    for (let k = 0; k < count; k += 1) {
      const index = (this.markerRefreshCursor + k) % count;
      const renderer = renderers[index];
      const body = renderer.target.body;
      if (!usesMagnitude(body)) {
        continue;
      }
      const entry = this.markerRadii.get(renderer);
      const stale = !entry || Math.abs(absoluteTimeMs - entry.atMs) > 6 * 3600000;
      if (!stale || (entry && refreshed)) {
        continue;
      }
      this.sunObserverDate.setTime(absoluteTimeMs);
      const radius = radiusForMagnitude(Illumination(body, this.sunObserverDate).mag);
      this.markerRadii.set(renderer, { radius, atMs: absoluteTimeMs });
      if (entry) {
        refreshed = true;
        this.markerRefreshCursor = (index + 1) % count;
      }
    }
  }

  private markerRadius(renderer: PlanetRenderer) {
    const body = renderer.target.body;
    if (body === Body.Sun) {
      return SUN_MARKER_RADIUS;
    }
    if (body === Body.Moon) {
      return MOON_MARKER_RADIUS;
    }
    return this.markerRadii.get(renderer)?.radius ?? DEFAULT_MARKER_RADIUS;
  }

  /** The Moon's disc with its lit limb turned toward the Sun. */
  private drawMoonShape(
    ctx: CanvasRenderingContext2D,
    projection: SkyProjection,
    moon: { azimuth: number; altitude: number },
    radius: number,
    color: string,
    absoluteTimeMs: number,
    darkAlpha = 1
  ) {
    const p = this.point;
    projection.project(moon.azimuth, moon.altitude, p);
    const x = p.x;
    const y = p.y;
    const toward = stepToward(moon, this.markerSunAt(absoluteTimeMs), 2, this.markerStep);
    projection.project(toward.azimuth, toward.altitude, p);
    drawMoonDisc(ctx, x, y, radius, this.moonPhaseAt(absoluteTimeMs), Math.atan2(p.y - y, p.x - x), color, darkAlpha);
    this.drawLandingSite(ctx, projection, moon, x, y, radius, absoluteTimeMs);
  }

  /**
   * While astronauts were on the Moon, a glint marks their landing site on the disc, placed by
   * its selenographic latitude and longitude (lunar north toward the celestial pole; features east
   * on the Moon appear toward celestial west), with the mission's name beside the Moon.
   */
  private drawLandingSite(
    ctx: CanvasRenderingContext2D,
    projection: SkyProjection,
    moon: { azimuth: number; altitude: number },
    x: number,
    y: number,
    radius: number,
    absoluteTimeMs: number
  ) {
    const landing = this.history.landingAt(absoluteTimeMs);
    if (!landing) {
      return;
    }
    const p = this.point;
    const pole = stepToward(moon, { azimuth: 0, altitude: this.config.observer.latitude }, 2, this.markerStep);
    projection.project(pole.azimuth, pole.altitude, p);
    const length = Math.hypot(p.x - x, p.y - y);
    if (!(length > 1e-3) || p.x === BEHIND_CAMERA) {
      return;
    }
    const nx = (p.x - x) / length;
    const ny = (p.y - y) / length;
    // Celestial west on screen: north turned a quarter clockwise (screen y points down).
    const wx = -ny;
    const wy = nx;
    const DEG = Math.PI / 180;
    const across = Math.cos(landing.latitude * DEG) * Math.sin(landing.longitude * DEG);
    const up = Math.sin(landing.latitude * DEG);
    const gx = x + radius * (across * wx + up * nx);
    const gy = y + radius * (across * wy + up * ny);
    ctx.save();
    const flicker = 0.75 + 0.25 * Math.sin(performance.now() / 180);
    const glow = ctx.createRadialGradient(gx, gy, 0, gx, gy, 5);
    glow.addColorStop(0, `rgba(255, 252, 230, ${0.95 * flicker})`);
    glow.addColorStop(1, 'rgba(255, 240, 200, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(gx - 5, gy - 5, 10, 10);
    ctx.font = '10px "JetBrains Mono", "Fira Code", ui-monospace, monospace';
    ctx.fillStyle = 'rgba(255, 232, 170, 0.85)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(landing.label, x + radius + 6, y + radius + 2);
    ctx.restore();
  }

  /**
   * The Moon as part of the sky when its light is in play (sky tint or clouds) but it is not a
   * traced body: drawn before the clouds so they can veil it, with a small bloom.
   */
  private drawSkyMoon(
    ctx: CanvasRenderingContext2D,
    projection: SkyProjection,
    moon: { azimuth: number; altitude: number; phase: number },
    absoluteTimeMs: number
  ) {
    if (
      moon.altitude < -0.5 ||
      moon.phase < 0.03 ||
      this.eclipse !== null ||
      this.planetRenderers.some((renderer) => renderer.target.body === Body.Moon)
    ) {
      return;
    }
    const p = this.point;
    projection.project(moon.azimuth, moon.altitude, p);
    const radius = MOON_MARKER_RADIUS - 1;
    const bloom = ctx.createRadialGradient(p.x, p.y, radius * 0.8, p.x, p.y, radius * 4);
    bloom.addColorStop(0, `rgba(226, 232, 244, ${0.35 * moon.phase})`);
    bloom.addColorStop(1, 'rgba(226, 232, 244, 0)');
    ctx.save();
    ctx.fillStyle = bloom;
    ctx.fillRect(p.x - radius * 4, p.y - radius * 4, radius * 8, radius * 8);
    // By day the Moon's unlit side is lost against the blue; only the lit part shows.
    const sunUp = daylightWash(this.computeSun(absoluteTimeMs).altitude);
    this.drawMoonShape(ctx, projection, moon, radius, '#e9edf3', absoluteTimeMs, 1 - sunUp);
    ctx.restore();
  }

  /** The Sun during a solar eclipse, drawn as part of the sky when it is not a traced body. */
  private drawSkyEclipse(ctx: CanvasRenderingContext2D, projection: SkyProjection) {
    if (!this.eclipse || this.planetRenderers.some((renderer) => renderer.target.body === Body.Sun)) {
      return;
    }
    this.drawEclipse(ctx, projection, this.eclipse.sun);
  }

  /** Eclipsed Sun at `at`: larger than the usual marker so the Moon's bite and the corona read. */
  private drawEclipse(ctx: CanvasRenderingContext2D, projection: SkyProjection, at: { azimuth: number; altitude: number }) {
    const eclipse = this.eclipse;
    if (!eclipse) {
      return;
    }
    const p = this.point;
    projection.project(at.azimuth, at.altitude, p);
    const x = p.x;
    const y = p.y;
    projection.project(eclipse.moon.azimuth, eclipse.moon.altitude, p);
    const trueRadius = 'focal' in projection ? Number(projection.focal) * eclipse.sunRadius * (Math.PI / 180) : 0;
    const radius = Math.max(12, trueRadius);
    const towardMoon = Math.hypot(p.x - x, p.y - y) > 1e-3 ? Math.atan2(p.y - y, p.x - x) : 0;
    drawEclipsedSun(ctx, x, y, towardMoon, radius, eclipse, '#ffe9a8');
  }

  /** The Sun's direction for the Moon's lit limb; it barely moves in 10 simulated minutes. */
  private markerSunAt(absoluteTimeMs: number) {
    const sun = this.markerSun;
    if (!(Math.abs(absoluteTimeMs - sun.atMs) < 600000)) {
      this.sunObserverDate.setTime(absoluteTimeMs);
      const sample = computeHorizonPoint({ body: Body.Sun, observer: this.config.observer, time: this.sunObserverDate });
      sun.azimuth = sample.azimuth;
      sun.altitude = sample.altitude;
      sun.atMs = absoluteTimeMs;
    }
    return sun;
  }

  /** Soft bloom of sky light around a bright Moon (night only, with the daylight-sky tint). */
  private drawMoonGlow(
    ctx: CanvasRenderingContext2D,
    projection: SkyProjection,
    moon: { altitude: number; azimuth: number; light: number },
    sunAltitude: number
  ) {
    const strength = moon.light * (1 - Math.min(1, Math.max(0, (sunAltitude + 10) / 8)));
    if (strength < 0.02) {
      return;
    }
    const p = this.point;
    projection.project(moon.azimuth, moon.altitude, p);
    const radius = Math.max(60, Math.min(this.surface.width, this.surface.height) * 0.22);
    const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius);
    // A bright aureole close in (scattering is strongly forward) over a wide faint skirt.
    glow.addColorStop(0, `rgba(214, 224, 244, ${0.42 * strength})`);
    glow.addColorStop(0.07, `rgba(200, 214, 240, ${0.24 * strength})`);
    glow.addColorStop(0.3, `rgba(160, 180, 220, ${0.09 * strength})`);
    glow.addColorStop(1, 'rgba(120, 140, 190, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(p.x - radius, p.y - radius, radius * 2, radius * 2);
  }

  private cloudLight(
    sun: { altitude: number; azimuth: number },
    moon: { altitude: number; azimuth: number; phase: number }
  ) {
    return {
      sunAzimuth: sun.azimuth,
      sunAltitude: sun.altitude,
      moonAzimuth: moon.azimuth,
      moonAltitude: moon.altitude,
      moonPhase: moon.phase,
    };
  }

  private collectVisiblePlanetSamples(previewTime: number): VisiblePlanetSample[] {
    const visible: VisiblePlanetSample[] = [];
    const trackingSweeps = this.jumpSetting !== 1 || this.pendingJumpSetting !== null;

    for (const renderer of this.planetRenderers) {
      if (
        (trackingSweeps && this.completedPassRenderers.has(renderer)) ||
        this.pendingEntryTargets.has(renderer) ||
        this.finishedRenderers.has(renderer)
      ) {
        continue;
      }

      const previewSample = renderer.computeSampleAt(previewTime);
      if (this.isSampleVisible(previewSample)) {
        visible.push({ renderer, previewSample });
      }
    }

    return visible;
  }

  private drawMarkers(
    visiblePlanets: VisiblePlanetSample[],
    ctx: CanvasRenderingContext2D = this.surface.context,
    projection: SkyProjection = this.projection
  ) {
    const p = this.point;
    ctx.save();

    // Oscilloscope-style halo first so cores always sit on top of neighbouring glows.
    for (const { renderer, previewSample } of visiblePlanets) {
      projection.project(previewSample.azimuth, previewSample.altitude, p);
      const radius = this.markerRadius(renderer);
      if (renderer.target.body === Body.Sun) {
        if (!this.eclipse) {
          drawSunGlow(ctx, p.x, p.y, radius);
        }
        continue;
      }
      // In an eclipse the Moon is drawn as the silhouette on the Sun.
      if (renderer.target.body === Body.Moon && this.eclipse) {
        continue;
      }
      // The Moon's disc carries its own shape; a tighter halo keeps the phase readable.
      const reach = renderer.target.body === Body.Moon ? 1.5 : 2;
      ctx.fillStyle = renderer.color;
      ctx.globalAlpha = 0.15;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius * reach, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.3;
      ctx.fill();
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius * 1.5, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.globalAlpha = 1;
    for (const { renderer, previewSample } of visiblePlanets) {
      projection.project(previewSample.azimuth, previewSample.altitude, p);
      const radius = this.markerRadius(renderer);
      if (renderer.target.body === Body.Moon) {
        if (!this.eclipse) {
          this.drawMoonShape(ctx, projection, previewSample, radius, renderer.color, this.baseTimestamp + this.previewTimeMs);
        }
        continue;
      }
      if (renderer.target.body === Body.Sun && this.eclipse) {
        this.drawEclipse(ctx, projection, previewSample);
        continue;
      }
      ctx.fillStyle = renderer.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fill();
      if (renderer.target.body === Body.Sun) {
        ctx.fillStyle = 'rgba(255, 252, 235, 0.9)';
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius * 0.55, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.restore();
  }

  /** Drawn after the ground so names of bodies near the horizon stay readable. */
  private drawMarkerLabels(
    visiblePlanets: VisiblePlanetSample[],
    ctx: CanvasRenderingContext2D = this.surface.context,
    projection: SkyProjection = this.projection,
    width = this.surface.width
  ) {
    if (!this.config.visuals.labels || visiblePlanets.length === 0) {
      return;
    }
    const p = this.point;
    const layout = this.labelLayout;
    layout.reset();
    for (const { renderer, previewSample } of visiblePlanets) {
      projection.project(previewSample.azimuth, previewSample.altitude, p);
      layout.addMarker(p.x, p.y, this.markerRadius(renderer) + 1);
    }
    ctx.save();
    ctx.font = MARKER_LABEL_FONT;
    ctx.globalAlpha = 0.85;
    for (const { renderer, previewSample } of visiblePlanets) {
      // In an eclipse the Moon is the Sun's silhouette: one name is enough.
      if (this.eclipse && renderer.target.body === Body.Moon) {
        continue;
      }
      // Behind a ridge in Scene mode: the marker is hidden by the land, so is its name.
      if (projection.skyline && previewSample.altitude < projection.skyline(previewSample.azimuth) - 0.2) {
        continue;
      }
      projection.project(previewSample.azimuth, previewSample.altitude, p);
      const gap = Math.max(this.eclipse && renderer.target.body === Body.Sun ? 16 : 9, this.markerRadius(renderer) + 4);
      drawMarkerLabel(ctx, renderer.target.label, renderer.color, p.x, p.y, width, gap, layout);
    }
    ctx.restore();
  }

  private drawPreviewSegments(
    visiblePlanets: VisiblePlanetSample[],
    ctx: CanvasRenderingContext2D = this.surface.context,
    projection: SkyProjection = this.projection
  ) {
    const p = this.point;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = this.config.visuals.lineWidth;
    ctx.globalAlpha = 0.9;
    for (const { renderer, previewSample } of visiblePlanets) {
      const anchor = renderer.getLastVisibleSample();
      if (!anchor) {
        continue;
      }
      if (projection.wrapsAzimuth && Math.abs(anchor.azimuth - previewSample.azimuth) > 180) {
        continue;
      }
      projection.project(anchor.azimuth, anchor.altitude, p);
      const startX = p.x;
      const startY = p.y;
      projection.project(previewSample.azimuth, previewSample.altitude, p);
      if (startX === BEHIND_CAMERA || p.x === BEHIND_CAMERA) {
        continue;
      }
      ctx.strokeStyle = renderer.color;
      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  private isSampleVisible(sample: HorizonSample) {
    return sample.altitude >= this.projection.cutoffAltitude(sample.azimuth);
  }

  private isSampleDrawable(sample: HorizonSample) {
    const tolerance = 5;
    return sample.altitude >= this.projection.cutoffAltitude(sample.azimuth) - tolerance;
  }

  private createLogicalLayer() {
    const layer = createLayerCanvas(this.surface.canvas.width, this.surface.canvas.height);
    const ctx = layer.getContext('2d');
    ctx?.setTransform(this.surface.pixelRatio, 0, 0, this.surface.pixelRatio, 0, 0);
    return { layer, ctx };
  }

  /** Rotate and shift the frame about its centre (logical units), slightly zoomed to hide the edges. */
  private applyRock(ctx: CanvasRenderingContext2D, motion: { roll: number; offsetY: number; zoom: number }, width: number, height: number) {
    ctx.translate(width / 2, height / 2 + motion.offsetY);
    ctx.rotate(motion.roll);
    ctx.scale(motion.zoom, motion.zoom);
    ctx.translate(-width / 2, -height / 2);
  }

  /** Re-draw everything on `canvas` so far, rocked: one copy out and one transformed copy back. */
  private rockCanvas(canvas: HTMLCanvasElement, motion: { roll: number; offsetY: number; zoom: number }, width: number, height: number) {
    if (!this.rockBuffer || this.rockBuffer.width !== canvas.width || this.rockBuffer.height !== canvas.height) {
      this.rockBuffer = createLayerCanvas(canvas.width, canvas.height);
    }
    const buffer = this.rockBuffer.getContext('2d');
    const ctx = canvas.getContext('2d');
    if (!buffer || !ctx) {
      return;
    }
    buffer.setTransform(1, 0, 0, 1, 0, 0);
    buffer.drawImage(canvas, 0, 0);
    ctx.save();
    const sx = canvas.width / width;
    const sy = canvas.height / height;
    ctx.setTransform(sx, 0, 0, sy, 0, 0);
    this.applyRock(ctx, motion, width, height);
    ctx.drawImage(this.rockBuffer, 0, 0, width, height);
    ctx.restore();
  }

  /**
   * Point the Scene camera at `config.visuals.scene` in place. Screen-space layers no longer line
   * up: star trails start a new exposure, sky rasters are re-sampled, and planet trails are drawn
   * live (all of them) until a fresh history composite has been built for the new view.
   */
  private aimCamera() {
    const { heading, tilt, fov } = this.config.visuals.scene;
    this.projection.setCamera?.(heading, tilt, fov);
    this.cameraMovingUntil = performance.now() + 250;
    this.starField.reproject();
    this.cloudLayer.resize(this.projection, this.surface.width, this.surface.height, this.surface.pixelRatio);
    this.milkyWay.resize(this.projection, this.surface.width, this.surface.height, this.surface.pixelRatio);
    this.historyHasContent = false;
    this.rebuildQueue = [];
    this.rebuildCursor = -1;
    this.historyLayerDirty = true;
    for (const renderer of this.planetRenderers) {
      renderer.resetCompositeState();
    }
  }

  /** Apply gesture camera changes at most once per frame (raster re-sampling is not free). */
  private queueCamera(camera: { heading: number; tilt: number; fov: number }) {
    this.pendingCamera = camera;
    if (this.cameraFrame !== null) {
      return;
    }
    this.cameraFrame = requestAnimationFrame(() => {
      this.cameraFrame = null;
      const next = this.pendingCamera;
      this.pendingCamera = null;
      if (!next || this.config.visuals.projection !== 'perspective') {
        return;
      }
      this.config.visuals = { ...this.config.visuals, scene: { ...this.config.visuals.scene, ...next } };
      this.aimCamera();
      this.config.onSceneCameraChange?.(next);
      this.renderStill();
    });
  }

  /**
   * Scene mode: drag the sky to look around (the view follows the finger or mouse), pinch or
   * scroll to change the field of view. Other projections ignore these events.
   */
  private attachCameraGestures(canvas: HTMLCanvasElement) {
    canvas.style.touchAction = 'none';
    const isScene = () => this.config.visuals.projection === 'perspective';
    const spread = () => {
      const [a, b] = Array.from(this.pointers.values());
      return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
    };
    const centre = () => {
      const points = Array.from(this.pointers.values());
      return {
        x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
        y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
      };
    };
    // Each change of finger count re-bases the gesture, so lifting one finger never jumps.
    const begin = () => {
      const { heading, tilt, fov } = this.config.visuals.scene;
      const c = centre();
      const focal = 'focal' in this.projection ? Number(this.projection.focal) : 1;
      this.gesture = { heading, tilt, fov, x: c.x, y: c.y, distance: spread(), focal };
    };
    const clamp = (value: number, [lo, hi]: [number, number]) => Math.max(lo, Math.min(hi, value));

    canvas.addEventListener('pointerdown', (event) => {
      if (!isScene() || (event.pointerType === 'mouse' && event.button !== 0)) {
        return;
      }
      canvas.setPointerCapture?.(event.pointerId);
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (this.pointers.size === 1) {
        this.dragged = false;
      }
      begin();
      canvas.style.cursor = 'grabbing';
    });
    canvas.addEventListener('pointermove', (event) => {
      if (!isScene()) {
        canvas.style.cursor = '';
        return;
      }
      if (!this.pointers.has(event.pointerId) || !this.gesture) {
        if (event.pointerType === 'mouse') {
          canvas.style.cursor = 'grab';
        }
        return;
      }
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const g = this.gesture;
      const c = centre();
      const dx = c.x - g.x;
      const dy = c.y - g.y;
      if (!this.dragged && Math.hypot(dx, dy) < 4 && this.pointers.size === 1) {
        return;
      }
      this.dragged = true;
      const fov = this.pointers.size >= 2 && g.distance > 0 ? clamp((g.fov * g.distance) / Math.max(1, spread()), FOV_RANGE) : g.fov;
      // Degrees per pixel at the centre of the frame, as the lens was when the gesture began.
      const perPixel = 180 / Math.PI / Math.max(1, g.focal);
      const heading = (((g.heading - dx * perPixel) % 360) + 360) % 360;
      const tilt = clamp(g.tilt + dy * perPixel, TILT_RANGE);
      this.queueCamera({ heading: Math.round(heading * 10) / 10, tilt: Math.round(tilt * 10) / 10, fov: Math.round(fov) });
    });
    const release = (event: PointerEvent) => {
      if (!this.pointers.delete(event.pointerId)) {
        return;
      }
      if (this.pointers.size > 0) {
        begin();
      } else {
        this.gesture = null;
        canvas.style.cursor = isScene() ? 'grab' : '';
      }
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
    // A drag is not a tap: keep it from reaching the "tap the sky closes the sheet" handler.
    canvas.addEventListener(
      'click',
      (event) => {
        if (this.dragged) {
          this.dragged = false;
          event.stopPropagation();
        }
      },
      true
    );
    canvas.addEventListener(
      'wheel',
      (event) => {
        if (!isScene()) {
          return;
        }
        event.preventDefault();
        const { heading, tilt, fov } = this.pendingCamera ?? this.config.visuals.scene;
        this.queueCamera({ heading, tilt, fov: Math.round(clamp(fov * Math.exp(event.deltaY * 0.0015), FOV_RANGE)) });
      },
      { passive: false }
    );
  }

  private rebuildStaticLayers() {
    const ground = this.createLogicalLayer();
    if (ground.ctx && !this.projection.dynamicGround) {
      this.projection.drawGround(ground.ctx);
    }
    this.groundLayer = ground.layer;
    this.historyLayer = null;
    this.historyHasContent = false;
    this.backLayer = null;
    this.backCtx = null;
    this.rebuildQueue = [];
    this.rebuildCursor = -1;
    this.historyLayerDirty = true;
    for (const renderer of this.planetRenderers) {
      renderer.resetCompositeState();
    }
  }

  /**
   * Rebuild the history composite into a back buffer one body at a time (each slice is forced
   * to rasterise immediately), then swap. Rebuilds are rate-limited to ~20% of frame time, so
   * dense, fast skies never stall a frame; sweeps not yet composited are drawn directly.
   */
  private advanceHistoryRebuild() {
    const now = performance.now();
    // While paused nothing else will finish a stale rebuild: restart it from the current state.
    if (this.paused && this.rebuildCursor >= 0 && this.historyLayerDirty) {
      this.rebuildCursor = -1;
    }
    if (this.rebuildCursor < 0) {
      if (!this.historyLayerDirty) {
        return;
      }
      const minInterval = Math.min(250, this.historyRebuildCostMs * 5);
      if (this.historyLayer && !this.paused && now - this.lastHistoryRebuildAt < minInterval) {
        return;
      }
      if (!this.backLayer || !this.backCtx) {
        const { layer, ctx } = this.createLogicalLayer();
        this.backLayer = layer;
        this.backCtx = ctx;
      }
      if (!this.backCtx) {
        return;
      }
      this.backCtx.save();
      this.backCtx.setTransform(1, 0, 0, 1, 0, 0);
      this.backCtx.clearRect(0, 0, this.backLayer.width, this.backLayer.height);
      this.backCtx.restore();
      this.rebuildQueue = this.planetRenderers.slice();
      this.backHasContent = false;
      for (const renderer of this.rebuildQueue) {
        renderer.historyDirty = false;
      }
      this.historyLayerDirty = false;
      this.rebuildCursor = 0;
      this.lastHistoryRebuildAt = now;
      this.historyRebuildCostMs = 0;
    }

    const ctx = this.backCtx;
    const back = this.backLayer;
    if (!ctx || !back) {
      return;
    }
    const sliceStart = performance.now();
    while (this.rebuildCursor < this.rebuildQueue.length) {
      if (this.rebuildQueue[this.rebuildCursor].drawHistory(ctx, this.projection) > 0) {
        this.backHasContent = true;
      }
      this.rebuildCursor += 1;
      if (!this.paused && performance.now() - sliceStart > 3) {
        break;
      }
    }
    // Canvas drawing is deferred until the layer is read; a 1×1 copy makes this slice pay now.
    this.flushCtx?.drawImage(back, 0, 0, 1, 1, 0, 0, 1, 1);
    this.historyRebuildCostMs += performance.now() - sliceStart;

    if (this.rebuildCursor >= this.rebuildQueue.length) {
      this.backLayer = this.historyLayer;
      this.backCtx = this.historyLayer?.getContext('2d') ?? null;
      this.historyLayer = back;
      this.historyHasContent = this.backHasContent;
      for (const renderer of this.rebuildQueue) {
        renderer.promoteBackLayer();
      }
      this.rebuildQueue = [];
      this.rebuildCursor = -1;
    }
  }

  private blitLayer(layer: HTMLCanvasElement | null) {
    if (layer) {
      this.surface.context.drawImage(layer, 0, 0, this.surface.width, this.surface.height);
    }
  }

  private handleResize = () => {
    if (!this.surface.resize()) {
      return;
    }
    this.projection.setSize(this.surface.width, this.surface.height);
    this.rebuildStaticLayers();
    this.starField.invalidate();
    this.cloudLayer.resize(this.projection, this.surface.width, this.surface.height, this.surface.pixelRatio);
    this.milkyWay.resize(this.projection, this.surface.width, this.surface.height, this.surface.pixelRatio);
    this.renderStill();
  };
}
