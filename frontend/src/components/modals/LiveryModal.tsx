import { useCallback, useEffect, useMemo, useState } from 'react';
import { App as AntdApp, Button, Checkbox, Input, Modal, Select } from 'antd';
import { LiveryApi } from '../../api/livery';
import { useAppDispatch, useAppSelector } from '../../store';
import {
  dropWatch,
  putWatch,
  refreshLiveryFeed,
  refreshWatchlist,
  setAirport,
  setDayOffset,
} from '../../store/liverySlice';
import type { LiveryAlert, WatchItem } from '../../types';
import { errorText } from '../../utils/errors';
import {
  alertKey,
  alertLabel,
  airportTz,
  categoryColor,
  categoryCounts,
  dayValue,
  filterAlerts,
  formatFlightTime,
  formatRetrievedAt,
  isWatched,
  LIVERY_AIRPORTS,
  watchKey,
} from '../../utils/livery';

interface LiveryModalProps {
  open: boolean;
  onClose: () => void;
  /** 提醒里的机号跳到相册搜索：走的是顶栏那个搜索框，所以关掉弹窗才有效果 */
  onSearchRegistration: (registration: string) => void;
}

interface WatchForm {
  registration: string;
  name: string;
  note: string;
  documented: boolean;
}

const EMPTY_FORM: WatchForm = { registration: '', name: '', note: '', documented: true };

const DAY_OPTIONS = [
  { value: 0, label: '今天' },
  { value: 1, label: '明天' },
];

function toForm(item: WatchItem): WatchForm {
  return {
    registration: item.registration,
    name: item.name,
    note: item.note ?? '',
    documented: item.documented,
  };
}

/** 数据源状态的文案：读不到就说读不到，别把上一份缓存装作是今天的 */
function feedTone(state: string | undefined): 'ok' | 'warn' | 'error' {
  if (!state) return 'warn';
  if (state === 'ok') return 'ok';
  if (state === 'error' || state === 'unconfigured') return 'error';
  return 'warn';
}

export function LiveryModal({ open, onClose, onSearchRegistration }: LiveryModalProps) {
  const { message } = AntdApp.useApp();
  const dispatch = useAppDispatch();
  const readOnly = useAppSelector((state) => state.app.readOnly);
  const configured = useAppSelector((state) => state.app.liveryConfigured);
  const { airport, dayOffset, watchlist, feed, loading, error } = useAppSelector((state) => state.livery);
  const [category, setCategory] = useState('all');
  const [form, setForm] = useState<WatchForm>(EMPTY_FORM);
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const tz = airportTz(airport);

  const loadFeed = useCallback(
    (refresh: boolean) =>
      configured ? refreshLiveryFeed(dispatch, { airport, dayOffset, refresh }) : Promise.resolve(),
    [airport, configured, dayOffset, dispatch],
  );

  useEffect(() => {
    if (!open) return;
    void refreshWatchlist(dispatch);
    void loadFeed(false);
  }, [open, dispatch, loadFeed]);

  const alerts = feed?.alerts ?? [];
  const counts = useMemo(() => categoryCounts(alerts), [alerts]);
  const visible = useMemo(() => filterAlerts(alerts, category), [alerts, category]);

  const jumpToAlbum = (registration: string | null) => {
    if (!registration) {
      message.info('这班还没公布机号，等机号出来再搜');
      return;
    }
    onSearchRegistration(registration);
    onClose();
  };

  const startAdd = () => {
    setEditing('__new__');
    setForm(EMPTY_FORM);
  };

  const startEdit = (item: WatchItem) => {
    setEditing(watchKey(item.registration));
    setForm(toForm(item));
  };

  const saveWatch = async () => {
    if (readOnly) {
      message.warning('当前为只读模式，管理操作已禁用');
      return;
    }
    const registration = form.registration.trim();
    if (!registration) {
      message.warning('机号得写，例如「B-5487」');
      return;
    }
    if (!form.name.trim()) {
      message.warning('给这台机起个名字，不然提醒里认不出');
      return;
    }
    setSaving(true);
    try {
      const saved = await LiveryApi.watch({
        registration,
        name: form.name.trim(),
        note: form.note.trim(),
        documented: form.documented,
      });
      // 后端会把机号规整成它自己的键，用返回的那个，本地才不会跟服务端分成两条
      dispatch(
        putWatch({
          registration: saved.registration,
          name: form.name.trim(),
          note: form.note.trim(),
          documented: form.documented,
        }),
      );
      setEditing(null);
      setForm(EMPTY_FORM);
      message.success(`已记住 ${saved.registration}`);
      // 分类是后端算的：关注表变了要重算一次，否则列表里还是老样子
      void loadFeed(true);
    } catch (requestError) {
      message.error(`保存失败：${errorText(requestError)}`);
    } finally {
      setSaving(false);
    }
  };

  const removeWatch = async (item: WatchItem) => {
    if (readOnly) {
      message.warning('当前为只读模式，管理操作已禁用');
      return;
    }
    try {
      await LiveryApi.unwatch(item.registration);
      dispatch(dropWatch(item.registration));
      if (editing === watchKey(item.registration)) {
        setEditing(null);
        setForm(EMPTY_FORM);
      }
      void loadFeed(true);
    } catch (requestError) {
      message.error(`删除失败：${errorText(requestError)}`);
    }
  };

  const statusText = error
    ? error
    : feed?.message ||
      (configured ? '还没拉到数据，按「刷新」试一次' : '没配排班数据源：容器的 AIRFRAME_URL / LIVERY_FEED_URL 空着');
  const tone = error ? 'error' : feedTone(feed?.state);

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title="彩绘提醒"
      width={860}
      className="livery-modal"
      footer={<Button onClick={onClose}>关闭</Button>}
      destroyOnHidden
    >
      <div className="livery-controls">
        <Select
          size="small"
          className="livery-airport"
          value={airport}
          onChange={(value: string) => dispatch(setAirport(value))}
          options={LIVERY_AIRPORTS.map((option) => ({
            value: option.code,
            label: `${option.city} · ${option.name} ${option.code}`,
          }))}
        />
        <Select
          size="small"
          className="livery-day"
          value={dayOffset}
          onChange={(value: number) => dispatch(setDayOffset(value))}
          options={DAY_OPTIONS.map((option) => ({
            value: option.value,
            label: `${option.label} · ${dayValue(airport, option.value).slice(5)}`,
          }))}
        />
        <Button size="small" loading={loading} disabled={!configured} onClick={() => void loadFeed(true)}>
          ↺ 刷新
        </Button>
        <span className="livery-source">{feed ? `抓于 ${formatRetrievedAt(feed.retrievedAt)}` : '数据源未加载'}</span>
      </div>

      <div className={`livery-status ${tone}`}>
        {statusText}
        {feed && feed.state === 'ok' ? ` · ${alerts.length} 个值得拍` : ''}
        {feed?.stale ? ' · 这是上一次留下的，不是最新' : ''}
      </div>

      {counts.length > 0 && (
        <div className="livery-chips">
          <button
            type="button"
            className={category === 'all' ? 'active' : ''}
            onClick={() => setCategory('all')}
          >
            全部 {alerts.length}
          </button>
          {counts.map((entry) => (
            <button
              type="button"
              key={entry.category}
              className={category === entry.category ? 'active' : ''}
              onClick={() => setCategory(entry.category)}
            >
              {entry.category} {entry.count}
            </button>
          ))}
        </div>
      )}

      <div className="livery-list">
        {loading && !feed ? (
          <p className="livery-empty">正在读他家的排班数据，慢的话是它在等接口……</p>
        ) : visible.length === 0 ? (
          <p className="livery-empty">
            {alerts.length ? '这个分类下今天没有目标' : '没有提醒：要么数据源没给航班，要么这些航班都不值得拍'}
          </p>
        ) : (
          visible.map((alert) => (
            <LiveryRow
              key={alertKey(alert)}
              alert={alert}
              tz={tz}
              watched={isWatched(watchlist, alert.registration)}
              onSearch={() => jumpToAlbum(alert.registration)}
              onWatch={() => {
                startAdd();
                setForm({
                  registration: alert.registration ?? '',
                  name: alert.name,
                  note: '',
                  documented: alert.category === '彩绘',
                });
              }}
            />
          ))
        )}
      </div>

      <div className="livery-watch">
        <div className="livery-watch-head">
          <span>我的关注（{watchlist.length}）</span>
          <Button size="small" onClick={startAdd} disabled={editing !== null}>
            ＋ 记一台
          </Button>
        </div>
        {editing !== null && (
          <div className="livery-watch-form">
            <Input
              size="small"
              placeholder="机号，例如 B-5487"
              value={form.registration}
              onChange={(event) => setForm({ ...form, registration: event.target.value })}
            />
            <Input
              size="small"
              placeholder="名字，例如「机队里的红色那台」"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
            <Input
              size="small"
              placeholder="备注，可留空"
              value={form.note}
              onChange={(event) => setForm({ ...form, note: event.target.value })}
            />
            <label className="livery-watch-check">
              <Checkbox
                checked={form.documented}
                onChange={(event) => setForm({ ...form, documented: event.target.checked })}
              />
              已核实它是彩绘机（提醒里直接算「彩绘」，不勾就算「我的关注」）
            </label>
            <div className="livery-watch-form-ops">
              <Button
                size="small"
                onClick={() => {
                  setEditing(null);
                  setForm(EMPTY_FORM);
                }}
              >
                取消
              </Button>
              <Button size="small" type="primary" loading={saving} onClick={() => void saveWatch()}>
                保存
              </Button>
            </div>
          </div>
        )}
        {watchlist.length === 0 ? (
          <p className="livery-empty">
            关注表是空的。记下机号后，只要它在排班里出现就会被提醒——数据源那边只说「这班由这台飞」，彩绘得自己认。
          </p>
        ) : (
          watchlist.map((item) => (
            <div className="livery-watch-row" key={item.registration}>
              <button type="button" className="livery-watch-reg" onClick={() => jumpToAlbum(item.registration)}>
                {item.registration}
              </button>
              <div className="livery-watch-name">
                <span>{item.name}</span>
                {item.note ? <em>{item.note}</em> : null}
              </div>
              <span className={`livery-tag ${item.documented ? 'painted' : ''}`}>
                {item.documented ? '彩绘' : '关注'}
              </span>
              <div className="livery-watch-ops">
                <Button size="small" onClick={() => startEdit(item)}>
                  改
                </Button>
                <Button size="small" danger disabled={readOnly} onClick={() => void removeWatch(item)}>
                  删
                </Button>
              </div>
            </div>
          ))
        )}
      </div>
    </Modal>
  );
}

interface LiveryRowProps {
  alert: LiveryAlert;
  tz: string;
  watched: boolean;
  onSearch: () => void;
  onWatch: () => void;
}

function LiveryRow({ alert, tz, watched, onSearch, onWatch }: LiveryRowProps) {
  return (
    <div className={`livery-row ${alert.status === '取消' ? 'cancelled' : ''}`}>
      <span className="livery-time">{formatFlightTime(alert.scheduledAt, tz)}</span>
      <span className={`livery-direction ${alert.direction}`}>{alertLabel(alert)}</span>
      <div className="livery-main">
        <div className="livery-name" title={alert.providerTarget ?? undefined}>
          {alert.name}
        </div>
        <div className="livery-sub">
          {alert.flightNumber} · {alert.origin}→{alert.destination} · {alert.model}
          {alert.airline ? ` · ${alert.airline}` : ''}
          {alert.status ? ` · ${alert.status}` : ''}
        </div>
      </div>
      <span className="livery-reg">{alert.registration ?? '机号待定'}</span>
      <span className="livery-tag" style={{ color: categoryColor(alert.category) }}>
        {alert.category}
      </span>
      <div className="livery-ops">
        <Button size="small" onClick={onSearch}>
          搜相册
        </Button>
        <Button size="small" disabled={watched || !alert.registration} onClick={onWatch}>
          {watched ? '已关注' : '关注'}
        </Button>
      </div>
    </div>
  );
}
