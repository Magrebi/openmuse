// Generates the desktop app's tray and bundle icons. Run with `node scripts/make-icons.mjs`.
// Kept as a script so the binary assets are reproducible rather than hand-edited.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const icons = join(here, "..", "src-tauri", "icons");

let table = null;
function crc32(buffer) {
  if (!table) {
    table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buffer) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/** The mark: an ink disc with a mint centre, the app's healthy accent. */
function pixel(size, x, y) {
  const centre = (size - 1) / 2;
  const distance = Math.hypot(x - centre, y - centre);
  if (distance > size / 2 - 1) return [0, 0, 0, 0];
  if (distance < size / 5) return [124, 242, 196, 255];
  return [18, 24, 33, 255];
}

function png(size) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  let offset = 0;
  for (let y = 0; y < size; y++) {
    raw[offset++] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(size, x, y);
      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = b;
      raw[offset++] = a;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(icons, { recursive: true });
for (const size of [32, 128, 256, 512]) {
  const name = size === 256 ? "icon.png" : `${size}x${size}.png`;
  const data = png(size);
  writeFileSync(join(icons, name), data);
  console.log(`icons/${name} (${data.length} bytes)`);
}
