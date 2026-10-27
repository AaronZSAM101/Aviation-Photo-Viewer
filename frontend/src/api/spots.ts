import request from './instance';
import type { ExifData, Spot } from '../types';

export interface SpotSaveRequest extends Spot {
  // 库根用空字符串，和后端 spots.json 的 key 一致
  folder: string;
}

export interface ApplySpotResult {
  ok: boolean;
  src: string;
  // 只有 GPS 四件套有值，其余字段是 null：合并时只取不为空的那几个
  exif: ExifData;
  spot: Spot;
}

export const SpotsApi = {
  list: async () => (await request.get<Record<string, Spot>>('/spots')).data,

  save: async (body: SpotSaveRequest) =>
    (await request.post<{ ok: boolean }>('/spots', body, { _skipGlobalError: true })).data,

  remove: async (folder: string) =>
    (
      await request.post<{ ok: boolean }>('/spots/delete', { folder }, { _skipGlobalError: true })
    ).data,

  // 把文件夹档案里的坐标补进这张照片的 EXIF 覆盖层：原图一个字节都不改
  apply: async (src: string) =>
    (
      await request.post<ApplySpotResult>('/spot/apply', { src }, { _skipGlobalError: true })
    ).data,
};
