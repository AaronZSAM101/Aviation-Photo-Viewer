import { memo, useEffect, useState, type MouseEvent } from 'react';
import type { GalleryCardEntry, GallerySection as GallerySectionType } from '../types';
import type { StagedSets } from '../utils/staged';
import { GalleryCard } from './GalleryCard';

// 上千张卡片一次性挂载会把主线程堵住 1s 以上，先渲染首屏，再按帧补齐
const INITIAL_CARDS = 240;
const CARD_CHUNK = 240;
const CHUNK_DELAY_MS = 30;

interface GallerySectionProps {
  section: GallerySectionType;
  numbering: Map<string, number>;
  isCollapsed: (key: string | null) => boolean;
  selected: Set<string>;
  staged: StagedSets;
  onToggleSection: (key: string) => void;
  onCardClick: (event: MouseEvent<HTMLDivElement>, entry: GalleryCardEntry) => void;
  onToggleCheck: (index: number, shiftKey: boolean) => void;
  onContextMenu: (event: MouseEvent<HTMLDivElement>, entry: GalleryCardEntry) => void;
}

function GallerySectionInner({
  section,
  numbering,
  isCollapsed,
  selected,
  staged,
  onToggleSection,
  onCardClick,
  onToggleCheck,
  onContextMenu,
}: GallerySectionProps) {
  const collapsed = section.key ? isCollapsed(section.key) : false;
  const [visible, setVisible] = useState(INITIAL_CARDS);
  const [lastSection, setLastSection] = useState(section);

  if (lastSection !== section) {
    setLastSection(section);
    setVisible(INITIAL_CARDS);
  }

  useEffect(() => {
    if (visible >= section.items.length) return;
    const timer = window.setTimeout(() => setVisible((count) => count + CARD_CHUNK), CHUNK_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [visible, section.items.length]);

  const shown =
    visible >= section.items.length ? section.items : section.items.slice(0, visible);

  const grid = (
    <div className="grid">
      {shown.map((entry) => {
        const key = entry.photo.folder
          ? `${entry.photo.folder}/${entry.photo.filename}`
          : entry.photo.filename;
        return (
          <GalleryCard
            key={key}
            entry={entry}
            number={numbering.get(key) || entry.index + 1}
            selected={selected.has(key)}
            staged={staged}
            onCardClick={onCardClick}
            onToggleCheck={onToggleCheck}
            onContextMenu={onContextMenu}
          />
        );
      })}
    </div>
  );

  if (!section.key) return grid;

  return (
    <div
      className={`folder-section${collapsed ? ' collapsed' : ''}`}
      data-section-key={section.key}
    >
      <div
        className="folder-header"
        role="button"
        aria-expanded={!collapsed}
        onClick={() => onToggleSection(section.key!)}
      >
        <span className="folder-toggle">{collapsed ? '▸' : '▾'}</span>
        <span className="folder-icon">{section.icon}</span>
        <span className="folder-name">{section.label}</span>
        <span className="folder-count">{section.count} 张</span>
      </div>
      {section.children.length > 0
        ? section.children.map((child) => (
            <GallerySection
              key={child.key || child.label}
              section={child}
              numbering={numbering}
              isCollapsed={isCollapsed}
              selected={selected}
              staged={staged}
              onToggleSection={onToggleSection}
              onCardClick={onCardClick}
              onToggleCheck={onToggleCheck}
              onContextMenu={onContextMenu}
            />
          ))
        : grid}
    </div>
  );
}

export const GallerySection = memo(GallerySectionInner);
