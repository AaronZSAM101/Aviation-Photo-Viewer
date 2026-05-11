// 文件操作 modal：rename / move / copy
import { state, $ } from './state.js';
import { subpath, splitSubpath, joinSubpath } from './utils.js';
import { clearSelection } from './selection.js';
import { fetchStagedOps, closeModal } from './api.js';
import { render, updateCardStagedIndicators } from './render.js';

function listFolderOptions() {
  const set = new Set(['']);
  state.photos.forEach(p => set.add((p.folder || '').trim()));
  return [...set].sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

function pathExistsInCurrentState(dst, src) {
  const occupiedByPhoto = state.photos.some(p => {
    const sp = subpath(p);
    if (sp !== dst) return false;
    return sp !== src && !state.stagedDeletes.has(sp);
  });
  if (occupiedByPhoto) return true;
  return state.stagedOpTargets.has(dst) && dst !== src;
}

export function openFileOpDialog(kind, src) {
  const parsed = splitSubpath(src);
  state.pendingFileOp = { kind, src, srcFolder: parsed.folder, srcName: parsed.name };

  $('modal-file-op-title').textContent =
    ({ rename: '重命名', move: '移动', copy: '复制' })[kind] || '操作';
  $('modal-file-op-src').textContent = src;

  $('op-rename-fields').style.display = kind === 'rename' ? 'block' : 'none';
  $('op-move-fields').style.display   = kind === 'move'   ? 'block' : 'none';
  $('op-path-fields').style.display   = kind === 'copy'   ? 'block' : 'none';

  $('modal-rename-name').value = parsed.name;
  $('modal-file-op-dst').value = '';

  if (kind === 'move') {
    const sel = $('modal-move-folder');
    const options = listFolderOptions().map(folder => {
      const label    = folder || '(根目录)';
      const selected = folder === parsed.folder ? ' selected' : '';
      return `<option value="${folder}"${selected}>${label}</option>`;
    }).join('');
    sel.innerHTML = options;
    const updatePreview = () => {
      const dstFolder = sel.value;
      $('modal-move-preview').textContent = '将移动到: ' + joinSubpath(dstFolder, parsed.name);
    };
    sel.onchange = updatePreview;
    updatePreview();
  }

  $('modal-file-op').classList.add('show');
}

export async function commitFileOp() {
  let dst = '';
  let replace = false;
  const op = state.pendingFileOp;

  if (op.kind === 'rename') {
    const newName = $('modal-rename-name').value.trim();
    if (!newName) { alert('请输入新文件名'); return; }
    if (newName.includes('/') || newName.includes('\\')) {
      alert('重命名只允许修改文件名，不允许带路径');
      return;
    }
    dst = joinSubpath(op.srcFolder, newName);
    if (dst === op.src) { alert('新文件名与原文件名相同'); return; }
    if (pathExistsInCurrentState(dst, op.src)) {
      if (!confirm(`目标已存在：${dst}\n是否替换？`)) return;
      replace = true;
    }
  } else if (op.kind === 'move') {
    const dstFolder = $('modal-move-folder').value;
    dst = joinSubpath(dstFolder, op.srcName);
    if (dst === op.src) { alert('目标路径与原路径相同'); return; }
  } else {
    dst = $('modal-file-op-dst').value.trim();
    if (!dst) { alert('请输入目标'); return; }
  }

  await fetch('/api/stage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: op.kind, src: op.src, dst, replace }),
  });
  alert('已加入分批');
  closeModal('modal-file-op');
  clearSelection();
  await fetchStagedOps();
  updateCardStagedIndicators();
  render();
}
