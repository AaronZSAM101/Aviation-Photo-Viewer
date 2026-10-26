// 复现 parity 的 viewer 删除流程，逐步打印队列/回收站状态
const WRITE = process.env.WRITE_BASE || 'http://10.88.1.240';
const puppeteer = await import('puppeteer-core').then((m) => m.default);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = async (page, fn, timeout = 12000) => {
  const start = Date.now();
  for (;;) {
    const v = await page.evaluate(fn);
    if (v) return v;
    if (Date.now() - start > timeout) return null;
    await sleep(200);
  }
};

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/usr/lib/chromium/chromium',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  defaultViewport: { width: 1600, height: 1000 },
});
const page = await browser.newPage();
page.on('console', (m) => {
  if (m.type() === 'error') console.log('console error:', m.text().slice(0, 160));
});
page.on('pageerror', (e) => console.log('pageerror:', String(e.message).slice(0, 160)));

const dump = (label, value) => console.log(`${label}: ${JSON.stringify(value)}`);
const queue = () =>
  page.evaluate(() => fetch('/api/stage/list').then((r) => r.json()).then((l) => l.map((o) => `${o.kind} ${o.src}${o.dst ? ` -> ${o.dst}` : ''}`)));
const trash = () =>
  page.evaluate(() => fetch('/api/trash/list').then((r) => r.json()).then((l) => l.map((t) => `${t.name} <= ${t.original}`)));
const has = (sp) =>
  page.evaluate(
    (p) => fetch('/api/photos?sort=name-asc').then((r) => r.json()).then((l) => l.some((x) => `${x.folder}/${x.filename}` === p)),
    sp,
  );

await page.goto(`${WRITE}/`, { waitUntil: 'domcontentloaded' });
await wait(page, () => document.querySelectorAll('.card').length > 0);
await page.evaluate(() => fetch('/api/stage/clear', { method: 'POST' }));

const victim = await page.evaluate(() =>
  fetch('/api/photos?sort=name-asc').then((r) => r.json()).then((l) => {
    const p = l.find((x) => x.folder === 'Alpha' && /_RENAMED\.jpg$/.test(x.filename)) || l[0];
    return `${p.folder}/${p.filename}`;
  }),
);
dump('victim', victim);

await page.goto(`${WRITE}/view/${encodeURI(victim)}`, { waitUntil: 'domcontentloaded' });
await wait(page, () => {
  const v = document.getElementById('viewer');
  return !!v && v.classList.contains('show');
});
await sleep(600);
await page.keyboard.press('d');
const pill = await wait(page, () => {
  const el = document.getElementById('v-staged-pill');
  return el && el.classList.contains('show') ? el.textContent.trim() : null;
}, 6000);
dump('pill after d', pill);
dump('queue after d', await queue());

await page.keyboard.press('Escape');
await sleep(500);

// 打开分批弹窗并点击应用，同时抓 HTTP 响应
const applyResponse = page.evaluate(async () => {
  const res = await fetch('/api/stage/apply', { method: 'POST' });
  return { status: res.status, body: await res.text() };
});
const applied = await applyResponse;
dump('apply response', applied);
dump('queue after apply', await queue());
dump('trash after apply', await trash());
dump('victim still listed', await has(victim));

await browser.close();
