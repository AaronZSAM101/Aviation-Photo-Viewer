import request from './instance';
import { encodePath } from '../utils/paths';
import type { AppConfig, Photo, SortKey } from '../types';

export interface PhotoListResult {
  photos: Photo[];
  scanErrors: number;
  scanTruncated: boolean;
}

export const PhotosApi = {
  getConfig: async () =>
    (await request.get<AppConfig>('/config', { _skipGlobalError: true })).data,

  getPhotos: async (sort: SortKey): Promise<PhotoListResult> => {
    const response = await request.get<Photo[]>('/photos', { params: { sort } });
    const scanErrors = Number(response.headers['x-scan-errors'] ?? 0) || 0;
    return {
      photos: Array.isArray(response.data) ? response.data : [],
      scanErrors,
      scanTruncated: response.headers['x-scan-truncated'] === '1',
    };
  },

  getFolders: async () => (await request.get<string[]>('/folders')).data,

  refreshCaches: async () => (await request.post<{ ok: boolean }>('/cache/refresh')).data,

  getLens: async (subpath: string) =>
    (
      await request.get<{ lens_model?: string | null }>(
        `/exif/lens/${encodePath(subpath)}`,
        { _skipGlobalError: true },
      )
    ).data,
};
