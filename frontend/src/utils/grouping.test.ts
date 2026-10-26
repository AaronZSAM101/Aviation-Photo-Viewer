import { describe, expect, it } from 'vitest';
import type { GallerySection, Photo } from '../types';
import { buildSections, collectSectionKeys } from './grouping';

function photo(filename: string, folder: string, dateKey: number): Photo {
  return {
    filename,
    folder,
    size: 100,
    mtime: dateKey,
    exif: {} as Photo['exif'],
    date_sort_key: dateKey,
  };
}

const PHOTOS = [
  photo('a.jpg', 'Queued', 20240101120000),
  photo('b.jpg', 'Queued', 20240115120000),
  photo('c.jpg', 'Queued', 20240201120000),
  photo('d.jpg', 'Personal Gallery', 20231231235900),
  photo('e.jpg', '', 20240102083000),
];

function labels(sections: GallerySection[]): string[] {
  return sections.map((s) => `${s.label}(${s.count})`);
}

describe('flat view without time grouping', () => {
  it('is one anonymous section holding every card in input order', () => {
    const sections = buildSections(PHOTOS, 'flat', 'none', 'date-desc');
    expect(sections).toHaveLength(1);
    expect(sections[0].key).toBeNull();
    expect(sections[0].items.map((e) => e.photo.filename)).toEqual(['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg']);
    expect(sections[0].items.map((e) => e.index)).toEqual([0, 1, 2, 3, 4]);
  });

  it('survives an empty library', () => {
    const sections = buildSections([], 'flat', 'none', 'date-desc');
    expect(sections).toHaveLength(1);
    expect(sections[0].count).toBe(0);
  });
});

describe('flat view with time grouping', () => {
  it('buckets by month and puts undated photos last whatever the sort', () => {
    const withUndated = [...PHOTOS, photo('f.jpg', 'Queued', 0)];
    const desc = buildSections(withUndated, 'flat', 'month', 'date-desc');
    const asc = buildSections(withUndated, 'flat', 'month', 'date-asc');
    expect(labels(desc)).toEqual(['2024 年 2 月(1)', '2024 年 1 月(3)', '2023 年 12 月(1)', '未知日期(1)']);
    expect(labels(asc)).toEqual(['2023 年 12 月(1)', '2024 年 1 月(3)', '2024 年 2 月(1)', '未知日期(1)']);
    expect(desc[0].key).toBe('time:month:2024 年 2 月');
  });

  it('renders year and day scales', () => {
    expect(labels(buildSections(PHOTOS, 'flat', 'year', 'date-desc'))).toEqual(['2024 年(4)', '2023 年(1)']);
    expect(labels(buildSections(PHOTOS, 'flat', 'day', 'date-asc'))).toEqual([
      '2023-12-31(1)',
      '2024-01-01(1)',
      '2024-01-02(1)',
      '2024-01-15(1)',
      '2024-02-01(1)',
    ]);
  });
});

describe('folder view', () => {
  it('sorts folders and keeps every photo under its own folder', () => {
    const sections = buildSections(PHOTOS, 'folder', 'none', 'date-desc');
    expect(sections.map((s) => s.label)).toEqual(['(根目录)', 'Personal Gallery', 'Queued']);
    expect(sections.map((s) => s.count)).toEqual([1, 1, 3]);
    expect(sections.every((s) => s.children.length === 0)).toBe(true);
    expect(sections.map((s) => s.key)).toEqual(['folder:(根目录)', 'folder:Personal Gallery', 'folder:Queued']);
  });

  it('nests time groups inside each folder when a scale is picked', () => {
    const sections = buildSections(PHOTOS, 'folder', 'month', 'date-desc');
    const queued = sections.find((s) => s.label === 'Queued')!;
    expect(queued.items).toEqual([]);
    expect(queued.count).toBe(3);
    expect(queued.children.map((c) => `${c.label}(${c.count})`)).toEqual(['2024 年 2 月(1)', '2024 年 1 月(2)']);
    expect(queued.children[0].key).toBe('folder:Queued:time:month:2024 年 2 月');
  });

  it('groups a root-level photo into the 未知日期 bucket only when it has no stamp', () => {
    const sections = buildSections([photo('x.jpg', '', 0)], 'folder', 'day', 'date-desc');
    expect(sections[0].label).toBe('(根目录)');
    expect(sections[0].children.map((c) => c.label)).toEqual(['未知日期']);
  });
});

describe('collectSectionKeys', () => {
  it('walks nested sections so collapse state can be persisted', () => {
    const keys = collectSectionKeys(buildSections(PHOTOS, 'folder', 'month', 'date-desc'));
    expect(keys).toContain('folder:Queued');
    expect(keys).toContain('folder:Queued:time:month:2024 年 1 月');
    expect(keys.filter((k) => /^folder:[^:]+$/.test(k))).toHaveLength(3);
    expect(keys).toHaveLength(7);
  });

  it('skips the anonymous flat section', () => {
    expect(collectSectionKeys(buildSections(PHOTOS, 'flat', 'none', 'date-desc'))).toEqual([]);
  });
});
