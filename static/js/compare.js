import { dom, state } from './state.js';
import { encodePath, previewUrl, subpath } from './utils.js';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function photosByPath() {
  return new Map(state.photos.map(p => [subpath(p), p]));
}

function selectedPair() {
  const selected = [...state.selectedSubpaths];
  if (selected.length !== 2) return null;
  const byPath = photosByPath();
  const a = byPath.get(selected[0]);
  const b = byPath.get(selected[1]);
  if (!a || !b) return null;
  return { a, b, aPath: selected[0], bPath: selected[1] };
}

function similarityLabel(distance) {
  if (distance === 0) return { label: '感知完全一致', tone: 'same' };
  if (distance <= 5) return { label: '非常相似', tone: 'high' };
  if (distance <= 10) return { label: '可能相似', tone: 'medium' };
  return { label: '差异较大', tone: 'low' };
}

function resultLabel(result) {
  const fallback = similarityLabel(Number(result.phash_dist));
  return {
    label: result.verdict_label || fallback.label,
    tone: result.tone || fallback.tone,
  };
}

function metricValue(value, suffix = '') {
  const number = Number(value);
  return Number.isFinite(number) ? `${number}${suffix}` : '—';
}

function renderReasons(reasons) {
  if (!Array.isArray(reasons) || !reasons.length) return '';
  return `
    <div class="compare-reasons">
      ${reasons.map(reason => `<span>${escapeHtml(reason)}</span>`).join('')}
    </div>
  `;
}

function hashPrefix(value) {
  if (!value) return '—';
  return value.slice(0, 12) + '…' + value.slice(-8);
}

function photoForPath(path) {
  return photosByPath().get(path) || null;
}

function imageUrlForPath(path) {
  const photo = photoForPath(path);
  return photo ? previewUrl(photo) : `/thumb/${encodePath(path)}`;
}

function renderPhoto(path) {
  const photo = photoForPath(path);
  const name = photo ? photo.filename : path.split('/').pop();
  return `
    <div class="compare-photo">
      <div class="compare-thumb">
        <img src="${imageUrlForPath(path)}" alt="${escapeHtml(name)}">
      </div>
      <div class="compare-name" title="${escapeHtml(path)}">${escapeHtml(name)}</div>
      <div class="compare-path">${escapeHtml(path)}</div>
    </div>
  `;
}

function renderIntro(pair) {
  dom.compareBody.innerHTML = `
    <div class="compare-actions">
      <div class="compare-action-block">
        <h3>手动对比</h3>
        <p>${pair ? '已选中两张照片，可以直接对比。' : '先在照片列表中选中两张照片，再打开本面板。'}</p>
        <button id="btn-run-pair-compare" class="primary"${pair ? '' : ' disabled'}>对比选中的两张</button>
      </div>
      <div class="compare-action-block">
        <h3>扫描当前挂载目录</h3>
        <p>自动在当前照片目录里找可能重复或很像的照片。照片很多时会比较耗时，可以先用默认设置试一次。</p>
        <div class="compare-scan-controls">
          <label>相似程度
            <select id="similar-threshold">
              <option value="3">严格：几乎一样</option>
              <option value="5" selected>标准：推荐</option>
              <option value="10">宽松：可能相似</option>
            </select>
          </label>
          <label>最多显示
            <select id="similar-limit">
              <option value="20">20 组</option>
              <option value="50" selected>50 组</option>
              <option value="100">100 组</option>
              <option value="200">200 组</option>
            </select>
          </label>
          <label>最多扫描
            <select id="similar-max">
              <option value="500">500 张</option>
              <option value="2000" selected>2000 张</option>
              <option value="5000">5000 张</option>
              <option value="10000">10000 张</option>
            </select>
          </label>
        </div>
        <button id="btn-run-similar-scan" class="primary">扫描当前目录</button>
      </div>
    </div>
    <div id="compare-result"></div>
  `;

  document.getElementById('btn-run-pair-compare')?.addEventListener('click', () => runPairCompare(pair));
  document.getElementById('btn-run-similar-scan')?.addEventListener('click', runSimilarityScan);

  if (pair) runPairCompare(pair);
}

function resultEl() {
  return document.getElementById('compare-result') || dom.compareBody;
}

function renderPairLoading(pair) {
  resultEl().innerHTML = `
    <div class="compare-grid">
      ${renderPhoto(pair.aPath)}
      ${renderPhoto(pair.bPath)}
    </div>
    <div class="compare-summary">
      <div class="compare-status">正在计算相似度…</div>
    </div>
  `;
}

function renderPairResult(pair, result) {
  const similarity = resultLabel(result);
  const sameFile = result.sha_a && result.sha_a === result.sha_b;

  resultEl().innerHTML = `
    <div class="compare-grid">
      ${renderPhoto(pair.aPath)}
      ${renderPhoto(pair.bPath)}
    </div>
    <div class="compare-summary">
      <div class="compare-verdict ${similarity.tone}">
        ${sameFile ? '文件内容完全相同' : escapeHtml(similarity.label)}
      </div>
      ${renderReasons(result.reasons)}
      <div class="compare-metrics">
        <div class="compare-metric">
          <span>综合可信度</span>
          <strong>${metricValue(result.score, '%')}</strong>
        </div>
        <div class="compare-metric">
          <span>轮廓/边缘差异</span>
          <strong>${metricValue(result.dhash_dist)} / 64</strong>
        </div>
        <div class="compare-metric">
          <span>明暗结构差异</span>
          <strong>${metricValue(result.ahash_dist ?? result.phash_dist)} / 64</strong>
        </div>
        <div class="compare-metric">
          <span>颜色差异</span>
          <strong>${metricValue(result.color_dist)}</strong>
        </div>
        <div class="compare-metric">
          <span>画幅差异</span>
          <strong>${metricValue(result.aspect_dist)}</strong>
        </div>
        <div class="compare-metric">
          <span>SHA256</span>
          <strong>${sameFile ? '一致' : '不同'}</strong>
        </div>
      </div>
      <div class="compare-hashes">
        <div><span>A</span><code title="${escapeHtml(result.sha_a)}">${escapeHtml(hashPrefix(result.sha_a))}</code></div>
        <div><span>B</span><code title="${escapeHtml(result.sha_b)}">${escapeHtml(hashPrefix(result.sha_b))}</code></div>
      </div>
    </div>
  `;
}

function renderError(message) {
  resultEl().innerHTML = `
    <div class="compare-summary">
      <div class="compare-status error">${escapeHtml(message)}</div>
    </div>
  `;
}

async function runPairCompare(pair) {
  if (!pair) return;
  renderPairLoading(pair);

  try {
    const query = new URLSearchParams({
      a: pair.aPath,
      b: pair.bPath,
    });
    const res = await fetch('/api/compare?' + query.toString(), { cache: 'no-store' });
    if (!res.ok) throw new Error(await res.text() || '对比失败');
    renderPairResult(pair, await res.json());
  } catch (e) {
    renderError(e.message || '对比失败');
  }
}

function numberInput(id, fallback) {
  const value = Number(document.getElementById(id)?.value);
  return Number.isFinite(value) ? value : fallback;
}

function scanQuery() {
  const threshold = Math.max(0, Math.min(16, numberInput('similar-threshold', 5)));
  const limit = Math.max(1, Math.min(500, numberInput('similar-limit', 50)));
  const maxPhotos = Math.max(2, Math.min(10000, numberInput('similar-max', 2000)));
  return new URLSearchParams({
    threshold: String(threshold),
    limit: String(limit),
    max_photos: String(maxPhotos),
  });
}

function renderScanLoading() {
  resultEl().innerHTML = `
    <div class="compare-summary">
      <div class="compare-status">正在创建扫描任务…</div>
    </div>
  `;
}

function renderScanProgress(data) {
  const total = Number(data.total) || Number(data.scanned) || 0;
  const processed = Number(data.processed) || Number(data.hashed) || 0;
  const hashed = Number(data.hashed) || 0;
  const cached = Number(data.cached) || 0;
  const pct = total ? Math.min(100, Math.round((processed / total) * 100)) : 0;
  const pairs = Array.isArray(data.pairs) ? data.pairs.length : 0;
  resultEl().innerHTML = `
    <div class="compare-summary">
      <div class="compare-scan-head">正在扫描当前挂载目录… ${pct}%</div>
      <div class="compare-progress" aria-label="扫描进度">
        <div style="width:${pct}%"></div>
      </div>
      <div class="compare-note">
        已处理 ${processed} / ${total || '—'} 张，其中 ${cached} 张来自缓存，成功计算 ${hashed} 张，已找到 ${pairs} 组。
      </div>
    </div>
  `;
}

function renderScanResult(data) {
  const pairs = Array.isArray(data.pairs) ? data.pairs : [];
  const notice = data.truncated
    ? `<div class="compare-note">照片数量超过扫描上限，本次只扫描前 ${data.max_photos} 张。</div>`
    : '';
  const body = pairs.length ? pairs.map(pair => {
    const similarity = resultLabel(pair);
    return `
      <div class="similar-pair">
        <div class="similar-pair-photos">
          ${renderPhoto(pair.a)}
          ${renderPhoto(pair.b)}
        </div>
        <div class="similar-pair-meta">
          <span class="${similarity.tone}">${escapeHtml(similarity.label)}</span>
          <strong>${metricValue(pair.score, '%')}</strong>
        </div>
        ${renderReasons(pair.reasons)}
        <div class="compare-note">
          边缘 ${metricValue(pair.dhash_dist)}/64 · 明暗 ${metricValue(pair.ahash_dist ?? pair.phash_dist)}/64 ·
          颜色 ${metricValue(pair.color_dist)} · 画幅 ${metricValue(pair.aspect_dist)}
        </div>
      </div>
    `;
  }).join('') : '<div class="compare-status">没有找到符合阈值的相似照片。</div>';

  resultEl().innerHTML = `
    <div class="compare-summary">
      <div class="compare-scan-head">
        扫描 ${data.scanned} 张，成功计算 ${data.hashed} 张，找到 ${pairs.length} 组
      </div>
      ${notice}
      ${data.unreadable ? `<div class="compare-note">${data.unreadable} 张图片无法读取，已跳过。</div>` : ''}
    </div>
    <div class="similar-list">${body}</div>
  `;
}

async function runSimilarityScan() {
  renderScanLoading();
  try {
    const res = await fetch('/api/similar/jobs?' + scanQuery().toString(), {
      method: 'POST',
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(await res.text() || '扫描失败');
    const job = await res.json();
    if (!job.id) throw new Error('扫描任务创建失败');
    await pollSimilarityJob(job.id);
  } catch (e) {
    renderError(e.message || '扫描失败');
  }
}

async function pollSimilarityJob(id) {
  for (;;) {
    const res = await fetch('/api/similar/jobs/' + encodeURIComponent(id), { cache: 'no-store' });
    if (!res.ok) throw new Error(await res.text() || '扫描失败');
    const data = await res.json();
    if (data.status === 'done') {
      renderScanResult(data);
      return;
    }
    if (data.status === 'error') {
      throw new Error(data.error || '扫描失败');
    }
    renderScanProgress(data);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

export function openCompareDialog() {
  document.getElementById('modal-compare').classList.add('show');
  renderIntro(selectedPair());
}
