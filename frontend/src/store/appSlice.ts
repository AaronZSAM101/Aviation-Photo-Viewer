import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { BROWSE_PREF_STORAGE_KEY, THEME_STORAGE_KEY } from '../config';
import type {
  AppConfig,
  BaseView,
  BrowsePreferences,
  GpsMapSettings,
  SortKey,
  ThemeMode,
  TimeScale,
  ZoomMode,
} from '../types';
import {
  loadGpsCustomAircraftLength,
  loadGpsMapSettings,
  saveGpsCustomAircraftLength,
  saveGpsMapSettings,
} from '../utils/gps';

const SORT_KEYS: SortKey[] = ['date-asc', 'date-desc', 'name-asc', 'name-desc', 'size-desc'];
const BASE_VIEWS: BaseView[] = ['flat', 'folder'];
const TIME_SCALES: TimeScale[] = ['none', 'year', 'month', 'day'];
const ZOOM_MODES: ZoomMode[] = ['fit', 'actual', 'fill'];

const isSort = (value: string | null): value is SortKey => !!value && SORT_KEYS.includes(value as SortKey);
const isBaseView = (value: string | null): value is BaseView =>
  !!value && BASE_VIEWS.includes(value as BaseView);
const isTimeScale = (value: string | null): value is TimeScale =>
  !!value && TIME_SCALES.includes(value as TimeScale);
const isZoomMode = (value: unknown): value is ZoomMode =>
  typeof value === 'string' && ZOOM_MODES.includes(value as ZoomMode);

export interface LoadingPatch {
  visible?: boolean;
  message?: string;
  progress?: number;
}

export interface AppState extends BrowsePreferences {
  themeMode: ThemeMode;
  readOnly: boolean;
  // 容器里有没有装 tesseract：决定信息面板的「识别机号」按钮能否点
  ocrAvailable: boolean;
  // 容器里有没有配排班数据源（AIRFRAME_URL / LIVERY_FEED_URL）：没配时彩绘提醒只能看关注表
  liveryConfigured: boolean;
  version: string | null;
  versionSource: string | null;
  user: string | null;
  email: string | null;
  searchTerm: string;
  collapseAll: boolean;
  collapsedSections: string[];
  expandedSections: string[];
  loadingVisible: boolean;
  loadingMessage: string;
  loadingProgress: number;
  gpsSettings: GpsMapSettings;
  gpsCustomAircraftLength: number | null;
}

function readThemeMode(): ThemeMode {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // ignore storage failures
  }
  return 'auto';
}

function readBrowsePreferences(): BrowsePreferences {
  const defaults: BrowsePreferences = {
    currentSort: 'date-asc',
    baseView: 'flat',
    timeScale: 'none',
    zoomMode: 'fit',
  };
  try {
    const prefs = JSON.parse(localStorage.getItem(BROWSE_PREF_STORAGE_KEY) || '{}') as Record<string, unknown>;
    return {
      currentSort: isSort(typeof prefs.currentSort === 'string' ? prefs.currentSort : null)
        ? (prefs.currentSort as SortKey)
        : defaults.currentSort,
      baseView: isBaseView(typeof prefs.baseView === 'string' ? prefs.baseView : null)
        ? (prefs.baseView as BaseView)
        : defaults.baseView,
      timeScale: isTimeScale(typeof prefs.timeScale === 'string' ? prefs.timeScale : null)
        ? (prefs.timeScale as TimeScale)
        : defaults.timeScale,
      zoomMode: isZoomMode(prefs.zoomMode) ? prefs.zoomMode : defaults.zoomMode,
    };
  } catch {
    return defaults;
  }
}

function readInitialBrowse(): BrowsePreferences & {
  searchTerm: string;
  collapseAll: boolean;
  collapsedSections: string[];
  expandedSections: string[];
} {
  const prefs = readBrowsePreferences();
  const params = new URLSearchParams(window.location.search);
  const sort = params.get('sort');
  const view = params.get('view');
  const scale = params.get('scale');
  return {
    currentSort: isSort(sort) ? sort : prefs.currentSort,
    baseView: isBaseView(view) ? view : prefs.baseView,
    timeScale: isTimeScale(scale) ? scale : prefs.timeScale,
    zoomMode: prefs.zoomMode,
    searchTerm: params.get('q')?.trim() || '',
    collapseAll: params.get('collapse') === '1' || params.get('collapse') === 'true',
    collapsedSections: params.getAll('closed').filter(Boolean),
    expandedSections: params.getAll('open').filter(Boolean),
  };
}

function persistBrowsePreferences(state: AppState) {
  try {
    const current = JSON.parse(localStorage.getItem(BROWSE_PREF_STORAGE_KEY) || '{}') as Record<string, unknown>;
    const savedZoom = isZoomMode(current.zoomMode) ? current.zoomMode : 'fit';
    localStorage.setItem(
      BROWSE_PREF_STORAGE_KEY,
      JSON.stringify({
        currentSort: state.currentSort,
        baseView: state.baseView,
        timeScale: state.timeScale,
        zoomMode: state.zoomMode === 'custom' ? savedZoom : state.zoomMode,
      }),
    );
  } catch {
    // ignore storage failures
  }
}

function persistThemeMode(mode: ThemeMode) {
  try {
    if (mode === 'auto') localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // ignore storage failures
  }
}

const initialBrowse = readInitialBrowse();

const initialState: AppState = {
  ...initialBrowse,
  themeMode: readThemeMode(),
  readOnly: false,
  ocrAvailable: false,
  liveryConfigured: false,
  version: null,
  versionSource: null,
  user: null,
  email: null,
  loadingVisible: false,
  loadingMessage: '加载中…',
  loadingProgress: 0,
  gpsSettings: loadGpsMapSettings(),
  gpsCustomAircraftLength: loadGpsCustomAircraftLength(),
};

const appSlice = createSlice({
  name: 'app',
  initialState,
  reducers: {
    setThemeMode: (state, action: PayloadAction<ThemeMode>) => {
      state.themeMode = action.payload;
      persistThemeMode(action.payload);
    },
    cycleThemeMode: (state) => {
      const order: ThemeMode[] = ['auto', 'light', 'dark'];
      state.themeMode = order[(order.indexOf(state.themeMode) + 1) % order.length];
      persistThemeMode(state.themeMode);
    },
    applyConfig: (state, action: PayloadAction<AppConfig>) => {
      const config = action.payload;
      state.readOnly = !!config.readOnly;
      state.ocrAvailable = !!config.ocrAvailable;
      state.liveryConfigured = !!config.liveryConfigured;
      state.version = config.version || null;
      state.versionSource = config.versionSource || null;
      state.user = config.user || null;
      state.email = config.email || null;
    },
    setSort: (state, action: PayloadAction<SortKey>) => {
      state.currentSort = action.payload;
      persistBrowsePreferences(state);
    },
    setBaseView: (state, action: PayloadAction<BaseView>) => {
      state.baseView = action.payload;
      persistBrowsePreferences(state);
    },
    setTimeScale: (state, action: PayloadAction<TimeScale>) => {
      state.timeScale = action.payload;
      persistBrowsePreferences(state);
    },
    setZoomMode: (state, action: PayloadAction<ZoomMode>) => {
      state.zoomMode = action.payload;
      persistBrowsePreferences(state);
    },
    setSearchTerm: (state, action: PayloadAction<string>) => {
      state.searchTerm = action.payload;
    },
    setCollapseState: (
      state,
      action: PayloadAction<{
        collapseAll: boolean;
        collapsedSections: string[];
        expandedSections: string[];
      }>,
    ) => {
      state.collapseAll = action.payload.collapseAll;
      state.collapsedSections = action.payload.collapsedSections;
      state.expandedSections = action.payload.expandedSections;
    },
    setLoading: (
      state,
      action: PayloadAction<LoadingPatch>,
    ) => {
      const patch = action.payload;
      if (patch.visible !== undefined) state.loadingVisible = patch.visible;
      if (patch.message !== undefined) state.loadingMessage = patch.message;
      if (patch.progress !== undefined) state.loadingProgress = patch.progress;
    },
    setGpsSettings: (state, action: PayloadAction<GpsMapSettings>) => {
      state.gpsSettings = action.payload;
      saveGpsMapSettings(action.payload);
    },
    setGpsCustomAircraftLength: (state, action: PayloadAction<number | null>) => {
      state.gpsCustomAircraftLength = saveGpsCustomAircraftLength(action.payload);
    },
  },
});

export const {
  setThemeMode,
  cycleThemeMode,
  applyConfig,
  setSort,
  setBaseView,
  setTimeScale,
  setZoomMode,
  setSearchTerm,
  setCollapseState,
  setLoading,
  setGpsSettings,
  setGpsCustomAircraftLength,
} = appSlice.actions;

export default appSlice.reducer;
