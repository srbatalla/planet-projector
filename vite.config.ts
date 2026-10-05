import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const readJson = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const pkg = readJson('./package.json');

/** Installed version and licence of a package, for the docs' dependency list. */
function installed(name: string) {
  try {
    const meta = readJson(`./node_modules/${name}/package.json`);
    return { name, version: String(meta.version ?? ''), license: String(meta.license ?? '') };
  } catch {
    return { name, version: '', license: '' };
  }
}

/** Direct dependencies plus the bundlers Vite brings, read at build time so the list stays current. */
function dependencyList() {
  const names = (record: Record<string, string> | undefined) => Object.keys(record ?? {});
  let viteDeps: string[] = [];
  try {
    viteDeps = names(readJson('./node_modules/vite/package.json').dependencies);
  } catch {
    // Not installed: the list just omits Vite's own dependencies.
  }
  return {
    runtime: names(pkg.dependencies).map(installed),
    build: names(pkg.devDependencies).map(installed),
    viaVite: viteDeps.map(installed),
  };
}

/** Short commit id for the docs' build stamp: from Cloudflare's build env, else git, else unknown. */
function commitId() {
  const fromCi = process.env.WORKERS_CI_COMMIT_SHA ?? process.env.CF_PAGES_COMMIT_SHA;
  if (fromCi) {
    return fromCi.slice(0, 7);
  }
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'unknown';
  }
}

export default defineConfig(({ command }) => ({
  root: '.',
  server: {
    port: 5173,
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_ID__: JSON.stringify(command === 'serve' ? 'dev' : commitId()),
    __BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
    __DEPENDENCIES__: JSON.stringify(dependencyList()),
  },
}));
