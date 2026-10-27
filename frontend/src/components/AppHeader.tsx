import { Fragment, useEffect, useState } from 'react';
import { Button, Dropdown, Input, Select } from 'antd';
import type { MenuProps } from 'antd';
import { useAppDispatch, useAppSelector } from '../store';
import { cycleThemeMode, setBaseView, setSort, setTimeScale } from '../store/appSlice';
import type { BaseView, SortKey, ThemeMode, TimeScale } from '../types';

const SORT_OPTIONS = [
  { value: 'date-asc', label: '拍摄日期 ↑ 旧→新' },
  { value: 'date-desc', label: '拍摄日期 ↓ 新→旧' },
  { value: 'name-asc', label: '文件名 A→Z' },
  { value: 'name-desc', label: '文件名 Z→A' },
  { value: 'size-desc', label: '大小 大→小' },
];

const VIEW_OPTIONS = [
  { value: 'flat', label: '全部' },
  { value: 'folder', label: '按文件夹' },
];

const SCALE_OPTIONS = [
  { value: 'none', label: '无' },
  { value: 'year', label: '按年' },
  { value: 'month', label: '按月' },
  { value: 'day', label: '按日' },
];

const MOBILE_QUERY = '(max-width: 900px)';

const THEME_ICON: Record<ThemeMode, string> = { auto: '◐', light: '☀', dark: '☾' };const THEME_LABEL: Record<ThemeMode, string> = { auto: '自动', light: '亮色', dark: '暗色' };
const THEME_ORDER: ThemeMode[] = ['auto', 'light', 'dark'];

interface AppHeaderProps {
  stats: string;
  searchValue: string;
  collapseDisabled: boolean;
  collapseAll: boolean;
  onSearchChange: (value: string) => void;
  onReload: () => void;
  onToggleCollapse: () => void;
  onOpenStaged: () => void;
  onOpenTrash: () => void;
  onOpenCompare: () => void;
  onOpenLivery: () => void;
  liveryCount: number;
  onOpenShortcuts: () => void;
  onOpenSetDir: () => void;
  onBulkDelete: () => void;
  onBulkMove: () => void;
  onSortChange: (sort: SortKey) => void;
}

export function AppHeader({
  stats,
  searchValue,
  collapseDisabled,
  collapseAll,
  onSearchChange,
  onReload,
  onToggleCollapse,
  onOpenStaged,
  onOpenTrash,
  onOpenCompare,
  onOpenLivery,
  liveryCount,
  onOpenShortcuts,
  onOpenSetDir,
  onBulkDelete,
  onBulkMove,
  onSortChange,
}: AppHeaderProps) {
  const dispatch = useAppDispatch();
  const readOnly = useAppSelector((state) => state.app.readOnly);
  const version = useAppSelector((state) => state.app.version);
  const versionSource = useAppSelector((state) => state.app.versionSource);
  const themeMode = useAppSelector((state) => state.app.themeMode);
  const currentSort = useAppSelector((state) => state.app.currentSort);
  const baseView = useAppSelector((state) => state.app.baseView);
  const timeScale = useAppSelector((state) => state.app.timeScale);
  const stagedCount = useAppSelector((state) => state.photos.stagedOps.length);

  const versionTitle = version
    ? `${versionSource === 'ghcr' ? 'GHCR' : '本地'} 版本：${version}`
    : '当前版本未知';
  const nextTheme = THEME_ORDER[(THEME_ORDER.indexOf(themeMode) + 1) % THEME_ORDER.length];
  const themeTitle = `当前：${THEME_LABEL[themeMode]}（点击切到 ${THEME_LABEL[nextTheme]}）`;

  // 管理/工具入口：桌面端渲染成顶栏按钮，手机端收进「更多」菜单，两处共用同一份标签
  const actions: {
    key: string;
    label: string;
    title?: string;
    manageOnly?: boolean;
    run: () => void;
  }[] = [
    { key: 'bulk-move', label: '📁 批量移动', manageOnly: true, run: onBulkMove },
    { key: 'bulk-delete', label: '🗑️ 批量删除', manageOnly: true, run: onBulkDelete },
    {
      key: 'staged',
      label: `📄 分批列表${stagedCount ? ` (${stagedCount})` : ''}`,
      manageOnly: true,
      run: onOpenStaged,
    },
    { key: 'trash', label: '♻️ 回收站', manageOnly: true, run: onOpenTrash },
    { key: 'compare', label: '◎ 相似对比', run: onOpenCompare },
    {
      key: 'livery',
      label: `🎨 彩绘提醒${liveryCount ? ` (${liveryCount})` : ''}`,
      title: '读他家机场的排班，提醒今天有哪些值得拍的机号',
      run: onOpenLivery,
    },
    { key: 'set-dir', label: '⚙️ 目录', title: '切换照片目录', manageOnly: true, run: onOpenSetDir },
    { key: 'shortcuts', label: '⌨ 快捷键', run: onOpenShortcuts },
  ];
  const visibleActions = actions.filter((action) => !action.manageOnly || !readOnly);

  const [compact, setCompact] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches,
  );
  useEffect(() => {
    const query = window.matchMedia(MOBILE_QUERY);
    const onChange = (event: MediaQueryListEvent) => setCompact(event.matches);
    query.addEventListener('change', onChange);
    setCompact(query.matches);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const filters = (
    <>
      <span className="lbl">显示</span>
      <Select
        size="small"
        className="toolbar-select"
        title="显示"
        value={baseView}
        options={VIEW_OPTIONS}
        onChange={(value: BaseView) => dispatch(setBaseView(value))}
      />
      <span className="lbl">时间尺度</span>
      <Select
        size="small"
        className="toolbar-select"
        title="时间尺度"
        value={timeScale}
        options={SCALE_OPTIONS}
        onChange={(value: TimeScale) => dispatch(setTimeScale(value))}
      />
      <span className="lbl">排序</span>
      <Select
        size="small"
        className="toolbar-select-wide"
        title="排序"
        value={currentSort}
        options={SORT_OPTIONS}
        onChange={(value: SortKey) => {
          dispatch(setSort(value));
          onSortChange(value);
        }}
      />
    </>
  );

  if (compact) {
    const menuItems: MenuProps['items'] = [
      {
        key: 'collapse',
        label: collapseAll ? '展开全部' : '折叠全部',
        disabled: collapseDisabled,
        onClick: onToggleCollapse,
      },
      { type: 'divider' },
      ...visibleActions.map((action) => ({
        key: action.key,
        label: action.label,
        onClick: action.run,
      })),
      { type: 'divider' },
      { key: 'version', label: version || '版本未知', disabled: true, title: versionTitle },
    ];
    return (
      <header className="app-header app-header-compact">
        <div className="brand">
          <div className="logo">📷 PHOTO VIEWER</div>
          <span className="stats">{stats}</span>
        </div>
        <div className="toolbar">
          <Button size="small" onClick={onReload}>↺ 刷新</Button>
          <Input
            size="small"
            allowClear
            className="toolbar-search"
            placeholder="搜索照片..."
            value={searchValue}
            onChange={(event) => onSearchChange(event.target.value)}
          />
          <Button size="small" onClick={() => dispatch(cycleThemeMode())} title={themeTitle} aria-label={`主题：${THEME_LABEL[themeMode]}`}>
            {THEME_ICON[themeMode]}
          </Button>
          <Dropdown menu={{ items: menuItems }} trigger={['click']} placement="bottomRight">
            <Button size="small" className="toolbar-more">⋯ 更多</Button>
          </Dropdown>
        </div>
        <div className="toolbar toolbar-filters">{filters}</div>
      </header>
    );
  }

  return (
    <header className="app-header">
      <div className="brand">
        <div className="logo">📷 PHOTO VIEWER</div>
        <div className="app-version" title={versionTitle}>
          {version || '版本未知'}
        </div>
      </div>
      <div className="toolbar">
        <Button size="small" onClick={onReload}>↺ 刷新</Button>
        <Input
          size="small"
          allowClear
          className="toolbar-search"
          placeholder="搜索照片..."
          value={searchValue}
          onChange={(event) => onSearchChange(event.target.value)}
        />
        <Button size="small" disabled={collapseDisabled} onClick={onToggleCollapse}>
          {collapseAll ? '展开全部' : '折叠全部'}
        </Button>

        <div className="sep" />
        {filters}

        <div className="sep" />
        {visibleActions.map((action) => (
          <Fragment key={action.key}>
            {action.key === 'compare' && <div className="sep" />}
            <Button size="small" title={action.title} onClick={action.run}>
              {action.label}
            </Button>
          </Fragment>
        ))}
        <Button
          size="small"
          onClick={() => dispatch(cycleThemeMode())}
          title={themeTitle}
          aria-label={`主题：${THEME_LABEL[themeMode]}`}
        >
          {THEME_ICON[themeMode]}
        </Button>

        <span className="stats">{stats}</span>
      </div>
    </header>
  );
}
