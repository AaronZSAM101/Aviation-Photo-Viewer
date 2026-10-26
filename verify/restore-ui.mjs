// 回收站弹窗的“恢复”按钮是否真的把 restore 操作送进分批队列
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
  if (!/\/api\/(stage|trash)/.test(res.url())) return;
  let body = '';
  try {
    body = (await res.text()).slice(0, 220);
  } catch {
    body = '<unreadable>';
  }
  console.log(`[${Date.now() - t0}ms] ${res.request().method()} ${res.url().replace(WRITE, '')} -> ${res.status()} ${body}`);
});
page.on('console', (m) => m.type() === 'error' && console.log('console error:', m.text().slice(0, 160)));
page.on('pageerror', (e) => console.log('pageerror:', String(e.message).slice(0, 200)));

await page.goto(`${WRITE}/`, { waitUntil: 'domcontentloaded' });
await wait(page, () => document.querySelectorAll('.card').length > 0);

const before = await page.evaluate(() => fetch('/api/trash/list').then((r) => r.json()));
console.log('trash before:', JSON.stringify(before));
if (!before.length) throw new Error('nothing in trash to restore');

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

console.log('open trash ->', await clickText('header button', '回收站'));
const modal = await wait(page, () => {
  const m = [...document.querySelectorAll('.ant-modal')].find((x) => x.offsetParent !== null);
  return m && /恢复/.test(m.textContent) ? m.textContent.replace(/\s+/g, ' ').slice(0, 140) : null;
}, 8000);
console.log('trash modal:', modal);

console.log('click 恢复 ->', await clickText('.ant-modal button', '恢复'));
await sleep(1200);
console.log('queue after 恢复:', await page.evaluate(() => fetch('/api/stage/list').then((r) => r.json())));
console.log('messages:', await page.evaluate(() => [...document.querySelectorAll('.ant-message-notice')].map((n) => n.textContent).join(' | ')));
console.log('modal now:', await page.evaluate(() => {
  const m = [...document.querySelectorAll('.ant-modal')].find((x) => x.offsetParent !== null);
  return m ? m.textContent.replace(/\s+/g, ' ').slice(0, 140) : null;
}));
console.log('trash after 恢复:', await page.evaluate(() => fetch('/api/trash/list').then((r) => r.json())));
await browser.close();
