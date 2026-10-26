// 批1 UI 验证：应用分批遇到覆盖冲突时，界面要指出源与目标，并且操作仍留在队列里
const WRITE = process.env.WRITE_BASE || 'http://10.88.1.240';
const puppeteer = await import('puppeteer-core').then((m) => m.default);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function log(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` | ${detail}`}`);
}
const wait = async (page, fn, timeout = 15000) => {
  const start = Date.now();
  for (;;) {
    if (await page.evaluate(fn)) return true;
    if (Date.now() - start > timeout) return false;
    await sleep(200);
  }
};

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/usr/bin/chromium-browser',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  defaultViewport: { width: 1600, height: 1000 },
});
const page = await browser.newPage();

const api = (path, body) =>
  page.evaluate(
    async (p, b) => {
      const res = await fetch(p, {
        method: b ? 'POST' : 'GET',
        headers: { 'content-type': 'application/json' },
        body: b ? JSON.stringify(b) : undefined,
      });
      return { status: res.status, text: await res.text() };
    },
    path,
    body,
  );

const visibleModals = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.ant-modal')]
      .filter((m) => m.offsetParent !== null)
      .map((m) => m.textContent)
      .join(' | '),
  );

const clickButton = async (scope, needle) => {
  const found = await page.evaluate(
    (root, text) => {
      const scopeEl = root ? document.querySelector(root) : document;
      const btn = [...(scopeEl || document).querySelectorAll('button')].find(
        (b) => b.textContent.replace(/\s+/g, '').includes(text) && b.getClientRects().length > 0,
      );
      if (!btn) return false;
      btn.click();
      return true;
    },
    scope,
    needle,
  );
  if (!found) throw new Error(`button not found: ${needle}`);
  await sleep(400);
};

await page.goto(`${WRITE}/`, { waitUntil: 'domcontentloaded' });
await wait(page, () => document.querySelectorAll('.card').length > 0);
await api('/api/stage/clear', {});

const picked = await page.evaluate(async () => {
  const list = await fetch('/api/photos?sort=name-asc').then((r) => r.json());
  const folder = list.find((p) => p.folder);
  const sameFolder = list.filter((p) => p.folder === folder.folder);
  if (sameFolder.length < 2) return null;
  return {
    src: `${sameFolder[0].folder}/${sameFolder[0].filename}`,
    dst: `${sameFolder[1].folder}/${sameFolder[1].filename}`,
  };
});
log('two photos in one folder found', !!picked, JSON.stringify(picked));
if (!picked) {
  await browser.close();
  process.exit(1);
}

const staged = await api('/api/stage', { kind: 'move', src: picked.src, dst: picked.dst });
log('conflicting move staged', staged.status === 201, `${staged.status} ${staged.text}`);

await clickButton(null, '分批列表');
const listShown = await wait(page, () => {
  const text = [...document.querySelectorAll('.ant-modal')]
    .filter((m) => m.offsetParent !== null)
    .map((m) => m.textContent)
    .join('');
  return text.includes('分批操作') && text.includes('移动');
});
log('staged list shows the pending move', listShown, await visibleModals());

await clickButton('.ant-modal', '应用');
const warned = await wait(page, () => {
  const text = [...document.querySelectorAll('.ant-modal')]
    .filter((m) => m.offsetParent !== null)
    .map((m) => m.textContent)
    .join('');
  return text.includes('目标已存在') && text.includes('→');
}, 10000);
const modalText = await visibleModals();
log(
  'apply reports source and destination of the conflict',
  warned && modalText.includes(picked.src) && modalText.includes(picked.dst),
  modalText.slice(0, 300),
);

const stillQueued = await wait(page, () => {
  const root = [...document.querySelectorAll('.ant-modal')].find((m) => m.offsetParent !== null);
  const text = root ? root.textContent : '';
  return text.includes('分批操作') && text.includes('移动');
}, 8000);
log('the rejected op stays in the list', stillQueued, await visibleModals());

const onDisk = await page.evaluate(
  (sp) =>
    fetch('/api/photos?sort=name-asc')
      .then((r) => r.json())
      .then((l) => l.some((p) => `${p.folder}/${p.filename}` === sp)),
  picked.src,
);
log('nothing was overwritten', onDisk, `${picked.src} missing`);

await clickButton('.ant-modal', '删除');
const emptied = await wait(page, () => {
  const root = [...document.querySelectorAll('.ant-modal')].find((m) => m.offsetParent !== null);
  return root ? root.textContent.includes('没有分批操作') : false;
}, 8000);
log('queue can be cleaned from the same modal', emptied, await visibleModals());

await page.keyboard.press('Escape');
await api('/api/stage/clear', {});
await sleep(300);
const finalQueue = await api('/api/stage/list');
log('scratch queue left empty', finalQueue.text.trim() === '[]', finalQueue.text);

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} conflict-UI checks passed`);
process.exit(failed.length ? 1 : 0);
