// 批4 UI 验证：顶栏整理、搜索去空白、查看器身份/按键作用域、只读刷新、扫描告警
const WRITE = process.env.WRITE_BASE || 'http://10.88.1.240';
const READ = process.env.READ_BASE || '';
const SCAN = process.env.SCAN_BASE || '';
const puppeteer = await import('puppeteer-core').then((m) => m.default);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: detail || '' });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — ${String(detail).slice(0, 300)}`}`);
}

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/usr/bin/chromium-browser',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  defaultViewport: { width: 1600, height: 1000 },
});

async function newPage() {
  const page = await browser.newPage();
  page.on('pageerror', (error) => console.log(`pageerror: ${error.message}`));
  return page;
}

async function waitFor(page, fn, timeout = 20000) {
  await page.waitForFunction(fn, { timeout, polling: 100 });
}

const api = (page, path, body) =>
  page.evaluate(
    async (url, data) => {
      const res = await fetch(url, {
        method: data ? 'POST' : 'GET',
        headers: { 'content-type': 'application/json' },
        body: data ? JSON.stringify(data) : undefined,
      });
      return { status: res.status, text: await res.text() };
    },
    path,
    body,
  );

const stagedKinds = async (page) => {
  const res = await api(page, '/api/stage/list');
  return JSON.parse(res.text);
};

const cardCount = (page) => page.$$eval('.card', (els) => els.length);
const toolbarButtons = (page) =>
  page.$$eval('.toolbar button', (els) =>
    els.map((el) => el.textContent.replace(/\s+/g, ' ').trim()),
  );
const urlState = (page) =>
  page.evaluate(() => ({
    path: location.pathname,
    q: new URLSearchParams(location.search).get('q'),
  }));

const page = await newPage();

// ── 1. 顶栏：合并重复入口，顺序按“浏览 → 管理 → 工具” ──────────────────────
await page.goto(WRITE, { waitUntil: 'networkidle2' });
await waitFor(page, () => document.querySelectorAll('.card').length === 9);

let labels = await toolbarButtons(page);
check(
  'the duplicated apply/list entry is gone',
  labels.filter((text) => text.includes('分批列表')).length === 1 &&
    !labels.some((text) => text.includes('应用分批')),
  JSON.stringify(labels),
);
const order = ['刷新', '批量移动', '批量删除', '分批列表', '回收站', '相似对比', '目录', '快捷键'];
const positions = order.map((word) => labels.findIndex((text) => text.includes(word)));
check(
  'toolbar order is stable and grouped',
  positions.every((pos, i) => pos >= 0 && (i === 0 || pos > positions[i - 1])),
  `${JSON.stringify(labels)} | ${JSON.stringify(positions)}`,
);
const searchFirst = await page.evaluate(() => {
  const toolbar = document.querySelector('.toolbar');
  const children = [...(toolbar?.children ?? [])];
  const search = toolbar?.querySelector('.toolbar-search');
  const collapse = children.find((el) => el.tagName === 'BUTTON' && /折叠全部/.test(el.textContent));
  return !!(search && collapse && children.indexOf(search) < children.indexOf(collapse));
});
check('search sits next to refresh, before collapse', searchFirst, '');

// ── 2. 分批数量显示 ────────────────────────────────────────────────────────
await api(page, '/api/stage', { kind: 'delete', src: 'ParitySeed/P1.jpg' });
const clickRefresh = () =>
  page.evaluate(() => {
    const button = [...document.querySelectorAll('.toolbar button')].find((b) =>
      b.textContent.includes('刷新'),
    );
    button?.click();
  });
await clickRefresh();
await waitFor(
  page,
  () =>
    [...document.querySelectorAll('.toolbar button')].some((b) =>
      /分批列表 \(1\)/.test(b.textContent.replace(/\s+/g, ' ')),
    ),
);
check('the staged count is shown on the list button', true, '');
await api(page, '/api/stage/clear', {});
await clickRefresh();
await waitFor(
  page,
  () =>
    ![...document.querySelectorAll('.toolbar button')].some((b) =>
      /分批列表 \(\d+\)/.test(b.textContent.replace(/\s+/g, ' ')),
    ),
);
check('the count disappears after clearing the queue', true, '');

// ── 3. 搜索去空白：输入首尾空格仍按去掉空格的关键词过滤，URL 也保持一致 ─────
await waitFor(page, () => document.querySelector('#loading.show') === null);
await page.focus('input[placeholder="搜索照片..."]');
await page.keyboard.type('  P1  ');
await sleep(700);
check('leading/trailing spaces still filter correctly', (await cardCount(page)) === 1, `${await cardCount(page)}`);
let url = await urlState(page);
check('the URL keeps only the trimmed query', url.q === 'P1', JSON.stringify(url));
await page.$eval('input[placeholder="搜索照片..."]', (el) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(el, '');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.blur();
});
await sleep(700);
check('clearing the search restores every card', (await cardCount(page)) === 9, `${await cardCount(page)}`);
url = await urlState(page);
check('the cleared query is removed from the URL', url.q === null, JSON.stringify(url));

// ── 4. 查看器身份：URL/导航/刷新后仍指向同一张照片 ──────────────────────────
async function openCard(name) {
  const clicked = await page.evaluate((needle) => {
    const card = [...document.querySelectorAll('.card')].find((el) => el.textContent.includes(needle));
    if (!card) return false;
    card.click();
    return true;
  }, name);
  if (!clicked) throw new Error(`card not found: ${name}`);
  await waitFor(page, () => document.querySelector('#viewer.show') !== null);
}

await openCard('P3.jpg');
let state = await urlState(page);
check('opening a photo writes its path to the URL', state.path === '/view/ParitySeed/P3.jpg', JSON.stringify(state));

await page.keyboard.press('ArrowRight');
await waitFor(page, () => /P4\.jpg/.test(document.querySelector('#v-name')?.textContent || ''));
state = await urlState(page);
check('arrow navigation updates the URL', state.path === '/view/ParitySeed/P4.jpg', JSON.stringify(state));

await page.reload({ waitUntil: 'networkidle2' });
await waitFor(page, () => document.querySelector('#viewer.show') !== null);
const reopened = await page.evaluate(() => document.querySelector('#v-name')?.textContent || '');
check('reloading the deep link reopens the same photo', /P4\.jpg/.test(reopened), reopened);
await page.keyboard.press('Escape');
await waitFor(page, () => document.querySelector('#viewer.show') === null);

// ── 5. 按键作用域：模态框打开时不响应查看器快捷键，关闭后恢复 ────────────────
await openCard('P2.jpg');
await page.click('#v-exif-edit-btn');
await waitFor(page, () => [...document.querySelectorAll('.ant-modal')].some((m) => m.offsetParent !== null));

await page.keyboard.press('d');
await page.keyboard.press('ArrowRight');
await sleep(500);
const duringModal = await page.evaluate(() => ({
  name: document.querySelector('#v-name')?.textContent || '',
  staged: !!document.querySelector('#v-staged-pill.show'),
}));
const stagedDuring = await stagedKinds(page);
check(
  'viewer keys stay inert while a modal is open',
  duringModal.name.includes('P2.jpg') && !duringModal.staged && stagedDuring.length === 0,
  JSON.stringify({ duringModal, stagedDuring }),
);

await page.keyboard.press('Escape');
await waitFor(page, () => [...document.querySelectorAll('.ant-modal')].every((m) => m.offsetParent === null));
await sleep(300);
const viewerStillOpen = await page.evaluate(() => !!document.querySelector('#viewer.show'));
check('closing the modal with Esc does not close the viewer', viewerStillOpen, `${viewerStillOpen}`);

await page.keyboard.press('ArrowRight');
await waitFor(page, () => /P3\.jpg/.test(document.querySelector('#v-name')?.textContent || ''));
check('navigation keys work again after the modal closes', true, '');
await page.keyboard.press('d');
await waitFor(page, () => !!document.querySelector('#v-staged-pill.show'));
const stagedAfter = await stagedKinds(page);
check(
  'the delete shortcut works again after the modal closes',
  stagedAfter.some((op) => op.kind === 'delete' && op.src === 'ParitySeed/P3.jpg'),
  JSON.stringify(stagedAfter),
);
await page.keyboard.press('Escape');
await waitFor(page, () => document.querySelector('#viewer.show') === null);
await api(page, '/api/stage/clear', {});

// ── 6. 只读实例：刷新只重新读取，不调用写接口 ───────────────────────────────
if (READ) {
  const readPage = await newPage();
  let refreshPosts = 0;
  readPage.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/cache/refresh')) refreshPosts += 1;
  });
  await readPage.goto(READ, { waitUntil: 'networkidle2' });
  await waitFor(readPage, () => document.querySelectorAll('.card').length > 0);
  const readLabels = await toolbarButtons(readPage);
  check(
    'read-only hides management buttons',
    !readLabels.some((text) => text.includes('分批列表') || text.includes('回收站') || text.includes('目录')),
    JSON.stringify(readLabels),
  );
  const before = await cardCount(readPage);
  await readPage.evaluate(() => {
    const button = [...document.querySelectorAll('.toolbar button')].find((b) =>
      b.textContent.includes('刷新'),
    );
    button?.click();
  });
  await sleep(1800);
  const after = await cardCount(readPage);
  const toast = await readPage.evaluate(() =>
    [...document.querySelectorAll('.ant-message-notice')]
      .map((el) => el.textContent)
      .join(' | '),
  );
  check(
    'read-only refresh reloads without calling the write endpoint',
    refreshPosts === 0 && after === before && !/刷新缓存失败/.test(toast),
    JSON.stringify({ refreshPosts, before, after, toast }),
  );
}

// ── 7. 扫描错误告警：读接口上报的问题必须在界面上可见 ───────────────────────
if (SCAN) {
  const scanPage = await newPage();
  await scanPage.goto(SCAN, { waitUntil: 'networkidle2' });
  const warned = await scanPage
    .waitForFunction(
      () =>
        [...document.querySelectorAll('.ant-message-notice')].some((el) =>
          /未能读取/.test(el.textContent || ''),
        ),
      { timeout: 20000, polling: 100 },
    )
    .then(() => true)
    .catch(() => false);
  const scanCards = await cardCount(scanPage);
  check('a partial scan surfaces a warning in the UI', warned, `cards=${scanCards}`);
}

const failed = results.filter((item) => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} batch4 checks passed`);
await browser.close();
process.exit(failed.length ? 1 : 0);
