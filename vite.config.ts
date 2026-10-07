import { readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { letteringPlugin } from './scripts/lettering';

// Cloudflare Pages serves files of at most 25 MiB. After the build, split
// larger files into numbered parts plus a `<file>.json` manifest.
// src/fetch-split.ts puts them back together at runtime.
const PART_SIZE = 20 * 1024 * 1024;

function splitLargeFiles(): Plugin {
  let outDir = '';
  return {
    name: 'split-large-files',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    // Runs before vite-plugin-pwa writes the precache list.
    closeBundle: {
      order: 'pre',
      sequential: true,
      handler() {
        for (const rel of readdirSync(outDir, { recursive: true, encoding: 'utf8' })) {
          const file = join(outDir, rel);
          const { size } = statSync(file);
          if (size <= PART_SIZE) continue;
          const data = readFileSync(file);
          const parts: string[] = [];
          for (let offset = 0; offset < size; offset += PART_SIZE) {
            const part = `${basename(file)}.${String(parts.length).padStart(3, '0')}`;
            writeFileSync(join(file, '..', part), data.subarray(offset, offset + PART_SIZE));
            parts.push(part);
          }
          writeFileSync(`${file}.json`, JSON.stringify({ size, parts }));
          unlinkSync(file);
          console.log(`split ${rel} into ${parts.length} parts`);
        }
      },
    },
  };
}

// Cross-origin isolation enables SharedArrayBuffer, so the WASM backend can
// use several threads. The production host must send the same headers.
const headers = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  server: { headers },
  preview: { headers },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  plugins: [
    letteringPlugin(),
    splitLargeFiles(),
    VitePWA({
      // Updates apply on the next launch, so a reload never interrupts work.
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'apple-touch-icon-180x180.png'],
      manifest: {
        name: 'begone – remove image backgrounds',
        short_name: 'begone',
        description: 'Remove the background from images. Runs entirely in your browser, also offline.',
        lang: 'en',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#F5F5F5',
        theme_color: '#F5F5F5',
        icons: [
          { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        file_handlers: [
          {
            action: '/',
            accept: { 'image/*': ['.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.bmp'] },
          },
        ],
        launch_handler: { client_mode: 'focus-existing' },
      } as any,
      workbox: {
        // App shell and the ORT runtime (its wasm is split into parts). The
        // worker caches the models itself, and only the one this device needs.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,mjs,woff2}', 'assets/*.wasm.json', 'assets/*.wasm.[0-9][0-9][0-9]'],
        // Screenshots are only for the portfolio page.
        globIgnores: ['models/**', 'screenshots/**'],
        maximumFileSizeToCacheInBytes: 25 * 1024 * 1024,
        navigateFallbackDenylist: [/^\/models\//],
      },
    }),
  ],
});
