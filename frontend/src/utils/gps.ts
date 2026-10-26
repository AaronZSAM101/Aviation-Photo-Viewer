import { GPS_CUSTOM_AIRCRAFT_LENGTH_KEY, GPS_MAP_PREF_KEY } from '../config';
import type { ExifData, GpsCustomSource, GpsMapSettings, GpsPoint, GpsSource } from '../types';

export type GpsCoordMode = 'dms' | 'decimal';

export const GPS_MAP_DEFAULTS: GpsMapSettings = {
  provider: 'esri',
  zoom: 16,
  customSources: [],
  sourceKeys: {},
};

export const GPS_CUSTOM_PREFIX = 'custom:';

export const GPS_BUILTIN_SOURCES: GpsSource[] = [
  {
    id: 'esri',
    name: 'Esri World Imagery',
    template:
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    maxZoom: 19,
    key: '',
    subdomains: '',
  },
  {
    id: 'osm',
    name: 'OpenStreetMap',
    template: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    maxZoom: 19,
    key: '',
    subdomains: '',
  },
  {
    id: 'google-sat',
    name: 'Google Satellite',
    template: 'https://mt{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
    subdomains: '0,1,2,3',
    maxZoom: 20,
    key: '',
  },
  {
    id: 'google-hybrid',
    name: 'Google Hybrid',
    template: 'https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',
    subdomains: '0,1,2,3',
    maxZoom: 20,
    key: '',
  },
  {
    id: 'bing-aerial',
    name: 'Bing Aerial',
    template: 'https://ecn.t{s}.tiles.virtualearth.net/tiles/a{q}.jpeg?g=14027',
    subdomains: '0,1,2,3',
    maxZoom: 19,
    key: '',
  },
  {
    id: 'tianditu-img',
    name: '天地图影像',
    template:
      'https://t{s}.tianditu.gov.cn/img_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=img&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk={key}',
    subdomains: '0,1,2,3,4,5,6,7',
    maxZoom: 18,
    key: '',
    needsKey: true,
  },
];

export const GPS_BUILTIN_SOURCE_MAP = new Map(GPS_BUILTIN_SOURCES.map((source) => [source.id, source]));
export const GPS_FULL_FRAME_SENSOR_WIDTH_MM = 36;
export const GPS_FULL_FRAME_SENSOR_HEIGHT_MM = 24;
export const GPS_APS_C_CROP_FACTOR = 1.6;
export const GPS_NARROWBODY_LENGTH_M = 40;
export const GPS_WIDEBODY_LENGTH_M = 65;

export function gpsRef(
  value: string | null | undefined,
  positiveLabel: string,
  negativeLabel: string,
): string | null {
  if (typeof value === 'string' && value.trim()) {
    const v = value.trim().toUpperCase();
    if (v.includes('S') || v.includes('W') || v.includes('SOUTH') || v.includes('WEST')) {
      return negativeLabel;
    }
    if (v.includes('N') || v.includes('E') || v.includes('NORTH') || v.includes('EAST')) {
      return positiveLabel;
    }
    return value.trim();
  }
  return null;
}

export function gpsSuffix(ref: string | null, positiveLabel: string, negativeLabel: string): string {
  if (ref === positiveLabel) {
    if (positiveLabel === '北纬') return 'N';
    if (positiveLabel === '东经') return 'E';
  }
  if (ref === negativeLabel) {
    if (negativeLabel === '南纬') return 'S';
    if (negativeLabel === '西经') return 'W';
  }
  return ref || '';
}

export function formatGpsCoord(
  value: number | null | undefined,
  refValue: string | null | undefined,
  positiveLabel: string,
  negativeLabel: string,
): string | null {
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

export function formatGpsDecimal(
  value: number | null | undefined,
  refValue: string | null | undefined,
  positiveLabel: string,
  negativeLabel: string,
): string | null {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const num = Number(value);
  const ref = gpsRef(refValue, positiveLabel, negativeLabel) || (num < 0 ? negativeLabel : positiveLabel);
  const suffix = gpsSuffix(ref, positiveLabel, negativeLabel);
  return `${Math.abs(num).toFixed(6)}° ${suffix}`;
}

export function formatGpsAltitude(value: number | null | undefined): string | null {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const meters = Number(value);
  const feet = meters * 3.280839895;
  const sign = meters < 0 ? '-' : '';
  return `${sign}${Math.abs(meters).toFixed(2)} 米 (${sign}${Math.abs(feet).toFixed(1)} 英尺)`;
}

export function formatGpsDate(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const m = value.trim().match(/^(\d{4})[:\-](\d{1,2})[:\-](\d{1,2})/);
  if (!m) return value.trim();
  return `${Number(m[1])}年${Number(m[2])}月${Number(m[3])}日`;
}

export function formatGpsTime(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  return `${value.trim()} 世界标准时间`;
}

export function formatGpsDateTime(
  dateValue: string | null | undefined,
  timeValue: string | null | undefined,
): string | null {
  const date = formatGpsDate(dateValue);
  const time = formatGpsTime(timeValue);
  if (date && time) return `${date} ${time}`;
  return date || time;
}

export function formatGpsDisplay(e: ExifData, type: 'lat' | 'lon', mode: GpsCoordMode): string | null {
  const isLat = type === 'lat';
  const value = isLat ? e.gps_lat : e.gps_lon;
  const ref = isLat ? e.gps_lat_ref : e.gps_lon_ref;
  const positiveLabel = isLat ? '北纬' : '东经';
  const negativeLabel = isLat ? '南纬' : '西经';
  return mode === 'decimal'
    ? formatGpsDecimal(value, ref, positiveLabel, negativeLabel)
    : formatGpsCoord(value, ref, positiveLabel, negativeLabel);
}

export function gpsSignedValue(
  value: number | null | undefined,
  refValue: string | null | undefined,
  positiveRef: string,
  negativeRef: string,
): number | null {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const num = Number(value);
  const ref = gpsRef(refValue, positiveRef, negativeRef);
  if (ref === negativeRef) return -Math.abs(num);
  if (ref === positiveRef) return Math.abs(num);
  return num;
}

export function formatGpsMapDecimal(
  value: number,
  positiveSuffix: string,
  negativeSuffix: string,
): string {
  const suffix = value < 0 ? negativeSuffix : positiveSuffix;
  return `${Math.abs(value).toFixed(4)}°${suffix}`;
}

export interface GpsMapData {
  lat: number;
  lon: number;
  latLabel: string;
  lonLabel: string;
}

export function gpsMapData(e: ExifData): GpsMapData | null {
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

export function normalizeCustomSource(
  raw: unknown,
  fallbackId: string | null = null,
): GpsCustomSource | null {
  if (!raw || typeof raw !== 'object') return null;
  const object = raw as Record<string, unknown>;
  const template = typeof object.template === 'string' ? object.template.trim() : '';
  if (!template) return null;
  const id =
    typeof object.id === 'string' && object.id.trim()
      ? object.id.trim()
      : fallbackId || `src-${Date.now().toString(36)}`;
  const name =
    typeof object.name === 'string' && object.name.trim() ? object.name.trim() : '自定义图源';
  const key = typeof object.key === 'string' ? object.key.trim() : '';
  const subdomains = typeof object.subdomains === 'string' ? object.subdomains.trim() : '';
  const maxZoomValue = Number(object.maxZoom ?? 20);
  return {
    id,
    name,
    template,
    key,
    subdomains,
    maxZoom: Math.max(1, Math.min(20, Math.round(Number.isFinite(maxZoomValue) ? maxZoomValue : 20))),
  };
}

export function customProviderId(id: string): string {
  return `${GPS_CUSTOM_PREFIX}${id}`;
}

export function customSourceId(provider: string): string | null {
  return provider.startsWith(GPS_CUSTOM_PREFIX) ? provider.slice(GPS_CUSTOM_PREFIX.length) : null;
}

export function gpsMapSourceByProviderWithList(
  provider: string,
  customSources: GpsCustomSource[],
): GpsSource | GpsCustomSource | null {
  if (GPS_BUILTIN_SOURCE_MAP.has(provider)) return GPS_BUILTIN_SOURCE_MAP.get(provider)!;
  const customId = customSourceId(provider);
  if (!customId) return null;
  return customSources.find((source) => source.id === customId) || null;
}

export function sourceMaxZoom(source?: { maxZoom?: number } | null): number {
  return Math.max(1, Math.min(20, Number(source?.maxZoom) || 19));
}

export function maxGpsMapZoom(source: { maxZoom?: number } | null | undefined): number {
  return Math.max(1, Math.min(20, Number(source?.maxZoom) || 19));
}

export function clampGpsMapZoom(
  zoom: number,
  source: { maxZoom?: number } | null | undefined = GPS_BUILTIN_SOURCE_MAP.get(GPS_MAP_DEFAULTS.provider),
): number {
  const n = Number(zoom);
  if (!Number.isFinite(n)) return Math.min(GPS_MAP_DEFAULTS.zoom, maxGpsMapZoom(source));
  return Math.max(1, Math.min(maxGpsMapZoom(source), Math.round(n)));
}

export function gpsMapSourceByProvider(
  provider: string,
  settings: GpsMapSettings,
): GpsSource | GpsCustomSource | null {
  if (GPS_BUILTIN_SOURCE_MAP.has(provider)) {
    const source = GPS_BUILTIN_SOURCE_MAP.get(provider)!;
    const key = settings.sourceKeys?.[provider] || source.key || '';
    return { ...source, key };
  }
  const customId = customSourceId(provider);
  if (customId) return settings.customSources.find((source) => source.id === customId) || null;
  return null;
}

export function activeGpsMapSource(settings: GpsMapSettings): GpsSource | GpsCustomSource {
  return (
    gpsMapSourceByProvider(settings.provider, settings) ||
    GPS_BUILTIN_SOURCE_MAP.get(GPS_MAP_DEFAULTS.provider)!
  );
}

export function loadGpsMapSettings(): GpsMapSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(GPS_MAP_PREF_KEY) || '{}') as Record<string, unknown>;
    let customSources = Array.isArray(raw.customSources)
      ? raw.customSources
          .map((source, idx) => normalizeCustomSource(source, `src-${idx + 1}`))
          .filter((source): source is GpsCustomSource => !!source)
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
    if (provider === 'custom') {
      provider = customSources[0] ? customProviderId(customSources[0].id) : GPS_MAP_DEFAULTS.provider;
    }
    const source =
      gpsMapSourceByProviderWithList(provider, customSources) ||
      GPS_BUILTIN_SOURCE_MAP.get(GPS_MAP_DEFAULTS.provider)!;
    const sourceKeys =
      raw.sourceKeys && typeof raw.sourceKeys === 'object'
        ? Object.fromEntries(
            Object.entries(raw.sourceKeys as Record<string, unknown>).map(([key, value]) => [
              key,
              String(value || '').trim(),
            ]),
          )
        : {};
    return {
      provider: GPS_BUILTIN_SOURCE_MAP.has(provider) ? provider : provider,
      zoom: clampGpsMapZoom(Number(raw.zoom ?? GPS_MAP_DEFAULTS.zoom), source),
      customSources,
      sourceKeys,
    };
  } catch {
    return { ...GPS_MAP_DEFAULTS };
  }
}

export function saveGpsMapSettings(settings: GpsMapSettings): void {
  try {
    localStorage.setItem(GPS_MAP_PREF_KEY, JSON.stringify(settings));
  } catch {
    // ignore storage failures
  }
}

export function gpsProviderLabel(source: { name?: string } | null | undefined): string {
  return source?.name || '地图图源';
}

export function gpsTileCoord(lat: number, lon: number, zoom: number) {
  const n = 2 ** zoom;
  const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const latRad = (clampedLat * Math.PI) / 180;
  const x = ((lon + 180) / 360) * n;
  const y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
  return { x, y, n };
}

export function gpsLatLonFromTile(x: number, y: number, zoom: number): GpsPoint {
  const n = 2 ** zoom;
  const lon = ((((x % n) + n) % n) / n) * 360 - 180;
  const clampedY = Math.max(0, Math.min(n, y));
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * clampedY) / n)));
  return { lat: (latRad * 180) / Math.PI, lon };
}

export function wrappedTileDelta(value: number, center: number, n: number): number {
  let delta = value - center;
  if (delta > n / 2) delta -= n;
  if (delta < -n / 2) delta += n;
  return delta;
}

export function gpsDistanceMeters(a: GpsPoint, b: GpsPoint): number {
  const r = 6371008.8;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 2 * r * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function gpsMeasureDistance(points: GpsPoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += gpsDistanceMeters(points[i - 1], points[i]);
  }
  return total;
}

export function formatGpsDistance(meters: number): string {
  if (!Number.isFinite(meters) || meters <= 0) return '0 m';
  if (meters < 1000) return `${meters.toFixed(0)} m`;
  if (meters < 100000) return `${(meters / 1000).toFixed(2)} km`;
  return `${(meters / 1000).toFixed(1)} km`;
}

export function gpsNumericMm(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  const match = String(value).replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const mm = Number(match[0]);
  return Number.isFinite(mm) && mm > 0 ? mm : null;
}

export function gpsEquivalentFocalMm(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  const text = String(value).replace(',', '.');
  const equivalent = text.match(/equivalent:\s*(-?\d+(?:\.\d+)?)/i);
  if (equivalent) {
    const mm = Number(equivalent[1]);
    if (Number.isFinite(mm) && mm > 0) return mm;
  }
  return gpsNumericMm(text);
}

export function formatGpsFocalMm(mm: number): string {
  if (!Number.isFinite(mm) || mm <= 0) return '';
  if (mm < 100) return `${mm.toFixed(1).replace(/\.0$/, '')} mm`;
  return `${mm.toFixed(0)} mm`;
}

export function gpsExifFocalMm(exif: ExifData | null | undefined): number | null {
  return gpsEquivalentFocalMm(exif?.focal_length_35mm) || gpsNumericMm(exif?.focal_length);
}

export function gpsFocalLengthLabel(exif: ExifData | null | undefined): string {
  const focal35 = typeof exif?.focal_length_35mm === 'string'
    ? exif.focal_length_35mm.trim()
    : exif?.focal_length_35mm;
  const focal = typeof exif?.focal_length === 'string' ? exif.focal_length.trim() : exif?.focal_length;
  const focal35mm = gpsEquivalentFocalMm(focal35);
  if (focal35mm) return `等效焦距 ${formatGpsFocalMm(focal35mm)}`;
  if (focal) return `焦距 ${focal}`;
  return '';
}

export function normalizeGpsAircraftLength(value: string | number | null | undefined): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(1, Math.min(120, n));
}

export function loadGpsCustomAircraftLength(): number | null {
  try {
    return normalizeGpsAircraftLength(localStorage.getItem(GPS_CUSTOM_AIRCRAFT_LENGTH_KEY));
  } catch {
    return null;
  }
}

export function saveGpsCustomAircraftLength(value: string | number | null): number | null {
  const normalized = normalizeGpsAircraftLength(value);
  try {
    if (normalized) localStorage.setItem(GPS_CUSTOM_AIRCRAFT_LENGTH_KEY, String(normalized));
    else localStorage.removeItem(GPS_CUSTOM_AIRCRAFT_LENGTH_KEY);
  } catch {
    // ignore storage failures
  }
  return normalized;
}

export interface GpsAircraftTarget {
  key: 'narrowbody' | 'widebody' | 'custom';
  label: string;
  length: number;
}

export function gpsAircraftFocalTargets(
  customLength: number | null,
  includeCustom = true,
): GpsAircraftTarget[] {
  const targets: GpsAircraftTarget[] = [
    { key: 'narrowbody', label: '窄体', length: GPS_NARROWBODY_LENGTH_M },
    { key: 'widebody', label: '宽体', length: GPS_WIDEBODY_LENGTH_M },
  ];
  if (includeCustom && customLength) {
    targets.push({ key: 'custom', label: '自定义', length: customLength });
  }
  return targets;
}

export function formatGpsTargetMeters(value: number): string {
  if (!Number.isFinite(value)) return '';
  return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}m`;
}

export function gpsFocalSegmentLabels(a: GpsPoint, b: GpsPoint, customLength: number | null): string[] {
  const distance = gpsDistanceMeters(a, b);
  if (!Number.isFinite(distance) || distance <= 0) return [];
  return gpsAircraftFocalTargets(customLength).map(({ label, length }) => {
    const ffFocal = (distance * GPS_FULL_FRAME_SENSOR_WIDTH_MM) / length;
    const apscFocal = ffFocal / GPS_APS_C_CROP_FACTOR;
    return `刚好拍下${label}(机长${formatGpsTargetMeters(length)})：全幅 ${formatGpsFocalMm(ffFocal)} / APS-C ${formatGpsFocalMm(apscFocal)}`;
  });
}

export function gpsMetersPerPixel(lat: number, zoom: number, tileSize: number): number {
  return (Math.cos((lat * Math.PI) / 180) * 2 * Math.PI * 6378137) / (tileSize * 2 ** zoom);
}

export function gpsDistanceForTargetWidth(
  focalMm: number | null,
  targetWidthMeters: number,
): number | null {
  if (
    !Number.isFinite(focalMm) ||
    (focalMm as number) <= 0 ||
    !Number.isFinite(targetWidthMeters) ||
    targetWidthMeters <= 0
  ) {
    return null;
  }
  return ((focalMm as number) * targetWidthMeters) / GPS_FULL_FRAME_SENSOR_WIDTH_MM;
}

export interface GpsFocalRing {
  key: GpsAircraftTarget['key'];
  label: string;
  length: number;
  distance: number;
  radiusPx: number;
  labelX: number;
  labelY: number;
}

export function gpsFocalGuideRings(
  photoPoint: { lat: number; lon: number; x: number; y: number } | null,
  centerTile: { x: number; y: number; zoom: number },
  tileSize: number,
  exifFocal: number | null,
  customLength: number | null,
): GpsFocalRing[] {
  if (!photoPoint || !Number.isFinite(exifFocal) || (exifFocal as number) <= 0) return [];
  const metersPerPixel = gpsMetersPerPixel(photoPoint.lat, centerTile.zoom, tileSize);
  if (!Number.isFinite(metersPerPixel) || metersPerPixel <= 0) return [];
  return gpsAircraftFocalTargets(customLength)
    .map((target, idx) => {
      const distance = gpsDistanceForTargetWidth(exifFocal, target.length);
      if (distance == null) return null;
      const radiusPx = distance / metersPerPixel;
      if (!Number.isFinite(radiusPx) || radiusPx <= 0) return null;
      const angle = [-35, 35, -90][idx] ?? 0;
      const angleRad = (angle * Math.PI) / 180;
      const labelX = photoPoint.x + Math.cos(angleRad) * Math.min(radiusPx, 320);
      const labelY = photoPoint.y + Math.sin(angleRad) * Math.min(radiusPx, 320);
      return {
        ...target,
        distance,
        radiusPx,
        labelX,
        labelY,
      };
    })
    .filter((ring): ring is GpsFocalRing => !!ring);
}

export function gpsQuadKey(x: number, y: number, zoom: number): string {
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

export function gpsSubdomain(source: { subdomains?: string } | null | undefined, x: number, y: number): string {
  const parts = String(source?.subdomains || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) return '';
  return parts[Math.abs(x + y) % parts.length];
}

export function gpsTileUrl(
  source: { template?: string; key?: string; subdomains?: string } | null | undefined,
  zoom: number,
  x: number,
  y: number,
): string {
  return String(source?.template || '')
    .replaceAll('{z}', String(zoom))
    .replaceAll('{x}', String(x))
    .replaceAll('{y}', String(y))
    .replaceAll('{q}', gpsQuadKey(x, y, zoom))
    .replaceAll('{s}', gpsSubdomain(source, x, y))
    .replaceAll('{key}', encodeURIComponent(source?.key || ''));
}

export function gpsToggleTitle(mode: GpsCoordMode): string {
  return mode === 'decimal' ? '点击切换为度分秒' : '点击切换为十进制度';
}
