import { state, $ } from './state.js';
import { subpath } from './utils.js';

const fields = [
  ['make', '品牌', 'text'],
  ['model', '型号', 'text'],
  ['lens_model', '镜头', 'text'],
  ['software', '软件', 'text'],
  ['iso', 'ISO', 'text'],
  ['exposure_time', '快门', 'text'],
  ['f_number', '光圈', 'text'],
  ['focal_length', '焦距', 'text'],
  ['focal_length_35mm', '等效焦距', 'text'],
  ['image_width', '图像宽度', 'number', '如 1920'],
  ['image_height', '图像高度', 'number', '如 1280'],
  ['gps_lat', '纬度', 'number', '如 39.9042'],
  ['gps_lon', '经度', 'number', '如 116.4074'],
  ['flash', '闪光灯', 'text'],
  ['white_balance', '白平衡', 'text'],
  ['metering_mode', '测光模式', 'text'],
  ['exposure_bias', '曝光补偿', 'text'],
];

function el(id) {
  return document.getElementById(id);
}

function currentPhoto() {
  return state.filteredPhotos[state.viewerIndex] || null;
}

function currentExifValue(exif, field) {
  const value = exif?.[field];
  return value == null ? '' : String(value);
}

export function openExifEditDialog() {
  if (state.readOnly) {
    alert('当前为只读模式，管理操作已禁用');
    return;
  }

  const photo = currentPhoto();
  if (!photo) return;

  el('exif-edit-src').textContent = subpath(photo);
  el('exif-edit-form').dataset.src = subpath(photo);
  // 填充日期/时间两个控件
  const dateRaw = currentExifValue(photo.exif, 'date_taken');
  if (dateRaw) {
    // 期望后端格式类似 2023:07:14 15:30:22
    const m = dateRaw.match(/(\d{4})[:\-]?(\d{2})[:\-]?(\d{2})\s*(\d{2}):(\d{2})(?::(\d{2}))?/);
    if (m) {
      el('exif-date_date').value = `${m[1]}-${m[2]}-${m[3]}`;
      el('exif-date_time').value = `${m[4]}:${m[5]}`;
    } else {
      // 其它格式则尝试 ISO parse
      try {
        const dt = new Date(dateRaw);
        if (!isNaN(dt.getTime())) {
          const yyyy = dt.getFullYear();
          const mm = String(dt.getMonth() + 1).padStart(2, '0');
          const dd = String(dt.getDate()).padStart(2, '0');
          const hh = String(dt.getHours()).padStart(2, '0');
          const mi = String(dt.getMinutes()).padStart(2, '0');
          el('exif-date_date').value = `${yyyy}-${mm}-${dd}`;
          el('exif-date_time').value = `${hh}:${mi}`;
        }
      } catch (_) {}
    }
  } else {
    el('exif-date_date').value = '';
    el('exif-date_time').value = '';
  }

  fields.forEach(([field]) => {
    const input = el(`exif-${field}`);
    if (input) input.value = currentExifValue(photo.exif, field);
  });
  el('modal-exif').classList.add('show');
}

function buildPayload() {
  const src = el('exif-edit-form').dataset.src;
  if (!src) throw new Error('missing source');

  const exif = {};
  // 处理日期/时间控件，组装为后端期望的 "YYYY:MM:DD HH:MM:SS"
  const dateVal = el('exif-date_date').value.trim();
  const timeVal = el('exif-date_time').value.trim();
  if (!dateVal && !timeVal) {
    exif['date_taken'] = null;
  } else {
    const datePart = dateVal ? dateVal.replace(/-/g, ':') : '0000:00:00';
    const timePart = timeVal ? (timeVal.length === 5 ? `${timeVal}:00` : timeVal) : '00:00:00';
    exif['date_taken'] = `${datePart} ${timePart}`;
  }

  for (const [field, , type] of fields) {
    const input = el(`exif-${field}`);
    if (!input) continue;
    const raw = input.value.trim();
    if (!raw) {
      exif[field] = null;
      continue;
    }
    if (type === 'number') {
      const num = Number(raw);
      if (!Number.isFinite(num)) {
        throw new Error(`${field} 需要数字`);
      }
      exif[field] = num;
    } else {
      exif[field] = raw;
    }
  }

  return { src, exif };
}

export async function commitExifEdit() {
  if (state.readOnly) {
    throw new Error('当前为只读模式');
  }

  const payload = buildPayload();
  const res = await fetch('/api/exif/update', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || '保存 EXIF 失败');
  }
  return res.json();
}
