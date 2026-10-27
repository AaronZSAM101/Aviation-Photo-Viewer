// 页面内测量：勾选卡片 → React 提交耗时（去掉 CDP 输入开销）
import puppeteer from 'puppeteer-core';

const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const THROTTLE = Number(process.env.THROTTLE || 1);

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/usr/lib/chromium/chromium',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 852, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
const cdp = await page.createCDPSession();
await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
await page.setRequestInterception(true);
page.on('request', (req) => {
  if (req.url().includes('/thumb/')) void req.abort();
  else void req.continue();
});
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.querySelectorAll('.card').length > 0);
await page.waitForFunction(() => !document.querySelector('#loading.show'));
await new Promise((r) => setTimeout(r, 1500));

const result = await page.evaluate(async () => {
  const checks = [...document.querySelectorAll('.card .selchk')];
  const marks = [];
  for (let i = 0; i < 10; i += 1) {
    const input = checks[i * 2];
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const t0 = performance.now();
    input.click();
    const afterEvent = performance.now();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const afterPaint = performance.now();
    marks.push([Math.round(afterEvent - t0), Math.round(afterPaint - t0)]);
  }
  return marks;
});
const eventCost = result.map((x) => x[0]);
const paintCost = result.map((x) => x[1]);
const avg = (xs) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
console.log(
  JSON.stringify(
    {
      base: BASE,
      throttle: THROTTLE,
      eventAvg: avg(eventCost),
      eventMax: Math.max(...eventCost),
      paintAvg: avg(paintCost),
      paintMax: Math.max(...paintCost),
      marks: result,
    },
    null,
    2,
  ),
);
await browser.close();
