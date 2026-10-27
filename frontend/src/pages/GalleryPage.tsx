import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { App as AntdApp } from 'antd';
import type { MouseEvent } from 'react';
import { PhotosApi } from '../api/photos';
import { SpotsApi } from '../api/spots';
import { StageApi } from '../api/stage';
import { AppHeader } from '../components/AppHeader';
import { CardContextMenu } from '../components/CardContextMenu';
import { EmptyState } from '../components/EmptyState';
import { GallerySection } from '../components/GallerySection';
import { BulkMoveModal } from '../components/modals/BulkMoveModal';
import { CompareModal } from '../components/modals/CompareModal';
import { ExifEditModal } from '../components/modals/ExifEditModal';
import { FileOpModal } from '../components/modals/FileOpModal';
import { LiveryModal } from '../components/modals/LiveryModal';
import { SetDirModal } from '../components/modals/SetDirModal';
import { ShortcutsModal } from '../components/modals/ShortcutsModal';
import { StagedModal } from '../components/modals/StagedModal';
import { TrashModal } from '../components/modals/TrashModal';
import { Viewer } from '../components/viewer/Viewer';
import type { ContextMenuItem } from '../components/CardContextMenu';
import { useAppDispatch, useAppSelector } from '../store';
import {
  applyConfig,
  setCollapseState,
  setSearchTerm,
  setLoading,
  setSort,
} from '../store/appSlice';
import { setPhotos, setSelection, setSpots, setStagedOps } from '../store/photosSlice';
import { applyServerAirport, refreshLiveryFeed } from '../store/liverySlice';
import type { GalleryCardEntry, OpKind, Photo, SortKey } from '../types';
import { errorText } from '../utils/errors';
import { hasAnyExif } from '../utils/format';
import { buildSections, collectSectionKeys } from '../utils/grouping';
import { decodeViewerPath, encodePath, subpath } from '../utils/paths';
import { filterPhotos } from '../utils/search';
import { stagedSets } from '../utils/staged';

interface CardMenuState {
  open: boolean;
  x: number;
  y: number;
  items: ContextMenuItem[];
  bulk: boolean;
  src: string | null;
  srcs: string[];
}

const CLOSED_MENU: CardMenuState = {
  open: false,
  x: 0,
  y: 0,
  items: [],
  bulk: false,
  src: null,
  srcs: [],
};

const MENU_WIDTH = 150;
const MENU_HEIGHT = 160;

const SCALE_LABEL: Record<string, string> = {
  none: '无时间分组',
  year: '按年',
  month: '按月',
  day: '按日',
};

function writeStateParam(params: URLSearchParams, key: string, value: string, fallback: string) {
  if (!value || value === fallback) params.delete(key);
  else params.set(key, value);
}

function writeSetParam(params: URLSearchParams, key: string, values: string[]) {
  params.delete(key);
  [...values].filter(Boolean).sort().forEach((value) => params.append(key, value));
}

export function GalleryPage() {
  const dispatch = useAppDispatch();
  const { message } = AntdApp.useApp();

  const photos = useAppSelector((state) => state.photos.photos);
  const stagedOps = useAppSelector((state) => state.photos.stagedOps);
  const selected = useAppSelector((state) => state.photos.selected);
  const anchor = useAppSelector((state) => state.photos.anchor);

  const currentSort = useAppSelector((state) => state.app.currentSort);
  const baseView = useAppSelector((state) => state.app.baseView);
  const timeScale = useAppSelector((state) => state.app.timeScale);
  const searchTerm = useAppSelector((state) => state.app.searchTerm);
  const collapseAll = useAppSelector((state) => state.app.collapseAll);
  const collapsedSections = useAppSelector((state) => state.app.collapsedSections);
  const expandedSections = useAppSelector((state) => state.app.expandedSections);
  const readOnly = useAppSelector((state) => state.app.readOnly);
  const liveryConfigured = useAppSelector((state) => state.app.liveryConfigured);
  const liveryAirport = useAppSelector((state) => state.livery.airport);
  const liveryDayOffset = useAppSelector((state) => state.livery.dayOffset);
  const liveryCount = useAppSelector((state) => state.livery.feed?.alerts.length ?? 0);
  const liveryLoading = useAppSelector((state) => state.livery.loading);
  const liveryAttempted = useAppSelector((state) => state.livery.attempted);

  const [searchValue, setSearchValue] = useState(searchTerm);
  const [viewerSp, setViewerSp] = useState<string | null>(null);
  const [routeReady, setRouteReady] = useState(false);
  const [menu, setMenu] = useState<CardMenuState>(CLOSED_MENU);
  const [fileOp, setFileOp] = useState<{ kind: OpKind; src: string } | null>(null);
  const [exifSrc, setExifSrc] = useState<string | null>(null);
  const [stagedOpen, setStagedOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const [liveryOpen, setLiveryOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [bulkMoveOpen, setBulkMoveOpen] = useState(false);
  const [setDirOpen, setSetDirOpen] = useState(false);

  const sortRef = useRef<SortKey>(currentSort);
  const startedRef = useRef(false);
  const loadSeqRef = useRef(0);
  const hideTimerRef = useRef<number | null>(null);

  useEffect(() => {
    sortRef.current = currentSort;
  }, [currentSort]);

  useEffect(
    () => () => {
      if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
    },
    [],
  );

  const staged = useMemo(() => stagedSets(stagedOps), [stagedOps]);
  const filtered = useMemo(() => filterPhotos(photos, searchTerm), [photos, searchTerm]);
  const sections = useMemo(
    () => buildSections(filtered, baseView, timeScale, currentSort),
    [filtered, baseView, timeScale, currentSort],
  );
  const sectionKeys = useMemo(() => collectSectionKeys(sections), [sections]);

  const numbering = useMemo(() => {
    const map = new Map<string, number>();
    let counter = 0;
    const walk = (list: ReturnType<typeof buildSections>) => {
      list.forEach((section) => {
        if (section.children.length) walk(section.children);
        else
          section.items.forEach((entry) => {
            counter += 1;
            map.set(subpath(entry.photo), counter);
          });
      });
    };
    walk(sections);
    return map;
  }, [sections]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const collapsedSet = useMemo(() => new Set(collapsedSections), [collapsedSections]);
  const expandedSet = useMemo(() => new Set(expandedSections), [expandedSections]);

  const safeViewerIndex =
    viewerSp != null ? filtered.findIndex((photo) => subpath(photo) === viewerSp) : -1;
  const viewerPhoto = safeViewerIndex >= 0 ? filtered[safeViewerIndex] ?? null : null;

  // ── 数据加载 ────────────────────────────────────────────────────────────
  const hideLoadingLater = useCallback((delay: number) => {
    if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null;
      dispatch(setLoading({ visible: false, progress: 0 }));
    }, delay);
  }, [dispatch]);

  const refreshStaged = useCallback(async () => {
    try {
      dispatch(setStagedOps(await StageApi.list()));
    } catch {
      dispatch(setStagedOps([]));
    }
  }, [dispatch]);

  // 拍摄点档案读不到不影响照片列表（老镜像根本没这个接口），当成空档案就行
  const refreshSpots = useCallback(async () => {
    try {
      dispatch(setSpots(await SpotsApi.list()));
    } catch {
      dispatch(setSpots({}));
    }
  }, [dispatch]);

  const loadPhotos = useCallback(
    async (sortOverride?: SortKey): Promise<Photo[]> => {
      const sort = sortOverride ?? sortRef.current;
      const seq = ++loadSeqRef.current;
      dispatch(setLoading({ visible: true, message: '读取照片…', progress: 30 }));
      let list: Photo[] = [];
      try {
        const [result] = await Promise.all([
          PhotosApi.getPhotos(sort),
          refreshStaged(),
          refreshSpots(),
        ]);
        list = result.photos;
        if (seq !== loadSeqRef.current) return [];
        dispatch(setPhotos(list));
        dispatch(setLoading({ progress: 100 }));
        if (result.scanErrors > 0) {
          message.open({
            type: 'warning',
            key: 'scan-status',
            content: `有 ${result.scanErrors} 个路径未能读取，照片列表可能不完整`,
          });
        } else if (result.scanTruncated) {
          message.open({
            type: 'warning',
            key: 'scan-status',
            content: '照片数量超过扫描上限，列表已截断',
          });
        } else {
          message.destroy('scan-status');
        }
      } catch (error) {
        if (seq === loadSeqRef.current) {
          dispatch(setLoading({ message: `加载失败: ${errorText(error)}` }));
        }
      }
      if (seq === loadSeqRef.current) hideLoadingLater(300);
      return list;
    },
    [dispatch, hideLoadingLater, message, refreshSpots, refreshStaged],
  );

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void (async () => {
      try {
        const config = await PhotosApi.getConfig();
        dispatch(applyConfig(config));
        dispatch(applyServerAirport(config.defaultAirport));
      } catch {
        // 配置读取失败时保持默认（可写）状态，与旧版一致
      }
      const list = await loadPhotos();
      const wanted = decodeViewerPath(window.location.pathname);
      if (wanted) {
        const visible = filterPhotos(list, searchTerm);
        if (visible.some((photo) => subpath(photo) === wanted)) setViewerSp(wanted);
      }
      setRouteReady(true);
    })();
  }, [dispatch, loadPhotos, searchTerm]);

  useEffect(() => {
    if (!routeReady || viewerSp === null) return;
    if (!filtered.some((photo) => subpath(photo) === viewerSp)) setViewerSp(null);
  }, [routeReady, viewerSp, filtered]);

  const handleReload = useCallback(async () => {
    if (!readOnly) {
      dispatch(setLoading({ visible: true, message: '刷新缓存…', progress: 20 }));
      try {
        await PhotosApi.refreshCaches();
        dispatch(setLoading({ progress: 70 }));
      } catch (error) {
        dispatch(setLoading({ message: `刷新缓存失败: ${errorText(error)}` }));
        hideLoadingLater(1200);
        return;
      }
    }
    await loadPhotos();
  }, [dispatch, hideLoadingLater, loadPhotos, readOnly]);

  // ── 搜索（120ms 去抖，与旧版一致）────────────────────────────────────────
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const next = searchValue.trim();
      if (next !== searchTerm) dispatch(setSearchTerm(next));
    }, 120);
    return () => window.clearTimeout(timer);
  }, [searchValue, searchTerm, dispatch]);

  // ── 彩绘提醒徽章：一次会话自动拉一遍，之后只在弹窗里手动刷 ──────────────────
  useEffect(() => {
    if (!liveryConfigured || liveryAttempted || liveryLoading) return;
    void refreshLiveryFeed(dispatch, { airport: liveryAirport, dayOffset: liveryDayOffset });
  }, [dispatch, liveryAirport, liveryDayOffset, liveryAttempted, liveryConfigured, liveryLoading]);

  // ── URL 同步 ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!routeReady) return;
    const url = new URL(window.location.href);
    const params = url.searchParams;

    writeStateParam(params, 'sort', currentSort, 'date-asc');
    writeStateParam(params, 'view', baseView, 'flat');
    writeStateParam(params, 'scale', timeScale, 'none');
    writeStateParam(params, 'q', searchTerm.trim(), '');
    params.delete('collapse');
    params.delete('open');
    params.delete('closed');

    const rendered = new Set(sectionKeys);
    const closed = sectionKeys.length
      ? collapsedSections.filter((key) => rendered.has(key))
      : collapsedSections;
    const open = sectionKeys.length
      ? expandedSections.filter((key) => rendered.has(key))
      : expandedSections;

    if (collapseAll) {
      params.set('collapse', '1');
      writeSetParam(params, 'open', open);
    } else {
      writeSetParam(params, 'closed', closed);
    }

    const viewerSp = viewerPhoto ? subpath(viewerPhoto) : null;
    const nextPath = viewerSp ? `/view/${encodePath(viewerSp)}` : '/';
    if (url.pathname !== nextPath) url.pathname = nextPath;

    const nextUrl = `${url.pathname}${params.toString() ? `?${params.toString()}` : ''}${url.hash}`;
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (nextUrl !== currentUrl) window.history.replaceState(null, '', nextUrl);
  }, [
    routeReady,
    currentSort,
    baseView,
    timeScale,
    searchTerm,
    collapseAll,
    collapsedSections,
    expandedSections,
    sectionKeys,
    viewerPhoto,
  ]);

  // ── F1 快捷键面板 ───────────────────────────────────────────────────────
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'F1') {
        event.preventDefault();
        setShortcutsOpen(true);
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  // ── 折叠 ────────────────────────────────────────────────────────────────
  const isCollapsed = useCallback(
    (key: string | null) => {
      if (!key) return false;
      return collapseAll ? !expandedSet.has(key) : collapsedSet.has(key);
    },
    [collapseAll, collapsedSet, expandedSet],
  );

  const toggleSection = (key: string) => {
    const collapsedKeys: string[] = [];
    const expandedKeys: string[] = [];
    sectionKeys.forEach((sectionKey) => {
      const collapsed = sectionKey === key ? !isCollapsed(sectionKey) : isCollapsed(sectionKey);
      (collapsed ? collapsedKeys : expandedKeys).push(sectionKey);
    });

    if (!expandedKeys.length) {
      dispatch(
        setCollapseState({
          collapseAll: true,
          collapsedSections: collapsedKeys,
          expandedSections: [],
        }),
      );
    } else if (collapseAll) {
      dispatch(
        setCollapseState({
          collapseAll: true,
          collapsedSections: collapsedKeys,
          expandedSections: expandedKeys,
        }),
      );
    } else {
      dispatch(
        setCollapseState({
          collapseAll: false,
          collapsedSections: collapsedKeys,
          expandedSections: [],
        }),
      );
    }
  };

  const toggleCollapseAll = () => {
    const next = !collapseAll;
    dispatch(
      setCollapseState({
        collapseAll: next,
        collapsedSections: next ? sectionKeys : [],
        expandedSections: [],
      }),
    );
  };

  // ── 选择 ────────────────────────────────────────────────────────────────
  const indexOfSp = (sp: string) =>
    filtered.findIndex((photo) => subpath(photo) === sp);

  const selectRange = (fromIndex: number, toIndex: number) => {
    if (!filtered.length) return;
    const from = Math.max(0, Math.min(fromIndex, toIndex));
    const to = Math.min(filtered.length - 1, Math.max(fromIndex, toIndex));
    const next = new Set(selected);
    for (let i = from; i <= to; i += 1) {
      const photo = filtered[i];
      if (photo) next.add(subpath(photo));
    }
    const endPhoto = filtered[toIndex];
    dispatch(setSelection({ selected: [...next], anchor: endPhoto ? subpath(endPhoto) : null }));
  };

  const toggleOne = (sp: string) => {
    const next = selected.includes(sp)
      ? selected.filter((item) => item !== sp)
      : [...selected, sp];
    dispatch(setSelection({ selected: next, anchor: sp }));
  };

  const handleToggleCheck = (index: number, shiftKey: boolean) => {
    const photo = filtered[index];
    if (!photo) return;
    const sp = subpath(photo);
    const anchorIndex = anchor ? indexOfSp(anchor) : -1;
    if (shiftKey && anchorIndex >= 0) {
      selectRange(anchorIndex, index);
      return;
    }
    toggleOne(sp);
  };

  const handleCardClick = (event: MouseEvent<HTMLDivElement>, entry: GalleryCardEntry) => {
    const index = entry.index;
    const photo = filtered[index];
    if (!photo) return;
    if (event.metaKey || event.ctrlKey) {
      toggleOne(subpath(photo));
      return;
    }
    if (event.shiftKey) {
      const anchorIndex = anchor ? indexOfSp(anchor) : -1;
      selectRange(anchorIndex < 0 ? index : anchorIndex, index);
      return;
    }
    setViewerSp(subpath(photo));
  };

  // ── 分批删除 ────────────────────────────────────────────────────────────
  const stageDelete = useCallback(
    async (sp: string) => {
      if (readOnly) {
        message.warning('当前为只读模式，管理操作已禁用');
        return false;
      }
      try {
        await StageApi.stage({ kind: 'delete', src: sp });
        await refreshStaged();
        return true;
      } catch (error) {
        message.error(`加入删除列表失败: ${errorText(error)}`);
        return false;
      }
    },
    [message, readOnly, refreshStaged],
  );

  const handleBulkDelete = async () => {
    if (readOnly) {
      message.warning('当前为只读模式，管理操作已禁用');
      return;
    }
    const targets = [...selected];
    if (!targets.length) {
      message.warning('请先选择要删除的照片');
      return;
    }
    for (const sp of targets) {
      await StageApi.stage({ kind: 'delete', src: sp }).catch(() => undefined);
    }
    dispatch(setSelection({ selected: [], anchor: null }));
    await refreshStaged();
    message.success('已加入分批（删除）');
  };

  const handleBulkMove = () => {
    if (readOnly) {
      message.warning('当前为只读模式，管理操作已禁用');
      return;
    }
    if (!selected.length) {
      message.warning('请先选择要移动的照片');
      return;
    }
    setBulkMoveOpen(true);
  };

  const openSetDir = async () => {
    let allowed = false;
    try {
      allowed = !!(await StageApi.allowSetDir()).allowed;
    } catch {
      allowed = false;
    }
    if (!allowed) {
      message.warning('服务器未启用运行时目录切换');
      return;
    }
    setSetDirOpen(true);
  };

  // ── 右键菜单 ────────────────────────────────────────────────────────────
  const handleContextMenu = (event: MouseEvent<HTMLDivElement>, entry: GalleryCardEntry) => {
    event.preventDefault();
    const sp = subpath(entry.photo);
    const bulk = selected.length > 1;

    if (!bulk) {
      dispatch(setSelection({ selected: [sp], anchor }));
    }

    const items: ContextMenuItem[] = [];
    if (bulk && selected.length === 2) {
      items.push({ kind: 'compare', label: '相似对比' });
    }
    if (!readOnly) {
      items.push({
        kind: 'delete',
        label: '删除',
        danger: true,
        separatorBefore: items.length > 0,
      });
      items.push({
        kind: bulk ? 'move' : 'rename',
        label: bulk ? '移动' : '重命名',
        separatorBefore: true,
      });
      if (!bulk) items.push({ kind: 'move', label: '移动' });
      items.push({ kind: 'copy', label: '复制' });
    }
    if (!items.length) {
      setMenu(CLOSED_MENU);
      return;
    }

    setMenu({
      open: true,
      x: Math.min(event.clientX, window.innerWidth - MENU_WIDTH - 8),
      y: Math.min(event.clientY, window.innerHeight - MENU_HEIGHT - 8),
      items,
      bulk,
      src: bulk ? null : sp,
      srcs: bulk ? [...selected] : [],
    });
  };

  const handleMenuSelect = async (kind: string) => {
    const { bulk, src, srcs } = menu;
    setMenu(CLOSED_MENU);

    if (bulk) {
      if (!srcs.length) return;
      if (kind === 'compare') setCompareOpen(true);
      else if (kind === 'delete') {
        for (const sp of srcs) await stageDelete(sp);
      } else if (kind === 'move') setBulkMoveOpen(true);
      else if (kind === 'copy') {
        message.info(`批量复制 (${srcs.length} 个文件)：请逐一处理`);
      }
      return;
    }

    if (!src) return;
    if (kind === 'delete') {
      await stageDelete(src);
      return;
    }
    setFileOp({ kind: kind as OpKind, src });
  };

  // 相册动辄上千张卡片，卡片用 memo 包了一层：回调必须保持引用稳定，
  // 否则每次勾选、查看器翻页都会把整页卡片重渲染一遍（实测单次 200ms 以上）。
  const interactionsRef = useRef({
    toggleSection,
    onCardClick: handleCardClick,
    onToggleCheck: handleToggleCheck,
    onContextMenu: handleContextMenu,
  });
  interactionsRef.current = {
    toggleSection,
    onCardClick: handleCardClick,
    onToggleCheck: handleToggleCheck,
    onContextMenu: handleContextMenu,
  };
  const stableToggleSection = useCallback(
    (key: string) => interactionsRef.current.toggleSection(key),
    [],
  );
  const stableCardClick = useCallback(
    (event: MouseEvent<HTMLDivElement>, entry: GalleryCardEntry) =>
      interactionsRef.current.onCardClick(event, entry),
    [],
  );
  const stableToggleCheck = useCallback(
    (index: number, shiftKey: boolean) => interactionsRef.current.onToggleCheck(index, shiftKey),
    [],
  );
  const stableContextMenu = useCallback(
    (event: MouseEvent<HTMLDivElement>, entry: GalleryCardEntry) =>
      interactionsRef.current.onContextMenu(event, entry),
    [],
  );

  // ── 统计文案 ────────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    if (!filtered.length) {
      return searchTerm ? '搜索：0 张' : '0 张照片';
    }
    const withExif = filtered.filter((photo) => hasAnyExif(photo.exif)).length;
    const viewLabel = baseView === 'folder' ? '按文件夹' : '全部';
    const scaleLabel = SCALE_LABEL[timeScale] ?? '无时间分组';
    const head = searchTerm
      ? `${filtered.length} / ${photos.length} 张  ·  ${withExif} 张含EXIF  ·  ${viewLabel} · ${scaleLabel}`
      : `${filtered.length} 张  ·  ${withExif} 张含EXIF  ·  ${viewLabel} · ${scaleLabel}`;
    return selected.length ? `${head}  ·  已选 ${selected.length} 张` : head;
  }, [filtered, photos.length, searchTerm, baseView, timeScale, selected.length]);

  const exifPhoto = exifSrc
    ? photos.find((photo) => subpath(photo) === exifSrc) ?? null
    : null;

  const anyModalOpen =
    stagedOpen ||
    trashOpen ||
    compareOpen ||
    liveryOpen ||
    shortcutsOpen ||
    bulkMoveOpen ||
    setDirOpen ||
    fileOp !== null ||
    exifSrc !== null;

  return (
    <>
      <div className="app-shell">
        <AppHeader
          stats={stats}
          searchValue={searchValue}
          collapseDisabled={!sectionKeys.length}
          collapseAll={collapseAll}
          onSearchChange={setSearchValue}
          onReload={() => void handleReload()}
          onToggleCollapse={toggleCollapseAll}
          onOpenStaged={() => setStagedOpen(true)}
          onOpenTrash={() => setTrashOpen(true)}
          onOpenCompare={() => setCompareOpen(true)}
          onOpenLivery={() => setLiveryOpen(true)}
          liveryCount={liveryCount}
          onOpenShortcuts={() => setShortcutsOpen(true)}
          onOpenSetDir={() => void openSetDir()}
          onBulkDelete={() => void handleBulkDelete()}
          onBulkMove={handleBulkMove}
          onSortChange={(value) => {
            dispatch(setSort(value));
            void loadPhotos(value);
          }}
        />
        <div id="content" style={{ display: filtered.length ? 'block' : 'none' }}>
          {sections.map((section) => (
            <GallerySection
              key={section.key || '__flat__'}
              section={section}
              numbering={numbering}
              isCollapsed={isCollapsed}
              selected={selectedSet}
              staged={staged}
              onToggleSection={stableToggleSection}
              onCardClick={stableCardClick}
              onToggleCheck={stableToggleCheck}
              onContextMenu={stableContextMenu}
            />
          ))}
        </div>
        <EmptyState visible={!filtered.length} />
      </div>

      <Viewer
        open={!!viewerPhoto}
        photos={filtered}
        index={viewerPhoto ? safeViewerIndex : null}
        keysDisabled={anyModalOpen}
        onClose={() => setViewerSp(null)}
        onNavigate={(next) => {
          const photo = filtered[next];
          if (photo) setViewerSp(subpath(photo));
        }}
        onOpenFileOp={(kind, src) => setFileOp({ kind, src })}
        onOpenExifEdit={setExifSrc}
      />

      <CardContextMenu
        open={menu.open}
        x={menu.x}
        y={menu.y}
        items={menu.items}
        onSelect={(kind) => void handleMenuSelect(kind)}
        onClose={() => setMenu(CLOSED_MENU)}
      />

      <FileOpModal
        open={!!fileOp}
        kind={fileOp?.kind ?? null}
        src={fileOp?.src ?? null}
        photos={photos}
        staged={staged}
        onClose={() => setFileOp(null)}
        onStaged={() => void refreshStaged()}
      />

      <ExifEditModal
        open={!!exifSrc}
        src={exifSrc}
        photo={exifPhoto}
        onClose={() => setExifSrc(null)}
        onStaged={() => void refreshStaged()}
      />

      <BulkMoveModal
        open={bulkMoveOpen}
        photos={photos}
        selected={selected}
        onClose={() => setBulkMoveOpen(false)}
        onStaged={() => void refreshStaged()}
      />

      <StagedModal
        open={stagedOpen}
        onClose={() => setStagedOpen(false)}
        onReloadPhotos={() => void loadPhotos()}
      />

      <TrashModal open={trashOpen} onClose={() => setTrashOpen(false)} />

      <CompareModal
        open={compareOpen}
        photos={photos}
        selected={selected}
        onClose={() => setCompareOpen(false)}
      />

      <LiveryModal
        open={liveryOpen}
        onClose={() => setLiveryOpen(false)}
        onSearchRegistration={(registration) => setSearchValue(registration)}
      />

      <ShortcutsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />

      <SetDirModal
        open={setDirOpen}
        onClose={() => setSetDirOpen(false)}
        onChanged={() => void loadPhotos()}
      />
    </>
  );
}
