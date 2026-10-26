import { useAppSelector } from '../store';

export function LoadingOverlay() {
  const visible = useAppSelector((state) => state.app.loadingVisible);
  const message = useAppSelector((state) => state.app.loadingMessage);
  const progress = useAppSelector((state) => state.app.loadingProgress);

  return (
    <>
      <div id="prog" style={{ width: `${progress}%` }} />
      <div id="loading" className={visible ? 'show' : undefined}>
        <div className="spinner" />
        <span id="loading-msg">{message}</span>
      </div>
    </>
  );
}
