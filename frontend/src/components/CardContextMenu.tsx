import { useEffect, useRef } from 'react';

export interface ContextMenuItem {
  kind: string;
  label: string;
  danger?: boolean;
  separatorBefore?: boolean;
}

interface CardContextMenuProps {
  open: boolean;
  x: number;
  y: number;
  items: ContextMenuItem[];
  onSelect: (kind: string) => void;
  onClose: () => void;
}

export function CardContextMenu({ open, x, y, items, onSelect, onClose }: CardContextMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const handleScroll = () => onClose();
    document.addEventListener('click', handleClick);
    document.addEventListener('keydown', handleKey);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleScroll);
    return () => {
      document.removeEventListener('click', handleClick);
      document.removeEventListener('keydown', handleKey);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleScroll);
    };
  }, [open, onClose]);

  if (!open || !items.length) {
    return <div ref={ref} className="card-context-menu" />;
  }

  return (
    <div
      ref={ref}
      className="card-context-menu show"
      style={{ left: x, top: y }}
      onClick={(event) => event.stopPropagation()}
    >
      {items.map((item) => (
        <div key={item.kind}>
          {item.separatorBefore && <div className="card-context-sep" />}
          <button
            type="button"
            className={`card-context-item${item.danger ? ' danger' : ''}`}
            onClick={() => onSelect(item.kind)}
          >
            {item.label}
          </button>
        </div>
      ))}
    </div>
  );
}
