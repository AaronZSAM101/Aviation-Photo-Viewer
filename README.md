# Aviation-Photo-Viewer

Aviation-Photo-Viewer 是一个轻量的照片浏览和管理工具，并且对于航空摄影师提供了一些客制化的服务。

本项目将后端、前端和静态资源打包成一个程序或一个容器，适合在本机、NAS、家庭服务器上浏览大量照片。

## 目录

- [它能做什么](#它能做什么)
- [先选一种部署方式](#先选一种部署方式)
- [本地直接运行](#本地直接运行)
- [Podman / Docker 运行](#podman--docker-运行)
- [群晖 NAS 部署](#群晖-nas-部署)
- [环境变量说明](#环境变量说明)
- [HTTPS 和公网访问](#https-和公网访问)
- [常见问题](#常见问题)
- [开发者附录](#开发者附录)



## 它能做什么

目前已有功能可以分成几个大模块：

### 照片浏览和检索

- 支持 JPG / PNG / WebP / TIFF 格式，未来可能会支持读取 RAW 格式照片。
- 自动生成缩略图和预览图，打开大量照片时更快。
- 支持按拍摄时间、文件夹、文件名、文件大小等方式查看和排序。
- 支持按年、月、日的时间尺度分组，适合浏览长期积累的照片。
- 支持按文件夹分组，适合已经在硬盘或 NAS 上整理好目录的照片库。
- 支持搜索照片文件名和路径。

### 大图查看和辅助分析

- 打开照片大图查看器，支持键盘左右切换。
- 显示 EXIF 信息，例如拍摄时间、相机、镜头、焦距、ISO、快门、光圈、GPS 等。
- 支持直方图、RGB 辅助查看、构图网格等查看工具。
- 支持 SHA256 和感知哈希对比，可以手动选择两张照片对比，也可以扫描当前挂载目录查找相似照片。

### 照片管理

- 支持多选照片。
- 支持暂存并批量执行文件操作：删除、移动、复制、重命名、恢复。
- 支持回收站式删除，降低误删风险。
- 支持手动编辑部分 EXIF 覆盖信息。
- 支持只读模式，只浏览不允许改文件。

### 部署和访问

- 支持本地运行，也支持 Podman / Docker / 群晖 NAS 部署。
- 支持 HTTP，本地使用不需要证书。
- 支持配置证书后直接启用 HTTPS。
- 推荐在群晖或公网环境中使用反向代理和 HTTPS 证书。

目前还没有内置账号系统。放到公网前，请务必使用群晖反向代理、oauth2-proxy、Authentik、Caddy、Nginx 等方式加认证。



## 先选一种部署方式

如果你只是自己电脑上用：

- 推荐：本地直接运行或 Podman / Docker。
- 不需要证书，浏览器打开 `http://localhost:3000`。

如果你在群晖 NAS 上用：

- 推荐：Container Manager 创建容器，DSM 反向代理负责 HTTPS 证书。
- 可以直接使用 GitHub Packages 中已经构建好的镜像，不需要在 NAS 上自己编译。
- photo-viewer 容器内部继续跑 HTTP，这样证书续期最省心。
- 群晖用户请选择 `amd64` / `linux/amd64` 镜像。

如果你熟悉 YAML：

- Podman 可以用 `photo-viewer-pod.yaml` 创建 Pod。
- 也可以直接用镜像创建容器并挂载照片目录。
- Podman Desktop、Docker Desktop、群晖 Container Manager 都有图形界面，可以不用手敲完整命令。



## 本地直接运行

适合已经拿到二进制文件，或者自己会 `cargo build` 的用户。

```bash
PHOTOS_DIR=/你的照片目录 PORT=3000 ./photo-viewer
```

然后打开：

```text
http://localhost:3000
```

本地运行默认是 HTTP，不需要证书。



## Podman / Docker 运行

下面命令里的 `podman` 可以换成 `docker`。

### 方式一：直接用镜像运行

项目已经在 GitHub Packages 中生成容器镜像：

```text
ghcr.io/aaronzsam101/aviation-photo-viewer:latest
```

镜像页面：[AaronZSAM101/Aviation-Photo-Viewer](https://github.com/AaronZSAM101/Aviation-Photo-Viewer/pkgs/container/aviation-photo-viewer)

镜像里默认监听容器内 `80` 端口，所以最简单的端口映射是 `3000:80`。

只浏览，不允许改照片：

```bash
podman run -d \
  --name photo-viewer \
  --restart unless-stopped \
  -p 3000:80 \
  -v /你的照片目录:/photos:ro \
  -e PHOTOS_DIR=/photos \
  -e READ_ONLY=true \
  ghcr.io/aaronzsam101/aviation-photo-viewer:latest
```

允许在网页里删除、移动、复制、重命名：

```bash
podman run -d \
  --name photo-viewer \
  --restart unless-stopped \
  -p 3000:80 \
  -v /你的照片目录:/photos \
  -e PHOTOS_DIR=/photos \
  -e READ_ONLY=false \
  ghcr.io/aaronzsam101/aviation-photo-viewer:latest
```

打开：

```text
http://localhost:3000
```

这里有两个“只读”概念，容易混：

- `READ_ONLY=true`：photo-viewer 自己的只读模式。前端会隐藏管理按钮，后端也会拒绝写操作。
- 挂载里的 `:ro`：容器层面的文件只读。即使 `READ_ONLY=false`，只要挂载是 `:ro`，容器也改不了照片。

想管理照片时，两边都要允许：

- `READ_ONLY=false`
- 挂载不要加 `:ro`

### 方式二：用 Pod / Kubernetes YAML

仓库里有一个示例文件：`photo-viewer-pod.yaml`。

使用前先改两处：

- `hostPath.path`：改成你的照片目录。
- `READ_ONLY`：只浏览用 `"true"`，需要管理照片用 `"false"`。

示例 YAML 默认使用 GitHub Packages 镜像：

```text
ghcr.io/aaronzsam101/aviation-photo-viewer:latest
```

如果你 clone 代码后自己修改并重新构建镜像，需要把 `photo-viewer-pod.yaml` 里的 `image` 改成你自己构建出来的镜像名。例如：

```yaml
image: localhost/photo-viewer:latest
```

或者：

```yaml
image: photo-viewer:latest
```

启动：

```bash
podman play kube photo-viewer-pod.yaml
```

查看状态：

```bash
podman pod ps
podman ps --pod
```

看日志：

```bash
podman logs photo-viewer-pod-photo-viewer
```

停止并移除：

```bash
podman play kube --down photo-viewer-pod.yaml
```

Podman Desktop 也可以通过图形界面导入或创建 Pod。命令行不是必须的。

### 方式三：用图形界面创建容器

在 Podman Desktop、Docker Desktop 或群晖 Container Manager 中，核心配置都一样：

镜像：

```text
ghcr.io/aaronzsam101/aviation-photo-viewer:latest
```

如果界面让你选择平台或架构，群晖用户请选择：

```text
linux/amd64
```

端口：

```text
宿主机 3000 -> 容器 80
```

卷挂载：

```text
/你的照片目录 -> /photos
```

环境变量：

```text
PHOTOS_DIR=/photos
READ_ONLY=true 或 false
```

如果图形界面要求填写容器端口，请填 `80`，除非你额外设置了 `PORT=3000`。



## 群晖 NAS 部署

特别提醒：群晖用户按 `amd64` / `linux/amd64` 镜像部署。Container Manager 如果出现平台或架构选项，请选 `linux/amd64`。

推荐路线：

```text
浏览器 HTTPS
  -> 群晖 DSM 反向代理 / 证书
  -> photo-viewer 容器 HTTP
  -> /photos 照片目录
```

这样 photo-viewer 不需要自己管理证书，群晖负责 HTTPS 和证书续期。

### 1. 准备照片共享文件夹

在群晖上，建议把照片放在真正的共享文件夹里，例如：

```text
/volume1/photo
/volume1/Aviation
/volume1/docker/photo-viewer/photos
```

注意：

- Container Manager 挂载的目录需要是容器能访问的共享文件夹。
- 不建议挂一个软链接目录。容器里看到软链接后，软链接指向的真实位置未必也被挂进去了，容易出现“能看到名字但打不开文件”。
- 排查真实路径时，不要只看 `ls -l` 的软链接结果；用 `mount` 看实际挂载点和共享文件夹位置更可靠。

### 2. 用 Container Manager 创建容器

在 Container Manager 里创建容器时，填这些配置。

镜像：

```text
ghcr.io/aaronzsam101/aviation-photo-viewer:latest
```

端口：

```text
本地端口 3000 -> 容器端口 80
```

卷：

```text
/volume1/你的照片共享文件夹 -> /photos
```

环境变量：

```text
PHOTOS_DIR=/photos
READ_ONLY=false
```

如果只想浏览，不想在网页里出现删除、移动、重命名这些功能：

```text
READ_ONLY=true
```

### 3. 确认群晖挂载权限

这里也有两个“只读”概念：

- photo-viewer 的 `READ_ONLY` 控制网页里的增删改功能。
- 群晖 Container Manager 的卷权限控制容器是否真的能改文件。

如果群晖里把卷挂成只读，那么即使 `READ_ONLY=false`，网页上点删除、移动、重命名也会失败，因为容器没有写权限。

想允许管理照片时：

- `READ_ONLY=false`
- Container Manager 的 `/photos` 卷不要选只读
- 群晖共享文件夹权限也要允许容器运行用户读写

想只浏览时：

- `READ_ONLY=true`
- 群晖卷可以设为只读，这样更保险

### 4. 配置 HTTPS

推荐用 DSM 反向代理：

1. `控制面板 -> 安全性 -> 证书`，申请或导入证书。
2. `控制面板 -> 登录门户 -> 高级 -> 反向代理服务器`，新增规则。

来源：

```text
协议: HTTPS
主机名: photo.yourdomain.com
端口: 443
```

目标：

```text
协议: HTTP
主机名: 127.0.0.1
端口: 3000
```

然后在证书设置里，把 `photo.yourdomain.com` 绑定到对应证书。

访问：

```text
https://photo.yourdomain.com
```

### 5. 如果想让容器自己启 HTTPS

不推荐作为首选，但支持。

把证书和私钥放到群晖目录，例如：

```text
/volume1/docker/photo-viewer/certs/fullchain.pem
/volume1/docker/photo-viewer/certs/privkey.pem
```

额外挂载：

```text
/volume1/docker/photo-viewer/certs -> /certs:ro
```

环境变量：

```text
PHOTOS_DIR=/photos
HOST=0.0.0.0
PORT=3443
HTTPS_CERT_PATH=/certs/fullchain.pem
HTTPS_KEY_PATH=/certs/privkey.pem
READ_ONLY=false
```

端口：

```text
本地端口 3443 -> 容器端口 3443
```

访问：

```text
https://你的NAS地址:3443
```



## 环境变量说明

| 变量 | 默认值 | 说明 |
---|---|---
| `PHOTOS_DIR` | `/photos` | 容器或程序内部看到的照片目录 |
| `PORT` | 本地程序默认 `3000`，镜像默认 `80` | 服务监听端口 |
| `HOST` | 本地程序默认 `127.0.0.1`，镜像默认 `0.0.0.0` | 服务监听地址 |
| `READ_ONLY` | `false` | photo-viewer 只读模式，设为 `true` 后禁用写操作 |
| `PHASH_WARMUP` | `false` | 打开照片列表后是否自动后台预热相似照片缓存；默认关闭，避免只是浏览时持续扫原图 |
| `SIMILAR_SCAN_WORKERS` | `4` | 相似照片扫描的后端并发数；NAS 上可调成 `2`，本地机器可用默认值 |
| `HTTPS_CERT_PATH` | 未设置 | HTTPS 证书 PEM 路径 |
| `HTTPS_KEY_PATH` | 未设置 | HTTPS 私钥 PEM 路径 |

`HTTPS_CERT_PATH` 和 `HTTPS_KEY_PATH` 必须同时设置。只设置其中一个时，程序会拒绝启动，避免你误以为已经启用 HTTPS。



## HTTPS 和公网访问

本地使用不需要 HTTPS：

```text
http://localhost:3000
```

NAS 或公网建议使用 HTTPS。推荐优先级：

1. 群晖 DSM 反向代理管理 HTTPS 证书。
2. Caddy / Nginx / oauth2-proxy 管理 HTTPS 和认证。
3. photo-viewer 自己读取证书启 HTTPS。

本项目目前没有内置登录系统，因此，只要能访问网页的人，就能浏览照片；如果 `READ_ONLY=false` 且文件挂载可写，还能管理照片。所以公网使用时请务必加认证。

本地自签名证书示例：

```bash
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout localhost-key.pem \
  -out localhost-cert.pem \
  -days 365 \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"

HTTPS_CERT_PATH=./localhost-cert.pem \
HTTPS_KEY_PATH=./localhost-key.pem \
PHOTOS_DIR=/path/to/photos \
PORT=3443 \
cargo run --release
```

打开：

```text
https://localhost:3443
```

自签名证书会触发浏览器安全提示。NAS 上建议使用可信 CA 签发的证书，或者让 DSM 反向代理处理证书。



## 常见问题

**Q：网页能打开，但看不到照片？**  
A：先检查 `PHOTOS_DIR` 是否是 `/photos`，再检查宿主机照片目录是否正确挂载到了容器的 `/photos`。

**Q：在群晖上挂载软链接目录，为什么读不到照片？**  
A：容器只看得到你挂进去的目录。软链接指向的真实目录如果没有被挂进容器，文件就会打不开。请挂真实共享文件夹，排查时用 `mount` 看真实挂载点。

**Q：我设置了 `READ_ONLY=false`，为什么还是删不掉或移动不了？**  
A：`READ_ONLY=false` 只是允许 photo-viewer 发起写操作。群晖或 Docker 的卷如果是只读，或者共享文件夹权限不允许写，操作仍然会失败。

**Q：我只是想安全浏览照片，应该怎么设？**  
A：设置 `READ_ONLY=true`，并把照片目录用只读方式挂载，例如 `/photos:ro`。这样前端隐藏管理入口，容器层也不能改文件。

**Q：换端口怎么做？**  
A：如果用镜像默认配置，容器端口是 `80`，改宿主机端口即可，例如 `8080:80`。如果你设置了 `PORT=3000`，就要映射到容器端口 `3000`。

**Q：HEIC 支持吗？**  
A：暂不支持。当前支持 JPG、PNG、WebP、TIFF。

**Q：能直接暴露到公网吗？**  
A：不建议。项目没有内置账号系统，请放在 DSM 反向代理、oauth2-proxy、Authentik、Caddy、Nginx 等认证入口后面。



## 开发者附录

### 支持的图片格式

JPG · PNG · WebP · TIFF

### API 端点

| 路由 | 说明 |
---|---
| `GET /` | 前端页面 |
| `GET /view/:path` | 可刷新查看器路由 |
| `GET /api/config` | 前端配置 |
| `GET /api/photos?sort=` | 照片列表 JSON |
| `GET /photos/:path` | 原图 |
| `GET /thumb/:path` | 缩略图 |
| `GET /preview/:path` | 预览图 |
| `POST /api/stage` | 暂存文件操作 |
| `POST /api/stage/apply` | 应用暂存操作 |
| `GET /api/trash/list` | 回收站列表 |
| `GET /api/hash/:path` | 计算 SHA256 和感知哈希 |
| `GET /api/compare?a=&b=` | 对比两张照片 |
| `GET /api/similar?threshold=&limit=&max_photos=` | 扫描当前照片目录，查找相似照片 |
| `POST /api/similar/jobs?threshold=&limit=&max_photos=` | 创建后台相似照片扫描任务 |
| `GET /api/similar/jobs/:id` | 查看后台扫描进度和结果 |
| `POST /api/exif/update` | 保存手动 EXIF 覆盖值 |

`sort` 可选值：

```text
date-asc / date-desc / name-asc / name-desc / size-desc
```

查看器路由会把当前状态写入 URL 查询参数，例如 `sort`、`view`、`scale`、`q`、`collapse`、`open`、`closed`。

### 本地开发

```bash
cargo check
cargo build
PHOTOS_DIR=/path/to/photos PORT=3000 cargo run
```

构建 release：

```bash
cargo build --release
PHOTOS_DIR=/path/to/photos PORT=3000 ./target/release/photo-viewer
```

### 构建镜像

```bash
podman build -t photo-viewer .
```

Docker 用户：

```bash
docker build -t photo-viewer .
```

### Containerfile 说明

镜像是多阶段构建：

- builder 阶段基于 Rust 镜像编译程序。
- runtime 阶段基于 `debian:bookworm-slim`，只放运行所需文件。
- 静态前端资源会编译进二进制，运行时不需要单独挂载 `static/`。

镜像默认值：

```text
PHOTOS_DIR=/photos
PORT=80
HOST=0.0.0.0
READ_ONLY=false
```

### 项目结构

```text
photo-viewer/
├── Containerfile
├── Cargo.toml
├── Cargo.lock
├── photo-viewer-pod.yaml
├── src/
│   ├── main.rs
│   ├── lib.rs
│   ├── models.rs
│   ├── handlers.rs
│   ├── file_ops.rs
│   ├── exif.rs
│   ├── exif_edit.rs
│   ├── hash.rs
│   └── utils.rs
└── static/
    ├── index.html
    ├── css/
    └── js/
```

### 技术栈

后端：

- Rust
- Axum
- Tokio
- Rayon
- rust-embed
- image
- kamadak-exif

前端：

- 原生 HTML / CSS / JavaScript
- ES Modules
- 虚拟滚动
- 智能图片加载队列

### 性能设计

- 图片列表扫描时按 `mtime` 和 `size` 缓存 EXIF 元数据。
- 相似照片扫描会复用照片目录扫描逻辑，并把结果写入后台任务进度。
- 如设置 `PHASH_WARMUP=true`，打开照片列表后会复用同一次目录扫描结果，在后台预热相似照片所需的感知哈希缓存；默认关闭，避免普通浏览时持续读取原图。
- 相似照片扫描时按 `mtime` 和 `size` 复用感知哈希，缓存文件为 `.photo_viewer_hash_cache.json`。
- 首次计算感知哈希时会用有限并发加速，默认 `SIMILAR_SCAN_WORKERS=4`；如果缩略图已经在内存缓存中，会优先用缩略图计算，减少原图解码成本。
- 缩略图和预览图会缓存在内存中。
- 前端使用 Intersection Observer，只加载接近视口的图片。
- 图片加载队列限制并发，避免浏览器一次性加载太多图片。
- 静态资源通过 `rust-embed` 编译进二进制。
