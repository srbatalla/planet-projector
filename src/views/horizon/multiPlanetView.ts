import { Body, Observer } from 'astronomy-engine';
import { computeHorizonPoint, type HorizonSample } from '../../core/astro';
import { CanvasSurface } from '../../render/canvas';
import { PlanetRenderer } from './planetRenderer';

type MultiPlanetViewConfig = {
  bodies: Body[];
  observer: Observer;
  sampleMinutes: number;
  startTime: Date;
  playbackSpeed: number;
  jumpSetting: number;
  trailPersistence: number;
  cycleLimit: number;
  activeFadeRate: number;
  azimuthCheckpointInterval: number;
};

type AltitudeRange = {
  min: number;
  max: number;
};

type SamplePoint = {
  azimuth: number;
  altitude: number;
};

type VisibilityState = {
  sample: HorizonSample;
  timeMs: number;
  horizonAlt: number;
  visibilityValue: number;
};

type VisiblePlanetSample = {
  renderer: PlanetRenderer;
  previewSample: HorizonSample;
  markerSample: HorizonSample;
};

type PendingEntry = {
  sample: HorizonSample;
  timeMs: number;
};

const MAX_LOOKAHEAD_HOURS = 400;

export class MultiPlanetView {
  private surface: CanvasSurface;
  private animationHandle: number | null = null;
  private lastFrameTime: number | null = null;
  private readonly altitudeRange: AltitudeRange = { min: -10, max: 90 };
  private readonly stepMs: number;
  private readonly baseTimestamp: number;

  // Pre-calculated constants for performance
  private readonly AZIMUTH_TO_NORMALIZED = 1 / 360;

  // Simulation state
  private simTimeMs = 0;
  private remainderMs = 0;
  private jumpSetting: number;

  // Planet renderers - one per enabled body
  private planetRenderers: PlanetRenderer[] = [];

  // Shared resources
  private historyCanvasPool: HTMLCanvasElement[] = [];
  private staticLayerSize = { width: 0, height: 0 };
  private gridLayer: HTMLCanvasElement | null = null;
  private horizonLayer: HTMLCanvasElement | null = null;
  private completedPassRenderers = new Set<PlanetRenderer>();
  private pendingEntryTargets = new Map<PlanetRenderer, PendingEntry>();
  private pendingJumpSetting: number | null = null;
  private spawnWithoutHistory = new Set<PlanetRenderer>();
  private readonly canvasPoolManager = {
    acquire: () => this.acquireHistoryCanvas(),
    release: (canvas: HTMLCanvasElement) => this.releaseHistoryCanvas(canvas),
  };
  private readonly mappingFunctions = {
    mapAzimuth: (az: number) => this.mapAzimuth(az),
    mapAltitude: (alt: number) => this.mapAltitude(alt),
    getCurvedHorizonAltitudeAtAzimuth: (az: number) => this.getCurvedHorizonAltitudeAtAzimuth(az),
    isSampleVisible: (sample: HorizonSample) => this.isSampleVisible(sample),
    isSampleDrawable: (sample: HorizonSample) => this.isSampleDrawable(sample),
    toCanvasPoint: (point: SamplePoint) => this.toCanvasPoint(point),
  };
  private simulationFrozen = false;

  // Cached dimensions
  private cachedLogicalWidth = 0;
  private cachedLogicalHeight = 0;

  // FPS tracking
  private fpsFrameTimes: number[] = [];
  private fps = 0;
  private lastFrameDurationMs = 16;
  private resizeListenerAttached = false;

  constructor(private container: HTMLElement, private config: MultiPlanetViewConfig) {
    this.stepMs = Math.max(1, this.config.sampleMinutes * 60 * 1000);
    this.baseTimestamp = this.config.startTime.getTime();
    this.jumpSetting = this.config.jumpSetting;

    // Create canvas
    const canvas = document.createElement('canvas');
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    this.container.appendChild(canvas);

    this.surface = new CanvasSurface(canvas);

    // Update dimension cache
    this.updateDimensionCache();

    // Create renderer for each planet
    this.createPlanetRenderers();
    this.simulationFrozen = this.planetRenderers.length === 0;

    // Initialize static layers
    this.ensureStaticLayers();
  }

  private createPlanetRenderers() {
    for (const body of this.config.bodies) {
      const renderer = this.createRendererForBody(body);
      this.planetRenderers.push(renderer);
    }
  }

  private createRendererForBody(body: Body) {
    const renderer = new PlanetRenderer(
      {
        body,
        observer: this.config.observer,
        baseTimestamp: this.baseTimestamp,
        stepMs: this.stepMs,
        trailPersistence: this.config.trailPersistence,
        azimuthCheckpointInterval: this.config.azimuthCheckpointInterval,
        activeFadeRate: this.config.activeFadeRate,
        cycleLimit: this.config.cycleLimit,
      },
      this.mappingFunctions,
      this.canvasPoolManager
    );

    renderer.syncTrailCanvas(this.surface.canvas, this.surface.pixelRatio);
    return renderer;
  }

  private destroyRenderer(renderer: PlanetRenderer) {
    renderer.reset();
    this.spawnWithoutHistory.delete(renderer);
  }

  start() {
    if (this.animationHandle !== null) {
      return;
    }

    if (this.planetRenderers.length === 0) {
      return;
    }

    if (!this.resizeListenerAttached) {
      window.addEventListener('resize', this.handleResize, { passive: true });
      this.resizeListenerAttached = true;
    }

    // Initialize: find the earliest upcoming visible arc among all planets
    let earliestEntryTime: number | null = null;
    const entryPoints = new Map<PlanetRenderer, PendingEntry>();

    for (const renderer of this.planetRenderers) {
      const initialSample = renderer.computeSampleAt(this.simTimeMs);
      let entryPoint: { sample: HorizonSample; timeMs: number } | null = null;

      if (this.isSampleDrawable(initialSample)) {
        entryPoint = this.findArcEntryPoint(renderer, this.simTimeMs);
      } else {
        entryPoint = this.seekNextVisibleSample(renderer, this.simTimeMs, 0);
      }

      if (entryPoint) {
        entryPoints.set(renderer, entryPoint);
      }

      if (entryPoint && (earliestEntryTime === null || entryPoint.timeMs < earliestEntryTime)) {
        earliestEntryTime = entryPoint.timeMs;
      }
    }

    if (earliestEntryTime !== null) {
      this.simTimeMs = earliestEntryTime;
      this.remainderMs = 0;
      this.syncRenderersToEntryPoints(entryPoints, earliestEntryTime);
    }

    this.animationHandle = requestAnimationFrame(this.loop);
  }

  stop() {
    if (this.animationHandle !== null) {
      cancelAnimationFrame(this.animationHandle);
      this.animationHandle = null;
    }

    if (this.resizeListenerAttached) {
      window.removeEventListener('resize', this.handleResize);
      this.resizeListenerAttached = false;
    }
  }

  updatePlaybackSpeed(newSpeed: number) {
    this.config.playbackSpeed = Math.max(1, newSpeed);
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

  updatePlanets(newBodies: Body[]) {
    const uniqueBodies = Array.from(new Set(newBodies));
    const previousCount = this.planetRenderers.length;
    this.config.bodies = uniqueBodies;

    const existingMap = new Map<Body, PlanetRenderer>();
    for (const renderer of this.planetRenderers) {
      existingMap.set(renderer.body, renderer);
    }

    const retained = new Set<PlanetRenderer>();
    const newRenderers: PlanetRenderer[] = [];
    const additions: PlanetRenderer[] = [];

    for (const body of uniqueBodies) {
      const renderer = existingMap.get(body);
      if (renderer) {
        newRenderers.push(renderer);
        retained.add(renderer);
      } else {
        const created = this.createRendererForBody(body);
        newRenderers.push(created);
        additions.push(created);
      }
    }

    const removed: PlanetRenderer[] = [];
    for (const renderer of this.planetRenderers) {
      if (!retained.has(renderer)) {
        removed.push(renderer);
      }
    }

    for (const renderer of removed) {
      this.destroyRenderer(renderer);
      this.completedPassRenderers.delete(renderer);
      this.pendingEntryTargets.delete(renderer);
    }

    this.planetRenderers = newRenderers;
    const hasPlanets = this.planetRenderers.length > 0;

    if (!hasPlanets) {
      this.simulationFrozen = true;
      this.pendingEntryTargets.clear();
      this.completedPassRenderers.clear();
      this.spawnWithoutHistory.clear();
      return;
    }

    const previouslyEmpty = previousCount === 0;
    if (previouslyEmpty) {
      this.simulationFrozen = false;
      this.reseedAfterPlanetActivation();
      return;
    }

    for (const renderer of additions) {
      this.initializeRendererEntry(renderer);
    }
  }

  private initializeRendererEntry(renderer: PlanetRenderer) {
    renderer.clearActiveTrail();
    renderer.setLastVisibleSample(null);
    this.spawnWithoutHistory.delete(renderer);

    const currentSample = renderer.computeSampleAt(this.simTimeMs);
    if (this.isSampleDrawable(currentSample)) {
      renderer.setLastVisibleSample(currentSample, this.simTimeMs);
      this.spawnWithoutHistory.add(renderer);
      return;
    }

    const entryPoint = this.seekNextVisibleSample(renderer, this.simTimeMs, 0);
    if (entryPoint) {
      this.pendingEntryTargets.set(renderer, entryPoint);
    }
  }

  private reseedAfterPlanetActivation() {
    this.spawnWithoutHistory.clear();
    let earliestEntryTime: number | null = null;
    const entryPoints = new Map<PlanetRenderer, PendingEntry>();

    for (const renderer of this.planetRenderers) {
      const entryPoint = this.findNextFutureEntryPoint(renderer, this.simTimeMs);
      if (!entryPoint) {
        continue;
      }

      entryPoints.set(renderer, entryPoint);
      if (earliestEntryTime === null || entryPoint.timeMs < earliestEntryTime) {
        earliestEntryTime = entryPoint.timeMs;
      }
    }

    if (earliestEntryTime === null) {
      for (const renderer of this.planetRenderers) {
        this.initializeRendererEntry(renderer);
      }
      return;
    }

    this.simTimeMs = earliestEntryTime;
    this.remainderMs = 0;
    this.syncRenderersToEntryPoints(entryPoints, earliestEntryTime);
  }

  private findNextFutureEntryPoint(renderer: PlanetRenderer, fromTimeMs: number) {
    const exitScanLimit = Math.ceil((48 * 3600 * 1000) / Math.max(1, this.stepMs));
    let searchTime = fromTimeMs;

    for (let i = 0; i < exitScanLimit; i += 1) {
      const sample = renderer.computeSampleAt(searchTime);
      if (!this.isSampleDrawable(sample)) {
        break;
      }
      searchTime += this.stepMs;
    }

    return this.seekNextVisibleSample(renderer, searchTime, 0);
  }

  private loop = (timestamp: number) => {
    if (this.lastFrameTime === null) {
      this.lastFrameTime = timestamp;
    }

    const deltaTime = timestamp - this.lastFrameTime;
    this.lastFrameTime = timestamp;
    this.lastFrameDurationMs = deltaTime;

    // Update FPS
    this.updateFPS(deltaTime);

    const deltaSimMs = deltaTime * this.config.playbackSpeed;
    this.advanceSimulation(deltaSimMs);
    this.render(deltaTime, deltaSimMs);
    this.animationHandle = requestAnimationFrame(this.loop);
  };

  private advanceSimulation(deltaSimMs: number) {
    if (deltaSimMs <= 0 || this.simulationFrozen || this.planetRenderers.length === 0) {
      return;
    }

    this.remainderMs += deltaSimMs;
    const stepsToProcess = Math.floor(this.remainderMs / this.stepMs);
    for (let i = 0; i < stepsToProcess; i += 1) {
      this.remainderMs -= this.stepMs;
      this.processStep(this.stepMs);
    }
  }

  private processStep(stepMs: number) {
    this.simTimeMs += stepMs;

    // Process each planet independently
    let anyPlanetDrawable = false;
    const jumpEnabled = this.jumpSetting !== 1;
    const trackingSweeps = jumpEnabled || this.pendingJumpSetting !== null;

    for (const renderer of this.planetRenderers) {
      if (trackingSweeps && this.completedPassRenderers.has(renderer)) {
        continue;
      }

      const pendingEntry = this.pendingEntryTargets.get(renderer);
      if (pendingEntry) {
        if (this.simTimeMs < pendingEntry.timeMs) {
          continue;
        }
        renderer.setLastVisibleSample(pendingEntry.sample, pendingEntry.timeMs);
        this.pendingEntryTargets.delete(renderer);
        this.spawnWithoutHistory.delete(renderer);
      }

      const sample = renderer.computeSampleAt(this.simTimeMs);
      const isDrawable = this.isSampleDrawable(sample);

      if (!isDrawable) {
        // Planet not drawable - mark for potential jump
        const lastSample = renderer.getLastVisibleSample();
        if (lastSample) {
          renderer.commitActiveTrailToHistory();
          renderer.setLastVisibleSample(null);
          if (trackingSweeps) {
            this.completedPassRenderers.add(renderer);
          }
        }
        continue;
      }

      anyPlanetDrawable = true;

      // Planet is drawable - paint segment
      let lastSample = renderer.getLastVisibleSample();
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
      }

      if (lastSample) {
        renderer.paintSegment(lastSample, sample);
      }

      renderer.setLastVisibleSample(sample, this.simTimeMs);
    }

    const sweepComplete =
      trackingSweeps && this.completedPassRenderers.size === this.planetRenderers.length;

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

  private performCoordinatedJump() {
    const jumpMs = this.getJumpMilliseconds();
    let earliestCrossingTime: number | null = null;
    const crossingInfos = new Map<PlanetRenderer, PendingEntry>();

    // Find the earliest horizon crossing among all planets
    for (const renderer of this.planetRenderers) {
      const crossingInfo = this.seekNextVisibleSample(renderer, this.simTimeMs, jumpMs);

      if (crossingInfo) {
        crossingInfos.set(renderer, crossingInfo);
        if (earliestCrossingTime === null || crossingInfo.timeMs < earliestCrossingTime) {
          earliestCrossingTime = crossingInfo.timeMs;
        }
      } else {
        crossingInfos.delete(renderer);
      }
    }

    if (earliestCrossingTime === null) {
      // No planet will be visible in lookahead window
      return;
    }

    // Warp to earliest crossing
    this.simTimeMs = earliestCrossingTime;
    this.remainderMs = 0;
    this.syncRenderersToEntryPoints(crossingInfos, earliestCrossingTime);
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

    let timeMs = fromTimeMs + jumpMs;
    for (let i = 0; i < maxIterations; i += 1) {
      const sample = renderer.computeSampleAt(timeMs);
      if (this.isSampleDrawable(sample)) {
        return this.findArcEntryPoint(renderer, timeMs);
      }

      // Adaptive stepping
      const cutoff = this.getCurvedHorizonAltitudeAtAzimuth(sample.azimuth);
      const depthBelowHorizon = cutoff - sample.altitude;
      let adaptiveStep = this.stepMs;

      if (depthBelowHorizon > 30) {
        adaptiveStep = 6 * 3600 * 1000;
      } else if (depthBelowHorizon > 15) {
        adaptiveStep = 2 * 3600 * 1000;
      } else if (depthBelowHorizon > 5) {
        adaptiveStep = 30 * 60 * 1000;
      }

      timeMs += adaptiveStep;
    }

    return null;
  }

  private findArcEntryPoint(
    renderer: PlanetRenderer,
    foundTimeMs: number
  ): { sample: HorizonSample; timeMs: number } {
    const coarseStepMs = 30 * 60 * 1000;
    const maxCoarseSteps = Math.ceil((24 * 3600 * 1000) / coarseStepMs);
    const backwardLimit = foundTimeMs - maxCoarseSteps * coarseStepMs;
    const forwardLimit = foundTimeMs + maxCoarseSteps * coarseStepMs;

    let upperState = this.evaluateVisibilityState(renderer, foundTimeMs);
    let lowerState = upperState;

    if (upperState.visibilityValue >= 0) {
      let bracketFound = false;
      for (let i = 0; i < maxCoarseSteps && !bracketFound; i += 1) {
        const candidateTime = upperState.timeMs - coarseStepMs;
        if (candidateTime < backwardLimit) break;

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
        if (candidateTime > forwardLimit) break;

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
    const horizonAlt = this.getCurvedHorizonAltitudeAtAzimuth(sample.azimuth);
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

    for (let i = 0; i < maxIterations && high.timeMs - low.timeMs > resolutionMs; i += 1) {
      const midTimeMs = (low.timeMs + high.timeMs) / 2;
      const midState = this.evaluateVisibilityState(renderer, midTimeMs);
      if (midState.visibilityValue < 0) {
        low = midState;
      } else {
        high = midState;
      }
    }

    if (low.visibilityValue >= 0) {
      const nudgedTime = low.timeMs - resolutionMs / 4;
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

  private render(deltaTime: number, deltaSimMs: number) {
    // Fade and age all planet trails
    for (const renderer of this.planetRenderers) {
      renderer.fadeTrailLayer(deltaSimMs);

      const currentSample = renderer.computeSampleAt(this.simTimeMs + this.remainderMs);
      if (this.isSampleVisible(currentSample)) {
        renderer.ageHistoryLayersByAzimuth(currentSample);
      }

      renderer.incrementHistoryLayerCycles(this.lastFrameDurationMs);
    }

    this.surface.clear();
    const visiblePlanets = this.collectVisiblePlanetSamples();
    this.blitStaticLayer(this.gridLayer, 'grid');

    // Draw all planet history layers
    for (const renderer of this.planetRenderers) {
      renderer.drawHistoryLayers(
        this.surface.context,
        this.cachedLogicalWidth,
        this.cachedLogicalHeight
      );
    }

    // Draw all planet active trails
    for (const renderer of this.planetRenderers) {
      renderer.drawActiveTrail(
        this.surface.context,
        this.cachedLogicalWidth,
        this.cachedLogicalHeight
      );
    }

    // Draw preview segments so slow sample intervals still look fluid
    this.drawPreviewSegments(visiblePlanets);

    // Draw glow halos and markers beneath the horizon
    this.drawMarkerGlows(visiblePlanets);
    this.drawMarkerCores(visiblePlanets);

    this.blitStaticLayer(this.horizonLayer, 'horizon');
    this.drawAxesLabels(this.cachedLogicalWidth);
    this.drawInfo(visiblePlanets);
    this.drawFPS();
  }

  private collectVisiblePlanetSamples(): VisiblePlanetSample[] {
    const visible: VisiblePlanetSample[] = [];
    const previewTime = this.simTimeMs + this.remainderMs;
    const trackingSweeps = this.jumpSetting !== 1 || this.pendingJumpSetting !== null;

    for (const renderer of this.planetRenderers) {
      if (
        (trackingSweeps && this.completedPassRenderers.has(renderer)) ||
        this.pendingEntryTargets.has(renderer)
      ) {
        continue;
      }

      const previewSample = renderer.computeSampleAt(previewTime);
      if (!this.isSampleVisible(previewSample)) {
        continue;
      }

      const lastSample = renderer.getLastVisibleSample();
      const markerSample = this.isSampleVisible(previewSample)
        ? previewSample
        : lastSample ?? previewSample;

      visible.push({
        renderer,
        previewSample,
        markerSample,
      });
    }

    return visible;
  }

  private drawMarkerGlows(visiblePlanets: VisiblePlanetSample[]) {
    const ctx = this.surface.context;
    ctx.save();

    for (const { renderer, markerSample } of visiblePlanets) {
      const x = this.mapAzimuth(markerSample.azimuth);
      const y = this.mapAltitude(markerSample.altitude);
      const color = renderer.color;

      // Draw o-scope style glow (outer halo)
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.15;
      ctx.beginPath();
      ctx.arc(x, y, 8, 0, Math.PI * 2);
      ctx.fill();

      // Draw medium glow
      ctx.globalAlpha = 0.3;
      ctx.beginPath();
      ctx.arc(x, y, 8, 0, Math.PI * 2);
      ctx.fill();

      // Draw brighter inner glow
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  private drawMarkerCores(visiblePlanets: VisiblePlanetSample[]) {
    const ctx = this.surface.context;
    ctx.save();

    for (const { renderer, markerSample } of visiblePlanets) {
      const x = this.mapAzimuth(markerSample.azimuth);
      const y = this.mapAltitude(markerSample.altitude);

      // Draw main planet marker (sharp and bright)
      ctx.fillStyle = renderer.color;
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  private drawPreviewSegments(visiblePlanets: VisiblePlanetSample[]) {
    const ctx = this.surface.context;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const { renderer, previewSample } of visiblePlanets) {
      const anchor = renderer.getLastVisibleSample();
      if (!anchor) {
        continue;
      }
      const startX = this.mapAzimuth(anchor.azimuth);
      const startY = this.mapAltitude(anchor.altitude);
      const endX = this.mapAzimuth(previewSample.azimuth);
      const endY = this.mapAltitude(previewSample.altitude);
      if (!Number.isFinite(startX + startY + endX + endY)) {
        continue;
      }

      ctx.strokeStyle = renderer.color;
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.lineTo(endX, endY);
      ctx.stroke();
    }
    ctx.restore();
  }


  private drawInfo(visiblePlanets: VisiblePlanetSample[]) {
    const ctx = this.surface.context;

    ctx.save();
    ctx.font = '12px "JetBrains Mono", "Fira Code", monospace';
    const padding = 12;
    const textY = padding + 12;

    let label: string;
    if (this.config.bodies.length === 0) {
      label = 'No planets selected · Simulation paused';
    } else if (visiblePlanets.length > 0) {
      const firstSample = visiblePlanets[0].previewSample;
      const elapsed = this.formatElapsedTime(firstSample.time);
      const planetList = visiblePlanets.map((p) => p.renderer.body).join(', ');
      label = [
        `Visible: ${planetList}`,
        `Observer: ${this.formatObserver(this.config.observer)}`,
        `Start (UTC): ${this.config.startTime.toISOString().slice(0, 16)}`,
        `Frame (UTC): ${firstSample.time.toISOString().slice(0, 19)}`,
        `Elapsed: ${elapsed}`,
      ].join('  ·  ');
    } else if (this.jumpSetting === 1) {
      const currentTime = new Date(this.baseTimestamp + this.simTimeMs + this.remainderMs);
      const elapsed = this.formatElapsedTime(currentTime);
      label = [
        `Planets: ${this.config.bodies.join(', ')}`,
        `Observer: ${this.formatObserver(this.config.observer)}`,
        `Start (UTC): ${this.config.startTime.toISOString().slice(0, 16)}`,
        `Frame (UTC): ${currentTime.toISOString().slice(0, 19)}`,
        `Elapsed: ${elapsed}`,
      ].join('  ·  ');
    } else {
      label = [
        `Planets: ${this.config.bodies.join(', ')}`,
        `Observer: ${this.formatObserver(this.config.observer)}`,
        `Start (UTC): ${this.config.startTime.toISOString().slice(0, 16)}`,
        'Waiting for next visible arc...',
      ].join('  ·  ');
    }

    ctx.fillStyle = '#cfcfcf';
    ctx.fillText(label, padding, textY);
    ctx.restore();
  }

  private drawAxesLabels(width: number) {
    const ctx = this.surface.context;
    ctx.save();
    ctx.fillStyle = '#8a8a8a';
    ctx.font = '10px "JetBrains Mono", "Fira Code", monospace';

    const azLabels = ['0°', '90°', '180°', '270°'];
    for (let i = 0; i < azLabels.length; i++) {
      const x = this.mapAzimuth(i * 90);
      ctx.fillText(azLabels[i], x + 4, 12);
    }

    for (let alt = this.altitudeRange.min; alt <= this.altitudeRange.max; alt += 30) {
      const y = this.mapAltitude(alt);
      ctx.fillText(`${alt}°`, width - 36, y - 4);
    }

    ctx.restore();
  }

  private formatObserver(observer: Observer) {
    const latLabel = `${Math.abs(observer.latitude).toFixed(2)}°${observer.latitude >= 0 ? 'N' : 'S'}`;
    const lonLabel = `${Math.abs(observer.longitude).toFixed(2)}°${observer.longitude >= 0 ? 'E' : 'W'}`;
    return `${latLabel} ${lonLabel}`;
  }

  private formatElapsedTime(frameTime: Date) {
    const elapsedMs = frameTime.getTime() - this.config.startTime.getTime();
    const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const parts = [];
    if (days > 0) {
      parts.push(`${days}d`);
    }
    parts.push(`${hours.toString().padStart(2, '0')}h`);
    parts.push(`${minutes.toString().padStart(2, '0')}m`);
    parts.push(`${seconds.toString().padStart(2, '0')}s`);
    return parts.join(' ');
  }

  private updateFPS(deltaTime: number) {
    this.fpsFrameTimes.push(deltaTime);
    if (this.fpsFrameTimes.length > 60) {
      this.fpsFrameTimes.shift();
    }

    if (this.fpsFrameTimes.length > 0) {
      const avgDelta = this.fpsFrameTimes.reduce((a, b) => a + b, 0) / this.fpsFrameTimes.length;
      this.fps = avgDelta > 0 ? Math.round(1000 / avgDelta) : 0;
    }
  }

  private drawFPS() {
    const ctx = this.surface.context;
    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 16px "JetBrains Mono", "Fira Code", monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    const padding = 12;
    const text = `${this.fps} FPS`;
    ctx.fillText(text, this.cachedLogicalWidth - padding, padding);
    ctx.restore();
  }

  // Coordinate mapping functions
  private mapAzimuth(azimuth: number) {
    return azimuth * this.AZIMUTH_TO_NORMALIZED * this.cachedLogicalWidth;
  }

  private mapAltitude(altitude: number) {
    const { min, max } = this.altitudeRange;
    const clamped = Math.max(min, Math.min(max, altitude));
    const height = this.cachedLogicalHeight;
    const paddingTop = this.getTopPaddingPx();
    if (height <= 0) {
      return 0;
    }

    const usableHeight = Math.max(1, height - paddingTop);
    const ratio = (clamped - min) / (max - min || 1);
    return paddingTop + usableHeight * (1 - ratio);
  }

  private toCanvasPoint(point: SamplePoint): { x: number; y: number } {
    return {
      x: this.mapAzimuth(point.azimuth),
      y: this.mapAltitude(point.altitude),
    };
  }

  private getCurvedHorizonY(x: number) {
    const width = this.cachedLogicalWidth;
    const base = this.mapAltitude(0);
    if (width <= 0) return base;

    const amplitude = Math.min(20, this.cachedLogicalHeight * 0.03);
    const normalized = x / width;
    return base - Math.sin(normalized * Math.PI) * amplitude;
  }

  private unmapAltitude(y: number) {
    const height = this.cachedLogicalHeight;
    const { min, max } = this.altitudeRange;
    if (height <= 0) return min;

    const paddingTop = this.getTopPaddingPx();
    const usableHeight = Math.max(1, height - paddingTop);
    const clampedY = Math.max(paddingTop, Math.min(height, y));
    const ratio = 1 - (clampedY - paddingTop) / usableHeight;
    return ratio * (max - min) + min;
  }

  private getTopPaddingPx() {
    const height = this.cachedLogicalHeight;
    if (height <= 0) {
      return 0;
    }
    return Math.max(24, height * 0.04);
  }

  private getCurvedHorizonAltitudeAtAzimuth(azimuth: number) {
    const x = this.mapAzimuth(azimuth);
    const y = this.getCurvedHorizonY(x);
    // Offset by 8 logical pixels to match visual horizon offset
    return this.unmapAltitude(y + 8);
  }

  private isSampleVisible(sample: HorizonSample) {
    const cutoff = this.getCurvedHorizonAltitudeAtAzimuth(sample.azimuth);
    return sample.altitude >= cutoff;
  }

  private isSampleDrawable(sample: HorizonSample) {
    const cutoff = this.getCurvedHorizonAltitudeAtAzimuth(sample.azimuth);
    const tolerance = 5;
    return sample.altitude >= cutoff - tolerance;
  }

  // Canvas pool management
  private acquireHistoryCanvas(): HTMLCanvasElement {
    const canvas = this.historyCanvasPool.pop() ?? document.createElement('canvas');
    const targetWidth = this.surface.canvas.width;
    const targetHeight = this.surface.canvas.height;

    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      canvas.style.width = this.surface.canvas.style.width;
      canvas.style.height = this.surface.canvas.style.height;
    }

    return canvas;
  }

  private releaseHistoryCanvas(canvas: HTMLCanvasElement) {
    this.historyCanvasPool.push(canvas);
  }

  // Static layer management
  private updateDimensionCache() {
    this.cachedLogicalWidth = this.getLogicalWidth();
    this.cachedLogicalHeight = this.getLogicalHeight();
  }

  private getLogicalWidth() {
    return this.surface.canvas.width / this.surface.pixelRatio;
  }

  private getLogicalHeight() {
    return this.surface.canvas.height / this.surface.pixelRatio;
  }

  private ensureStaticLayers() {
    const width = this.surface.canvas.width;
    const height = this.surface.canvas.height;

    if (
      this.staticLayerSize.width === width &&
      this.staticLayerSize.height === height &&
      this.gridLayer !== null &&
      this.horizonLayer !== null
    ) {
      return;
    }

    this.staticLayerSize = { width, height };

    this.gridLayer = document.createElement('canvas');
    this.gridLayer.width = width;
    this.gridLayer.height = height;
    const gridCtx = this.gridLayer.getContext('2d');
    if (gridCtx) {
      this.renderGridLayer(gridCtx, width, height);
    }

    this.horizonLayer = document.createElement('canvas');
    this.horizonLayer.width = width;
    this.horizonLayer.height = height;
    const horizonCtx = this.horizonLayer.getContext('2d');
    if (horizonCtx) {
      this.renderHorizonLayer(horizonCtx, width, height);
    }
  }

  private renderGridLayer(ctx: CanvasRenderingContext2D, width: number, height: number) {
    ctx.save();
    ctx.clearRect(0, 0, width, height);
    for (let az = 0; az < 360; az += 30) {
      ctx.beginPath();
      const x = az * this.AZIMUTH_TO_NORMALIZED * width;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.strokeStyle = '#111';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.restore();
  }

  private renderHorizonLayer(ctx: CanvasRenderingContext2D, width: number, height: number) {
    ctx.save();
    ctx.clearRect(0, 0, width, height);

    // Scale logical coordinates to physical canvas coordinates
    const pixelRatio = this.surface.pixelRatio;
    const base = this.mapAltitude(0) * pixelRatio;
    const gradientDepth = Math.min(80, this.cachedLogicalHeight * 0.15) * pixelRatio;

    // Offset entire horizon DOWN by 8 logical pixels (outer glow radius)
    // This allows glow to smoothly pass beneath the visible horizon line
    const glowOffset = 8 * pixelRatio;

    // Draw opaque fill region starting at offset horizon curve
    ctx.beginPath();
    this.traceHorizonCurvePhysical(ctx, width, glowOffset);
    ctx.lineTo(width, height);
    ctx.lineTo(0, height);
    ctx.closePath();
    ctx.fillStyle = '#070707';
    ctx.fill();

    // Curved atmospheric glow hugging the horizon (also offset)
    const gradient = ctx.createLinearGradient(
      0,
      base + glowOffset - 30 * pixelRatio,
      0,
      base + glowOffset + gradientDepth
    );
    gradient.addColorStop(0, 'rgba(255, 255, 255, 0.08)');
    gradient.addColorStop(0.4, 'rgba(255, 255, 255, 0.18)');
    gradient.addColorStop(1, 'rgba(5, 5, 5, 0)');

    ctx.beginPath();
    this.traceHorizonCurvePhysical(ctx, width, glowOffset);
    ctx.lineTo(width, base + glowOffset + gradientDepth);
    ctx.lineTo(0, base + glowOffset + gradientDepth);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    // Draw horizon line at offset position
    ctx.beginPath();
    this.traceHorizonCurvePhysical(ctx, width, glowOffset);
    ctx.strokeStyle = '#2a2a2a';
    ctx.lineWidth = 2 * pixelRatio;
    ctx.stroke();
    ctx.restore();
  }

  private traceHorizonCurvePhysical(ctx: CanvasRenderingContext2D, width: number, offsetY: number = 0) {
    const pixelRatio = this.surface.pixelRatio;
    ctx.moveTo(0, this.getCurvedHorizonY(0 / pixelRatio) * pixelRatio + offsetY);
    const steps = Math.max(24, Math.floor(width / (30 * pixelRatio)));
    const step = width / steps;
    for (let i = 1; i <= steps; i += 1) {
      const x = Math.min(width, i * step);
      const logicalX = x / pixelRatio;
      ctx.lineTo(x, this.getCurvedHorizonY(logicalX) * pixelRatio + offsetY);
    }
  }

  private blitStaticLayer(layer: HTMLCanvasElement | null, type: 'grid' | 'horizon') {
    if (!layer) {
      this.ensureStaticLayers();
      layer = type === 'grid' ? this.gridLayer : this.horizonLayer;
      if (!layer) return;
    }

    const ctx = this.surface.context;
    ctx.drawImage(
      layer,
      0,
      0,
      layer.width,
      layer.height,
      0,
      0,
      this.cachedLogicalWidth,
      this.cachedLogicalHeight
    );
  }

  private handleResize = () => {
    this.surface.resize();
    this.updateDimensionCache();
    this.ensureStaticLayers();
    for (const renderer of this.planetRenderers) {
      renderer.handleResize(this.surface.canvas, this.surface.pixelRatio);
    }
  };
}
