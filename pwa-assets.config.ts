import { defineConfig, type Preset } from '@vite-pwa/assets-generator/config';

// The favicon is a full pink square, so it needs no padding. Where the
// generator pads (maskable icons keep a safe zone), it pads in the same pink.
const PINK = '#ff3ea5';

const preset: Preset = {
  transparent: { sizes: [64, 192, 512], favicons: [[48, 'favicon.ico']], padding: 0 },
  maskable: { sizes: [512], padding: 0.1, resizeOptions: { background: PINK } },
  apple: { sizes: [180], padding: 0, resizeOptions: { background: PINK } },
};

export default defineConfig({
  preset,
  images: ['public/favicon.svg'],
});
