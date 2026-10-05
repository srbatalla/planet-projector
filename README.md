# Planetary Patterns

Planet motion as art, computed in the browser from real ephemerides
([Astronomy Engine](https://github.com/cosinekitty/astronomy)).

Three modes, switched from the bar:

- **Dome** (default) — the whole sky overhead as a fisheye: long-exposure streaks of the Sun,
  Moon and planets, star trails wheeling around the pole, optional daylight tint and clouds.
- **Horizon** — the same sky as a 360° panorama along the horizon.
- **Spiro** — the looping paths planets trace as seen from another body: the five-petal
  Venus rose, retrograde loops, Earth–Venus "dance" chords, kaleidoscope symmetry.

Both views can also trace Pluto and **special objects** propagated from Keplerian elements:
Ceres, comets Halley, Encke and Hale-Bopp, the interstellar visitors ʻOumuamua and 2I/Borisov
(hyperbolic orbits), the Tesla Roadster and Apollo 10's Snoopy. Their elements reproduce known
events (e.g. Hale-Bopp's 1.315 AU and ʻOumuamua's 0.161 AU closest approaches to Earth); being
two-body orbits, they drift by days over years where Jupiter perturbs them.

Everything runs client-side; no server or API keys.

## Run

```sh
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check + production build into dist/
```

## Deploy

It is a static site, deployed on Cloudflare as a static-assets Worker (`wrangler.jsonc`), with the
GitHub repo connected so every push to `main` redeploys:

| Setting | Value |
|---|---|
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` (serves `dist/`, per `wrangler.jsonc`) |
| Node version | 22 (`.node-version`; current Wrangler requires it) |

Cloudflare Pages or any other static host works too: build with `npm run build` and publish `dist/`.

No redirects are needed: all state lives in the URL fragment. HTTPS is required for
"Use my location" and the native share sheet.

It is also an installable web app: *Add to Home Screen* (iOS Safari share menu, Android Chrome
menu) gives a full-screen app with its own icon, and it keeps working offline after the first
visit. The service worker (`public/sw.js`) loads pages network-first, so a new deploy shows up on
the next online launch; `public/_headers` keeps Cloudflare from caching the worker itself. It is
only registered in production builds and needs HTTPS (or localhost), so the LAN dev server is
unaffected.

## Using it

- **Presets** are the quickest way in; every setting is in the side panel (bottom sheet on phones).
- **Guide & docs** at the bottom of the settings (or <kbd>?</kbd>): usage tips, getting 120 fps on
  iPhone, installing as an offline app, and the dependencies list.
- **Share**: *Link* copies a compact link (e.g. `#z=AQABARgSCBQAFwEYyAEbARwG`, ~4× shorter) that
  reproduces exactly what you see. While you edit, the address bar shows a readable form
  (`#view=spirograph&bodies=Venus,Earth&perspective=Sun&connect=1…`); both open the same view.
  Compact links are a versioned binary encoding (see `src/shareCodec.ts`): field ids are
  append-only and carry frozen base values, so old links survive later default changes. No server
  is involved; true short URLs (`/s/abc`) would need storage such as a Pages Function + KV.
- **Library**: *Save this run* keeps the settings plus a thumbnail on this device (localStorage);
  load, rename or delete them later. Runs started at "now" or "night" are pinned to the instant
  they actually began, so reloading reproduces the same sky.
- **Export**: *Snapshot* (PNG; on phones a portrait frame shaped like the screen with the sky
  centred and the traced bodies listed along the bottom) and *Record* (10 s clip). Clips are H.264 MP4 where
  the browser can encode it (Chrome 126+, Safari), which plays everywhere including iPhone; Firefox
  only records WebM, which iOS cannot play.
- **Rewind**: take the speed below 1× (− button or key) and time runs backward through the same
  steps (◀ 1×, ◀ 1k×, …). Arcs replay from where bodies set back to where they rose, the
  spirograph keeps drawing into the past; skip-ahead pauses while rewinding.
- **Moonlight** (with *Daylight sky* or clouds): a bright Moon turns the night sky a deep blue, glows
  around itself, washes out faint stars and silvers the clouds — cloud near the Moon lights up
  brightest, thin edges most of all — scaled by its phase and altitude. The Moon is drawn with its
  real phase, lit side toward the Sun, even when it is not one of the traced bodies.
- **Markers**: planets are sized by apparent magnitude (Venus and Jupiter stand out, Uranus and
  Neptune are pinpricks), and the Sun carries a warm glow.
- **Clouds** (*Sky → Clouds*): a procedural cloud deck drawn in true perspective (sparse overhead,
  crowding into a haze toward the horizon), lit by the Sun and Moon — warm undersides at dusk,
  grey-white by day, moonlit or silhouetted at night. *Long exp.* smears the drift into streaks,
  and star trails get gaps where clouds pass, as in a real long exposure.
- **Milky Way** (*Sky → Milky Way*): the galactic band placed by real galactic coordinates —
  bulge toward Sagittarius, the Cygnus star cloud, the dark Great Rift — turning with the sky,
  dimmed near the horizon and washed out by twilight and moonlight.
- **Phones**: the settings sheet has a grab handle — drag it down to return to the full view,
  swipe up on the bottom bar to open it, or tap the sky.
- **Keyboard**: <kbd>Space</kbd> play/pause · <kbd>+</kbd>/<kbd>−</kbd> speed · <kbd>R</kbd> restart · <kbd>1</kbd>/<kbd>2</kbd>/<kbd>3</kbd>
  Dome/Horizon/Spiro · <kbd>S</kbd> save image · <kbd>H</kbd> hide panel · <kbd>?</kbd> guide.
- **Spirograph zoom**: scroll or pinch; double-click resets.
- **Trail brightness** (horizon view): each trail is a settled streak plus a fresh glow that decays
  with simulated time (*Trails → Active sweep fade*, *Settled brightness*). Completed sweeps keep
  fading the same way, so finishing a sweep never pops, and older sweeps dim by cycle until they
  reach zero and are removed (*Lifespan*). Settled brightness 1 gives uniform long-exposure streaks,
  0 gives pure comet tails.

## How it stays fast

- Trails are stored as simplified vector polylines in azimuth/altitude, not bitmaps. Completed
  sweeps are composited into one cached layer, rebuilt a body at a time only when something
  changes, so per-frame cost no longer grows with planets × trail lifespan.
- `Equator()` (the expensive ephemeris call) is evaluated on a coarse time grid and interpolated
  (≤0.002° error), making horizon samples 3–8× cheaper.
- The spirograph inks only new segments each frame; a decimated sample store re-renders on
  resize, zoom or restyle without restarting the simulation.
- Canvas resolution is capped at 2× device pixels, simulation work has a per-frame time budget,
  and the loop stops entirely while paused.

## Layout

```
src/
  app.ts                 UI shell: layout, HUD, presets, export, keyboard
  settings.ts            settings model, URL encoding, presets
  ui/                    control builders, clip recorder
  core/                  ephemeris helpers, star catalog, orbital elements
  render/                canvas surface, labels
  views/horizon/         horizon view: projections, trails, stars, sky
  views/spirograph/      spirograph view
```
