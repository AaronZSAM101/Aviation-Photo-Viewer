import { state, $ } from './state.js';

const PREF_KEY = 'photo-viewer:browse-settings:v1';

const DEFAULTS = {
  currentSort: 'date-asc',
  baseView: 'flat',
  timeScale: 'none',
};

const ALLOWED = {
  currentSort: new Set(['date-asc', 'date-desc', 'name-asc', 'name-desc', 'size-desc']),
  baseView: new Set(['flat', 'folder']),
  timeScale: new Set(['none', 'year', 'month', 'day']),
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
  } catch (e) {
    state.currentSort = DEFAULTS.currentSort;
    state.baseView = DEFAULTS.baseView;
    state.timeScale = DEFAULTS.timeScale;
  }
}

export function saveBrowsePreferences() {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify({
      currentSort: state.currentSort,
      baseView: state.baseView,
      timeScale: state.timeScale,
    }));
  } catch (e) {}
}

export function syncBrowseControls() {
  const sortSel = $('sort-sel');
  const viewModeSel = $('view-mode-sel');
  const timeScaleSel = $('time-scale-sel');

  if (sortSel) sortSel.value = state.currentSort;
  if (viewModeSel) viewModeSel.value = state.baseView;
  if (timeScaleSel) timeScaleSel.value = state.timeScale;
}

