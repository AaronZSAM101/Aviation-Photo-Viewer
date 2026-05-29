import { dom, state, $ } from './state.js';
import { encodePath, subpath } from './utils.js';
import { loadBrowsePreferences, syncBrowseControls } from './preferences.js';

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

function readSetParam(params, key) {
  return new Set(params.getAll(key).filter(Boolean));
}

function writeSetParam(params, key, values) {
  params.delete(key);
  [...values].filter(Boolean).sort().forEach(value => params.append(key, value));
}

function getRenderedSectionKeys() {
  return [...dom.content.querySelectorAll('.folder-section[data-section-key]')]
    .map(sec => sec.dataset.sectionKey)
    .filter(Boolean);
}

export function applyRouteStateFromLocation() {
  loadBrowsePreferences();

  const url = new URL(window.location.href);
  const params = url.searchParams;

  state.currentSort = params.get('sort') || state.currentSort;
  state.baseView = params.get('view') || state.baseView;
  state.timeScale = params.get('scale') || state.timeScale;
  state.searchTerm = params.get('q') || state.searchTerm;
  state.collapseAll = readBoolParam(params, 'collapse');
  state.collapsedSections = readSetParam(params, 'closed');
  state.expandedSections = readSetParam(params, 'open');

  const searchBox = $('search-box');

  syncBrowseControls();
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
  params.delete('collapse');
  params.delete('open');
  params.delete('closed');

  const sectionKeys = getRenderedSectionKeys();
  const sectionKeySet = new Set(sectionKeys);
  const collapsedSections = sectionKeys.length
    ? new Set([...state.collapsedSections].filter(key => sectionKeySet.has(key)))
    : state.collapsedSections;
  const expandedSections = sectionKeys.length
    ? new Set([...state.expandedSections].filter(key => sectionKeySet.has(key)))
    : state.expandedSections;

  if (state.collapseAll) {
    params.set('collapse', '1');
    writeSetParam(params, 'open', expandedSections);
  } else {
    writeSetParam(params, 'closed', collapsedSections);
  }

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
