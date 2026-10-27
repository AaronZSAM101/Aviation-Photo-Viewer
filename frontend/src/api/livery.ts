import request from './instance';
import type { LiveryFeed, WatchItem } from '../types';

export interface WatchListResult {
  items: WatchItem[];
  feedConfigured: boolean;
}

export const LiveryApi = {
  // 排班数据源在别人家的机器上，读不到是常态：超时给足，错误一律由界面自己说清楚
  feed: async (airport: string, day: string, refresh = false) =>
    (
      await request.get<LiveryFeed>(
        '/livery/feed',
        { params: { airport, day, refresh: refresh ? 1 : undefined }, timeout: 40000, _skipGlobalError: true },
      )
    ).data,

  listWatch: async () => (await request.get<WatchListResult>('/livery/watch')).data,

  watch: async (body: { registration: string; name: string; note?: string; documented?: boolean }) =>
    (
      await request.post<{ ok: boolean; registration: string; count: number }>(
        '/livery/watch',
        body,
        { _skipGlobalError: true },
      )
    ).data,

  unwatch: async (registration: string) =>
    (
      await request.post<{ ok: boolean; removed: boolean }>(
        '/livery/watch/delete',
        { registration },
        { _skipGlobalError: true },
      )
    ).data,
};
