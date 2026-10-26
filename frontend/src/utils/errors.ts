import axios from 'axios';
import type { StageConflict } from '../types';

export function errorText(error: unknown, fallback = '操作失败'): string {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data;
    if (typeof data === 'string' && data.trim()) return data;
    if (data && typeof data === 'object') {
      const payload = data as { message?: unknown; error?: unknown };
      const text = payload.message ?? payload.error;
      if (typeof text === 'string' && text.trim()) return text;
    }
    return error.message || fallback;
  }
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

// 分批应用被拒绝时后端返回的冲突清单（源路径 + 目标路径）
export function stageConflicts(error: unknown): StageConflict[] {
  if (!axios.isAxiosError(error)) return [];
  const data = error.response?.data as { conflicts?: unknown } | undefined;
  if (!data || !Array.isArray(data.conflicts)) return [];
  return data.conflicts.filter(
    (item): item is StageConflict =>
      !!item && typeof item === 'object' && typeof (item as StageConflict).src === 'string',
  );
}
