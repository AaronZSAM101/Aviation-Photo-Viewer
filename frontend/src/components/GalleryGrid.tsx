import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
} from 'react';
import type { GalleryCardEntry } from '../types';
import type { StagedSets } from '../utils/staged';
import { GalleryCard } from './GalleryCard';
import {
  DEFAULT_GAP,
  DEFAULT_MIN_COLUMN,
  DEFAULT_ROW_HEIGHT,
  bootstrapSlice,
  columnCount,
  offscreenSlice,
  padPx,
  px,
  rememberGridSize,
  sameSlice,
  sharedGridSize,
  windowSlice,
  type GridSize,
  type WindowSlice,
} from '../utils/rowWindow';
import { onScrollFrame, requestScrollFrame } from '../utils/scrollTicker';

// 挂一张卡片就能量到列数（来自 grid-template-columns）和行高，
// 而 useLayoutEffect 在浏览器绘制之前跑完，所以首屏看到的已经是窗口结果。
const BOOTSTRAP_CARDS = 3;
const OVERSCAN_ROWS = 1;
// 窗口外扩这么多像素：卡片在进入视口前就开始加载，滚动了才挂载会露出转圈
const BAND_MARGIN_PX = 1200;

const ESTIMATED_SIZE: GridSize = {
  columns: 1,
  rowHeight: DEFAULT_ROW_HEIGHT,
  gap: DEFAULT_GAP,
};

interface GridView {
  slice: WindowSlice;
  size: GridSize;
}

interface GalleryGridProps {
  items: GalleryCardEntry[];
  numbering: Map<string, number>;
  selected: Set<string>;
  staged: StagedSets;
  onCardClick: (event: MouseEvent<HTMLDivElement>, entry: GalleryCardEntry) => void;
  onToggleCheck: (index: number, shiftKey: boolean) => void;
  onContextMenu: (event: MouseEvent<HTMLDivElement>, entry: GalleryCardEntry) => void;
}

export function cardKeyOf(entry: GalleryCardEntry): string {
  return entry.photo.folder ? `${entry.photo.folder}/${entry.photo.filename}` : entry.photo.filename;
}

function trackCount(value: string): number {
  if (!value || value === 'none') return 0;
  return value.split(' ').filter((part) => part.length > 0).length;
}

/**
 * 只读浏览器真正排出来的列数与行高，比自己按 auto-fill 公式重算可靠：
 * 断点改 CSS 变量时不需要跟着改 JS。一张卡片都没挂时只能借用别处的测量值。
 */
function readSize(grid: HTMLElement, width: number): { size: GridSize; exact: boolean } {
  const style = getComputedStyle(grid);
  const gap = px(style.rowGap, px(style.getPropertyValue('--card-gap'), DEFAULT_GAP));
  const minColumn = px(style.getPropertyValue('--card-min'), DEFAULT_MIN_COLUMN);
  const columns = trackCount(style.gridTemplateColumns) || columnCount(width, minColumn, gap);
  const first = grid.firstElementChild;
  const rowHeight = first ? first.getBoundingClientRect().height : 0;
  if (rowHeight > 0) return { size: { columns, rowHeight, gap }, exact: true };
  return {
    size: { columns, rowHeight: sharedGridSize(width)?.rowHeight ?? DEFAULT_ROW_HEIGHT, gap },
    exact: false,
  };
}

const sameSize = (a: GridSize, b: GridSize) =>
  a.columns === b.columns && a.rowHeight === b.rowHeight && a.gap === b.gap;

function GalleryGridInner({
  items,
  numbering,
  selected,
  staged,
  onCardClick,
  onToggleCheck,
  onContextMenu,
}: GalleryGridProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const sizeRef = useRef<GridSize | null>(null);
  const widthRef = useRef(0);
  const nearRef = useRef(true);
  const viewRef = useRef<GridView>({
    slice: bootstrapSlice(items.length, BOOTSTRAP_CARDS),
    size: ESTIMATED_SIZE,
  });
  const [view, setView] = useState<GridView>(viewRef.current);

  const sizeFor = useCallback((grid: HTMLElement, width: number): { size: GridSize; exact: boolean } => {
    const cached = sizeRef.current;
    if (cached && widthRef.current === width) return { size: cached, exact: true };
    const next = readSize(grid, width);
    if (next.exact) {
      sizeRef.current = next.size;
      widthRef.current = width;
      rememberGridSize(next.size, width);
      return next;
    }
    const shared = sharedGridSize(width);
    if (shared) {
      sizeRef.current = shared;
      widthRef.current = width;
      return { size: shared, exact: false };
    }
    return next;
  }, []);

  const apply = useCallback((slice: WindowSlice, size: GridSize) => {
    const prev = viewRef.current;
    if (sameSlice(prev.slice, slice) && sameSize(prev.size, size)) return;
    const next = { slice, size };
    viewRef.current = next;
    setView(next);
  }, []);

  const compute = useCallback(() => {
    const wrap = wrapRef.current;
    const grid = gridRef.current;
    if (!wrap || !grid) return;
    const width = grid.clientWidth;
    // 折叠的分区是 display:none，量不到宽度；展开时观察器会再触发一次
    if (width <= 0) return;

    const measured = sizeFor(grid, width);
    const size = measured.size;
    if (!measured.exact) {
      // 这一遍只能按估计值算，等卡片挂上后（见下面的渲染后重算）再用真实行高校正
      requestScrollFrame();
    }
    if (!nearRef.current) {
      apply(offscreenSlice(items.length, size), size);
      return;
    }
    // 窗口顶边相对网格第 0 行原点的距离：占位内边距不会移动这个原点
    const bandTop = -wrap.getBoundingClientRect().top - BAND_MARGIN_PX;
    apply(
      windowSlice({
        items: items.length,
        size,
        bandTop,
        bandHeight: window.innerHeight + BAND_MARGIN_PX * 2,
        overscanRows: OVERSCAN_ROWS,
      }),
      size,
    );
  }, [apply, items, sizeFor]);

  const computeRef = useRef(compute);
  useEffect(() => {
    computeRef.current = compute;
  });

  // 只有真正靠近视口的分区才测量、才挂载，其余的每帧几次浮点运算就过去了
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) nearRef.current = entry.isIntersecting;
        computeRef.current();
      },
      { rootMargin: `${BAND_MARGIN_PX}px 0px` },
    );
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  useEffect(() => onScrollFrame(() => computeRef.current()), []);

  // 每次绘制前都重算一遍：第一遍往往一张卡片都还没挂（列表刚到、或上一次算完是空窗口），
  // 只能用估计行高；这一遍挂上了卡片，量到真实行高再把占位高度纠正回来。
  // 收敛后 apply() 发现窗口没变就不 setState，所以不会来回抖。
  useLayoutEffect(() => {
    compute();
  });

  const pads = padPx(view.slice, view.size);
  const shown =
    view.slice.end > view.slice.start ? items.slice(view.slice.start, view.slice.end) : [];

  return (
    <div
      ref={wrapRef}
      className="grid-window"
      style={{ paddingTop: pads.top || undefined, paddingBottom: pads.bottom || undefined }}
    >
      <div className="grid" ref={gridRef}>
        {shown.map((entry) => {
          const key = cardKeyOf(entry);
          return (
            <GalleryCard
              key={key}
              entry={entry}
              number={numbering.get(key) || entry.index + 1}
              selected={selected.has(key)}
              staged={staged}
              onCardClick={onCardClick}
              onToggleCheck={onToggleCheck}
              onContextMenu={onContextMenu}
            />
          );
        })}
      </div>
    </div>
  );
}

export const GalleryGrid = memo(GalleryGridInner);
