import sharp from 'sharp';

// Both frames: 2400x1520 (1200x760 viewport at dpr 2).
const region = { left: 800, top: 1180, width: 1500, height: 300 };

async function crop(src, out) {
  const buf = await sharp(src).extract(region).resize({ width: 1500 }).png().toBuffer();
  await sharp(buf).toFile(out);
  console.log('wrote', out);
}

await crop('qa/composer-context.png', 'qa/composer-before-crop.png');
await crop('qa/composer-after.png', 'qa/composer-after-crop.png');

// Stacked comparison with labels.
const label = (text) => Buffer.from(
  `<svg width="1500" height="34"><text x="12" y="24" font-family="Segoe UI, sans-serif" font-size="19" fill="#a3a7a4">${text}</text></svg>`,
);
const before = await sharp('qa/composer-before-crop.png').toBuffer();
const after = await sharp('qa/composer-after-crop.png').toBuffer();
const meta = await sharp(after).metadata();
const gap = 24;
await sharp({
  create: { width: meta.width, height: 34 + meta.height + gap + 34 + meta.height, channels: 3, background: '#1b1d1d' },
})
  .composite([
    { input: label('之前 · 24px 圆角 · 86px 高'), top: 0, left: 0 },
    { input: before, top: 34, left: 0 },
    { input: label('之后 · 16px 圆角 · 94px 高'), top: 34 + meta.height + gap, left: 0 },
    { input: after, top: 34 + meta.height + gap + 34, left: 0 },
  ])
  .png()
  .toFile('qa/composer-compare.png');
console.log('wrote qa/composer-compare.png');
