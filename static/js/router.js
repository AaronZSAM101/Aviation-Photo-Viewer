import { dom, state, $ } from './state.js';
import { encodePath, subpath } from './utils.js';

let initialViewerSubpath = null;

function readBoolParam(params, key) {
  const value = params.get(key);
  return value === '1' || value === 'true';
}

function writeStateParam(params, key, value, defaultValue) {
  if (value == null || value === '' || value === defaultValue) {
    params.delete(key);
    return;
  }
  params.set(key, value);
}

export function applyRouteStateFromLocation() {
  const url = new URL(window.location.href);
  const params = url.searchParams;

  state.currentSort = params.get('sort') || state.currentSort;
  state.baseView = params.get('view') || state.baseView;
  state.timeScale = params.get('scale') || state.timeScale;
  state.searchTerm = params.get('q') || state.searchTerm;
  state.collapseAll = readBoolParam(params, 'collapse');

  const sortSel = $('sort-sel');
  const viewModeSel = $('view-mode-sel');
  const timeScaleSel = $('time-scale-sel');
  const searchBox = $('search-box');

  if (sortSel) sortSel.value = state.currentSort;
  if (viewModeSel) viewModeSel.value = state.baseView;
  if (timeScaleSel) timeScaleSel.value = state.timeScale;
  if (searchBox) searchBox.value = state.searchTerm;

  const viewPrefix = '/view/';
  initialViewerSubpath = url.pathname.startsWith(viewPrefix)
    ? decodeURIComponent(url.pathname.slice(viewPrefix.length))
    : null;

  return initialViewerSubpath;
}

export function consumeInitialViewerSubpath() {
  const sp = initialViewerSubpath;
  initialViewerSubpath = null;
  return sp;
}

export function syncRoute() {
  const url = new URL(window.location.href);
  const params = url.searchParams;

  writeStateParam(params, 'sort', state.currentSort, 'date-asc');
  writeStateParam(params, 'view', state.baseView, 'flat');
  writeStateParam(params, 'scale', state.timeScale, 'none');
  writeStateParam(params, 'q', state.searchTerm.trim(), '');
  if (state.collapseAll) params.set('collapse', '1');
  else params.delete('collapse');

  const viewerSp = dom.viewer.classList.contains('show') ? currentViewerSubpath() : null;
  const nextPath = viewerSp ? `/view/${encodePath(viewerSp)}` : '/';
  if (url.pathname !== nextPath) url.pathname = nextPath;

  const nextUrl = `${url.pathname}${params.toString() ? `?${params.toString()}` : ''}${url.hash}`;
  const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (nextUrl !== currentUrl) window.history.replaceState(null, '', nextUrl);
}

function currentViewerSubpath() {
  const p = state.filteredPhotos[state.viewerIndex];
  return p ? subpath(p) : null;
}