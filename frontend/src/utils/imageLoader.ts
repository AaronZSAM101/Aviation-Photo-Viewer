interface QueueItem {
  img: HTMLImageElement;
  done: () => void;
}

class ImageLoader {
  private maxConcurrent: number;
  private queue: QueueItem[] = [];
  // 排队中的元素：可能已经被卸载，所以能取消
  private queued = new Set<HTMLImageElement>();
  // 已经挂上 src 的元素：浏览器正在下载，取消不了，只能等它结束
  private running = new Set<HTMLImageElement>();

  constructor(maxConcurrent: number) {
    this.maxConcurrent = maxConcurrent;
  }

  load(img: HTMLImageElement, done: () => void = () => {}) {
    if (this.queued.has(img) || this.running.has(img)) return;
    this.queued.add(img);
    this.queue.push({ img, done });
    this.processQueue();
  }

  // 行级窗口下卡片会被滚出窗口就卸载，排在队里的下载没必要再发起：
  // 快速划过整库时，不然会把带宽和 onload 全花在没人看的缩略图上。
  cancel(img: HTMLImageElement) {
    if (!this.queued.delete(img)) return;
    this.queue = this.queue.filter((item) => item.img !== img);
  }

  private processQueue() {
    while (this.running.size < this.maxConcurrent && this.queue.length > 0) {
      const item = this.queue.shift()!;
      this.queued.delete(item.img);
      // 取消只覆盖还在排队的；这一遍再兜住"已经不在文档里"的
      if (!item.img.isConnected) continue;
      this.running.add(item.img);
      item.img.onload = item.img.onerror = () => {
        item.img.classList.add('loaded');
        this.running.delete(item.img);
        item.done();
        this.processQueue();
      };
      const src = item.img.dataset.src;
      if (src) item.img.src = src;
      else this.running.delete(item.img);
    }
  }
}

// 浏览器对同一 origin 的 HTTP/1.1 并发本来就只有 6 条连接，
// 手机端再往下压到 2 条只会让滚动时满屏都是转圈。
export const imageLoader = new ImageLoader(6);

let lazyObserver: IntersectionObserver | null = null;

function getLazyObserver() {
  if (!lazyObserver) {
    // 手机屏幕矮、滚动快，120px 的预判几乎等于“到了才加载”
    const rootMargin = window.matchMedia('(max-width: 900px), (pointer: coarse)').matches
      ? '600px'
      : '300px';
    lazyObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const img = entry.target as HTMLImageElement;
          if (!img.src && img.dataset.src) {
            imageLoader.load(img);
          }
          lazyObserver?.unobserve(img);
        });
      },
      { rootMargin },
    );
  }
  return lazyObserver;
}

export function observeLazyImage(img: HTMLImageElement) {
  getLazyObserver().observe(img);
}

export function unobserveLazyImage(img: HTMLImageElement) {
  lazyObserver?.unobserve(img);
  imageLoader.cancel(img);
}
