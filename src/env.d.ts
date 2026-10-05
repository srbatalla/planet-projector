/** Injected by vite.config.ts for the docs' build stamp. */
declare const __APP_VERSION__: string;
declare const __BUILD_ID__: string;
declare const __BUILD_DATE__: string;

type DependencyInfo = { name: string; version: string; license: string };
/** package.json dependencies with installed versions, grouped by role (see vite.config.ts). */
declare const __DEPENDENCIES__: { runtime: DependencyInfo[]; build: DependencyInfo[]; viaVite: DependencyInfo[] };
