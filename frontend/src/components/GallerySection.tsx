import { memo, type MouseEvent } from 'react';
import type { GalleryCardEntry, GallerySection as GallerySectionType } from '../types';
import type { StagedSets } from '../utils/staged';
import { GalleryGrid } from './GalleryGrid';

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

  const grid = (
    <GalleryGrid
      items={section.items}
      numbering={numbering}
      selected={selected}
      staged={staged}
      onCardClick={onCardClick}
      onToggleCheck={onToggleCheck}
      onContextMenu={onContextMenu}
    />
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
