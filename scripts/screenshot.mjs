/**
 * Portfolio screenshot generator.
 *
 * Starts the Vite dev server and captures the app at an iPhone-class viewport
 * scaled 2× → exactly 780 × 1688. The shots use the real app: the script sets
 * the saved options, opens the demo photo through the file input and waits
 * until the model, edge refinement and PNG encoder are done. So the shots stay
 * correct as the app changes.
 *
 * They land in public/screenshots/, so the deployed site serves them at
 * https://bg.gnass.buzz/screenshots/*.png. The portfolio links those URLs
 * directly, so it stays in sync without copying files around.
 *
 *   public/screenshots/result.png   the demo photo without its background, on
 *                                   the checkerboard, with Shadow and Crop on
 *   public/screenshots/original.png the same frame with "Original" pressed, so
 *                                   the photo still has its background
 *   public/screenshots/start.png    the empty start screen
 *
 * Demo photo: scripts/assets/banana.jpg, "riped banana on pink surface" by
 * Mike Dorner (https://unsplash.com/photos/sf_1ZDA1YFw), Unsplash License.
 *
 * Re-run any time the UI changes:  npm run screenshot
 */
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const outDir = resolve(root, 'public', 'screenshots');
const photo = resolve(__dirname, 'assets', 'banana.jpg');

// Target output is 780 × 1688: half that on a high-DPI viewport, captured at
// the native device pixels.
const VIEWPORT = { width: 390, height: 844 };
const SCALE = 2;

const PORT = 5171;
const BASE = `http://127.0.0.1:${PORT}/`;

// The first run loads the model and may fall back to WASM, which is slow.
const WAIT_TIMEOUT_MS = 180_000;

/** Opens the demo photo and waits until the result can be exported. */
async function removeBackground(page) {
  await page.setInputFiles('#file', photo);
  await page.waitForFunction(
    () => document.body.classList.contains('done') &&
      document.querySelector('#download')?.getAttribute('aria-disabled') === 'false',
    null,
    { timeout: WAIT_TIMEOUT_MS },
  );
}

const RESULT_STORAGE = { 'bg-theme': 'checker', 'bg-shadow': 'on', 'bg-crop': 'on' };

/** Each shot: the saved options (localStorage) and how to bring the app into its state. */
const SHOTS = {
  result: {
    storage: RESULT_STORAGE,
    stage: removeBackground,
  },
  original: {
    storage: RESULT_STORAGE,
    async stage(page) {
      await removeBackground(page);
      await page.click('#compare');
    },
  },
  start: {
    storage: { 'bg-theme': 'light' },
    async stage() {},
  },
};

function startServer() {
  const child = spawn('npx', ['vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('Vite did not start in time')), 30_000);
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      if (/Local:.*http/.test(String(chunk))) {
        clearTimeout(timer);
        res(child);
      }
    });
    child.on('exit', (code) => rej(new Error(`Vite exited early (code ${code})`)));
  });
}

/** Capture one shot in its own context (own localStorage), then dispose it. */
async function capture(browser, name, shot) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: SCALE,
    isMobile: true,
    hasTouch: true,
    // Freeze CSS transitions/keyframes so the captured frame is deterministic.
    reducedMotion: 'reduce',
  });
  try {
    await context.addInitScript((storage) => {
      for (const [key, value] of Object.entries(storage)) localStorage.setItem(key, value);
    }, shot.storage);
    const page = await context.newPage();
    page.on('console', (msg) => {
      if (/Inference|Refine|failed|Error/.test(msg.text())) console.log(`  [page] ${msg.text()}`);
    });
    console.log(`Opening ${BASE} for ${name}`);
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await shot.stage(page);
    // Let the last layout settle before the capture.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const out = resolve(outDir, `${name}.png`);
    await page.screenshot({ path: out });
    console.log(`Saved ${out} (${VIEWPORT.width * SCALE} × ${VIEWPORT.height * SCALE})`);
  } finally {
    await context.close();
  }
}

async function main() {
  await mkdir(outDir, { recursive: true });

  console.log('Starting Vite…');
  const server = await startServer();

  // Use the real GPU, so the shots show the same 1024 px WebGPU model as most
  // devices. The headless shell only has SwiftShader without shader-f16, so it
  // needs the full Chromium build; Metal is the macOS backend. Without a usable
  // adapter, the app falls back to WASM (512 px) by itself.
  const browser = await chromium.launch({
    channel: 'chromium',
    args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal'],
  });
  try {
    for (const [name, shot] of Object.entries(SHOTS)) {
      await capture(browser, name, shot);
    }
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
