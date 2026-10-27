// 临时探针：行级窗口的 padding/列数/行高是否自洽
import puppeteer from 'puppeteer-core';

const BASE = process.env.BASE || 'http://10.88.1.1';
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/usr/bin/chromium-browser',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  defaultViewport: { width: 1600, height: 1000 },
});
const page = await browser.newPage();
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.querySelectorAll('.card').length > 0, { timeout: 60000 });
await page.waitForFunction(() => !document.querySelector('#loading.show'), { timeout: 60000 });

const sample = (label) =>
  page.evaluate((name) => {
    const wrap = document.querySelector('.grid-window');
    const grid = document.querySelector('.grid');
    const card = grid?.firstElementChild;
    const cards = [...(grid?.children || [])];
    const tops = [...new Set(cards.map((c) => Math.round(c.getBoundingClientRect().top)))];
    const style = getComputedStyle(grid);
    const cs = getComputedStyle(wrap);
    return {
      [name]: {
        scrollY: Math.round(document.scrollingElement.scrollTop),
        docHeight: document.scrollingElement.scrollHeight,
        padTop: cs.paddingTop,
        padBottom: cs.paddingBottom,
        wrapTop: Math.round(wrap.getBoundingClientRect().top),
        wrapH: Math.round(wrap.getBoundingClientRect().height),
        cards: cards.length,
        rows: tops.length,
        cardH: card ? Math.round(card.getBoundingClientRect().height * 100) / 100 : null,
        cardW: card ? Math.round(card.getBoundingClientRect().width * 100) / 100 : null,
        tracks: style.gridTemplateColumns.split(' ').length,
        gap: style.rowGap,
        width: grid.clientWidth,
      },
    };
  }, label);

const out = {};
Object.assign(out, await sample('freshTop'));
await page.evaluate(() => document.scrollingElement.scrollBy(0, 600));
await new Promise((r) => setTimeout(r, 800));
Object.assign(out, await sample('topAgain'));
await page.evaluate(() => document.scrollingElement.scrollTop = 40000);
await new Promise((r) => setTimeout(r, 800));
Object.assign(out, await sample('mid'));
await page.evaluate(() => document.scrollingElement.scrollTop = 0);
await new Promise((r) => setTimeout(r, 800));
Object.assign(out, await sample('backToTop'));
console.log(JSON.stringify(out, null, 2));
await browser.close();
