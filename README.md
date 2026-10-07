# begone

Removes the background from images. Runs completely in the browser, also offline. No uploads, no account, no ads.

**Use the app at [bg.gnass.buzz](https://bg.gnass.buzz).** You do not have to install anything. On a phone or desktop, you can add it to the home screen or install it as an app from the browser.

This page explains how the app works and how to build it from the source.

## How it works

- **Model:** [BiRefNet-lite](https://github.com/ZhengPeng7/BiRefNet) (MIT, also the weights).
  - WebGPU: [1024×1024 fp16 graph](https://huggingface.co/jiabins0303/birefnet-lite-1024-webgpu), patched to run on WebGPU.
  - Fallback without WebGPU: [512×512 fp32 graph](https://huggingface.co/studioludens/birefnet-lite-512) on WASM (multi-threaded when cross-origin isolated).
- **Runtime:** [onnxruntime-web](https://onnxruntime.ai) in a Web Worker.
- **Edges:** Images above 4096² pixels are scaled down, and the mask is upscaled to the output size. Then "blur fusion" foreground estimation (Forte & Pitié 2021) removes the colour of the old background from hair and other soft edges. It runs in overlapping tiles with reused buffers to keep working memory bounded.
- **Shadows:** For a plain, light background (studio shots), the app fits a smooth "clean plate" of the background (a cubic polynomial, shadows rejected as outliers). Pixels darker than the plate become a black shadow layer with partial alpha, so the shadow keeps its real shape and softness. If the background is not plain, this step does nothing. A toolbar button turns it off; the model does not run again.
- **Brush:** "Restore" (B) and "Erase" (E) fix the mask by hand, `[` / `]` change the size, Ctrl/⌘ Z undoes a stroke. Strokes are kept as vectors and sent to the worker as one edit image. The worker applies it to the cached model mask before edge refinement and shadows, so the model does not run again and the PNG has clean edges. Copy and Download wait until all edits are included in the displayed result.
- **Output:** A PNG encoder of our own writes straight (not premultiplied) alpha, so semi-transparent pixels keep their exact colour.
- **Offline:** The service worker caches the app and the ORT runtime. The worker caches the model in Cache Storage at first use. Only the model the device needs is downloaded.

## Develop

You only need these steps if you want to change the app or run your own copy. To use the app, open [bg.gnass.buzz](https://bg.gnass.buzz).

Use Node.js 22.18 or newer.

```sh
npm install
npm run models   # downloads the models to public/models and checks their SHA-256
npm run dev
```

Open `/?wasm` to force the WASM fallback.

```sh
npm test        # request ordering, worker recovery, PNG round trips, blur and shadow fixtures
npm run build   # type checking and the production/PWA build
```

The UI tests use mocks for the worker and image decoding. They do not run the model, so they do not replace tests in real browsers and on real devices.

## Deploy (Cloudflare Pages)

```sh
npm run deploy   # models + build + wrangler pages deploy
```

Or connect the Git repository in the Cloudflare dashboard with the build command `npm run models && npm run build` and the output directory `dist`.

Notes:

- Cloudflare Pages serves files of at most 25 MiB. The build splits larger files (the models and the ORT wasm) into 20 MiB parts with a `<file>.json` manifest. `src/fetch-split.ts` puts them back together in the browser.
- `public/_headers` sets `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy`. Without them, the WASM fallback uses one thread only.
