// One-off icon generator for the Bluebell Attendance app.
// Builds the Android adaptive icon set + iOS/legacy icon + splash + favicon
// from the school crest (bluebellschool/public/logo.png). Run: `node scripts/gen-icons.js`
// Uses only pngjs (already present in node_modules). Safe to delete after use.
const fs = require("fs");
const path = require("path");
const { PNG } = require("pngjs");

const SRC = "C:/Users/Black-Box/Documents/builds/bluebellschool/public/logo.png";
const OUT = path.join(__dirname, "..", "assets");

const WHITE_T = 236; // near-white threshold -> becomes transparent in the cutout

// ---- load + build a tight "crest" sprite with white knocked out to alpha ----
const src = PNG.sync.read(fs.readFileSync(SRC));
const W = src.width, H = src.height;
const cut = new PNG({ width: W, height: H });
for (let i = 0; i < W * H; i++) {
  const r = src.data[i * 4], g = src.data[i * 4 + 1], b = src.data[i * 4 + 2], a = src.data[i * 4 + 3];
  const nearWhite = r > WHITE_T && g > WHITE_T && b > WHITE_T;
  cut.data[i * 4] = r; cut.data[i * 4 + 1] = g; cut.data[i * 4 + 2] = b;
  cut.data[i * 4 + 3] = (a < 10 || nearWhite) ? 0 : a;
}
// bounding box of visible pixels
let minX = W, minY = H, maxX = 0, maxY = 0, found = false;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  if (cut.data[(W * y + x) * 4 + 3] > 10) { found = true; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
}
if (!found) { minX = 0; minY = 0; maxX = W - 1; maxY = H - 1; }
const cropW = maxX - minX + 1, cropH = maxY - minY + 1;
const crest = new PNG({ width: cropW, height: cropH });
for (let y = 0; y < cropH; y++) for (let x = 0; x < cropW; x++) {
  const si = (W * (minY + y) + (minX + x)) * 4, di = (cropW * y + x) * 4;
  crest.data[di] = cut.data[si]; crest.data[di + 1] = cut.data[si + 1]; crest.data[di + 2] = cut.data[si + 2]; crest.data[di + 3] = cut.data[si + 3];
}

// ---- compositor: draw `sprite` scaled to `frac` of the square canvas, centered ----
function render(size, sprite, frac, bg) {
  const canvas = new PNG({ width: size, height: size });
  for (let i = 0; i < size * size; i++) {
    canvas.data[i * 4] = bg[0]; canvas.data[i * 4 + 1] = bg[1]; canvas.data[i * 4 + 2] = bg[2]; canvas.data[i * 4 + 3] = bg[3];
  }
  const sw = Math.round(size * frac), sh = Math.round(size * frac * (sprite.height / sprite.width));
  const scale = sw / sprite.width;
  const offX = Math.round((size - sw) / 2), offY = Math.round((size - sh) / 2);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const sx = Math.min(sprite.width - 1, Math.floor(x / scale));
    const sy = Math.min(sprite.height - 1, Math.floor(y / scale));
    const si = (sprite.width * sy + sx) * 4, a = sprite.data[si + 3];
    if (a === 0) continue;
    const dx = offX + x, dy = offY + y;
    if (dx < 0 || dy < 0 || dx >= size || dy >= size) continue;
    const di = (size * dy + dx) * 4;
    const na = a / 255, da = canvas.data[di + 3] / 255, oa = na + da * (1 - na);
    canvas.data[di] = Math.round((sprite.data[si] * na + canvas.data[di] * da * (1 - na)) / (oa || 1));
    canvas.data[di + 1] = Math.round((sprite.data[si + 1] * na + canvas.data[di + 1] * da * (1 - na)) / (oa || 1));
    canvas.data[di + 2] = Math.round((sprite.data[si + 2] * na + canvas.data[di + 2] * da * (1 - na)) / (oa || 1));
    canvas.data[di + 3] = Math.round(oa * 255);
  }
  return PNG.sync.write(canvas);
}

// monochrome silhouette: keep crest alpha, force RGB black
const mono = new PNG({ width: crest.width, height: crest.height });
for (let i = 0; i < crest.width * crest.height; i++) {
  mono.data[i * 4] = 0; mono.data[i * 4 + 1] = 0; mono.data[i * 4 + 2] = 0; mono.data[i * 4 + 3] = crest.data[i * 4 + 3];
}

const TRANSPARENT = [0, 0, 0, 0];
const WHITE = [255, 255, 255, 255];

fs.writeFileSync(path.join(OUT, "icon.png"), render(1024, crest, 0.80, WHITE));                 // iOS / legacy (opaque)
fs.writeFileSync(path.join(OUT, "splash-icon.png"), render(1024, crest, 0.55, TRANSPARENT));     // splash
fs.writeFileSync(path.join(OUT, "android-icon-foreground.png"), render(432, crest, 0.60, TRANSPARENT)); // adaptive fg (safe zone)
fs.writeFileSync(path.join(OUT, "android-icon-background.png"), render(432, crest, 0, WHITE));   // adaptive bg (solid white)
fs.writeFileSync(path.join(OUT, "android-icon-monochrome.png"), render(432, mono, 0.60, TRANSPARENT)); // themed icon
fs.writeFileSync(path.join(OUT, "favicon.png"), render(64, crest, 0.92, WHITE));                  // web favicon

console.log("Generated icon set from crest", crest.width + "x" + crest.height);
