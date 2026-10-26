import { describe, expect, it } from 'vitest';
import type { Photo } from '../types';
import {
  decodeViewerPath,
  encodePath,
  joinSubpath,
  photoUrl,
  photoVersion,
  previewUrl,
  splitSubpath,
  subpath,
  thumbUrl,
} from './paths';

function photo(over: Partial<Photo> = {}): Photo {
  return {
    filename: 'B-5218.jpg',
    folder: 'Queued',
    size: 1234,
    mtime: 1700000000,
    exif: {} as Photo['exif'],
    date_sort_key: 20240101120000,
    ...over,
  };
}

describe('subpath', () => {
  it('joins folder and filename', () => {
    expect(subpath(photo({ folder: 'Queued/2024', filename: 'a.jpg' }))).toBe('Queued/2024/a.jpg');
  });

  it('drops the separator for root-level photos', () => {
    expect(subpath(photo({ folder: '' }))).toBe('B-5218.jpg');
  });
});

describe('encodePath', () => {
  it('keeps separators but encodes each segment', () => {
    expect(encodePath('My Photos/B 7378 #1.jpg')).toBe('My%20Photos/B%207378%20%231.jpg');
  });

  it('encodes CJK without touching slashes', () => {
    expect(encodePath('彩绘机/南航.jpg')).toBe('%E5%BD%A9%E7%BB%98%E6%9C%BA/%E5%8D%97%E8%88%AA.jpg');
  });
});

describe('decodeViewerPath', () => {
  it('returns null for anything outside the viewer route', () => {
    expect(decodeViewerPath('/gallery')).toBeNull();
    expect(decodeViewerPath('/view')).toBeNull();
  });

  it('decodes a nested path', () => {
    expect(decodeViewerPath('/view/Queued%2F2024/B%207378.jpg')).toBe('Queued/2024/B 7378.jpg');
  });

  it('falls back to the raw tail when the encoding is broken', () => {
    expect(decodeViewerPath('/view/bad%ZZ.jpg')).toBe('bad%ZZ.jpg');
  });
});

describe('photoVersion', () => {
  it('is built from mtime and size', () => {
    expect(photoVersion(photo({ mtime: 1700, size: 42 }))).toBe('1700-42');
  });

  it('treats missing or non-finite stamps as zero', () => {
    expect(photoVersion({ mtime: Number.NaN, size: undefined } as never)).toBe('0-0');
  });
});

describe('image urls', () => {
  it('point at the three backend routes with a version stamp', () => {
    const p = photo({ folder: 'Personal Gallery', filename: 'a b.jpg', mtime: 9, size: 8 });
    expect(thumbUrl(p)).toBe('/thumb/Personal%20Gallery/a%20b.jpg?v=9-8');
    expect(previewUrl(p)).toBe('/preview/Personal%20Gallery/a%20b.jpg?v=9-8');
    expect(photoUrl(p)).toBe('/photos/Personal%20Gallery/a%20b.jpg?v=9-8');
  });

  it('works for a root-level photo', () => {
    expect(thumbUrl(photo({ folder: '', mtime: 1, size: 1 }))).toBe('/thumb/B-5218.jpg?v=1-1');
  });
});

describe('splitSubpath / joinSubpath', () => {
  it('splits on the last separator only', () => {
    expect(splitSubpath('a/b/c.jpg')).toEqual({ folder: 'a/b', name: 'c.jpg' });
    expect(splitSubpath('c.jpg')).toEqual({ folder: '', name: 'c.jpg' });
  });

  it('omits the folder when there is none', () => {
    expect(joinSubpath('', 'c.jpg')).toBe('c.jpg');
    expect(joinSubpath('a/b', 'c.jpg')).toBe('a/b/c.jpg');
  });

  it('round-trips', () => {
    for (const sp of ['c.jpg', 'a/c.jpg', '彩绘机/南航/a b.jpg']) {
      const { folder, name } = splitSubpath(sp);
      expect(joinSubpath(folder, name)).toBe(sp);
    }
  });
});
