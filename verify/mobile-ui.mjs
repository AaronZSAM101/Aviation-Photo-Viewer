// 移动端 UI 检查：真实手机视口 + 溢出/遮挡量化 + 截图
// 只做浏览类操作：不暂存、不应用、不确认任何写操作对话框
const BASE = process.env.BASE || 'http://host.containers.internal:3000';
const puppeteer = await import('puppeteer-core').then((m) => m.default);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail: String(detail).slice(0, 400) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — ${String(detail).slice(0, 300)}`}`);
};

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/usr/bin/chromium-browser',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});

const consoleErrors = [];
const page = await browser.newPage();
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(`console: ${m.text().slice(0, 140)}`);
});
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e.message).slice(0, 140)}`));

const MOBILE = { width: 393, height: 852, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const setMobile = () => page.setViewport(MOBILE);
const shot = (name) => page.screenshot({ path: `/work/out/mobile-${name}.png` });

const metrics = () =>
  page.evaluate(() => {
    const vw = window.innerWidth;
    const doc = document.documentElement;
    const bad = [];
    const inScroller = (el) => {
      for (let node = el.parentElement; node; node = node.parentElement) {
        const cs = getComputedStyle(node);
        if (cs.overflowX === 'auto' || cs.overflowX === 'scroll' || cs.overflowX === 'hidden') return true;
      }
      return false;
    };
    // 超出视口右边界的可见元素；横向滚动容器内部的内容允许超出（那是设计如此）
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;
      if (r.right > vw + 1 && !inScroller(el)) {
        bad.push(`${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]}@${Math.round(r.right)}`);
      }
    }
    return {
      vw,
      docScrollW: doc.scrollWidth,
      canScrollX: doc.scrollWidth > vw + 1,
      overflowers: [...new Set(bad)].slice(0, 12),
    };
  });

const smallTargets = (scope) =>
  page.evaluate((root) => {
    const out = [];
    for (const el of document.querySelectorAll(root)) {
      if (!el.getClientRects().length) continue;
      // 输入框/选择框内部图标由组件库控制，不算独立点击目标
      if (el.closest('.ant-input-affix-wrapper,.ant-select')) continue;
      const r = el.getBoundingClientRect();
      if (r.height < 28 || r.width < 24) {
        out.push(`${el.tagName.toLowerCase()}:${(el.textContent || '').trim().slice(0, 12)}=${Math.round(r.width)}x${Math.round(r.height)}`);
      }
    }
    return out.slice(0, 10);
  }, scope);

const openModalMetrics = (titleNeedle) =>
  page.evaluate((needle) => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const modal = [...document.querySelectorAll('.ant-modal')].find(
      (m) => m.offsetParent !== null && (m.textContent || '').includes(needle),
    );
    if (!modal) return { found: false, vw, vh };
    const r = modal.getBoundingClientRect();
    const content = modal.querySelector('.ant-modal-content')?.getBoundingClientRect();
    const footer = modal.querySelector('.ant-modal-footer');
    const footerBtn = footer?.querySelector('button')?.getBoundingClientRect();
    return {
      found: true,
      vw,
      vh,
      modal: { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), width: Math.round(r.width) },
      clippedLeft: r.left < -1,
      clippedRight: r.right > vw + 1,
      contentWidth: content ? Math.round(content.width) : null,
      footerVisible: footerBtn ? footerBtn.right <= vw + 1 && footerBtn.left >= 0 : null,
      topOffset: Math.round(r.top),
    };
  }, titleNeedle);

const clickByText = async (selector, needle) => {
  const done = await page.evaluate(
    (root, text) => {
      const btn = [...document.querySelectorAll(root)].find(
        (b) => b.textContent.replace(/\s+/g, '').includes(text) && b.getClientRects().length > 0,
      );
      if (!btn) return false;
      btn.click();
      return true;
    },
    selector,
    needle,
  );
  if (!done) throw new Error(`button not found: ${needle} in ${selector}`);
  await sleep(600);
};

const menuOpen = () =>
  page.evaluate(
    () =>
      [...document.querySelectorAll('.ant-dropdown')].some(
        (dd) =>
          !dd.classList.contains('ant-dropdown-hidden') &&
          [...dd.querySelectorAll('.ant-dropdown-menu-item')].some((i) => {
            const r = i.getBoundingClientRect();
            // 入场动画期间条目宽度还是 0，getClientRects() 会误报"已可见"
            return r.width > 0 && r.height > 0;
          }),
      ),
  );

const settleMenu = async (want, ms = 3000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    if ((await menuOpen()) === want) return true;
    if (Date.now() > deadline) return false;
    await sleep(120);
  }
};

const closeDropdown = async () => {
  if (await menuOpen()) {
    const more = await page.$('.app-header .toolbar-more');
    if (more) await more.click();
    await settleMenu(false, 2000);
  }
  await sleep(150);
};

// 真实鼠标点击：合成的 el.click() 会让 rc-trigger 把同一次事件当成外部点击，
// 菜单刚开就被关掉，截图里看不到下拉
const realClickByText = async (selector, needle) => {
  const handles = await page.$$(selector);
  for (const h of handles) {
    const info = await h.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return {
        text: (el.textContent || '').replace(/\s+/g, ''),
        visible: r.width > 0 && r.height > 0,
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
      };
    });
    if (info.visible && info.text.includes(needle.replace(/\s+/g, ''))) {
      await page.mouse.click(info.x, info.y);
      return true;
    }
  }
  return false;
};

// 窄屏顶栏把管理入口收进 ⋯ 更多 下拉；两种形态都要能打开同一个控件。
// 菜单可能已经开着（点条目不一定自动收起），所以只在关闭时才点触发钮。
const menuDump = () =>
  page.evaluate(() => ({
    dropdowns: [...document.querySelectorAll('.ant-dropdown')].map((dd) => ({
      cls: dd.className.replace(/css-\S+/g, ''),
      items: [...dd.querySelectorAll('.ant-dropdown-menu-item')].map((i) => {
        const r = i.getBoundingClientRect();
        return `${(i.textContent || '').trim().slice(0, 8)}@${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`;
      }),
    })),
  }));

const gotoGallery = async () => {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await waitFor(() => document.querySelectorAll('.card').length > 0, 60000);
  await waitFor(() => document.querySelector('#loading.show') === null, 60000);
  await sleep(800);
};

const openHeaderAction = async (needle) => {
  if (await realClickByText('.app-header .toolbar button', needle)) {
    await sleep(600);
    return 'button';
  }
  if (!(await page.$('.app-header .toolbar-more'))) throw new Error(`header control not found: ${needle}`);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (attempt > 1) await gotoGallery(); // 下拉偶尔卡在入场动画，重新加载最省事
    if (!(await menuOpen())) {
      await (await page.$('.app-header .toolbar-more')).click();
      await settleMenu(true, 3000);
    }
    await sleep(250);
    if (await realClickByText('.ant-dropdown-menu-item', needle)) {
      await sleep(600);
      return `dropdown${attempt > 1 ? ':retry' : ''}`;
    }
    await closeDropdown();
  }
  throw new Error(`dropdown item not found: ${needle} — ${JSON.stringify(await menuDump()).slice(0, 400)}`);
};

const waitFor = async (fn, timeout = 30000) => {
  try {
    await page.waitForFunction(fn, { timeout, polling: 200 });
    return true;
  } catch {
    return false;
  }
};

await setMobile();

// ── 画廊首屏 ────────────────────────────────────────────────────────────────
await gotoGallery();
await sleep(700);

let m = await metrics();
check('gallery has no horizontal page scroll', !m.canScrollX, JSON.stringify(m));
check('nothing is pushed off the right edge', m.overflowers.length === 0, JSON.stringify(m.overflowers));
await shot('01-gallery');

const grid = await page.evaluate(() => {
  const g = document.querySelector('.grid');
  if (!g) return null;
  const cards = [...document.querySelectorAll('.card')].filter((c) => c.getClientRects().length);
  const first = cards[0]?.getBoundingClientRect();
  const cols = getComputedStyle(g).gridTemplateColumns.split(' ').length;
  const clipped = cards.filter((c) => {
    const r = c.getBoundingClientRect();
    return r.right > window.innerWidth + 1 || r.left < -1;
  }).length;
  return { cols, cardWidth: first ? Math.round(first.width) : 0, cards: cards.length, clipped };
});
check('photo grid fits the phone width', grid && grid.clipped === 0 && grid.cardWidth > 90, JSON.stringify(grid));

const header = await page.evaluate(() => {
  const h = document.querySelector('.app-header');
  const r = h?.getBoundingClientRect();
  const tb = document.querySelector('.app-header .toolbar');
  const filters = document.querySelector('.toolbar-filters');
  return {
    compact: !!h && h.classList.contains('app-header-compact'),
    headerHeight: r ? Math.round(r.height) : 0,
    toolbarScrollsX: tb ? tb.scrollWidth > tb.clientWidth + 1 : null,
    toolbarWraps: tb ? getComputedStyle(tb).flexWrap : null,
    searchVisible: (() => {
      const s = document.querySelector('.toolbar-search');
      const rect = s?.getBoundingClientRect();
      return rect ? rect.right <= window.innerWidth + 1 : false;
    })(),
    moreVisible: (() => {
      const rect = document.querySelector('.toolbar-more')?.getBoundingClientRect();
      return rect ? rect.right <= window.innerWidth + 1 && rect.width > 0 : false;
    })(),
    filtersFit: (() => {
      const rect = filters?.getBoundingClientRect();
      return rect ? rect.right <= window.innerWidth + 1 && rect.left >= -1 : null;
    })(),
    filtersScroll: filters ? { w: filters.clientWidth, sw: filters.scrollWidth } : null,
  };
});
check('header uses the compact mobile layout', header.compact, JSON.stringify(header));
check('header is compact on mobile', header.headerHeight > 0 && header.headerHeight < 200, JSON.stringify(header));
check('main header row has no sideways scroll', header.toolbarScrollsX === false, JSON.stringify(header));
check('search box and 更多 button are on screen', header.searchVisible && header.moreVisible, JSON.stringify(header));
check(
  'filter row fits the phone width',
  header.filtersFit === true,
  JSON.stringify({ filtersFit: header.filtersFit, filtersScroll: header.filtersScroll }),
);
await smallTargets('.app-header .toolbar button').then((t) =>
  check('header tap targets are at least 28px', t.length === 0, JSON.stringify(t)),
);

// ⋯ 更多 下拉必须收全部管理入口，否则手机上这些功能再也点不到
await (await page.$('.app-header .toolbar-more')).click();
if (!(await settleMenu(true))) throw new Error('more menu never opened');
await sleep(500);
const menuItems = await page.evaluate(() => {
  const items = [...document.querySelectorAll('.ant-dropdown')]
    .filter((dd) => !dd.classList.contains('ant-dropdown-hidden'))
    .flatMap((dd) => [...dd.querySelectorAll('.ant-dropdown-menu-item')])
    .filter((i) => {
      const r = i.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
  const vw = window.innerWidth;
  const clipped = items.filter((i) => {
    const r = i.getBoundingClientRect();
    return r.right > vw + 1 || r.left < -1;
  }).length;
  return {
    labels: items.map((i) => (i.textContent || '').trim()),
    clipped,
    panel: (() => {
      const r = items[0]?.getBoundingClientRect();
      return r ? { l: Math.round(r.left), right: Math.round(r.right), h: Math.round(r.height) } : null;
    })(),
  };
});
const menuText = menuItems.labels.join('|').replace(/\s+/g, '');
const missing = ['批量移动', '批量删除', '分批列表', '回收站', '相似对比', '目录', '快捷键'].filter(
  (n) => !menuText.includes(n),
);
if (!/折叠全部|展开全部/.test(menuText)) missing.push('折叠/展开全部');
if (!/\d{4}-\d{2}-\d{2}|版本未知/.test(menuText)) missing.push('版本号');
if (!menuText.includes('WIP')) missing.push('WIP 标记');
check('more menu exposes every management control', missing.length === 0, JSON.stringify({ missing, labels: menuItems.labels }));
check('more menu is fully on screen', menuItems.clipped === 0 && menuItems.panel !== null, JSON.stringify(menuItems));
await shot('01b-more-menu');
await closeDropdown();

// ── 只读实例的顶栏在手机上不应出现管理入口（这里生产是可写，只记录） ──────────
const statsText = await page.evaluate(() => document.querySelector('.stats')?.textContent || '');
check('stats line renders', /\d/.test(statsText), statsText);

// ── 模态框：宽度写死会在手机上被裁掉 ────────────────────────────────────────
for (const [label, needle] of [
  ['分批列表', '分批操作'],
  ['回收站', '回收站'],
  ['快捷键', '快捷键'],
  ['相似对比', '相似照片'],
]) {
  await waitFor(() => ![...document.querySelectorAll('.ant-modal')].some((mm) => mm.offsetParent !== null), 8000);
  try {
    await openHeaderAction(label);
  } catch (error) {
    check(`modal ${label} opens`, false, error.message);
    await closeDropdown();
    continue;
  }
  const opened = await waitFor(
    () => [...document.querySelectorAll('.ant-modal')].some((mm) => mm.offsetParent !== null),
    8000,
  );
  const mm = await openModalMetrics(needle);
  check(
    `modal ${label} fits the phone viewport`,
    opened && mm.found && !mm.clippedLeft && !mm.clippedRight,
    JSON.stringify(mm),
  );
  await sleep(400);
  await shot(`modal-${label}`);
  await page.keyboard.press('Escape');
  let closed = await waitFor(
    () => ![...document.querySelectorAll('.ant-modal')].some((mm2) => mm2.offsetParent !== null),
    4000,
  );
  if (!closed) {
    await page.evaluate(() => document.querySelector('.ant-modal .ant-modal-close')?.click());
    await waitFor(
      () => ![...document.querySelectorAll('.ant-modal')].some((mm2) => mm2.offsetParent !== null),
      4000,
    );
  }
  await sleep(300);
  await closeDropdown();
}

// ── 查看器 ─────────────────────────────────────────────────────────────────
await gotoGallery();
const tapped = await page.evaluate(() => {
  const c = document.querySelectorAll('.card')[1];
  if (!c) return false;
  c.click();
  return true;
});
if (!tapped) throw new Error('no card to tap');
const viewerOpen = await waitFor(() => {
  const v = document.getElementById('viewer');
  const img = document.getElementById('v-img');
  return !!v && v.classList.contains('show') && !!img && img.naturalWidth > 0;
}, 60000);
check('viewer opens from a tap', viewerOpen, await page.evaluate(() => document.getElementById('v-img')?.naturalWidth));
await sleep(1200);
m = await metrics();
check('viewer has no horizontal overflow', !m.canScrollX && m.overflowers.length === 0, JSON.stringify(m));
const vlay = await page.evaluate(() => {
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) };
  };
  return {
    vw: window.innerWidth,
    vh: window.innerHeight,
    toolbar: box('#vtoolbar'),
    stage: box('#vstage'),
    info: box('#vinfo'),
    img: box('#v-img'),
    prev: box('#v-prev'),
    next: box('#v-next'),
  };
});
check(
  'viewer toolbar stays inside the screen',
  vlay.toolbar && vlay.toolbar.r <= vlay.vw + 1 && vlay.toolbar.l >= -1,
  JSON.stringify(vlay.toolbar),
);
check(
  'viewer nav arrows are reachable',
  vlay.prev && vlay.next && vlay.prev.l >= 0 && vlay.next.r <= vlay.vw + 1,
  JSON.stringify({ prev: vlay.prev, next: vlay.next }),
);
await smallTargets('#vtoolbar button').then((t) =>
  check('viewer toolbar tap targets are at least 28px', t.length === 0, JSON.stringify(t)),
);
const toolbarLabels = await page.evaluate(() => {
  const btns = [...document.querySelectorAll('#vtoolbar button')].filter((b) => b.getClientRects().length);
  return {
    count: btns.length,
    letterOnly: btns
      .filter((b) => /^[A-Za-z]$/.test((b.textContent || '').trim()))
      .map((b) => (b.textContent || '').trim()),
    sample: btns.slice(0, 16).map((b) => (b.textContent || '').trim().slice(0, 10)),
  };
});
check(
  'viewer toolbar buttons are readable, not bare letters',
  toolbarLabels.count > 0 && toolbarLabels.letterOnly.length === 0,
  JSON.stringify(toolbarLabels),
);
await shot('02-viewer');

// EXIF 面板：默认展开，手机上应完整落在屏幕内；I 键能收起再展开
let infoBox = await page.evaluate(() => {
  const el = document.querySelector('#vinfo');
  const r = el?.getBoundingClientRect();
  return {
    shown: !!el && el.classList.contains('show'),
    rect: r ? { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom) } : null,
    vw: window.innerWidth,
    vh: window.innerHeight,
  };
});
if (!infoBox.shown) {
  await page.keyboard.press('i');
  await sleep(900);
  infoBox = await page.evaluate(() => {
    const el = document.querySelector('#vinfo');
    const r = el?.getBoundingClientRect();
    return {
      shown: !!el && el.classList.contains('show'),
      rect: r ? { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom) } : null,
      vw: window.innerWidth,
      vh: window.innerHeight,
    };
  });
}
check('EXIF panel is visible in the viewer', infoBox.shown, JSON.stringify(infoBox));
check(
  'EXIF panel fits the phone screen',
  infoBox.rect && infoBox.rect.l >= -1 && infoBox.rect.r <= infoBox.vw + 1 && infoBox.rect.t >= 0 && infoBox.rect.b <= infoBox.vh + 1,
  JSON.stringify(infoBox),
);
await shot('03-viewer-exif');

// 直方图 + RGB：移动端小屏容易和工具栏打架
await page.keyboard.press('h');
await page.keyboard.press('r');
await sleep(1200);
m = await metrics();
check('charts do not overflow the phone width', m.overflowers.length === 0 && !m.canScrollX, JSON.stringify(m));
const chartBoxes = await page.evaluate(() => {
  const vw = window.innerWidth;
  return {
    vw,
    panels: [...document.querySelectorAll('.chart-panel')].filter((el) => el.classList.contains('show')).map((el) => {
      const r = el.getBoundingClientRect();
      return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) };
    }),
  };
});
check(
  'chart panels are fully on screen',
  chartBoxes.panels.length > 0 &&
    chartBoxes.panels.every((b) => b.l >= 0 && b.r <= chartBoxes.vw + 1 && b.t >= 0),
  JSON.stringify(chartBoxes),
);
await shot('04-viewer-charts');

// 地图上滑（若这张照片有 GPS）
const hasMap = await page.evaluate(
  () => !!document.querySelector('#v-map-toggle') || [...document.querySelectorAll('#vtoolbar button')].some((b) => /地图|map/i.test(b.textContent)),
);
check('map control presence recorded', true, `hasMap=${hasMap}`);

// ── 更窄的手机（360x640）再跑一遍关键项 ─────────────────────────────────────
await page.evaluate(() => document.getElementById('viewer')?.classList.remove('show'));
await page.setViewport({ ...MOBILE, width: 360, height: 640 });
await gotoGallery();
m = await metrics();
check('360px width: no horizontal scroll', !m.canScrollX && m.overflowers.length === 0, JSON.stringify(m));
await shot('05-gallery-360');
try {
  await openHeaderAction('相似对比');
  await waitFor(() => [...document.querySelectorAll('.ant-modal')].some((mm) => mm.offsetParent !== null), 8000);
  const mm = await openModalMetrics('相似照片');
  check('360px width: compare modal fits', !mm.clippedLeft && !mm.clippedRight, JSON.stringify(mm));
  await shot('06-compare-360');
} catch (error) {
  check('360px width: compare modal fits', false, error.message);
}

check('no console or page errors', consoleErrors.length === 0, consoleErrors.slice(0, 6).join(' | '));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} mobile UI checks passed`);
await browser.close();
process.exit(failed.length ? 1 : 0);
