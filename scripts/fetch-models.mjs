// Downloads the ONNX models into public/models and verifies their checksums.
// The models are too large for git, so this runs before every build.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MODELS = [
  {
    file: 'birefnet-lite-1024-fp16.onnx',
    url: 'https://huggingface.co/jiabins0303/birefnet-lite-1024-webgpu/resolve/1ad01cef0f4101a285c5a3e0bd7f15597d93403f/onnx/model_fp16.onnx',
    sha256: '4059896039dfccb0f15b9080ff06d11d90e499449bb045e797055eb8901cf5f4',
  },
  {
    file: 'birefnet-lite-512-fp32.onnx',
    url: 'https://huggingface.co/studioludens/birefnet-lite-512/resolve/4a3c40c36c94093cc1e724d9ea428b8fa4b57dc7/onnx/model.onnx',
    sha256: '1cb0fb360dadd15af77c639085d77a9df67db0c64315560c3de005f676345ac2',
  },
];

const dir = new URL('../public/models/', import.meta.url);
mkdirSync(dir, { recursive: true });

async function sha256(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

for (const { file, url, sha256: expected } of MODELS) {
  const path = new URL(file, dir);
  if (existsSync(path) && (await sha256(path)) === expected) {
    console.log(`✓ ${file}`);
    continue;
  }
  console.log(`↓ ${file}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const tmp = new URL(`${file}.part`, dir);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  const actual = await sha256(tmp);
  if (actual !== expected) throw new Error(`${file}: checksum mismatch (${actual})`);
  renameSync(tmp, path);
  console.log(`✓ ${file}`);
}
