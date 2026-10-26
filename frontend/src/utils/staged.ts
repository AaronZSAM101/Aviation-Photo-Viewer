import type { StagedOp } from '../types';
import { splitSubpath } from './paths';

export interface StagedSets {
  deletes: Set<string>;
  renameSrcs: Set<string>;
  moveSrcs: Set<string>;
  exifSrcs: Set<string>;
  renameMap: Map<string, string>;
  moveMap: Map<string, string>;
  targets: Set<string>;
}

export function stagedSets(ops: StagedOp[]): StagedSets {
  const sets: StagedSets = {
    deletes: new Set(),
    renameSrcs: new Set(),
    moveSrcs: new Set(),
    exifSrcs: new Set(),
    renameMap: new Map(),
    moveMap: new Map(),
    targets: new Set(),
  };
  ops.forEach((op) => {
    if (op.kind === 'delete') sets.deletes.add(op.src);
    if (op.kind === 'rename') {
      sets.renameSrcs.add(op.src);
      if (op.dst) sets.renameMap.set(op.src, op.dst);
    }
    if (op.kind === 'move') {
      sets.moveSrcs.add(op.src);
      if (op.dst) sets.moveMap.set(op.src, op.dst);
    }
    if (op.kind === 'exif') sets.exifSrcs.add(op.src);
    if (op.dst) sets.targets.add(op.dst);
  });
  return sets;
}

export function renameBadgeLabel(sp: string, sets: StagedSets): string {
  const dst = sets.renameMap.get(sp);
  if (!dst) return '待重命名';
  const srcName = splitSubpath(sp).name || sp;
  const dstName = splitSubpath(dst).name || dst;
  return `${srcName} → ${dstName}`;
}

export function moveBadgeLabel(sp: string, sets: StagedSets): string {
  const dst = sets.moveMap.get(sp);
  if (!dst) return '待移动';
  const dstFolder = splitSubpath(dst).folder || '(根目录)';
  return `移至 ${dstFolder}`;
}

export const STAGED_KIND_LABEL: Record<string, string> = {
  delete: '删除',
  move: '移动',
  copy: '复制',
  rename: '重命名',
  restore: '恢复',
  exif: 'EXIF',
};
