// 纯工具函数：格式化、路径与 URL、EXIF 检查
// 全部无副作用，可被任何模块导入。

export function fmt_size(b) {
  if (b < 1024)    return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(2) + ' MB';
}

export function fmt_megapixels(w, h) {
  if (!w || !h) return null;
  const mp = (w * h) / 1_000_000;
  if (mp >= 10) return mp.toFixed(1) + ' MP';
  if (mp >= 1)  return mp.toFixed(2) + ' MP';
  return mp.toFixed(3) + ' MP';
}

export function fmt_date(s) {
  if (!s) return '—';
  return s.replace(/^"|"$/g, '')
          .replace(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}).*$/, '$1-$2-$3 $4:$5');
}

export function subpath(p) {
  return p.folder ? p.folder + '/' + p.filename : p.filename;
}

export function encodePath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}

export function photoVersion(p) {
  const mtime = Number.isFinite(p?.mtime) ? p.mtime : 0;
  const size  = Number.isFinite(p?.size)  ? p.size  : 0;
  return `${mtime}-${size}`;
}

export function thumbUrl(p) {
  return `/thumb/${encodePath(subpath(p))}?v=${photoVersion(p)}`;
}

export function previewUrl(p) {
  return `/preview/${encodePath(subpath(p))}?v=${photoVersion(p)}`;
}

export function splitSubpath(sp) {
  const i = sp.lastIndexOf('/');
  return i >= 0
    ? { folder: sp.slice(0, i), name: sp.slice(i + 1) }
    : { folder: '', name: sp };
}

export function joinSubpath(folder, name) {
  return folder ? `${folder}/${name}` : name;
}

// 是否含任何 EXIF 字段（image_width/height 不算，因为可能来自图片头）
export function hasAnyExif(e) {
  return !!(e.date_taken || e.make || e.model || e.lens_model || e.software ||
    e.iso || e.exposure_time || e.f_number || e.focal_length || e.focal_length_35mm ||
    e.gps_lat || e.gps_lon || e.flash ||
    e.white_balance || e.metering_mode || e.exposure_bias);
}
