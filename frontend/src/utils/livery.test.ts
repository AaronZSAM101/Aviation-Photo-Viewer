import { describe, expect, it } from 'vitest';
import type { LiveryAlert, WatchItem } from '../types';
import {
  alertKey,
  categoryCounts,
  dayValue,
  filterAlerts,
  formatFlightTime,
  formatRetrievedAt,
  isWatched,
  watchKey,
} from './livery';

const alert = (overrides: Partial<LiveryAlert>): LiveryAlert => ({
  flightNumber: 'NH0958',
  registration: 'B-52DX',
  model: 'B38M',
  airline: '全日空',
  origin: 'HND',
  destination: 'SHA',
  direction: 'arrival',
  scheduledAt: '2026-10-27T09:05:00+08:00',
  status: '计划',
  source: 'Jetmark',
  name: '彩绘机',
  category: '彩绘',
  providerTarget: null,
  ...overrides,
});

describe('dayValue', () => {
  // 同一瞬间，上海已经跨到 28 号，洛杉矶还在 27 号：排班按机场的「今天」算
  const at = new Date('2026-10-27T16:30:00Z');

  it('uses the airport timezone rather than the machine clock', () => {
    expect(dayValue('SHA', 0, at)).toBe('2026-10-28');
    expect(dayValue('LAX', 0, at)).toBe('2026-10-27');
  });

  it('steps to the airport next day', () => {
    expect(dayValue('SHA', 1, at)).toBe('2026-10-29');
    expect(dayValue('LAX', 1, at)).toBe('2026-10-28');
  });

  it('falls back to UTC for a code nobody declared', () => {
    expect(dayValue('XXX', 0, at)).toBe('2026-10-27');
  });
});

describe('formatFlightTime', () => {
  it('renders the schedule in the airport timezone', () => {
    expect(formatFlightTime('2026-10-27T09:05:00+08:00', 'Asia/Tokyo')).toBe('10:05');
    expect(formatFlightTime('2026-10-27T09:05:00+08:00', 'Asia/Shanghai')).toBe('09:05');
  });

  it('says nothing instead of inventing a time', () => {
    expect(formatFlightTime(null, 'Asia/Shanghai')).toBe('—');
    expect(formatFlightTime('not a timestamp', 'Asia/Shanghai')).toBe('not a timestamp');
  });
});

describe('alertKey', () => {
  it('separates the arrival and departure of the same flight number', () => {
    expect(alertKey(alert({ direction: 'arrival' }))).not.toBe(alertKey(alert({ direction: 'departure' })));
  });

  it('separates the same airframe with and without a published time', () => {
    expect(alertKey(alert({ scheduledAt: null }))).not.toBe(alertKey(alert({})));
  });
});

describe('categoryCounts', () => {
  const alerts = [
    alert({}),
    alert({ registration: 'B-2001', category: '特色机型' }),
    alert({ registration: 'B-2002', category: '待核对' }),
  ];

  it('keeps the fixed order and drops empty categories', () => {
    expect(categoryCounts(alerts)).toEqual([
      { category: '彩绘', count: 1 },
      { category: '待核对', count: 1 },
      { category: '特色机型', count: 1 },
    ]);
  });

  it('returns nothing when there is nothing worth shooting', () => {
    expect(categoryCounts([])).toEqual([]);
  });
});

describe('filterAlerts', () => {
  const alerts = [alert({}), alert({ registration: 'B-2001', category: '我的关注' })];

  it('passes everything through for the all chip', () => {
    expect(filterAlerts(alerts, 'all')).toHaveLength(2);
  });

  it('keeps only the chosen category', () => {
    expect(filterAlerts(alerts, '我的关注').map((item) => item.registration)).toEqual(['B-2001']);
  });
});

describe('watch matching', () => {
  const watchlist: WatchItem[] = [{ registration: 'B52DX', name: '红色那台', note: '', documented: true }];

  it('ignores dashes and case', () => {
    expect(watchKey('b-52dx')).toBe('B52DX');
    expect(isWatched(watchlist, 'B-52DX')).toBe(true);
    expect(isWatched(watchlist, 'b52dx')).toBe(true);
  });

  it('never claims an unpublished registration is watched', () => {
    expect(isWatched(watchlist, null)).toBe(false);
    expect(isWatched(watchlist, 'B-1391')).toBe(false);
  });
});

describe('formatRetrievedAt', () => {
  it('admits it has no data yet', () => {
    expect(formatRetrievedAt(0)).toBe('还没拉到数据');
  });

  it('prints the fetch minute instead of a bare epoch', () => {
    expect(formatRetrievedAt(1_761_000_000)).toMatch(/\d{2}:\d{2}/);
  });
});
