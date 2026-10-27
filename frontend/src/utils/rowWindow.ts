// 画廊列表的行级窗口计算。刻意做成纯函数：布局一变就能单测覆盖，
// 组件里只负责“量出来 → 调这里 → 按结果挂载”。
export interface GridSize {
  /** 一行几列 */
  columns: number;
  /** 一行的高度（含卡片自身，不含间距） */
  rowHeight: number;
  /** 行间距 */
  gap: number;
}

/** 每张卡片在 CSS 里声明的最小列宽，auto-fill 的列数由它决定 */
export const DEFAULT_MIN_COLUMN = 175;
export const DEFAULT_GAP = 10;
/** 一个卡片都没挂、其它分区也还没量到时用的行高估计 */
export const DEFAULT_ROW_HEIGHT = 248;

export function px(value: string | null | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// `repeat(auto-fill, minmax(--card-min, 1fr))` 的列数公式
export function columnCount(width: number, minColumn: number, gap: number): number {
  if (!(width > 0) || !(minColumn > 0)) return 1;
  return Math.max(1, Math.floor((width + gap) / (minColumn + gap)));
}

export function rowCount(items: number, columns: number): number {
  if (items <= 0) return 0;
  return Math.ceil(items / Math.max(1, columns));
}

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

export interface WindowSlice {
  /** 挂载区间 [start, end) */
  start: number;
  end: number;
  /** 上方留了多少整行，用占位块补出来，滚动条和跳滚才不失真 */
  topRows: number;
  bottomRows: number;
}

export const EMPTY_SLICE: WindowSlice = { start: 0, end: 0, topRows: 0, bottomRows: 0 };

/**
 * 决定要挂载哪几张卡片。
 * `bandTop` 是视口顶相对网格原点的距离（网格滚过头时为负），`bandHeight` 是视口高。
 */
export function windowSlice(options: {
  items: number;
  size: GridSize;
  bandTop: number;
  bandHeight: number;
  overscanRows?: number;
}): WindowSlice {
  const { items, size, bandTop, bandHeight } = options;
  const overscan = Math.max(0, options.overscanRows ?? 2);
  const rows = rowCount(items, size.columns);
  if (rows === 0) return EMPTY_SLICE;

  const stride = size.rowHeight + size.gap;
  if (!(stride > 0) || !(bandHeight > 0)) {
    return { start: 0, end: items, topRows: 0, bottomRows: 0 };
  }

  const firstVisible = clamp(Math.floor(bandTop / stride), 0, rows - 1);
  const lastVisible = clamp(Math.ceil((bandTop + bandHeight) / stride) - 1, firstVisible, rows - 1);
  const first = clamp(firstVisible - overscan, 0, rows - 1);
  const last = clamp(lastVisible + overscan, first, rows - 1);

  return {
    start: first * size.columns,
    end: Math.min(items, (last + 1) * size.columns),
    topRows: first,
    bottomRows: rows - last - 1,
  };
}

// 首屏只要挂这几张就够量出列数和行高了：列数来自 grid-template-columns
// 的解析结果（与条目数无关），行高来自任意一张卡片。
export function bootstrapSlice(items: number, maxCards: number): WindowSlice {
  return { start: 0, end: Math.min(items, maxCards), topRows: 0, bottomRows: 0 };
}

/** 整段都在窗口外：一张都不挂，高度全靠占位补，滚动条长度不变 */
export function offscreenSlice(items: number, size: GridSize): WindowSlice {
  return { start: 0, end: 0, topRows: 0, bottomRows: rowCount(items, size.columns) };
}

/**
 * 占位用的上下内边距。窗口里的卡片撑住自身高度，剩下的行折成两段 padding，
 * 于是网格内容原点始终等于虚拟的第 0 行原点，行号换算不会因为 padding 漂移。
 */
export function padPx(slice: WindowSlice, size: GridSize): { top: number; bottom: number } {
  const stride = size.rowHeight + size.gap;
  const rendered = rowCount(slice.end - slice.start, size.columns);
  if (rendered === 0) {
    const rows = slice.topRows + slice.bottomRows;
    return { top: 0, bottom: Math.max(0, rows * stride - size.gap) };
  }
  return { top: slice.topRows * stride, bottom: slice.bottomRows * stride };
}

export function sameSlice(a: WindowSlice, b: WindowSlice): boolean {
  return (
    a.start === b.start && a.end === b.end && a.topRows === b.topRows && a.bottomRows === b.bottomRows
  );
}

/**
 * 行高和列数只取决于网格宽度和 CSS 变量，对所有分区都一样，所以量到一次就可以共用：
 * 后面的分区一挂载就有准确高度，不会先按估计值撑出一段再跳回去。
 * 宽度是这条推断的前提，所以连同宽度一起存，断点变了就不会再复用旧值。
 */
let shared: { size: GridSize; width: number } | null = null;

export function sharedGridSize(width: number): GridSize | null {
  return shared && shared.width === width ? shared.size : null;
}

export function rememberGridSize(size: GridSize, width: number): void {
  shared = { size, width };
}

/** 单测之间把共用状态清干净，避免互相影响 */
export function resetSharedGridSize(): void {
  shared = null;
}
