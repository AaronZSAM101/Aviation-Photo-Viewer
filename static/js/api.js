// 与后端通信：照片列表、暂存操作、回收站
import { dom, state } from './state.js';
import { syncSelectionWithPhotos, clearSelection } from './selection.js';
import { render, updateCardStagedIndicators } from './render.js';
import { joinSubpath, splitSubpath } from './utils.js';

function ensureWritable() {
  if (!state.readOnly) return true;
  alert('当前为只读模式，管理操作已禁用');
  return false;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function setHidden(id, hidden) {
  const el = document.getElementById(id);
  if (el) el.hidden = hidden;
}

function applyReadOnlyUI() {
  const hidden = !!state.readOnly;
  [
    'btn-bulk-move',
    'btn-bulk-delete',
    'btn-stage-list',
    'btn-trash',
    'btn-admin-setdir',
    'v-exif-edit-btn',
    'v-rename-btn',
    'v-move-btn',
    'v-copy-btn',
    'v-delete-btn',
    'v-staged-pill',
  ].forEach(id => setHidden(id, hidden));
}

function applyVersionUI() {
  if (!dom.appVersion) return;
  if (!state.appVersion) {
    dom.appVersion.textContent = '版本未知';
    dom.appVersion.title = '当前版本未知';
    return;
  }
  const sourceLabel = state.appVersionSource === 'ghcr' ? 'GHCR' : '本地';
  dom.appVersion.textContent = state.appVersion;
  dom.appVersion.title = `${sourceLabel} 版本：${state.appVersion}`;
}

export async function loadConfig() {
  try {
    const res = await fetch('/api/config', { cache: 'no-store' });
    if (!res.ok) return;
    const config = await res.json();
    state.readOnly = !!config.readOnly;
    state.appVersion = config.version || null;
    state.appVersionSource = config.versionSource || null;
    state.user = config.user || null;
    state.email = config.email || null;
    applyReadOnlyUI();
    applyVersionUI();
  } catch (e) {
    state.readOnly = false;
  }
}

export async function loadPhotos() {
  dom.loading.classList.add('show');
  dom.loadingMsg.textContent = '读取照片…';
  dom.prog.style.width = '30%';
  try {
    const [photosRes] = await Promise.all([
      fetch('/api/photos?sort=' + encodeURIComponent(state.currentSort), {
        cache: 'no-store',
      }).then(r => r.json()),
      fetchStagedOps(),
    ]);
    state.photos = Array.isArray(photosRes) ? photosRes : (photosRes.photos || []);
    // photos 数组被替换 → 之前缓存的搜索索引（按旧数组下标存）作废，
    // 否则 filterPhotos 会用旧下标在新数组里取错照片（包括不匹配搜索词的）。
    state.searchIndex    = null;
    state.lastSearchTerm = '';
    syncSelectionWithPhotos();
    dom.prog.style.width = '100%';
    render();
  } catch (e) {
    dom.loadingMsg.textContent = '加载失败: ' + e.message;
  } finally {
    setTimeout(() => {
      dom.loading.classList.remove('show');
      dom.prog.style.width = '0';
    }, 300);
  }
}

export async function fetchStagedOps() {
  try {
    const res  = await fetch('/api/stage/list', { cache: 'no-store' });
    const list = await res.json();
    state.stagedDeletes    = new Set(list.filter(o => o.kind === 'delete').map(o => o.src));
    state.stagedRenameSrcs = new Set(list.filter(o => o.kind === 'rename').map(o => o.src));
    state.stagedRenameMap  = new Map(
      list.filter(o => o.kind === 'rename' && o.dst).map(o => [o.src, o.dst])
    );
    state.stagedOpTargets  = new Set(list.filter(o => o.dst).map(o => o.dst));
  } catch (e) {
    state.stagedDeletes    = new Set();
    state.stagedRenameSrcs = new Set();
    state.stagedRenameMap  = new Map();
    state.stagedOpTargets  = new Set();
  }
}

export async function stageSingleDelete(sp) {
  if (!ensureWritable()) return;
  try {
    const res = await fetch('/api/stage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'delete', src: sp }),
    });
    if (!res.ok) { alert('加入删除列表失败'); return; }
    await fetchStagedOps();
    updateCardStagedIndicators();
  } catch (e) {
    alert('加入删除列表失败: ' + e.message);
  }
}

export async function stageBulkDelete() {
  if (!ensureWritable()) return;
  const sels = [...state.selectedSubpaths];
  if (!sels.length) { alert('请先选择要删除的照片'); return; }
  for (const s of sels) {
    await fetch('/api/stage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'delete', src: s }),
    });
  }
  clearSelection();
  await fetchStagedOps();
  updateCardStagedIndicators();
  alert('已加入分批（删除）');
}

export async function stageBulkMove(dstFolder) {
  if (!ensureWritable()) return;
  const sels = [...state.selectedSubpaths];
  if (!sels.length) { alert('请先选择要移动的照片'); return; }
  for (const s of sels) {
    const parsed = splitSubpath(s);
    const dst = joinSubpath(dstFolder, parsed.name);
    await fetch('/api/stage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'move', src: s, dst }),
    });
  }
  clearSelection();
  await fetchStagedOps();
  updateCardStagedIndicators();
  alert('已加入分批（移动）');
}

export async function applyStaged() {
  if (!ensureWritable()) return;
  const res = await fetch('/api/stage/apply', { method: 'POST' });
  if (res.ok) {
    const j = await res.json();
    alert('应用完成: ' + j.applied + ' 个操作');
    closeModal('modal-staged');
    loadPhotos();
  } else {
    alert('应用失败');
  }
}

export async function clearAllStaged() {
  if (!ensureWritable()) return;
  if (!confirm('确定清空所有分批操作？')) return;
  await fetch('/api/stage/clear', { method: 'POST' });
  state.stagedDeletes.clear();
  state.stagedRenameSrcs.clear();
  state.stagedOpTargets.clear();
  clearSelection();
  updateCardStagedIndicators();
  refreshStagedList();
}

export async function refreshStagedList() {
  const res  = await fetch('/api/stage/list', { cache: 'no-store' });
  const list = await res.json();
  const html = list.length ? list.map(o => `
    <div class="staged-item">
      <div class="staged-item-info">
        <strong>${o.kind}</strong> ${o.src}${o.dst ? ' → ' + o.dst : ''}
      </div>
      <div class="staged-item-actions">
        ${state.readOnly ? '' : `<button data-action="remove-staged" data-id="${o.id}">删除</button>`}
      </div>
    </div>
  `).join('') : '<p style="color:var(--muted)">没有分批操作</p>';
  document.getElementById('staged-list').innerHTML = html;
}

export async function removeStagedOp(id) {
  if (!ensureWritable()) return;
  await fetch('/api/stage/remove/' + id, { method: 'POST' });
  await fetchStagedOps();
  updateCardStagedIndicators();
  refreshStagedList();
}

export async function showStagedList() {
  refreshStagedList();
  document.getElementById('modal-staged').classList.add('show');
}

export async function showTrash() {
  const res  = await fetch('/api/trash/list');
  const list = await res.json();
  const html = list.length ? list.map(item => {
    const trashName = escapeHtml(item.name);
    const original = escapeHtml(item.original || '');
    const displayName = original || trashName;
    return `
    <div class="trash-item">
      <div class="trash-item-name" title="${trashName}">${displayName}</div>
      <div class="trash-item-actions">
        ${state.readOnly ? '' : `<button data-action="restore" data-name="${trashName}" data-original="${original}">恢复</button>`}
      </div>
    </div>
  `;
  }).join('') : '<p style="color:var(--muted)">回收站为空</p>';
  document.getElementById('trash-list').innerHTML = html;
  document.getElementById('modal-trash').classList.add('show');
}

export async function stageRestore(trashName, originalPath = '') {
  if (!ensureWritable()) return;
  const body = { kind: 'restore', src: '.trash/' + trashName };
  if (originalPath) body.dst = originalPath;
  await fetch('/api/stage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  alert('已加入分批（恢复）');
  showTrash();
}

export function closeModal(id) {
  document.getElementById(id).classList.remove('show');
}

export async function allowRuntimeDirChange() {
  try {
    const res = await fetch('/api/admin/allow_set_dir');
    if (!res.ok) return false;
    const j = await res.json();
    return !!j.allowed;
  } catch (e) {
    return false;
  }
}

export async function setPhotosDir(path) {
  if (!ensureWritable()) throw new Error('当前为只读模式');
  const res = await fetch('/api/admin/set_photos_dir', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || 'failed');
  }
  return await res.json();
}
