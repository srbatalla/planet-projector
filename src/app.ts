import { Body, Observer } from 'astronomy-engine';
import { MultiPlanetView } from './views/horizon/multiPlanetView';
import { SpirographView } from './views/spirograph/spirographView';
import { SPECIAL_OBJECTS } from './core/specialObjects';

type ControlState = {
  planets: Body[];
  latitude: number;
  longitude: number;
  elevation: number;
  sampleMinutes: number;
  playbackSpeed: number;
  spiroPlaybackSpeed: number;
  spiroPerspective: Body;
  spiroSpecialEnabled: boolean;
  spiroSpecialId: string | null;
  startTime: Date;
  jumpSetting: number;
  trailPersistence: number;
  cycleLimit: number;
  activeFadeRate: number;
  azimuthCheckpointInterval: number;
};

const PLANET_OPTIONS: { label: string; value: Body }[] = [
  { label: 'Sun', value: Body.Sun },
  { label: 'Mercury', value: Body.Mercury },
  { label: 'Venus', value: Body.Venus },
  { label: 'Earth', value: Body.Earth },
  { label: 'Mars', value: Body.Mars },
  { label: 'Jupiter', value: Body.Jupiter },
  { label: 'Saturn', value: Body.Saturn },
  { label: 'Uranus', value: Body.Uranus },
  { label: 'Neptune', value: Body.Neptune },
];

const DEFAULTS: ControlState = {
  planets: [Body.Mars],
  latitude: 37.7749,
  longitude: -122.4194,
  elevation: 0,
  sampleMinutes: 5,
  playbackSpeed: 10000,
  spiroPlaybackSpeed: 2500000,
  spiroPerspective: Body.Earth,
  spiroSpecialEnabled: false,
  spiroSpecialId: null,
  startTime: new Date(),
  jumpSetting: 3,
  trailPersistence: 15,
  cycleLimit: 0,
  activeFadeRate: 0.0001,
  azimuthCheckpointInterval: 10,
};

const SPEED_STEPS = [1, 1000, 5000, 10000, 20000, 50000, 100000, 500000];
const SPIRO_SPEED_STEPS = [
  1,
  2500000,
  5000000,
  15000000,
  30000000,
  100000000,
  1000000000,
  Number.POSITIVE_INFINITY,
];
const DEFAULT_SPIRO_SAMPLE_MINUTES = 1440;
const PERSPECTIVE_OPTIONS: { label: string; value: Body }[] = PLANET_OPTIONS;

type ViewMode = 'horizon' | 'spirograph';
type ActiveView = MultiPlanetView | SpirographView;

function sliderToSpeed(sliderValue: number): number {
  // Direct mapping: slider 1-8 -> [1, 1k, 5k, 10k, 20k, 50k, 100k, 500k]
  const index = Math.max(0, Math.min(SPEED_STEPS.length - 1, sliderValue - 1));
  return SPEED_STEPS[index];
}

function speedToSlider(speed: number): number {
  // Find closest speed step
  let closestIndex = 0;
  let closestDiff = Math.abs(speed - SPEED_STEPS[0]);

  for (let i = 1; i < SPEED_STEPS.length; i++) {
    const diff = Math.abs(speed - SPEED_STEPS[i]);
    if (diff < closestDiff) {
      closestDiff = diff;
      closestIndex = i;
    }
  }

  return closestIndex + 1;
}

function formatSpeedLabel(speed: number): string {
  if (speed >= 1000000) {
    return `${(speed / 1000000).toFixed(0)}M×`;
  }
  if (speed >= 1000) {
    return `${(speed / 1000).toFixed(0)}k×`;
  }
  return `${speed}×`;
}

function formatExactSpeedLabel(speed: number) {
  if (speed >= 1000) {
    if (speed >= 1000000000) {
      const inBillions = speed / 1000000000;
      const roundedB = Math.round(inBillions * 10) / 10;
      return `${roundedB}B×`;
    }
    const inMillions = speed / 1000000;
    if (inMillions >= 1) {
      const rounded = Math.round(inMillions * 10) / 10;
      return `${rounded}M×`;
    }
    const kValue = Math.round(speed / 1000);
    return `${kValue}k×`;
  }
  return `${Math.round(speed)}×`;
}

function spiroSliderToSpeed(sliderValue: number): number {
  const index = Math.max(0, Math.min(SPIRO_SPEED_STEPS.length - 1, Math.round(sliderValue - 1)));
  return SPIRO_SPEED_STEPS[index];
}

function spiroSpeedToSlider(speed: number): number {
  let closestIndex = 0;
  let closestDiff = Math.abs(speed - SPIRO_SPEED_STEPS[0]);
  for (let i = 1; i < SPIRO_SPEED_STEPS.length; i += 1) {
    const diff = Math.abs(speed - SPIRO_SPEED_STEPS[i]);
    if (diff < closestDiff) {
      closestDiff = diff;
      closestIndex = i;
    }
  }
  return closestIndex + 1;
}

function updateHorizonSpeedLabel(root: HTMLElement) {
  const slider = root.querySelector<HTMLInputElement>('input[name="horizonPlaybackSpeed"]');
  const display = root.querySelector<HTMLElement>('[data-horizon-speed-display]');
  if (!slider || !display) {
    return;
  }
  const sliderValue = Number(slider.value) || speedToSlider(DEFAULTS.playbackSpeed);
  const speed = sliderToSpeed(sliderValue);
  display.textContent = formatSpeedLabel(speed);
}

function updateSpiroSpeedLabel(root: HTMLElement) {
  const slider = root.querySelector<HTMLInputElement>('input[name="spiroPlaybackSpeed"]');
  const display = root.querySelector<HTMLElement>('[data-spiro-speed-display]');
  if (!slider || !display) {
    return;
  }
  const sliderValue = Number(slider.value) || spiroSpeedToSlider(DEFAULTS.spiroPlaybackSpeed);
  const speed = spiroSliderToSpeed(sliderValue);
  display.textContent = Number.isFinite(speed) ? formatExactSpeedLabel(speed) : 'Maximum Overdrive';
}

function formatJumpLabel(setting: number) {
  if (setting === 1) {
    return 'None';
  }
  if (setting === 2) {
    return 'Next';
  }
  if (setting <= 6) {
    const weeks = setting - 2;
    return `${weeks} wk${weeks === 1 ? '' : 's'}`;
  }
  const monthSteps = setting - 6;
  return `${monthSteps} mo${monthSteps === 1 ? '' : 's'}`;
}

function updateJumpLabel(root: HTMLElement) {
  const slider = root.querySelector<HTMLInputElement>('input[name="jumpSetting"]');
  const display = root.querySelector<HTMLElement>('[data-jump-display]');
  if (!slider || !display) {
    return;
  }
  const value = Number(slider.value) || DEFAULTS.jumpSetting;
  display.textContent = formatJumpLabel(value);
}

function updateAzimuthCheckpointLabel(root: HTMLElement) {
  const slider = root.querySelector<HTMLInputElement>('input[name="azimuthCheckpointInterval"]');
  const display = root.querySelector<HTMLElement>('[data-azimuth-checkpoint-display]');
  if (!slider || !display) {
    return;
  }
  const value = Number(slider.value) || DEFAULTS.azimuthCheckpointInterval;
  display.textContent = `${value}°`;
}

export function initializeApp() {
  const target = document.querySelector<HTMLDivElement>('#app');
  if (!target) {
    throw new Error('Root container #app missing.');
  }

  target.innerHTML = '';
  const panel = document.createElement('div');
  panel.className = 'panel';
  target.appendChild(panel);

  const heading = document.createElement('h1');
  heading.textContent = 'Horizon Streak · Prototype Controls';
  panel.appendChild(heading);

  const tabBar = document.createElement('div');
  tabBar.className = 'view-tabs';

  const horizonTab = document.createElement('button');
  horizonTab.type = 'button';
  horizonTab.textContent = 'Horizon';

  const spiroTab = document.createElement('button');
  spiroTab.type = 'button';
  spiroTab.textContent = 'Spirograph';

  tabBar.append(horizonTab, spiroTab);
  panel.appendChild(tabBar);

  const layout = document.createElement('div');
  layout.className = 'layout';
  panel.appendChild(layout);

  const controls = createControls();
  layout.appendChild(controls);
  updateJumpLabel(controls);
  updateHorizonSpeedLabel(controls);
  updateSpiroSpeedLabel(controls);
  updateAzimuthCheckpointLabel(controls);

  const planetCheckboxInputs = Array.from(
    controls.querySelectorAll<HTMLInputElement>('input[name="planet"]')
  );
  const perspectiveSelect = controls.querySelector<HTMLSelectElement>('select[name="spiroPerspective"]');

  const canvasHost = document.createElement('div');
  canvasHost.className = 'canvas-host';
  layout.appendChild(canvasHost);

  let view: ActiveView | null = null;
  let activeMode: ViewMode = 'horizon';

  const specialToggle = controls.querySelector<HTMLInputElement>('input[name="spiroSpecialEnabled"]');
  const specialSelect = controls.querySelector<HTMLSelectElement>('select[name="spiroSpecialId"]');

  const syncViewControlVisibility = () => {
    const viewControls = controls.querySelectorAll<HTMLElement>('[data-view]');
    viewControls.forEach((element) => {
      const target = element.getAttribute('data-view');
      if (!target) {
        return;
      }
      element.style.display = target === activeMode ? '' : 'none';
    });
  };

  const syncSpecialControls = () => {
    if (!specialToggle || !specialSelect) {
      return;
    }
    specialSelect.disabled = !specialToggle.checked;
  };

  const syncPerspectiveExclusion = () => {
    const perspectiveValue = perspectiveSelect?.value ?? `${DEFAULTS.spiroPerspective}`;
    planetCheckboxInputs.forEach((input) => {
      const label = input.closest('label');
      if (input.value === perspectiveValue) {
        input.checked = false;
        input.disabled = true;
        label?.classList.add('disabled');
      } else {
        input.disabled = false;
        label?.classList.remove('disabled');
      }
    });
  };

  const updateTabState = () => {
    horizonTab.classList.toggle('active', activeMode === 'horizon');
    spiroTab.classList.toggle('active', activeMode === 'spirograph');
    syncViewControlVisibility();
    syncPerspectiveExclusion();
    syncSpecialControls();
  };

  const setActiveMode = (mode: ViewMode) => {
    if (mode === activeMode) {
      return;
    }
    activeMode = mode;
    updateTabState();
    refreshView();
  };

  updateTabState();

  const refreshView = () => {
    const state = readControlState(controls);
    canvasHost.innerHTML = '';
    view?.stop();
    const filteredPlanets = state.planets.filter((body) => body !== state.spiroPerspective);

    if (filteredPlanets.length === 0 && !(state.spiroSpecialEnabled && state.spiroSpecialId)) {
      const empty = document.createElement('p');
      empty.textContent =
        activeMode === 'horizon'
          ? 'Select at least one planet to render a trail.'
          : 'Select at least one planet to render a spirograph.';
      canvasHost.appendChild(empty);
      view = null;
      return;
    }
    if (activeMode === 'horizon') {
      const observer = new Observer(state.latitude, state.longitude, state.elevation);
      view = new MultiPlanetView(canvasHost, {
        bodies: filteredPlanets,
        observer,
        sampleMinutes: state.sampleMinutes,
        startTime: state.startTime,
        playbackSpeed: state.playbackSpeed,
        jumpSetting: state.jumpSetting,
        trailPersistence: state.trailPersistence,
        cycleLimit: state.cycleLimit,
        activeFadeRate: state.activeFadeRate,
        azimuthCheckpointInterval: state.azimuthCheckpointInterval,
      });
    } else {
      const effectiveSampleMinutes =
        state.sampleMinutes === DEFAULTS.sampleMinutes
          ? DEFAULT_SPIRO_SAMPLE_MINUTES
          : state.sampleMinutes;
      view = new SpirographView(canvasHost, {
        bodies: filteredPlanets,
        startTime: state.startTime,
        sampleMinutes: effectiveSampleMinutes,
        playbackSpeed: state.spiroPlaybackSpeed,
        perspectiveBody: state.spiroPerspective,
        special: state.spiroSpecialEnabled && state.spiroSpecialId
          ? SPECIAL_OBJECTS.find((obj) => obj.id === state.spiroSpecialId) ?? null
          : null,
      });
    }
    view.start();
  };

  horizonTab.addEventListener('click', () => setActiveMode('horizon'));
  spiroTab.addEventListener('click', () => setActiveMode('spirograph'));

  const updateHorizonPlaybackSpeed = () => {
    if (view && activeMode === 'horizon' && view instanceof MultiPlanetView) {
      const state = readControlState(controls);
      view.updatePlaybackSpeed(state.playbackSpeed);
    }
  };

  const updateSpiroPlaybackSpeed = () => {
    if (view && activeMode === 'spirograph' && view instanceof SpirographView) {
      const state = readControlState(controls);
      view.updatePlaybackSpeed(state.spiroPlaybackSpeed);
    }
  };

  let refreshHandle: number | null = null;
  const scheduleRefresh = () => {
    updateJumpLabel(controls);
    updateHorizonSpeedLabel(controls);
    updateSpiroSpeedLabel(controls);
    updateAzimuthCheckpointLabel(controls);
    if (refreshHandle !== null) {
      cancelAnimationFrame(refreshHandle);
    }
    refreshHandle = requestAnimationFrame(() => {
      refreshHandle = null;
      refreshView();
    });
  };

  const applyJumpSetting = () => {
    updateJumpLabel(controls);
    const slider = controls.querySelector<HTMLInputElement>('input[name="jumpSetting"]');
    const value = slider ? Number(slider.value) : DEFAULTS.jumpSetting;
    if (!view) {
      scheduleRefresh();
      return;
    }
    if (activeMode === 'horizon' && view instanceof MultiPlanetView) {
      view.updateJumpSetting(value);
    }
  };

  const applyPlanetSelection = () => {
    const state = readControlState(controls);
    if (!view) {
      scheduleRefresh();
      return;
    }
    view.updatePlanets(state.planets);
  };

  const handleControlEvent = (event: Event) => {
    const target = event.target as HTMLElement | null;
    const name = target?.getAttribute('name');
    if (name === 'horizonPlaybackSpeed') {
      updateHorizonSpeedLabel(controls);
      updateHorizonPlaybackSpeed();
      return;
    }

    if (name === 'spiroPlaybackSpeed') {
      updateSpiroSpeedLabel(controls);
      updateSpiroPlaybackSpeed();
      return;
    }

    if (name === 'spiroPerspective') {
      syncPerspectiveExclusion();
      scheduleRefresh();
      return;
    }

    if (name === 'spiroSpecialEnabled') {
      syncSpecialControls();
      scheduleRefresh();
      return;
    }

    if (name === 'jumpSetting') {
      applyJumpSetting();
      return;
    }

    if (name === 'planet') {
      applyPlanetSelection();
      return;
    }

    scheduleRefresh();
  };

  controls.addEventListener('input', handleControlEvent);
  controls.addEventListener('change', handleControlEvent);
  controls.addEventListener('submit', (event) => {
    event.preventDefault();
    scheduleRefresh();
  });

  refreshView();
}

function createControls() {
  const form = document.createElement('form');
  form.className = 'controls';

  const defaultPlanets = new Set(DEFAULTS.planets);
  const perspectiveOptions = PERSPECTIVE_OPTIONS.map(
    (option) =>
      `<option value="${option.value}" ${option.value === DEFAULTS.spiroPerspective ? 'selected' : ''}>
        ${option.label}
      </option>`
  ).join('');

  const planetCheckboxes = PLANET_OPTIONS.map(
    (option) =>
      `<label class="checkbox">
        <input type="checkbox" name="planet" value="${option.value}" ${defaultPlanets.has(option.value) ? 'checked' : ''} />
        <span>${option.label}</span>
      </label>`,
  ).join('');

  form.innerHTML = `
    <label class="select" data-view="spirograph">
      <span>Perspective body</span>
      <select name="spiroPerspective">
        ${perspectiveOptions}
      </select>
    </label>
    <label class="checkbox" data-view="spirograph">
      <input type="checkbox" name="spiroSpecialEnabled" />
      <span>Enable special object</span>
    </label>
    <label class="select" data-view="spirograph">
      <span>Special object</span>
      <select name="spiroSpecialId" disabled>
        <option value="">None</option>
        ${SPECIAL_OBJECTS.map((special) => `<option value="${special.id}">${special.name}</option>`).join('')}
      </select>
    </label>
    <fieldset class="planet-picker">
      <legend>Planets</legend>
      <div class="planet-checkboxes">
        ${planetCheckboxes}
      </div>
    </fieldset>
    <label>
      <span>Latitude (°)</span>
      <input type="number" name="latitude" step="0.0001" value="${DEFAULTS.latitude}" />
    </label>
    <label>
      <span>Longitude (°)</span>
      <input type="number" name="longitude" step="0.0001" value="${DEFAULTS.longitude}" />
    </label>
    <label>
      <span>Elevation (m)</span>
      <input type="number" name="elevation" step="1" value="${DEFAULTS.elevation}" />
    </label>
    <label>
      <span>Trail lifespan (cycles)</span>
      <input type="number" name="trailPersistence" min="1" step="1" value="${DEFAULTS.trailPersistence}" />
    </label>
    <label>
      <span>Cycle limit</span>
      <input type="number" name="cycleLimit" min="0" step="1" value="${DEFAULTS.cycleLimit}" />
    </label>
    <label>
      <span>Sample step (min)</span>
      <input type="number" name="sampleMinutes" min="0.1" step="0.5" value="${DEFAULTS.sampleMinutes}" />
    </label>
    <label class="slider" data-view="horizon">
      <span>Horizon speed</span>
      <input type="range" name="horizonPlaybackSpeed" min="1" max="8" value="${speedToSlider(DEFAULTS.playbackSpeed)}" />
      <small data-horizon-speed-display>${formatSpeedLabel(DEFAULTS.playbackSpeed)}</small>
    </label>
    <label class="slider" data-view="spirograph">
      <span>Spirograph speed</span>
      <input type="range" name="spiroPlaybackSpeed" min="1" max="${SPIRO_SPEED_STEPS.length}" value="${spiroSpeedToSlider(DEFAULTS.spiroPlaybackSpeed)}" />
      <small data-spiro-speed-display>${formatExactSpeedLabel(DEFAULTS.spiroPlaybackSpeed)}</small>
    </label>
    <label>
      <span>Active sweep fade rate</span>
      <input type="number" name="activeFadeRate" min="0" max="0.01" step="0.0001" value="${DEFAULTS.activeFadeRate}" />
    </label>
    <label class="slider">
      <span>Azimuth checkpoint interval</span>
      <input type="range" name="azimuthCheckpointInterval" min="2" max="30" value="${DEFAULTS.azimuthCheckpointInterval}" />
      <small data-azimuth-checkpoint-display>${DEFAULTS.azimuthCheckpointInterval}°</small>
    </label>
    <label class="slider">
      <span>Jump interval</span>
      <input type="range" name="jumpSetting" min="1" max="12" value="${DEFAULTS.jumpSetting}" />
      <small data-jump-display>${formatJumpLabel(DEFAULTS.jumpSetting)}</small>
    </label>
    <label>
      <span>Start time (local)</span>
      <input type="datetime-local" name="startTime" value="${toDatetimeLocal(DEFAULTS.startTime)}" />
    </label>
  `;

  return form;
}

function readControlState(root: HTMLElement): ControlState {
  const getNumber = (selector: string, fallback: number, min?: number) => {
    const input = root.querySelector<HTMLInputElement>(selector);
    if (!input) {
      return fallback;
    }
    const value = Number(input.value);
    if (!Number.isFinite(value)) {
      return fallback;
    }
    if (typeof min === 'number' && value < min) {
      return min;
    }
    return value;
  };

  const planetInputs = Array.from(root.querySelectorAll<HTMLInputElement>('input[name="planet"]'));
  const selectedPlanets = planetInputs
    .filter((input) => input.checked && !input.disabled)
    .map((input) => input.value as Body);
  const startValue = root.querySelector<HTMLInputElement>('input[name="startTime"]')?.value;
  const startTime = startValue ? new Date(startValue) : new Date();

  const playbackSlider = root.querySelector<HTMLInputElement>('input[name="horizonPlaybackSpeed"]');
  const playbackSliderValue = playbackSlider ? Number(playbackSlider.value) : speedToSlider(DEFAULTS.playbackSpeed);
  const playbackSpeed = sliderToSpeed(playbackSliderValue);

  const spiroSlider = root.querySelector<HTMLInputElement>('input[name="spiroPlaybackSpeed"]');
  const spiroSliderValue = spiroSlider ? Number(spiroSlider.value) : spiroSpeedToSlider(DEFAULTS.spiroPlaybackSpeed);
  const spiroPlaybackSpeed = spiroSliderToSpeed(spiroSliderValue);
  const perspectiveSelect = root.querySelector<HTMLSelectElement>('select[name="spiroPerspective"]');
  const spiroPerspective = perspectiveSelect
    ? (perspectiveSelect.value as Body)
    : DEFAULTS.spiroPerspective;
  const spiroSpecialEnabled = root.querySelector<HTMLInputElement>('input[name="spiroSpecialEnabled"]')?.checked ?? false;
  const specialSelect = root.querySelector<HTMLSelectElement>('select[name="spiroSpecialId"]');
  const spiroSpecialId = specialSelect?.value || null;

  return {
    planets: selectedPlanets,
    latitude: getNumber('input[name="latitude"]', DEFAULTS.latitude),
    longitude: getNumber('input[name="longitude"]', DEFAULTS.longitude),
    elevation: getNumber('input[name="elevation"]', DEFAULTS.elevation),
    sampleMinutes: getNumber('input[name="sampleMinutes"]', DEFAULTS.sampleMinutes, 0.1),
    playbackSpeed,
    spiroPlaybackSpeed,
    spiroPerspective,
    spiroSpecialEnabled,
    spiroSpecialId,
    jumpSetting: Math.min(12, Math.max(1, Math.round(getNumber('input[name="jumpSetting"]', DEFAULTS.jumpSetting, 1)))),
    trailPersistence: Math.max(1, Math.round(getNumber('input[name="trailPersistence"]', DEFAULTS.trailPersistence, 1))),
    cycleLimit: Math.max(0, Math.round(getNumber('input[name="cycleLimit"]', DEFAULTS.cycleLimit, 0))),
    activeFadeRate: Math.max(0, getNumber('input[name="activeFadeRate"]', DEFAULTS.activeFadeRate)),
    azimuthCheckpointInterval: Math.min(30, Math.max(2, Math.round(getNumber('input[name="azimuthCheckpointInterval"]', DEFAULTS.azimuthCheckpointInterval, 2)))),
    startTime: Number.isNaN(startTime.getTime()) ? new Date() : startTime,
  };
}

function toDatetimeLocal(date: Date) {
  const pad = (value: number) => `${value}`.padStart(2, '0');
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}
