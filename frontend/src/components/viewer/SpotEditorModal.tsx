import { useEffect, useMemo, useState } from 'react';
import { App as AntdApp, Button, Input, Modal } from 'antd';
import type { ExifData, Spot } from '../../types';
import { formatSpot, parseCoordinate, signedLatLon, spotKey } from '../../utils/spot';

interface SpotEditorModalProps {
  open: boolean;
  folder: string;
  /** 这个文件夹现有的档案，没有就是 null */
  spot: Spot | null;
  /** 当前照片的 EXIF：它自己带坐标时可以一键抄进档案 */
  photoExif: ExifData;
  /** 库里所有档案，用来复用一个已经写好的点 */
  archive: Record<string, Spot>;
  onClose: () => void;
  onSave: (spot: Spot) => void;
  onDelete: () => void;
}

const toText = (spot: Spot | null) => ({
  name: spot?.name ?? '',
  lat: spot ? String(spot.lat) : '',
  lon: spot ? String(spot.lon) : '',
  note: spot?.note ?? '',
});

/**
 * 拍摄点档案：老照片没写 GPS，机器猜不出来，只能人按文件夹记一次坐标。
 * 存的是有符号十进制度，填的时候允许带 N/S/E/W 字母——从资料里抄下来通常长那样。
 */
export function SpotEditorModal({
  open,
  folder,
  spot,
  photoExif,
  archive,
  onClose,
  onSave,
  onDelete,
}: SpotEditorModalProps) {
  const { message } = AntdApp.useApp();
  const [form, setForm] = useState(toText(spot));

  useEffect(() => {
    if (open) setForm(toText(spot));
  }, [open, spot]);

  const photoCoord = signedLatLon(photoExif);
  const canCopyFromPhoto = photoCoord.lat != null && photoCoord.lon != null;
  const others = useMemo(
    () =>
      Object.entries(archive)
        .filter(([key]) => key !== spotKey(folder))
        .sort(([a], [b]) => a.localeCompare(b, 'zh-Hans-CN')),
    [archive, folder],
  );

  const save = () => {
    const name = form.name.trim();
    if (!name) {
      message.warning('拍摄点要有名字，不然档案列表里认不出是哪条');
      return;
    }
    const lat = parseCoordinate(form.lat, 'lat');
    if (lat == null) {
      message.warning('纬度读不出来，写「22.99」或「33.9S」这样就行');
      return;
    }
    const lon = parseCoordinate(form.lon, 'lon');
    if (lon == null) {
      message.warning('经度读不出来，写「113.37」或「118.4W」这样就行');
      return;
    }
    onSave({ name, lat, lon, note: form.note.trim() });
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={`拍摄点档案 · ${folder || '库根'}`}
      width={560}
      footer={[
        <Button key="delete" danger disabled={!spot} onClick={onDelete}>
          删除档案
        </Button>,
        <Button key="cancel" onClick={onClose}>
          取消
        </Button>,
        <Button key="save" type="primary" onClick={save}>
          保存
        </Button>,
      ]}
      destroyOnHidden
    >
      <div className="spot-help">
        坐标只是记在档案里，不动原图。要补到某张照片上，回到信息面板按「补给这张」。
      </div>
      <label className="map-settings-field">
        <span>名称</span>
        <Input
          value={form.name}
          placeholder="例如：01 跑道北端铁丝网"
          onChange={(event) => setForm({ ...form, name: event.target.value })}
        />
      </label>
      <div className="spot-row">
        <label className="map-settings-field">
          <span>纬度</span>
          <Input
            value={form.lat}
            placeholder="22.99 或 33.9S"
            onChange={(event) => setForm({ ...form, lat: event.target.value })}
          />
        </label>
        <label className="map-settings-field">
          <span>经度</span>
          <Input
            value={form.lon}
            placeholder="113.37 或 118.4W"
            onChange={(event) => setForm({ ...form, lon: event.target.value })}
          />
        </label>
      </div>
      <label className="map-settings-field">
        <span>备注</span>
        <Input
          value={form.note}
          placeholder="可留空，例如：下午顺光"
          onChange={(event) => setForm({ ...form, note: event.target.value })}
        />
      </label>
      {canCopyFromPhoto && (
        <Button
          size="small"
          onClick={() =>
            setForm({
              ...form,
              lat: String(photoCoord.lat),
              lon: String(photoCoord.lon),
              name: form.name || '这张照片的点',
            })
          }
        >
          用这张照片的坐标填表（{photoCoord.lat?.toFixed(4)}, {photoCoord.lon?.toFixed(4)}）
        </Button>
      )}
      {others.length > 0 && (
        <div className="spot-archive">
          <div className="spot-archive-title">库里其他档案</div>
          {others.map(([key, value]) => (
            <div className="spot-archive-row" key={key}>
              <span className="spot-archive-folder" title={key || '库根'}>
                {key || '库根'}
              </span>
              <span className="spot-archive-value">{formatSpot(value)}</span>
              <Button
                size="small"
                onClick={() =>
                  setForm({ name: value.name, lat: String(value.lat), lon: String(value.lon), note: value.note ?? '' })
                }
              >
                改用这个点
              </Button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
