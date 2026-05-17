// 所有事件绑定：toolbar / viewer 按钮 / 键盘 / 右键菜单 / modal 关闭按钮
import { dom, state, $ } from './state.js';
import { subpath } from './utils.js';
import {
  loadPhotos, fetchStagedOps, stageBulkDelete, stageSingleDelete,
  applyStaged, clearAllStaged, refreshStagedList, removeStagedOp,
  showStagedList, showTrash, stageRestore, closeModal,
} from './api.js';
import { syncRoute } from './router.js';
import {
  render, applyCollapseStateToSections, refreshCollapseButton,
  updateCardStagedIndicators,
} from './render.js';
import {
  closeViewer, navigate, applyEqualize, disableEqualize,
  fitGridToImage, refreshHistograms, syncToggleButtons,
  refreshCurrentViewer,
  viewerToggleDelete, currentViewerSubpath, openViewer,
} from './viewer.js';
import { openFileOpDialog, commitFileOp, openBulkMoveDialog, commitBulkMove } from './file-ops.js';
import { openExifEditDialog, commitExifEdit } from './exif-edit.js';
import { syncSelectionUI } from './selection.js';

function openShortcutsModal() {
  $('modal-shortcuts').classList.add('show');
}

export function bindAllEvents() {
  // ── Viewer toggle 按钮 ────────────────────────────────────────────────
  dom.vEqBtn.addEventListener('click', () => {
    state.equalizeOn = !state.equalizeOn;
    syncToggleButtons();
    if (state.equalizeOn) {
      dom.vSpin.classList.add('show');
      // 让转圈动画先画出来再做重活
      requestAnimationFrame(() => requestAnimationFrame(() => {
        applyEqualize();
        dom.vSpin.classList.remove('show');
        fitGridToImage();
        refreshHistograms();
      }));
    } else {
      disableEqualize();
      requestAnimationFrame(() => { fitGridToImage(); refreshHistograms(); });
    }
  });
  dom.vGridBtn.addEventListener('click', () => {
    state.gridOn = !state.gridOn;
    syncToggleButtons();
    if (state.gridOn) fitGridToImage();
  });
  dom.vFineGridBtn.addEventListener('click', () => {
    state.fineGridOn = !state.fineGridOn;
    syncToggleButtons();
    if (state.fineGridOn) fitGridToImage();
  });
  dom.vRgbBtn.addEventListener('click', () => {
    state.rgbOn = !state.rgbOn;
    syncToggleButtons();
    if (state.rgbOn) refreshHistograms();
  });
  dom.vHistBtn.addEventListener('click', () => {
    state.histOn = !state.histOn;
    syncToggleButtons();
    if (state.histOn) refreshHistograms();
  });
  dom.vInfoBtn.addEventListener('click', () => {
    state.infoOn = !state.infoOn;
    syncToggleButtons();
    requestAnimationFrame(fitGridToImage);
  });
  dom.vExifEditBtn.addEventListener('click', openExifEditDialog);

  dom.vClose.addEventListener('click', closeViewer);
  dom.vPrev.addEventListener('click', () => navigate(-1));
  dom.vNext.addEventListener('click', () => navigate( 1));
  dom.vDeleteBtn.addEventListener('click', viewerToggleDelete);
  dom.vRenameBtn.addEventListener('click', () => {
    const sp = currentViewerSubpath();
    if (sp) openFileOpDialog('rename', sp);
  });
  dom.vMoveBtn.addEventListener('click', () => {
    const sp = currentViewerSubpath();
    if (sp) openFileOpDialog('move', sp);
  });
  dom.vCopyBtn.addEventListener('click', () => {
    const sp = currentViewerSubpath();
    if (sp) openFileOpDialog('copy', sp);
  });

  // ── 窗口事件 ──────────────────────────────────────────────────────────
  window.addEventListener('resize', () => {
    if (dom.viewer.classList.contains('show')) fitGridToImage();
  });
  window.addEventListener('keydown', e => {
    // Viewer 内的键盘快捷键
    if (dom.viewer.classList.contains('show')) {
      const ae = document.activeElement;
      const inField = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT');
      if (inField && e.key !== 'Escape') return;
      if      (e.key === 'Escape')     closeViewer();
      else if (e.key === 'ArrowLeft')  navigate(-1);
      else if (e.key === 'ArrowRight') navigate( 1);
      else if (e.key === 'e' || e.key === 'E') dom.vEqBtn.click();
      else if (e.key === 'g' || e.key === 'G') dom.vGridBtn.click();
      else if (e.key === 'f' || e.key === 'F') dom.vFineGridBtn.click();
      else if (e.key === 'r' || e.key === 'R') dom.vRgbBtn.click();
      else if (e.key === 'h' || e.key === 'H') dom.vHistBtn.click();
      else if (e.key === 'i' || e.key === 'I') dom.vInfoBtn.click();
      else if (e.key === 'd' || e.key === 'D') dom.vDeleteBtn.click();
    }
    // 全局：F1 打开快捷键面板
    if (e.key === 'F1') {
      e.preventDefault();
      openShortcutsModal();
    }
  });

  // ── 顶部 toolbar ──────────────────────────────────────────────────────
  $('sort-sel').addEventListener('change', e => {
    state.currentSort = e.target.value;
    loadPhotos();
    syncRoute();
  });
  $('btn-reload').addEventListener('click', () => {
    loadPhotos();
    syncRoute();
  });
  $('btn-collapse').addEventListener('click', () => {
    state.collapseAll = !state.collapseAll;
    applyCollapseStateToSections();
    refreshCollapseButton();
    syncRoute();
  });
  $('view-mode-sel').addEventListener('change', e => {
    state.baseView = e.target.value;
    render();
    syncRoute();
  });
  $('time-scale-sel').addEventListener('change', e => {
    state.timeScale = e.target.value;
    render();
    syncRoute();
  });
  $('btn-bulk-delete').addEventListener('click', stageBulkDelete);
  $('btn-bulk-move').addEventListener('click', openBulkMoveDialog);
  $('btn-stage-list').addEventListener('click', showStagedList);
  $('btn-stage-apply').addEventListener('click', () => {
    $('modal-staged').classList.add('show');
    refreshStagedList();
  });
  $('btn-trash').addEventListener('click', showTrash);
  $('btn-shortcuts').addEventListener('click', openShortcutsModal);
  $('search-box').addEventListener('input', e => {
    state.searchTerm = e.target.value;
    render();
    syncRoute();
  });

  // ── Modal 关闭按钮（之前是 onclick 内联）──────────────────────────────
  document.querySelectorAll('[data-close-modal]').forEach(btn => {
    btn.addEventListener('click', () => closeModal(btn.dataset.closeModal));
  });
  // 分批 modal 内的「清空所有」「应用」
  $('btn-clear-staged').addEventListener('click', clearAllStaged);
  $('btn-apply-staged').addEventListener('click', applyStaged);
  // 文件操作 modal 内的「确定」
  $('btn-commit-file-op').addEventListener('click', commitFileOp);
  $('btn-commit-exif').addEventListener('click', async () => {
    const sp = currentViewerSubpath();
    if (!sp) return;
    try {
      await commitExifEdit();
      await loadPhotos();
      refreshCurrentViewer(sp);
      closeModal('modal-exif');
    } catch (e) {
      alert('保存 EXIF 失败: ' + e.message);
    }
  });
  // 批量移动 modal 内的「确定」
  $('btn-commit-bulk-move').addEventListener('click', commitBulkMove);

  // 分批列表 / 回收站列表的事件委托：动态生成的按钮通过 data-action 绑定
  $('staged-list').addEventListener('click', e => {
    const btn = e.target.closest('[data-action="remove-staged"]');
    if (btn) removeStagedOp(btn.dataset.id);
  });
  $('trash-list').addEventListener('click', e => {
    const btn = e.target.closest('[data-action="restore"]');
    if (btn) stageRestore(btn.dataset.name);
  });

  // ── 卡片右键菜单 ──────────────────────────────────────────────────────
  const cardMenu = document.createElement('div');
  cardMenu.className = 'card-context-menu';
  document.body.appendChild(cardMenu);

  function closeCardMenu() {
    cardMenu.classList.remove('show');
    state.cardMenuSrc    = null;
    state.cardMenuSrcs   = [];
    state.cardMenuIsBulk = false;
  }

  function buildCardMenuHTML(isBulk) {
    const items = [
      '<button class="card-context-item danger" data-kind="delete">删除</button>',
      '<div class="card-context-sep"></div>',
    ];
    if (!isBulk) items.push('<button class="card-context-item" data-kind="rename">重命名</button>');
    items.push('<button class="card-context-item" data-kind="move">移动</button>');
    items.push('<button class="card-context-item" data-kind="copy">复制</button>');
    return items.join('');
  }

  cardMenu.addEventListener('click', async e => {
    const btn = e.target.closest('[data-kind]');
    if (!btn) return;
    const kind = btn.dataset.kind;
    const isBulk = state.cardMenuIsBulk;
    const srcs   = state.cardMenuSrcs;
    const src    = state.cardMenuSrc;
    closeCardMenu();

    if (isBulk) {
      if (!srcs.length) return;
      if (kind === 'delete') {
        for (const s of srcs) await stageSingleDelete(s);
      } else if (kind === 'move') {
        openBulkMoveDialog();
      } else if (kind === 'copy') {
        alert(`批量复制 (${srcs.length} 个文件)：请逐一处理`);
      }
    } else {
      if (!src) return;
      if (kind === 'delete') stageSingleDelete(src);
      else                   openFileOpDialog(kind, src);
    }
  });

  document.addEventListener('contextmenu', e => {
    const card = e.target.closest('.card');
    if (!card) return;
    e.preventDefault();

    const idx = parseInt(card.querySelector('input.selchk').dataset.idx, 10);
    const p   = state.filteredPhotos[idx];
    if (!p) return;

    const sp = subpath(p);
    if (state.selectedSubpaths.size > 1) {
      // 多选模式
      state.cardMenuIsBulk = true;
      state.cardMenuSrcs   = [...state.selectedSubpaths];
      state.cardMenuSrc    = null;
    } else {
      // 单选模式
      state.cardMenuIsBulk = false;
      state.cardMenuSrc    = sp;
      state.cardMenuSrcs   = [];
      state.selectedSubpaths.clear();
      state.selectedSubpaths.add(sp);
      syncSelectionUI();
    }

    cardMenu.innerHTML = buildCardMenuHTML(state.cardMenuIsBulk);
    const menuW = 150, menuH = 160;
    const x = Math.min(e.clientX, window.innerWidth  - menuW - 8);
    const y = Math.min(e.clientY, window.innerHeight - menuH - 8);
    cardMenu.style.left = x + 'px';
    cardMenu.style.top  = y + 'px';
    cardMenu.classList.add('show');
  });

  document.addEventListener('click', e => {
    if (!cardMenu.contains(e.target)) closeCardMenu();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeCardMenu();
  });
  window.addEventListener('scroll', closeCardMenu, true);
  window.addEventListener('resize', closeCardMenu);
}
