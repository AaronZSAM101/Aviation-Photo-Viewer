// 走 UI 路径复现 parity 的 viewer 删除：记录每个 /api/stage* 请求与响应的顺序和结果
const WRITE = process.env.WRITE_BASE || 'http://10.88.1.240';
const puppeteer = await import('puppeteer-core').then((m) => m.default);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const wait = async (page, fn, timeout = 12000) => {
  const start = Date.now();
  for (;;) {
    const v = await page.evaluate(fn);
    if (v) return v;
    if (Date.now() - start > timeout) return null;
    await sleep(150);
  }
};

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/usr/lib/chromium/chromium',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  defaultViewport: { width: 1600, height: 1000 },
});
const page = await browser.newPage();
page.on('response', async (res) => {
  const url = res.url();
  if (!/\/api\/(stage|trash)/.test(url)) return;
  let body = '';
  try {
    body = (await res.text()).slice(0, 200);
  } catch {
    body = '<unreadable>';
  }
  console.log(`[${Date.now() - t0}ms] ${res.request().method()} ${url.replace(WRITE, '')} -> ${res.status()} ${body}`);
});
page.on('pageerror', (e) => console.log('pageerror:', String(e.message).slice(0, 160)));

const queue = () =>
  page.evaluate(() =>
    fetch('/api/stage/list').then((r) => r.json()).then((l) => l.map((o) => `${o.kind} ${o.src}${o.dst ? ` -> ${o.dst}` : ''}`)),
  );
const trash = () =>
  page.evaluate(() => fetch('/api/trash/list').then((r) => r.json()).then((l) => l.map((t) => `${t.name} <= ${t.original}`)));

const clickByText = async (selector, text) => {
  const found = await page.evaluate(
    (sel, txt) => {
      const btn = [...document.querySelectorAll(sel)].find((b) => b.textContent.replace(/\s+/g, '').includes(txt) && b.offsetParent !== null);
      if (!btn) return null;
      btn.click();
      return btn.textContent.trim();
    },
    selector,
    text,
  );
  console.log(`click ${selector} "${text}" -> ${JSON.stringify(found)}`);
  return found;
};

await page.goto(`${WRITE}/`, { waitUntil: 'domcontentloaded' });
await wait(page, () => document.querySelectorAll('.card').length > 0);
await page.evaluate(() => fetch('/api/stage/clear', { method: 'POST' }));

const victim = await page.evaluate(() =>
  fetch('/api/photos?sort=name-asc').then((r) => r.json()).then((l) => `${l[0].folder}/${l[0].filename}`),
);
console.log('victim:', victim);

await page.goto(`${WRITE}/view/${encodeURI(victim)}`, { waitUntil: 'domcontentloaded' });
await wait(page, () => {
  const v = document.getElementById('viewer');
  return !!v && v.classList.contains('show');
});
await wait(page, () => {
  const img = document.querySelector('#viewer img');
  return !!img && img.complete && img.naturalWidth > 0;
}, 8000);
await page.keyboard.press('d');
const pill = await wait(page, () => {
  const el = document.getElementById('v-staged-pill');
  return el && el.classList.contains('show') ? el.textContent.trim() : null;
}, 6000);
console.log('pill:', pill);
console.log('queue right after pill:', await queue());

await page.keyboard.press('Escape');
await wait(page, () => {
  const v = document.getElementById('viewer');
  return !v || !v.classList.contains('show');
}, 5000);
await sleep(400);

// parity 的 applyStaged：关闭弹窗 -> 打开分批弹窗 -> 点“应用”
await page.evaluate(() => {
  for (const b of document.querySelectorAll('.ant-modal-close')) b.click();
});
await sleep(300);
await clickByText('header button', '应用分批');
await wait(page, () => [...document.querySelectorAll('.ant-modal')].some((m) => m.offsetParent !== null && /分批操作/.test(m.textContent)), 6000);
console.log('modal content:', await page.evaluate(() => {
  const m = [...document.querySelectorAll('.ant-modal')].find((x) => x.offsetParent !== null);
  return m ? m.textContent.replace(/\s+/g, ' ').slice(0, 160) : null;
}));
await clickByText('.ant-modal button', '应用');
await sleep(2500);
console.log('queue after apply:', await queue());
console.log('trash after apply:', await trash());
console.log(
  'victim present:',
  await page.evaluate(
    (sp) => fetch('/api/photos?sort=name-asc').then((r) => r.json()).then((l) => l.some((x) => `${x.folder}/${x.filename}` === sp)),
    victim,
  ),
);
await browser.close();
