import type {
  BaseView,
  GalleryCardEntry,
  GallerySection,
  Photo,
  SortKey,
  TimeScale,
} from '../types';

interface TimeGroup {
  key: string;
  label: string;
  sort: number;
}

function timeGroupOf(p: Photo, scale: Exclude<TimeScale, 'none'>): TimeGroup {
  const k = p.date_sort_key;
  if (!k) return { key: '__nodate__', label: '未知日期', sort: -1 };
  const s = String(k).padStart(14, '0');
  const Y = s.slice(0, 4);
  const M = s.slice(4, 6);
  const D = s.slice(6, 8);
  if (scale === 'year') return { key: Y, label: `${Y} 年`, sort: parseInt(Y, 10) };
  if (scale === 'month') {
    return { key: Y + M, label: `${Y} 年 ${parseInt(M, 10)} 月`, sort: parseInt(Y + M, 10) };
  }
  return { key: Y + M + D, label: `${Y}-${M}-${D}`, sort: parseInt(Y + M + D, 10) };
}

function sortTimeGroups<T extends { sort: number }>(entries: T[], sort: SortKey): T[] {
  const asc = sort === 'date-asc';
  return [...entries].sort((a, b) => {
    if (a.sort < 0) return 1;
    if (b.sort < 0) return -1;
    return asc ? a.sort - b.sort : b.sort - a.sort;
  });
}

function flatSection(entries: GalleryCardEntry[]): GallerySection {
  return { key: null, label: '', icon: '', count: entries.length, items: entries, children: [] };
}

function groupByTime(entries: GalleryCardEntry[], scale: Exclude<TimeScale, 'none'>, sort: SortKey) {
  const groups = new Map<string, { label: string; sort: number; items: GalleryCardEntry[] }>();
  entries.forEach((entry) => {
    const g = timeGroupOf(entry.photo, scale);
    if (!groups.has(g.key)) groups.set(g.key, { label: g.label, sort: g.sort, items: [] });
    groups.get(g.key)!.items.push(entry);
  });
  return sortTimeGroups([...groups.values()], sort);
}

export function buildSections(
  photos: Photo[],
  baseView: BaseView,
  timeScale: TimeScale,
  sort: SortKey,
): GallerySection[] {
  const entries: GalleryCardEntry[] = photos.map((photo, index) => ({ photo, index }));

  if (baseView === 'flat' && timeScale === 'none') {
    return [flatSection(entries)];
  }

  if (baseView === 'flat' && timeScale !== 'none') {
    return groupByTime(entries, timeScale, sort).map((info) => ({
      key: `time:${timeScale}:${info.label}`,
      label: info.label,
      icon: '📅',
      count: info.items.length,
      items: info.items,
      children: [],
    }));
  }

  const folderMap = new Map<string, GalleryCardEntry[]>();
  entries.forEach((entry) => {
    const folder = entry.photo.folder || '(根目录)';
    if (!folderMap.has(folder)) folderMap.set(folder, []);
    folderMap.get(folder)!.push(entry);
  });

  return [...folderMap.keys()]
    .sort((a, b) => a.localeCompare(b, 'zh-CN'))
    .map((folder) => {
      const folderItems = folderMap.get(folder)!;
      if (timeScale === 'none') {
        return {
          key: `folder:${folder}`,
          label: folder,
          icon: '▤',
          count: folderItems.length,
          items: folderItems,
          children: [],
        };
      }
      const children = groupByTime(folderItems, timeScale, sort).map((info) => ({
        key: `folder:${folder}:time:${timeScale}:${info.label}`,
        label: info.label,
        icon: '📅',
        count: info.items.length,
        items: info.items,
        children: [],
      }));
      return {
        key: `folder:${folder}`,
        label: folder,
        icon: '▤',
        count: folderItems.length,
        items: [],
        children,
      };
    });
}

export function collectSectionKeys(sections: GallerySection[]): string[] {
  const keys: string[] = [];
  const walk = (list: GallerySection[]) => {
    list.forEach((section) => {
      if (section.key) keys.push(section.key);
      if (section.children.length) walk(section.children);
    });
  };
  walk(sections);
  return keys;
}
