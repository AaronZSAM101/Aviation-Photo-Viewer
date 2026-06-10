// 网格渲染、文件夹/时间分组、卡片创建、虚拟滚动 lazyLoad、暂存徽标更新
import { dom, state, imageLoader, $ } from './state.js';
import {
  subpath, thumbUrl, fmt_size, fmt_date, hasAnyExif, splitSubpath,
} from './utils.js';
import {
  syncSelectionUI, getSelectionAnchorIndex, selectRangeByIndex, toggleSelectionAtIndex,
} from './selection.js';
import { openViewer } from './viewer.js';
import { syncRoute } from './router.js';

let lazyObserver = null;

// ── 搜索索引 ──────────────────────────────────────────────────────────────
function buildSearchIndex() {
  if (state.searchIndex !== null && state.lastSearchTerm === state.searchTerm) return;
  state.searchIndex    = new Map();
  state.lastSearchTerm = state.searchTerm;
  if (!state.searchTerm.trim()) {
    state.searchIndex = null;
    return;
  }
  const term = state.searchTerm.toLowerCase();
  state.photos.forEach((p, idx) => {
    const filename = p.filename.toLowerCase();
    const folder   = (p.folder || '').toLowerCase();
    const fullpath = subpath(p).toLowerCase();
    if (filename.includes(term) || folder.includes(term) || fullpath.includes(term)) {
      if (!state.searchIndex.has('match')) state.searchIndex.set('match', []);
      state.searchIndex.get('match').push(idx);
    }
  });
}

function filterPhotos() {
  buildSearchIndex();
  if (!state.searchTerm.trim()) {
    state.filteredPhotos = state.photos;
  } else {
    const indices = state.searchIndex?.get('match') || [];
    state.filteredPhotos = indices.map(i => state.photos[i]);
  }
}

// ── 暂存操作徽标 ──────────────────────────────────────────────────────────
export function renameBadgeLabel(sp) {
  const dst = state.stagedRenameMap.get(sp);
  if (!dst) return '待重命名';
  const srcName = splitSubpath(sp).name || sp;
  const dstName = splitSubpath(dst).name || dst;
  return `${srcName} → ${dstName}`;
}

export function renameBadgeTitle(sp) {
  const dst = state.stagedRenameMap.get(sp);
  if (!dst) return sp;
  return `${sp} → ${dst}`;
}

export function updateCardStagedIndicators() {
  document.querySelectorAll('.card[data-sp]').forEach(card => {
    const sp        = card.dataset.sp;
    const isDeleted = state.stagedDeletes.has(sp);
    const isRenamed = state.stagedRenameSrcs.has(sp);
    const hasExifOp = state.stagedExifSrcs.has(sp);
    card.classList.toggle('staged-delete', isDeleted);
    card.classList.toggle('staged-rename', isRenamed);
    card.classList.toggle('staged-exif', hasExifOp);
    const thumb = card.querySelector('.thumb');
    let deleteBadge = thumb && thumb.querySelector('.badge.staged');
    let renameBadge = thumb && thumb.querySelector('.badge.rename');
    let exifBadge = thumb && thumb.querySelector('.badge.exif');
    if (isDeleted && !deleteBadge && thumb) {
      const b = document.createElement('span');
      b.className = 'badge staged';
      b.textContent = '待删除';
      thumb.appendChild(b);
    } else if (!isDeleted && deleteBadge) {
      deleteBadge.remove();
    }
    if (isRenamed && !renameBadge && thumb) {
      const b = document.createElement('span');
      b.className = 'badge rename';
      b.textContent = renameBadgeLabel(sp);
      b.title = renameBadgeTitle(sp);
      thumb.appendChild(b);
    } else if (!isRenamed && renameBadge) {
      renameBadge.remove();
    } else if (isRenamed && renameBadge) {
      renameBadge.textContent = renameBadgeLabel(sp);
      renameBadge.title = renameBadgeTitle(sp);
    }
    if (hasExifOp && !exifBadge && thumb) {
      const b = document.createElement('span');
      b.className = 'badge exif';
      b.textContent = '待EXIF';
      b.title = '待写入 EXIF';
      thumb.appendChild(b);
    } else if (!hasExifOp && exifBadge) {
      exifBadge.remove();
    }
  });
}

// ── 主渲染入口 ────────────────────────────────────────────────────────────
export function render() {
  filterPhotos();

  if (!state.filteredPhotos.length) {
    dom.content.style.display = 'none';
    dom.empty.style.display   = 'flex';
    dom.stats.textContent = state.searchTerm ? `搜索：0 张` : '0 张照片';
    return;
  }
  dom.empty.style.display   = 'none';
  dom.content.style.display = 'block';
  dom.content.innerHTML     = '';
  state.globalIndex         = 0;

  const withExif   = state.filteredPhotos.filter(p => hasAnyExif(p.exif)).length;
  const total      = state.filteredPhotos.length;
  const total_all  = state.photos.length;
  const viewLabel  = state.baseView === 'folder' ? '按文件夹' : '全部';
  const scaleLabel = state.timeScale === 'none'
    ? '无时间分组'
    : (state.timeScale === 'year' ? '按年' : (state.timeScale === 'month' ? '按月' : '按日'));
  if (state.searchTerm) {
    dom.stats.textContent = `${total} / ${total_all} 张  ·  ${withExif} 张含EXIF  ·  ${viewLabel} · ${scaleLabel}`;
  } else {
    dom.stats.textContent = `${total} 张  ·  ${withExif} 张含EXIF  ·  ${viewLabel} · ${scaleLabel}`;
  }
  if (state.selectedSubpaths.size) {
    dom.stats.textContent += `  ·  已选 ${state.selectedSubpaths.size} 张`;
  }

  if (state.baseView === 'flat') {
    if (state.timeScale === 'none') renderFlat(state.filteredPhotos);
    else                            renderTimeGrouped(state.filteredPhotos, state.timeScale);
  } else {
    if (state.timeScale === 'none') renderGrouped(state.filteredPhotos);
    else                            renderFolderTimeGrouped(state.filteredPhotos, state.timeScale);
  }
  wireSectionToggles();
  refreshCollapseButton();
  syncSelectionUI();

  // 首屏只加载视口内的图片（虚拟滚动）
  requestAnimationFrame(() => lazyLoad());
}

// ── 折叠区块 ──────────────────────────────────────────────────────────────
function makeSection(label, icon, count, key) {
  const collapsed = state.collapseAll
    ? !(key && state.expandedSections.has(key))
    : !!(key && state.collapsedSections.has(key));
  const sec = document.createElement('div');
  sec.className = 'folder-section' + (collapsed ? ' collapsed' : '');
  if (key) sec.dataset.sectionKey = key;
  sec.innerHTML = `
    <div class="folder-header" role="button" aria-expanded="${collapsed ? 'false' : 'true'}">
      <span class="folder-toggle">${collapsed ? '▸' : '▾'}</span>
      <span class="folder-icon">${icon}</span>
      <span class="folder-name">${label}</span>
      <span class="folder-count">${count} 张</span>
    </div>`;
  return sec;
}

function wireSectionToggles() {
  dom.content.querySelectorAll('.folder-section > .folder-header').forEach(header => {
    header.addEventListener('click', () => {
      const sec = header.parentElement;
      if (!sec) return;
      sec.classList.toggle('collapsed');
      const collapsed = sec.classList.contains('collapsed');
      const toggle = header.querySelector('.folder-toggle');
      if (toggle) toggle.textContent = collapsed ? '▸' : '▾';
      header.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      const key = sec.dataset.sectionKey;
      if (key) {
        if (collapsed) state.collapsedSections.add(key);
        else           state.collapsedSections.delete(key);
      }
      syncCollapseStateFromDOM();
      syncRoute();
    });
  });
}

export function applyCollapseStateToSections() {
  state.expandedSections.clear();
  if (state.collapseAll) {
    state.collapsedSections = new Set(
      [...dom.content.querySelectorAll('.folder-section[data-section-key]')]
        .map(sec => sec.dataset.sectionKey)
        .filter(Boolean)
    );
  } else {
    state.collapsedSections.clear();
  }
  dom.content.querySelectorAll('.folder-section').forEach(sec => {
    sec.classList.toggle('collapsed', state.collapseAll);
    const header = sec.querySelector(':scope > .folder-header');
    const toggle = header && header.querySelector('.folder-toggle');
    if (toggle) toggle.textContent = state.collapseAll ? '▸' : '▾';
    if (header) header.setAttribute('aria-expanded', state.collapseAll ? 'false' : 'true');
  });
}

function syncCollapseStateFromDOM() {
  const sections = [...dom.content.querySelectorAll('.folder-section')];
  const collapsedKeys = sections
    .filter(sec => sec.classList.contains('collapsed') && sec.dataset.sectionKey)
    .map(sec => sec.dataset.sectionKey);
  const expandedKeys = sections
    .filter(sec => !sec.classList.contains('collapsed') && sec.dataset.sectionKey)
    .map(sec => sec.dataset.sectionKey);

  if (!sections.length) {
    state.collapseAll = false;
    state.collapsedSections.clear();
    state.expandedSections.clear();
  } else if (!expandedKeys.length) {
    state.collapseAll = true;
    state.collapsedSections = new Set(collapsedKeys);
    state.expandedSections.clear();
  } else if (state.collapseAll) {
    state.expandedSections = new Set(expandedKeys);
    state.collapsedSections = new Set(collapsedKeys);
  } else {
    state.collapseAll = false;
    state.collapsedSections = new Set(collapsedKeys);
    state.expandedSections.clear();
  }
  refreshCollapseButton();
}

export function refreshCollapseButton() {
  const btn = $('btn-collapse');
  const hasGroups = !!dom.content.querySelector('.folder-section');
  btn.disabled = !hasGroups;
  btn.textContent = state.collapseAll ? '展开全部' : '折叠全部';
}

// ── 时间分组 ──────────────────────────────────────────────────────────────
function timeGroupOf(p, scale) {
  const k = p.date_sort_key;
  if (!k) return { key: '__nodate__', label: '未知日期', sort: -1 };
  const s = String(k).padStart(14, '0');
  const Y = s.slice(0, 4), M = s.slice(4, 6), D = s.slice(6, 8);
  if (scale === 'year')  return { key: Y,       label: `${Y} 年`,                       sort: parseInt(Y, 10)        };
  if (scale === 'month') return { key: Y + M,   label: `${Y} 年 ${parseInt(M,10)} 月`,  sort: parseInt(Y + M, 10)    };
  return                       { key: Y+M+D,    label: `${Y}-${M}-${D}`,                sort: parseInt(Y+M+D, 10)    };
}

function renderTimeGrouped(list, scale) {
  const groups = new Map();
  list.forEach((p, idx) => {
    const g = timeGroupOf(p, scale);
    if (!groups.has(g.key)) groups.set(g.key, { label: g.label, sort: g.sort, items: [] });
    groups.get(g.key).items.push({ p, idx });
  });
  const asc = state.currentSort === 'date-asc';
  const entries = [...groups.values()].sort((a, b) => {
    if (a.sort < 0) return 1;
    if (b.sort < 0) return -1;
    return asc ? a.sort - b.sort : b.sort - a.sort;
  });
  entries.forEach(info => {
    const sec = makeSection(info.label, '📅', info.items.length, `time:${scale}:${info.label}`);
    const grid = makeGrid();
    const frag = document.createDocumentFragment();
    info.items.forEach(({ p, idx }) => frag.appendChild(makeCard(p, ++state.globalIndex, idx)));
    grid.appendChild(frag);
    sec.appendChild(grid);
    dom.content.appendChild(sec);
  });
}

function renderFlat(list) {
  const grid = makeGrid();
  const frag = document.createDocumentFragment();
  list.forEach((p, idx) => frag.appendChild(makeCard(p, ++state.globalIndex, idx)));
  grid.appendChild(frag);
  dom.content.appendChild(grid);
}

function renderGrouped(list) {
  const map = new Map();
  list.forEach((p, idx) => {
    const key = p.folder || '(根目录)';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({ p, idx });
  });
  [...map.keys()].sort((a, b) => a.localeCompare(b)).forEach(folder => {
    const items = map.get(folder);
    const sec = makeSection(folder, '▤', items.length, `folder:${folder}`);
    const grid = makeGrid();
    const frag = document.createDocumentFragment();
    items.forEach(({ p, idx }) => frag.appendChild(makeCard(p, ++state.globalIndex, idx)));
    grid.appendChild(frag);
    sec.appendChild(grid);
    dom.content.appendChild(sec);
  });
}

function renderFolderTimeGrouped(list, scale) {
  const folderMap = new Map();
  list.forEach((p, idx) => {
    const folderKey = p.folder || '(根目录)';
    if (!folderMap.has(folderKey)) folderMap.set(folderKey, []);
    folderMap.get(folderKey).push({ p, idx });
  });

  const asc = state.currentSort === 'date-asc';

  [...folderMap.keys()].sort((a, b) => a.localeCompare(b, 'zh-CN')).forEach(folder => {
    const folderItems = folderMap.get(folder);
    const sec = makeSection(folder, '▤', folderItems.length, `folder:${folder}`);

    const timeMap = new Map();
    folderItems.forEach(({ p, idx }) => {
      const g = timeGroupOf(p, scale);
      if (!timeMap.has(g.key)) timeMap.set(g.key, { label: g.label, sort: g.sort, items: [] });
      timeMap.get(g.key).items.push({ p, idx });
    });

    const timeEntries = [...timeMap.values()].sort((a, b) => {
      if (a.sort < 0) return 1;
      if (b.sort < 0) return -1;
      return asc ? a.sort - b.sort : b.sort - a.sort;
    });

    timeEntries.forEach(info => {
      const sub  = makeSection(
        info.label,
        '📅',
        info.items.length,
        `folder:${folder}:time:${scale}:${info.label}`
      );
      const grid = makeGrid();
      const frag = document.createDocumentFragment();
      info.items.forEach(({ p, idx }) => frag.appendChild(makeCard(p, ++state.globalIndex, idx)));
      grid.appendChild(frag);
      sub.appendChild(grid);
      sec.appendChild(sub);
    });

    dom.content.appendChild(sec);
  });
}

function makeGrid() {
  const g = document.createElement('div');
  g.className = 'grid';
  return g;
}

function makeCard(p, idx, photosIdx) {
  const hasExif    = hasAnyExif(p.exif);
  const sp         = subpath(p);
  const isStaged   = state.stagedDeletes.has(sp);
  const isRenamed  = state.stagedRenameSrcs.has(sp);
  const hasExifOp  = state.stagedExifSrcs.has(sp);
  const renameText = isRenamed ? renameBadgeLabel(sp) : '';
  const isSelected = state.selectedSubpaths.has(sp);

  const card = document.createElement('div');
  card.className =
    'card' +
    (isStaged   ? ' staged-delete' : '') +
    (isRenamed  ? ' staged-rename' : '') +
    (hasExifOp  ? ' staged-exif'   : '') +
    (isSelected ? ' selected'      : '');
  card.dataset.sp = sp;
  card.dataset.photosIdx = String(photosIdx);
  card.innerHTML = `
    <div class="thumb">
      <label style="position:absolute;left:6px;top:6px;z-index:5">
        <input type="checkbox" class="selchk" data-idx="${photosIdx}"${isSelected ? ' checked' : ''}>
      </label>
      <div class="loader"></div>
      <img data-src="${thumbUrl(p)}" alt="${p.filename}" decoding="async" fetchpriority="low">
      ${!hasExif ? '<span class="badge no-exif">NO EXIF</span>' : ''}
      ${isStaged  ? '<span class="badge staged">待删除</span>' : ''}
      ${isRenamed ? `<span class="badge rename" title="${renameBadgeTitle(sp)}">${renameText}</span>` : ''}
      ${hasExifOp ? '<span class="badge exif" title="待写入 EXIF">待EXIF</span>' : ''}
      <span class="badge num">#${idx}</span>
    </div>
    <div class="card-info">
      <div class="card-name" title="${sp}">${p.filename}</div>
      <div class="card-date">${fmt_date(p.exif.date_taken)}</div>
      <div class="card-meta">${p.exif.image_width && p.exif.image_height ? p.exif.image_width + '×' + p.exif.image_height + ' · ' : ''}${fmt_size(p.size)}</div>
    </div>`;
  return card;
}

// ── 虚拟滚动：进入视口时通过 imageLoader 加载图片 ────────────────────────
export function lazyLoad() {
  if (!lazyObserver) {
    const mobileRootMargin = window.matchMedia('(max-width: 900px), (pointer: coarse)').matches
      ? '120px'
      : '300px';
    lazyObserver = new IntersectionObserver(
      entries => {
        entries.forEach(e => {
          if (!e.isIntersecting) return;
          const img = e.target;
          if (!img.src && img.dataset.src) imageLoader.load(img);
          lazyObserver.unobserve(img);
        });
      },
      { rootMargin: mobileRootMargin }
    );
  } else {
    lazyObserver.disconnect();
  }
  dom.content.querySelectorAll('img[data-src]').forEach(img => lazyObserver.observe(img));
}

export function handleCardInteraction(e) {
  const card = e.target.closest('.card');
  if (!card) return;
  const photosIdx = Number(card.dataset.photosIdx);
  if (!Number.isFinite(photosIdx)) return;
  const sp = card.dataset.sp;

  if (e.target.closest('input.selchk')) {
    e.stopPropagation();
    const checked = !!e.target.checked;
    const anchorIdx = getSelectionAnchorIndex();
    if (e.shiftKey && anchorIdx != null) {
      selectRangeByIndex(anchorIdx, photosIdx, true);
      return;
    }
    if (!checked) state.selectedSubpaths.delete(sp);
    else          state.selectedSubpaths.add(sp);
    state.selectionAnchorSp = sp;
    syncSelectionUI();
    return;
  }

  if (e.target.closest('label')) return;
  if (e.metaKey || e.ctrlKey) { toggleSelectionAtIndex(photosIdx); return; }
  if (e.shiftKey) {
    const anchor    = getSelectionAnchorIndex();
    const anchorIdx = anchor == null ? photosIdx : anchor;
    selectRangeByIndex(anchorIdx, photosIdx, true);
    return;
  }
  openViewer(photosIdx);
}
