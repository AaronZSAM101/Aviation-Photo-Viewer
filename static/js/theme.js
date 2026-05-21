// 主题切换：自动 / 亮 / 暗 三态循环
//
// 状态来源：
//   - localStorage.theme = "light" | "dark"  → 手动覆盖
//   - 不存在或其他值                          → 自动（CSS 走 prefers-color-scheme media query）
//
// 注意：FOUC 防护在 index.html <head> 内联脚本里已经做过（CSS 加载前同步设
// data-theme），本模块只负责按钮 UI 与循环切换。

const ICON = { auto: '◐', light: '☀', dark: '☾' };
const LABEL = { auto: '自动', light: '亮色', dark: '暗色' };
const ORDER = ['auto', 'light', 'dark']; // 点击循环顺序

function readCurrent() {
  try {
    const t = localStorage.getItem('theme');
    if (t === 'light' || t === 'dark') return t;
  } catch (e) {}
  return 'auto';
}

function apply(mode) {
  if (mode === 'auto') {
    document.documentElement.removeAttribute('data-theme');
    try { localStorage.removeItem('theme'); } catch (e) {}
  } else {
    document.documentElement.setAttribute('data-theme', mode);
    try { localStorage.setItem('theme', mode); } catch (e) {}
  }
}

function updateButton(btn, mode) {
  btn.textContent = ICON[mode];
  const next = ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length];
  btn.title = `当前：${LABEL[mode]}（点击切到 ${LABEL[next]}）`;
  btn.setAttribute('aria-label', `主题：${LABEL[mode]}`);
}

export function initTheme() {
  const btn = document.getElementById('btn-theme');
  if (!btn) return;

  // 首次同步按钮显示
  updateButton(btn, readCurrent());

  btn.addEventListener('click', () => {
    const cur  = readCurrent();
    const next = ORDER[(ORDER.indexOf(cur) + 1) % ORDER.length];
    apply(next);
    updateButton(btn, next);
  });
}
