// 渲染/滚动性能探针：手机视口 + CPU 节流，量化首屏渲染阻塞与滚动掉帧
// 只读浏览，不改任何数据
import puppeteer from 'puppeteer-core';

const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const THROTTLE = Number(process.env.THROTTLE || 4);
const steps = Number(process.env.SCROLL_STEPS || 12);

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

// BLOCK_THUMBS=1：掐掉缩略图请求，隔离出纯 DOM/布局/滚动的开销
if (process.env.BLOCK_THUMBS) {
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.url().includes('/thumb/')) void req.abort();
    else void req.continue();
  });
}

const t0 = Date.now();
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });

await page.evaluate(() => {
  window.__lt = [];
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) window.__lt.push(Math.round(e.duration));
  }).observe({ entryTypes: ['longtask'] });
  window.__cls = 0;
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (!e.hadRecentInput) window.__cls += e.value;
    }
  }).observe({ entryTypes: ['layout-shift'] });
});

async function waitForCards() {
  const started = Date.now();
  const expect = Number(process.env.EXPECT_CARDS || 0);
  // 期望总数未知时：等卡片数量连续 1.2s 不再变化
  if (!expect) {
    let last = -1;
    let stableSince = Date.now();
    for (;;) {
      const n = await cardsInDom();
      if (n !== last) {
        last = n;
        stableSince = Date.now();
      } else if (Date.now() - stableSince > 1200) {
        return Date.now() - started;
      }
      if (Date.now() - started > 60000) return Date.now() - started;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  await page.waitForFunction(
    (n) => document.querySelectorAll('.card').length >= n,
    { timeout: 60000, polling: 150 },
    expect,
  );
  return Date.now() - started;
}
const cardsInDom = () => page.evaluate(() => document.querySelectorAll('.card').length);

// 先等列表接口回来（#loading 消失）
await page.waitForFunction(() => {
  const l = document.getElementById('loading');
  return !l || !l.classList.contains('show');
}, { timeout: 60000 });
const tList = Date.now() - t0;
const cardsAfterList = await cardsInDom();
const tAllCards = await waitForCards();

const renderMetrics = await page.evaluate(() => {
  const lt = window.__lt || [];
  const nav = performance.getEntriesByType('navigation')[0];
  const api = performance
    .getEntriesByType('resource')
    .filter((r) => r.name.includes('/api/photos'))
    .map((r) => Math.round(r.duration));
  return {
    nodes: document.getElementsByTagName('*').length,
    longTasks: lt.length,
    longTotal: lt.reduce((a, b) => a + b, 0),
    longMax: lt.length ? Math.max(...lt) : 0,
    domContentLoaded: Math.round(nav.domContentLoadedEventEnd),
    loadEvent: Math.round(nav.loadEventEnd),
    firstPaint: Math.round((performance.getEntriesByName('first-contentful-paint')[0] || {}).startTime || 0),
    apiMs: api,
  };
});

// 等首屏图片稳定下来，单独量“纯滚动”的开销
await new Promise((r) => setTimeout(r, 2500));
const beforeScrollLong = await page.evaluate(() => (window.__lt || []).length);

// 滚动 12 屏，记录掉帧
const scroll = await page.evaluate(async (steps, beforeLong) => {
  const frames = [];
  let last = performance.now();
  let stop = false;
  const tick = (now) => {
    frames.push(Math.round(now - last));
    last = now;
    if (!stop) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  for (let i = 0; i < steps; i += 1) {
    window.scrollBy(0, window.innerHeight);
    await new Promise((r) => setTimeout(r, 450));
  }
  stop = true;
  await new Promise((r) => setTimeout(r, 120));
  const lt = window.__lt || [];
  return {
    frames: frames.length,
    janky: frames.filter((f) => f > 50).length,
    worst: Math.max(...frames, 0),
    avg: Math.round(frames.reduce((a, b) => a + b, 0) / Math.max(frames.length, 1)),
    scrollY: Math.round(window.scrollY),
    longTasksDuringScroll: lt.length - beforeLong,
  };
}, steps, beforeScrollLong);

const finalCards = await cardsInDom();
const mem = await page.evaluate(() => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null));

const cls = await page.evaluate(() => Math.round(window.__cls * 1000) / 1000);

console.log(JSON.stringify({
  base: BASE,
  throttle: THROTTLE,
  listReadyMs: tList,
  cardsAfterList,
  allCardsMs: tAllCards,
  cardsInDom: finalCards,
  ...renderMetrics,
  scroll,
  heapMB: mem,
  cls,
}, null, 2));

await browser.close();
