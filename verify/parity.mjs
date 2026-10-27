import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const READ = process.env.READ_BASE || 'http://10.88.1.31';
const WRITE = process.env.WRITE_BASE || 'http://10.88.1.36';
const OUT = process.env.OUT_DIR || '/work/out';
const norm = (value) => String(value ?? '').replace(/\s+/g, '');
const results = [];
const consoleErrors = [];
// ONLY_STEPS=子串1,子串2 只跑名字命中的步骤（默认全部），用于快速复现单个步骤
const ONLY = (process.env.ONLY_STEPS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const LOG_API = !!process.env.LOG_API;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(OUT, { recursive: true });

function log(name, ok, detail = '') {
  const row = { name, ok: !!ok, detail: String(detail).slice(0, 220) };
  results.push(row);
  fs.appendFileSync(`${OUT}/progress.jsonl`, `${JSON.stringify(row)}\n`);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + String(detail).slice(0, 200) : ''}`);
}

async function step(name, fn) {
  if (ONLY.length && !ONLY.some((needle) => name.includes(needle))) return;
  console.log(`... ${name}`);
  try {
    await fn();
  } catch (error) {
    log(name, false, `threw: ${error.message}`);
  }
}

const launch = async () =>
  puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/usr/bin/chromium-browser',
    // 一次 CDP 调用要等的上限。列表窗口化那步要在页面里滚完全库（2900+ 张），
    // 默认 180s 在冷缓存的实例上会超时，而且超时的 evaluate 并不会取消页面里
    // 正在跑的滚动——后面的步骤会接着被这股滚动带歪，看起来像四个独立的失败。
    protocolTimeout: 600000,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--window-size=1600,1000'],
    defaultViewport: { width: 1600, height: 1000 },
  });

const instrument = (page, tag) => {
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(`${tag} console: ${m.text().slice(0, 160)}`);
  });
  page.on('pageerror', (e) => consoleErrors.push(`${tag} pageerror: ${String(e.message).slice(0, 160)}`));
  if (!LOG_API) return;
  const t0 = Date.now();
  page.on('console', (m) => console.log(`[${tag} console] ${m.type()}: ${m.text().slice(0, 200)}`));
  page.on('response', async (res) => {
    if (!/\/api\/(stage|trash|photos)/.test(res.url())) return;
    let body = '';
    try {
      body = (await res.text()).slice(0, 240);
    } catch {
      body = '<unreadable>';
    }
    console.log(
      `[${tag} api ${Date.now() - t0}ms] ${res.request().method()} ${res.url().replace(/^https?:\/\/[^/]+/, '')} -> ${res.status()} ${body}`,
    );
  });
};

const shot = async (page, name) => {
  try {
    await page.screenshot({ path: `${OUT}/${name}.png` });
  } catch {
    /* screenshot is best-effort */
  }
};

const text = (page, sel) => page.$eval(sel, (e) => e.textContent.trim()).catch(() => null);

const statText = (page) =>
  page.evaluate(() => {
    const el = [...document.querySelectorAll('#toolbar *, .toolbar *, body *')].find(
      (n) => n.children.length === 0 && /张.*(含EXIF|时间分组)/.test(n.textContent),
    );
    return el ? el.textContent.trim() : null;
  });

const waitFor = async (page, fn, timeout = 25000) => {
  const start = Date.now();
  for (;;) {
    const value = await page.evaluate(fn);
    if (value) return value;
    if (Date.now() - start > timeout) return false;
    await sleep(250);
  }
};

const url = (page) => page.evaluate(() => location.pathname + location.search);

// antd Select: open the n-th select then click the option whose text matches.
// The global #loading overlay swallows clicks while the photo list is in flight.
const waitIdle = (page, timeout = 20000) =>
  waitFor(page, () => {
    const l = document.getElementById('loading');
    return !l || !l.classList.contains('show');
  }, timeout);

// Click the centre of an element found by an in-page expression, using real mouse events.
// Hit-testing before pressing matters: an overlay painted over the target silently eats the click.
async function clickBox(page, finderExpr, label, timeout = 6000) {
  await waitIdle(page);
  const measure = (expr) =>
    page.evaluate((e) => {
      let el;
      try {
        el = eval(e);
      } catch {
        return null;
      }
      if (!el || !el.getBoundingClientRect) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return null;
      const x = Math.round(r.x + r.width / 2);
      const y = Math.round(r.y + r.height / 2);
      const top = document.elementFromPoint(x, y);
      const blocked = !!top && !el.contains(top);
      return {
        x,
        y,
        blocked,
        blocker: blocked ? `${top.tagName}.${String(top.className).slice(0, 40)}` : '',
      };
    }, expr);
  const start = Date.now();
  let box = await measure(finderExpr);
  let blocker = box && box.blocked ? box.blocker : '';
  while (box && box.blocked && Date.now() - start < timeout) {
    await sleep(250);
    box = await measure(finderExpr);
    blocker = box && box.blocked ? box.blocker : '';
  }
  while (!box && Date.now() - start < timeout) {
    await sleep(250);
    box = await measure(finderExpr);
  }
  if (!box) throw new Error(`click target missing (${label}): ${finderExpr}`);
  if (box.blocked) throw new Error(`click blocked (${label}) by ${blocker}`);
  await page.mouse.click(box.x, box.y);
  await sleep(350);
  return box;
}

// An overlay can appear between mousePressed and mouseReleased, which moves the click's
// target off the button. Re-click until the expected UI state shows up.
async function clickUntil(page, finderExpr, check, label, attempts = 3) {
  for (let i = 0; i < attempts; i += 1) {
    await clickBox(page, finderExpr, `${label}#${i}`);
    if (await check()) return true;
    await waitIdle(page);
    await sleep(400);
  }
  return false;
}

const visibleModalText = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.ant-modal')]
      .filter((x) => x.offsetParent !== null)
      .map((x) => x.textContent.replace(/\s+/g, ' '))
      .join(' | ') || null,
  );

async function modalShowing(page, needle, timeout = 2500) {
  const start = Date.now();
  for (;;) {
    const t = await visibleModalText(page);
    if (t && t.includes(needle)) return true;
    if (Date.now() - start > timeout) return false;
    await sleep(200);
  }
}

// 选中的下拉项靠真鼠标点，页面正忙（滚动窗口重排、缩略图落地）时第一下可能落在动画中途的
// 浮层上而什么都没改。所以点完要回头看 Select 自己显示的文字，没生效就关掉重开再点一次。
async function pickSelect(page, index, optionText) {
  const shown = () =>
    page.evaluate((idx) => {
      const s = document.querySelectorAll('.ant-select')[idx];
      if (!s) return '';
      const item = s.querySelector('.ant-select-selection-item');
      return (item ? item.textContent : s.textContent).replace(/\s+/g, '');
    }, index);
  const closeDropdown = async () => {
    await page.keyboard.press('Escape');
    await sleep(150);
  };
  let lastOptions = '';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await closeDropdown();
    await clickBox(page, `document.querySelectorAll('.ant-select')[${index}]`, `select ${index}`);
    const opened = await waitFor(page, () => {
      const dd = document.querySelector('.ant-select-dropdown:not(.ant-select-dropdown-hidden)');
      return !!dd && !!dd.querySelector('.ant-select-item-option');
    }, 6000);
    if (!opened) throw new Error(`dropdown for select ${index} did not open`);
    const options = await page.evaluate(() =>
      [...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')]
        .map((o) => o.textContent.trim())
        .join('|'),
    );
    lastOptions = options;
    const found = await page.evaluate(
      (needle) => {
        const o = [...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')]
          .find((x) => x.textContent.replace(/\s+/g, '').includes(needle.replace(/\s+/g, '')));
        if (!o) return null;
        const r = o.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      },
      optionText,
    );
    if (!found) throw new Error(`option "${optionText}" missing, have: ${options}`);
    await page.mouse.click(found.x, found.y);
    const want = norm(optionText);
    const start = Date.now();
    while (Date.now() - start < 4000) {
      if (norm(await shown()).includes(want)) return optionText;
      await sleep(200);
    }
  }
  throw new Error(`select ${index} never showed "${optionText}" (last options: ${lastOptions})`);
}

const textFinder = (selector, needle) =>
  `[...document.querySelectorAll(${JSON.stringify(selector)})]` +
  `.find((n) => n.textContent.replace(/\\s+/g, '').includes(${JSON.stringify(norm(needle))}) && n.getClientRects().length > 0)`;

async function clickByText(page, selector, needle) {
  const found = await clickBox(page, textFinder(selector, needle), needle);
  return found;
}

const typeInto = async (page, selector, value) => {
  const el = await page.$(selector);
  if (!el) throw new Error(`missing input ${selector}`);
  await el.click({ clickCount: 3 });
  await el.type(value, { delay: 12 });
  await sleep(500);
};

// Hidden modals stay in the DOM, so target the visible one.
const visibleModalInputs = (page, index) =>
  page.evaluate(
    (idx) => {
      const m = [...document.querySelectorAll('.ant-modal')].find((x) => x.offsetParent !== null);
      if (!m) return null;
      const input = m.querySelectorAll('input')[idx];
      return input ? `${input.type}=${input.value}` : null;
    },
    index,
  );

const typeIntoVisibleModal = async (page, index, value) => {
  const done = await page.evaluate(
    (idx, text) => {
      const m = [...document.querySelectorAll('.ant-modal')].find((x) => x.offsetParent !== null);
      if (!m) return false;
      const input = m.querySelectorAll('input')[idx];
      if (!input) return false;
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    },
    index,
    value,
  );
  if (!done) throw new Error(`visible modal input #${index} missing`);
  await sleep(350);
};

// Point for the n-th card: 'thumb' = thumbnail centre, 'info' = first line of the info row.
const cardPoint = (page, n, mode = 'thumb') =>
  page.evaluate((idx, m) => {
    const c = document.querySelectorAll('.card')[idx];
    if (!c) return null;
    const el = m === 'info' ? c.querySelector('.card-info') : c.querySelector('.thumb');
    const r = (el || c).getBoundingClientRect();
    return {
      x: Math.round(r.x + r.width / 2),
      y: Math.round(r.y + (m === 'info' ? 10 : r.height / 2)),
    };
  }, n, mode);

// ── read-only instance: browsing, viewer, modals ────────────────────────────
const browser = await launch();
const page = await browser.newPage();
instrument(page, 'read');

await page.goto(`${READ}/`, { waitUntil: 'domcontentloaded' });

await step('gallery renders real thumbs', async () => {
  const ok = await waitFor(page, () => {
    const imgs = [...document.querySelectorAll('.card img')];
    return imgs.length > 0 && imgs.filter((i) => i.naturalWidth > 0).length >= 8;
  });
  await waitIdle(page);
  log('gallery renders real thumbs', ok, ok ? '' : 'no thumbnail reached naturalWidth');
});

// 列表改成行级窗口后，DOM 里只保留视口附近那几十张卡片。
// 契约相应地从“2939 张全部挂载”改成三条：窗口有界、从上到下滚一遍能碰到每一张、
// 滚动条长度不随挂载伸缩（占位内边距算对了）。
await step('gallery windows the list', async () => {
  // 期望清单走 node 侧 HTTP：冷实例上 /api/photos 要几十秒，挂在浏览器协议里只会白白吃超时。
  const expected = await fetch(`${READ}/api/photos`)
    .then((r) => r.json())
    .then((l) => l.map((p) => (p.folder ? `${p.folder}/${p.filename}` : p.filename)));
  if (!Array.isArray(expected) || expected.length === 0) throw new Error('expected list is empty');

  await page.evaluate(() => {
    window.__sweep = { seen: new Set(), peak: 0, height0: 0, height1: 0 };
    document.scrollingElement.scrollTop = 0;
  });
  await sleep(300);
  // 一页一页地滚，每页一次短 evaluate。整场循环放进单个 evaluate 里会让这一步变成
  // 一个长达数分钟的 CDP 调用，一旦超时页面还在继续滚，后面的步骤全被带歪。
  const tick = () =>
    page.evaluate(() => {
      const s = window.__sweep;
      const cards = document.querySelectorAll('.card[data-sp]');
      s.peak = Math.max(s.peak, cards.length);
      cards.forEach((c) => s.seen.add(c.getAttribute('data-sp')));
      const sc = document.scrollingElement;
      s.height1 = sc.scrollHeight;
      return { bottom: sc.scrollTop + window.innerHeight >= sc.scrollHeight - 2 };
    });
  await page.evaluate(() => {
    window.__sweep.height0 = document.scrollingElement.scrollHeight;
  });
  let reachedBottom = false;
  for (let guard = 0; guard < 1200; guard += 1) {
    await page.evaluate((px) => {
      document.scrollingElement.scrollTop += px;
    }, Math.max(200, Math.round(1000 * 0.6)));
    await sleep(50);
    const t = await tick();
    if (t.bottom) {
      reachedBottom = true;
      break;
    }
  }
  const sweep = await page.evaluate((all) => {
    const s = window.__sweep;
    document.scrollingElement.scrollTop = 0;
    return { cards: s.seen.size, peak: s.peak, height0: s.height0, height1: s.height1, missing: all.filter((sp) => !s.seen.has(sp)).slice(0, 5) };
  }, expected);
  const bounded = sweep.peak > 0 && sweep.peak < 400;
  const complete = reachedBottom && sweep.cards === expected.length && sweep.missing.length === 0;
  const stable = Math.abs(sweep.height1 - sweep.height0) < 24;
  log('gallery window stays bounded', bounded, `peak=${sweep.peak} of ${expected.length} cards`);
  log(
    'every photo reachable by scrolling',
    complete,
    `seen=${sweep.cards} bottom=${reachedBottom} missing=${sweep.missing.join(',')}`,
  );
  log('scrollbar length stable while windowing', stable, `${sweep.height0} → ${sweep.height1}`);
});
const stats = await statText(page);
log('stats string', /2939 张.*2939 张含EXIF.*全部.*无时间分组/.test(stats || ''), stats);

await step('read-only hides write controls', async () => {
  const labels = await page.evaluate(() => document.querySelector('body').innerText);
  const hidden = ['回收站', '目录', '分批列表'].filter((w) => labels.includes(w));
  log('read-only hides write controls', hidden.length === 0, `still visible: ${hidden.join(',')}`);
});

await step('view=folder', async () => {
  await pickSelect(page, 0, '按文件夹');
  const sections = await page.evaluate(() => document.querySelectorAll('.folder-section').length);
  const u = await url(page);
  log('view=folder', sections > 0 && u.includes('view=folder'), `sections=${sections} url=${u}`);
});

await step('scale=month', async () => {
  await pickSelect(page, 1, '按月');
  const u = await url(page);
  const calendars = await page.evaluate(() => document.querySelectorAll('.folder-section').length);
  log('scale=month', u.includes('scale=month') && calendars > 2, `sections=${calendars} url=${u}`);
  await shot(page, '01-folder-month');
});

await step('sort=name-asc', async () => {
  await pickSelect(page, 2, '文件名 A→Z');
  const u = await url(page);
  log('sort=name-asc', u.includes('sort=name-asc'), u);
});

await step('search filters + q param', async () => {
  const input = await page.$('.ant-input');
  if (!input) throw new Error('no search input');
  await input.click();
  await input.type('B-52', { delay: 20 });
  const ok = await waitFor(page, () => {
    const el = [...document.querySelectorAll('body *')].find(
      (n) => n.children.length === 0 && /搜索|\/ \d+ 张|\d+ \/ \d+ 张/.test(n.textContent),
    );
    return !!el && location.search.includes('q=B-52');
  }, 8000);
  const n = await page.evaluate(() => document.querySelectorAll('.card').length);
  log('search filters + q param', ok && n > 0 && n < 2939, `cards=${n} url=${await url(page)}`);
  await shot(page, '02-search');
  await input.evaluate((el) => {
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(600);
});

await step('collapse all toggles collapse=1', async () => {
  await clickByText(page, 'button', '折叠全部');
  const u1 = await url(page);
  const visible = await page.evaluate(
    () => [...document.querySelectorAll('.folder-section')].filter((s) => s.classList.contains('collapsed')).length,
  );
  await clickByText(page, 'button', '展开全部');
  const u2 = await url(page);
  log('collapse all toggles collapse=1', u1.includes('collapse=1') && !u2.includes('collapse=1'), `${u1} -> ${u2} collapsed=${visible}`);
});

await step('theme switch sets data-theme', async () => {
  const themeExpr = `document.querySelector('button[aria-label^="主题"]')`;
  const before = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  await clickBox(page, themeExpr, 'theme');
  const after = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  await shot(page, '03-dark-theme');
  await clickBox(page, themeExpr, 'theme');
  const back = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  log('theme switch sets data-theme', before !== after && after !== back, `${before} -> ${after} -> ${back}`);
});

await step('F1 opens shortcut modal', async () => {
  await page.keyboard.press('F1');
  const ok = await waitFor(page, () => {
    const m = document.querySelector('.ant-modal');
    return !!m && /快捷键/.test(m.textContent);
  }, 6000);
  await shot(page, '04-shortcuts');
  log('F1 opens shortcut modal', ok, ok ? '' : 'modal not found');
  await page.keyboard.press('Escape');
  await sleep(400);
});

await step('compare modal opens', async () => {
  await clickByText(page, 'button', '相似对比');
  const ok = await waitFor(page, () => {
    const m = [...document.querySelectorAll('.ant-modal')].find((x) => x.offsetParent !== null);
    return !!m && /相似/.test(m.textContent);
  }, 6000);
  await shot(page, '05-compare');
  log('compare modal opens', ok, ok ? '' : 'compare modal missing');
  await clickByText(page, '.ant-modal button', '取消').catch(() => {});
  await page.keyboard.press('Escape');
  await sleep(400);
});

// viewer on the read-only instance
const gpsPath = "Unqueued/ZSAM-Overview(Xiang'an).jpg";
await page.goto(`${READ}/view/${encodeURI(gpsPath)}?view=flat`, { waitUntil: 'domcontentloaded' });

await step('deep link /view opens viewer', async () => {
  const ok = await waitFor(page, () => {
    const v = document.getElementById('viewer');
    const img = document.getElementById('v-img');
    return !!v && v.classList.contains('show') && !!img && img.naturalWidth > 0;
  });
  log('deep link /view opens viewer', ok, ok ? await url(page) : 'viewer did not open');
});

await step('viewer info panel + grids + rgb + hist', async () => {
  const infoDefault = await page.evaluate(() => {
    const el = document.getElementById('vinfo');
    return !!el && el.classList.contains('show');
  });
  await page.keyboard.press('i');
  const closed = await waitFor(
    page,
    () => {
      const el = document.getElementById('vinfo');
      return !!el && !el.classList.contains('show');
    },
    5000,
  );
  await page.keyboard.press('i');
  const reopened = await waitFor(
    page,
    () => {
      const el = document.getElementById('vinfo');
      return !!el && el.classList.contains('show');
    },
    5000,
  );
  const exifText = await page.evaluate(() => {
    const el = document.getElementById('vinfo');
    return el ? el.innerText.replace(/\s+/g, ' ').slice(0, 160) : null;
  });
  await page.keyboard.press('g');
  await page.keyboard.press('f');
  const grids = await page.evaluate(() => ({
    grid: !!document.querySelector('#v-grid.show'),
    fine: !!document.querySelector('#v-finegrid.show'),
  }));
  await page.keyboard.press('r');
  await page.keyboard.press('h');
  const charts = await page.evaluate(() => ({
    rgb: document.querySelectorAll('.chart-panel').length,
    paths: document.querySelectorAll('.chart-panel svg path').length,
  }));
  await shot(page, '06-viewer-info');
  log(
    'viewer info panel + grids + rgb + hist',
    infoDefault &&
      closed &&
      reopened &&
      /ISO|曝光|焦距|镜头|GPS/i.test(exifText || '') &&
      grids.grid &&
      grids.fine &&
      charts.rgb >= 2 &&
      charts.paths > 0,
    JSON.stringify({ infoDefault, closed, reopened, ...grids, ...charts }, null, 0) + ' | ' + exifText,
  );
});

await step('viewer gps mini map renders tiles', async () => {
  const tiles = await page.evaluate(() => {
    const map = document.querySelector('.gps-map, .gps-mini-map, [class*="gps-"]');
    const imgs = [...document.querySelectorAll('.gps-map-tile img')];
    return { map: !!map, total: imgs.length, loaded: imgs.filter((i) => i.naturalWidth > 0).length };
  });
  log('viewer gps mini map renders tiles', tiles.map && tiles.total > 0, JSON.stringify(tiles));
});

await step('E equalize toggles canvas', async () => {
  await page.keyboard.press('e');
  const state = await waitFor(
    page,
    () => {
      const c = document.getElementById('v-canvas');
      const img = document.getElementById('v-img');
      const visible = !!c && getComputedStyle(c).display !== 'none';
      return visible && img && getComputedStyle(img).display === 'none' && c.width > 0
        ? { canvasVisible: visible, imgHidden: true, pixel: c.width, painted: c.width }
        : null;
    },
    6000,
  );
  await shot(page, '07-equalize');
  await page.keyboard.press('e');
  const backToImage = await waitFor(
    page,
    () => getComputedStyle(document.getElementById('v-img')).display !== 'none',
    4000,
  );
  log(
    'E equalize toggles canvas',
    !!state && backToImage,
    JSON.stringify({ state, backToImage }),
  );
});

await step('zoom modes fit / 100% / fill', async () => {
  const measure = () =>
    page.evaluate(() => {
      const img = document.getElementById('v-img');
      const stage = document.getElementById('vstage');
      const r = img.getBoundingClientRect();
      return {
        w: Math.round(r.width),
        h: Math.round(r.height),
        natural: img.naturalWidth,
        cls: stage.className,
        scrollable: stage.scrollWidth > stage.clientWidth + 2,
      };
    });
  const out = {};
  for (const mode of ['fit', 'actual', 'fill']) {
    await page.select('#v-zoom-sel', mode);
    await sleep(700);
    out[mode] = await measure();
    if (mode === 'actual') await shot(page, '07-zoom-actual');
  }
  await page.select('#v-zoom-sel', 'fit');
  await sleep(500);
  const ok =
    out.fit.w > 0 &&
    out.actual.natural > 0 &&
    Math.abs(out.actual.w - out.actual.natural) <= 2 &&
    out.actual.w > out.fit.w &&
    out.fill.h >= out.fit.h - 2;
  log('zoom modes fit / 100% / fill', ok, JSON.stringify(out));
});

await step('pan by drag moves the stage', async () => {
  await page.select('#v-zoom-sel', 'actual');
  await sleep(700);
  const before = await page.evaluate(() => document.getElementById('vstage').scrollLeft);
  const box = await page.evaluate(() => {
    const r = document.getElementById('vstage').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x - 220, box.y, { steps: 8 });
  await page.mouse.up();
  await sleep(400);
  const after = await page.evaluate(() => document.getElementById('vstage').scrollLeft);
  await page.select('#v-zoom-sel', 'fit');
  log('pan by drag moves the stage', after > before, `${before} -> ${after}`);
});

await step('arrow navigation changes /view path', async () => {
  const before = await url(page);
  await page.keyboard.press('ArrowRight');
  await sleep(900);
  const after = await url(page);
  const counter = await page.evaluate(() => {
    const el = document.getElementById('v-counter');
    return el ? el.textContent.trim() : null;
  });
  log('arrow navigation changes /view path', before !== after && /\d+ \/ \d+/.test(counter || ''), `${before} -> ${after} counter=${counter}`);
});

await step('escape closes viewer and clears /view path', async () => {
  await page.keyboard.press('Escape');
  const closed = await waitFor(page, () => {
    const v = document.getElementById('viewer');
    return !!v && !v.classList.contains('show');
  }, 5000);
  const u = await url(page);
  log('escape closes viewer and clears /view path', closed && !u.startsWith('/view'), u);
});

await browser.close();

// Click through the staged-apply flow: header button → 分批操作 modal → 应用 → optional replace confirm.
async function closeModals(page) {
  for (let i = 0; i < 4; i += 1) {
    const open = await page.evaluate(() =>
      [...document.querySelectorAll('.ant-modal')].some((m) => m.offsetParent !== null),
    );
    if (!open) break;
    await page.keyboard.press('Escape');
    await sleep(350);
  }
  // Masks fade out after the modal unmounts; wait until the page is clickable again.
  await waitFor(
    page,
    () =>
      ![...document.querySelectorAll('.ant-modal-root,.ant-modal-mask,.ant-modal-wrap')].some(
        (m) => m.offsetParent !== null,
      ),
    5000,
  );
  await sleep(200);
}

async function openStagedModal(page, buttonText) {
  const shown = await clickUntil(
    page,
    textFinder('button', buttonText),
    () => modalShowing(page, '分批操作'),
    `open staged (${buttonText})`,
  );
  if (!shown) throw new Error(`staged modal did not open via ${buttonText}: ${await visibleModalText(page)}`);
}

async function applyStaged(page) {
  const clicked = [];
  await closeModals(page);
  await openStagedModal(page, '分批列表');
  await clickByText(page, '.ant-modal button', '应用');
  clicked.push('应用');
  for (let round = 0; round < 3; round += 1) {
    const confirmed = await page.evaluate(() => {
      const m = [...document.querySelectorAll('.ant-modal')].find((x) => x.offsetParent !== null);
      if (!m || !/目标已存在/.test(m.textContent)) return null;
      const btn = [...m.querySelectorAll('button')].find((b) =>
        /确定/.test(b.textContent.replace(/\s+/g, '')),
      );
      if (!btn) return null;
      btn.click();
      return '目标已存在→确定';
    });
    if (!confirmed) break;
    clicked.push(confirmed);
    await sleep(900);
  }
  await sleep(800);
  const remaining = await page.evaluate(() =>
    fetch('/api/stage/list').then((r) => r.json()).then((l) => l.length),
  );
  return { clicked, remaining };
}

// ── writable instance: staged ops, trash, exif edit ──────────────────────────
const browser2 = await launch();
const wp = await browser2.newPage();
instrument(wp, 'write');
await fetch(`${WRITE}/api/stage/clear`, { method: 'POST' });
await wp.goto(`${WRITE}/`, { waitUntil: 'domcontentloaded' });
await waitFor(wp, () => {
  const imgs = [...document.querySelectorAll('.card img')];
  return imgs.length > 0 && imgs.filter((i) => i.naturalWidth > 0).length >= 3;
});

const firstSp = await wp.evaluate(() => document.querySelector('.card').getAttribute('data-sp'));
const TAG = `PV${Date.now().toString(36).toUpperCase().slice(-6)}`;
const renamedSp = `${firstSp.split('/').slice(0, -1).join('/')}/${TAG}_RENAMED.jpg`;

// Right-click the middle of the first card's thumbnail (away from checkbox and badges).
async function rightClickFirstCard() {
  await waitIdle(wp);
  const point = await wp.evaluate(() => {
    const r = document.querySelector('.card').getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height * 0.35) };
  });
  await wp.mouse.click(point.x, point.y, { button: 'right' });
  return point;
}

await step('context menu offers write actions', async () => {
  let items = null;
  for (let attempt = 0; attempt < 3 && !items; attempt += 1) {
    await rightClickFirstCard();
    items = await waitFor(wp, () => {
      const m = document.querySelector('.card-context-menu.show');
      return m ? m.innerText.replace(/\s+/g, ' ').trim() : null;
    }, 3000);
  }
  await shot(wp, '08-context-menu');
  log('context menu offers write actions', !!items && /删除/.test(items) && /重命名/.test(items) && /复制/.test(items), items);
  await wp.keyboard.press('Escape');
});

await step('rename stages an op and badges the card', async () => {
  await rightClickFirstCard();
  const menuOk = await waitFor(wp, () => {
    const m = document.querySelector('.card-context-menu.show');
    return !!m && /重命名/.test(m.innerText);
  }, 4000);
  if (!menuOk) throw new Error('context menu missing');
  await clickByText(wp, '.card-context-menu.show button', '重命名');
  const modalOk = await waitFor(wp, () => {
    const m = [...document.querySelectorAll('.ant-modal')].find((x) => x.offsetParent !== null);
    return !!m && /重命名/.test(m.textContent) && !!m.querySelector('input');
  }, 6000);
  if (!modalOk) throw new Error('rename modal did not open');
  await typeIntoVisibleModal(wp, 0, renamedSp.split('/').pop());
  await clickByText(wp, '.ant-modal button', '确定');
  const badge = await waitFor(wp, () => {
    const b = [...document.querySelectorAll('.badge.rename')];
    return b.length > 0 ? b.map((x) => x.textContent).join(',') : null;
  }, 6000);
  const stagedOp = await wp.evaluate(() =>
    fetch('/api/stage/list').then((r) => r.json()).then((l) => JSON.stringify(l)),
  );
  await shot(wp, '09-staged-rename');
  log(
    'rename stages an op and badges the card',
    !!badge && stagedOp.includes(TAG),
    `badge=${badge} ops=${stagedOp.slice(0, 160)}`,
  );
});

await step('staged list modal shows pending op', async () => {
  await closeModals(wp);
  await openStagedModal(wp, '分批列表');
  const content = await waitFor(wp, () => {
    const m = [...document.querySelectorAll('.ant-modal')].find((x) => x.offsetParent !== null);
    if (!m) return null;
    const txt = m.textContent.replace(/\s+/g, '');
    return /_RENAMED\.jpg/.test(txt) && /分批操作/.test(txt) ? txt.slice(0, 160) : null;
  }, 6000);
  await shot(wp, '10-staged-modal');
  await closeModals(wp);
  log('staged list modal shows pending op', !!content, content);
});

await step('apply stage renames on disk', async () => {
  const { clicked, remaining } = await applyStaged(wp);
  const reloaded = await wp.evaluate(
    (tag) =>
      fetch('/api/photos?sort=date-asc')
        .then((r) => r.json())
        .then((list) => list.some((p) => (p.folder + '/' + p.filename).includes(tag))),
    TAG,
  );
  await shot(wp, '11-after-apply');
  log(
    'apply stage renames on disk',
    reloaded && remaining === 0,
    `clicked=${clicked.join('>')} remaining=${remaining} present=${reloaded}`,
  );
});

await step('viewer delete -> staged pill -> apply -> trash -> restore', async () => {
  const victim = await wp.evaluate(
    (tag) =>
      fetch('/api/photos?sort=date-asc')
        .then((r) => r.json())
        .then((list) => {
          const p = list.find((x) => (x.folder + '/' + x.filename).includes(tag));
          return p ? p.folder + '/' + p.filename : null;
        }),
    TAG,
  );
  if (!victim) throw new Error('renamed file missing');
  await wp.goto(`${WRITE}/view/${encodeURI(victim)}`, { waitUntil: 'domcontentloaded' });
  const opened = await waitFor(wp, () => {
    const v = document.getElementById('viewer');
    return !!v && v.classList.contains('show');
  });
  if (!opened) throw new Error('viewer did not open for victim');
  await waitIdle(wp);
  await wp.keyboard.press('d');
  const pill = await waitFor(wp, () => {
    const el = document.getElementById('v-staged-pill');
    return el && el.classList.contains('show') ? el.textContent.trim() : null;
  }, 6000);
  await shot(wp, '12-viewer-staged-delete');
  await wp.keyboard.press('Escape');
  await waitFor(wp, () => {
    const v = document.getElementById('viewer');
    return !v || !v.classList.contains('show');
  }, 5000);
  await sleep(400);
  const firstApply = await applyStaged(wp);
  const gone = await wp.evaluate(
    (sp) => fetch('/api/photos?sort=date-asc').then((r) => r.json()).then((l) => !l.some((p) => p.folder + '/' + p.filename === sp)),
    victim,
  );
  const trash = await wp.evaluate(() => fetch('/api/trash/list').then((r) => r.json()));
  await closeModals(wp);
  await clickUntil(
    wp,
    textFinder('button', '回收站'),
    () => modalShowing(wp, '回收站'),
    'open trash',
  );
  const trashUi = await waitFor(wp, () => {
    const m = [...document.querySelectorAll('.ant-modal')].find((x) => x.offsetParent !== null);
    return m && /恢复/.test(m.textContent) ? m.textContent.replace(/\s+/g, ' ').slice(0, 100) : null;
  }, 6000);
  await shot(wp, '13-trash-modal');
  const restoreBtn = await wp.evaluate((sp) => {
    const m = [...document.querySelectorAll('.ant-modal')].find((x) => x.offsetParent !== null);
    if (!m) return null;
    // 回收站里可能还有别的条目（上一个用例的残留），必须点 victim 那一行的恢复
    const row = [...m.querySelectorAll('.trash-item')].find((r) => r.textContent.includes(sp));
    if (!row) return null;
    const btn = [...row.querySelectorAll('button')].find((b) => /恢复/.test(b.textContent.replace(/\s+/g, '')));
    if (!btn) return null;
    btn.click();
    return `${sp} -> ${btn.textContent.trim()}`;
  }, victim);
  await sleep(700);
  if (!trash.some((t) => t.original === victim)) throw new Error(`victim not in trash: ${victim}`);
  const secondApply = await applyStaged(wp);
  const back = await wp.evaluate(
    (sp) => fetch('/api/photos?sort=date-asc').then((r) => r.json()).then((l) => l.some((p) => p.folder + '/' + p.filename === sp)),
    victim,
  );
  log(
    'viewer delete -> staged pill -> apply -> trash -> restore',
    pill === '待删除' && firstApply.remaining === 0 && gone && !!trashUi && !!restoreBtn && secondApply.remaining === 0 && back,
    JSON.stringify({
      pill,
      gone,
      trashUi: !!trashUi,
      restoreBtn,
      back,
      remaining: [firstApply.remaining, secondApply.remaining],
    }),
  );
});

await step('exif edit modal saves override', async () => {
  const target = await wp.evaluate(() =>
    fetch('/api/photos?sort=date-asc').then((r) => r.json()).then((l) => l[0].folder + '/' + l[0].filename),
  );
  await wp.goto(`${WRITE}/view/${encodeURI(target)}`, { waitUntil: 'domcontentloaded' });
  await waitFor(wp, () => {
    const v = document.getElementById('viewer');
    return !!v && v.classList.contains('show');
  });
  await clickByText(wp, '#vtoolbar button', '编辑');
  const modalOk = await waitFor(wp, () => {
    const m = [...document.querySelectorAll('.ant-modal')].find((x) => x.offsetParent !== null);
    return !!m && /EXIF/i.test(m.textContent) && m.querySelectorAll('input').length > 0;
  }, 6000);
  if (!modalOk) throw new Error('exif modal missing');
  await typeIntoVisibleModal(wp, 0, '2030-01-02');
  await typeIntoVisibleModal(wp, 1, '03:04:05');
  const before = await visibleModalInputs(wp, 0);
  await clickByText(wp, '.ant-modal button', '加入分批');
  const badge = await waitFor(wp, () => {
    const el = [...document.querySelectorAll('.badge.exif')];
    return el.length ? el[0].textContent.trim() : null;
  }, 6000);
  await shot(wp, '14-exif-edit');
  const stagedOp = await wp.evaluate(() =>
    fetch('/api/stage/list')
      .then((r) => r.json())
      .then((ops) => JSON.stringify(ops.filter((o) => o.kind === 'exif').slice(0, 1))),
  );
  log(
    'exif edit modal saves override',
    !!badge && /2030/.test(String(before)) && /"kind":"exif"/.test(stagedOp),
    `badge=${badge} dateInput=${before} ${stagedOp}`,
  );
});

await step('bulk select + shift range + delete to staged', async () => {
  await wp.goto(`${WRITE}/`, { waitUntil: 'domcontentloaded' });
  await waitFor(wp, () => document.querySelectorAll('.card').length > 3);
  const selectedCount = () => wp.evaluate(() => document.querySelectorAll('.card.selected').length);
  const picked = () =>
    wp.evaluate(() => [...document.querySelectorAll('.card.selected')].map((c) => c.getAttribute('data-sp')).join(','));
  const points = [await cardPoint(wp, 0, 'thumb'), await cardPoint(wp, 2, 'thumb')];
  await waitIdle(wp);
  await wp.keyboard.down('Control');
  await wp.mouse.click(points[0].x, points[0].y);
  await wp.keyboard.up('Control');
  await sleep(500);
  const afterCtrl = await selectedCount();
  await waitIdle(wp);
  await wp.keyboard.down('Shift');
  await wp.mouse.click(points[1].x, points[1].y);
  await wp.keyboard.up('Shift');
  await sleep(600);
  const selected = await selectedCount();
  const statsLine = await wp.evaluate(() => {
    const el = [...document.querySelectorAll('body *')].find(
      (n) => n.children.length === 0 && /已选 \d+ 张/.test(n.textContent),
    );
    return el ? el.textContent.trim() : null;
  });
  await shot(wp, '15-bulk-select');
  log(
    'bulk select + shift range + delete to staged',
    afterCtrl === 1 && selected === 3 && /已选 3 张/.test(statsLine || ''),
    `afterCtrl=${afterCtrl} selected=${selected} stats=${statsLine} picked=${await picked()}`,
  );
  await clickByText(wp, 'button', '批量删除');
  await sleep(1500);
  const stagedCount = await wp.evaluate(() => document.querySelectorAll('.card.staged-delete').length);
  log('bulk delete stages 3 cards', stagedCount === 3, `staged-delete=${stagedCount}`);
  await wp.evaluate(() => fetch('/api/stage/clear', { method: 'POST' }));
});

await step('admin set dir endpoint respected', async () => {
  const allow = await wp.evaluate(() => fetch('/api/admin/allow_set_dir').then((r) => r.json()));
  const labels = await wp.evaluate(() => document.body.innerText);
  log('admin set dir endpoint respected', typeof allow.allowed === 'boolean', JSON.stringify(allow) + ' 目录按钮=' + labels.includes('目录'));
});

console.log('\n===== SUMMARY =====');
const failed = results.filter((r) => !r.ok);
console.log(`total=${results.length} pass=${results.length - failed.length} fail=${failed.length}`);
failed.forEach((f) => console.log(`FAILED: ${f.name} | ${f.detail}`));
console.log('console/page errors:', consoleErrors.length ? consoleErrors.slice(0, 12) : 'none');
fs.writeFileSync(`${OUT}/report.json`, JSON.stringify({ results, consoleErrors }, null, 2));
// 不关掉第二个浏览器，容器里的 node 就永远挂着，suite.sh 的管道拿不到 EOF
await browser2.close();
