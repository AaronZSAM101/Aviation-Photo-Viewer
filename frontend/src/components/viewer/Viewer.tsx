import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { App as AntdApp, Modal } from 'antd';
import { PhotosApi } from '../../api/photos';
import { StageApi } from '../../api/stage';
import { useAppDispatch, useAppSelector } from '../../store';
import {
  setGpsCustomAircraftLength,
  setGpsSettings,
  setZoomMode,
} from '../../store/appSlice';
import { setLens, setStagedOps } from '../../store/photosSlice';
import type { OpKind, Photo, ZoomMode } from '../../types';
import { errorText } from '../../utils/errors';
import {
  type GpsCoordMode,
  gpsMapData,
} from '../../utils/gps';
import { buildAreaPath, computeHistograms, peakOf } from '../../utils/histogram';
import { photoUrl, subpath } from '../../utils/paths';
import { stagedSets } from '../../utils/staged';
import { GpsMapSection, type GpsMapState } from './GpsMapSection';
import { InfoPanel } from './InfoPanel';
import { MapSettingsModal } from './MapSettingsModal';

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 8;

interface ViewerProps {
  open: boolean;
  photos: Photo[];
  index: number | null;
  keysDisabled: boolean;
  onClose: () => void;
  onNavigate: (index: number) => void;
  onOpenFileOp: (kind: OpKind, src: string) => void;
  onOpenExifEdit: (src: string) => void;
}

function emptyMapState(sp: string): GpsMapState {
  return {
    subpath: sp,
    centerLat: null,
    centerLon: null,
    active: false,
    points: [],
    focalGuide: false,
  };
}

function clampZoom(scale: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
}

export function Viewer({
  open,
  photos,
  index,
  keysDisabled,
  onClose,
  onNavigate,
  onOpenFileOp,
  onOpenExifEdit,
}: ViewerProps) {
  const dispatch = useAppDispatch();
  const { message } = AntdApp.useApp();
  const readOnly = useAppSelector((state) => state.app.readOnly);
  const zoomModePref = useAppSelector((state) => state.app.zoomMode);
  const gpsSettings = useAppSelector((state) => state.app.gpsSettings);
  const gpsCustomLength = useAppSelector((state) => state.app.gpsCustomAircraftLength);
  const stagedOps = useAppSelector((state) => state.photos.stagedOps);

  const currentPhoto = index != null ? photos[index] ?? null : null;
  const currentSp = currentPhoto ? subpath(currentPhoto) : '';
  const staged = stagedSets(stagedOps);
  const isStaged = !!currentSp && staged.deletes.has(currentSp);

  const imgRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<SVGSVGElement | null>(null);
  const fineGridRef = useRef<HTMLDivElement | null>(null);
  const vinfoRef = useRef<HTMLDivElement | null>(null);

  const zoomModeRef = useRef<ZoomMode>(zoomModePref);
  const zoomScaleRef = useRef(1);
  const equalizeRef = useRef(false);
  const togglesRef = useRef({ rgbOn: false, histOn: false });
  const currentSpRef = useRef(currentSp);
  const prefetchedRef = useRef<Set<string>>(new Set());
  const panRef = useRef<{
    startX: number;
    startY: number;
    scrollLeft: number;
    scrollTop: number;
  } | null>(null);

  const [equalizeOn, setEqualizeOn] = useState(false);
  const [gridOn, setGridOn] = useState(false);
  const [fineGridOn, setFineGridOn] = useState(false);
  const [rgbOn, setRgbOn] = useState(false);
  const [histOn, setHistOn] = useState(false);
  const [infoOn, setInfoOn] = useState(true);
  const [zoomMode, setZoomModeState] = useState<ZoomMode>(zoomModePref);
  const [spinner, setSpinner] = useState(false);
  const [rgbPaths, setRgbPaths] = useState<{ r: string; g: string; b: string } | null>(null);
  const [histPath, setHistPath] = useState('');
  const [mapState, setMapState] = useState<GpsMapState>(() => emptyMapState(''));
  const [coordModes, setCoordModes] = useState<Record<'lat' | 'lon', GpsCoordMode>>({
    lat: 'dms',
    lon: 'dms',
  });
  const [mapSettingsOpen, setMapSettingsOpen] = useState(false);
  const [largeMapOpen, setLargeMapOpen] = useState(false);

  currentSpRef.current = currentSp;

  useEffect(() => {
    zoomModeRef.current = zoomMode;
  }, [zoomMode]);

  useEffect(() => {
    togglesRef.current = { rgbOn, histOn };
  }, [rgbOn, histOn]);

  const displaySource = useCallback(
    (): HTMLImageElement | HTMLCanvasElement | null =>
      equalizeRef.current ? canvasRef.current : imgRef.current,
    [],
  );

  const fitGridToImage = useCallback(() => {
    const content = contentRef.current;
    const grid = gridRef.current;
    const fine = fineGridRef.current;
    if (!content || !grid || !fine) return;
    const rect = content.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const fineX = Math.max(4, (rect.width * 25) / 1024);
    const fineY = Math.max(4, (rect.height * 25) / 683);
    const styles = { left: '0', top: '0', width: '100%', height: '100%' };
    Object.assign(grid.style, styles);
    Object.assign(fine.style, styles);
    fine.style.setProperty('--fine-grid-x', `${fineX}px`);
    fine.style.setProperty('--fine-grid-y', `${fineY}px`);
  }, []);

  const adjustVinfoHeight = useCallback(() => {
    const vinfo = vinfoRef.current;
    if (!vinfo) return;
    if (!window.matchMedia('(max-width: 900px) and (orientation: portrait)').matches) {
      vinfo.style.maxHeight = '';
      return;
    }
    const img = equalizeRef.current ? canvasRef.current : imgRef.current;
    if (!img) return;
    const rect = img.getBoundingClientRect();
    vinfo.style.maxHeight = `${Math.max(0, Math.floor(window.innerHeight - rect.bottom - 8))}px`;
  }, []);

  const applyZoom = useCallback(
    (options: {
      mode?: ZoomMode;
      scale?: number | null;
      anchor?: { x: number; y: number } | null;
      preserveCenter?: boolean;
    } = {}) => {
      const {
        mode = zoomModeRef.current,
        scale = null,
        anchor = null,
        preserveCenter = true,
      } = options;
      const src = displaySource();
      const stage = stageRef.current;
      const content = contentRef.current;
      if (!src || !stage || !content) return;
      const width = src instanceof HTMLImageElement ? src.naturalWidth : src.width;
      const height = src instanceof HTMLImageElement ? src.naturalHeight : src.height;
      if (!width || !height) return;

      const stageW = Math.max(1, stage.clientWidth);
      const stageH = Math.max(1, stage.clientHeight);
      let nextScale: number;
      if (scale != null) {
        nextScale = clampZoom(scale);
      } else if (mode === 'fit') {
        nextScale = clampZoom(Math.min(stageW / width, stageH / height));
      } else if (mode === 'fill') {
        nextScale = clampZoom(Math.max(stageW / width, stageH / height));
      } else if (mode === 'custom') {
        nextScale = clampZoom(zoomScaleRef.current || 1);
      } else {
        nextScale = 1;
      }

      const anchorPoint = anchor || { x: stageW / 2, y: stageH / 2 };
      const oldScale = zoomScaleRef.current || 1;
      const contentX = preserveCenter
        ? (stage.scrollLeft + anchorPoint.x) / oldScale
        : width / 2;
      const contentY = preserveCenter
        ? (stage.scrollTop + anchorPoint.y) / oldScale
        : height / 2;

      zoomModeRef.current = mode;
      zoomScaleRef.current = nextScale;
      setZoomModeState(mode);

      content.style.width = `${Math.max(1, Math.round(width * nextScale))}px`;
      content.style.height = `${Math.max(1, Math.round(height * nextScale))}px`;

      requestAnimationFrame(() => {
        stage.scrollLeft = Math.max(0, contentX * nextScale - anchorPoint.x);
        stage.scrollTop = Math.max(0, contentY * nextScale - anchorPoint.y);
        fitGridToImage();
        adjustVinfoHeight();
      });
    },
    [displaySource, fitGridToImage, adjustVinfoHeight],
  );

  const refreshHistograms = useCallback(() => {
    const { rgbOn: rgb, histOn: hist } = togglesRef.current;
    if (!rgb && !hist) return;
    const histograms = computeHistograms(displaySource());
    if (!histograms) return;
    if (rgb) {
      const peak = Math.max(
        peakOf(histograms.r),
        peakOf(histograms.g),
        peakOf(histograms.b),
      );
      setRgbPaths({
        r: buildAreaPath(histograms.r, 256, 100, peak),
        g: buildAreaPath(histograms.g, 256, 100, peak),
        b: buildAreaPath(histograms.b, 256, 100, peak),
      });
    }
    if (hist) {
      setHistPath(buildAreaPath(histograms.L, 256, 100, peakOf(histograms.L)));
    }
  }, [displaySource]);

  const prefetchAdjacent = useCallback(() => {
    if (index == null) return;
    [index - 1, index + 1].forEach((nearby) => {
      const photo = photos[nearby];
      if (!photo) return;
      const url = photoUrl(photo);
      if (prefetchedRef.current.has(url)) return;
      prefetchedRef.current.add(url);
      if (prefetchedRef.current.size > 80) {
        const first = prefetchedRef.current.values().next().value;
        if (first) prefetchedRef.current.delete(first);
      }
      const image = new Image();
      image.src = url;
    });
  }, [index, photos]);

  const handleImageLoad = () => {
    setSpinner(false);
    applyZoom({ mode: zoomModeRef.current, preserveCenter: false });
    fitGridToImage();
    adjustVinfoHeight();
    refreshHistograms();
    prefetchAdjacent();
  };

  useEffect(() => {
    if (!open) return;
    equalizeRef.current = false;
    setEqualizeOn(false);
    setGridOn(false);
    setFineGridOn(false);
    setRgbOn(false);
    setHistOn(false);
    setInfoOn(true);
    zoomScaleRef.current = 1;
    setLargeMapOpen(false);
    setMapSettingsOpen(false);
  }, [open]);

  useEffect(() => {
    if (!open || !currentSp) return;
    setMapState((state) =>
      state.subpath === currentSp ? state : emptyMapState(currentSp),
    );
    equalizeRef.current = false;
    setEqualizeOn(false);
    setSpinner(true);
  }, [open, currentSp]);

  useEffect(() => {
    if (!open) return;
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = stage.getBoundingClientRect();
      applyZoom({
        mode: 'custom',
        scale: clampZoom((zoomScaleRef.current || 1) * Math.exp(-event.deltaY * 0.002)),
        anchor: { x: event.clientX - rect.left, y: event.clientY - rect.top },
        preserveCenter: true,
      });
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [open, applyZoom]);

  useEffect(() => {
    if (!open) return;
    const onResize = () => {
      if (zoomModeRef.current === 'fit' || zoomModeRef.current === 'fill') {
        applyZoom({ mode: zoomModeRef.current, preserveCenter: true });
      } else {
        fitGridToImage();
      }
      adjustVinfoHeight();
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, [open, applyZoom, fitGridToImage, adjustVinfoHeight]);

  useEffect(() => {
    if (!open || !currentPhoto || currentPhoto.exif.lens_model) return;
    const sp = currentSp;
    let cancelled = false;
    PhotosApi.getLens(sp)
      .then((data) => {
        if (cancelled || currentSpRef.current !== sp) return;
        if (data?.lens_model) {
          dispatch(setLens({ subpath: sp, lens: data.lens_model }));
        }
      })
      .catch(() => {
        /* lens fallback is best-effort */
      });
    return () => {
      cancelled = true;
    };
  }, [open, currentSp, currentPhoto, dispatch]);

  const handleToggleEqualize = () => {
    if (!equalizeRef.current) {
      const img = imgRef.current;
      const canvas = canvasRef.current;
      if (!img || !canvas || !img.complete || !img.naturalWidth) return;
      const sp = currentSp;
      setSpinner(true);
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const source = imgRef.current;
          const target = canvasRef.current;
          if (!source || !target || currentSpRef.current !== sp || !source.naturalWidth) {
            setSpinner(false);
            return;
          }
          const w = source.naturalWidth;
          const h = source.naturalHeight;
          const scale = Math.min(1, 2400 / Math.max(w, h));
          const cw = Math.max(1, Math.round(w * scale));
          const ch = Math.max(1, Math.round(h * scale));
          target.width = cw;
          target.height = ch;
          const ctx = target.getContext('2d', { willReadFrequently: true });
          if (!ctx) {
            setSpinner(false);
            return;
          }
          ctx.drawImage(source, 0, 0, cw, ch);
          let imageData: ImageData;
          try {
            imageData = ctx.getImageData(0, 0, cw, ch);
          } catch {
            setSpinner(false);
            return;
          }
          const data = imageData.data;
          const total = cw * ch;
          for (let channel = 0; channel < 3; channel += 1) {
            const histogram = new Uint32Array(256);
            for (let i = 0; i < total; i += 1) histogram[data[i * 4 + channel]] += 1;
            const cdf = new Uint32Array(256);
            let acc = 0;
            for (let i = 0; i < 256; i += 1) {
              acc += histogram[i];
              cdf[i] = acc;
            }
            let cdfMin = 0;
            for (let i = 0; i < 256; i += 1) {
              if (cdf[i] > 0) {
                cdfMin = cdf[i];
                break;
              }
            }
            const denom = total - cdfMin;
            const lut = new Uint8ClampedArray(256);
            for (let i = 0; i < 256; i += 1) {
              lut[i] = denom > 0 ? Math.round(((cdf[i] - cdfMin) / denom) * 255) : i;
            }
            for (let i = 0; i < total; i += 1) {
              data[i * 4 + channel] = lut[data[i * 4 + channel]];
            }
          }
          ctx.putImageData(imageData, 0, 0);
          equalizeRef.current = true;
          setEqualizeOn(true);
          setSpinner(false);
          requestAnimationFrame(() => {
            applyZoom({ mode: zoomModeRef.current, preserveCenter: true });
            fitGridToImage();
            refreshHistograms();
          });
        }),
      );
      return;
    }
    equalizeRef.current = false;
    setEqualizeOn(false);
    requestAnimationFrame(() => {
      applyZoom({ mode: zoomModeRef.current, preserveCenter: true });
      fitGridToImage();
      refreshHistograms();
    });
  };

  const toggleGrid = () => {
    const next = !gridOn;
    setGridOn(next);
    if (next) requestAnimationFrame(fitGridToImage);
  };

  const toggleFineGrid = () => {
    const next = !fineGridOn;
    setFineGridOn(next);
    if (next) requestAnimationFrame(fitGridToImage);
  };

  const toggleRgb = () => {
    const next = !rgbOn;
    setRgbOn(next);
    togglesRef.current.rgbOn = next;
    if (next) requestAnimationFrame(refreshHistograms);
    requestAnimationFrame(adjustVinfoHeight);
  };

  const toggleHist = () => {
    const next = !histOn;
    setHistOn(next);
    togglesRef.current.histOn = next;
    if (next) requestAnimationFrame(refreshHistograms);
    requestAnimationFrame(adjustVinfoHeight);
  };

  const toggleInfo = () => {
    setInfoOn(!infoOn);
    requestAnimationFrame(fitGridToImage);
  };

  const handleZoomChange = (value: string) => {
    if (value === 'custom') return;
    const mode = value as ZoomMode;
    applyZoom({ mode, preserveCenter: true });
    dispatch(setZoomMode(mode));
  };

  const handleToggleDelete = async () => {
    if (readOnly) {
      message.warning('当前为只读模式，管理操作已禁用');
      return;
    }
    if (!currentSp) return;
    if (staged.deletes.has(currentSp)) {
      try {
        const list = await StageApi.list();
        const op = list.find((item) => item.kind === 'delete' && item.src === currentSp);
        if (op) await StageApi.remove(op.id);
      } catch (error) {
        message.error(`取消删除失败: ${errorText(error)}`);
        return;
      }
    } else {
      try {
        await StageApi.stage({ kind: 'delete', src: currentSp });
      } catch (error) {
        message.error(`加入删除列表失败: ${errorText(error)}`);
        return;
      }
    }
    try {
      dispatch(setStagedOps(await StageApi.list()));
    } catch {
      // 列表刷新失败时保持当前分批状态
    }
  };

  const go = (delta: number) => {
    if (index == null) return;
    const next = Math.max(0, Math.min(photos.length - 1, index + delta));
    if (next !== index) onNavigate(next);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest('button,select,input,textarea,a')) return;
    panRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: event.currentTarget.scrollLeft,
      scrollTop: event.currentTarget.scrollTop,
    };
    event.currentTarget.classList.add('is-panning');
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (!pan) return;
    event.preventDefault();
    event.currentTarget.scrollLeft = pan.scrollLeft - (event.clientX - pan.startX);
    event.currentTarget.scrollTop = pan.scrollTop - (event.clientY - pan.startY);
    fitGridToImage();
  };

  const endPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!panRef.current) return;
    panRef.current = null;
    event.currentTarget.classList.remove('is-panning');
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const keyHandlerRef = useRef<(event: KeyboardEvent) => void>(() => {});
  keyHandlerRef.current = (event: KeyboardEvent) => {
    const active = document.activeElement as HTMLElement | null;
    const tag = active?.tagName;
    const inField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    if (inField && event.key !== 'Escape') return;
    if (event.key === 'Escape') {
      onClose();
      return;
    }
    if (event.key === 'ArrowLeft') {
      go(-1);
      return;
    }
    if (event.key === 'ArrowRight') {
      go(1);
      return;
    }
    switch (event.key.toLowerCase()) {
      case 'e':
        handleToggleEqualize();
        break;
      case 'g':
        toggleGrid();
        break;
      case 'f':
        toggleFineGrid();
        break;
      case 'r':
        toggleRgb();
        break;
      case 'h':
        toggleHist();
        break;
      case 'i':
        toggleInfo();
        break;
      case 'd':
        void handleToggleDelete();
        break;
      default:
        break;
    }
  };

  useEffect(() => {
    const blocked = keysDisabled || mapSettingsOpen || largeMapOpen;
    if (!open || blocked) return;
    const listener = (event: KeyboardEvent) => keyHandlerRef.current(event);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [open, keysDisabled, mapSettingsOpen, largeMapOpen]);

  const chartCount = (rgbOn ? 1 : 0) + (histOn ? 1 : 0);
  const stageClasses = [
    infoOn || chartCount > 0 ? 'info-open' : '',
    infoOn ? 'exif-on-stage' : '',
    chartCount === 1 ? 'chart-open-one' : '',
    chartCount === 2 ? 'chart-open-two' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const infoClasses = [
    infoOn || chartCount > 0 ? 'show' : '',
    infoOn ? 'exif-on' : '',
    chartCount > 0 ? 'charts-open' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const effectiveMapState =
    currentSp && mapState.subpath === currentSp ? mapState : emptyMapState(currentSp);
  const hasMapData = !!currentPhoto && !!gpsMapData(currentPhoto.exif);
  const counter = index != null ? `${index + 1} / ${photos.length}` : '—';

  return (
    <>
      <div id="viewer" className={open ? 'show' : undefined}>
        {open && currentPhoto && (
          <>
            <div id="vtoolbar">
              <div id="v-toolbar-meta">
                <button id="v-close" className="icon" title="关闭 (Esc)" onClick={onClose}>
                  ✕
                </button>
                <span id="v-name">
                  {currentPhoto.folder
                    ? `${currentPhoto.folder} / ${currentPhoto.filename}`
                    : currentPhoto.filename}
                </span>
                {isStaged && !readOnly && (
                  <span id="v-staged-pill" className="show">待删除</span>
                )}
                <span id="v-counter">{counter}</span>
              </div>
              <div id="v-toolbar-tools">
                <button
                  id="v-equalize"
                  data-short="E"
                  title="检查污点 (E)"
                  className={equalizeOn ? 'active' : undefined}
                  onClick={handleToggleEqualize}
                >
                  检查污点
                </button>
                <button
                  id="v-gridbtn"
                  data-short="G"
                  title="居中 (G)"
                  className={gridOn ? 'active' : undefined}
                  onClick={toggleGrid}
                >
                  居中
                </button>
                <button
                  id="v-finegridbtn"
                  data-short="F"
                  title="地平 (F)"
                  className={fineGridOn ? 'active' : undefined}
                  onClick={toggleFineGrid}
                >
                  地平
                </button>
                <button
                  id="v-rgbbtn"
                  data-short="R"
                  title="RGB (R)"
                  className={rgbOn ? 'active' : undefined}
                  onClick={toggleRgb}
                >
                  RGB
                </button>
                <button
                  id="v-histbtn"
                  data-short="H"
                  title="直方图 (H)"
                  className={histOn ? 'active' : undefined}
                  onClick={toggleHist}
                >
                  直方图
                </button>
                <select
                  id="v-zoom-sel"
                  title="查看比例"
                  value={zoomMode}
                  onChange={(event) => handleZoomChange(event.target.value)}
                >
                  <option value="fit">适合屏幕</option>
                  <option value="actual">100%</option>
                  <option value="fill">填满窗口</option>
                  <option value="custom" disabled hidden>自定义</option>
                </select>
                <button
                  id="v-info-btn"
                  data-short="I"
                  title="EXIF (I)"
                  className={infoOn ? 'active' : undefined}
                  onClick={toggleInfo}
                >
                  EXIF
                </button>
                {!readOnly && (
                  <>
                    <button
                      id="v-exif-edit-btn"
                      data-short="编"
                      title="编辑 EXIF"
                      onClick={() => onOpenExifEdit(currentSp)}
                    >
                      编辑
                    </button>
                    <span className="vsep" />
                    <button
                      id="v-rename-btn"
                      data-short="重"
                      title="重命名"
                      onClick={() => onOpenFileOp('rename', currentSp)}
                    >
                      重命名
                    </button>
                    <button
                      id="v-move-btn"
                      data-short="移"
                      title="移动"
                      onClick={() => onOpenFileOp('move', currentSp)}
                    >
                      移动
                    </button>
                    <button
                      id="v-copy-btn"
                      data-short="复"
                      title="复制"
                      onClick={() => onOpenFileOp('copy', currentSp)}
                    >
                      复制
                    </button>
                    <button
                      id="v-delete-btn"
                      data-short="删"
                      title="删除 (D)"
                      className={isStaged ? 'staged' : undefined}
                      onClick={() => void handleToggleDelete()}
                    >
                      {isStaged ? '取消删除' : '删除'}
                    </button>
                  </>
                )}
              </div>
            </div>

            <div id="vmain">
              <div
                id="vstage"
                ref={stageRef}
                className={stageClasses || undefined}
                onScroll={fitGridToImage}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={endPan}
                onPointerCancel={endPan}
                onPointerLeave={endPan}
              >
                <div id="v-content" ref={contentRef}>
                  <img
                    id="v-img"
                    ref={imgRef}
                    alt=""
                    src={photoUrl(currentPhoto)}
                    style={{ display: equalizeOn ? 'none' : undefined }}
                    onLoad={handleImageLoad}
                    onError={() => setSpinner(false)}
                  />
                  <canvas
                    id="v-canvas"
                    ref={canvasRef}
                    style={{ display: equalizeOn ? 'block' : 'none' }}
                  />
                  <svg
                    id="v-grid"
                    ref={gridRef}
                    className={gridOn ? 'show' : undefined}
                    preserveAspectRatio="none"
                    viewBox="0 0 100 100"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <g fill="none" stroke="currentColor" strokeWidth={1.5}>
                      <line x1="23.14" y1="0" x2="23.14" y2="100" />
                      <line x1="76.86" y1="0" x2="76.86" y2="100" />
                      <line x1="0" y1="28.04" x2="100" y2="28.04" />
                      <line x1="0" y1="71.96" x2="100" y2="71.96" />
                      <line x1="23.14" y1="50.00" x2="76.86" y2="50.00" />
                      <line x1="50.00" y1="28.04" x2="50.00" y2="71.96" />
                    </g>
                  </svg>
                  <div
                    id="v-finegrid"
                    ref={fineGridRef}
                    className={fineGridOn ? 'show' : undefined}
                  />
                </div>
                <button
                  className="nav-arrow"
                  id="v-prev"
                  title="上一张 (←)"
                  disabled={index === 0}
                  onClick={() => go(-1)}
                >
                  ‹
                </button>
                <button
                  className="nav-arrow"
                  id="v-next"
                  title="下一张 (→)"
                  disabled={index != null && index === photos.length - 1}
                  onClick={() => go(1)}
                >
                  ›
                </button>
                <div id="vspin" className={spinner ? 'show' : undefined} />
              </div>

              <div id="vinfo" ref={vinfoRef} className={infoClasses || undefined}>
                <InfoPanel
                  photo={currentPhoto}
                  rgbOn={rgbOn}
                  histOn={histOn}
                  rgbPaths={rgbPaths}
                  histPath={histPath}
                  gpsSettings={gpsSettings}
                  gpsMapState={effectiveMapState}
                  gpsCustomLength={gpsCustomLength}
                  coordModes={coordModes}
                  onGpsSettingsChange={(next) => dispatch(setGpsSettings(next))}
                  onGpsMapStateChange={(updater) => setMapState(updater)}
                  onGpsCustomLengthChange={(value) =>
                    dispatch(setGpsCustomAircraftLength(value))
                  }
                  onToggleCoordMode={(type) =>
                    setCoordModes((current) => ({
                      ...current,
                      [type]: current[type] === 'decimal' ? 'dms' : 'decimal',
                    }))
                  }
                  onOpenLargeMap={() => setLargeMapOpen(true)}
                  onOpenMapSettings={() => setMapSettingsOpen(true)}
                />
              </div>
            </div>
          </>
        )}
      </div>

      {open && currentPhoto && (
        <>
          <MapSettingsModal
            open={mapSettingsOpen}
            settings={gpsSettings}
            onClose={() => setMapSettingsOpen(false)}
            onChange={(next) => dispatch(setGpsSettings(next))}
          />
          <Modal
            open={largeMapOpen}
            onCancel={() => setLargeMapOpen(false)}
            title="地图"
            footer={null}
            width={1120}
            style={{ maxWidth: '92vw', top: 24 }}
            destroyOnHidden
          >
            {hasMapData ? (
              <GpsMapSection
                exif={currentPhoto.exif}
                variant="large"
                settings={gpsSettings}
                mapState={effectiveMapState}
                customLength={gpsCustomLength}
                onSettingsChange={(next) => dispatch(setGpsSettings(next))}
                onStateChange={(updater) => setMapState(updater)}
                onCustomLengthChange={(value) =>
                  dispatch(setGpsCustomAircraftLength(value))
                }
                onOpenLarge={() => undefined}
                onOpenSettings={() => setMapSettingsOpen(true)}
              />
            ) : (
              <div className="gps-map-empty">当前照片没有 GPS 信息</div>
            )}
          </Modal>
        </>
      )}
    </>
  );
}
