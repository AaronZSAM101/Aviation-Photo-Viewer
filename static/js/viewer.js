// 全屏查看器：图像显示、导航、信息面板、直方图、网格 overlay、污点检查
import { dom, state, $ } from './state.js';
import {
  subpath, previewUrl, fmt_size, fmt_megapixels, hasAnyExif,
} from './utils.js';
import { stageSingleDelete } from './api.js';
import { updateCardStagedIndicators } from './render.js';
import { syncRoute } from './router.js';

export function openViewer(idx) {
  state.viewerIndex = idx;
  // 每次打开都重置切换状态
  state.equalizeOn = false;
  state.gridOn     = false;
  state.fineGridOn = false;
  state.rgbOn      = false;
  state.histOn     = false;
  state.infoOn     = true;
  syncToggleButtons();
  dom.viewer.classList.add('show');
  showCurrent();
  syncRoute();
}

export function closeViewer() {
  dom.viewer.classList.remove('show');
  if (dom.vCharts && dom.vCharts.parentElement !== dom.vStage) {
    dom.vStage.appendChild(dom.vCharts);
  }
  dom.vImg.src = '';
  dom.vCanvas.width = dom.vCanvas.height = 0;
  syncRoute();
}

export function navigate(delta) {
  const n = state.filteredPhotos.length;
  if (!n) return;
  const ni = Math.max(0, Math.min(n - 1, state.viewerIndex + delta));
  if (ni === state.viewerIndex) return;
  state.viewerIndex = ni;
  showCurrent();
  syncRoute();
}

function showCurrent() {
  const p = state.filteredPhotos[state.viewerIndex];
  if (!p) return;
  dom.vName.textContent    = p.folder ? `${p.folder} / ${p.filename}` : p.filename;
  dom.vCounter.textContent = `${state.viewerIndex + 1} / ${state.filteredPhotos.length}`;
  dom.vPrev.disabled = state.viewerIndex === 0;
  dom.vNext.disabled = state.viewerIndex === state.filteredPhotos.length - 1;

  // 切换照片时重置 equalize，保留 grid/info
  state.equalizeOn = false;
  syncToggleButtons();
  dom.vImg.style.display    = '';
  dom.vCanvas.style.display = 'none';
  dom.vSpin.classList.add('show');

  dom.vImg.onload = () => {
    dom.vSpin.classList.remove('show');
    fitGridToImage();
    adjustVinfoHeight();
    adjustVchartsPosition();
    refreshHistograms();
    prefetchAdjacent();
  };
  dom.vImg.onerror = () => { dom.vSpin.classList.remove('show'); };
  dom.vImg.src = previewUrl(p);

  renderInfoPanel(p);
  updateViewerStagedIndicator();
  if (!p.exif.lens_model) refreshLensModel(p);
}

async function refreshLensModel(p) {
  const sp = subpath(p);
  try {
    const res = await fetch('/api/exif/lens/' + encodeURIComponent(sp).replace(/%2F/g, '/'));
    if (!res.ok) return;
    const data = await res.json();
    const lens = data?.lens_model;
    if (!lens) return;
    const currentSp = currentViewerSubpath();
    if (currentSp !== sp) return;
    p.exif.lens_model = lens;
    renderInfoPanel(p);
  } catch {
    // 兜底失败时不打断主流程
  }
}

// 预取左右两张到浏览器缓存，让导航看起来"瞬时"
function prefetchAdjacent() {
  [state.viewerIndex - 1, state.viewerIndex + 1].forEach(i => {
    const p = state.filteredPhotos[i];
    if (!p) return;
    const url = previewUrl(p);
    if (state.prefetchedPreviewUrls.has(url)) return;
    state.prefetchedPreviewUrls.add(url);
    if (state.prefetchedPreviewUrls.size > 80) {
      const first = state.prefetchedPreviewUrls.values().next().value;
      if (first) state.prefetchedPreviewUrls.delete(first);
    }
    const img = new Image();
    img.src = url;
  });
}

export function currentViewerSubpath() {
  const p = state.filteredPhotos[state.viewerIndex];
  return p ? subpath(p) : null;
}

export function updateViewerStagedIndicator() {
  const sp = currentViewerSubpath();
  const isStaged = !!(sp && state.stagedDeletes.has(sp));
  dom.vDeleteBtn.classList.toggle('staged', isStaged);
  dom.vDeleteBtn.textContent = isStaged ? '取消删除' : '删除';
  dom.vStagedPill.classList.toggle('show', isStaged);
}

export function refreshCurrentViewer(targetSubpath = null) {
  if (!dom.viewer.classList.contains('show')) return;
  const sp = targetSubpath || currentViewerSubpath();
  if (!sp) return;
  const idx = state.filteredPhotos.findIndex(p => subpath(p) === sp);
  if (idx < 0) return;
  state.viewerIndex = idx;
  showCurrent();
}

export async function viewerToggleDelete() {
  if (state.readOnly) {
    alert('当前为只读模式，管理操作已禁用');
    return;
  }
  const sp = currentViewerSubpath();
  if (!sp) return;
  if (state.stagedDeletes.has(sp)) {
    try {
      const res  = await fetch('/api/stage/list');
      const list = await res.json();
      const op = list.find(o => o.kind === 'delete' && o.src === sp);
      if (op) await fetch('/api/stage/remove/' + op.id, { method: 'POST' });
      state.stagedDeletes.delete(sp);
    } catch (e) { alert('取消删除失败: ' + e.message); return; }
  } else {
    await stageSingleDelete(sp);
  }
  updateCardStagedIndicators();
  updateViewerStagedIndicator();
}

function renderInfoPanel(p) {
  const e = p.exif, hasExif = hasAnyExif(e);
  const sections = [
    { title: '基本信息', rows: [
      ['文件名',   p.filename],
      ['文件夹',   p.folder || '(根目录)'],
      ['大小',     fmt_size(p.size)],
      ['分辨率',   e.image_width && e.image_height ? `${e.image_width} × ${e.image_height} px` : null],
      ['像素总数', fmt_megapixels(e.image_width, e.image_height)],
    ]},
    hasExif && { title: '拍摄时间', rows: [['拍摄时间', e.date_taken]] },
    hasExif && (e.make || e.model || e.lens_model || e.software) && { title: '相机', rows: [
      ['品牌', e.make], ['型号', e.model], ['镜头', e.lens_model], ['软件', e.software],
    ]},
    hasExif && (e.iso || e.exposure_time || e.f_number || e.focal_length) && { title: '曝光参数', rows: [
      ['ISO',    e.iso], ['快门', e.exposure_time], ['光圈', e.f_number],
      ['焦距',   e.focal_length], ['等效焦距', e.focal_length_35mm],
      ['曝光补偿', e.exposure_bias], ['测光模式', e.metering_mode],
      ['白平衡', e.white_balance], ['闪光灯', e.flash],
    ]},
    hasExif && e.gps_lat != null && { title: 'GPS', rows: [
      ['纬度', e.gps_lat?.toFixed(6) + '°'],
      ['经度', e.gps_lon?.toFixed(6) + '°'],
    ]},
  ].filter(Boolean);

  const sectionsHTML = sections.map(s => `
    <div class="sec">
      <div class="sec-title">${s.title}</div>
      ${s.rows.filter(([, v]) => v != null).map(([k, v]) => `
        <div class="row"><span class="rk">${k}</span><span class="rv">${v}</span></div>
      `).join('')}
    </div>`).join('')
    + (!hasExif ? '<div class="no-exif-note">此文件不含 EXIF 数据</div>' : '');
  // 用 .vinfo-sections 外壳把所有 sec 包起来，
  // 这样在横向布局（手机竖屏 charts-open / 手机横屏 / 桌面）下，
  // 整组 EXIF 才是 #vinfo 的"一个 flex 列"，不会被拆成多列。
  dom.vInfo.innerHTML = `<div class="vinfo-sections">${sectionsHTML}</div>`;
  syncChartHost();
}

function syncChartHost() {
  if (!dom.vCharts || !dom.vInfo || !dom.vStage) return;
  // charts 永远托管在 vinfo 里（不管 EXIF 是否打开），避免浮在 vstage 上挡照片。
  // vinfo 容器本身的可见性由 syncToggleButtons 控制（infoOn || chartCount>0）。
  const host = dom.vInfo;
  if (dom.vCharts.parentElement !== host) {
    host.prepend(dom.vCharts);
  }
  dom.vCharts.classList.add('in-info');
}

// ── 污点检查：每通道直方图均衡（JetPhotos 风格）─────────────────────────
export function applyEqualize() {
  if (!dom.vImg.complete || !dom.vImg.naturalWidth) return;
  const w = dom.vImg.naturalWidth, h = dom.vImg.naturalHeight;
  const MAX = 2400;
  const scale = Math.min(1, MAX / Math.max(w, h));
  const cw = Math.round(w * scale), ch_ = Math.round(h * scale);
  dom.vCanvas.width  = cw;
  dom.vCanvas.height = ch_;
  const ctx = dom.vCanvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(dom.vImg, 0, 0, cw, ch_);
  let imgData;
  try       { imgData = ctx.getImageData(0, 0, cw, ch_); }
  catch (err){ console.warn('getImageData failed', err); return; }
  const data = imgData.data, total = cw * ch_;

  for (let c = 0; c < 3; c++) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < total; i++) hist[data[i * 4 + c]]++;
    const cdf = new Uint32Array(256);
    let acc = 0;
    for (let i = 0; i < 256; i++) { acc += hist[i]; cdf[i] = acc; }
    let cdfMin = 0;
    for (let i = 0; i < 256; i++) if (cdf[i] > 0) { cdfMin = cdf[i]; break; }
    const denom = total - cdfMin;
    const lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) {
      lut[i] = denom > 0 ? Math.round((cdf[i] - cdfMin) / denom * 255) : i;
    }
    for (let i = 0; i < total; i++) data[i * 4 + c] = lut[data[i * 4 + c]];
  }
  ctx.putImageData(imgData, 0, 0);
  dom.vImg.style.display    = 'none';
  dom.vCanvas.style.display = 'block';
}

export function disableEqualize() {
  dom.vCanvas.style.display = 'none';
  dom.vImg.style.display    = '';
}

// ── 网格 overlay 贴合显示中的图像矩形 ─────────────────────────────────────
export function fitGridToImage() {
  const img = (dom.vCanvas.style.display === 'block') ? dom.vCanvas : dom.vImg;
  if (!img || !img.getBoundingClientRect) return;
  const stage  = dom.vStage.getBoundingClientRect();
  const r      = img.getBoundingClientRect();
  const fineGridX = Math.max(4, r.width  * 25 / 1024);
  const fineGridY = Math.max(4, r.height * 25 / 683);
  const styles = {
    left:   (r.left - stage.left) + 'px',
    top:    (r.top  - stage.top ) + 'px',
    width:  r.width  + 'px',
    height: r.height + 'px',
  };
  Object.assign(dom.vGrid.style,     styles);
  Object.assign(dom.vFineGrid.style, styles);
  dom.vFineGrid.style.setProperty('--fine-grid-x', fineGridX + 'px');
  dom.vFineGrid.style.setProperty('--fine-grid-y', fineGridY + 'px');
}

// ── 直方图 ────────────────────────────────────────────────────────────────
function getDisplaySource() {
  return (dom.vCanvas.style.display === 'block') ? dom.vCanvas : dom.vImg;
}

function computeHistograms() {
  const src = getDisplaySource();
  if (!src) return null;
  const w = src.naturalWidth || src.width;
  const h = src.naturalHeight || src.height;
  if (!w || !h) return null;
  const MAX = 512;
  const s = Math.min(1, MAX / Math.max(w, h));
  const cw  = Math.max(1, Math.round(w * s));
  const ch_ = Math.max(1, Math.round(h * s));
  const tmp = document.createElement('canvas');
  tmp.width = cw; tmp.height = ch_;
  const ctx = tmp.getContext('2d', { willReadFrequently: true });
  let data;
  try {
    ctx.drawImage(src, 0, 0, cw, ch_);
    data = ctx.getImageData(0, 0, cw, ch_).data;
  } catch (e) { return null; }
  const r = new Uint32Array(256), g = new Uint32Array(256),
        b = new Uint32Array(256), L = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) {
    const R = data[i], G = data[i + 1], B = data[i + 2];
    r[R]++; g[G]++; b[B]++;
    const y = Math.min(255, (0.299 * R + 0.587 * G + 0.114 * B) | 0);
    L[y]++;
  }
  return { r, g, b, L };
}

function buildAreaPath(values, vbW, vbH, peak) {
  const trimmed = Math.max(1, peak);
  let d = `M 0 ${vbH} L 0 ${(vbH - values[0] / trimmed * vbH).toFixed(2)}`;
  for (let i = 1; i < 256; i++) {
    const x = (i / 255) * vbW;
    const y = vbH - Math.min(values[i], trimmed) / trimmed * vbH;
    d += ` L ${x.toFixed(2)} ${y.toFixed(2)}`;
  }
  d += ` L ${vbW} ${vbH} Z`;
  return d;
}

function peakOf(arr) {
  // 99.5 分位数：抑制 0/255 处的尖刺
  const sorted = Array.from(arr).slice(1, 255).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.995)] || Math.max(...arr);
}

export function refreshHistograms() {
  if (!state.rgbOn && !state.histOn) return;
  const h = computeHistograms();
  if (!h) return;
  if (state.rgbOn) {
    const peak = Math.max(peakOf(h.r), peakOf(h.g), peakOf(h.b));
    $('rgb-r').setAttribute('d', buildAreaPath(h.r, 256, 100, peak));
    $('rgb-g').setAttribute('d', buildAreaPath(h.g, 256, 100, peak));
    $('rgb-b').setAttribute('d', buildAreaPath(h.b, 256, 100, peak));
  }
  if (state.histOn) {
    const peak = peakOf(h.L);
    $('hist-l').setAttribute('d', buildAreaPath(h.L, 256, 100, peak));
  }
}

// ── 切换按钮同步 ──────────────────────────────────────────────────────────
export function syncToggleButtons() {
  dom.vEqBtn.classList.toggle('active',       state.equalizeOn);
  dom.vGridBtn.classList.toggle('active',     state.gridOn);
  dom.vFineGridBtn.classList.toggle('active', state.fineGridOn);
  dom.vRgbBtn.classList.toggle('active',      state.rgbOn);
  dom.vHistBtn.classList.toggle('active',     state.histOn);
  dom.vInfoBtn.classList.toggle('active',     state.infoOn);
  dom.vGrid.classList.toggle('show',          state.gridOn);
  dom.vFineGrid.classList.toggle('show',      state.fineGridOn);
  dom.vRgbPanel.classList.toggle('show',      state.rgbOn);
  dom.vHistPanel.classList.toggle('show',     state.histOn);
  const chartCount = (state.rgbOn ? 1 : 0) + (state.histOn ? 1 : 0);
  // vinfo 容器可见：EXIF 开 或 任一 chart 开（charts 留在 vinfo 里，不浮回照片上）
  dom.vInfo.classList.toggle('show', state.infoOn || chartCount > 0);
  // exif-on：EXIF 文本区是否显示（独立于容器可见性）
  dom.vInfo.classList.toggle('exif-on', state.infoOn);
  syncChartHost();
  // vstage padding：info-open 现在等价于"vinfo 容器可见"；
  // exif-on-stage 单独标记 EXIF 文本是否显示，让 CSS 在仅 charts 时缩小 vstage padding
  dom.vStage.classList.toggle('info-open',    state.infoOn || chartCount > 0);
  dom.vStage.classList.toggle('exif-on-stage', state.infoOn);
  dom.vStage.classList.toggle('chart-open-one', chartCount === 1);
  dom.vStage.classList.toggle('chart-open-two', chartCount === 2);
  // mark vInfo when charts are visible so layout can adapt (EXIF full width when none)
  if (dom.vInfo) dom.vInfo.classList.toggle('charts-open', chartCount > 0);
  // Ensure v-charts visibility and pointer events when any chart is open
  if (dom.vCharts) {
    if (chartCount > 0) {
      dom.vCharts.style.display = 'flex';
      dom.vCharts.style.pointerEvents = 'auto';
    } else {
      dom.vCharts.style.display = '';
      dom.vCharts.style.pointerEvents = 'none';
    }
    // ensure each panel has correct .show class (in case toggles were missed)
    dom.vRgbPanel && dom.vRgbPanel.classList.toggle('show', state.rgbOn);
    dom.vHistPanel && dom.vHistPanel.classList.toggle('show', state.histOn);
  }
  // Ensure EXIF panel height doesn't overlap image on small/portrait screens
  try { adjustVinfoHeight(); } catch (e) { /* noop */ }
  try { adjustVchartsPosition(); } catch (e) { /* noop */ }
}

// 限制竖屏下 EXIF 面板最大高度，使其不高于当前图片底端
function adjustVinfoHeight() {
  if (!dom.vInfo) return;
  const isMobilePortrait = window.matchMedia('(max-width: 900px) and (orientation: portrait)').matches;
  if (!isMobilePortrait) {
    dom.vInfo.style.maxHeight = '';
    return;
  }
  const imgEl = (dom.vCanvas.style.display === 'block') ? dom.vCanvas : dom.vImg;
  if (!imgEl || !imgEl.getBoundingClientRect) return;
  const r = imgEl.getBoundingClientRect();
  const availBelow = Math.floor(window.innerHeight - r.bottom - 8); // 8px safety gap
  // if no space below image, collapse max-height to 0 to avoid overlap
  const maxH = Math.max(0, availBelow);
  dom.vInfo.style.maxHeight = maxH + 'px';
}

window.addEventListener('resize', adjustVinfoHeight);
window.addEventListener('orientationchange', adjustVinfoHeight);

// Ensure charts floating in stage don't extend below the top of the image,
// 但如果图像太高没有空间容纳 charts，则让 charts 直接覆盖在图像上沿，
// 避免把整个 #v-charts 推出屏幕（会导致 RGB 整张看不见）。
function adjustVchartsPosition() {
  if (!dom.vCharts || !dom.vStage) return;
  // if charts are moved into info host, let normal layout handle them
  if (dom.vCharts.classList.contains('in-info')) {
    dom.vCharts.style.transform = '';
    return;
  }
  // 先清掉之前可能留下的 transform，再测量原始位置
  dom.vCharts.style.transform = '';
  const imgEl = (dom.vCanvas.style.display === 'block') ? dom.vCanvas : dom.vImg;
  if (!imgEl || !imgEl.getBoundingClientRect) return;
  const stageRect  = dom.vStage.getBoundingClientRect();
  const imgRect    = imgEl.getBoundingClientRect();
  const chartsRect = dom.vCharts.getBoundingClientRect();
  // gap to keep between chart bottom and image top
  const GAP = 8;
  const overlap = (chartsRect.bottom) - (imgRect.top - GAP);
  if (overlap <= 0) return;
  // 至多把 charts 推到 stage 顶部 — 再往上就出屏了
  const headroom = Math.max(0, chartsRect.top - stageRect.top);
  const shift = Math.min(Math.ceil(overlap), headroom);
  if (shift > 0) {
    dom.vCharts.style.transform = `translateY(-${shift}px)`;
  }
}

window.addEventListener('resize', () => { adjustVchartsPosition(); adjustVinfoHeight(); });
window.addEventListener('orientationchange', () => { adjustVchartsPosition(); adjustVinfoHeight(); });
