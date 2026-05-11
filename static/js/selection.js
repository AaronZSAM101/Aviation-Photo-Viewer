// 选择状态管理
import { state } from './state.js';
import { subpath } from './utils.js';

export function syncSelectionWithPhotos() {
  if (!state.selectedSubpaths.size) return;
  const valid = new Set(state.photos.map(p => subpath(p)));
  for (const sp of [...state.selectedSubpaths]) {
    if (!valid.has(sp)) state.selectedSubpaths.delete(sp);
  }
  if (state.selectionAnchorSp && !valid.has(state.selectionAnchorSp)) {
    state.selectionAnchorSp = null;
  }
}

export function clearSelection() {
  state.selectedSubpaths.clear();
  state.selectionAnchorSp = null;
  syncSelectionUI();
}

export function syncSelectionUI() {
  document.querySelectorAll('.card[data-sp]').forEach(card => {
    const sp = card.dataset.sp;
    const selected = state.selectedSubpaths.has(sp);
    card.classList.toggle('selected', selected);
    const chk = card.querySelector('input.selchk');
    if (chk) chk.checked = selected;
  });
}

export function getSelectionAnchorIndex() {
  if (!state.selectionAnchorSp) return null;
  return state.filteredPhotos.findIndex(p => subpath(p) === state.selectionAnchorSp);
}

export function selectRangeByIndex(startIdx, endIdx, additive = true) {
  if (!state.filteredPhotos.length) return;
  const from = Math.max(0, Math.min(startIdx, endIdx));
  const to   = Math.min(state.filteredPhotos.length - 1, Math.max(startIdx, endIdx));
  if (!additive) state.selectedSubpaths.clear();
  for (let i = from; i <= to; i++) {
    const p = state.filteredPhotos[i];
    if (p) state.selectedSubpaths.add(subpath(p));
  }
  const anchorPhoto = state.filteredPhotos[endIdx];
  state.selectionAnchorSp = anchorPhoto ? subpath(anchorPhoto) : null;
  syncSelectionUI();
}

export function toggleSelectionAtIndex(idx) {
  const p = state.filteredPhotos[idx];
  if (!p) return;
  const sp = subpath(p);
  if (state.selectedSubpaths.has(sp)) state.selectedSubpaths.delete(sp);
  else                                state.selectedSubpaths.add(sp);
  state.selectionAnchorSp = sp;
  syncSelectionUI();
}

export function getSelectedSubpaths() {
  return [...state.selectedSubpaths];
}
