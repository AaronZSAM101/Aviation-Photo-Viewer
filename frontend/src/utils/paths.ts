import type { Photo } from '../types';

export function subpath(p: Pick<Photo, 'folder' | 'filename'>): string {
  return p.folder ? `${p.folder}/${p.filename}` : p.filename;
}

export function encodePath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}

export function decodeViewerPath(pathname: string): string | null {
  const prefix = '/view/';
  if (!pathname.startsWith(prefix)) return null;
  try {
    return decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    return pathname.slice(prefix.length);
  }
}

export function photoVersion(p: Pick<Photo, 'mtime' | 'size'>): string {
  const mtime = Number.isFinite(p?.mtime) ? p.mtime : 0;
  const size = Number.isFinite(p?.size) ? p.size : 0;
  return `${mtime}-${size}`;
}

export function thumbUrl(p: Photo): string {
  return `/thumb/${encodePath(subpath(p))}?v=${photoVersion(p)}`;
}

export function previewUrl(p: Photo): string {
  return `/preview/${encodePath(subpath(p))}?v=${photoVersion(p)}`;
}

export function photoUrl(p: Photo): string {
  return `/photos/${encodePath(subpath(p))}?v=${photoVersion(p)}`;
}

export function splitSubpath(sp: string): { folder: string; name: string } {
  const i = sp.lastIndexOf('/');
  return i >= 0
    ? { folder: sp.slice(0, i), name: sp.slice(i + 1) }
    : { folder: '', name: sp };
}

export function joinSubpath(folder: string, name: string): string {
  return folder ? `${folder}/${name}` : name;
}
