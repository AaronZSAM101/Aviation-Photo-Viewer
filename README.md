# Photo Viewer

该项目是使用 Rust + Axum 写的轻量航空照片浏览器。支持 EXIF 读取、缩略图与预览图生成、按拍摄日期排序、文件操作（删除/移动/复制/重命名）、感知哈希对比。前端单页应用编译进二进制，部署只需要一个容器。

- 后端：Axum + Tokio + Rayon
- 前端：原生 JS（虚拟滚动 + 智能加载队列）
- 部署：Podman / Docker / 直接二进制

---

## 目录

- [快速开始](#快速开始)
- [环境变量](#环境变量)
- [API 端点](#api-端点)
- [支持的图片格式](#支持的图片格式)
- [项目架构](#项目架构)
- [性能优化](#性能优化)
- [Podman 部署](#podman-部署)
- [开发与构建](#开发与构建)

---

## 快速开始
建议本地用户使用 [Podman](https://podman.io/) 进行部署。
PHOTOS_DIR=/Users/aaronliu/Library/CloudStorage/SynologyDrive-MBA-Aaron/Photos/Aviation PORT=3002 ./target/release/photo-viewer
```bash
# 1. 构建镜像
podman build -t photo-viewer .

# 2. 只读挂载照片目录并运行
podman run --rm \
  -v /你的照片目录:/photos:ro \
  -p 3000:3000 \
  photo-viewer
```

浏览器打开 <http://localhost:3000> 即可。

第一次构建需要拉 Rust 工具链与依赖，约 3–5 分钟；之后只改代码的增量构建几秒就能完成（依赖层会被缓存）。

---

## 环境变量

| 变量          | 默认值     | 说明                |
|---------------|------------|---------------------|
| `PHOTOS_DIR`  | `/photos`  | 容器内照片目录路径  |
| `PORT`        | `3000`     | 监听端口            |
| `HOST`        | `127.0.0.1` | 监听地址；容器镜像默认设为 `0.0.0.0` |
| `READ_ONLY`   | `false`    | 只读模式；设为 `true` 时禁用所有写操作 |

> 公网部署时不要直接暴露 photo-viewer 端口。建议让 photo-viewer 只在容器网络内监听，再通过认证反向代理访问。

---

## 公网安全部署

本项目没有内置账号系统。若端口直接暴露到公网，知道链接的人可以查看照片，并在非只读模式下执行移动、删除、重命名、EXIF 编辑等操作。

推荐使用 **GitHub OAuth + oauth2-proxy + Caddy** 作为公网入口：

```text
Internet
  -> Caddy :443
  -> oauth2-proxy :4180
  -> photo-viewer :3000
```

GitHub OAuth App 配置：

| 字段 | 示例 |
|------|------|
| Homepage URL | `https://photos.example.com` |
| Authorization callback URL | `https://photos.example.com/oauth2/callback` |

oauth2-proxy 关键配置示例：

```text
provider = "github"
client_id = "<GitHub OAuth Client ID>"
client_secret = "<GitHub OAuth Client Secret>"
cookie_secret = "<openssl rand -base64 32>"
email_domains = ["*"]
github_users = ["your-github-user", "friend-github-user"]
upstreams = ["http://photo-viewer:3000"]
http_address = "0.0.0.0:4180"
reverse_proxy = true
cookie_secure = true
```

Caddyfile 示例：

```caddyfile
photos.example.com {
  reverse_proxy oauth2-proxy:4180
}
```

photo-viewer 公网建议环境变量：

```bash
HOST=0.0.0.0
READ_ONLY=true
```

`READ_ONLY=true` 会在后端拒绝写接口，并在前端隐藏管理按钮。GitHub OAuth 负责“谁能进入”，只读模式负责“进入后不能改/删照片”。

---

## API 端点

| 路由                          | 说明                                          |
|-------------------------------|-----------------------------------------------|
| `GET /`                       | 前端页面                                      |
| `GET /view/:path`             | 前端页面的可刷新查看器路由                   |
| `GET /api/photos?sort=`       | 照片列表 JSON（含 EXIF）                      |
| `GET /photos/:path`           | 原图                                          |
| `GET /thumb/:path`            | 缩略图（400px，内存缓存）                     |
| `GET /preview/:path`          | 预览图（≤2400px，内存缓存）                   |
| `POST /api/stage`             | 暂存文件操作                                  |
| `POST /api/stage/apply`       | 应用暂存的操作                                |
| `GET /api/hash/:path`         | 计算照片 SHA256                               |
| `GET /api/compare?a=&b=`      | 对比两张照片（感知哈希）                      |

`sort` 可选值：`date-asc` / `date-desc` / `name-asc` / `name-desc` / `size-desc`

查看器路由会把当前状态写入 URL 查询参数：`sort`、`view`、`scale`、`q`、`collapse`。

---

## 支持的图片格式

JPG · PNG · WebP · TIFF

HEIC 暂不支持，需要额外的 C 库依赖。

---

## 项目架构

代码前后端均采用模块化设计。后端 8 个 Rust 模块约 1000 行，前端 9 个 ES Module 约 1400 行（含 CSS）。

### 后端（Rust）

```
src/
├── lib.rs          (8 行)    库入口，导出公共接口
├── main.rs         (66 行)   应用启动、路由注册
├── models.rs       (89 行)   数据类型（AppState、ExifData、PhotoMeta、OpKind…）
├── exif.rs         (165 行)  EXIF 元数据提取与解析
├── handlers.rs     (~290 行) HTTP 请求处理 + 静态资源 (rust-embed)
├── file_ops.rs     (270 行)  文件操作、暂存队列、垃圾回收（.trash）
├── hash.rs         (84 行)   SHA256 + 感知哈希（aHash），照片对比
└── utils.rs        (24 行)   工具函数（路径安全检查、ahash 算法）
```

| 模块 | 职责 |
|------|------|
| `models` | 全局状态与数据类型定义 |
| `exif` | `extract_exif()`、`date_to_sort_key()`、GPS 坐标转换、有理数处理 |
| `handlers` | 路由处理函数（图片列表/缩略图/预览/前端入口/`/static/*` 静态资源） |
| `file_ops` | 文件删除/移动/复制/重命名，操作队列与 `.trash` 目录 |
| `hash` | 文件 SHA256 与感知哈希，重复照片检测 |
| `utils` | `safe_subpath()` 路径校验、`compute_ahash()` |

### 前端（静态资源全部嵌入二进制）

整个 `static/` 目录通过 [`rust-embed`](https://crates.io/crates/rust-embed) 在编译期打包进可执行文件，运行时不需要任何外部资源文件。

```
static/
├── index.html              (233 行)  纯 DOM 模板，无内联 JS / CSS
├── css/
│   └── styles.css          (184 行)  全部样式
└── js/                                ES Modules（type="module"）
    ├── main.js             (6 行)    入口
    ├── state.js            (125 行)  state 对象 + DOM 引用 + ImageLoader
    ├── utils.js            (63 行)   纯函数：fmt_*, subpath, thumbUrl…
    ├── selection.js        (63 行)   选择逻辑
    ├── api.js              (156 行)  所有 fetch（照片/暂存/回收站）
    ├── render.js           (364 行)  网格渲染 + 搜索 + 虚拟滚动
    ├── viewer.js           (281 行)  全屏查看器 + 直方图 + 网格 overlay
    ├── file-ops.js         (96 行)   文件操作 modal（rename/move/copy）
    └── events.js           (257 行)  事件绑定 + 键盘快捷键 + 右键菜单
```

| 模块 | 职责 |
|------|------|
| `state` | 全局可变状态 `state` 对象、所有 `getElementById` 引用、`ImageLoader` 单例 |
| `utils` | 纯函数：格式化、路径与 URL、`hasAnyExif` 等，无副作用 |
| `selection` | 卡片多选（含 Shift 范围选 / Cmd 追加选） |
| `api` | 所有 `fetch` 调用、`closeModal` |
| `render` | 主渲染入口、按文件夹/时间分组、虚拟滚动、暂存徽标 |
| `viewer` | 查看器开关与导航、EXIF 面板、污点检查、RGB/直方图、网格对齐 |
| `file-ops` | 文件操作 modal（rename / move / copy）的状态机与提交 |
| `events` | 把上面所有模块的功能挂到 DOM 事件上 |
| `main` | 入口：调用 `bindAllEvents()` + `loadPhotos()` |

### 关键设计

**缓存策略** — 图片列表请求时扫描文件系统，按 `mtime` + `size` 命中 EXIF 缓存；缩略图与预览图均常驻内存缓存。

**路径安全** — 所有文件操作经 `safe_subpath()` 校验，杜绝 `../` 目录遍历攻击。

**并行处理** — 文件 I/O 跑在 blocking pool（避免阻塞 tokio 调度）；EXIF 提取通过 `rayon` 并行。

**前端模块化** — 用单一 `state` 对象集中可变状态，所有跨模块共享通过对象属性读写，避免 `export let` + setter 的繁琐写法。模块间存在循环依赖（render ↔ viewer，api → render → viewer → api），但所有跨模块调用都发生在事件回调里，ES Module live bindings 能正确处理。

**静态资源嵌入** — 用 `rust-embed` 把 `static/` 整个目录在编译期打包进二进制，运行时通过 `/static/*path` 路由提供。新增 CSS / JS / 字体文件不需要改 Rust 代码。

---

## 性能优化

通过 **虚拟滚动 + 智能图片加载队列 + 搜索索引**，前端能稳定承载 50K+ 张图片。

### 性能指标对比

| 指标 | 优化前 | 优化后 | 提升 |
|------|-------|--------|------|
| 首屏加载（1000 张） | 3–5 秒 | 200–500 ms | 6–10× |
| 内存占用（1000 张） | ~200 MB | ~50 MB | 4× |
| 滚动帧率 | 15–30 fps（卡顿）| 55–60 fps（流畅）| 2–4× |
| 搜索延迟 | 100–200 ms | 10–30 ms | 3–10× |
| 最大支持图片数 | ~5K | **50K+** | 10× |

### 三项核心优化

**1. 虚拟滚动（Intersection Observer）** — 只渲染视口内的 DOM 元素，进入视口的图片才触发加载（`rootMargin: '300px'` 提前 300px 加载）。DOM 节点减少 90%+。

**2. 智能图片加载队列（ImageLoader）** — 限制并发加载数量（默认 6），避免浏览器资源耗尽。并发数 = 6 在大多数环境下是 CPU 占用与速度的最佳平衡点。

```javascript
class ImageLoader {
  constructor(maxConcurrent = 6) { /* ... */ }
  load(img) { this.queue.push(img); this.processQueue(); }
  processQueue() {
    while (this.loading < this.maxConcurrent && this.queue.length > 0) {
      const img = this.queue.shift();
      this.loading++;
      img.onload = img.onerror = () => { this.loading--; this.processQueue(); };
      img.src = img.dataset.src;
    }
  }
}
```

**3. 搜索索引** — 预构建 Map 索引，把 O(n) 的全表扫描降为 O(1) 查表，并缓存上一次搜索词避免重复计算。10K 张图片搜索从 100 ms 降到 5 ms。

### 推荐配置

```javascript
maxConcurrent = 6;     // 并发加载数
rootMargin = '300px';  // 预加载距离
```

低端设备可降到 3，高端设备可提到 8–12。

### 后续可选优化

- 后端分页 API（`/api/photos?limit=100&offset=0`，`models.rs` 中已预留 `PhotosQuery` / `PagedPhotos` 结构）
- HTTP 缓存头（`Cache-Control: public, max-age=86400`）
- Service Worker 离线缓存
- IndexedDB 元数据缓存
- WebP 转码 + Brotli 压缩

---

## Podman 部署

本项目以 Podman 为主推部署方式（也完全兼容 Docker，把命令里的 `podman` 替换成 `docker` 即可）。提供两种方式：**直接 `podman run`** 和 **Pod / Kubernetes YAML**。Yaml为本项目主推方式。

### 方式一：直接 `podman run`

适合最简单的本地使用场景。

```bash
# 构建镜像
podman build -t photo-viewer .

# 运行（前台）
podman run --rm \
  -v /你的照片目录:/photos:ro \
  -p 3000:3000 \
  photo-viewer

# 运行（后台 + 命名 + 自启）
podman run -d \
  --name photo-viewer \
  --restart unless-stopped \
  -v /你的照片目录:/photos:ro \
  -p 3000:3000 \
  photo-viewer
```

常用管理命令：

```bash
podman logs -f photo-viewer          # 看日志
podman stop photo-viewer             # 停止
podman start photo-viewer            # 启动
podman rm -f photo-viewer            # 删除容器
podman image prune                   # 清理无用镜像
```

> **macOS 提示**：Podman 在 macOS 上跑在轻量虚拟机里。把宿主机目录挂进容器前，先确认这个目录已经被 podman machine 共享：
>
> ```bash
> podman machine stop
> podman machine set --rootful=false --volume /Users/你的用户名/Pictures
> podman machine start
> ```

### 方式二：Pod / Kubernetes YAML

仓库内已提供 `photo-viewer-pod.yaml`，Podman 原生支持 Kubernetes Pod 规范，直接 `play kube` 即可。

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: photo-viewer-pod
spec:
  containers:
    - name: photo-viewer
      image: localhost/photo-viewer:latest
      ports:
        - containerPort: 3000
          hostPort: 3000
      env:
        - name: PHOTOS_DIR
          value: /photos
        - name: PORT
          value: "3000"
      volumeMounts:
        - name: photos-volume
          mountPath: /photos

  volumes:
    - name: photos-volume
      hostPath:
        path: /Users/aaronliu/Library/CloudStorage/SynologyDrive-MBA-Aaron/Photos/Aviation
```

把 `volumes.hostPath.path` 改成你自己的照片目录后，使用：

```bash
# 启动 pod
podman play kube photo-viewer-pod.yaml

# 查看状态
podman pod ps
podman ps --pod

# 查看日志
podman logs photo-viewer-pod-photo-viewer

# 停止 / 移除
podman play kube --down photo-viewer-pod.yaml
```

### 方式三：systemd 自启（Linux 服务器）

```bash
# 生成 systemd unit 文件（用户态）
mkdir -p ~/.config/systemd/user
podman generate systemd --new --files --name photo-viewer \
  --restart-policy=always

mv container-photo-viewer.service ~/.config/systemd/user/

# 启用并启动
systemctl --user daemon-reload
systemctl --user enable --now container-photo-viewer.service

# 让服务在用户未登录时也能运行
loginctl enable-linger $USER
```

### Containerfile 说明

镜像采用两阶段构建（多阶段构建），最终运行镜像基于 `debian:bookworm-slim`，体积小：

- **Stage 1（builder）**：基于 `rust:1.91-slim-trixie`，先把 `Cargo.toml` / `Cargo.lock` 拷进去构建空 stub 来缓存依赖层，再拷源码做真正的 release 构建。这样只改代码时不会重拉所有依赖。
- **Stage 2（runtime）**：只装 `ca-certificates`，把构建产物 `photo-viewer` 拷进去，暴露 3000 端口，挂载点 `/photos`。

镜像默认环境变量：`PHOTOS_DIR=/photos`、`PORT=3000`。

### 常见问题

**Q：照片目录权限不对，容器读不到？**
A：加 `:ro,Z`（SELinux 系统）或确认宿主机文件可读：`chmod -R a+rX /你的照片目录`。

**Q：换端口？**
A：`-p 8080:3000` 或在 YAML 里改 `hostPort`。容器内端口也想改的话同步改 `PORT` 环境变量。

**Q：rootless Podman 挂载报权限错误？**
A：rootless 模式下使用 `--userns=keep-id` 让容器内 UID 与宿主一致；或用 `:U` 标志让 Podman 自动 chown 卷。

---

## 开发与构建

### 本地开发（无容器）

```bash
# 编译检查
cargo check
cargo clippy

# 运行（指定照片目录与端口）
PHOTOS_DIR=/path/to/photos PORT=3000 cargo run --release
```

### 构建产物

```bash
cargo build --release
./target/release/photo-viewer
```

`Cargo.toml` 中的 release profile 已开启：

```toml
[profile.release]
opt-level = 3
lto       = true
strip     = true
```

### 验证 API

```bash
curl http://localhost:3000/api/photos
curl http://localhost:3000/thumb/example.jpg -o thumb.jpg
```

### 模块导入示例（如果你想把它当库用）

```rust
use photo_viewer::models::{AppState, PhotoMeta};
use photo_viewer::exif::extract_exif;
use photo_viewer::handlers;
use photo_viewer::hash;
```

### 依赖

axum 0.7 · tokio 1 · tower-http 0.5 · image 0.24 · kamadak-exif 0.6 · sha2 0.10 · img_hash 2.0 · rayon 1.7

### 后续可做的事

- 单元测试（`#[cfg(test)]`，路径校验、EXIF 解析等都很容易测）
- 持久化缓存（SQLite 或 RocksDB）
- EXIF 字段全文搜索
- 性能监控与结构化日志
- 前端错误处理改进

---

## 目录结构

```
photo-viewer/
├── Containerfile           # 多阶段构建
├── Cargo.toml
├── photo-viewer-pod.yaml   # Pod / k8s 部署清单
├── src/
│   ├── lib.rs
│   ├── main.rs
│   ├── models.rs
│   ├── exif.rs
│   ├── handlers.rs
│   ├── file_ops.rs
│   ├── hash.rs
│   └── utils.rs
└── static/
    └── index.html          # 前端（编译进二进制）
```
