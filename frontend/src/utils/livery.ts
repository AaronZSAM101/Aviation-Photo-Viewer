import type { LiveryAlert } from '../types';

export interface AirportOption {
  code: string;
  city: string;
  name: string;
  tz: string;
}

/**
 * 机场清单抄自 AIRFRAME 的 `data.ts`：排班数据源只认这几个三字码，
 * 而且每个机场的「今天」要按它自己的时区算，不是本机时区。
 */
export const LIVERY_AIRPORTS: AirportOption[] = [
  { code: 'PVG', city: '上海', name: '浦东国际机场', tz: 'Asia/Shanghai' },
  { code: 'PEK', city: '北京', name: '首都国际机场', tz: 'Asia/Shanghai' },
  { code: 'CAN', city: '广州', name: '白云国际机场', tz: 'Asia/Shanghai' },
  { code: 'SZX', city: '深圳', name: '宝安国际机场', tz: 'Asia/Shanghai' },
  { code: 'TFU', city: '成都', name: '天府国际机场', tz: 'Asia/Shanghai' },
  { code: 'HGH', city: '杭州', name: '萧山国际机场', tz: 'Asia/Shanghai' },
  { code: 'PKX', city: '北京', name: '大兴国际机场', tz: 'Asia/Shanghai' },
  { code: 'SHA', city: '上海', name: '虹桥国际机场', tz: 'Asia/Shanghai' },
  { code: 'HKG', city: '香港', name: '香港国际机场', tz: 'Asia/Hong_Kong' },
  { code: 'NRT', city: '东京', name: '成田国际机场', tz: 'Asia/Tokyo' },
  { code: 'SIN', city: '新加坡', name: '樟宜国际机场', tz: 'Asia/Singapore' },
  { code: 'LHR', city: '伦敦', name: '希思罗机场', tz: 'Europe/London' },
  { code: 'FRA', city: '法兰克福', name: '法兰克福机场', tz: 'Europe/Berlin' },
  { code: 'AMS', city: '阿姆斯特丹', name: '史基浦机场', tz: 'Europe/Amsterdam' },
  { code: 'LAX', city: '洛杉矶', name: '洛杉矶国际机场', tz: 'America/Los_Angeles' },
  { code: 'JFK', city: '纽约', name: '肯尼迪国际机场', tz: 'America/New_York' },
];

export function airportOf(code: string): AirportOption | null {
  return LIVERY_AIRPORTS.find((a) => a.code === code.toUpperCase()) ?? null;
}

export function airportTz(code: string): string {
  return airportOf(code)?.tz ?? 'UTC';
}

/** 按机场当地时区算的 YYYY-MM-DD */
export function isoDayIn(tz: string, at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/** 只给今天和明天：排班数据源也只放这两天 */
export function dayOptions(tz: string, at: Date = new Date()): { value: string; label: string }[] {
  const today = isoDayIn(tz, at);
  const tomorrow = isoDayIn(tz, new Date(at.getTime() + 86_400_000));
  return [
    { value: today, label: '今天' },
    { value: tomorrow, label: '明天' },
  ];
}

/** 顶栏徽章/提醒列表按「今天/明天」偏移取真实日期，仍按机场自己的时区算 */
export function dayValue(airport: string, offset: number, at: Date = new Date()): string {
  return isoDayIn(airportTz(airport), new Date(at.getTime() + offset * 86_400_000));
}

/** 提醒列表里显示的到/离港时间，一律换算到机场当地时区 */
export function formatFlightTime(iso: string | null, tz: string): string {
  if (!iso) return '—';
  const stamp = Date.parse(iso);
  if (!Number.isFinite(stamp)) return iso;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(stamp));
}

export function alertLabel(alert: LiveryAlert): string {
  return alert.direction === 'arrival' ? '落地' : '起飞';
}

const CATEGORY_COLORS: Record<string, string> = {
  彩绘: '#5ca8bd',
  待核对: '#c8a24a',
  特色机型: '#7f9fd6',
  我的关注: '#8fbf8f',
  拍摄推荐: '#9aa0a6',
};

export function categoryColor(category: string): string {
  return CATEGORY_COLORS[category] ?? 'var(--muted)';
}

/** 关注表里判断「这台已经记过了」用的键：横杠写不写都算同一台 */
export function watchKey(registration: string): string {
  return registration.replace(/-/g, '').toUpperCase();
}

export function isWatched(watchlist: { registration: string }[], registration: string | null): boolean {
  if (!registration) return false;
  const key = watchKey(registration);
  return watchlist.some((item) => watchKey(item.registration) === key);
}

/** 后端分类的固定顺序，也是筛选条的顺序 */
export const LIVERY_CATEGORIES = ['彩绘', '待核对', '特色机型', '我的关注', '拍摄推荐', '其他航班'];

/** 一行的 React key：同一班可能既进港又离港，光航班号不够 */
export function alertKey(alert: LiveryAlert): string {
  return [alert.flightNumber, alert.registration ?? '', alert.direction, alert.scheduledAt ?? ''].join('|');
}

export function categoryCounts(alerts: LiveryAlert[]): { category: string; count: number }[] {
  return LIVERY_CATEGORIES.map((category) => ({
    category,
    count: alerts.filter((alert) => alert.category === category).length,
  })).filter((entry) => entry.count > 0);
}

export function filterAlerts(alerts: LiveryAlert[], category: string): LiveryAlert[] {
  if (category === 'all') return alerts;
  return alerts.filter((alert) => alert.category === category);
}

/** 这份提醒是什么时候抓的：按本机时区显示，看的是「我什么时候拿到的」，不是航班时刻 */
export function formatRetrievedAt(secs: number): string {
  if (!secs) return '还没拉到数据';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(secs * 1000));
}
