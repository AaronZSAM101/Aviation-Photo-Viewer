// 恢复操作在界面上点“应用”之后到底返回了什么
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
  if (!/\/api\/(stage|trash|photos)/.test(res.url())) return;
  let body = '';
  try {
    body = (await res.text()).slice(0, 260);
  } catch {
    body = '<unreadable>';
  }
  console.log(`[${Date.now() - t0}ms] ${res.request().method()} ${res.url().replace(WRITE, '')} -> ${res.status()} ${body}`);
});
page.on('console', (m) => m.type() === 'error' && console.log('console error:', m.text().slice(0, 160)));
page.on('pageerror', (e) => console.log('pageerror:', String(e.message).slice(0, 200)));

const clickText = (sel, text) =>
  page.evaluate(
    (root, txt) => {
      const b = [...document.querySelectorAll(root)].find(
        (x) => x.textContent.replace(/\s+/g, '').includes(txt) && x.offsetParent !== null,
      );
      if (!b) return null;
      b.click();
      return b.textContent.trim().slice(0, 40);
    },
    sel,
    text,
  );

await page.goto(`${WRITE}/`, { waitUntil: 'domcontentloaded' });
await wait(page, () => document.querySelectorAll('.card').length > 0);

let queue = await page.evaluate(() => fetch('/api/stage/list').then((r) => r.json()));
console.log('queue at start:', JSON.stringify(queue));
if (!queue.length) {
  const tr = await page.evaluate(() => fetch('/api/trash/list').then((r) => r.json()));
  if (!tr.length) throw new Error('no trash entry and no queued restore');
  console.log('staging restore for', tr[0].original);
  console.log(
    'stage ->',
    JSON.stringify(
      await page.evaluate(
        (item) =>
          fetch('/api/stage', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ kind: 'restore', src: `.trash/${item.name}`, dst: item.original }),
          }).then(async (r) => `${r.status} ${await r.text()}`),
        tr[0],
      ),
    ),
  );
}
const target = (await page.evaluate(() => fetch('/api/stage/list').then((r) => r.json()))).find((o) => o.kind === 'restore');
console.log('restore target:', JSON.stringify(target));

// parity 的 applyStaged
console.log('open 应用分批 ->', await clickText('header button', '应用分批'));
await wait(page, () => [...document.querySelectorAll('.ant-modal')].some((m) => m.offsetParent !== null && /分批操作/.test(m.textContent)), 8000);
console.log('modal:', await page.evaluate(() => {
  const m = [...document.querySelectorAll('.ant-modal')].find((x) => x.offsetParent !== null);
  return m ? m.textContent.replace(/\s+/g, ' ').slice(0, 160) : null;
}));
console.log('click 应用 ->', await clickText('.ant-modal button', '应用'));
await sleep(2500);
console.log('toasts:', await page.evaluate(() => [...document.querySelectorAll('.ant-message-notice')].map((n) => n.textContent).join(' | ')));
console.log('queue after apply:', JSON.stringify(await page.evaluate(() => fetch('/api/stage/list').then((r) => r.json()))));
console.log('trash after apply:', JSON.stringify(await page.evaluate(() => fetch('/api/trash/list').then((r) => r.json()))));
const present = await page.evaluate(
  (sp) =>
    fetch('/api/photos?sort=name-asc').then((r) => r.json()).then((l) => ({
      listed: l.some((p) => `${p.folder}/${p.filename}` === sp),
      count: l.length,
    })),
  target.dst,
);
console.log('dst', target.dst, '->', JSON.stringify(present));

await browser.close();
