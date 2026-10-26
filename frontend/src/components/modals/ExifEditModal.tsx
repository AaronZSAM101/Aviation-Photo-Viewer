import { useEffect, useState } from 'react';
import { App as AntdApp, Button, Input, Modal } from 'antd';
import { StageApi } from '../../api/stage';
import { useAppSelector } from '../../store';
import type { Photo } from '../../types';
import { errorText } from '../../utils/errors';

interface ExifEditModalProps {
  open: boolean;
  src: string | null;
  photo: Photo | null;
  onClose: () => void;
  onStaged: () => void;
}

type TextField =
  | 'make'
  | 'model'
  | 'lens_model'
  | 'software'
  | 'iso'
  | 'exposure_time'
  | 'f_number'
  | 'focal_length'
  | 'focal_length_35mm'
  | 'flash'
  | 'white_balance'
  | 'metering_mode'
  | 'exposure_bias';

type NumberField =
  | 'image_width'
  | 'image_height'
  | 'gps_altitude'
  | 'gps_lat'
  | 'gps_lon';

interface FieldSpec {
  key: TextField | NumberField;
  label: string;
  placeholder?: string;
  numeric?: boolean;
}

const FIELDS: FieldSpec[] = [
  { key: 'make', label: '品牌' },
  { key: 'model', label: '型号' },
  { key: 'lens_model', label: '镜头' },
  { key: 'software', label: '软件' },
  { key: 'iso', label: 'ISO' },
  { key: 'exposure_time', label: '快门' },
  { key: 'f_number', label: '光圈' },
  { key: 'focal_length', label: '焦距' },
  { key: 'focal_length_35mm', label: '等效焦距' },
  { key: 'image_width', label: '图像宽度', placeholder: '如 1920', numeric: true },
  { key: 'image_height', label: '图像高度', placeholder: '如 1280', numeric: true },
  { key: 'gps_altitude', label: '海拔高度', placeholder: '如 21.55', numeric: true },
  { key: 'gps_lat', label: '纬度', placeholder: '如 39.9042', numeric: true },
  { key: 'gps_lon', label: '经度', placeholder: '如 116.4074', numeric: true },
  { key: 'flash', label: '闪光灯' },
  { key: 'white_balance', label: '白平衡' },
  { key: 'metering_mode', label: '测光模式' },
  { key: 'exposure_bias', label: '曝光补偿' },
];

function splitDateTime(raw: string | null): { date: string; time: string } {
  if (!raw) return { date: '', time: '' };
  const match = raw.match(/(\d{4})[:\-]?(\d{2})[:\-]?(\d{2})\s*(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (match) {
    return { date: `${match[1]}-${match[2]}-${match[3]}`, time: `${match[4]}:${match[5]}` };
  }
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    const pad = (value: number) => String(value).padStart(2, '0');
    return {
      date: `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`,
      time: `${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`,
    };
  }
  return { date: '', time: '' };
}

export function ExifEditModal({ open, src, photo, onClose, onStaged }: ExifEditModalProps) {
  const { message } = AntdApp.useApp();
  const readOnly = useAppSelector((state) => state.app.readOnly);
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    const exif = photo?.exif;
    const parts = splitDateTime(exif?.date_taken ?? null);
    setDate(parts.date);
    setTime(parts.time);
    const next: Record<string, string> = {};
    FIELDS.forEach(({ key }) => {
      const raw = exif ? exif[key] : null;
      next[key] = raw == null ? '' : String(raw);
    });
    setValues(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, src]);

  const commit = async () => {
    if (!src) return;
    if (readOnly) {
      message.warning('当前为只读模式，管理操作已禁用');
      return;
    }

    const exif: Record<string, string | number | null> = {};
    const datePart = date.trim() ? date.trim().replace(/-/g, ':') : '0000:00:00';
    const timePart = time.trim() ? (time.trim().length === 5 ? `${time.trim()}:00` : time.trim()) : '00:00:00';
    exif.date_taken = !date.trim() && !time.trim() ? null : `${datePart} ${timePart}`;

    for (const field of FIELDS) {
      const raw = (values[field.key] || '').trim();
      if (!raw) {
        exif[field.key] = null;
        continue;
      }
      if (field.numeric) {
        const num = Number(raw);
        if (!Number.isFinite(num)) {
          message.error(`${field.label} 需要数字`);
          return;
        }
        exif[field.key] = num;
      } else {
        exif[field.key] = raw;
      }
    }

    try {
      await StageApi.stage({ kind: 'exif', src, exif });
      message.success('已加入分批（EXIF）');
      onClose();
      onStaged();
    } catch (error) {
      message.error(`加入 EXIF 分批失败: ${errorText(error)}`);
    }
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title="编辑 EXIF"
      width={760}
      footer={[
        <Button key="cancel" onClick={onClose}>取消</Button>,
        <Button key="ok" type="primary" onClick={commit}>加入分批</Button>,
      ]}
      destroyOnHidden
    >
      <div className="modal-src">{src || '—'}</div>
      <div className="exif-form-grid">
        <label className="exif-field">
          <span>拍摄时间</span>
          <div className="exif-date-row">
            <Input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
            <Input
              type="time"
              value={time}
              onChange={(event) => setTime(event.target.value)}
              style={{ width: 140, flex: '0 0 140px' }}
            />
          </div>
        </label>
        {FIELDS.map((field) => (
          <label className="exif-field" key={field.key}>
            <span>{field.label}</span>
            <Input
              value={values[field.key] || ''}
              placeholder={field.placeholder}
              inputMode={field.numeric ? 'decimal' : undefined}
              onChange={(event) =>
                setValues((current) => ({ ...current, [field.key]: event.target.value }))
              }
            />
          </label>
        ))}
      </div>
    </Modal>
  );
}
