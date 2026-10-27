// 全站共用一个滚动源：画廊可能有几十个分区，各挂各的 scroll 监听会把一帧的
// 布局读取放大几十次。这里按帧合并，回调里只做自己那一个网格的测量。
type Listener = () => void;

const listeners = new Set<Listener>();
let frame = 0;
let attached = false;

function pump() {
  frame = 0;
  listeners.forEach((listener) => listener());
}

function schedule() {
  if (!frame) frame = requestAnimationFrame(pump);
}

function attach() {
  if (attached) return;
  attached = true;
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
}

function detach() {
  attached = false;
  window.removeEventListener('scroll', schedule);
  window.removeEventListener('resize', schedule);
  if (frame) {
    cancelAnimationFrame(frame);
    frame = 0;
  }
}

export function onScrollFrame(listener: () => void): () => void {
  listeners.add(listener);
  attach();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) detach();
  };
}

/** 首帧没有滚动事件，挂载后手动排一次测量 */
export function requestScrollFrame(): void {
  schedule();
}
