// 彩绘提醒（P2-3）契约 + UI 检查。
//
//   BASE=http://10.88.1.36 ./verify/livery.mjs
//
// 只在临时实例上跑，而且刻意不给 AIRFRAME_URL / LIVERY_FEED_URL：
// 排班数据源在别人家的机器上，验证套件不能依赖它在线、也不能替我们打下那个接口。
// 于是这里断言的是「没配数据源时接口和界面怎么说」，加上关注表的完整读写闭环。
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://10.88.1.36';
const RO_BASE = process.env.RO_BASE || '';
const OUT = process.env.OUT_DIR || '/work/out';
const REG = 'B-TEST01';

const results = [];
const consoleErrors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

function log(name, ok, detail = '') {
  const row = { name, ok: !!ok, detail: String(detail).slice(0, 220) };
  results.push(row);
  fs.appendFileSync(`${OUT}/progress.jsonl`, `${JSON.stringify(row)}\n`);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + String(detail).slice(0, 200) : ''}`);
}

async function step(name, fn) {
  console.log(`... ${name}`);
  try {
    await fn();
  } catch (error) {
    log(name, false, `threw: ${error.message}`);
  }
}

const api = async (path, options) => {
  const response = await fetch(`${BASE}${path}`, options);
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
};

const clickText = async (page, selector, text) => {
  const handle = await page.evaluateHandle(
    (sel, needle) => [...document.querySelectorAll(sel)].find((el) => el.textContent.trim().includes(needle)),
    selector,
    text,
  );
  const element = handle.asElement();
  if (!element) throw new Error(`找不到 ${selector} 里的「${text}」`);
  await element.click();
  return true;
};

const typeInto = async (page, placeholderPrefix, value) => {
  const selector = `input[placeholder^="${placeholderPrefix}"]`;
  await page.waitForSelector(selector, { visible: true, timeout: 8000 });
  await page.click(selector, { clickCount: 3 });
  await page.type(selector, value);
};

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/usr/bin/chromium-browser',
  protocolTimeout: 300000,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--window-size=1500,1000'],
});
const page = await browser.newPage();
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(`console: ${m.text().slice(0, 160)}`);
});
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e.message).slice(0, 160)}`));
await page.setViewport({ width: 1500, height: 1000 });

await step('config says whether a feed source is wired up', async () => {
  const { status, body } = await api('/api/config');
  log(
    'config exposes liveryConfigured',
    status === 200 && typeof body?.liveryConfigured === 'boolean' && body.liveryConfigured === false,
    `${status} liveryConfigured=${body?.liveryConfigured}`,
  );
});

await step('watch list starts empty and reports the feed flag', async () => {
  const { status, body } = await api('/api/livery/watch');
  log(
    'watch list contract',
    status === 200 && Array.isArray(body?.items) && body.feedConfigured === false,
    `${status} items=${body?.items?.length} feedConfigured=${body?.feedConfigured}`,
  );
});

await step('feed answers without touching the network when unconfigured', async () => {
  const day = new Date().toISOString().slice(0, 10);
  const { status, body } = await api(`/api/livery/feed?airport=SZX&day=${day}`);
  const camel = body && 'totalFlights' in body && 'feedSource' in body && 'retrievedAt' in body;
  log(
    'feed is unconfigured, not a crash',
    status === 200 && body?.state === 'unconfigured' && Array.isArray(body?.alerts) && camel,
    `${status} state=${body?.state} keys=${camel ? 'camelCase' : JSON.stringify(Object.keys(body || {}))}`,
  );
});

await step('airport and day inputs are fenced before any URL is built', async () => {
  const bad = [
    `/api/livery/feed?airport=${encodeURIComponent("../../etc")}&day=2026-10-27`,
    `/api/livery/feed?airport=${encodeURIComponent("SZX?x=1")}&day=2026-10-27`,
    `/api/livery/feed?airport=SZX&day=${encodeURIComponent('2026-10-27" OR 1=1')}`,
    `/api/livery/feed?airport=SZX`,
  ];
  const codes = [];
  for (const path of bad.slice(0, 3)) codes.push((await api(path)).status);
  const missingAirport = await api(bad[3]);
  log(
    'hostile airport/day rejected with 400',
    codes.every((code) => code === 400),
    codes.join(','),
  );
  log('airport is required', missingAirport.status === 400, `${missingAirport.status}`);
});

await step('watch list round-trips through the UI', async () => {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.app-header', { timeout: 20000 });
  // 顶栏遮罩退场后再点，否则坐标点到的是 #loading 那一层
  await page.waitForFunction(() => {
    const mask = document.querySelector('#loading');
    return !mask || getComputedStyle(mask).display === 'none';
  }, { timeout: 20000 });
  await sleep(400);

  await clickText(page, 'button', '彩绘提醒');
  // 顶栏按钮本身就叫「彩绘提醒」，只等文案会假通过——要等模态框里的状态行
  await page.waitForSelector('.livery-modal .livery-status', { visible: true, timeout: 8000 });
  log('header opens the reminder modal', true);

  const statusLine = await page.evaluate(
    () => document.querySelector('.livery-status')?.textContent?.trim() ?? '',
  );
  log(
    'modal states the feed source is not configured',
    /没配|没有配置/.test(statusLine),
    statusLine.slice(0, 120),
  );

  await clickText(page, 'button', '记一台');
  await typeInto(page, '机号', REG);
  await typeInto(page, '名字', '套件测试机');
  await clickText(page, 'button', '保存');
  await page.waitForFunction(
    (reg) => [...document.querySelectorAll('.livery-watch-reg')].some((el) => el.textContent.trim() === reg),
    { timeout: 10000, polling: 300 },
    REG,
  );
  log('saving a registration shows up in the watch list', true);
  await page.screenshot({ path: `${OUT}/livery-watch-saved.png` }).catch(() => {});

  const listed = await api('/api/livery/watch');
  const item = listed.body?.items?.find((row) => row.registration === REG);
  log(
    'watch list persisted on the server',
    !!item && item.name === '套件测试机' && item.documented === true,
    JSON.stringify(listed.body?.items),
  );

  // 点机号跳相册搜索：这是「提醒→相册」唯一的深链入口
  await clickText(page, 'button.livery-watch-reg', REG);
  await sleep(1200);
  const searchValue = await page.evaluate(() => {
    const input = document.querySelector('.toolbar-search input') || document.querySelector('input[placeholder*="搜索"]');
    return input ? input.value : null;
  });
  log(
    'clicking a watched registration fills the album search',
    searchValue === REG && page.url().includes(encodeURIComponent(REG)),
    `search="${searchValue}" url=${page.url()}`,
  );

  const del = await page.evaluate(
    (reg) => {
      const row = [...document.querySelectorAll('.livery-watch-row')].find((el) =>
        el.textContent.includes(reg),
      );
      const button = [...(row?.querySelectorAll('button') || [])].find((b) => b.textContent.trim() === '删');
      if (button) button.click();
      return !!button;
    },
    REG,
  );
  await sleep(1200);
  const after = await api('/api/livery/watch');
  log(
    'deleting removes it from the server too',
    del && !after.body?.items?.some((row) => row.registration === REG),
    `clicked=${del} items=${JSON.stringify(after.body?.items)}`,
  );

  await page.keyboard.press('Escape');
  await sleep(300);
});

await step('reminder entry survives the phone viewport', async () => {
  await page.setViewport({ width: 393, height: 852, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.app-header-compact', { timeout: 20000 });
  await clickText(page, 'button.toolbar-more', '更多');
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.ant-dropdown-menu-item')].some((item) =>
        item.textContent.includes('彩绘提醒'),
      ),
    { timeout: 8000 },
  );
  log('compact header keeps the reminder entry in 更多', true);
  await page.screenshot({ path: `${OUT}/livery-mobile-menu.png` }).catch(() => {});
});

if (RO_BASE) {
  await step('read-only instance refuses writes', async () => {
    const response = await fetch(`${RO_BASE}/api/livery/watch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ registration: REG, name: '不该被记下' }),
    });
    log('read-only refuses to save a watch item', response.status === 403, `${response.status}`);
  });
}

console.log('\n===== SUMMARY =====');
const failed = results.filter((r) => !r.ok);
console.log(`total=${results.length} pass=${results.length - failed.length} fail=${failed.length}`);
failed.forEach((f) => console.log(`FAILED: ${f.name} | ${f.detail}`));
console.log('console/page errors:', consoleErrors.length ? consoleErrors.slice(0, 8) : 'none');
fs.writeFileSync(`${OUT}/livery-report.json`, JSON.stringify({ results, consoleErrors }, null, 2));
await browser.close();
