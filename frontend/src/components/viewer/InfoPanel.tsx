import type { ReactNode } from 'react';
import type { GpsMapSettings, Photo, Spot } from '../../types';
import {
  formatGpsAltitude,
  formatGpsDateTime,
  formatGpsDisplay,
  gpsMapData,
  gpsToggleTitle,
  type GpsCoordMode,
} from '../../utils/gps';
import { fmtMegapixels, fmtSize, hasAnyExif } from '../../utils/format';
import { formatSpot } from '../../utils/spot';
import { GpsMapSection, type GpsMapState } from './GpsMapSection';

interface InfoPanelProps {
  photo: Photo;
  rgbOn: boolean;
  histOn: boolean;
  rgbPaths: { r: string; g: string; b: string } | null;
  histPath: string;
  gpsSettings: GpsMapSettings;
  gpsMapState: GpsMapState;
  gpsCustomLength: number | null;
  coordModes: Record<'lat' | 'lon', GpsCoordMode>;
  readOnly: boolean;
  ocrAvailable: boolean;
  regBusy: boolean;
  regError: string | null;
  spot: Spot | null;
  spotBusy: boolean;
  spotError: string | null;
  onGpsSettingsChange: (settings: GpsMapSettings) => void;
  onGpsMapStateChange: (updater: (state: GpsMapState) => GpsMapState) => void;
  onGpsCustomLengthChange: (value: number | null) => void;
  onToggleCoordMode: (type: 'lat' | 'lon') => void;
  onOpenLargeMap: () => void;
  onOpenMapSettings: () => void;
  onRecognizeReg: () => void;
  onEditSpot: () => void;
  onApplySpot: () => void;
}

interface InfoRow {
  key: string;
  value: ReactNode;
  gpsToggle?: 'lat' | 'lon';
}

interface InfoSection {
  title: string;
  rows: InfoRow[];
}

interface RegistrationCellProps {
  photo: Photo;
  readOnly: boolean;
  ocrAvailable: boolean;
  regBusy: boolean;
  regError: string | null;
  onRecognize: () => void;
}

/**
 * 机号一格：文件名读得出的直接显示；读不出时允许就地做一次机身文字识别。
 * 禁用原因写在 title 里，用户不必点下去才知道容器没装 tesseract。
 * 文件名读得出机号时它以识别结果为准（后端就是这个口径），所以按钮照样能点，
 * 只是点完显示的还是文件名下那个号。
 */
function RegistrationCell({
  photo,
  readOnly,
  ocrAvailable,
  regBusy,
  regError,
  onRecognize,
}: RegistrationCellProps) {
  const regs = photo.regs ?? [];
  const source = photo.reg_source ?? 'none';
  const origin = regs.length === 0 ? '未识别' : source === 'ocr' ? '机身文字识别' : '文件名读出';
  const title = !ocrAvailable
    ? '容器里没有 tesseract，只能用文件名里的机号'
    : '识别机身文字里的机号';
  return (
    <span className="reg-cell">
      <span className="reg-value">{regs.length > 0 ? regs.join(' / ') : '—'}</span>
      <span className="reg-origin">{origin}</span>
      {!readOnly && (
        <button
          type="button"
          className="reg-pick"
          disabled={regBusy || !ocrAvailable}
          title={title}
          onClick={onRecognize}
        >
          {regBusy ? '识别中…' : '识别'}
        </button>
      )}
      {regError && <span className="reg-error">{regError}</span>}
    </span>
  );
}

/**
 * 拍摄点一格：档案按文件夹记，所以这一格说的是「这张照片所在的点」，不是这张照片自己的坐标。
 * 「补给这张」只在照片本来没坐标时出现——已经有 GPS 的话再盖一层只会把真值挡掉。
 */
function SpotCell({
  spot,
  photoHasGps,
  readOnly,
  spotBusy,
  spotError,
  onEdit,
  onApply,
}: {
  spot: Spot | null;
  photoHasGps: boolean;
  readOnly: boolean;
  spotBusy: boolean;
  spotError: string | null;
  onEdit: () => void;
  onApply: () => void;
}) {
  return (
    <span className="spot-cell">
      <span className="spot-value">{spot ? formatSpot(spot) : '未记录'}</span>
      {!readOnly && (
        <button type="button" className="reg-pick" onClick={onEdit}>
          {spot ? '编辑' : '记录'}
        </button>
      )}
      {!readOnly && spot && !photoHasGps && (
        <button
          type="button"
          className="reg-pick"
          disabled={spotBusy}
          title="把这个点的坐标补进这张照片的 EXIF 覆盖层，原图不动"
          onClick={onApply}
        >
          {spotBusy ? '补写中…' : '补给这张'}
        </button>
      )}
      {spotError && <span className="reg-error">{spotError}</span>}
    </span>
  );
}

export function InfoPanel({
  photo,
  rgbOn,
  histOn,
  rgbPaths,
  histPath,
  gpsSettings,
  gpsMapState,
  gpsCustomLength,
  coordModes,
  readOnly,
  ocrAvailable,
  regBusy,
  regError,
  spot,
  spotBusy,
  spotError,
  onGpsSettingsChange,
  onGpsMapStateChange,
  onGpsCustomLengthChange,
  onToggleCoordMode,
  onOpenLargeMap,
  onOpenMapSettings,
  onRecognizeReg,
  onEditSpot,
  onApplySpot,
}: InfoPanelProps) {
  const e = photo.exif;
  const hasExif = hasAnyExif(e);
  const mapData = gpsMapData(e);

  const sections: InfoSection[] = [];

  const basicRows: InfoRow[] = [
    { key: '文件名', value: photo.filename },
    { key: '文件夹', value: photo.folder || '(根目录)' },
    { key: '大小', value: fmtSize(photo.size) },
    {
      key: '分辨率',
      value:
        e.image_width && e.image_height ? `${e.image_width} × ${e.image_height} px` : null,
    },
    { key: '像素总数', value: fmtMegapixels(e.image_width, e.image_height) },
    { key: '机号', value: <RegistrationCell photo={photo} readOnly={readOnly} ocrAvailable={ocrAvailable} regBusy={regBusy} regError={regError} onRecognize={onRecognizeReg} /> },
    {
      key: '拍摄点',
      value: (
        <SpotCell
          spot={spot}
          photoHasGps={e.gps_lat != null && e.gps_lon != null}
          readOnly={readOnly}
          spotBusy={spotBusy}
          spotError={spotError}
          onEdit={onEditSpot}
          onApply={onApplySpot}
        />
      ),
    },
  ];
  sections.push({ title: '基本信息', rows: basicRows });

  if (hasExif) {
    sections.push({ title: '拍摄时间', rows: [{ key: '拍摄时间', value: e.date_taken }] });
  }

  if (hasExif && (e.make || e.model || e.lens_model || e.software)) {
    sections.push({
      title: '相机',
      rows: [
        { key: '品牌', value: e.make },
        { key: '型号', value: e.model },
        { key: '镜头', value: e.lens_model },
        { key: '软件', value: e.software },
      ],
    });
  }

  if (hasExif && (e.iso || e.exposure_time || e.f_number || e.focal_length)) {
    sections.push({
      title: '曝光参数',
      rows: [
        { key: 'ISO', value: e.iso },
        { key: '快门', value: e.exposure_time },
        { key: '光圈', value: e.f_number },
        { key: '焦距', value: e.focal_length },
        { key: '等效焦距', value: e.focal_length_35mm },
        { key: '曝光补偿', value: e.exposure_bias },
        { key: '测光模式', value: e.metering_mode },
        { key: '白平衡', value: e.white_balance },
        { key: '闪光灯', value: e.flash },
      ],
    });
  }

  const hasGps =
    hasExif &&
    (e.gps_lat != null ||
      e.gps_lon != null ||
      e.gps_altitude != null ||
      !!e.gps_date_stamp ||
      !!e.gps_time_stamp ||
      !!e.gps_version_id ||
      !!e.gps_map_datum);

  if (hasGps) {
    const gpsRows: InfoRow[] = [];
    if (mapData) {
      gpsRows.push({
        key: '__map',
        value: (
          <GpsMapSection
            exif={e}
            variant="mini"
            settings={gpsSettings}
            mapState={gpsMapState}
            customLength={gpsCustomLength}
            onSettingsChange={onGpsSettingsChange}
            onStateChange={onGpsMapStateChange}
            onCustomLengthChange={onGpsCustomLengthChange}
            onOpenLarge={onOpenLargeMap}
            onOpenSettings={onOpenMapSettings}
          />
        ),
      });
    }
    gpsRows.push(
      { key: '海拔高度', value: formatGpsAltitude(e.gps_altitude) },
      {
        key: '日期时间戳',
        value: formatGpsDateTime(e.gps_date_stamp, e.gps_time_stamp),
      },
      { key: 'GPS 版本', value: e.gps_version_id },
      {
        key: '纬度',
        value: formatGpsDisplay(e, 'lat', coordModes.lat),
        gpsToggle: 'lat',
      },
      {
        key: '经度',
        value: formatGpsDisplay(e, 'lon', coordModes.lon),
        gpsToggle: 'lon',
      },
      { key: '映射数据', value: e.gps_map_datum },
    );
    sections.push({ title: 'GPS', rows: gpsRows });
  }

  return (
    <>
      <div id="v-charts" className="in-info">
        <div className={`chart-panel${rgbOn ? ' show' : ''}`} id="v-rgb-panel">
          <div className="chart-title">RGB</div>
          <svg className="chart-svg" viewBox="0 0 256 100" preserveAspectRatio="none">
            <path id="rgb-r" fill="#f47b7b" d={rgbPaths?.r} />
            <path id="rgb-g" fill="#82c882" d={rgbPaths?.g} />
            <path id="rgb-b" fill="#335ea8" d={rgbPaths?.b} />
          </svg>
        </div>
        <div className={`chart-panel${histOn ? ' show' : ''}`} id="v-hist-panel">
          <div className="chart-title">Histogram</div>
          <svg className="chart-svg" viewBox="0 0 256 100" preserveAspectRatio="none">
            <path id="hist-l" fill="#9aa0a6" stroke="#5b8cd6" strokeWidth={0.4} d={histPath || undefined} />
          </svg>
        </div>
      </div>
      <div className="vinfo-sections">
        {sections.map((section) => (
          <div className="sec" key={section.title}>
            <div className="sec-title">{section.title}</div>
            {section.rows
              .filter((row) => row.value != null && row.value !== '')
              .map((row) =>
                row.key === '__map' ? (
                  <div key={row.key}>{row.value}</div>
                ) : (
                  <div className="row" key={`${section.title}-${row.key}`}>
                    <span
                      className={`rk${row.gpsToggle ? ' gps-toggle-key' : ''}`}
                      title={
                        row.gpsToggle ? gpsToggleTitle(coordModes[row.gpsToggle]) : undefined
                      }
                      onClick={
                        row.gpsToggle
                          ? () => onToggleCoordMode(row.gpsToggle as 'lat' | 'lon')
                          : undefined
                      }
                    >
                      {row.key}
                    </span>
                    <span className="rv">{row.value}</span>
                  </div>
                ),
              )}
          </div>
        ))}
        {!hasExif && <div className="no-exif-note">此文件不含 EXIF 数据</div>}
      </div>
    </>
  );
}
