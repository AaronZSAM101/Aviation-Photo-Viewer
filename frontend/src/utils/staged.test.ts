import { describe, expect, it } from 'vitest';
import type { OpKind, StagedOp } from '../types';
import { STAGED_KIND_LABEL, moveBadgeLabel, renameBadgeLabel, stagedSets } from './staged';

function op(over: Partial<StagedOp> & { kind: OpKind; src: string }): StagedOp {
  return { id: over.src, ...over };
}

describe('stagedSets', () => {
  const sets = stagedSets([
    op({ kind: 'delete', src: 'a/1.jpg' }),
    op({ kind: 'rename', src: 'a/2.jpg', dst: 'a/two.jpg' }),
    op({ kind: 'move', src: 'a/3.jpg', dst: 'b/3.jpg' }),
    op({ kind: 'exif', src: 'a/4.jpg', exif: { date_taken: '2024:01:01 00:00:00' } as never }),
    op({ kind: 'copy', src: 'a/5.jpg', dst: 'b/5.jpg' }),
    op({ kind: 'restore', src: 'trash/6.jpg', dst: 'a/6.jpg' }),
  ]);

  it('indexes sources per kind', () => {
    expect([...sets.deletes]).toEqual(['a/1.jpg']);
    expect([...sets.renameSrcs]).toEqual(['a/2.jpg']);
    expect([...sets.moveSrcs]).toEqual(['a/3.jpg']);
    expect([...sets.exifSrcs]).toEqual(['a/4.jpg']);
  });

  it('maps sources to destinations for the two rename/move badges', () => {
    expect(sets.renameMap.get('a/2.jpg')).toBe('a/two.jpg');
    expect(sets.moveMap.get('a/3.jpg')).toBe('b/3.jpg');
    expect(sets.renameMap.has('a/3.jpg')).toBe(false);
  });

  it('collects every destination so a target is never overwritten blindly', () => {
    expect([...sets.targets].sort()).toEqual(['a/6.jpg', 'a/two.jpg', 'b/3.jpg', 'b/5.jpg']);
  });

  it('returns empty containers for an empty queue', () => {
    const empty = stagedSets([]);
    expect(empty.deletes.size).toBe(0);
    expect(empty.targets.size).toBe(0);
    expect(empty.renameMap.size).toBe(0);
  });
});

describe('badge labels', () => {
  it('fall back to the generic wording when an op carries no destination', () => {
    const sets = stagedSets([op({ kind: 'rename', src: 'a/1.jpg', dst: null }), op({ kind: 'move', src: 'a/2.jpg' })]);
    expect(renameBadgeLabel('a/1.jpg', sets)).toBe('待重命名');
    expect(moveBadgeLabel('a/2.jpg', sets)).toBe('待移动');
  });

  it('show only the file names for a rename', () => {
    const sets = stagedSets([op({ kind: 'rename', src: 'Queued/B 7378.jpg', dst: 'Queued/CZ-B7378.jpg' })]);
    expect(renameBadgeLabel('Queued/B 7378.jpg', sets)).toBe('B 7378.jpg → CZ-B7378.jpg');
  });

  it('show the destination folder for a move', () => {
    const toFolder = stagedSets([op({ kind: 'move', src: 'a/1.jpg', dst: 'Personal Gallery/2024/1.jpg' })]);
    expect(moveBadgeLabel('a/1.jpg', toFolder)).toBe('移至 Personal Gallery/2024');
  });

  it('call out a move back to the library root', () => {
    const toRoot = stagedSets([op({ kind: 'move', src: 'a/1.jpg', dst: '1.jpg' })]);
    expect(moveBadgeLabel('a/1.jpg', toRoot)).toBe('移至 (根目录)');
  });

  it('leave an unknown source untouched', () => {
    const sets = stagedSets([]);
    expect(renameBadgeLabel('a/1.jpg', sets)).toBe('待重命名');
    expect(moveBadgeLabel('a/1.jpg', sets)).toBe('待移动');
  });
});

describe('STAGED_KIND_LABEL', () => {
  it('covers every operation kind the backend can stage', () => {
    const kinds: OpKind[] = ['delete', 'move', 'copy', 'rename', 'restore', 'exif'];
    for (const kind of kinds) {
      expect(STAGED_KIND_LABEL[kind]).toBeTruthy();
    }
  });
});
