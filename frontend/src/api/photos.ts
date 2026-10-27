import request from './instance';
import { encodePath } from '../utils/paths';
import type { AppConfig, Photo, SortKey } from '../types';

export interface PhotoListResult {
  photos: Photo[];
  scanErrors: number;
  scanTruncated: boolean;
}

export interface OcrRegResult {
  path: string;
  regs: string[];
  name_regs: string[];
  engine: string;
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

  // 机身文字识别机号：解码 + OCR 都在线程池里跑，慢盘上能到十几秒，
  // 单独放宽超时，别用全局 60s；失败原因（没装 tesseract / 识别不出来）由调用方呈现。
  ocrRegistration: async (path: string) =>
    (
      await request.post<OcrRegResult>(
        '/reg/ocr',
        { path },
        { timeout: 180000, _skipGlobalError: true },
      )
    ).data,
};
