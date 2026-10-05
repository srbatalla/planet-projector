/**
 * The in-app guide: usage tips, frame-rate advice, installing as an offline app, and what the
 * project is built on. A full-screen sheet over the app (not a separate page), so opening it
 * never resets the running sky; Android's back button closes it through a history entry.
 */

const CLOSE_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

const TOPICS: [id: string, label: string][] = [
  ['docs-start', 'Start'],
  ['docs-tips', 'Tips'],
  ['docs-fps', 'FPS'],
  ['docs-install', 'Install'],
  ['docs-deps', 'Dependencies'],
];

/** What each package does here; anything new still lists with its version and licence. */
const ROLES: Record<string, string> = {
  'astronomy-engine': 'Positions of the Sun, Moon and planets, rise and set, Moon phase and planet brightness. By Don Cross.',
  vite: 'Dev server and production build.',
  typescript: 'Type-checks the source.',
  '@types/node': 'Type definitions for the build configuration.',
  esbuild: 'Compiles TypeScript during development and minifies the build.',
  rollup: 'Bundles the app into a single script.',
  postcss: 'Processes the stylesheet.',
};

const LINKS: Record<string, string> = {
  'astronomy-engine': 'https://github.com/cosinekitty/astronomy',
};

function escapeHtml(text: string) {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
}

function dependencyList(items: DependencyInfo[]) {
  if (items.length === 0) {
    return '<p class="docs-note">None.</p>';
  }
  const rows = items.map(({ name, version, license }) => {
    const label = LINKS[name]
      ? `<a href="${LINKS[name]}" target="_blank" rel="noopener">${escapeHtml(name)}</a>`
      : escapeHtml(name);
    const meta = [version, license].filter(Boolean).map(escapeHtml).join(' · ');
    const role = ROLES[name] ? `<span class="docs-dep-role">${escapeHtml(ROLES[name])}</span>` : '';
    return `<li><span class="docs-dep-name">${label}</span> <span class="docs-dep-meta">${meta}</span>${role}</li>`;
  });
  return `<ul class="docs-deps">${rows.join('')}</ul>`;
}

function installedNote() {
  const standalone =
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return standalone ? '<p class="docs-note">You are using the installed app.</p>' : '';
}

function content() {
  return `
<section id="docs-start">
  <h2>Getting started</h2>
  <p>Planetary Patterns traces the Sun, Moon and planets as they really move: as long-exposure
  streaks across your sky, or as spirograph flowers of their orbits seen from one planet.</p>
  <ul>
    <li><b>Presets</b> (top of settings) are the quickest way in.</li>
    <li><b>Dome</b> is the whole sky as a circle, as if lying on your back looking up: north at
    the top, east on the <em>left</em>. <b>Horizon</b> unrolls the sky into a 360° panorama.
    <b>Spiro</b> draws orbits as seen from one body (<em>Frame → Seen from</em>).</li>
    <li><b>−</b> / <b>+</b> in the bar change speed. Below 1× time runs backward (◀): arcs
    replay from where bodies set back to where they rose.</li>
    <li>Pick where you are under <em>Place</em>, or tap the target button to use your
    location. <em>Start</em> sets when: <em>Now</em>, <em>Night</em> (next nightfall), or any date.</li>
  </ul>
</section>

<section id="docs-tips">
  <h2>Tips</h2>
  <ul>
    <li><b>The long-exposure look:</b> <em>Stars → Trails</em>, <em>Trail style → Glow</em>, and
    <em>Clouds → Long exp.</em>, which smears drifting cloud into streaks and leaves gaps in the
    star trails where cloud passes.</li>
    <li><b>A real night sky:</b> turn on <em>Daylight sky</em> and <em>Milky Way</em>. The Milky
    Way only shows in true darkness; a bright Moon washes it out, tints the sky blue and lights
    up the clouds around it. Pick a date near new Moon for the darkest skies.</li>
    <li><b>Skip ahead between arcs</b> (<em>Time</em>) jumps over the hours when nothing you
    trace is up, so sweeps follow each other without waiting.</li>
    <li>When a traced body is already up at the start, the run begins at its rise so the whole
    arc is drawn. That is why the clock can show a negative time at first.</li>
    <li><b>Spiro:</b> try <em>Connect bodies</em> (chords between two planets),
    <em>Symmetry</em> with <em>Mirror</em>, and a different <em>Seen from</em>. Pinch or scroll
    to zoom; double-click resets.</li>
    <li><b>Share:</b> <em>Link</em> copies a short link holding every setting.
    <em>Library → Save this run</em> keeps runs on this device. <em>Snapshot</em> saves an
    image; <em>Record</em> saves a 10-second clip.</li>
    <li><b>On a phone:</b> drag the settings sheet down to close it, swipe up on the bar to
    open it, or tap the sky.</li>
  </ul>
  <h3>Keyboard</h3>
  <dl class="docs-keys">
    <dt><kbd>Space</kbd></dt><dd>Play / pause</dd>
    <dt><kbd>+</kbd> <kbd>−</kbd></dt><dd>Faster / slower (below 1× rewinds)</dd>
    <dt><kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd></dt><dd>Dome / Horizon / Spiro</dd>
    <dt><kbd>R</kbd></dt><dd>Restart</dd>
    <dt><kbd>S</kbd></dt><dd>Save an image</dd>
    <dt><kbd>H</kbd></dt><dd>Hide or show the panel</dd>
    <dt><kbd>?</kbd></dt><dd>This guide</dd>
  </dl>
</section>

<section id="docs-fps">
  <h2>Higher frame rate (FPS)</h2>
  <p>Turn on <em>Display → Frame stats</em> to see the frame rate you are getting.</p>
  <h3>iOS</h3>
  <ul>
    <li><b>Allow 120 Hz.</b> Safari holds web pages to 60 fps even on ProMotion screens. To lift
    that: <em>Settings → Apps → Safari → Advanced → Feature Flags</em> and turn
    <b>off</b> <em>Prefer Page Rendering Updates near 60fps</em>. On iOS 17 and earlier it is
    under <em>Settings → Safari → Advanced → Feature Flags</em>. Then reload the page. This is a
    Safari setting; if the installed app still looks capped, compare in a Safari tab.</li>
    <li><b>Turn off Low Power Mode.</b> It throttles web animation to 30 fps.</li>
  </ul>
  <h3>Android</h3>
  <ul>
    <li>Chrome already follows the screen's refresh rate (90 or 120 Hz). Battery Saver can cap it
    at 60, and some phones have a "smooth display" or refresh-rate setting under Display.</li>
  </ul>
  <h3>Anywhere</h3>
  <ul>
    <li><b>Clouds</b> and the <b>Milky Way</b> repaint the whole sky and cost the most; turn them
    off on older devices.</li>
    <li>Fewer traced bodies, <em>Trail style → Line</em> instead of Glow, and <em>Stars →
    Points</em> instead of Trails all lighten each frame.</li>
    <li>The very top speeds do more work per frame; one or two steps down is often smoother.</li>
  </ul>
</section>

<section id="docs-install">
  <h2>Install as an app</h2>
  ${installedNote()}
  <p>Installed, it opens full screen with its own icon and keeps working with no connection
  once it has been opened online. Updates arrive automatically the next time you open it
  online.</p>
  <h3>iOS</h3>
  <ol>
    <li>Open the site in <b>Safari</b>.</li>
    <li>Tap <b>Share</b> (the square with an arrow), then <b>Add to Home Screen</b>, then
    <b>Add</b>.</li>
    <li>Open it from the Home Screen once while online so it can save itself for offline use.</li>
  </ol>
  <p class="docs-note">On iPhone the installed app keeps its own storage: runs saved in a
  Safari tab do not appear in the app, or the other way round. Use <em>Link</em> to move a run
  across. <em>Use my location</em> asks for permission again inside the app.</p>
  <h3>Android</h3>
  <ol>
    <li>Open the site in <b>Chrome</b>.</li>
    <li>Tap the <b>⋮</b> menu, then <b>Add to Home screen</b> or <b>Install app</b>, and
    confirm.</li>
  </ol>
  <h3>Desktop</h3>
  <p>In Chrome or Edge, click the install icon at the right of the address bar (or find
  <em>Install</em> in the browser menu).</p>
</section>

<section id="docs-deps">
  <h2>Dependencies</h2>
  <p>One library runs in the page; everything else only builds or deploys it.</p>
  <h3>Runs in the page</h3>
  ${dependencyList(__DEPENDENCIES__.runtime)}
  <h3>Build tools</h3>
  ${dependencyList(__DEPENDENCIES__.build)}
  <p class="docs-subhead">Brought in by Vite</p>
  ${dependencyList(__DEPENDENCIES__.viaVite)}
  <h3>Deploy</h3>
  <ul class="docs-deps">
    <li><span class="docs-dep-name">wrangler</span>
    <span class="docs-dep-role">Cloudflare's command-line tool; uploads the build to Cloudflare. Run by Cloudflare's deploy step, not installed with the project.</span></li>
  </ul>
  <h3>Browser features</h3>
  <ul class="docs-deps">
    <li><span class="docs-dep-name">Canvas 2D</span> <span class="docs-dep-role">All drawing; no frameworks or WebGL.</span></li>
    <li><span class="docs-dep-name">Service Worker · Cache Storage</span> <span class="docs-dep-role">The installable offline app.</span></li>
    <li><span class="docs-dep-name">localStorage</span> <span class="docs-dep-role">Library of saved runs, on this device only.</span></li>
    <li><span class="docs-dep-name">MediaRecorder · captureStream</span> <span class="docs-dep-role">Record (video clips).</span></li>
    <li><span class="docs-dep-name">Web Share · Clipboard</span> <span class="docs-dep-role">Link and sharing.</span></li>
    <li><span class="docs-dep-name">Geolocation</span> <span class="docs-dep-role">Use my location (asked only when you tap it).</span></li>
  </ul>
  <h3>Built-in data</h3>
  <ul>
    <li>About 100 of the brightest stars (J2000 positions).</li>
    <li>Orbits of selected comets, asteroids, interstellar visitors and spacecraft (two-body
    approximations).</li>
    <li>The IAU galactic coordinate frame, for placing the Milky Way.</li>
    <li>Clouds are procedural, not real weather. No trackers or cookies; settings live in the
    link itself.</li>
  </ul>
  <p class="docs-version">v${__APP_VERSION__} · build ${__BUILD_ID__} · ${__BUILD_DATE__}</p>
</section>`;
}

export type DocsSheet = {
  root: HTMLElement;
  isOpen: () => boolean;
  open: () => void;
  close: () => void;
};

/** `onToggle` lets the app pause the sky underneath while the guide is open. */
export function createDocs(onToggle: (open: boolean) => void): DocsSheet {
  const root = document.createElement('div');
  root.className = 'docs';
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-labelledby', 'docs-title');

  const header = document.createElement('header');
  header.className = 'docs-header';
  const title = document.createElement('h1');
  title.id = 'docs-title';
  title.textContent = 'Guide';
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'icon-button docs-close';
  closeButton.innerHTML = CLOSE_ICON;
  closeButton.setAttribute('aria-label', 'Close guide');
  closeButton.title = 'Close (Esc)';
  header.append(title, closeButton);

  // Buttons, not #anchors: the URL fragment holds the run's settings.
  const nav = document.createElement('nav');
  nav.className = 'docs-nav';
  const scroller = document.createElement('div');
  scroller.className = 'docs-scroll';
  const article = document.createElement('article');
  article.className = 'docs-body';
  for (const [id, label] of TOPICS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', () => {
      const target = article.querySelector<HTMLElement>(`#${id}`);
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    nav.append(button);
  }
  scroller.append(article);
  root.append(header, nav, scroller);

  let open = false;

  const hide = () => {
    if (!open) {
      return;
    }
    open = false;
    root.hidden = true;
    onToggle(false);
  };

  // A history entry for the open guide, so Android's back gesture closes it instead of the app.
  window.addEventListener('popstate', () => {
    if (open && !(history.state as { docs?: boolean } | null)?.docs) {
      hide();
    }
  });

  const sheet: DocsSheet = {
    root,
    isOpen: () => open,
    open() {
      if (open) {
        return;
      }
      // Built on open so the installed-app note reflects how it was launched.
      article.innerHTML = content();
      scroller.scrollTop = 0;
      open = true;
      root.hidden = false;
      history.pushState({ docs: true }, '');
      onToggle(true);
      closeButton.focus({ preventScroll: true });
    },
    close() {
      if ((history.state as { docs?: boolean } | null)?.docs) {
        history.back();
      } else {
        hide();
      }
    },
  };
  closeButton.addEventListener('click', () => sheet.close());
  return sheet;
}
