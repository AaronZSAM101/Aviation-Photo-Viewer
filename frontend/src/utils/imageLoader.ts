class ImageLoader {
  private maxConcurrent: number;
  private loading = 0;
  private queue: { img: HTMLImageElement; done: () => void }[] = [];
  private loadingSet = new Set<HTMLImageElement>();

  constructor(maxConcurrent: number) {
    this.maxConcurrent = maxConcurrent;
  }

  load(img: HTMLImageElement, done: () => void = () => {}) {
    if (this.loadingSet.has(img)) return;
    this.loadingSet.add(img);
    this.queue.push({ img, done });
    this.processQueue();
  }

  private processQueue() {
    while (this.loading < this.maxConcurrent && this.queue.length > 0) {
      const item = this.queue.shift()!;
      this.loading += 1;
      const src = item.img.dataset.src;
      item.img.onload = item.img.onerror = () => {
        item.img.classList.add('loaded');
        this.loading -= 1;
        this.loadingSet.delete(item.img);
        item.done();
        this.processQueue();
      };
      if (src) item.img.src = src;
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
}
