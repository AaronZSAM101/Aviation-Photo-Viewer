import request from './instance';
import type { StageApplyResult, StagedOp, StagedRequest, TrashItem } from '../types';

const noStore = () => ({ params: { _: Date.now() } });

export const StageApi = {
  list: async () =>
    (await request.get<StagedOp[]>('/stage/list', noStore())).data,

  stage: async (body: StagedRequest) =>
    (await request.post<{ id?: string }>('/stage', body, { _skipGlobalError: true })).data,

  remove: async (id: string) =>
    request.post(`/stage/remove/${encodeURIComponent(id)}`, null, { _skipGlobalError: true }),

  clear: async () => request.post('/stage/clear', null, { _skipGlobalError: true }),

  apply: async () =>
    (await request.post<StageApplyResult>('/stage/apply', null, { _skipGlobalError: true })).data,

  listTrash: async () => (await request.get<TrashItem[]>('/trash/list', noStore())).data,

  allowSetDir: async () =>
    (await request.get<{ allowed: boolean }>('/admin/allow_set_dir', { _skipGlobalError: true })).data,

  setPhotosDir: async (path: string) =>
    (
      await request.post<{ ok: boolean; path?: string }>(
        '/admin/set_photos_dir',
        { path },
        { _skipGlobalError: true },
      )
    ).data,
};
