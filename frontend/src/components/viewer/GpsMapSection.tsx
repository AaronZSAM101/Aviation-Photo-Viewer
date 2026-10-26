import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { ExifData, GpsMapSettings, GpsPoint } from '../../types';
import {
  GPS_BUILTIN_SOURCE_MAP,
  GPS_MAP_DEFAULTS,
  activeGpsMapSource,
  clampGpsMapZoom,
  formatGpsDistance,
  formatGpsFocalMm,
  formatGpsTargetMeters,
  gpsDistanceMeters,
  gpsExifFocalMm,
  gpsFocalGuideRings,
  gpsFocalLengthLabel,
  gpsFocalSegmentLabels,
  gpsLatLonFromTile,
  gpsMapData,
  gpsMapSourceByProvider,
  gpsMeasureDistance,
  gpsProviderLabel,
  gpsTileCoord,
  gpsTileUrl,
  wrappedTileDelta,
} from '../../utils/gps';

export interface GpsMapState {
  subpath: string;
  centerLat: number | null;
  centerLon: number | null;
  active: boolean;
  points: GpsPoint[];
  focalGuide: boolean;
}

interface GpsMapSectionProps {
  exif: ExifData;
  variant: 'mini' | 'large';
  settings: GpsMapSettings;
  mapState: GpsMapState;
  customLength: number | null;
  onSettingsChange: (settings: GpsMapSettings) => void;
  onStateChange: (updater: (state: GpsMapState) => GpsMapState) => void;
  onCustomLengthChange: (value: number | null) => void;
  onOpenLarge: () => void;
  onOpenSettings: () => void;
}

export function GpsMapSection({
  exif,
  variant,
  settings,
  mapState,
  customLength,
  onSettingsChange,
  onStateChange,
  onCustomLengthChange,
  onOpenLarge,
  onOpenSettings,
}: GpsMapSectionProps) {
  const mapRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    startTileX: number;
    startTileY: number;
    zoom: number;
    tileSize: number;
  } | null>(null);
  const [customInput, setCustomInput] = useState(customLength ? String(customLength) : '');
  const customTimerRef = useRef<number | null>(null);

  useEffect(() => {
    setCustomInput(customLength ? String(customLength) : '');
  }, [customLength]);

  useEffect(
    () => () => {
      if (customTimerRef.current) window.clearTimeout(customTimerRef.current);
    },
    [],
  );

  const data = gpsMapData(exif);
  const source =
    variant === 'mini'
      ? GPS_BUILTIN_SOURCE_MAP.get(GPS_MAP_DEFAULTS.provider)!
      : activeGpsMapSource(settings);
  const zoom = clampGpsMapZoom(settings.zoom, source);
  const tileSize = variant === 'large' ? 256 : 96;
  const radius = variant === 'large' ? 2 : 1;
  const gridSize = radius * 2 + 1;
  const layerSize = tileSize * gridSize;
  const center = data
    ? {
        lat:
          Number.isFinite(mapState.centerLat) && mapState.centerLat != null
            ? mapState.centerLat
            : data.lat,
        lon:
          Number.isFinite(mapState.centerLon) && mapState.centerLon != null
            ? mapState.centerLon
            : data.lon,
      }
    : null;

  useEffect(() => {
    const element = mapRef.current;
    if (!element || !data) return;
    const handler = (event: WheelEvent) => {
      event.preventDefault();
      const next = clampGpsMapZoom(settings.zoom + (event.deltaY < 0 ? 1 : -1), source);
      if (next !== settings.zoom) onSettingsChange({ ...settings, zoom: next });
    };
    element.addEventListener('wheel', handler, { passive: false });
    return () => element.removeEventListener('wheel', handler);
  });

  if (!data || !center) return null;

  const centerTile = gpsTileCoord(center.lat, center.lon, zoom);
  const photoTile = gpsTileCoord(data.lat, data.lon, zoom);
  const n = centerTile.n;
  const baseX = Math.floor(centerTile.x) - radius;
  const baseY = Math.floor(centerTile.y) - radius;
  const centerX = (centerTile.x - baseX) * tileSize;
  const centerY = (centerTile.y - baseY) * tileSize;
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
      tiles.push(
        <div
          className="gps-map-tile"
          key={`${row}-${col}`}
          style={{ left: col * tileSize, top: row * tileSize, width: tileSize, height: tileSize }}
        >
          <img
            src={url}
            alt=""
            draggable={false}
            onLoad={(event) => {
              event.currentTarget.style.visibility = 'visible';
            }}
            onError={(event) => {
              event.currentTarget.style.visibility = 'hidden';
            }}
          />
        </div>,
      );
    }
  }

  const centerTileWithZoom = { x: centerTile.x, y: centerTile.y, zoom };
  const measureVisible =
    variant === 'large' &&
    (mapState.active || mapState.points.length > 0 || mapState.focalGuide);
  const renderedPoints = mapState.points.map((point) => {
    const tile = gpsTileCoord(point.lat, point.lon, zoom);
    return {
      x: wrappedTileDelta(tile.x, centerTile.x, n) * tileSize,
      y: (tile.y - centerTile.y) * tileSize,
    };
  });
  const exifFocal = gpsExifFocalMm(exif);
  const focalRings =
    measureVisible && mapState.focalGuide
      ? gpsFocalGuideRings(
          { lat: data.lat, lon: data.lon, x: markerX, y: markerY },
          centerTileWithZoom,
          tileSize,
          exifFocal,
          customLength,
        )
      : [];
  const focal = gpsFocalLengthLabel(exif);
  const distance = formatGpsDistance(gpsMeasureDistance(mapState.points));
  const hint = mapState.active
    ? mapState.points.length
      ? '线段按拍摄距离估算焦段'
      : '点击地图开始测距'
    : '测距已暂停';

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('button,input,select')) return;
    if (!data) return;
    if (variant === 'large' && mapState.active) {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      const dx = event.clientX - (rect.left + rect.width / 2);
      const dy = event.clientY - (rect.top + rect.height / 2);
      const point = gpsLatLonFromTile(
        centerTile.x + dx / tileSize,
        centerTile.y + dy / tileSize,
        zoom,
      );
      onStateChange((state) => ({ ...state, points: [...state.points, point] }));
      return;
    }
    event.preventDefault();
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      startTileX: centerTile.x,
      startTileY: centerTile.y,
      zoom,
      tileSize,
    };
    event.currentTarget.classList.add('dragging');
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    event.preventDefault();
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    const next = gpsLatLonFromTile(
      drag.startTileX - dx / drag.tileSize,
      drag.startTileY - dy / drag.tileSize,
      drag.zoom,
    );
    onStateChange((state) => ({ ...state, centerLat: next.lat, centerLon: next.lon }));
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    event.currentTarget.classList.remove('dragging');
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const stepZoom = (delta: number) => {
    onSettingsChange({ ...settings, zoom: clampGpsMapZoom(zoom + delta, source) });
  };

  const resetCenter = () => {
    onStateChange((state) => ({ ...state, centerLat: data.lat, centerLon: data.lon }));
  };

  const toggleMeasure = () => {
    onStateChange((state) => ({ ...state, active: !state.active }));
  };

  const clearMeasure = () => {
    onStateChange((state) => ({ ...state, points: [], active: true }));
  };

  const toggleFocalGuide = () => {
    onStateChange((state) => ({ ...state, focalGuide: !state.focalGuide }));
  };

  const updateCustomLength = (value: string) => {
    setCustomInput(value);
    if (customTimerRef.current) window.clearTimeout(customTimerRef.current);
    customTimerRef.current = window.setTimeout(() => {
      const num = Number(value);
      onCustomLengthChange(Number.isFinite(num) && num > 0 ? num : null);
    }, 300);
  };

  const commitCustomLength = (value: string) => {
    if (customTimerRef.current) window.clearTimeout(customTimerRef.current);
    const num = Number(value);
    onCustomLengthChange(Number.isFinite(num) && num > 0 ? num : null);
  };

  const title = `地图位置：${data.latLabel}, ${data.lonLabel}`;

  return (
    <div
      ref={mapRef}
      className={`gps-mini-map${variant === 'large' ? ' gps-large-map' : ''}`}
      role="img"
      aria-label={title}
      title={title}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerLeave={endDrag}
    >
      <div
        className="gps-tile-layer"
        style={
          {
            '--center-x': `${centerX.toFixed(2)}px`,
            '--center-y': `${centerY.toFixed(2)}px`,
            '--tile-layer-size': `${layerSize}px`,
          } as CSSProperties
        }
      >
        {tiles}
      </div>
      <div
        className="gps-map-photo-marker"
        title="照片位置"
        style={
          {
            '--marker-x': `${markerX.toFixed(2)}px`,
            '--marker-y': `${markerY.toFixed(2)}px`,
          } as CSSProperties
        }
      />

      {measureVisible && (
        <>
          <div className="gps-map-measure-layer">
            <svg viewBox="0 0 2000 2000" preserveAspectRatio="none" aria-hidden="true">
              {focalRings.map((ring) => (
                <circle
                  key={ring.key}
                  className={`gps-focal-guide-circle gps-focal-guide-circle-${ring.key}`}
                  cx={(1000 + markerX).toFixed(1)}
                  cy={(1000 + markerY).toFixed(1)}
                  r={ring.radiusPx.toFixed(1)}
                />
              ))}
              {renderedPoints.length > 1 && (
                <polyline
                  points={renderedPoints
                    .map((point) => `${(1000 + point.x).toFixed(1)},${(1000 + point.y).toFixed(1)}`)
                    .join(' ')}
                />
              )}
            </svg>
            {focalRings.map((ring) => (
              <div
                key={`label-${ring.key}`}
                className={`gps-measure-segment gps-focal-guide-label gps-focal-ring-label gps-focal-ring-label-${ring.key}`}
                style={
                  {
                    '--measure-x': `${ring.labelX.toFixed(2)}px`,
                    '--measure-y': `${ring.labelY.toFixed(2)}px`,
                  } as CSSProperties
                }
              >
                <span>{formatGpsFocalMm(exifFocal || 0)} 参考圈</span>
                <span>
                  {ring.label}机长{formatGpsTargetMeters(ring.length)} 最远{' '}
                  {formatGpsDistance(ring.distance)}
                </span>
              </div>
            ))}
            {renderedPoints.slice(1).map((point, idx) => {
              const prev = renderedPoints[idx];
              const meters = gpsDistanceMeters(mapState.points[idx], mapState.points[idx + 1]);
              const labels = gpsFocalSegmentLabels(
                mapState.points[idx],
                mapState.points[idx + 1],
                customLength,
              );
              return (
                <div
                  className="gps-measure-segment"
                  key={`seg-${idx}`}
                  style={
                    {
                      '--measure-x': `${((prev.x + point.x) / 2).toFixed(2)}px`,
                      '--measure-y': `${((prev.y + point.y) / 2).toFixed(2)}px`,
                    } as CSSProperties
                  }
                >
                  <span>A→B {formatGpsDistance(meters)}</span>
                  {labels.map((label) => (
                    <span key={label}>{label}</span>
                  ))}
                </div>
              );
            })}
            {renderedPoints.map((point, idx) => (
              <div
                className="gps-measure-point"
                key={`point-${idx}`}
                style={
                  {
                    '--measure-x': `${point.x.toFixed(2)}px`,
                    '--measure-y': `${point.y.toFixed(2)}px`,
                  } as CSSProperties
                }
              >
                {idx + 1}
              </div>
            ))}
          </div>
          <div className="gps-map-measure-readout">
            <span>{distance}</span>
            {focal && (
              <button
                type="button"
                className={mapState.focalGuide ? 'active' : ''}
                data-gps-focal-guide
                title="显示/隐藏拍摄点距离参考圈"
                onClick={toggleFocalGuide}
              >
                {focal}
              </button>
            )}
            <span className="gps-aircraft-basis">
              机长：窄体 40m · 宽体 65m · 自定义
            </span>
            <label className="gps-custom-aircraft-length" title="按自定义机长测算所需焦段">
              <input
                type="number"
                min={1}
                max={120}
                step={0.1}
                value={customInput}
                onChange={(event) => updateCustomLength(event.target.value)}
                onBlur={(event) => commitCustomLength(event.target.value)}
              />
              <span>m</span>
            </label>
            <span>{hint}</span>
          </div>
        </>
      )}

      {variant === 'large' && (
        <div className="gps-map-zoom">
          <button type="button" title="放大" onClick={() => stepZoom(1)}>+</button>
          <span>{zoom}</span>
          <button type="button" title="缩小" onClick={() => stepZoom(-1)}>-</button>
          <button type="button" title="回到照片位置" onClick={resetCenter}>◎</button>
        </div>
      )}

      <div className="gps-map-controls">
        {variant === 'large' &&
          [...GPS_BUILTIN_SOURCE_MAP.values()].slice(0, 3).map((item) => (
            <button
              type="button"
              key={item.id}
              className={settings.provider === item.id ? 'active' : ''}
              onClick={() => {
                const nextSource = gpsMapSourceByProvider(item.id, settings);
                onSettingsChange({
                  ...settings,
                  provider: item.id,
                  zoom: clampGpsMapZoom(settings.zoom, nextSource),
                });
              }}
            >
              {item.id === 'esri' ? '卫星' : item.name.replace('Google ', 'G ')}
            </button>
          ))}
        {variant === 'large' && (
          <button
            type="button"
            className={mapState.active ? 'active' : ''}
            title="测距"
            onClick={toggleMeasure}
          >
            测距
          </button>
        )}
        {variant === 'large' && mapState.points.length > 0 && (
          <button type="button" title="清除测距" onClick={clearMeasure}>清除</button>
        )}
        {variant === 'mini' && (
          <button type="button" title="打开大地图" onClick={onOpenLarge}>大图</button>
        )}
        {variant === 'large' && (
          <button type="button" title="图源设置" onClick={onOpenSettings}>图源</button>
        )}
      </div>

      <div className="gps-map-readout">
        {data.latLabel} · {data.lonLabel}
      </div>
      <div className="gps-map-source">{gpsProviderLabel(source)}</div>
    </div>
  );
}
