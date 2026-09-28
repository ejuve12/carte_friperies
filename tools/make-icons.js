// Génère les icônes PNG de l'app (sans dépendance) : node tools/make-icons.js
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const OUT = path.join(__dirname, "..", "icons");
const BG = [181, 84, 60];      // --accent
const FG = [255, 250, 245];

// Forme dans un repère [0,1] : épingle de carte (cercle + pointe) avec un trou.
// `scale` réduit la forme pour les icônes « maskable » (zone de sécurité).
function inPin(x, y, scale) {
  x = 0.5 + (x - 0.5) * 0.8 / scale;
  y = 0.5 + (y - 0.5) * 0.8 / scale;
  const cx = 0.5, cy = 0.4, r = 0.22;
  const dx = x - cx, dy = y - cy;
  const inCircle = dx * dx + dy * dy <= r * r;
  const tipY = cy + r * 1.9;
  const inTip = y >= cy && y <= tipY && Math.abs(dx) <= r * (tipY - y) / (tipY - cy) * 0.87;
  const hole = dx * dx + dy * dy <= (r * 0.42) ** 2;
  return (inCircle || inTip) && !hole;
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size, scale, rounded) {
  const SS = 4; // suréchantillonnage pour l'anticrénelage
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const radius = rounded ? size * 0.22 : 0;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let fg = 0, inside = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const px = x + (sx + 0.5) / SS, py = y + (sy + 0.5) / SS;
        const qx = Math.max(radius - px, px - (size - radius), 0);
        const qy = Math.max(radius - py, py - (size - radius), 0);
        if (radius && qx * qx + qy * qy > radius * radius) continue;
        inside++;
        if (inPin(px / size, py / size, scale)) fg++;
      }
      const t = inside ? fg / inside : 0;
      const o = y * (size * 4 + 1) + 1 + x * 4;
      for (let i = 0; i < 3; i++) raw[o + i] = Math.round(BG[i] * (1 - t) + FG[i] * t);
      raw[o + 3] = Math.round(255 * inside / (SS * SS));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(OUT, { recursive: true });
const icons = [
  ["icon-192.png", 192, 0.8, true],
  ["icon-512.png", 512, 0.8, true],
  ["maskable-512.png", 512, 0.6, false],
  ["apple-touch-icon.png", 180, 0.8, false], // iOS arrondit lui-même
  ["favicon-32.png", 32, 0.9, true],
];
for (const [name, size, scale, rounded] of icons) {
  fs.writeFileSync(path.join(OUT, name), png(size, scale, rounded));
  console.log("✓", name);
}
