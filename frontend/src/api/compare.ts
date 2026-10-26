import request from './instance';
import type { CompareResult, SimilarJob, SimilarScanParams } from '../types';

export const CompareApi = {
  compare: async (a: string, b: string) =>
    (
      await request.get<CompareResult>('/compare', {
        params: { a, b },
        _skipGlobalError: true,
      })
    ).data,

  startSimilarScan: async (params: SimilarScanParams) =>
    (
      await request.post<SimilarJob>('/similar/jobs', null, {
        params,
        _skipGlobalError: true,
      })
    ).data,

  getSimilarJob: async (id: string) =>
    (
      await request.get<SimilarJob>(`/similar/jobs/${encodeURIComponent(id)}`, {
        _skipGlobalError: true,
      })
    ).data,
};
