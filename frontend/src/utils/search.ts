import type { Photo } from '../types';
import { subpath } from './paths';

// 机号里的分隔符（B-3207 / B 3207）打字时基本不会带上，比对前先抹掉；
// 文件名和路径仍按原样子串匹配，避免把 "1-2" 这种片段搜成通配。
const compact = (value: string) => value.toLowerCase().replace(/[\s\-/]/g, '');

/** 搜索框的一个词能否命中这张照片：文件名、所在文件夹、完整路径、机号。 */
export function photoMatchesTerm(photo: Photo, term: string): boolean {
  const trimmed = term.trim();
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();
  if (
    photo.filename.toLowerCase().includes(lower) ||
    (photo.folder || '').toLowerCase().includes(lower) ||
    subpath(photo).toLowerCase().includes(lower)
  ) {
    return true;
  }
  const needle = compact(lower);
  return (photo.regs ?? []).some((reg) => compact(reg).includes(needle));
}

export function filterPhotos(photos: Photo[], term: string): Photo[] {
  if (!term.trim()) return photos;
  return photos.filter((photo) => photoMatchesTerm(photo, term));
}
