// 全屏查看器：图像显示、导航、信息面板、直方图、网格 overlay、污点检查
import { dom, state, $ } from './state.js';
import {
  subpath, photoUrl, fmt_size, fmt_megapixels, hasAnyExif,
} from './utils.js';
import { stageSingleDelete } from './api.js';
import { updateCardStagedIndicators } from './render.js';
import { syncRoute } from './router.js';

const gpsCoordModes = {
  lat: 'dms',
  lon: 'dms',
};
const GPS_MAP_PREF_KEY = 'photo-viewer:gps-map-settings:v1';
const GPS_CUSTOM_AIRCRAFT_LENGTH_KEY = 'photo-viewer:gps-custom-aircraft-length:v1';
const GPS_MAP_DEFAULTS = {
  provider: 'esri',
  zoom: 16,
  customSources: [],
  sourceKeys: {},
};
const GPS_CUSTOM_PREFIX = 'custom:';
const GPS_BUILTIN_SOURCES = [
  {
    id: 'esri',
    name: 'Esri World Imagery',
    template: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    maxZoom: 19,
  },
  {
    id: 'osm',
    name: 'OpenStreetMap',
    template: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    maxZoom: 19,
  },
  {
    id: 'google-sat',
    name: 'Google Satellite',
    template: 'https://mt{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
    subdomains: '0,1,2,3',
    maxZoom: 20,
  },
  {
    id: 'google-hybrid',
    name: 'Google Hybrid',
    template: 'https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',
    subdomains: '0,1,2,3',
    maxZoom: 20,
  },
  {
    id: 'bing-aerial',
    name: 'Bing Aerial',
    template: 'https://ecn.t{s}.tiles.virtualearth.net/tiles/a{q}.jpeg?g=14027',
    subdomains: '0,1,2,3',
    maxZoom: 19,
  },
  {
    id: 'tianditu-img',
    name: '天地图影像',
    template: 'https://t{s}.tianditu.gov.cn/img_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=img&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk={key}',
    subdomains: '0,1,2,3,4,5,6,7',
    maxZoom: 18,
    needsKey: true,
  },
];
const GPS_BUILTIN_SOURCE_MAP = new Map(GPS_BUILTIN_SOURCES.map(source => [source.id, source]));
const GPS_FULL_FRAME_SENSOR_WIDTH_MM = 36;
const GPS_FULL_FRAME_SENSOR_HEIGHT_MM = 24;
const GPS_APS_C_CROP_FACTOR = 1.6;
const GPS_NARROWBODY_LENGTH_M = 40;
const GPS_WIDEBODY_LENGTH_M = 65;
let gpsMapSettings = loadGpsMapSettings();
let gpsMapSettingsModalBound = false;
let gpsMapView = { subpath: null, centerLat: null, centerLon: null };
let gpsMapMeasure = { subpath: null, active: false, points: [] };
let gpsMapDrag = null;
let gpsCustomAircraftLength = loadGpsCustomAircraftLength();
let gpsCustomAircraftLengthTimer = null;
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 8;

function gpsRef(value, positiveLabel, negativeLabel) {
  if (typeof value === 'string' && value.trim()) {
    const v = value.trim().toUpperCase();
    if (v.includes('S') || v.includes('W') || v.includes('SOUTH') || v.includes('WEST')) return negativeLabel;
    if (v.includes('N') || v.includes('E') || v.includes('NORTH') || v.includes('EAST')) return positiveLabel;
    return value.trim();
  }
  return null;
}

function gpsSuffix(ref, positiveLabel, negativeLabel) {
  if (ref === positiveLabel) {
    if (positiveLabel === '北纬') return 'N';
    if (positiveLabel === '东经') return 'E';
  }
  if (ref === negativeLabel) {
    if (negativeLabel === '南纬') return 'S';
    if (negativeLabel === '西经') return 'W';
  }
  return ref;
}

function formatGpsCoord(value, refValue, positiveLabel, negativeLabel) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const num = Number(value);
  const ref = gpsRef(refValue, positiveLabel, negativeLabel) || (num < 0 ? negativeLabel : positiveLabel);
  const suffix = gpsSuffix(ref, positiveLabel, negativeLabel);
  const abs = Math.abs(num);
  const deg = Math.floor(abs);
  const minFloat = (abs - deg) * 60;
  const min = Math.floor(minFloat);
  const sec = (minFloat - min) * 60;
  return `${deg}° ${min}' ${sec.toFixed(3)}" ${suffix}`;
}

function formatGpsDecimal(value, refValue, positiveLabel, negativeLabel) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const num = Number(value);
  const ref = gpsRef(refValue, positiveLabel, negativeLabel) || (num < 0 ? negativeLabel : positiveLabel);
  const suffix = gpsSuffix(ref, positiveLabel, negativeLabel);
  return `${Math.abs(num).toFixed(6)}° ${suffix}`;
}

function formatGpsAltitude(value) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const meters = Number(value);
  const feet = meters * 3.280839895;
  const sign = meters < 0 ? '-' : '';
  return `${sign}${Math.abs(meters).toFixed(2)} 米 (${sign}${Math.abs(feet).toFixed(1)} 英尺)`;
}

function formatGpsDate(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const m = value.trim().match(/^(\d{4})[:\-](\d{1,2})[:\-](\d{1,2})/);
  if (!m) return value.trim();
  return `${Number(m[1])}年${Number(m[2])}月${Number(m[3])}日`;
}

function formatGpsTime(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return `${value.trim()} 世界标准时间`;
}

function formatGpsDateTime(dateValue, timeValue) {
  const date = formatGpsDate(dateValue);
  const time = formatGpsTime(timeValue);
  if (date && time) return `${date} ${time}`;
  return date || time;
}

function formatGpsDisplay(e, type) {
  const isLat = type === 'lat';
  const value = isLat ? e.gps_lat : e.gps_lon;
  const ref = isLat ? e.gps_lat_ref : e.gps_lon_ref;
  const positiveLabel = isLat ? '北纬' : '东经';
  const negativeLabel = isLat ? '南纬' : '西经';
  return gpsCoordModes[type] === 'decimal'
    ? formatGpsDecimal(value, ref, positiveLabel, negativeLabel)
    : formatGpsCoord(value, ref, positiveLabel, negativeLabel);
}

function gpsSignedValue(value, refValue, positiveRef, negativeRef) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const num = Number(value);
  const ref = gpsRef(refValue, positiveRef, negativeRef);
  if (ref === negativeRef) return -Math.abs(num);
  if (ref === positiveRef) return Math.abs(num);
  return num;
}

function formatGpsMapDecimal(value, positiveSuffix, negativeSuffix) {
  const suffix = value < 0 ? negativeSuffix : positiveSuffix;
  return `${Math.abs(value).toFixed(4)}°${suffix}`;
}

function escapeAttr(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function normalizeCustomSource(raw, fallbackId = null) {
  if (!raw || typeof raw !== 'object') return null;
  const template = typeof raw.template === 'string' ? raw.template.trim() : '';
  if (!template) return null;
  const id = typeof raw.id === 'string' && raw.id.trim()
    ? raw.id.trim()
    : (fallbackId || `src-${Date.now().toString(36)}`);
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : '自定义图源';
  const key = typeof raw.key === 'string' ? raw.key.trim() : '';
  const subdomains = typeof raw.subdomains === 'string' ? raw.subdomains.trim() : '';
  return {
    id,
    name,
    template,
    key,
    subdomains,
    maxZoom: clampGpsMapZoom(raw.maxZoom ?? 20, { maxZoom: 20 }),
  };
}

function customProviderId(id) {
  return `${GPS_CUSTOM_PREFIX}${id}`;
}

function customSourceId(provider) {
  return typeof provider === 'string' && provider.startsWith(GPS_CUSTOM_PREFIX)
    ? provider.slice(GPS_CUSTOM_PREFIX.length)
    : null;
}

function gpsMapSourceByProvider(provider) {
  if (GPS_BUILTIN_SOURCE_MAP.has(provider)) {
    const source = GPS_BUILTIN_SOURCE_MAP.get(provider);
    const key = gpsMapSettings.sourceKeys?.[provider] || source.key || '';
    return { ...source, key };
  }
  const customId = customSourceId(provider);
  if (customId) return gpsMapSettings.customSources.find(source => source.id === customId) || null;
  return null;
}

function activeGpsMapSource() {
  return gpsMapSourceByProvider(gpsMapSettings.provider) || GPS_BUILTIN_SOURCE_MAP.get(GPS_MAP_DEFAULTS.provider);
}

function maxGpsMapZoom(source = activeGpsMapSource()) {
  return Math.max(1, Math.min(20, Number(source?.maxZoom) || 19));
}

function clampGpsMapZoom(zoom, source = GPS_BUILTIN_SOURCE_MAP.get(GPS_MAP_DEFAULTS.provider)) {
  const n = Number(zoom);
  if (!Number.isFinite(n)) return Math.min(GPS_MAP_DEFAULTS.zoom, maxGpsMapZoom(source));
  return Math.max(1, Math.min(maxGpsMapZoom(source), Math.round(n)));
}

function loadGpsMapSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(GPS_MAP_PREF_KEY) || '{}');
    let customSources = Array.isArray(raw.customSources)
      ? raw.customSources.map((source, idx) => normalizeCustomSource(source, `src-${idx + 1}`)).filter(Boolean)
      : [];

    if (raw.customTemplate && !customSources.length) {
      const migrated = normalizeCustomSource({
        id: 'custom-1',
        name: '自定义图源',
        template: raw.customTemplate,
        maxZoom: 20,
      });
      if (migrated) customSources = [migrated];
    }

    let provider = typeof raw.provider === 'string' ? raw.provider : GPS_MAP_DEFAULTS.provider;
    if (provider === 'satellite') provider = 'esri';
    if (provider === 'custom') provider = customSources[0] ? customProviderId(customSources[0].id) : GPS_MAP_DEFAULTS.provider;
    const source = gpsMapSourceByProviderWithList(provider, customSources) || GPS_BUILTIN_SOURCE_MAP.get(GPS_MAP_DEFAULTS.provider);
    const sourceKeys = raw.sourceKeys && typeof raw.sourceKeys === 'object'
      ? Object.fromEntries(Object.entries(raw.sourceKeys).map(([key, value]) => [key, String(value || '').trim()]))
      : {};
    return {
      provider: source.id && GPS_BUILTIN_SOURCE_MAP.has(source.id) ? source.id : provider,
      zoom: clampGpsMapZoom(raw.zoom ?? GPS_MAP_DEFAULTS.zoom, source),
      customSources,
      sourceKeys,
    };
  } catch {
    return { ...GPS_MAP_DEFAULTS };
  }
}

function gpsMapSourceByProviderWithList(provider, customSources) {
  if (GPS_BUILTIN_SOURCE_MAP.has(provider)) return GPS_BUILTIN_SOURCE_MAP.get(provider);
  const customId = customSourceId(provider);
  if (!customId) return null;
  return customSources.find(source => source.id === customId) || null;
}

function saveGpsMapSettings() {
  try {
    localStorage.setItem(GPS_MAP_PREF_KEY, JSON.stringify(gpsMapSettings));
  } catch {}
}

function gpsProviderLabel(source) {
  return source?.name || '地图图源';
}

function gpsMapData(e) {
  const lat = gpsSignedValue(e.gps_lat, e.gps_lat_ref, '北纬', '南纬');
  const lon = gpsSignedValue(e.gps_lon, e.gps_lon_ref, '东经', '西经');
  if (lat == null || lon == null) return null;
  return {
    lat,
    lon,
    latLabel: formatGpsMapDecimal(lat, 'N', 'S'),
    lonLabel: formatGpsMapDecimal(lon, 'E', 'W'),
  };
}

function gpsTileCoord(lat, lon, zoom) {
  const n = 2 ** zoom;
  const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const latRad = clampedLat * Math.PI / 180;
  const x = ((lon + 180) / 360) * n;
  const y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
  return { x, y, n };
}

function gpsLatLonFromTile(x, y, zoom) {
  const n = 2 ** zoom;
  const lon = ((x % n) + n) % n / n * 360 - 180;
  const clampedY = Math.max(0, Math.min(n, y));
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * clampedY / n)));
  return { lat: latRad * 180 / Math.PI, lon };
}

function wrappedTileDelta(value, center, n) {
  let delta = value - center;
  if (delta > n / 2) delta -= n;
  if (delta < -n / 2) delta += n;
  return delta;
}

function gpsDistanceMeters(a, b) {
  const r = 6371008.8;
  const lat1 = a.lat * Math.PI / 180;
  const lat2 = b.lat * Math.PI / 180;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lon - a.lon) * Math.PI / 180;
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 2 * r * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function gpsMeasureDistance(points) {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += gpsDistanceMeters(points[i - 1], points[i]);
  }
  return total;
}

function formatGpsDistance(meters) {
  if (!Number.isFinite(meters) || meters <= 0) return '0 m';
  if (meters < 1000) return `${meters.toFixed(0)} m`;
  if (meters < 100000) return `${(meters / 1000).toFixed(2)} km`;
  return `${(meters / 1000).toFixed(1)} km`;
}

function gpsNumericMm(value) {
  if (value == null) return null;
  const match = String(value).replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const mm = Number(match[0]);
  return Number.isFinite(mm) && mm > 0 ? mm : null;
}

function gpsEquivalentFocalMm(value) {
  if (value == null) return null;
  const text = String(value).replace(',', '.');
  const equivalent = text.match(/equivalent:\s*(-?\d+(?:\.\d+)?)/i);
  if (equivalent) {
    const mm = Number(equivalent[1]);
    if (Number.isFinite(mm) && mm > 0) return mm;
  }
  return gpsNumericMm(text);
}

function formatGpsFocalMm(mm) {
  if (!Number.isFinite(mm) || mm <= 0) return '';
  if (mm < 100) return `${mm.toFixed(1).replace(/\.0$/, '')} mm`;
  return `${mm.toFixed(0)} mm`;
}

function gpsExifFocalMm(exif) {
  return gpsEquivalentFocalMm(exif?.focal_length_35mm) || gpsNumericMm(exif?.focal_length);
}

function gpsFocalLengthLabel(exif) {
  const focal35 = typeof exif?.focal_length_35mm === 'string' ? exif.focal_length_35mm.trim() : exif?.focal_length_35mm;
  const focal = typeof exif?.focal_length === 'string' ? exif.focal_length.trim() : exif?.focal_length;
  const focal35mm = gpsEquivalentFocalMm(focal35);
  if (focal35mm) return `等效焦距 ${formatGpsFocalMm(focal35mm)}`;
  if (focal) return `焦距 ${focal}`;
  return '';
}

function normalizeGpsAircraftLength(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(1, Math.min(120, n));
}

function loadGpsCustomAircraftLength() {
  try {
    return normalizeGpsAircraftLength(localStorage.getItem(GPS_CUSTOM_AIRCRAFT_LENGTH_KEY));
  } catch {
    return null;
  }
}

function saveGpsCustomAircraftLength(value) {
  gpsCustomAircraftLength = normalizeGpsAircraftLength(value);
  try {
    if (gpsCustomAircraftLength) localStorage.setItem(GPS_CUSTOM_AIRCRAFT_LENGTH_KEY, String(gpsCustomAircraftLength));
    else localStorage.removeItem(GPS_CUSTOM_AIRCRAFT_LENGTH_KEY);
  } catch {}
}

function gpsAircraftFocalTargets({ includeCustom = true } = {}) {
  const targets = [
    { key: 'narrowbody', label: '窄体', length: GPS_NARROWBODY_LENGTH_M },
    { key: 'widebody', label: '宽体', length: GPS_WIDEBODY_LENGTH_M },
  ];
  if (includeCustom && gpsCustomAircraftLength) {
    targets.push({ key: 'custom', label: '自定义', length: gpsCustomAircraftLength });
  }
  return targets;
}

function gpsFocalSegmentLabels(a, b, exif = null) {
  const distance = gpsDistanceMeters(a, b);
  if (!Number.isFinite(distance) || distance <= 0) return [];
  return gpsAircraftFocalTargets().map(({ label, length }) => {
    const ffFocal = distance * GPS_FULL_FRAME_SENSOR_WIDTH_MM / length;
    const apscFocal = ffFocal / GPS_APS_C_CROP_FACTOR;
    return `刚好拍下${label}(机长${formatGpsTargetMeters(length)})：全幅 ${formatGpsFocalMm(ffFocal)} / APS-C ${formatGpsFocalMm(apscFocal)}`;
  });
}

function formatGpsTargetMeters(value) {
  if (!Number.isFinite(value)) return '';
  return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}m`;
}

function gpsMetersPerPixel(lat, zoom, tileSize) {
  return Math.cos(lat * Math.PI / 180) * 2 * Math.PI * 6378137 / (tileSize * 2 ** zoom);
}

function gpsDistanceForTargetWidth(focalMm, targetWidthMeters) {
  if (!Number.isFinite(focalMm) || focalMm <= 0 || !Number.isFinite(targetWidthMeters) || targetWidthMeters <= 0) {
    return null;
  }
  return focalMm * targetWidthMeters / GPS_FULL_FRAME_SENSOR_WIDTH_MM;
}

function gpsFocalGuideRings(photoPoint, centerTile, tileSize, exifFocal) {
  if (!photoPoint || !Number.isFinite(exifFocal) || exifFocal <= 0) {
    return { circles: '', labels: '' };
  }
  const metersPerPixel = gpsMetersPerPixel(photoPoint.lat, centerTile.zoom, tileSize);
  if (!Number.isFinite(metersPerPixel) || metersPerPixel <= 0) {
    return { circles: '', labels: '' };
  }
  const rings = gpsAircraftFocalTargets().map((target, idx) => {
    const distance = gpsDistanceForTargetWidth(exifFocal, target.length);
    const radiusPx = distance / metersPerPixel;
    if (!Number.isFinite(radiusPx) || radiusPx <= 0) return null;
    const angle = [-35, 35, -90][idx] ?? 0;
    const angleRad = angle * Math.PI / 180;
    const labelX = photoPoint.x + Math.cos(angleRad) * Math.min(radiusPx, 320);
    const labelY = photoPoint.y + Math.sin(angleRad) * Math.min(radiusPx, 320);
    return {
      ...target,
      distance,
      radiusPx,
      labelX,
      labelY,
    };
  }).filter(Boolean);
  return {
    circles: rings.map(ring => `
            <circle class="gps-focal-guide-circle gps-focal-guide-circle-${ring.key}"
                    cx="${(1000 + photoPoint.x).toFixed(1)}"
                    cy="${(1000 + photoPoint.y).toFixed(1)}"
                    r="${ring.radiusPx.toFixed(1)}"></circle>`).join(''),
    labels: rings.map(ring => `
          <div class="gps-measure-segment gps-focal-guide-label gps-focal-ring-label gps-focal-ring-label-${ring.key}"
               style="--measure-x:${ring.labelX.toFixed(2)}px;--measure-y:${ring.labelY.toFixed(2)}px">
            <span>${escapeAttr(formatGpsFocalMm(exifFocal))} 参考圈</span>
            <span>${escapeAttr(ring.label)}机长${escapeAttr(formatGpsTargetMeters(ring.length))} 最远 ${escapeAttr(formatGpsDistance(ring.distance))}</span>
          </div>`).join(''),
  };
}

function gpsQuadKey(x, y, zoom) {
  let quad = '';
  for (let i = zoom; i > 0; i -= 1) {
    let digit = 0;
    const mask = 1 << (i - 1);
    if ((x & mask) !== 0) digit += 1;
    if ((y & mask) !== 0) digit += 2;
    quad += String(digit);
  }
  return quad;
}

function gpsSubdomain(source, x, y) {
  const parts = String(source?.subdomains || '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);
  if (!parts.length) return '';
  return parts[Math.abs(x + y) % parts.length];
}

function gpsTileUrl(source, zoom, x, y) {
  return String(source?.template || '')
    .replaceAll('{z}', String(zoom))
    .replaceAll('{x}', String(x))
    .replaceAll('{y}', String(y))
    .replaceAll('{q}', gpsQuadKey(x, y, zoom))
    .replaceAll('{s}', gpsSubdomain(source, x, y))
    .replaceAll('{key}', encodeURIComponent(source?.key || ''));
}

function currentGpsExif() {
  return state.filteredPhotos[state.viewerIndex]?.exif || null;
}

function currentGpsMapMeasure() {
  const key = currentViewerSubpath() || '';
  if (gpsMapMeasure.subpath !== key) {
    gpsMapMeasure = { subpath: key, active: false, points: [], focalGuide: false };
  }
  if (typeof gpsMapMeasure.focalGuide !== 'boolean') gpsMapMeasure.focalGuide = false;
  return gpsMapMeasure;
}

function getGpsMapCenter(photoLat, photoLon) {
  const key = currentViewerSubpath() || '';
  if (
    gpsMapView.subpath !== key ||
    !Number.isFinite(gpsMapView.centerLat) ||
    !Number.isFinite(gpsMapView.centerLon)
  ) {
    gpsMapView = { subpath: key, centerLat: photoLat, centerLon: photoLon };
  }
  return { lat: gpsMapView.centerLat, lon: gpsMapView.centerLon };
}

function resetGpsMapCenter(photoLat, photoLon) {
  gpsMapView = {
    subpath: currentViewerSubpath() || '',
    centerLat: photoLat,
    centerLon: photoLon,
  };
}

function renderGpsMeasureOverlay(centerTile, n, tileSize, exif = null, photoPoint = null) {
  const measure = currentGpsMapMeasure();
  if (!measure.active && measure.points.length === 0 && !measure.focalGuide) return '';
  const rendered = measure.points.map(point => {
    const tile = gpsTileCoord(point.lat, point.lon, centerTile.zoom);
    return {
      x: wrappedTileDelta(tile.x, centerTile.x, n) * tileSize,
      y: (tile.y - centerTile.y) * tileSize,
    };
  });
  const svgPoints = rendered
    .map(point => `${(1000 + point.x).toFixed(1)},${(1000 + point.y).toFixed(1)}`)
    .join(' ');
  const markers = rendered.map((point, idx) => `
          <div class="gps-measure-point"
               style="--measure-x:${point.x.toFixed(2)}px;--measure-y:${point.y.toFixed(2)}px">${idx + 1}</div>`).join('');
  const segmentLabels = rendered.slice(1).map((point, idx) => {
    const prev = rendered[idx];
    const meters = gpsDistanceMeters(measure.points[idx], measure.points[idx + 1]);
    const focalLabels = gpsFocalSegmentLabels(measure.points[idx], measure.points[idx + 1], exif);
    return `
          <div class="gps-measure-segment"
               style="--measure-x:${((prev.x + point.x) / 2).toFixed(2)}px;--measure-y:${((prev.y + point.y) / 2).toFixed(2)}px">
            <span>A→B ${escapeAttr(formatGpsDistance(meters))}</span>
            ${focalLabels.map(label => `<span>${escapeAttr(label)}</span>`).join('')}
          </div>`;
  }).join('');
  const exifFocal = gpsExifFocalMm(exif);
  const focalRings = measure.focalGuide ? gpsFocalGuideRings(photoPoint, centerTile, tileSize, exifFocal) : { circles: '', labels: '' };
  const distance = formatGpsDistance(gpsMeasureDistance(measure.points));
  const focal = gpsFocalLengthLabel(exif);
  const focalToggle = focal
    ? `<button type="button" class="${measure.focalGuide ? 'active' : ''}" data-gps-focal-guide title="显示/隐藏拍摄点距离参考圈">${escapeAttr(focal)}</button>`
    : '';
  const customLengthValue = gpsCustomAircraftLength ? String(gpsCustomAircraftLength) : '';
  const aircraftBasis = `
    <span class="gps-aircraft-basis">机长：窄体 ${GPS_NARROWBODY_LENGTH_M}m · 宽体 ${GPS_WIDEBODY_LENGTH_M}m · 自定义</span>
    <label class="gps-custom-aircraft-length" title="按自定义机长测算所需焦段">
      <input type="number" min="1" max="120" step="0.1" value="${escapeAttr(customLengthValue)}" data-gps-custom-aircraft-length>
      <span>m</span>
    </label>`;
  const hint = measure.active
    ? (measure.points.length ? '线段按拍摄距离估算焦段' : '点击地图开始测距')
    : '测距已暂停';
  const readout = [escapeAttr(distance), focalToggle, aircraftBasis, escapeAttr(hint)].filter(Boolean).join(' · ');

  return `
        <div class="gps-map-measure-layer">
          <svg viewBox="0 0 2000 2000" preserveAspectRatio="none" aria-hidden="true">
            ${focalRings.circles}
            ${rendered.length > 1 ? `<polyline points="${escapeAttr(svgPoints)}"></polyline>` : ''}
          </svg>
          ${focalRings.labels}
          ${segmentLabels}
          ${markers}
        </div>
        <div class="gps-map-measure-readout">${readout}</div>`;
}

function gpsMapEventLatLon(ev, map, photoLat, photoLon) {
  const rect = map.getBoundingClientRect();
  const variant = map.classList.contains('gps-large-map') ? 'large' : 'mini';
  const tileSize = variant === 'large' ? 256 : 96;
  const zoom = clampGpsMapZoom(gpsMapSettings.zoom, activeGpsMapSource());
  const center = getGpsMapCenter(photoLat, photoLon);
  const centerTile = gpsTileCoord(center.lat, center.lon, zoom);
  const dx = ev.clientX - (rect.left + rect.width / 2);
  const dy = ev.clientY - (rect.top + rect.height / 2);
  return gpsLatLonFromTile(
    centerTile.x + dx / tileSize,
    centerTile.y + dy / tileSize,
    zoom,
  );
}

function renderOnlineTileMap(lat, lon, latLabel, lonLabel, variant = 'mini', exif = null) {
  const source = variant === 'mini'
    ? GPS_BUILTIN_SOURCE_MAP.get(GPS_MAP_DEFAULTS.provider)
    : activeGpsMapSource();
  const zoom = clampGpsMapZoom(gpsMapSettings.zoom, source);
  const tileSize = variant === 'large' ? 256 : 96;
  const radius = variant === 'large' ? 2 : 1;
  const gridSize = radius * 2 + 1;
  const layerSize = tileSize * gridSize;
  const center = getGpsMapCenter(lat, lon);
  const centerTile = gpsTileCoord(center.lat, center.lon, zoom);
  centerTile.zoom = zoom;
  const photoTile = gpsTileCoord(lat, lon, zoom);
  const { x, y, n } = centerTile;
  const baseX = Math.floor(x) - radius;
  const baseY = Math.floor(y) - radius;
  const centerX = (x - baseX) * tileSize;
  const centerY = (y - baseY) * tileSize;
  const markerX = wrappedTileDelta(photoTile.x, centerTile.x, n) * tileSize;
  const markerY = (photoTile.y - centerTile.y) * tileSize;
  const tiles = [];

  for (let row = 0; row < gridSize; row += 1) {
    for (let col = 0; col < gridSize; col += 1) {
      const rawX = baseX + col;
      const tileX = ((rawX % n) + n) % n;
      const tileY = baseY + row;
      if (tileY < 0 || tileY >= n) continue;
      const url = gpsTileUrl(source, zoom, tileX, tileY);
      tiles.push(`
          <div class="gps-map-tile"
               style="left:${col * tileSize}px;top:${row * tileSize}px;width:${tileSize}px;height:${tileSize}px;background-image:url('${escapeAttr(url)}')"></div>`);
    }
  }

  return `
        <div class="gps-tile-layer" style="--center-x:${centerX.toFixed(2)}px;--center-y:${centerY.toFixed(2)}px;--tile-layer-size:${layerSize}px">
          ${tiles.join('')}
        </div>
        <div class="gps-map-photo-marker"
             title="照片位置"
             style="--marker-x:${markerX.toFixed(2)}px;--marker-y:${markerY.toFixed(2)}px"></div>
        ${variant === 'large' ? renderGpsMeasureOverlay(centerTile, n, tileSize, exif, { lat, lon, x: markerX, y: markerY }) : ''}
        ${variant === 'large' ? `
        <div class="gps-map-zoom">
          <button type="button" data-gps-map-zoom="in" title="放大">+</button>
          <span>${zoom}</span>
          <button type="button" data-gps-map-zoom="out" title="缩小">-</button>
          <button type="button" data-gps-map-reset title="回到照片位置">◎</button>
        </div>` : ''}
        <div class="gps-map-controls">
          ${variant === 'large' ? GPS_BUILTIN_SOURCES.slice(0, 3).map(item => `
            <button type="button" class="${gpsMapSettings.provider === item.id ? 'active' : ''}" data-gps-map-provider="${item.id}">${item.id === 'esri' ? '卫星' : escapeAttr(item.name.replace('Google ', 'G '))}</button>
          `).join('') : ''}
          ${variant === 'large' ? `<button type="button" class="${currentGpsMapMeasure().active ? 'active' : ''}" data-gps-map-measure title="测距">测距</button>` : ''}
          ${variant === 'large' && currentGpsMapMeasure().points.length ? '<button type="button" data-gps-map-measure-clear title="清除测距">清除</button>' : ''}
          ${variant === 'mini' ? '<button type="button" data-gps-map-large title="打开大地图">大图</button>' : ''}
          ${variant === 'large' ? '<button type="button" data-gps-map-settings title="图源设置">图源</button>' : ''}
        </div>
        <div class="gps-map-readout">${latLabel} · ${lonLabel}</div>
        <div class="gps-map-source">${escapeAttr(gpsProviderLabel(source))}</div>`;
}

function renderGpsMap(e, variant = 'mini') {
  const data = gpsMapData(e);
  if (!data) return '';
  const title = `地图位置：${data.latLabel}, ${data.lonLabel}`;

  return `
      <div class="gps-mini-map${variant === 'large' ? ' gps-large-map' : ''}" role="img" aria-label="${title}" title="${title}">
        ${renderOnlineTileMap(data.lat, data.lon, data.latLabel, data.lonLabel, variant, e)}
      </div>`;
}

function gpsToggleTitle(type) {
  return gpsCoordModes[type] === 'decimal' ? '点击切换为度分秒' : '点击切换为十进制度';
}

function refreshGpsMapPanel() {
  const p = state.filteredPhotos[state.viewerIndex];
  if (p) renderInfoPanel(p);
  refreshLargeGpsMap();
}

function refreshLargeGpsMap() {
  const modal = $('modal-gps-map');
  const body = $('gps-map-large-body');
  const e = currentGpsExif();
  if (!modal?.classList.contains('show') || !body) return;
  if (!e || !gpsMapData(e)) {
    body.innerHTML = '<div class="gps-map-empty">当前照片没有 GPS 信息</div>';
    return;
  }
  body.innerHTML = renderGpsMap(e, 'large');
  bindGpsMapControls(body, e);
}

function openLargeGpsMapDialog() {
  const modal = $('modal-gps-map');
  const body = $('gps-map-large-body');
  const e = currentGpsExif();
  if (!modal || !body || !e || !gpsMapData(e)) return;
  modal.classList.add('show');
  body.innerHTML = renderGpsMap(e, 'large');
  bindGpsMapControls(body, e);
}

function startGpsMapDrag(ev, lat, lon) {
  if (ev.target.closest('button,input,select')) return;
  ev.preventDefault();
  const zoom = clampGpsMapZoom(gpsMapSettings.zoom, activeGpsMapSource());
  const tileSize = ev.currentTarget.classList.contains('gps-large-map') ? 256 : 96;
  const center = getGpsMapCenter(lat, lon);
  const tile = gpsTileCoord(center.lat, center.lon, zoom);
  gpsMapDrag = {
    startX: ev.clientX,
    startY: ev.clientY,
    startTileX: tile.x,
    startTileY: tile.y,
    zoom,
    n: tile.n,
    tileSize,
  };
  ev.currentTarget.classList.add('dragging');
  document.addEventListener('pointermove', moveGpsMapDrag);
  document.addEventListener('pointerup', endGpsMapDrag);
  document.addEventListener('pointercancel', endGpsMapDrag);
}

function moveGpsMapDrag(ev) {
  if (!gpsMapDrag) return;
  ev.preventDefault();
  const dx = ev.clientX - gpsMapDrag.startX;
  const dy = ev.clientY - gpsMapDrag.startY;
  const next = gpsLatLonFromTile(
    gpsMapDrag.startTileX - dx / gpsMapDrag.tileSize,
    gpsMapDrag.startTileY - dy / gpsMapDrag.tileSize,
    gpsMapDrag.zoom,
  );
  gpsMapView = {
    subpath: currentViewerSubpath() || '',
    centerLat: next.lat,
    centerLon: next.lon,
  };
  refreshGpsMapPanel();
}

function endGpsMapDrag() {
  gpsMapDrag = null;
  document.removeEventListener('pointermove', moveGpsMapDrag);
  document.removeEventListener('pointerup', endGpsMapDrag);
  document.removeEventListener('pointercancel', endGpsMapDrag);
  document.querySelector('.gps-mini-map.dragging')?.classList.remove('dragging');
}

function openGpsMapSettingsDialog() {
  bindGpsMapSettingsModal();
  const modal = $('modal-map-settings');
  const providerSel = $('map-provider-sel');
  if (!modal || !providerSel) return;
  populateGpsMapProviderSelect();
  providerSel.value = gpsMapSourceByProvider(gpsMapSettings.provider)
    ? gpsMapSettings.provider
    : GPS_MAP_DEFAULTS.provider;
  fillGpsMapSourceFields(providerSel.value);
  modal.classList.add('show');
}

function populateGpsMapProviderSelect() {
  const providerSel = $('map-provider-sel');
  if (!providerSel) return;
  const builtin = GPS_BUILTIN_SOURCES.map(source => `
        <option value="${escapeAttr(source.id)}">${escapeAttr(source.name)}</option>`).join('');
  const custom = gpsMapSettings.customSources.map(source => `
        <option value="${escapeAttr(customProviderId(source.id))}">${escapeAttr(source.name)}</option>`).join('');
  providerSel.innerHTML = `
      <optgroup label="内置图源">${builtin}</optgroup>
      <optgroup label="自定义图源">${custom || '<option value="" disabled>暂无自定义图源</option>'}</optgroup>`;
}

function fillGpsMapSourceFields(provider) {
  const source = gpsMapSourceByProvider(provider);
  const isCustom = !!customSourceId(provider);
  const nameInput = $('map-source-name');
  const templateInput = $('map-source-template');
  const keyInput = $('map-source-key');
  const subdomainsInput = $('map-source-subdomains');
  const maxZoomInput = $('map-source-maxzoom');
  const deleteBtn = $('btn-delete-map-source');
  if (!source || !nameInput || !templateInput || !keyInput || !subdomainsInput || !maxZoomInput) return;
  nameInput.value = source.name || '';
  templateInput.value = source.template || '';
  keyInput.value = source.key || '';
  subdomainsInput.value = source.subdomains || '';
  maxZoomInput.value = String(source.maxZoom || maxGpsMapZoom(source));
  if (deleteBtn) deleteBtn.disabled = !isCustom;
}

function sourceFromMapSettingsFields(id, fallbackName = '自定义图源') {
  return normalizeCustomSource({
    id,
    name: $('map-source-name')?.value.trim() || fallbackName,
    template: $('map-source-template')?.value.trim() || '',
    key: $('map-source-key')?.value.trim() || '',
    subdomains: $('map-source-subdomains')?.value.trim() || '',
    maxZoom: $('map-source-maxzoom')?.value.trim() || 20,
  }, id);
}

function upsertCustomSource(source) {
  const idx = gpsMapSettings.customSources.findIndex(item => item.id === source.id);
  if (idx >= 0) gpsMapSettings.customSources[idx] = source;
  else gpsMapSettings.customSources.push(source);
}

function newCustomSourceId() {
  let i = gpsMapSettings.customSources.length + 1;
  let id = `custom-${i}`;
  const existing = new Set(gpsMapSettings.customSources.map(source => source.id));
  while (existing.has(id)) {
    i += 1;
    id = `custom-${i}`;
  }
  return id;
}

function bindGpsMapSettingsModal() {
  if (gpsMapSettingsModalBound) return;
  gpsMapSettingsModalBound = true;
  const providerSel = $('map-provider-sel');
  const saveBtn = $('btn-save-map-settings');
  const resetBtn = $('btn-reset-map-settings');
  const addBtn = $('btn-add-map-source');
  const deleteBtn = $('btn-delete-map-source');
  if (!providerSel || !saveBtn || !resetBtn || !addBtn || !deleteBtn) return;

  providerSel.addEventListener('change', () => {
    fillGpsMapSourceFields(providerSel.value);
  });

  saveBtn.addEventListener('click', () => {
    let provider = providerSel.value || GPS_MAP_DEFAULTS.provider;
    const customId = customSourceId(provider);
    if (customId) {
      const source = sourceFromMapSettingsFields(customId);
      if (!source) {
        alert('请填写自定义图源 URL 模板');
        return;
      }
      upsertCustomSource(source);
      provider = customProviderId(source.id);
    } else if (GPS_BUILTIN_SOURCE_MAP.has(provider)) {
      gpsMapSettings.sourceKeys = {
        ...(gpsMapSettings.sourceKeys || {}),
        [provider]: $('map-source-key')?.value.trim() || '',
      };
    }
    gpsMapSettings.provider = gpsMapSourceByProvider(provider) ? provider : GPS_MAP_DEFAULTS.provider;
    gpsMapSettings.zoom = clampGpsMapZoom(gpsMapSettings.zoom, activeGpsMapSource());
    saveGpsMapSettings();
    populateGpsMapProviderSelect();
    providerSel.value = gpsMapSettings.provider;
    $('modal-map-settings')?.classList.remove('show');
    refreshGpsMapPanel();
  });

  addBtn.addEventListener('click', () => {
    const source = sourceFromMapSettingsFields(
      newCustomSourceId(),
      $('map-new-source-name')?.value.trim() || $('map-source-name')?.value.trim() || '自定义图源',
    );
    if (!source) {
      alert('请填写自定义图源 URL 模板');
      return;
    }
    const newName = $('map-new-source-name')?.value.trim();
    if (newName) source.name = newName;
    upsertCustomSource(source);
    gpsMapSettings.provider = customProviderId(source.id);
    gpsMapSettings.zoom = clampGpsMapZoom(gpsMapSettings.zoom, source);
    saveGpsMapSettings();
    populateGpsMapProviderSelect();
    providerSel.value = gpsMapSettings.provider;
    fillGpsMapSourceFields(providerSel.value);
    refreshGpsMapPanel();
  });

  deleteBtn.addEventListener('click', () => {
    const id = customSourceId(providerSel.value);
    if (!id) return;
    gpsMapSettings.customSources = gpsMapSettings.customSources.filter(source => source.id !== id);
    if (gpsMapSettings.provider === customProviderId(id)) {
      gpsMapSettings.provider = GPS_MAP_DEFAULTS.provider;
      gpsMapSettings.zoom = clampGpsMapZoom(gpsMapSettings.zoom, activeGpsMapSource());
    }
    saveGpsMapSettings();
    populateGpsMapProviderSelect();
    providerSel.value = gpsMapSettings.provider;
    fillGpsMapSourceFields(providerSel.value);
    refreshGpsMapPanel();
  });

  resetBtn.addEventListener('click', () => {
    gpsMapSettings = {
      provider: GPS_MAP_DEFAULTS.provider,
      zoom: GPS_MAP_DEFAULTS.zoom,
      customSources: [],
      sourceKeys: {},
    };
    saveGpsMapSettings();
    populateGpsMapProviderSelect();
    providerSel.value = gpsMapSettings.provider;
    fillGpsMapSourceFields(providerSel.value);
    refreshGpsMapPanel();
  });
}

function bindGpsToggles(e) {
  dom.vInfo.querySelectorAll('.rk[data-gps-toggle]').forEach(label => {
    label.addEventListener('click', () => {
      const type = label.dataset.gpsToggle;
      if (!type || !gpsCoordModes[type]) return;
      gpsCoordModes[type] = gpsCoordModes[type] === 'decimal' ? 'dms' : 'decimal';
      const row = label.closest('.row');
      const value = row?.querySelector('.rv');
      if (value) value.textContent = formatGpsDisplay(e, type) || '';
      label.title = gpsToggleTitle(type);
    });
  });

  bindGpsMapControls(dom.vInfo, e);
}

function bindGpsMapControls(root, e) {
  root.querySelectorAll('[data-gps-map-provider]').forEach(btn => {
    btn.addEventListener('click', () => {
      const provider = btn.dataset.gpsMapProvider;
      if (!provider || provider === gpsMapSettings.provider) return;
      gpsMapSettings.provider = provider;
      gpsMapSettings.zoom = clampGpsMapZoom(gpsMapSettings.zoom, activeGpsMapSource());
      saveGpsMapSettings();
      refreshGpsMapPanel();
    });
  });

  root.querySelectorAll('[data-gps-map-zoom]').forEach(btn => {
    btn.addEventListener('click', () => {
      const delta = btn.dataset.gpsMapZoom === 'in' ? 1 : -1;
      gpsMapSettings.zoom = clampGpsMapZoom(gpsMapSettings.zoom + delta, activeGpsMapSource());
      saveGpsMapSettings();
      refreshGpsMapPanel();
    });
  });

  root.querySelectorAll('.gps-mini-map').forEach(map => {
    map.addEventListener('pointerdown', ev => {
      const lat = gpsSignedValue(e.gps_lat, e.gps_lat_ref, '北纬', '南纬');
      const lon = gpsSignedValue(e.gps_lon, e.gps_lon_ref, '东经', '西经');
      if (lat == null || lon == null) return;
      if (map.classList.contains('gps-large-map') && currentGpsMapMeasure().active) {
        if (ev.target.closest('button,input,select')) return;
        ev.preventDefault();
        const point = gpsMapEventLatLon(ev, map, lat, lon);
        currentGpsMapMeasure().points.push(point);
        refreshGpsMapPanel();
        return;
      }
      startGpsMapDrag(ev, lat, lon);
    });
    map.addEventListener('wheel', ev => {
      ev.preventDefault();
      gpsMapSettings.zoom = clampGpsMapZoom(
        gpsMapSettings.zoom + (ev.deltaY < 0 ? 1 : -1),
        activeGpsMapSource(),
      );
      saveGpsMapSettings();
      refreshGpsMapPanel();
    }, { passive: false });
  });

  root.querySelector('[data-gps-map-reset]')?.addEventListener('click', () => {
    const lat = gpsSignedValue(e.gps_lat, e.gps_lat_ref, '北纬', '南纬');
    const lon = gpsSignedValue(e.gps_lon, e.gps_lon_ref, '东经', '西经');
    if (lat == null || lon == null) return;
    resetGpsMapCenter(lat, lon);
    refreshGpsMapPanel();
  });

  root.querySelector('[data-gps-map-measure]')?.addEventListener('click', () => {
    const measure = currentGpsMapMeasure();
    measure.active = !measure.active;
    refreshGpsMapPanel();
  });

  root.querySelector('[data-gps-map-measure-clear]')?.addEventListener('click', () => {
    const measure = currentGpsMapMeasure();
    measure.points = [];
    measure.active = true;
    refreshGpsMapPanel();
  });

  root.querySelector('[data-gps-focal-guide]')?.addEventListener('click', () => {
    const measure = currentGpsMapMeasure();
    measure.focalGuide = !measure.focalGuide;
    refreshGpsMapPanel();
  });

  root.querySelector('[data-gps-custom-aircraft-length]')?.addEventListener('input', ev => {
    const value = ev.currentTarget.value;
    clearTimeout(gpsCustomAircraftLengthTimer);
    gpsCustomAircraftLengthTimer = setTimeout(() => {
      saveGpsCustomAircraftLength(value);
      refreshGpsMapPanel();
    }, 300);
  });

  root.querySelector('[data-gps-custom-aircraft-length]')?.addEventListener('change', ev => {
    clearTimeout(gpsCustomAircraftLengthTimer);
    saveGpsCustomAircraftLength(ev.currentTarget.value);
    refreshGpsMapPanel();
  });

  root.querySelector('[data-gps-map-large]')?.addEventListener('click', openLargeGpsMapDialog);
  root.querySelector('[data-gps-map-settings]')?.addEventListener('click', openGpsMapSettingsDialog);
}

export function openViewer(idx) {
  state.viewerIndex = idx;
  // 每次打开都重置切换状态
  state.equalizeOn = false;
  state.gridOn     = false;
  state.fineGridOn = false;
  state.rgbOn      = false;
  state.histOn     = false;
  state.infoOn     = true;
  state.zoomMode   = state.zoomMode || 'fit';
  state.zoomScale  = 1;
  syncToggleButtons();
  dom.viewer.classList.add('show');
  showCurrent();
  syncRoute();
}

export function closeViewer() {
  dom.viewer.classList.remove('show');
  if (dom.vCharts && dom.vCharts.parentElement !== dom.vStage) {
    dom.vStage.appendChild(dom.vCharts);
  }
  dom.vImg.src = '';
  dom.vCanvas.width = dom.vCanvas.height = 0;
  syncRoute();
}

export function navigate(delta) {
  const n = state.filteredPhotos.length;
  if (!n) return;
  const ni = Math.max(0, Math.min(n - 1, state.viewerIndex + delta));
  if (ni === state.viewerIndex) return;
  state.viewerIndex = ni;
  showCurrent();
  syncRoute();
}

function showCurrent() {
  const p = state.filteredPhotos[state.viewerIndex];
  if (!p) return;
  dom.vName.textContent    = p.folder ? `${p.folder} / ${p.filename}` : p.filename;
  dom.vCounter.textContent = `${state.viewerIndex + 1} / ${state.filteredPhotos.length}`;
  dom.vPrev.disabled = state.viewerIndex === 0;
  dom.vNext.disabled = state.viewerIndex === state.filteredPhotos.length - 1;

  // 切换照片时重置 equalize，保留 grid/info
  state.equalizeOn = false;
  syncToggleButtons();
  dom.vImg.style.display    = '';
  dom.vCanvas.style.display = 'none';
  dom.vSpin.classList.add('show');

  dom.vImg.onload = () => {
    dom.vSpin.classList.remove('show');
    applyViewerZoom({ mode: state.zoomMode, preserveCenter: false });
    fitGridToImage();
    adjustVinfoHeight();
    adjustVchartsPosition();
    refreshHistograms();
    prefetchAdjacent();
  };
  dom.vImg.onerror = () => { dom.vSpin.classList.remove('show'); };
  dom.vImg.src = photoUrl(p);

  renderInfoPanel(p);
  refreshLargeGpsMap();
  updateViewerStagedIndicator();
  if (!p.exif.lens_model) refreshLensModel(p);
}

async function refreshLensModel(p) {
  const sp = subpath(p);
  try {
    const res = await fetch('/api/exif/lens/' + encodeURIComponent(sp).replace(/%2F/g, '/'));
    if (!res.ok) return;
    const data = await res.json();
    const lens = data?.lens_model;
    if (!lens) return;
    const currentSp = currentViewerSubpath();
    if (currentSp !== sp) return;
    p.exif.lens_model = lens;
    renderInfoPanel(p);
  } catch {
    // 兜底失败时不打断主流程
  }
}

// 预取左右两张到浏览器缓存，让导航看起来"瞬时"
function prefetchAdjacent() {
  [state.viewerIndex - 1, state.viewerIndex + 1].forEach(i => {
    const p = state.filteredPhotos[i];
    if (!p) return;
    const url = photoUrl(p);
    if (state.prefetchedPreviewUrls.has(url)) return;
    state.prefetchedPreviewUrls.add(url);
    if (state.prefetchedPreviewUrls.size > 80) {
      const first = state.prefetchedPreviewUrls.values().next().value;
      if (first) state.prefetchedPreviewUrls.delete(first);
    }
    const img = new Image();
    img.src = url;
  });
}

export function currentViewerSubpath() {
  const p = state.filteredPhotos[state.viewerIndex];
  return p ? subpath(p) : null;
}

export function updateViewerStagedIndicator() {
  const sp = currentViewerSubpath();
  const isStaged = !!(sp && state.stagedDeletes.has(sp));
  dom.vDeleteBtn.classList.toggle('staged', isStaged);
  dom.vDeleteBtn.textContent = isStaged ? '取消删除' : '删除';
  dom.vStagedPill.classList.toggle('show', isStaged);
}

export function refreshCurrentViewer(targetSubpath = null) {
  if (!dom.viewer.classList.contains('show')) return;
  const sp = targetSubpath || currentViewerSubpath();
  if (!sp) return;
  const idx = state.filteredPhotos.findIndex(p => subpath(p) === sp);
  if (idx < 0) return;
  state.viewerIndex = idx;
  showCurrent();
}

export async function viewerToggleDelete() {
  if (state.readOnly) {
    alert('当前为只读模式，管理操作已禁用');
    return;
  }
  const sp = currentViewerSubpath();
  if (!sp) return;
  if (state.stagedDeletes.has(sp)) {
    try {
      const res  = await fetch('/api/stage/list');
      const list = await res.json();
      const op = list.find(o => o.kind === 'delete' && o.src === sp);
      if (op) await fetch('/api/stage/remove/' + op.id, { method: 'POST' });
      state.stagedDeletes.delete(sp);
    } catch (e) { alert('取消删除失败: ' + e.message); return; }
  } else {
    await stageSingleDelete(sp);
  }
  updateCardStagedIndicators();
  updateViewerStagedIndicator();
}

function renderInfoPanel(p) {
  const e = p.exif, hasExif = hasAnyExif(e);
  const sections = [
    { title: '基本信息', rows: [
      ['文件名',   p.filename],
      ['文件夹',   p.folder || '(根目录)'],
      ['大小',     fmt_size(p.size)],
      ['分辨率',   e.image_width && e.image_height ? `${e.image_width} × ${e.image_height} px` : null],
      ['像素总数', fmt_megapixels(e.image_width, e.image_height)],
    ]},
    hasExif && { title: '拍摄时间', rows: [['拍摄时间', e.date_taken]] },
    hasExif && (e.make || e.model || e.lens_model || e.software) && { title: '相机', rows: [
      ['品牌', e.make], ['型号', e.model], ['镜头', e.lens_model], ['软件', e.software],
    ]},
    hasExif && (e.iso || e.exposure_time || e.f_number || e.focal_length) && { title: '曝光参数', rows: [
      ['ISO',    e.iso], ['快门', e.exposure_time], ['光圈', e.f_number],
      ['焦距',   e.focal_length], ['等效焦距', e.focal_length_35mm],
      ['曝光补偿', e.exposure_bias], ['测光模式', e.metering_mode],
      ['白平衡', e.white_balance], ['闪光灯', e.flash],
    ]},
    hasExif && (
      e.gps_lat != null || e.gps_lon != null || e.gps_altitude != null ||
      e.gps_date_stamp || e.gps_time_stamp || e.gps_version_id || e.gps_map_datum
    ) && { title: 'GPS', rows: [
      ['__map', renderGpsMap(e)],
      ['海拔高度', formatGpsAltitude(e.gps_altitude)],
      ['日期时间戳', formatGpsDateTime(e.gps_date_stamp, e.gps_time_stamp)],
      ['GPS 版本', e.gps_version_id],
      ['纬度', formatGpsDisplay(e, 'lat'), 'lat'],
      ['经度', formatGpsDisplay(e, 'lon'), 'lon'],
      ['映射数据', e.gps_map_datum],
    ]},
  ].filter(Boolean);

  const sectionsHTML = sections.map(s => `
    <div class="sec">
      <div class="sec-title">${s.title}</div>
      ${s.rows.filter(([, v]) => v != null && v !== '').map(([k, v, gpsToggle]) => k === '__map' ? v : `
        <div class="row">
          <span class="rk${gpsToggle ? ' gps-toggle-key' : ''}"${gpsToggle ? ` data-gps-toggle="${gpsToggle}" title="${gpsToggleTitle(gpsToggle)}"` : ''}>${k}</span>
          <span class="rv">${v}</span>
        </div>
      `).join('')}
    </div>`).join('')
    + (!hasExif ? '<div class="no-exif-note">此文件不含 EXIF 数据</div>' : '');
  // 用 .vinfo-sections 外壳把所有 sec 包起来，
  // 这样在横向布局（手机竖屏 charts-open / 手机横屏 / 桌面）下，
  // 整组 EXIF 才是 #vinfo 的"一个 flex 列"，不会被拆成多列。
  dom.vInfo.innerHTML = `<div class="vinfo-sections">${sectionsHTML}</div>`;
  bindGpsToggles(e);
  syncChartHost();
}

function syncChartHost() {
  if (!dom.vCharts || !dom.vInfo || !dom.vStage) return;
  // charts 永远托管在 vinfo 里（不管 EXIF 是否打开），避免浮在 vstage 上挡照片。
  // vinfo 容器本身的可见性由 syncToggleButtons 控制（infoOn || chartCount>0）。
  const host = dom.vInfo;
  if (dom.vCharts.parentElement !== host) {
    host.prepend(dom.vCharts);
  }
  dom.vCharts.classList.add('in-info');
}

// ── 污点检查：每通道直方图均衡（JetPhotos 风格）─────────────────────────
export function applyEqualize() {
  if (!dom.vImg.complete || !dom.vImg.naturalWidth) return;
  const w = dom.vImg.naturalWidth, h = dom.vImg.naturalHeight;
  const MAX = 2400;
  const scale = Math.min(1, MAX / Math.max(w, h));
  const cw = Math.round(w * scale), ch_ = Math.round(h * scale);
  dom.vCanvas.width  = cw;
  dom.vCanvas.height = ch_;
  const ctx = dom.vCanvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(dom.vImg, 0, 0, cw, ch_);
  let imgData;
  try       { imgData = ctx.getImageData(0, 0, cw, ch_); }
  catch (err){ console.warn('getImageData failed', err); return; }
  const data = imgData.data, total = cw * ch_;

  for (let c = 0; c < 3; c++) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < total; i++) hist[data[i * 4 + c]]++;
    const cdf = new Uint32Array(256);
    let acc = 0;
    for (let i = 0; i < 256; i++) { acc += hist[i]; cdf[i] = acc; }
    let cdfMin = 0;
    for (let i = 0; i < 256; i++) if (cdf[i] > 0) { cdfMin = cdf[i]; break; }
    const denom = total - cdfMin;
    const lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) {
      lut[i] = denom > 0 ? Math.round((cdf[i] - cdfMin) / denom * 255) : i;
    }
    for (let i = 0; i < total; i++) data[i * 4 + c] = lut[data[i * 4 + c]];
  }
  ctx.putImageData(imgData, 0, 0);
  dom.vImg.style.display    = 'none';
  dom.vCanvas.style.display = 'block';
  applyViewerZoom({ mode: state.zoomMode, preserveCenter: true });
}

export function disableEqualize() {
  dom.vCanvas.style.display = 'none';
  dom.vImg.style.display    = '';
  applyViewerZoom({ mode: state.zoomMode, preserveCenter: true });
}

function clampZoom(scale) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
}

function getDisplayDimensions() {
  const src = getDisplaySource();
  if (!src) return null;
  const width = src.naturalWidth || src.width;
  const height = src.naturalHeight || src.height;
  if (!width || !height) return null;
  return { width, height };
}

function scaleForMode(mode) {
  const dims = getDisplayDimensions();
  if (!dims || !dom.vStage) return 1;
  const stageW = Math.max(1, dom.vStage.clientWidth);
  const stageH = Math.max(1, dom.vStage.clientHeight);
  if (mode === 'fit') return clampZoom(Math.min(stageW / dims.width, stageH / dims.height));
  if (mode === 'fill') return clampZoom(Math.max(stageW / dims.width, stageH / dims.height));
  if (mode === 'custom') return clampZoom(state.zoomScale || 1);
  return 1;
}

function viewportAnchorPoint(anchor) {
  const stage = dom.vStage;
  if (!stage) return { x: 0, y: 0 };
  if (anchor) return anchor;
  return { x: stage.clientWidth / 2, y: stage.clientHeight / 2 };
}

export function applyViewerZoom({ mode = state.zoomMode, scale = null, anchor = null, preserveCenter = true } = {}) {
  const dims = getDisplayDimensions();
  const stage = dom.vStage;
  const content = dom.vContent;
  if (!dims || !stage || !content) return;

  const anchorPt = viewportAnchorPoint(anchor);
  const oldScale = state.zoomScale || 1;
  const contentX = preserveCenter ? (stage.scrollLeft + anchorPt.x) / oldScale : dims.width / 2;
  const contentY = preserveCenter ? (stage.scrollTop + anchorPt.y) / oldScale : dims.height / 2;

  state.zoomMode = mode;
  state.zoomScale = clampZoom(scale == null ? scaleForMode(mode) : scale);
  if (dom.vZoomSel) dom.vZoomSel.value = state.zoomMode;

  content.style.width = Math.max(1, Math.round(dims.width * state.zoomScale)) + 'px';
  content.style.height = Math.max(1, Math.round(dims.height * state.zoomScale)) + 'px';

  requestAnimationFrame(() => {
    stage.scrollLeft = Math.max(0, contentX * state.zoomScale - anchorPt.x);
    stage.scrollTop = Math.max(0, contentY * state.zoomScale - anchorPt.y);
    fitGridToImage();
    adjustVinfoHeight();
    adjustVchartsPosition();
  });
}

export function setViewerZoomMode(mode) {
  if (mode === 'custom') return;
  applyViewerZoom({ mode, preserveCenter: true });
}

export function zoomViewerBy(delta, clientX, clientY) {
  const stage = dom.vStage;
  if (!stage) return;
  const rect = stage.getBoundingClientRect();
  const anchor = {
    x: clientX - rect.left,
    y: clientY - rect.top,
  };
  const nextScale = clampZoom((state.zoomScale || 1) * delta);
  applyViewerZoom({ mode: 'custom', scale: nextScale, anchor, preserveCenter: true });
}

export function startViewerPan(e) {
  if (e.button !== 0 || !dom.viewer.classList.contains('show')) return;
  if (e.target.closest('button,select,input,textarea')) return;
  state.isPanning = true;
  state.panStart = {
    x: e.clientX,
    y: e.clientY,
    scrollLeft: dom.vStage.scrollLeft,
    scrollTop: dom.vStage.scrollTop,
  };
  dom.vStage.classList.add('is-panning');
  dom.vStage.setPointerCapture?.(e.pointerId);
}

export function moveViewerPan(e) {
  if (!state.isPanning || !state.panStart) return;
  dom.vStage.scrollLeft = state.panStart.scrollLeft - (e.clientX - state.panStart.x);
  dom.vStage.scrollTop = state.panStart.scrollTop - (e.clientY - state.panStart.y);
  fitGridToImage();
}

export function endViewerPan(e) {
  if (!state.isPanning) return;
  state.isPanning = false;
  state.panStart = null;
  dom.vStage.classList.remove('is-panning');
  dom.vStage.releasePointerCapture?.(e.pointerId);
}

// ── 网格 overlay 贴合显示中的图像矩形 ─────────────────────────────────────
export function fitGridToImage() {
  const content = dom.vContent;
  if (!content || !content.getBoundingClientRect) return;
  const r = content.getBoundingClientRect();
  const fineGridX = Math.max(4, r.width * 25 / 1024);
  const fineGridY = Math.max(4, r.height * 25 / 683);
  const styles = {
    left:   '0',
    top:    '0',
    width:  '100%',
    height: '100%',
  };
  Object.assign(dom.vGrid.style,     styles);
  Object.assign(dom.vFineGrid.style, styles);
  dom.vFineGrid.style.setProperty('--fine-grid-x', fineGridX + 'px');
  dom.vFineGrid.style.setProperty('--fine-grid-y', fineGridY + 'px');
}

// ── 直方图 ────────────────────────────────────────────────────────────────
function getDisplaySource() {
  return (dom.vCanvas.style.display === 'block') ? dom.vCanvas : dom.vImg;
}

function computeHistograms() {
  const src = getDisplaySource();
  if (!src) return null;
  const w = src.naturalWidth || src.width;
  const h = src.naturalHeight || src.height;
  if (!w || !h) return null;
  const MAX = 512;
  const s = Math.min(1, MAX / Math.max(w, h));
  const cw  = Math.max(1, Math.round(w * s));
  const ch_ = Math.max(1, Math.round(h * s));
  const tmp = document.createElement('canvas');
  tmp.width = cw; tmp.height = ch_;
  const ctx = tmp.getContext('2d', { willReadFrequently: true });
  let data;
  try {
    ctx.drawImage(src, 0, 0, cw, ch_);
    data = ctx.getImageData(0, 0, cw, ch_).data;
  } catch (e) { return null; }
  const r = new Uint32Array(256), g = new Uint32Array(256),
        b = new Uint32Array(256), L = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) {
    const R = data[i], G = data[i + 1], B = data[i + 2];
    r[R]++; g[G]++; b[B]++;
    const y = Math.min(255, (0.299 * R + 0.587 * G + 0.114 * B) | 0);
    L[y]++;
  }
  return { r, g, b, L };
}

function buildAreaPath(values, vbW, vbH, peak) {
  const trimmed = Math.max(1, peak);
  let d = `M 0 ${vbH} L 0 ${(vbH - values[0] / trimmed * vbH).toFixed(2)}`;
  for (let i = 1; i < 256; i++) {
    const x = (i / 255) * vbW;
    const y = vbH - Math.min(values[i], trimmed) / trimmed * vbH;
    d += ` L ${x.toFixed(2)} ${y.toFixed(2)}`;
  }
  d += ` L ${vbW} ${vbH} Z`;
  return d;
}

function peakOf(arr) {
  // 99.5 分位数：抑制 0/255 处的尖刺
  const sorted = Array.from(arr).slice(1, 255).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.995)] || Math.max(...arr);
}

export function refreshHistograms() {
  if (!state.rgbOn && !state.histOn) return;
  const h = computeHistograms();
  if (!h) return;
  if (state.rgbOn) {
    const peak = Math.max(peakOf(h.r), peakOf(h.g), peakOf(h.b));
    $('rgb-r').setAttribute('d', buildAreaPath(h.r, 256, 100, peak));
    $('rgb-g').setAttribute('d', buildAreaPath(h.g, 256, 100, peak));
    $('rgb-b').setAttribute('d', buildAreaPath(h.b, 256, 100, peak));
  }
  if (state.histOn) {
    const peak = peakOf(h.L);
    $('hist-l').setAttribute('d', buildAreaPath(h.L, 256, 100, peak));
  }
}

// ── 切换按钮同步 ──────────────────────────────────────────────────────────
export function syncToggleButtons() {
  dom.vEqBtn.classList.toggle('active',       state.equalizeOn);
  dom.vGridBtn.classList.toggle('active',     state.gridOn);
  dom.vFineGridBtn.classList.toggle('active', state.fineGridOn);
  dom.vRgbBtn.classList.toggle('active',      state.rgbOn);
  dom.vHistBtn.classList.toggle('active',     state.histOn);
  dom.vInfoBtn.classList.toggle('active',     state.infoOn);
  dom.vGrid.classList.toggle('show',          state.gridOn);
  dom.vFineGrid.classList.toggle('show',      state.fineGridOn);
  dom.vRgbPanel.classList.toggle('show',      state.rgbOn);
  dom.vHistPanel.classList.toggle('show',     state.histOn);
  const chartCount = (state.rgbOn ? 1 : 0) + (state.histOn ? 1 : 0);
  // vinfo 容器可见：EXIF 开 或 任一 chart 开（charts 留在 vinfo 里，不浮回照片上）
  dom.vInfo.classList.toggle('show', state.infoOn || chartCount > 0);
  // exif-on：EXIF 文本区是否显示（独立于容器可见性）
  dom.vInfo.classList.toggle('exif-on', state.infoOn);
  syncChartHost();
  // vstage padding：info-open 现在等价于"vinfo 容器可见"；
  // exif-on-stage 单独标记 EXIF 文本是否显示，让 CSS 在仅 charts 时缩小 vstage padding
  dom.vStage.classList.toggle('info-open',    state.infoOn || chartCount > 0);
  dom.vStage.classList.toggle('exif-on-stage', state.infoOn);
  dom.vStage.classList.toggle('chart-open-one', chartCount === 1);
  dom.vStage.classList.toggle('chart-open-two', chartCount === 2);
  // mark vInfo when charts are visible so layout can adapt (EXIF full width when none)
  if (dom.vInfo) dom.vInfo.classList.toggle('charts-open', chartCount > 0);
  // Ensure v-charts visibility and pointer events when any chart is open
  if (dom.vCharts) {
    if (chartCount > 0) {
      dom.vCharts.style.display = 'flex';
      dom.vCharts.style.pointerEvents = 'auto';
    } else {
      dom.vCharts.style.display = '';
      dom.vCharts.style.pointerEvents = 'none';
    }
    // ensure each panel has correct .show class (in case toggles were missed)
    dom.vRgbPanel && dom.vRgbPanel.classList.toggle('show', state.rgbOn);
    dom.vHistPanel && dom.vHistPanel.classList.toggle('show', state.histOn);
  }
  // Ensure EXIF panel height doesn't overlap image on small/portrait screens
  try { adjustVinfoHeight(); } catch (e) { /* noop */ }
  try { adjustVchartsPosition(); } catch (e) { /* noop */ }
}

// 限制竖屏下 EXIF 面板最大高度，使其不高于当前图片底端
function adjustVinfoHeight() {
  if (!dom.vInfo) return;
  const isMobilePortrait = window.matchMedia('(max-width: 900px) and (orientation: portrait)').matches;
  if (!isMobilePortrait) {
    dom.vInfo.style.maxHeight = '';
    return;
  }
  const imgEl = (dom.vCanvas.style.display === 'block') ? dom.vCanvas : dom.vImg;
  if (!imgEl || !imgEl.getBoundingClientRect) return;
  const r = imgEl.getBoundingClientRect();
  const availBelow = Math.floor(window.innerHeight - r.bottom - 8); // 8px safety gap
  // if no space below image, collapse max-height to 0 to avoid overlap
  const maxH = Math.max(0, availBelow);
  dom.vInfo.style.maxHeight = maxH + 'px';
}

window.addEventListener('resize', adjustVinfoHeight);
window.addEventListener('orientationchange', adjustVinfoHeight);

// Ensure charts floating in stage don't extend below the top of the image,
// 但如果图像太高没有空间容纳 charts，则让 charts 直接覆盖在图像上沿，
// 避免把整个 #v-charts 推出屏幕（会导致 RGB 整张看不见）。
function adjustVchartsPosition() {
  if (!dom.vCharts || !dom.vStage) return;
  // if charts are moved into info host, let normal layout handle them
  if (dom.vCharts.classList.contains('in-info')) {
    dom.vCharts.style.transform = '';
    return;
  }
  // 先清掉之前可能留下的 transform，再测量原始位置
  dom.vCharts.style.transform = '';
  const imgEl = (dom.vCanvas.style.display === 'block') ? dom.vCanvas : dom.vImg;
  if (!imgEl || !imgEl.getBoundingClientRect) return;
  const stageRect  = dom.vStage.getBoundingClientRect();
  const imgRect    = imgEl.getBoundingClientRect();
  const chartsRect = dom.vCharts.getBoundingClientRect();
  // gap to keep between chart bottom and image top
  const GAP = 8;
  const overlap = (chartsRect.bottom) - (imgRect.top - GAP);
  if (overlap <= 0) return;
  // 至多把 charts 推到 stage 顶部 — 再往上就出屏了
  const headroom = Math.max(0, chartsRect.top - stageRect.top);
  const shift = Math.min(Math.ceil(overlap), headroom);
  if (shift > 0) {
    dom.vCharts.style.transform = `translateY(-${shift}px)`;
  }
}

window.addEventListener('resize', () => { adjustVchartsPosition(); adjustVinfoHeight(); });
window.addEventListener('orientationchange', () => { adjustVchartsPosition(); adjustVinfoHeight(); });
