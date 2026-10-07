// Cloudflare Pages serves files of at most 25 MiB. The build splits larger
// files into parts and writes a `<file>.json` manifest next to them (see
// splitLargeFiles() in vite.config.ts). This puts the parts back together.

type Manifest = { size: number; parts: string[] };

export async function fetchSplit(url: string, onProgress?: (loaded: number, total: number) => void): Promise<Uint8Array<ArrayBuffer>> {
  if (import.meta.env.DEV) {
    // The dev server serves the original, unsplit file.
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed: ${url} (${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  }

  const base = new URL(url, self.location.href);
  const res = await fetch(`${base.href}.json`);
  if (!res.ok) throw new Error(`Download failed: ${url}.json (${res.status})`);
  const { size, parts }: Manifest = await res.json();

  const bytes = new Uint8Array(size);
  let loaded = 0;
  for (const part of parts) {
    const partUrl = new URL(part, base).href;
    const res = await fetch(partUrl);
    if (!res.ok || !res.body) throw new Error(`Download failed: ${partUrl} (${res.status})`);
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (loaded + value.length > size) throw new Error(`Download failed: ${url} is larger than expected`);
      bytes.set(value, loaded);
      loaded += value.length;
      onProgress?.(loaded, size);
    }
  }
  if (loaded !== size) throw new Error(`Download failed: ${url} is incomplete`);
  return bytes;
}
