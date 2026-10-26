interface EmptyStateProps {
  visible: boolean;
}

export function EmptyState({ visible }: EmptyStateProps) {
  return (
    <div id="empty" style={{ display: visible ? 'flex' : 'none' }}>
      <svg width="52" height="52" fill="none" stroke="currentColor" strokeWidth="1.2" viewBox="0 0 24 24">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <path d="M21 15l-5-5L5 21" />
      </svg>
      <h2>没有找到照片</h2>
      <p>请将照片目录挂载到容器的 <code>/photos</code> 路径</p>
      <code>podman run -v /你的照片目录:/photos:ro -p 3000:3000 photo-viewer</code>
    </div>
  );
}
