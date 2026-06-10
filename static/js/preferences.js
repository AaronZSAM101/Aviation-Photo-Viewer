import { state, $ } from './state.js';

const PREF_KEY = 'photo-viewer:browse-settings:v1';

const DEFAULTS = {
  currentSort: 'date-asc',
  baseView: 'flat',
  timeScale: 'none',
  zoomMode: 'fit',
};

const ALLOWED = {
  currentSort: new Set(['date-asc', 'date-desc', 'name-asc', 'name-desc', 'size-desc']),
  baseView: new Set(['flat', 'folder']),
  timeScale: new Set(['none', 'year', 'month', 'day']),
  zoomMode: new Set(['fit', 'actual', 'fill']),
};

function pickAllowed(key, value) {
  return ALLOWED[key].has(value) ? value : DEFAULTS[key];
}

export function loadBrowsePreferences() {
  try {
    const prefs = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
    state.currentSort = pickAllowed('currentSort', prefs.currentSort || state.currentSort);
    state.baseView = pickAllowed('baseView', prefs.baseView || state.baseView);
    state.timeScale = pickAllowed('timeScale', prefs.timeScale || state.timeScale);
    state.zoomMode = pickAllowed('zoomMode', prefs.zoomMode || state.zoomMode);
  } catch (e) {
    state.currentSort = DEFAULTS.currentSort;
    state.baseView = DEFAULTS.baseView;
    state.timeScale = DEFAULTS.timeScale;
    state.zoomMode = DEFAULTS.zoomMode;
  }
}

export function saveBrowsePreferences() {
  try {
    const current = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
    const savedZoomMode = pickAllowed('zoomMode', current.zoomMode || DEFAULTS.zoomMode);
    localStorage.setItem(PREF_KEY, JSON.stringify({
      currentSort: state.currentSort,
      baseView: state.baseView,
      timeScale: state.timeScale,
      zoomMode: ALLOWED.zoomMode.has(state.zoomMode) ? state.zoomMode : savedZoomMode,
    }));
  } catch (e) {}
}

export function syncBrowseControls() {
  const sortSel = $('sort-sel');
  const viewModeSel = $('view-mode-sel');
  const timeScaleSel = $('time-scale-sel');
  const zoomSel = $('v-zoom-sel');

  if (sortSel) sortSel.value = state.currentSort;
  if (viewModeSel) viewModeSel.value = state.baseView;
  if (timeScaleSel) timeScaleSel.value = state.timeScale;
  if (zoomSel) zoomSel.value = ALLOWED.zoomMode.has(state.zoomMode) ? state.zoomMode : DEFAULTS.zoomMode;
}
