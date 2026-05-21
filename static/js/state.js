// 全局状态、DOM 引用、ImageLoader
// 所有跨模块共享的可变状态都通过 `state` 对象访问，避免 ES Module 中
// `export let` + setter 的繁琐写法。

const $ = id => document.getElementById(id);

// ── DOM 引用 ──────────────────────────────────────────────────────────────
export const dom = {
  prog:        $('prog'),
  content:     $('content'),
  empty:       $('empty'),
  stats:       $('stats'),
  loading:     $('loading'),
  loadingMsg:  $('loading-msg'),

  // Viewer
  viewer:        $('viewer'),
  vName:         $('v-name'),
  vCounter:      $('v-counter'),
  vImg:          $('v-img'),
  vCanvas:       $('v-canvas'),
  vGrid:         $('v-grid'),
  vSpin:         $('vspin'),
  vFineGrid:     $('v-finegrid'),
  vCharts:       $('v-charts'),
  vInfo:         $('vinfo'),
  vRgbPanel:     $('v-rgb-panel'),
  vHistPanel:    $('v-hist-panel'),
  vEqBtn:        $('v-equalize'),
  vGridBtn:      $('v-gridbtn'),
  vFineGridBtn:  $('v-finegridbtn'),
  vRgbBtn:       $('v-rgbbtn'),
  vHistBtn:      $('v-histbtn'),
  vInfoBtn:      $('v-info-btn'),
  vExifEditBtn:  $('v-exif-edit-btn'),
  vPrev:         $('v-prev'),
  vNext:         $('v-next'),
  vDeleteBtn:    $('v-delete-btn'),
  vRenameBtn:    $('v-rename-btn'),
  vMoveBtn:      $('v-move-btn'),
  vCopyBtn:      $('v-copy-btn'),
  vStagedPill:   $('v-staged-pill'),
  vClose:        $('v-close'),
  vStage:        $('vstage'),
};

export { $ };

// ── 全局状态 ──────────────────────────────────────────────────────────────
export const state = {
  // 设置
  currentSort: 'date-asc',
  baseView:    'flat',
  timeScale:   'none',
  collapseAll: false,
  readOnly:    false,
  user:        null,
  email:       null,

  // 数据
  photos:         [],
  filteredPhotos: [],
  searchTerm:     '',
  globalIndex:    0,

  // 搜索索引
  searchIndex:    null,
  lastSearchTerm: '',
  searchDebounceTimer: null,

  // 选择
  selectedSubpaths:  new Set(),
  selectionAnchorSp: null,

  // 暂存的文件操作
  stagedDeletes:    new Set(),
  stagedRenameSrcs: new Set(),
  stagedRenameMap:  new Map(),
  stagedOpTargets:  new Set(),

  // 查看器
  viewerIndex: -1,
  equalizeOn:  false,
  gridOn:      false,
  fineGridOn:  false,
  rgbOn:       false,
  histOn:      false,
  infoOn:      true,

  // 文件操作 modal
  pendingFileOp: { kind: null, src: null, srcFolder: '', srcName: '' },

  // 批量移动 modal
  pendingBulkMove: { selectedCount: 0 },

  // 卡片右键菜单
  cardMenuSrc:     null,
  cardMenuSrcs:    [],
  cardMenuIsBulk:  false,

  // 预加载缓存：避免重复 new Image 导致浪费
  prefetchedPreviewUrls: new Set(),
};

// ── 智能图片加载队列（控制并发数）──────────────────────────────────────────
class ImageLoader {
  constructor(maxConcurrent = 6) {
    this.maxConcurrent = maxConcurrent;
    this.loading = 0;
    this.queue = [];
    this.loadingSet = new Set();
  }
  load(img) {
    if (this.loadingSet.has(img)) return;
    this.loadingSet.add(img);
    this.queue.push(img);
    this.processQueue();
  }
  processQueue() {
    while (this.loading < this.maxConcurrent && this.queue.length > 0) {
      const img = this.queue.shift();
      this.loading++;
      const src = img.dataset.src;
      img.onload = img.onerror = () => {
        img.classList.add('loaded');
        const loader = img.previousElementSibling;
        if (loader && loader.classList.contains('loader')) loader.remove();
        this.loading--;
        this.loadingSet.delete(img);
        this.processQueue();
      };
      img.src = src;
    }
  }
}

function defaultImageConcurrency() {
  const isMobile = window.matchMedia('(max-width: 900px), (pointer: coarse)').matches;
  if (isMobile) return 2;
  return 6;
}

export const imageLoader = new ImageLoader(defaultImageConcurrency());
