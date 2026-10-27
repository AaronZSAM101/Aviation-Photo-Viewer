import { describe, expect, it, beforeEach } from 'vitest';
import {
  DEFAULT_GAP,
  DEFAULT_MIN_COLUMN,
  EMPTY_SLICE,
  bootstrapSlice,
  columnCount,
  offscreenSlice,
  padPx,
  px,
  rememberGridSize,
  resetSharedGridSize,
  rowCount,
  sameSlice,
  sharedGridSize,
  windowSlice,
  type GridSize,
  type WindowSlice,
} from './rowWindow';

const size: GridSize = { columns: 5, rowHeight: 200, gap: 10 };

// 窗口 + 占位必须精确等于全部挂载时的高度，否则滚动条会随滚动伸缩
const fullHeight = (rows: number, s: GridSize) =>
  rows * s.rowHeight + Math.max(0, rows - 1) * s.gap;

const contentHeight = (slice: WindowSlice, s: GridSize) => {
  const rows = rowCount(slice.end - slice.start, s.columns);
  return rows > 0 ? rows * s.rowHeight + (rows - 1) * s.gap : 0;
};

describe('px / columnCount', () => {
  it('parses css lengths and falls back on garbage', () => {
    expect(px('138px', 9)).toBe(138);
    expect(px('normal', 9)).toBe(9);
    expect(px(null, 9)).toBe(9);
    expect(px('-4px', 9)).toBe(9);
  });

  it('matches the auto-fill track formula', () => {
    // n 列需要 n*175 + (n-1)*10 宽：1400 放得下 7 列（1295），放不下 8 列（1480）
    expect(columnCount(1400, DEFAULT_MIN_COLUMN, DEFAULT_GAP)).toBe(7);
    expect(columnCount(1220, DEFAULT_MIN_COLUMN, DEFAULT_GAP)).toBe(6);
    expect(columnCount(0, 175, 10)).toBe(1);
    expect(columnCount(1000, 0, 10)).toBe(1);
  });
});

describe('rowCount', () => {
  it('rounds up and never divides by zero', () => {
    expect(rowCount(0, 5)).toBe(0);
    expect(rowCount(1, 5)).toBe(1);
    expect(rowCount(11, 5)).toBe(3);
    expect(rowCount(11, 0)).toBe(11);
  });
});

describe('windowSlice', () => {
  it('returns empty for an empty section', () => {
    expect(windowSlice({ items: 0, size, bandTop: 0, bandHeight: 800 })).toEqual(EMPTY_SLICE);
  });

  it('renders everything before there is a measured row height', () => {
    expect(windowSlice({ items: 7, size, bandTop: 0, bandHeight: 0 })).toEqual({
      start: 0,
      end: 7,
      topRows: 0,
      bottomRows: 0,
    });
  });

  it('windows the middle of a list with overscan rows', () => {
    // 20 行，视口看到第 5~7 行，上下各多挂 2 行 → 挂 3~9 行
    const slice = windowSlice({ items: 100, size, bandTop: 5 * 210, bandHeight: 3 * 210 });
    expect(slice).toEqual({ start: 3 * 5, end: 10 * 5, topRows: 3, bottomRows: 20 - 10 });
  });

  it('clamps to the first and last row', () => {
    const top = windowSlice({ items: 100, size, bandTop: -5000, bandHeight: 800 });
    expect(top).toMatchObject({ start: 0, topRows: 0 });
    expect(top.end).toBeGreaterThan(0);

    const bottom = windowSlice({ items: 100, size, bandTop: fullHeight(20, size), bandHeight: 800 });
    expect(bottom.end).toBe(100);
    expect(bottom.bottomRows).toBe(0);
  });

  it('honours a custom overscan', () => {
    const slice = windowSlice({
      items: 100,
      size,
      bandTop: 10 * 210,
      bandHeight: 210,
      overscanRows: 0,
    });
    expect(slice.topRows).toBe(10);
    expect(slice.bottomRows).toBe(20 - 11);
  });
});

describe('padding invariants', () => {
  it('keeps the grid height identical for a window in the middle', () => {
    const slice = windowSlice({ items: 100, size, bandTop: 5 * 210, bandHeight: 3 * 210 });
    const pads = padPx(slice, size);
    expect(pads.top + contentHeight(slice, size) + pads.bottom).toBe(fullHeight(20, size));
  });

  it.each([0, 1, 4, 9, 19, 39, 79, 159, 399, 899, 2000])(
    'keeps the grid height while scrolling past bandTop=%i',
    (bandTop) => {
      const items = 137;
      const slice = windowSlice({ items, size, bandTop, bandHeight: 800 });
      const pads = padPx(slice, size);
      expect(pads.top + contentHeight(slice, size) + pads.bottom).toBe(
        fullHeight(rowCount(items, size.columns), size),
      );
    },
  );

  it('collapses to a single pad when nothing is mounted', () => {
    const slice = offscreenSlice(100, size);
    expect(slice).toEqual({ start: 0, end: 0, topRows: 0, bottomRows: 20 });
    const pads = padPx(slice, size);
    expect(pads.top).toBe(0);
    expect(pads.bottom).toBe(fullHeight(20, size));
  });

  it('pads nothing for the bootstrap render', () => {
    const slice = bootstrapSlice(100, 3);
    expect(slice).toEqual({ start: 0, end: 3, topRows: 0, bottomRows: 0 });
    expect(padPx(slice, size)).toEqual({ top: 0, bottom: 0 });
  });
});

describe('window bounds', () => {
  it('keeps the mounted rows inside viewport + overscan', () => {
    const viewportRows = Math.ceil(800 / 210);
    for (let bandTop = 0; bandTop < fullHeight(20, size); bandTop += 37) {
      const slice = windowSlice({ items: 100, size, bandTop, bandHeight: 800, overscanRows: 1 });
      const rows = rowCount(slice.end - slice.start, size.columns);
      expect(rows).toBeLessThanOrEqual(viewportRows + 2 + 1);
    }
  });

  it('reaches every item while scrolling the whole list', () => {
    const items = 137;
    const rows = rowCount(items, size.columns);
    const seen = new Set<number>();
    for (let bandTop = -800; bandTop <= fullHeight(rows, size); bandTop += 50) {
      const slice = windowSlice({ items, size, bandTop, bandHeight: 800 });
      for (let i = slice.start; i < slice.end; i += 1) seen.add(i);
    }
    expect(seen.size).toBe(items);
  });
});

describe('shared grid size', () => {
  beforeEach(() => resetSharedGridSize());

  it('is reused only while the width still matches', () => {
    expect(sharedGridSize(1400)).toBeNull();
    rememberGridSize(size, 1400);
    expect(sharedGridSize(1400)).toEqual(size);
    expect(sharedGridSize(900)).toBeNull();
  });
});

describe('sameSlice', () => {
  it('compares by value', () => {
    expect(sameSlice(EMPTY_SLICE, { start: 0, end: 0, topRows: 0, bottomRows: 0 })).toBe(true);
    expect(sameSlice(EMPTY_SLICE, { start: 0, end: 1, topRows: 0, bottomRows: 0 })).toBe(false);
  });
});
