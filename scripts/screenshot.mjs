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
 *   public/screenshots/og.png       the link preview (og:image): the result on
 *                                   a desktop viewport, in a browser window on
 *                                   the pink of gnass.buzz/projects, 2400 × 1260
 *
 * Not deployed, so not in public/:
 *
 *   promo/post.png                  the same in the 4:5 format of a LinkedIn
 *                                   post image, with the tagline above the
 *                                   window, 2160 × 2700
 *
 * Demo photo: scripts/assets/banana.jpg, "riped banana on pink surface" by
 * Mike Dorner (https://unsplash.com/photos/sf_1ZDA1YFw), Unsplash License.
 *
 * Re-run any time the UI changes:  npm run screenshot
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const outDir = resolve(root, 'public', 'screenshots');
const promoDir = resolve(root, 'promo');
const require = createRequire(import.meta.url);
const BOREL = require.resolve('@fontsource/borel/files/borel-latin-400-normal.woff2');
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

const BAR = 40;
const BORDER = 2;

/**
 * A result shot in a stylized browser window on the accent color of begone on
 * gnass.buzz/projects, with the same frame color and hard shadow. `canvas` is
 * the image size in CSS pixels, `window` the place of the window in it. The
 * app viewport is the window minus its border and title bar. An optional
 * `title` is written in Borel, centered above the window.
 */
function framedShot(canvas, window, { title, dir = outDir } = {}) {
  const content = {
    width: window.width - 2 * BORDER,
    height: window.height - BAR - 2 * BORDER,
  };
  return {
    viewport: content,
    mobile: false,
    storage: RESULT_STORAGE,
    stage: removeBackground,
    dir,
    compose: (browser, png) => frameInBrowser(browser, png, canvas, window, content, title),
  };
}

async function frameInBrowser(browser, png, canvas, w, content, title) {
  const font = title ? (await readFile(BOREL)).toString('base64') : '';
  const html = `<!doctype html>
<style>
  @font-face { font-family: Borel; src: url(data:font/woff2;base64,${font}) format('woff2'); }
  h1 {
    position: absolute; left: 0; right: 0; top: 0; height: ${w.y}px;
    display: flex; align-items: center; justify-content: center;
    font: 400 84px/1 Borel; color: #3d0722; padding-top: 0.5em;
  }
  * { box-sizing: border-box; margin: 0; }
  body { width: ${canvas.width}px; height: ${canvas.height}px; background: #ff3ea5; overflow: hidden; }
  .window {
    position: absolute; left: ${w.x}px; top: ${w.y}px; width: ${w.width}px; height: ${w.height}px;
    border: ${BORDER}px solid #3d0722; border-radius: 16px; overflow: hidden;
    background: #3d0722; box-shadow: 0 10px #00000038;
  }
  .bar { position: relative; height: ${BAR}px; display: flex; align-items: center; padding-left: 16px; gap: 8px; }
  .dot { width: 12px; height: 12px; border-radius: 50%; background: #ff3ea5; opacity: 0.6; }
  .url {
    position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
    width: 360px; height: 26px; border-radius: 13px; background: #ffffff1a;
    color: #ffd3ea; font: 500 13px/26px system-ui, sans-serif; text-align: center; letter-spacing: 0.02em;
  }
  img { display: block; width: ${content.width}px; height: ${content.height}px; }
</style>
${title ? `<h1>${title}</h1>` : ''}
<div class="window">
  <div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="url">bg.gnass.buzz</span></div>
  <img src="data:image/png;base64,${png.toString('base64')}" />
</div>`;
  const context = await browser.newContext({ viewport: canvas, deviceScaleFactor: SCALE });
  try {
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    return { png: await page.screenshot(), size: { width: canvas.width * SCALE, height: canvas.height * SCALE } };
  } finally {
    await context.close();
  }
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
  // Link preview for LinkedIn, Slack etc., which use 1.91:1.
  og: framedShot({ width: 1200, height: 630 }, { x: 60, y: 40, width: 1080, height: 534 }),
  // Image for a LinkedIn post: 4:5 gets the most room in the feed.
  post: framedShot(
    { width: 1080, height: 1350 },
    { x: 60, y: 250, width: 960, height: 1030 },
    { title: 'background begone!', dir: promoDir },
  ),
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
  const { viewport = VIEWPORT, scale = SCALE, mobile = true } = shot;
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: scale,
    isMobile: mobile,
    hasTouch: mobile,
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
    let png = await page.screenshot();
    let size = { width: viewport.width * scale, height: viewport.height * scale };
    if (shot.compose) ({ png, size } = await shot.compose(browser, png));
    const out = resolve(shot.dir ?? outDir, `${name}.png`);
    await writeFile(out, png);
    console.log(`Saved ${out} (${size.width} × ${size.height})`);
  } finally {
    await context.close();
  }
}

async function main() {
  await mkdir(outDir, { recursive: true });
  await mkdir(promoDir, { recursive: true });

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
