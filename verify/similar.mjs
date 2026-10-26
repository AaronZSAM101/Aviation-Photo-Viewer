import puppeteer from 'puppeteer-core';

const BASE = process.env.BASE || 'http://10.88.1.211';
const OUT = process.env.OUT_DIR || '/work/out';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/usr/lib/chromium/chromium',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  defaultViewport: { width: 1600, height: 1000 },
});
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 160)));
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 160)));

const poll = async (fn, timeout = 30000, every = 400) => {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) return null;
    await sleep(every);
  }
};

const modalText = () =>
  poll(async () => {
    const t = await page.evaluate(() => {
      const m = [...document.querySelectorAll('.ant-modal')].find((x) => x.offsetParent !== null);
      return m ? m.textContent.replace(/\s+/g, ' ').trim() : null;
    });
    return t && /相似照片对比/.test(t) ? t : null;
  }, 15000);

const clickInModal = (needle) =>
  page.evaluate((want) => {
    const m = [...document.querySelectorAll('.ant-modal')].find((x) => x.offsetParent !== null);
    if (!m) return false;
    const b = [...m.querySelectorAll('button')].find(
      (x) => x.textContent.replace(/\s+/g, '').includes(want.replace(/\s+/g, '')) && x.getClientRects().length,
    );
    if (!b) return false;
    b.click();
    return true;
  }, needle);

await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
const cards = await poll(
  () => page.evaluate(() => document.querySelectorAll('.card').length || null),
  30000,
);
console.log('cards rendered:', cards);

// #loading 是整屏遮罩，列表到达后 300ms 才隐藏。不等它退下去就点，点的是遮罩，
// 模态框根本不会开 —— 套件里跑到第 5 个、机器正忙时就是这么偶发的。
await poll(
  () =>
    page.evaluate(() => {
      const l = document.getElementById('loading');
      return !l || !l.classList.contains('show');
    }),
  15000,
);

const clickCompare = () =>
  page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(
      (x) => x.textContent.replace(/\s+/g, '').includes('相似对比'),
    );
    if (!b) return false;
    b.click();
    return true;
  });

if (!(await clickCompare())) throw new Error('相似对比 button missing');
let opened = await modalText();
if (!opened) {
  // 机器很忙时监听器可能还没挂上，再点一次
  await sleep(2000);
  await clickCompare();
  opened = await modalText();
}
console.log('compare modal opened:', !!opened);

const clickedScan = await clickInModal('扫描当前目录');
console.log('scan clicked:', clickedScan);

const done = await poll(async () => {
  // 进度行（"已处理 … 已找到 0 组"）里也有"找到 N 组"，整块 modal 文本里正则蒙会把
  // 扫描中当成扫完。按元素取：结果行是 .compare-scan-head 且以"扫描 N 张"开头。
  const t = await page.evaluate(() => {
    const m = [...document.querySelectorAll('.ant-modal')].find((x) => x.offsetParent !== null);
    if (!m) return null;
    const head = (m.querySelector('.compare-scan-head')?.textContent || '').trim();
    const status = (m.querySelector('.compare-status')?.textContent || '').trim();
    const text = `${head} ${status}`.replace(/\s+/g, ' ').trim();
    return /^(扫描 \d+ 张|没有找到符合阈值|扫描失败)/.test(text) ? text : null;
  });
  return t;
}, 60000);

const summary = done ? String(done).slice(0, 260) : null;
await page.screenshot({ path: `${OUT}/16-similar-scan.png` }).catch(() => {});

// 样本库里一定有 4 对一模一样的副本，所以"找到 N 组"必须出现且 N >= 4；
// 只断言"有结果"会让扫描静默返回空也算通过。
const groups = summary ? Number((summary.match(/找到\s*(\d+)\s*组/) || [])[1] ?? -1) : -1;
const ok = groups >= 4 && errors.length === 0;
console.log('scan result text:', summary);
console.log('console/page errors:', errors.length ? errors.slice(0, 5) : 'none');
console.log(`${ok ? 'PASS' : 'FAIL'} similar scan surfaces seeded duplicates [${groups} 组]`);
console.log('SIMILAR_SCAN_' + (ok ? 'OK' : 'FAIL'));
if (!ok) process.exitCode = 1;

await browser.close();
