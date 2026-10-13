import { defineConfig, type Plugin } from 'vite';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Stamp the service worker cache name and precache all built assets. */
function swPlugin(): Plugin {
  return {
    name: 'marknest-sw',
    apply: 'build',
    writeBundle(opts, bundle) {
      const dir = opts.dir!;
      const assets = Object.keys(bundle).filter((f) => f !== 'sw.js').map((f) => './' + f);
      const file = resolve(dir, 'sw.js');
      let sw = readFileSync(file, 'utf8');
      sw = sw.replace('__BUILD__', Date.now().toString(36))
        .replace("const SHELL = ['./', './index.html', './manifest.webmanifest', './icon.svg'];",
          `const SHELL = ${JSON.stringify(['./', ...new Set(['./index.html', './manifest.webmanifest', './icon.svg', ...assets])])};`);
      writeFileSync(file, sw);
    },
  };
}

export default defineConfig({
  // Relative by default; the Pages workflow sets BASE_PATH=/marknest/.
  base: process.env.BASE_PATH || './',
  plugins: [swPlugin()],
  test: { environment: 'jsdom', include: ['tests/**/*.test.ts'] },
} as never);
