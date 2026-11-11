// Génère les icônes PWA (PNG) à partir des SVG sources de public/icons/.
// Usage : npm run icons
import sharp from "sharp";
import { mkdir } from "node:fs/promises";

const SRC = "public/icons";
const targets = [
  // [source SVG, sortie, taille]
  ["icon.svg", "icon-192.png", 192],          // manifest "any"
  ["icon.svg", "icon-512.png", 512],          // manifest "any"
  ["maskable.svg", "maskable-192.png", 192],  // manifest "maskable" (Android adaptive)
  ["maskable.svg", "maskable-512.png", 512],
  ["maskable.svg", "apple-touch-icon.png", 180], // iOS : carré plein, iOS arrondit lui-même
  ["icon.svg", "favicon-32.png", 32],
];

await mkdir(SRC, { recursive: true });
for (const [src, out, size] of targets) {
  await sharp(`${SRC}/${src}`, { density: Math.ceil((72 * size) / 512) * 2 })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toFile(`${SRC}/${out}`);
  console.log(`✓ ${out} (${size}×${size})`);
}
