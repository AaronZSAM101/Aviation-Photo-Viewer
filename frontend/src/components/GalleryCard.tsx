import { memo, useEffect, useRef, useState, type MouseEvent } from 'react';
import type { GalleryCardEntry } from '../types';
import { fmtDate, fmtSize, hasAnyExif } from '../utils/format';
import { observeLazyImage, unobserveLazyImage } from '../utils/imageLoader';
import { subpath, thumbUrl } from '../utils/paths';
import { moveBadgeLabel, renameBadgeLabel, type StagedSets } from '../utils/staged';

interface LazyThumbProps {
  src: string;
  alt: string;
}

function LazyThumb({ src, alt }: LazyThumbProps) {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    setLoaded(false);
    const onLoad = () => setLoaded(true);
    img.addEventListener('load', onLoad);
    img.addEventListener('error', onLoad);
    observeLazyImage(img);
    return () => {
      img.removeEventListener('load', onLoad);
      img.removeEventListener('error', onLoad);
      unobserveLazyImage(img);
    };
  }, [src]);

  return (
    <>
      {!loaded && <div className="loader" />}
      <img ref={imgRef} data-src={src} alt={alt} decoding="async" fetchPriority="low" />
    </>
  );
}

interface GalleryCardProps {
  entry: GalleryCardEntry;
  number: number;
  selected: boolean;
  staged: StagedSets;
  onCardClick: (event: MouseEvent<HTMLDivElement>, entry: GalleryCardEntry) => void;
  onToggleCheck: (index: number, shiftKey: boolean) => void;
  onContextMenu: (event: MouseEvent<HTMLDivElement>, entry: GalleryCardEntry) => void;
}

function GalleryCardInner({
  entry,
  number,
  selected,
  staged,
  onCardClick,
  onToggleCheck,
  onContextMenu,
}: GalleryCardProps) {
  const { photo, index } = entry;
  const sp = subpath(photo);
  const hasExif = hasAnyExif(photo.exif);
  const isDeleted = staged.deletes.has(sp);
  const isRenamed = staged.renameSrcs.has(sp);
  const isMoved = staged.moveSrcs.has(sp);
  const hasExifOp = staged.exifSrcs.has(sp);

  const className = [
    'card',
    isDeleted ? 'staged-delete' : '',
    isRenamed ? 'staged-rename' : '',
    isMoved ? 'staged-move' : '',
    hasExifOp ? 'staged-exif' : '',
    selected ? 'selected' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const metaBits = [
    photo.exif.image_width && photo.exif.image_height
      ? `${photo.exif.image_width}×${photo.exif.image_height}`
      : '',
    fmtSize(photo.size),
  ].filter(Boolean);

  return (
    <div
      className={className}
      data-sp={sp}
      data-photos-idx={index}
      onClick={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest('input.selchk')) {
          event.preventDefault();
          event.stopPropagation();
          onToggleCheck(index, event.shiftKey);
          return;
        }
        if (target.closest('.sel-wrap')) {
          event.stopPropagation();
          return;
        }
        onCardClick(event, entry);
      }}
      onContextMenu={(event) => onContextMenu(event, entry)}
    >
      <div className="thumb">
        <div className="sel-wrap">
          <input
            type="checkbox"
            className="selchk"
            checked={selected}
            readOnly
            aria-label={`选择 ${photo.filename}`}
          />
        </div>
        <LazyThumb src={thumbUrl(photo)} alt={photo.filename} />
        {!hasExif && <span className="badge no-exif">NO EXIF</span>}
        {isDeleted && <span className="badge staged">待删除</span>}
        {isRenamed && (
          <span className="badge rename" title={`${sp} → ${staged.renameMap.get(sp) || sp}`}>
            {renameBadgeLabel(sp, staged)}
          </span>
        )}
        {isMoved && (
          <span className="badge move" title={`${sp} → ${staged.moveMap.get(sp) || sp}`}>
            {moveBadgeLabel(sp, staged)}
          </span>
        )}
        {hasExifOp && (
          <span className="badge exif" title="待写入 EXIF">待EXIF</span>
        )}
        <span className="badge num">#{number}</span>
      </div>
      <div className="card-info">
        <div className="card-name" title={sp}>{photo.filename}</div>
        <div className="card-date">{fmtDate(photo.exif.date_taken)}</div>
        <div className="card-meta">{metaBits.join(' · ')}</div>
      </div>
    </div>
  );
}

export const GalleryCard = memo(GalleryCardInner);
