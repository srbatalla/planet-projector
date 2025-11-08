import { Body, Observer } from 'astronomy-engine';
import { HorizonView } from './views/horizon/horizonView';

type ControlState = {
  planet: Body;
  latitude: number;
  longitude: number;
  elevation: number;
  sampleMinutes: number;
  playbackSpeed: number;
  startTime: Date;
  horizonCutoff: number;
  autoHorizon: boolean;
  trailFade: number;
  jumpSetting: number;
  trailPersistence: number;
  cycleLimit: number;
};

const PLANET_OPTIONS: { label: string; value: Body }[] = [
  { label: 'Mercury', value: Body.Mercury },
  { label: 'Venus', value: Body.Venus },
  { label: 'Mars', value: Body.Mars },
  { label: 'Jupiter', value: Body.Jupiter },
  { label: 'Saturn', value: Body.Saturn },
  { label: 'Uranus', value: Body.Uranus },
  { label: 'Neptune', value: Body.Neptune },
];

const DEFAULTS: ControlState = {
  planet: Body.Mars,
  latitude: 37.7749,
  longitude: -122.4194,
  elevation: 0,
  sampleMinutes: 5,
  playbackSpeed: 12000,
  startTime: new Date(),
  horizonCutoff: 0,
  autoHorizon: true,
  trailFade: 0.2,
  jumpSetting: 1,
  trailPersistence: 20,
  cycleLimit: 8,
};

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

  const layout = document.createElement('div');
  layout.className = 'layout';
  panel.appendChild(layout);

  const controls = createControls();
  layout.appendChild(controls);
  updateJumpLabel(controls);

  const canvasHost = document.createElement('div');
  canvasHost.className = 'canvas-host';
  layout.appendChild(canvasHost);

  let view: HorizonView | null = null;

  const refreshView = () => {
    const state = readControlState(controls);
    const observer = new Observer(state.latitude, state.longitude, state.elevation);
    canvasHost.innerHTML = '';
    view?.stop();
    view = new HorizonView(canvasHost, {
      body: state.planet,
      observer,
      sampleMinutes: state.sampleMinutes,
      startTime: state.startTime,
      playbackSpeed: state.playbackSpeed,
      horizonCutoff: state.horizonCutoff,
      autoHorizon: state.autoHorizon,
      trailFade: state.trailFade,
      jumpSetting: state.jumpSetting,
      trailPersistence: state.trailPersistence,
      cycleLimit: state.cycleLimit,
    });
    view.start();
  };

  let refreshHandle: number | null = null;
  const scheduleRefresh = () => {
    updateJumpLabel(controls);
    if (refreshHandle !== null) {
      cancelAnimationFrame(refreshHandle);
    }
    refreshHandle = requestAnimationFrame(() => {
      refreshHandle = null;
      refreshView();
    });
  };

  controls.addEventListener('input', scheduleRefresh);
  controls.addEventListener('change', scheduleRefresh);
  controls.addEventListener('submit', (event) => {
    event.preventDefault();
    scheduleRefresh();
  });

  refreshView();
}

function createControls() {
  const form = document.createElement('form');
  form.className = 'controls';

  const planetSelect = PLANET_OPTIONS.map(
    (option) =>
      `<option value="${option.value}" ${option.value === DEFAULTS.planet ? 'selected' : ''}>${option.label}</option>`,
  ).join('');

  form.innerHTML = `
    <label>
      <span>Planet</span>
      <select name="planet">
        ${planetSelect}
      </select>
    </label>
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
    <label>
      <span>Playback speed (×)</span>
      <input type="number" name="playbackSpeed" min="1" step="1" value="${DEFAULTS.playbackSpeed}" />
    </label>
    <label>
      <span>Horizon cutoff (°)</span>
      <input type="number" name="horizonCutoff" step="0.5" value="${DEFAULTS.horizonCutoff}" />
    </label>
    <label class="checkbox">
      <input type="checkbox" name="autoHorizon" ${DEFAULTS.autoHorizon ? 'checked' : ''} />
      <span>Auto horizon cutoff</span>
    </label>
    <label>
      <span>Trail fade rate</span>
      <input type="number" name="trailFade" min="0" max="1" step="0.01" value="${DEFAULTS.trailFade}" />
    </label>
    <label class="slider">
      <span>Jump interval</span>
      <input type="range" name="jumpSetting" min="1" max="10" value="${DEFAULTS.jumpSetting}" />
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

  const planet = root.querySelector<HTMLSelectElement>('select[name="planet"]')?.value as Body;
  const startValue = root.querySelector<HTMLInputElement>('input[name="startTime"]')?.value;
  const startTime = startValue ? new Date(startValue) : new Date();

  return {
    planet: planet ?? DEFAULTS.planet,
    latitude: getNumber('input[name="latitude"]', DEFAULTS.latitude),
    longitude: getNumber('input[name="longitude"]', DEFAULTS.longitude),
    elevation: getNumber('input[name="elevation"]', DEFAULTS.elevation),
    sampleMinutes: getNumber('input[name="sampleMinutes"]', DEFAULTS.sampleMinutes, 0.1),
    playbackSpeed: getNumber('input[name="playbackSpeed"]', DEFAULTS.playbackSpeed, 1),
    autoHorizon: !!root.querySelector<HTMLInputElement>('input[name="autoHorizon"]')?.checked,
    horizonCutoff: getNumber('input[name="horizonCutoff"]', DEFAULTS.horizonCutoff),
    trailFade: Math.min(1, Math.max(0, getNumber('input[name="trailFade"]', DEFAULTS.trailFade))),
    jumpSetting: Math.min(10, Math.max(1, Math.round(getNumber('input[name="jumpSetting"]', DEFAULTS.jumpSetting, 1)))),
    trailPersistence: Math.max(1, Math.round(getNumber('input[name="trailPersistence"]', DEFAULTS.trailPersistence, 1))),
    cycleLimit: Math.max(0, Math.round(getNumber('input[name="cycleLimit"]', DEFAULTS.cycleLimit, 0))),
    startTime: Number.isNaN(startTime.getTime()) ? new Date() : startTime,
  };
}

function formatJumpLabel(setting: number) {
  if (setting <= 4) {
    return `${setting} wk${setting === 1 ? '' : 's'}`;
  }
  const monthSteps = setting - 4;
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

function toDatetimeLocal(date: Date) {
  const pad = (value: number) => `${value}`.padStart(2, '0');
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}
