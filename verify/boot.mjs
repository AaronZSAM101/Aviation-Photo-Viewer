import puppeteer from 'puppeteer-core';

const BASES = (process.env.BASES || '').split(',').filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/usr/lib/chromium/chromium',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  defaultViewport: { width: 1600, height: 1000 },
});

for (const base of BASES) {
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 120)));
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 120)));
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  const cards = await page
    .waitForFunction(() => document.querySelectorAll('.card').length > 3, { timeout: 30000 })
    .then(() => page.evaluate(() => document.querySelectorAll('.card').length))
    .catch(() => 0);
  const first = await page.evaluate(() => document.querySelector('.card')?.getAttribute('data-sp') || null);
  let viewer = false;
  let modal = false;
  if (first) {
    await page.goto(`${base}/view/${encodeURI(first)}`, { waitUntil: 'domcontentloaded' });
    viewer = await page
      .waitForFunction(() => {
        const v = document.getElementById('viewer');
        return !!v && v.classList.contains('show');
      }, { timeout: 20000 })
      .then(() => true)
      .catch(() => false);
    await page.keyboard.press('Escape');
    await sleep(500);
    await page.keyboard.press('F1');
    modal = await page
      .waitForFunction(
        () => [...document.querySelectorAll('.ant-modal')].some((m) => m.offsetParent !== null),
        { timeout: 8000 },
      )
      .then(() => true)
      .catch(() => false);
  }
  out.push({ base, cards, viewer, modal, errors: errors.slice(0, 4) });
  await page.close();
}

await browser.close();
console.log(JSON.stringify(out, null, 1));
