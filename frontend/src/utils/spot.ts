import type { ExifData, Spot } from '../types';

/** 档案按文件夹记，库根记成 ''；前后端的斜线写法统一在这里收口。 */
export function spotKey(folder: string | undefined): string {
  return (folder ?? '').trim().replace(/^\/+|\/+$/g, '');
}

export function folderSpot(spots: Record<string, Spot>, folder: string | undefined): Spot | null {
  return spots[spotKey(folder)] ?? null;
}

/**
 * 把人手抄的坐标洗成十进制度。支持「22.99」「-33.9」「33.9461S」「N 33.9」四种写法：
 * 抄地图是纯数字，抄航段资料常带半球字母，负号来自已经改成南/西经的那批。
 * 读不出或超出范围就返回 null，由界面提示，不猜。
 */
export function parseCoordinate(raw: string, axis: 'lat' | 'lon'): number | null {
  let text = raw.trim().toUpperCase();
  if (!text) return null;
  let letter = '';
  if (/^[NSEW]/.test(text)) {
    letter = text[0];
    text = text.slice(1).trim();
  } else if (/[NSEW]$/.test(text)) {
    letter = text[text.length - 1];
    text = text.slice(0, -1).trim();
  }
  const wrongAxis =
    letter && (axis === 'lat' ? letter === 'E' || letter === 'W' : letter === 'N' || letter === 'S');
  if (wrongAxis) return null;
  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  if (Math.abs(value) > (axis === 'lat' ? 90 : 180)) return null;
  return letter === 'S' || letter === 'W' ? -Math.abs(value) : value;
}

/** 补进覆盖层后写回这张照片的字段——只动 GPS，其余 EXIF 一概不碰。 */
export function gpsFromSpotExif(exif: ExifData): Partial<ExifData> {
  return {
    gps_lat: exif.gps_lat,
    gps_lat_ref: exif.gps_lat_ref,
    gps_lon: exif.gps_lon,
    gps_lon_ref: exif.gps_lon_ref,
  };
}

export function formatSpot(spot: Spot): string {
  const lat = `${Math.abs(spot.lat).toFixed(4)}°${spot.lat < 0 ? 'S' : 'N'}`;
  const lon = `${Math.abs(spot.lon).toFixed(4)}°${spot.lon < 0 ? 'W' : 'E'}`;
  const tail = spot.note?.trim() ? ` · ${spot.note.trim()}` : '';
  return `${spot.name} · ${lat} ${lon}${tail}`;
}

/** 照片自己的坐标（带 N/S/E/W 参照）折回有符号十进制，用来把「这张的坐标」抄进文件夹档案。 */
export function signedLatLon(exif: ExifData): { lat: number | null; lon: number | null } {
  const fold = (value: number | null, ref: string | null, positive: string): number | null => {
    if (value == null) return null;
    const suffix = (ref ?? '').trim().toUpperCase();
    return suffix && suffix !== positive ? -Math.abs(value) : Math.abs(value);
  };
  return {
    lat: fold(exif.gps_lat, exif.gps_lat_ref, 'N'),
    lon: fold(exif.gps_lon, exif.gps_lon_ref, 'E'),
  };
}
