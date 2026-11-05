// Renders public/logo-mark.svg into PNG icons (needs Playwright's Chromium: npx playwright install chromium).
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url)); const svg = readFileSync(join(root, 'public/logo-mark.svg'), 'utf8');
const browser = await chromium.launch();
for (const [file, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180], ['favicon-32.png', 32]]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  await page.screenshot({ path: join(root, 'public', file), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } }); await page.close();
}
await browser.close(); console.log('icons written to public/');
