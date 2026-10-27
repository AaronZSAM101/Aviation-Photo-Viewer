import { createSlice, type Dispatch, type PayloadAction } from '@reduxjs/toolkit';
import { LiveryApi } from '../api/livery';
import { LIVERY_PREF_KEY } from '../config';
import type { LiveryFeed, WatchItem } from '../types';
import { errorText } from '../utils/errors';
import { dayValue, LIVERY_AIRPORTS, watchKey } from '../utils/livery';

// 数据源是他家机器上的排班站，默认机场照抄 AIRFRAME 自己的默认值；
// 真正用的是本机记住的那一个，切一次就不用再选。
const FALLBACK_AIRPORT = 'SHA';

interface LiveryPrefs {
  airport: string;
  dayOffset: number;
}

function readPrefs(): LiveryPrefs {
  const fallback: LiveryPrefs = { airport: FALLBACK_AIRPORT, dayOffset: 0 };
  try {
    const stored = JSON.parse(localStorage.getItem(LIVERY_PREF_KEY) || '{}') as Record<string, unknown>;
    const storedAirport = typeof stored.airport === 'string' ? stored.airport.toUpperCase() : '';
    return {
      airport: LIVERY_AIRPORTS.some((option) => option.code === storedAirport)
        ? storedAirport
        : fallback.airport,
      dayOffset: stored.dayOffset === 1 ? 1 : 0,
    };
  } catch {
    return fallback;
  }
}

function persistPrefs(prefs: LiveryPrefs) {
  try {
    localStorage.setItem(LIVERY_PREF_KEY, JSON.stringify(prefs));
  } catch {
    // ignore storage failures
  }
}

export interface LiveryState extends LiveryPrefs {
  /** 关注表：后端 watchlist.json，按机号排序。数据源有没有配走 app.liveryConfigured */
  watchlist: WatchItem[];
  feed: LiveryFeed | null;
  loading: boolean;
  /** 请求本身失败（后端都连不上），跟 feed.state 里的「数据源读不到」不是一回事 */
  error: string | null;
  /** 本次会话有没有自动拉过：顶栏徽章要有数，但别每次刷新相册都打一次别人家的接口 */
  attempted: boolean;
}

const initialState: LiveryState = {
  ...readPrefs(),
  watchlist: [],
  feed: null,
  loading: false,
  error: null,
  attempted: false,
};

const liverySlice = createSlice({
  name: 'livery',
  initialState,
  reducers: {
    setWatchlist: (state, action: PayloadAction<WatchItem[]>) => {
      state.watchlist = action.payload;
    },
    // 存/删关注先改内存：徽章和「这台已经记过了」立刻对上，不等下一次列表请求
    putWatch: (state, action: PayloadAction<WatchItem>) => {
      const key = watchKey(action.payload.registration);
      const rest = state.watchlist.filter((item) => watchKey(item.registration) !== key);
      state.watchlist = [...rest, action.payload].sort((a, b) =>
        a.registration.localeCompare(b.registration),
      );
    },
    dropWatch: (state, action: PayloadAction<string>) => {
      const key = watchKey(action.payload);
      state.watchlist = state.watchlist.filter((item) => watchKey(item.registration) !== key);
    },
    setAirport: (state, action: PayloadAction<string>) => {
      state.airport = action.payload.toUpperCase();
      persistPrefs({ airport: state.airport, dayOffset: state.dayOffset });
    },
    setDayOffset: (state, action: PayloadAction<number>) => {
      state.dayOffset = action.payload === 1 ? 1 : 0;
      persistPrefs({ airport: state.airport, dayOffset: state.dayOffset });
    },
    feedRequested: (state) => {
      state.loading = true;
      state.error = null;
    },
    feedReceived: (state, action: PayloadAction<LiveryFeed>) => {
      state.feed = action.payload;
      state.loading = false;
      state.attempted = true;
    },
    feedRejected: (state, action: PayloadAction<string>) => {
      state.error = action.payload;
      state.loading = false;
      state.attempted = true;
    },
  },
});

export const {
  setWatchlist,
  putWatch,
  dropWatch,
  setAirport,
  setDayOffset,
  feedRequested,
  feedReceived,
  feedRejected,
} = liverySlice.actions;

/**
 * 关注表：读不到就当下空表——它是手写的，别拿旧内存数据顶着一个已经连不上的后端。
 */
export async function refreshWatchlist(dispatch: Dispatch) {
  try {
    dispatch(setWatchlist((await LiveryApi.listWatch()).items));
  } catch {
    dispatch(setWatchlist([]));
  }
}

/**
 * 拉一次提醒。顶栏徽章和弹窗共用这一个入口：徽章要数字就得有人在打开弹窗之前先拉一次，
 * 而后端按机场+日期缓存 5 分钟，所以一次会话自动拉一遍不会反复打别人家的接口。
 */
export async function refreshLiveryFeed(
  dispatch: Dispatch,
  args: { airport: string; dayOffset: number; refresh?: boolean },
) {
  dispatch(feedRequested());
  try {
    const feed = await LiveryApi.feed(args.airport, dayValue(args.airport, args.dayOffset), !!args.refresh);
    dispatch(feedReceived(feed));
  } catch (error) {
    dispatch(feedRejected(errorText(error, '排班数据源请求失败')));
  }
}

export default liverySlice.reducer;
