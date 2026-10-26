// 生产实例冒烟检查：只读操作（浏览/查看器/搜索），不暂存、不应用、不改文件
const BASE = process.env.BASE || 'http://host.containers.internal:3000';
const puppeteer = await import('puppeteer-core').then((m) => m.default);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — ${String(detail).slice(0, 240)}`}`);
};

const consoleErrors = [];
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/usr/bin/chromium-browser',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  defaultViewport: { width: 1600, height: 1000 },
});
const page = await browser.newPage();
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(`console: ${m.text().slice(0, 160)}`);
});
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e.message).slice(0, 160)}`));

const waitFor = async (fn, timeout = 60000) => {
  try {
    await page.waitForFunction(fn, { timeout, polling: 250 });
    return true;
  } catch {
    return false;
  }
};

await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });

const config = await page.evaluate(() => fetch('/api/config').then((r) => r.json()));
check(
  'serves the delivered version',
  config.version === (process.env.EXPECT_VERSION || '2026-10-26-mobile5'),
  JSON.stringify(config),
);
check('production stays writable mode', config.readOnly === false, JSON.stringify(config));

const rendered = await waitFor(() => {
  const imgs = [...document.querySelectorAll('.card img')];
  return imgs.length > 0 && imgs.filter((i) => i.naturalWidth > 0).length >= 8;
});
const cards = await page.evaluate(() => document.querySelectorAll('.card').length);
check('gallery renders real thumbnails', rendered && cards > 0, `cards=${cards}`);

const labels = await page.$$eval('.toolbar button', (els) =>
  els.map((el) => el.textContent.replace(/\s+/g, ' ').trim()),
);
check(
  'toolbar has one staged entry and no duplicates',
  labels.filter((t) => t.includes('分批列表')).length === 1 && !labels.some((t) => t.includes('应用分批')),
  JSON.stringify(labels),
);

const queue = await page.evaluate(() => fetch('/api/stage/list').then((r) => r.json()));
check('the staged queue is empty', queue.length === 0, JSON.stringify(queue));

const trash = await page.evaluate(() => fetch('/api/trash/list').then((r) => r.json()));
check(
  'the trash manifest is readable with original paths',
  Array.isArray(trash) && trash.every((t) => typeof t.original === 'string' && t.original.length > 0),
  `items=${trash.length} first=${JSON.stringify(trash[0])}`,
);

const scan = await page.evaluate(async () => {
  const res = await fetch('/api/photos?sort=date-asc');
  const list = await res.json();
  return { count: list.length, errors: res.headers.get('x-scan-errors'), truncated: res.headers.get('x-scan-truncated') };
});
check('a full scan reports no errors', scan.errors === '0' && scan.truncated === '0', JSON.stringify(scan));

// 查看器：挑一张带 GPS 的照片，验证大图、EXIF 与在线图源请求
const gps = await page.evaluate(async () => {
  const list = await fetch('/api/photos?sort=date-desc').then((r) => r.json());
  const withGps = list.filter((p) => p.exif?.gps_lat != null && p.exif?.gps_lon != null);
  if (!withGps.length) return null;
  const p = withGps[0];
  return { sp: `${p.folder ? `${p.folder}/` : ''}${p.filename}`, count: withGps.length };
});
check('a GPS photo can be located', !!gps, JSON.stringify(gps));

if (gps) {
  await page.goto(`${BASE}/view/${encodeURI(gps.sp)}`, { waitUntil: 'domcontentloaded' });
  const opened = await waitFor(() => {
    const v = document.getElementById('viewer');
    const img = document.getElementById('v-img');
    return !!v && v.classList.contains('show') && !!img && img.naturalWidth > 0;
  });
  check('the deep link opens the viewer on the same photo', opened, gps.sp);
  const name = await page.evaluate(() => document.querySelector('#v-name')?.textContent || '');
  check('the viewer shows the requested file', name.includes(gps.sp.split('/').pop()), `${name} vs ${gps.sp}`);
  await sleep(2500);
  const tiles = await page.evaluate(() =>
    [...document.querySelectorAll('img')].filter((i) => /tile|osm|satellite|map/i.test(i.src)).length,
  );
  check('map tiles are reachable from the viewer', tiles > 0, `tileImgs=${tiles}`);
  await page.keyboard.press('Escape');
  await waitFor(() => document.querySelector('#viewer.show') === null);
}

// 只读语义：清空搜索后 URL 不带空白查询
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await waitFor(() => document.querySelectorAll('.card').length > 0);
await page.focus('input[placeholder="搜索照片..."]');
await page.keyboard.type('  ZSAM  ');
await sleep(900);
const q = await page.evaluate(() => new URLSearchParams(location.search).get('q'));
check('search writes the trimmed term to the URL', q === 'ZSAM', `q=${q}`);
const filtered = await page.evaluate(() => document.querySelectorAll('.card').length);
check('the trimmed term filters cards', filtered > 0 && filtered < cards, `filtered=${filtered} total=${cards}`);

const queueAfter = await page.evaluate(() => fetch('/api/stage/list').then((r) => r.json()));
check('the smoke run staged nothing', queueAfter.length === 0, JSON.stringify(queueAfter));

check('no console or page errors', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' | '));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} production smoke checks passed`);
await browser.close();
process.exit(failed.length ? 1 : 0);
