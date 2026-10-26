// 交互性能探针：勾选卡片 / 查看器翻页时，整页 2939 张卡重渲染的代价
// 只读浏览，不改任何数据（勾选只是前端状态）
import puppeteer from 'puppeteer-core';

const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const THROTTLE = Number(process.env.THROTTLE || 4);

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/usr/lib/chromium/chromium',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 852, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
await page.setUserAgent(
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
);
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
await page.waitForFunction((n) => document.querySelectorAll('.card').length >= n, { timeout: 120000 }, 2939);
await new Promise((r) => setTimeout(r, 1500));

await page.evaluate(() => {
  window.__lt = [];
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) window.__lt.push(Math.round(e.duration));
  }).observe({ entryTypes: ['longtask'] });
});

const takeLong = () => page.evaluate(() => window.__lt.splice(0));

async function clicks() {
  const checks = await page.$$('.card .selchk');
  const samples = [];
  for (let i = 0; i < 10; i += 1) {
    const t0 = Date.now();
    await checks[i * 2].click();
    samples.push(Date.now() - t0);
    await new Promise((r) => setTimeout(r, 250));
  }
  return samples;
}

async function viewerNav() {
  await page.click('.card');
  await new Promise((r) => setTimeout(r, 800));
  const samples = [];
  for (let i = 0; i < 10; i += 1) {
    const t0 = Date.now();
    await page.keyboard.press('ArrowRight');
    samples.push(Date.now() - t0);
    await new Promise((r) => setTimeout(r, 300));
  }
  await page.keyboard.press('Escape');
  return samples;
}

const stat = (xs) => ({
  avg: Math.round(xs.reduce((a, b) => a + b, 0) / xs.length),
  max: Math.max(...xs),
});

await takeLong();
const clickSamples = await clicks();
const clickLong = await takeLong();
await new Promise((r) => setTimeout(r, 500));
const navSamples = await viewerNav();
const navLong = await takeLong();

console.log(
  JSON.stringify(
    {
      base: BASE,
      throttle: THROTTLE,
      click: { ...stat(clickSamples), samples: clickSamples, longTasks: clickLong },
      viewerNav: { ...stat(navSamples), samples: navSamples, longTasks: navLong },
    },
    null,
    2,
  ),
);
await browser.close();
