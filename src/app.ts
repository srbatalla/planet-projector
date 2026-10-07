import { Body, Observer } from 'astronomy-engine';
import { SPECIAL_OBJECTS, type SpecialObject } from './core/specialObjects';
import { bodyTarget, specialTarget, type SkyTarget } from './views/targets';
import { MultiPlanetView } from './views/horizon/multiPlanetView';
import { getPlanetColor } from './views/horizon/planetColors';
import { SpirographView } from './views/spirograph/spirographView';
import type { ViewStatus } from './views/viewStatus';
import {
  applyPreset,
  BODY_OPTIONS,
  canonicalBodies,
  DEFAULTS,
  effectiveBodies,
  encodeSettings,
  formatJump,
  formatSpeed,
  horizonSpeed,
  HORIZON_SPEED_STEPS,
  LOCATIONS,
  minSpeedIndex,
  PRESETS,
  resolveStartTime,
  spiroSpeed,
  SPIRO_SPEED_STEPS,
  toDatetimeLocal,
  type Settings,
  type ViewMode,
} from './settings';
import { createDocs } from './ui/docs';
import { ClipRecorder } from './ui/recorder';
import {
  libraryAvailable,
  loadLibrary,
  makeThumbnail,
  newEntryId,
  storeLibrary,
  type LibraryEntry,
} from './ui/library';
import { COMPACT_PREFIX, encodeCompact, parseHash } from './shareCodec';
import {
  el,
  numberControl,
  rangeControl,
  rowControl,
  sectionControl,
  segmentedControl,
  selectControl,
  toggleControl,
  type Control,
  type UpdateFn,
} from './ui/controls';

type ActiveView = MultiPlanetView | SpirographView;

const ICONS = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor"/></svg>',
  restart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12a7 7 0 1 0 2.05-4.95M5 4.5v3.6h3.6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  sliders: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="16" cy="7" r="2.2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="10" cy="17" r="2.2" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  minus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  camera: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8.5h3l1.6-2.5h6.8L17 8.5h3V19H4z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="12" cy="13.2" r="3.3" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
  link: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  record: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="4" fill="#ff4d4d"/></svg>',
  stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5" fill="#ff4d4d"/></svg>',
  book: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6.5C10.3 5.3 7.9 4.8 4.5 5v12.5c3.4-.2 5.8.3 7.5 1.5 1.7-1.2 4.1-1.7 7.5-1.5V5c-3.4-.2-5.8.3-7.5 1.5zM12 6.5V19" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  locate: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="6" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
};

/** Settings applied to the running view without restarting it. */
const LIVE_KEYS: Record<ViewMode, Set<keyof Settings>> = {
  horizon: new Set([
    'horizonSpeed', 'jump', 'bodies', 'specials', 'projection', 'stars', 'milkyWay', 'clouds', 'cloudCover', 'skyTint', 'lineWidth',
    'trailStyle', 'labels', 'settledBrightness', 'sceneHeading', 'sceneTilt', 'sceneFov', 'landscape',
  ]),
  spirograph: new Set([
    'spiroSpeed', 'bodies', 'specials', 'labels', 'colorMode', 'spiroGlow', 'spiroLineWidth', 'symmetry', 'mirror',
    'connect', 'connectDays', 'fadeYears', 'zoom', 'auLabels',
  ]),
};
/** Settings that only matter to one view: changing them while in the other view does nothing. */
const VIEW_KEYS: Record<ViewMode, Set<keyof Settings>> = {
  horizon: new Set([
    'latitude', 'longitude', 'elevation', 'horizonSpeed', 'sampleMinutes', 'jump', 'trailPersistence',
    'cycleLimit', 'activeFadeRate', 'settledBrightness', 'checkpoint', 'projection', 'stars', 'milkyWay', 'clouds', 'cloudCover', 'skyTint',
    'lineWidth', 'trailStyle', 'sceneHeading', 'sceneTilt', 'sceneFov', 'landscape',
  ]),
  spirograph: new Set([
    'spiroSpeed', 'spiroStepHours', 'perspective', 'colorMode', 'spiroGlow', 'spiroLineWidth',
    'symmetry', 'mirror', 'connect', 'connectDays', 'fadeYears', 'zoom', 'auLabels',
  ]),
};
const UI_KEYS = new Set<keyof Settings>(['showStats']);

const isSheetLayout = () => window.matchMedia('(max-width: 720px)').matches;

/**
 * The three visually distinct modes in the bar. Dome and Horizon are the same sky view with
 * different projections, so links, presets and saved runs keep using view + projection.
 */
type DisplayModeId = 'dome' | 'horizon' | 'scene' | 'spiro';
const DISPLAY_MODES: { id: DisplayModeId; label: string; patch: Partial<Settings> }[] = [
  { id: 'dome', label: 'Dome', patch: { view: 'horizon', projection: 'dome' } },
  { id: 'scene', label: 'Scene', patch: { view: 'horizon', projection: 'perspective' } },
  { id: 'horizon', label: 'Horizon', patch: { view: 'horizon', projection: 'panorama' } },
  { id: 'spiro', label: 'Spiro', patch: { view: 'spirograph' } },
];

/** The mode a preset opens in, for its button: the same names as the bar. */
const LAST_PRESET_KEY = 'planetary-patterns:last-preset';

function readLastPreset(): string | null {
  try {
    return localStorage.getItem(LAST_PRESET_KEY);
  } catch {
    return null;
  }
}

function storeLastPreset(id: string) {
  try {
    localStorage.setItem(LAST_PRESET_KEY, id);
  } catch {
    // Storage blocked (private mode): the highlight just lasts for this visit.
  }
}

function presetModeLabel(patch: Partial<Settings>) {
  if (patch.view === 'spirograph') {
    return 'Spiro';
  }
  const projection = patch.projection ?? 'panorama';
  return projection === 'dome' ? 'Dome' : projection === 'perspective' ? 'Scene' : 'Horizon';
}

function displayMode(settings: Settings): DisplayModeId {
  if (settings.view === 'spirograph') {
    return 'spiro';
  }
  return settings.projection === 'dome' ? 'dome' : settings.projection === 'perspective' ? 'scene' : 'horizon';
}

export function initializeApp() {
  const target = document.querySelector<HTMLDivElement>('#app');
  if (!target) {
    throw new Error('Root container #app missing.');
  }

  let settings: Settings = { ...DEFAULTS, ...parseHash(location.hash) };
  let view: ActiveView | null = null;
  let paused = false;
  let rebuildHandle: number | null = null;
  let hashHandle: number | null = null;
  let toastHandle: number | null = null;
  /** Start instant of the running view: saved runs freeze 'now'/'night' to it. */
  let viewStartTime = new Date();

  // ------------------------------------------------------------- layout

  target.innerHTML = '';
  target.className = 'app';
  target.dataset.panel = window.matchMedia('(min-width: 900px)').matches ? 'open' : 'closed';

  const stage = el('main', 'stage');
  const canvasHost = el('div', 'canvas-host');
  const hud = el('div', 'hud');
  const hudTitle = el('div', 'hud-title', 'Planetary Patterns');
  const hudTime = el('div', 'hud-time');
  const hudMeta = el('div', 'hud-meta');
  const hudBodies = el('div', 'hud-bodies');
  hud.append(hudTitle, hudTime, hudMeta, hudBodies);
  const stats = el('div', 'hud-stats');
  const emptyHint = el('div', 'empty-hint');
  const speedFlash = el('div', 'speed-flash');
  speedFlash.setAttribute('role', 'status');
  let speedFlashHandle: number | null = null;
  const toast = el('div', 'toast');
  toast.setAttribute('role', 'status');
  stage.append(canvasHost, hud, stats, emptyHint, speedFlash, toast);

  const panel = el('aside', 'panel');
  panel.setAttribute('aria-label', 'Controls');
  const dock = el('header', 'dock');
  const panelBody = el('div', 'panel-body');
  panel.append(dock, panelBody);
  target.append(stage, panel);

  // ------------------------------------------------------------- dock

  const viewSwitch = el('div', 'segmented view-switch');
  viewSwitch.setAttribute('role', 'tablist');
  const viewButtons = DISPLAY_MODES.map((mode) => {
    const button = el('button', '', mode.label);
    button.type = 'button';
    button.setAttribute('role', 'tab');
    button.addEventListener('click', () => update(mode.patch));
    viewSwitch.append(button);
    return { mode, button };
  });

  const iconButton = (icon: string, label: string, onClick: () => void) => {
    const button = el('button', 'icon-button');
    button.type = 'button';
    button.innerHTML = icon;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.addEventListener('click', onClick);
    return button;
  };
  const playButton = iconButton(ICONS.pause, 'Pause (space)', () => setPaused(!paused));
  const restartButton = iconButton(ICONS.restart, 'Restart (R)', () => rebuildView());
  const panelButton = iconButton(ICONS.sliders, 'Settings', () => togglePanel());
  const actions = el('div', 'dock-actions');
  actions.append(playButton, restartButton, panelButton);
  // Speed is the most-changed setting: one-tap −/+ in the bar; the new value flashes above it.
  const speedGroup = el('div', 'dock-speed');
  const speedDown = iconButton(ICONS.minus, 'Slower (−)', () => stepSpeed(-1));
  const speedUp = iconButton(ICONS.plus, 'Faster (+)', () => stepSpeed(+1));
  speedGroup.append(speedDown, speedUp);
  const dockGrabber = el('button', 'dock-grabber');
  dockGrabber.type = 'button';
  dockGrabber.setAttribute('aria-label', 'Open settings');
  dockGrabber.addEventListener('click', () => setPanel(true));
  dock.append(dockGrabber, viewSwitch, speedGroup, actions);

  // ------------------------------------------------------------- panel body

  const update: UpdateFn = (patch) => applyUpdate(patch);

  const toolRow = el('div', 'tool-row');
  const snapshotButton = el('button', 'tool-button');
  snapshotButton.type = 'button';
  snapshotButton.innerHTML = `${ICONS.camera}<span>Snapshot</span>`;
  snapshotButton.title = 'Save a PNG of the canvas (S)';
  snapshotButton.addEventListener('click', () => void saveSnapshot());
  const recordButton = el('button', 'tool-button');
  recordButton.type = 'button';
  recordButton.innerHTML = `${ICONS.record}<span>Record</span>`;
  recordButton.title = 'Record a 10 second video of the canvas';
  const recorder = new ClipRecorder(
    ({ recording, remainingSeconds }) => {
      recordButton.innerHTML = recording
        ? `${ICONS.stop}<span>Stop ${remainingSeconds}s</span>`
        : `${ICONS.record}<span>Record</span>`;
      recordButton.classList.toggle('recording', recording);
      target.dataset.recording = recording ? 'on' : 'off';
      if (!recording) {
        stopRecordingFrames();
      }
    },
    (clip, extension, iosPlayable) => {
      const note = iosPlayable ? 'Clip saved (MP4)' : `Clip saved (${extension.toUpperCase()}; this browser can't record iPhone-playable MP4)`;
      void deliverFile(clip, `planetary-patterns-${settings.view}-${Date.now()}.${extension}`, note);
    }
  );
  recordButton.hidden = !ClipRecorder.isSupported();
  recordButton.addEventListener('click', () => {
    if (recorder.recording) {
      recorder.stop();
    } else if (view) {
      if (paused) {
        setPaused(false);
      }
      recorder.start(startRecordingFrames(), 10);
    }
  });

  // Clips use the snapshot framing: phones record a full-screen portrait re-render (unaffected
  // by the settings sheet), other layouts the live canvas; both carry the snapshot caption.
  let recordingLoop: number | null = null;

  function startRecordingFrames(): HTMLCanvasElement {
    const source = view!.canvas;
    const phone = isSheetLayout();
    const width = phone ? window.innerWidth : source.clientWidth;
    const height = phone ? window.innerHeight : source.clientHeight;
    const pixelRatio = source.width / Math.max(1, source.clientWidth);
    // H.264 needs even frame dimensions.
    const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
    const frame = document.createElement('canvas');
    frame.width = even(width * pixelRatio);
    frame.height = even(height * pixelRatio);
    const ctx = frame.getContext('2d');
    const compose = () => {
      recordingLoop = requestAnimationFrame(compose);
      if (!view || !ctx) {
        return;
      }
      if (phone) {
        view.renderSnapshot(width, height, frame);
      } else {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(view.canvas, 0, 0, frame.width, frame.height);
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      drawSnapshotCaption(ctx, frame.width, frame.height, frame.width / width, view.getStatus());
    };
    stopRecordingFrames();
    compose();
    return frame;
  }

  function stopRecordingFrames() {
    if (recordingLoop !== null) {
      cancelAnimationFrame(recordingLoop);
      recordingLoop = null;
    }
  }
  const shareButton = el('button', 'tool-button');
  shareButton.type = 'button';
  shareButton.innerHTML = `${ICONS.link}<span>Link</span>`;
  shareButton.title = 'Copy a link that reproduces this view';
  shareButton.addEventListener('click', () => void shareLink());
  toolRow.append(snapshotButton, recordButton, shareButton);

  const presetStrip = el('div', 'preset-strip');
  // The last preset picked keeps a highlight (on this device) even after its settings are tweaked.
  // A first visit opens on the default run, which is the Sydney preset.
  let lastPresetId = readLastPreset() ?? (location.hash.length <= 1 ? 'sydney' : null);
  const presetButtons = PRESETS.map((preset) => {
    const button = el('button', 'preset');
    button.type = 'button';
    button.title = preset.hint;
    button.append(el('span', 'preset-label', preset.label));
    button.append(el('span', 'preset-kind', presetModeLabel(preset.settings)));
    button.addEventListener('click', () => {
      paused = false;
      lastPresetId = preset.id;
      storeLastPreset(preset.id);
      settings = applyPreset(settings, preset);
      syncAll();
      persistHash();
      rebuildView();
      showToast(preset.hint);
      if (isSheetLayout()) {
        setPanel(false);
      }
    });
    presetStrip.append(button);
    return button;
  });
  const presetSection: Control = {
    root: (() => {
      const wrap = el('section', 'section section-flat');
      wrap.append(el('h2', 'section-title', 'Presets'), presetStrip);
      return wrap;
    })(),
    sync() {},
  };

  const bodyControl = createBodyPicker(update);

  const horizonSpeedControl = rangeControl(
    'horizonSpeed',
    'Speed',
    { min: minSpeedIndex(HORIZON_SPEED_STEPS), max: HORIZON_SPEED_STEPS.length, format: (_, s) => formatSpeed(horizonSpeed(s)) },
    update,
    ['horizon']
  );
  const spiroSpeedControl = rangeControl(
    'spiroSpeed',
    'Speed',
    { min: minSpeedIndex(SPIRO_SPEED_STEPS), max: SPIRO_SPEED_STEPS.length, format: (_, s) => formatSpeed(spiroSpeed(s)) },
    update,
    ['spirograph']
  );

  const sections: Control[] = [
    presetSection,
    createLibrarySection(),
    bodyControl,
    sceneSection(update),
    sectionControl(
      'Sky',
      [
        segmentedControl('stars', 'Stars', [
          { value: 'off', label: 'Off' },
          { value: 'points', label: 'Points' },
          { value: 'trails', label: 'Trails' },
        ], update),
        toggleControl('milkyWay', 'Milky Way', update, undefined, 'The galactic band, turning with the sky'),
        segmentedControl('clouds', 'Clouds', [
          { value: 'off', label: 'Off' },
          { value: 'drift', label: 'Drift' },
          { value: 'exposure', label: 'Long exp.' },
        ], update),
        rangeControl('cloudCover', 'Cloud cover', {
          min: 0.05,
          max: 1,
          step: 0.05,
          format: (v) => `${Math.round(v * 100)}%`,
        }, update),
        toggleControl('skyTint', 'Daylight sky', update, undefined, 'Tint the sky by the Sun’s altitude'),
        segmentedControl('trailStyle', 'Trail style', [
          { value: 'line', label: 'Line' },
          { value: 'glow', label: 'Glow' },
        ], update),
        rangeControl('lineWidth', 'Line width', { min: 0.5, max: 5, step: 0.5, format: (v) => `${v}px` }, update),
      ],
      ['horizon']
    ),
    sectionControl(
      'Style',
      [
        segmentedControl('colorMode', 'Colour', [
          { value: 'planet', label: 'Planet' },
          { value: 'spectrum', label: 'Spectrum' },
          { value: 'mono', label: 'Mono' },
        ], update),
        toggleControl('spiroGlow', 'Glow', update, undefined, 'Additive light: crossings burn bright'),
        rangeControl('spiroLineWidth', 'Line width', { min: 0.5, max: 4, step: 0.25, format: (v) => `${v}px` }, update),
        rangeControl('symmetry', 'Symmetry', { min: 1, max: 12, format: (v) => (v === 1 ? 'Off' : `${v}-fold`) }, update),
        toggleControl('mirror', 'Mirror', update, undefined, 'Reflect each copy for a kaleidoscope'),
        toggleControl('connect', 'Connect bodies', update, undefined, 'Chords between bodies: the planetary dance'),
        rangeControl('connectDays', 'Chord interval', { min: 1, max: 90, format: (v) => `${v} day${v === 1 ? '' : 's'}` }, update),
        rangeControl('fadeYears', 'Trail fade', {
          min: 0, max: 100, format: (v) => (v === 0 ? 'Never' : `half-life ${v} yr`),
        }, update),
        rangeControl('zoom', 'Zoom', { min: 0.25, max: 12, step: 0.05, format: (v) => `${v.toFixed(2)}×` }, update),
      ],
      ['spirograph']
    ),
    sectionControl(
      'Frame',
      [
        selectControl(
          'perspective',
          'Seen from',
          BODY_OPTIONS.filter((option) => option.value !== Body.Moon).map((option) => ({
            value: option.value,
            label: option.label,
          })),
          update
        ),
      ],
      ['spirograph']
    ),
    createLocationSection(update),
    sectionControl('Time', [
      createStartControl(update),
      horizonSpeedControl,
      spiroSpeedControl,
      rangeControl('jump', 'Skip ahead between arcs', { min: 1, max: 12, format: (v) => formatJump(v) }, update, ['horizon']),
      numberControl('sampleMinutes', 'Sample step', { min: 0.5, max: 120, step: 0.5, suffix: 'min' }, update, ['horizon']),
      numberControl('spiroStepHours', 'Sample step', { min: 1, max: 720, step: 1, suffix: 'h' }, update, ['spirograph']),
    ]),
    sectionControl(
      'Trails',
      [
        rowControl([
          numberControl('trailPersistence', 'Lifespan', { min: 1, max: 200, integer: true, suffix: 'cycles' }, update),
          numberControl('cycleLimit', 'Stop after', { min: 0, max: 1000, integer: true, suffix: 'cycles' }, update),
        ]),
        numberControl('activeFadeRate', 'Active sweep fade', { min: 0, max: 0.01, step: 0.0001, suffix: '/s' }, update),
        rangeControl('settledBrightness', 'Settled brightness', {
          min: 0,
          max: 1,
          step: 0.05,
          format: (v) => (v >= 1 ? 'No glow' : v <= 0 ? 'Glow only' : `${Math.round(v * 100)}%`),
        }, update),
        rangeControl('checkpoint', 'Azimuth checkpoint', { min: 2, max: 30, format: (v) => `${v}°` }, update),
      ],
      ['horizon'],
      false
    ),
    sectionControl(
      'Display',
      [
        toggleControl('labels', 'Body labels', update, undefined, 'Name tags beside each moving body'),
        toggleControl('auLabels', 'AU labels', update, ['spirograph'], 'Distances on the reference rings'),
        toggleControl('showStats', 'Frame stats', update, undefined, 'Frame rate and main-thread time per frame'),
      ],
      undefined,
      false
    ),
  ];

  const grabber = el('div', 'sheet-grabber');
  grabber.setAttribute('aria-hidden', 'true');
  panelBody.append(grabber, toolRow);
  sections.forEach((section) => panelBody.append(section.root));
  const footer = el('p', 'panel-footer');
  footer.innerHTML =
    'Space pause · +/− speed · R restart · 1–4 Dome/Scene/Horizon/Spiro · S save · H hide panel · ? guide<br>Spiro: scroll or pinch to zoom, double-click to reset';
  panelBody.append(footer);

  // The guide sits at the bottom of the settings; the sky pauses underneath while it is open.
  let resumeAfterDocs = false;
  const docs = createDocs((open) => {
    if (open) {
      resumeAfterDocs = !paused;
      setPaused(true);
    } else if (resumeAfterDocs) {
      setPaused(false);
    }
  });
  target.append(docs.root);
  const docsEntry = el('div', 'docs-entry');
  const docsButton = el('button', 'tool-button docs-button');
  docsButton.type = 'button';
  docsButton.innerHTML = `${ICONS.book}<span>Guide &amp; docs</span>`;
  docsButton.title = 'Tips, smoother animation, installing as an app (?)';
  docsButton.addEventListener('click', () => docs.open());
  docsEntry.append(docsButton, el('p', 'docs-entry-version', `v${__APP_VERSION__} · build ${__BUILD_ID__}`));
  panelBody.append(docsEntry);

  // ------------------------------------------------------------- library

  function createLibrarySection(): Control {
    const root = el('details', 'section');
    root.open = true;
    const summary = el('summary', '', 'Library');
    const body = el('div', 'section-body');
    root.append(summary, body);

    const saveButton = el('button', 'tool-button library-save');
    saveButton.type = 'button';
    saveButton.textContent = 'Save this run';
    saveButton.title = 'Keep these settings (and a thumbnail) on this device';
    const list = el('div', 'library-list');
    const note = el('p', 'library-note');
    body.append(saveButton, list, note);

    let entries = loadLibrary();
    const available = libraryAvailable();
    saveButton.disabled = !available;

    const persist = () => {
      if (!storeLibrary(entries)) {
        showToast('Could not save: device storage is full or blocked');
        entries = loadLibrary();
        render();
        return false;
      }
      return true;
    };

    const load = (entry: LibraryEntry) => {
      paused = false;
      settings = { ...DEFAULTS, showStats: settings.showStats, ...parseHash(`#${COMPACT_PREFIX}${entry.code}`) };
      syncAll();
      persistHash();
      rebuildView();
      showToast(`Loaded “${entry.name}”`);
      if (isSheetLayout()) {
        setPanel(false);
      }
    };

    const render = () => {
      list.replaceChildren(
        ...entries.map((entry, index) => {
          const item = el('div', 'library-item');
          const thumb = el('button', 'library-thumb');
          thumb.type = 'button';
          thumb.title = 'Load this run';
          if (entry.thumbnail) {
            const img = el('img');
            img.src = entry.thumbnail;
            img.alt = '';
            thumb.append(img);
          }
          thumb.addEventListener('click', () => load(entry));

          const text = el('div', 'library-text');
          const name = el('input', 'library-name');
          name.type = 'text';
          name.value = entry.name;
          name.setAttribute('aria-label', 'Run name');
          name.addEventListener('change', () => {
            entry.name = name.value.trim() || entry.name;
            name.value = entry.name;
            persist();
          });
          const date = el('span', 'library-date', new Date(entry.savedAt).toLocaleString(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short',
          }));
          text.append(name, date);

          const actions = el('div', 'library-actions');
          const loadButton = el('button', 'mini-button', 'Load');
          loadButton.type = 'button';
          loadButton.addEventListener('click', () => load(entry));
          const remove = el('button', 'mini-button icon-only');
          remove.type = 'button';
          remove.innerHTML = ICONS.close;
          remove.title = 'Delete';
          remove.setAttribute('aria-label', `Delete ${entry.name}`);
          remove.addEventListener('click', () => {
            const removed = entries.splice(index, 1)[0];
            if (persist()) {
              render();
              showToast(`Deleted “${removed.name}”`, {
                label: 'Undo',
                run: () => {
                  entries.splice(Math.min(index, entries.length), 0, removed);
                  persist();
                  render();
                },
              });
            }
          });
          actions.append(loadButton, remove);
          item.append(thumb, text, actions);
          return item;
        })
      );
      note.textContent = !available
        ? 'Saving is unavailable here (private browsing or blocked site data).'
        : entries.length === 0
          ? 'Saved runs stay on this device, with a thumbnail of the moment you saved.'
          : '';
      note.hidden = note.textContent === '';
    };

    saveButton.addEventListener('click', () => {
      if (!view) {
        return;
      }
      // A run that started "now" or at nightfall is pinned to the instant it actually began.
      const frozen: Settings = { ...settings };
      if (frozen.start === '' || frozen.start === 'night') {
        frozen.start = `${formatUtc(viewStartTime).replace(' ', 'T')}Z`;
      }
      const entry: LibraryEntry = {
        id: newEntryId(),
        name: defaultRunName(frozen),
        code: encodeCompact(frozen),
        thumbnail: makeThumbnail(view.canvas),
        savedAt: Date.now(),
      };
      entries = [entry, ...entries];
      if (persist()) {
        render();
        showToast(`Saved “${entry.name}”`);
      }
    });

    render();
    return { root, sync() {} };
  }

  function defaultRunName(run: Settings) {
    const preset = PRESETS.find((_, index) => isPresetActive(index));
    if (preset) {
      return preset.label;
    }
    const names = [
      ...effectiveBodies(run).map((body) => body as string),
      ...SPECIAL_OBJECTS.filter((special) => run.specials.includes(special.id)).map((special) => special.shortName),
    ];
    const shown = names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', ') || 'Empty sky';
    if (run.view === 'horizon') {
      return `${shown} · ${formatObserver(run.latitude, run.longitude)}`;
    }
    return `${shown} from ${run.perspective}`;
  }

  function syncAll() {
    const isHorizon = settings.view === 'horizon';
    const speedIndex = isHorizon ? settings.horizonSpeed : settings.spiroSpeed;
    const speedSteps = isHorizon ? HORIZON_SPEED_STEPS : SPIRO_SPEED_STEPS;
    speedDown.disabled = speedIndex <= minSpeedIndex(speedSteps);
    speedUp.disabled = speedIndex >= speedSteps.length;
    target!.dataset.view = settings.view;
    target!.dataset.stats = settings.showStats ? 'on' : 'off';
    const current = displayMode(settings);
    for (const { mode, button } of viewButtons) {
      button.setAttribute('aria-selected', String(current === mode.id));
    }
    for (const section of sections) {
      section.root.hidden = !!section.views && !section.views.includes(settings.view);
      section.sync(settings);
    }
    presetButtons.forEach((button, index) => {
      button.classList.toggle('preset-active', isPresetActive(index));
      button.classList.toggle('preset-selected', PRESETS[index].id === lastPresetId);
    });
  }

  function isPresetActive(index: number) {
    const preset = PRESETS[index];
    return (Object.keys(preset.settings) as (keyof Settings)[]).every((key) => {
      const a = preset.settings[key];
      const b = settings[key];
      return Array.isArray(a) && Array.isArray(b) ? [...a].sort().join() === [...b].sort().join() : a === b;
    });
  }

  // ------------------------------------------------------------- state changes

  function applyUpdate(patch: Partial<Settings>) {
    const previous = settings;
    settings = { ...settings, ...patch };
    persistHash();
    syncAll();

    if (patch.view !== undefined && patch.view !== previous.view) {
      rebuildView();
      return;
    }

    const mode = settings.view;
    let needsRebuild = false;
    let liveChange = false;
    for (const key of Object.keys(patch) as (keyof Settings)[]) {
      const before = previous[key];
      const after = settings[key];
      const changed = Array.isArray(before) && Array.isArray(after)
        ? before.join() !== after.join()
        : before !== after;
      if (!changed || UI_KEYS.has(key)) {
        continue;
      }
      const otherMode: ViewMode = mode === 'horizon' ? 'spirograph' : 'horizon';
      if (VIEW_KEYS[otherMode].has(key) && !VIEW_KEYS[mode].has(key)) {
        continue;
      }
      if (LIVE_KEYS[mode].has(key)) {
        liveChange = true;
      } else {
        needsRebuild = true;
      }
    }

    if (needsRebuild || !view) {
      scheduleRebuild();
    } else if (liveChange) {
      applyLive(previous);
    }
  }

  function applyLive(previous: Settings) {
    if (!view) {
      return;
    }
    const bodies = effectiveBodies(settings);
    if (
      bodies.join() !== effectiveBodies(previous).join() ||
      settings.specials.join() !== previous.specials.join()
    ) {
      if (view instanceof MultiPlanetView) {
        view.updateTargets(skyTargets(settings));
      } else {
        view.updateTargets(bodies, selectedSpecials(settings));
      }
    }
    if (view instanceof MultiPlanetView) {
      view.updatePlaybackSpeed(horizonSpeed(settings));
      view.updateJumpSetting(settings.jump);
      view.updateVisuals(horizonVisuals(settings));
    } else {
      view.updatePlaybackSpeed(spiroSpeed(settings));
      view.updateVisuals(spiroVisuals(settings));
    }
    updateEmptyHint();
  }

  function scheduleRebuild() {
    if (rebuildHandle !== null) {
      window.clearTimeout(rebuildHandle);
    }
    rebuildHandle = window.setTimeout(() => {
      rebuildHandle = null;
      rebuildView();
    }, 250);
  }

  function rebuildView() {
    if (rebuildHandle !== null) {
      window.clearTimeout(rebuildHandle);
      rebuildHandle = null;
    }
    recorder.stop();
    view?.stop();
    canvasHost.innerHTML = '';
    paused = false;

    const startTime = resolveStartTime(settings);
    viewStartTime = startTime;
    const bodies = effectiveBodies(settings);
    if (settings.view === 'horizon') {
      view = new MultiPlanetView(canvasHost, {
        targets: skyTargets(settings),
        observer: new Observer(settings.latitude, settings.longitude, settings.elevation),
        sampleMinutes: Math.max(0.25, settings.sampleMinutes),
        startTime,
        playbackSpeed: horizonSpeed(settings),
        jumpSetting: settings.jump,
        trailPersistence: settings.trailPersistence,
        cycleLimit: settings.cycleLimit,
        activeFadeRate: settings.activeFadeRate,
        azimuthCheckpointInterval: settings.checkpoint,
        visuals: horizonVisuals(settings),
        onHistoryEvent: (note) => showToast(note, undefined, 7000),
        onSceneCameraChange: (camera) => {
          settings = { ...settings, sceneHeading: camera.heading, sceneTilt: camera.tilt, sceneFov: camera.fov };
          syncAll();
          persistHash();
        },
      });
    } else {
      view = new SpirographView(canvasHost, {
        bodies,
        startTime,
        stepMinutes: Math.max(1, settings.spiroStepHours) * 60,
        playbackSpeed: spiroSpeed(settings),
        perspectiveBody: settings.perspective,
        specials: selectedSpecials(settings),
        visuals: spiroVisuals(settings),
        onZoomChange: (zoom) => {
          settings = { ...settings, zoom: Math.round(zoom * 100) / 100 };
          syncAll();
          persistHash();
        },
      });
    }
    view.start();
    syncPlayButton();
    updateEmptyHint();
    updateHud();
  }

  function updateEmptyHint() {
    const empty = effectiveBodies(settings).length === 0 && settings.specials.length === 0;
    emptyHint.textContent = empty ? 'Choose a body in settings to start tracing' : '';
    emptyHint.hidden = !empty;
  }

  function setPaused(next: boolean) {
    paused = next;
    view?.setPaused(paused);
    syncPlayButton();
  }

  function syncPlayButton() {
    playButton.innerHTML = paused ? ICONS.play : ICONS.pause;
    const label = paused ? 'Play (space)' : 'Pause (space)';
    playButton.title = label;
    playButton.setAttribute('aria-label', label);
  }

  function setPanel(open: boolean) {
    target!.dataset.panel = open ? 'open' : 'closed';
    panelButton.innerHTML = open ? ICONS.close : ICONS.sliders;
    panelButton.setAttribute('aria-expanded', String(open));
    if (open) {
      requestAnimationFrame(revealSelectedPreset);
    }
  }

  /** On phones the presets scroll sideways: bring the highlighted one into view. */
  function revealSelectedPreset() {
    const selected = presetStrip.querySelector<HTMLElement>('.preset-selected');
    if (!selected || presetStrip.scrollWidth <= presetStrip.clientWidth) {
      return;
    }
    const strip = presetStrip.getBoundingClientRect();
    const box = selected.getBoundingClientRect();
    presetStrip.scrollLeft += box.left - strip.left - (strip.width - box.width) / 2;
  }

  function togglePanel() {
    setPanel(target!.dataset.panel !== 'open');
  }

  function persistHash() {
    if (hashHandle !== null) {
      window.clearTimeout(hashHandle);
    }
    hashHandle = window.setTimeout(() => {
      hashHandle = null;
      const encoded = encodeSettings(settings);
      // Keep the entry's state: the open guide marks its history entry so Back can close it.
      history.replaceState(history.state, '', encoded ? `#${encoded}` : location.pathname + location.search);
    }, 200);
  }

  function showToast(message: string, action?: { label: string; run: () => void }, durationMs?: number) {
    toast.replaceChildren(document.createTextNode(message));
    toast.classList.toggle('actionable', !!action);
    if (action) {
      const button = el('button', 'toast-action', action.label);
      button.type = 'button';
      button.addEventListener('click', () => {
        action.run();
        toast.classList.remove('visible');
      });
      toast.append(button);
    }
    toast.classList.add('visible');
    if (toastHandle !== null) {
      window.clearTimeout(toastHandle);
    }
    toastHandle = window.setTimeout(() => toast.classList.remove('visible'), durationMs ?? (action ? 5000 : 2600));
  }

  // ------------------------------------------------------------- HUD

  let lastHudKey = '';
  function updateHud() {
    if (!view) {
      return;
    }
    const status = view.getStatus();
    if (!Number.isFinite(status.timeMs) || Math.abs(status.timeMs) > 8.64e15) {
      return;
    }
    const time = new Date(status.timeMs);
    const timeText = `${formatUtc(time)} UTC`;
    const metaParts = [`${status.elapsedMs < 0 ? '−' : '+'}${formatElapsed(Math.abs(status.elapsedMs), settings.view)}`];
    if (settings.view === 'horizon') {
      metaParts.push(formatObserver(settings.latitude, settings.longitude));
    } else {
      const persp = BODY_OPTIONS.find((option) => option.value === settings.perspective)?.label ?? settings.perspective;
      metaParts.push(`from ${persp}`);
    }
    if (status.eclipse) {
      const { kind, obscuration } = status.eclipse;
      const label =
        kind === 'total' ? 'total solar eclipse' : kind === 'annular' ? 'annular eclipse' : `partial eclipse ${Math.min(99, Math.round(obscuration * 100))}%`;
      metaParts.push(label);
    }
    const speedNow = settings.view === 'horizon' ? horizonSpeed(settings) : spiroSpeed(settings);
    if (speedNow < 0 && !status.paused && !status.finished) metaParts.push('◀ rewinding');
    if (status.paused) metaParts.push('paused');
    else if (status.finished) metaParts.push('complete');
    else if (status.waiting) metaParts.push('waiting for next rise…');
    const metaText = metaParts.join(' · ');

    const visible = new Set(status.visible);
    const bodyKey = status.targets.map((target) => `${target.id}${visible.has(target.id) ? '+' : '-'}`).join(',');
    const key = `${timeText}|${metaText}|${bodyKey}`;
    if (key !== lastHudKey) {
      lastHudKey = key;
      hudTime.textContent = timeText;
      hudMeta.textContent = metaText;
      hudBodies.replaceChildren(
        ...status.targets.map((target) => {
          const chip = el('span', `hud-body${visible.has(target.id) ? '' : ' dim'}`);
          const dot = el('i');
          dot.style.background = target.color;
          chip.append(dot, document.createTextNode(target.label));
          return chip;
        })
      );
    }
    if (settings.showStats) {
      stats.textContent = status.paused
        ? 'paused'
        : `${Math.round(status.fps)} fps · ${status.frameWorkMs.toFixed(1)} ms`;
    }
  }
  window.setInterval(updateHud, 250);

  // ------------------------------------------------------------- export

  async function saveSnapshot() {
    if (!view) {
      return;
    }
    const source = view.canvas;
    const ratio = source.width / Math.max(1, source.clientWidth);
    // Phones: re-render the scene as a full-screen portrait (the live canvas is short while the
    // settings sheet is open, and pasting it would clip the sky). Elsewhere the canvas is the frame.
    const out = isSheetLayout()
      ? view.renderSnapshot(window.innerWidth, window.innerHeight)
      : copyCanvas(source);
    const ctx = out.getContext('2d');
    if (!ctx) {
      return;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    drawSnapshotCaption(ctx, out.width, out.height, ratio, view.getStatus());

    const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, 'image/png'));
    if (!blob) {
      showToast('Could not create image');
      return;
    }
    await deliverFile(blob, `planetary-patterns-${displayMode(settings)}-${Date.now()}.png`, 'Image saved');
  }

  /**
   * Caption centred along the bottom edge: a small spaced-out title, then date and place, then
   * the traced bodies in their own colours (wrapping as needed), dimmed while below the horizon.
   */
  function drawSnapshotCaption(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    ratio: number,
    status: ViewStatus
  ) {
    const pad = 16 * ratio;
    const maxWidth = width - pad * 2;
    const visible = new Set(status.visible);
    const meta = [
      formatUtc(new Date(status.timeMs)).slice(0, -6),
      settings.view === 'horizon'
        ? formatObserver(settings.latitude, settings.longitude)
        : `from ${settings.perspective}`,
    ].join('  ·  ');

    const family = '"JetBrains Mono", ui-monospace, monospace';
    const bodyFont = `${12 * ratio}px ${family}`;
    const dot = 4 * ratio;
    const dotGap = 6 * ratio;
    const gap = 14 * ratio;
    const lineHeight = 19 * ratio;

    // Lay out body tokens (dot + label) into centred lines.
    ctx.font = bodyFont;
    type Token = { target: ViewStatus['targets'][number]; width: number };
    const lines: Token[][] = [[]];
    let lineWidth = 0;
    for (const target of status.targets) {
      const tokenWidth = dot * 2 + dotGap + ctx.measureText(target.label).width;
      if (lineWidth > 0 && lineWidth + gap + tokenWidth > maxWidth) {
        lines.push([]);
        lineWidth = 0;
      }
      lineWidth += (lineWidth > 0 ? gap : 0) + tokenWidth;
      lines[lines.length - 1].push({ target, width: tokenWidth });
    }

    ctx.save();
    ctx.textBaseline = 'alphabetic';
    let y = height - pad;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      const total = line.reduce((sum, token) => sum + token.width, 0) + gap * Math.max(0, line.length - 1);
      let x = (width - total) / 2;
      for (const { target, width: tokenWidth } of line) {
        const shown = settings.view === 'spirograph' || visible.has(target.id);
        ctx.globalAlpha = shown ? 0.95 : 0.4;
        ctx.fillStyle = target.color;
        ctx.beginPath();
        ctx.arc(x + dot, y - dot * 1.1, dot, 0, Math.PI * 2);
        ctx.fill();
        ctx.font = bodyFont;
        ctx.textAlign = 'left';
        ctx.fillText(target.label, x + dot * 2 + dotGap, y);
        x += tokenWidth + gap;
      }
      y -= lineHeight;
    }

    ctx.globalAlpha = 1;
    ctx.textAlign = 'center';
    ctx.font = `${10.5 * ratio}px ${family}`;
    ctx.fillStyle = 'rgba(220, 220, 220, 0.6)';
    ctx.fillText(meta, width / 2, y + 2 * ratio, maxWidth);

    // Small spaced-out heading, like the on-screen HUD title.
    y -= 20 * ratio;
    const title = 'PLANETARY PATTERNS';
    ctx.font = `600 ${9.5 * ratio}px ${family}`;
    ctx.fillStyle = 'rgba(200, 200, 195, 0.5)';
    const spacing = 3 * ratio;
    const titleWidth = [...title].reduce((sum, ch) => sum + ctx.measureText(ch).width, 0) + spacing * (title.length - 1);
    let tx = (width - titleWidth) / 2;
    ctx.textAlign = 'left';
    for (const ch of title) {
      ctx.fillText(ch, tx, y);
      tx += ctx.measureText(ch).width + spacing;
    }
    ctx.restore();
  }

  /** Phones get the native share sheet (save to Photos etc.); elsewhere a plain download. */
  async function deliverFile(blob: Blob, name: string, doneMessage: string) {
    const file = new File([blob], name, { type: blob.type });
    if (isSheetLayout() && navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'Planetary Patterns' });
        return;
      } catch {
        // Share sheet dismissed: fall through to a download.
      }
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
    showToast(doneMessage);
  }

  /** Share links use the compact form; the address bar keeps the readable one while editing. */
  async function shareLink() {
    const url = `${location.origin}${location.pathname}#${COMPACT_PREFIX}${encodeCompact(settings)}`;
    if (isSheetLayout() && navigator.share) {
      try {
        await navigator.share({ url, title: 'Planetary Patterns' });
        return;
      } catch {
        // fall back to clipboard
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      showToast('Link copied');
    } catch {
      showToast('Copy failed: link is in the address bar');
    }
  }

  // ------------------------------------------------------------- input

  stage.addEventListener('click', (event) => {
    // On phones the sheet covers the sky: tapping the sky dismisses it.
    if (isSheetLayout() && target!.dataset.panel === 'open' && event.target instanceof HTMLCanvasElement) {
      setPanel(false);
    }
  });

  /**
   * Phone bottom sheet: drag it down (from the grabber, or from the content when it is scrolled
   * to the top) to close; a short drag springs back. Swiping up on the bottom bar opens it.
   * Horizontal movement (preset strip, sliders) cancels the gesture.
   */
  function attachSheetGestures() {
    let startX = 0;
    let startY = 0;
    let lastY = 0;
    let lastTime = 0;
    let velocity = 0;
    let tracking = false;
    let dragging = false;
    let fromDock = false;

    const resetBody = () => {
      panelBody.style.transform = '';
      panelBody.style.opacity = '';
    };

    const begin = (event: TouchEvent, onDock: boolean) => {
      if (!isSheetLayout() || event.touches.length !== 1) {
        tracking = false;
        return;
      }
      const touch = event.touches[0];
      const open = target!.dataset.panel === 'open';
      startX = touch.clientX;
      startY = lastY = touch.clientY;
      lastTime = event.timeStamp;
      velocity = 0;
      dragging = false;
      fromDock = onDock;
      const onGrabber = event.target instanceof Node && grabber.contains(event.target);
      tracking = onDock || (open && (panelBody.scrollTop <= 0 || onGrabber));
    };

    const move = (event: TouchEvent) => {
      if (!tracking) {
        return;
      }
      const touch = event.touches[0];
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      const dt = event.timeStamp - lastTime;
      if (dt > 0) {
        velocity = (touch.clientY - lastY) / dt;
      }
      lastY = touch.clientY;
      lastTime = event.timeStamp;
      const open = target!.dataset.panel === 'open';

      if (!dragging) {
        if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) {
          tracking = false;
          return;
        }
        if (Math.abs(dy) < 8) {
          return;
        }
        // Upward drags on open content are ordinary scrolling.
        if (open && dy < 0 && !fromDock) {
          tracking = false;
          return;
        }
        dragging = true;
        panelBody.style.transition = 'none';
      }
      event.preventDefault();
      if (open && !fromDock) {
        const offset = Math.max(0, dy);
        panelBody.style.transform = `translateY(${offset}px)`;
        panelBody.style.opacity = String(Math.max(0.35, 1 - offset / 500));
      }
    };

    const end = () => {
      if (!tracking) {
        return;
      }
      tracking = false;
      if (!dragging) {
        return;
      }
      dragging = false;
      panelBody.style.transition = '';
      const dy = lastY - startY;
      const open = target!.dataset.panel === 'open';
      if (open && (dy > 90 || velocity > 0.6)) {
        // Finish the slide, then collapse (the canvas resizes once, after the animation).
        panelBody.style.transform = `translateY(${panelBody.offsetHeight}px)`;
        panelBody.style.opacity = '0';
        window.setTimeout(() => {
          setPanel(false);
          resetBody();
        }, 160);
      } else if (!open && (dy < -30 || velocity < -0.4)) {
        setPanel(true);
      } else {
        resetBody();
      }
    };

    panelBody.addEventListener('touchstart', (event) => begin(event, false), { passive: true });
    dock.addEventListener('touchstart', (event) => begin(event, true), { passive: true });
    for (const element of [panelBody, dock]) {
      element.addEventListener('touchmove', move, { passive: false });
      element.addEventListener('touchend', end);
      element.addEventListener('touchcancel', end);
    }
  }

  window.addEventListener('keydown', (event) => {
    // While the guide is open, keys scroll it; only Escape does anything (closes it).
    if (docs.isOpen()) {
      if (event.key === 'Escape') {
        docs.close();
      }
      return;
    }
    const active = document.activeElement;
    if (
      event.metaKey || event.ctrlKey || event.altKey ||
      (active instanceof HTMLInputElement && active.type !== 'range' && active.type !== 'checkbox') ||
      active instanceof HTMLSelectElement || active instanceof HTMLTextAreaElement
    ) {
      return;
    }
    switch (event.key) {
      case ' ':
        event.preventDefault();
        // A focused button would also activate on keyup; Space here always means play/pause.
        if (active instanceof HTMLElement && active !== document.body) {
          active.blur();
        }
        setPaused(!paused);
        break;
      case 'r':
      case 'R':
        rebuildView();
        break;
      case '1':
      case '2':
      case '3':
      case '4':
        update(DISPLAY_MODES[Number(event.key) - 1].patch);
        break;
      case 's':
      case 'S':
        void saveSnapshot();
        break;
      case 'h':
      case 'H':
        togglePanel();
        break;
      case '?':
        docs.open();
        break;
      case '+':
      case '=':
        event.preventDefault();
        stepSpeed(+1);
        break;
      case '-':
      case '_':
        event.preventDefault();
        stepSpeed(-1);
        break;
      default:
    }
  });

  /** +/- hotkeys: move the current view's speed one notch and say where it landed. */
  function stepSpeed(direction: number) {
    const isHorizon = settings.view === 'horizon';
    const key = isHorizon ? 'horizonSpeed' : 'spiroSpeed';
    const steps = isHorizon ? HORIZON_SPEED_STEPS : SPIRO_SPEED_STEPS;
    const next = Math.max(minSpeedIndex(steps), Math.min(steps.length, settings[key] + direction));
    if (next !== settings[key]) {
      update({ [key]: next });
    }
    flashSpeed(isHorizon ? horizonSpeed(settings) : spiroSpeed(settings));
  }

  /** Large, brief readout just above the bar (or bottom of the sky) after a speed change. */
  function flashSpeed(speed: number) {
    speedFlash.textContent = Number.isFinite(speed) ? formatSpeed(speed) : 'Maximum Overdrive';
    speedFlash.classList.add('visible');
    if (speedFlashHandle !== null) {
      window.clearTimeout(speedFlashHandle);
    }
    speedFlashHandle = window.setTimeout(() => speedFlash.classList.remove('visible'), 1200);
  }

  window.addEventListener('hashchange', () => {
    const encoded = encodeSettings(settings);
    if (location.hash.replace(/^#/, '') === encoded) {
      return;
    }
    settings = { ...DEFAULTS, ...parseHash(location.hash) };
    syncAll();
    rebuildView();
  });

  attachSheetGestures();
  setPanel(target.dataset.panel === 'open');
  syncAll();
  rebuildView();
  // Rewrite the fragment from the validated settings so the address bar never shows rejected values.
  if (location.hash) {
    persistHash();
  }
}

// ----------------------------------------------------------------- composite controls

function createBodyPicker(update: UpdateFn): Control {
  const root = el('section', 'section section-flat');
  root.append(el('h2', 'section-title', 'Bodies'));
  const grid = el('div', 'body-grid');
  root.append(grid);
  root.append(el('h3', 'section-subtitle', 'Comets, asteroids & craft'));
  const specialGrid = el('div', 'body-grid');
  root.append(specialGrid);
  let current: Settings | null = null;

  const makeChip = (label: string, color: string, onClick: () => void) => {
    const chip = el('button', 'body-chip');
    chip.type = 'button';
    chip.style.setProperty('--body-color', color);
    chip.append(el('i'), document.createTextNode(label));
    chip.addEventListener('click', onClick);
    return chip;
  };

  const chips = BODY_OPTIONS.map((option) => {
    const chip = makeChip(option.label, getPlanetColor(option.value), () => {
      if (!current) {
        return;
      }
      const selected = new Set(current.bodies);
      if (selected.has(option.value)) {
        selected.delete(option.value);
      } else {
        selected.add(option.value);
      }
      update({ bodies: canonicalBodies([...selected]) });
    });
    grid.append(chip);
    return { chip, body: option.value };
  });

  const specialChips = SPECIAL_OBJECTS.map((special) => {
    const chip = makeChip(special.shortName, special.color, () => {
      if (!current) {
        return;
      }
      const selected = new Set(current.specials);
      if (selected.has(special.id)) {
        selected.delete(special.id);
      } else {
        selected.add(special.id);
      }
      update({ specials: SPECIAL_OBJECTS.map((s) => s.id).filter((id) => selected.has(id)) });
    });
    chip.title = `${special.name}: ${special.description}`;
    specialGrid.append(chip);
    return { chip, id: special.id };
  });

  return {
    root,
    sync(settings) {
      current = settings;
      const excluded = settings.view === 'horizon' ? Body.Earth : settings.perspective;
      for (const { chip, body } of chips) {
        const isExcluded = body === excluded;
        chip.disabled = isExcluded;
        chip.title = isExcluded
          ? settings.view === 'horizon' ? 'You are standing on Earth' : 'This is the viewpoint'
          : '';
        chip.setAttribute('aria-pressed', String(!isExcluded && settings.bodies.includes(body)));
      }
      for (const { chip, id } of specialChips) {
        chip.setAttribute('aria-pressed', String(settings.specials.includes(id)));
      }
    },
  };
}

function createStartControl(update: UpdateFn): Control {
  const root = el('div', 'field');
  root.append(el('span', 'field-label', 'Start'));
  const wrap = el('span', 'input-with-button');
  const input = el('input');
  input.type = 'datetime-local';
  input.setAttribute('aria-label', 'Start time');
  const now = el('button', 'mini-button', 'Now');
  now.type = 'button';
  now.title = 'Start from the current moment';
  const night = el('button', 'mini-button', 'Night');
  night.type = 'button';
  night.title = 'Start at the next nightfall for the observer';
  wrap.append(input, now, night);
  root.append(wrap);

  input.addEventListener('change', () => update({ start: input.value }));
  now.addEventListener('click', () => update({ start: '' }));
  night.addEventListener('click', () => update({ start: 'night' }));

  return {
    root,
    sync(settings) {
      if (document.activeElement !== input) {
        input.value = settings.start === '' || settings.start === 'night' || settings.start.endsWith('Z')
          ? toDatetimeLocal(resolveStartTime(settings))
          : settings.start;
      }
      now.setAttribute('aria-pressed', String(settings.start === ''));
      night.setAttribute('aria-pressed', String(settings.start === 'night'));
      night.hidden = settings.view !== 'horizon';
    },
  };
}

function createLocationSection(update: UpdateFn): Control {
  const placeRoot = el('label', 'field');
  placeRoot.append(el('span', 'field-label', 'Place'));
  const wrap = el('span', 'input-with-button');
  const select = el('select');
  const custom = el('option', '', 'Custom');
  custom.value = '';
  select.append(custom);
  LOCATIONS.forEach((place, index) => {
    const option = el('option', '', place.label);
    option.value = String(index);
    select.append(option);
  });
  const locate = el('button', 'mini-button icon-only');
  locate.type = 'button';
  locate.innerHTML = ICONS.locate;
  locate.title = 'Use my location';
  locate.setAttribute('aria-label', 'Use my location');
  wrap.append(select, locate);
  placeRoot.append(wrap);

  select.addEventListener('change', () => {
    const place = LOCATIONS[Number(select.value)];
    if (select.value !== '' && place) {
      update({ latitude: place.latitude, longitude: place.longitude });
    }
  });
  locate.addEventListener('click', (event) => {
    event.preventDefault();
    if (!navigator.geolocation) {
      return;
    }
    locate.classList.add('busy');
    navigator.geolocation.getCurrentPosition(
      (position) => {
        locate.classList.remove('busy');
        update({
          latitude: Math.round(position.coords.latitude * 1e4) / 1e4,
          longitude: Math.round(position.coords.longitude * 1e4) / 1e4,
          elevation: Math.round(position.coords.altitude ?? 0),
        });
      },
      () => {
        locate.classList.remove('busy');
        locate.title = 'Location unavailable (needs HTTPS and permission)';
      },
      { timeout: 10000 }
    );
  });

  const place: Control = {
    root: placeRoot,
    sync(settings) {
      const index = LOCATIONS.findIndex(
        (p) => Math.abs(p.latitude - settings.latitude) < 1e-3 && Math.abs(p.longitude - settings.longitude) < 1e-3
      );
      select.value = index >= 0 ? String(index) : '';
    },
  };

  return sectionControl(
    'Observer',
    [
      place,
      rowControl([
        numberControl('latitude', 'Latitude', { min: -89.9, max: 89.9, step: 0.0001, suffix: '°' }, update),
        numberControl('longitude', 'Longitude', { min: -180, max: 180, step: 0.0001, suffix: '°' }, update),
      ]),
      numberControl('elevation', 'Elevation', { min: -500, max: 9000, step: 1, suffix: 'm' }, update),
    ],
    ['horizon']
  );
}

// ----------------------------------------------------------------- helpers

function selectedSpecials(settings: Settings): SpecialObject[] {
  return SPECIAL_OBJECTS.filter((special) => settings.specials.includes(special.id));
}

/** Everything the horizon view should trace: selected planets, then special objects. */
function skyTargets(settings: Settings): SkyTarget[] {
  return [...effectiveBodies(settings).map(bodyTarget), ...selectedSpecials(settings).map(specialTarget)];
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** Camera and landscape for Scene mode; shown only while it is the active mode. */
function sceneSection(update: UpdateFn): Control {
  const section = sectionControl(
    'Scene',
    [
      rangeControl('sceneHeading', 'Facing', {
        min: 0,
        max: 359,
        step: 1,
        format: (v) => `${COMPASS[Math.round(v / 22.5) % 16]} · ${v}°`,
      }, update),
      rangeControl('sceneTilt', 'Tilt', { min: 0, max: 45, step: 1, format: (v) => `${v}° up` }, update),
      rangeControl('sceneFov', 'Field of view', {
        min: 30,
        max: 120,
        step: 1,
        // As a full-frame lens: the diagonal angle and its equivalent focal length.
        format: (v) => `${v}° · ${Math.round(21.63 / Math.tan((v * Math.PI) / 360))} mm`,
      }, update),
      segmentedControl('landscape', 'Landscape', [
        { value: 'mountains', label: 'Mountains' },
        { value: 'lake', label: 'Lake' },
        { value: 'boat', label: 'Boat' },
      ], update),
    ],
    ['horizon']
  );
  return {
    ...section,
    sync(settings) {
      section.sync(settings);
      section.root.hidden = settings.view !== 'horizon' || settings.projection !== 'perspective';
    },
  };
}

function horizonVisuals(settings: Settings) {
  return {
    projection: settings.projection,
    stars: settings.stars,
    skyTint: settings.skyTint,
    lineWidth: settings.lineWidth,
    trailStyle: settings.trailStyle,
    settledBrightness: settings.settledBrightness,
    labels: settings.labels,
    clouds: settings.clouds,
    cloudCover: settings.cloudCover,
    milkyWay: settings.milkyWay,
    scene: {
      heading: settings.sceneHeading,
      tilt: settings.sceneTilt,
      fov: settings.sceneFov,
      landscape: settings.landscape,
    },
  };
}

function spiroVisuals(settings: Settings) {
  return {
    colorMode: settings.colorMode,
    glow: settings.spiroGlow,
    lineWidth: settings.spiroLineWidth,
    symmetry: settings.symmetry,
    mirror: settings.mirror,
    connect: settings.connect,
    connectDays: settings.connectDays,
    fadeYears: settings.fadeYears,
    zoom: settings.zoom,
    labels: settings.labels,
    auLabels: settings.auLabels,
  };
}

/** "YYYY-MM-DD HH:MM" in UTC; years outside 0–9999 stay readable (toISOString uses ±YYYYYY). */
function formatUtc(date: Date) {
  const pad = (value: number) => `${value}`.padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

function copyCanvas(source: HTMLCanvasElement) {
  const copy = document.createElement('canvas');
  copy.width = source.width;
  copy.height = source.height;
  copy.getContext('2d')?.drawImage(source, 0, 0);
  return copy;
}

function formatObserver(latitude: number, longitude: number) {
  const lat = `${Math.abs(latitude).toFixed(2)}°${latitude >= 0 ? 'N' : 'S'}`;
  const lon = `${Math.abs(longitude).toFixed(2)}°${longitude >= 0 ? 'E' : 'W'}`;
  return `${lat} ${lon}`;
}

function formatElapsed(elapsedMs: number, mode: ViewMode) {
  const totalMinutes = Math.max(0, Math.floor(elapsedMs / 60000));
  const days = Math.floor(totalMinutes / 1440);
  if (mode === 'spirograph' || days >= 365) {
    const years = Math.floor(days / 365.25);
    const remDays = Math.floor(days - years * 365.25);
    return years > 0 ? `${years}y ${remDays}d` : `${days}d`;
  }
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const hh = `${hours}`.padStart(2, '0');
  const mm = `${minutes}`.padStart(2, '0');
  return days > 0 ? `${days}d ${hh}h ${mm}m` : `${hh}h ${mm}m`;
}
