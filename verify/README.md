# 验证脚本（verify/）

这些脚本是本次重构的验收工具：改完前后端，跑一遍就知道有没有把已交付的行为弄坏。
它们不进镜像（`.containerignore` 已排除 `verify/node_modules`、`verify/out`、`verify/.scratch`），
但脚本本身必须和代码一起演进 —— 断言过时了要改断言，新增功能要补断言。

全部脚本都在 Podman 容器里跑无头 Chromium，不装任何本机依赖，也不会碰 3000 端口的生产实例。

## 一键跑

```bash
./verify/suite.sh                                 # 验 localhost/photo-viewer:latest
./verify/suite.sh localhost/photo-viewer:mobile6  # 指哪个镜像验哪个
LIB=/path/to/Aviation ./verify/suite.sh           # 换真实图库路径
```

流程：单元测试 → 起三个临时实例 → 播种测试照片 → 跑核心套件（每个会改库的套件前重新播种）→ 清理容器和临时卷。

- `pv-verify-ro`（宿主 3901）：真实图库以 **:ro** 挂载，`READ_ONLY=true`。只用于浏览/渲染类断言。
- `pv-verify-rw`（宿主 3902）：`verify/.scratch/photos` 临时卷，可写。所有删除、移动、覆盖都落在这里，跑完即删。
- `pv-verify-sim`（宿主 3903）：`verify/.scratch/probe/photos` 样本卷，18 张小原图（`probe-manifest.txt` 从真实库挑的，套件里只读抽取），相似对比用它，避免在 2939 张的真实库上等一分钟。
- 浏览器容器：`docker.io/zenika/alpine-chrome:with-node`，`--entrypoint node`，靠 `--network podman` 直接访问上面两个实例的 IP。
- 每个套件的完整原始输出落在 `verify/out/<tag>.log`，屏幕上只留 `PASS` / `FAIL` / 汇总行；任一套件超出允许的 FAIL 数就以退出码 1 结束。

安全边界：绝不使用 3000；真实图库永远只读；写操作的证据留在 `verify/out/`（截图 + JSON，已 gitignore）。

## 先装一次依赖

`verify/node_modules` 只被 `puppeteer-core` 用到，装一次就够（仓库里不入库）。

```bash
cd verify
podman run --rm --security-opt label=disable --dns=8.8.8.8 --dns=1.1.1.1 \
  -v "$PWD:/work" -w /work --entrypoint npm \
  docker.io/library/node:22-alpine ci --no-audit --no-fund
```

注意 `--entrypoint` 要写成要执行的命令本身：`--entrypoint node ... npm ci` 会让 node 去找一个叫 `npm` 的脚本文件，直接 `MODULE_NOT_FOUND`。跑套件时才用 `--entrypoint node <script>.mjs`。

## 单独跑某个套件

```bash
cd verify
podman run --rm --name pv-verify-manual --shm-size=1g --network podman \
  -v "$PWD:/work" -w /work \
  -e CHROME_PATH=/usr/lib/chromium/chromium -e OUT_DIR=/work/out \
  -e READ_BASE="http://10.88.0.121" -e WRITE_BASE="http://10.88.0.122" \
  --entrypoint node docker.io/zenika/alpine-chrome:with-node parity.mjs
podman rm -f pv-verify-manual   # parity 跑完不关浏览器，必须手动收
```

实例 IP 用 `podman inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' pv-verify-ro` 查。

## 套件清单

核心六件（`suite.sh` 覆盖）：

| 脚本 | 覆盖范围 | 预期 |
| --- | --- | --- |
| `parity.mjs` | 功能对等全链路：列表/分组/搜索/查看器/暂存/应用/回收站/恢复/EXIF 编辑，读写两个实例交叉验证 | 29/29 |
| `batch4-ui.mjs` | 顶栏整理、搜索去空白、查看器身份与按键作用域、只读刷新、扫描告警 | 16/16 |
| `conflict-ui.mjs` | 分批应用遇到覆盖冲突时，界面指出源与目标，操作仍留在队列里 | 8/8 |
| `mobile-ui.mjs` | 393×852 手机视口的溢出/遮挡量化 + 截图，只做浏览类操作 | 可写 30/30；只读 27/30（3 项是管理入口，按设计隐藏） |
| `similar.mjs` | 相似对比：3903 上独立样本实例（`probe-manifest.txt` 的 14 张真实原图 + 4 个副本），断言模态框报出 ≥4 组 | 1/1 |
| `livery.mjs` | 彩绘提醒：`/api/config`、`/api/livery/{watch,watch/delete,feed}` 的契约（含机场/日期输入的 400），关注表在界面里的增删与点机号跳搜索，窄屏「更多」里的入口 | 12/12 |

`livery.mjs` 打的两个临时实例都**不配** `AIRFRAME_URL` / `LIVERY_FEED_URL`：排班数据源在别人家的机器上，验收套件既不能依赖它在线，也不该替相册去敲那个接口。所以这里断言的是「没配数据源时接口和界面怎么说」，真正连通数据源的那条路径靠后端的 `cargo test` 和手工 `prod-smoke` 覆盖。

独立探针（自己起实例，不进 `suite.sh`）：

| 脚本 | 覆盖范围 |
| --- | --- |
| `raw-probe.sh` | P2-4 RAW：用 exiftool 造三张合成 `.CR2`（带内嵌图 / 纯垃圾字节 / JPEG 改名），断言取内嵌图、422 不 500、按内容兜底解码三条分支；只监听 3905 |
| `heights.mjs` | 列表窗口化（P2-5）：滚动时量 DOM 行数、占位高度与真实卡片高度是否一致 |
| `launch-probe.mjs` | 拉起脚本的自检：容器起来后 `/api/config` 的版本与模式是否符合预期 |

后端写路径的定向脚本（要自己起可写实例，`HOST_IP`/`PHOTOS_ROOT`/`WRITE_IP` 指过去）：
| 脚本 | 覆盖范围 |
| --- | --- |
| `seed.mjs` | 往测试卷铺 9 张有效 JPEG（`ParitySeed`、`ParitySeed2`），写流程的前置 |
| `batch2.mjs` | 批次结果逐条上报、manifest 写失败不丢文件、陈旧映射自愈、并发 apply 不丢映射 |
| `batch3.mjs` | 路径边界（保留目录、符号链接逃逸、暂存/执行两道校验）、运行时切库、缓存写回新库 |
| `overwrite.mjs` | 覆盖语义：默认拒绝覆盖、批次同目标、执行时目标出现、无半成品残留 |
| `readonly.mjs` | 只读实例查询不写盘，回收站列表照常可用 |
| `trash-race.mjs` | apply 尚未落盘时立刻读回收站列表，映射是否丢 |
| `restore-ui.mjs` / `restore-apply-ui.mjs` | 回收站“恢复”是否真的进队列、点“应用”后返回什么 |
| `delete-ui-path.mjs` / `viewer-delete.mjs` | 复现查看器删除，逐步打印 `/api/stage*` 与队列/回收站状态 |
| `reset.mjs` | 把回收站里的照片全部恢复回库、清空队列并刷新缓存（重置测试卷） |
| `state.mjs` | 打印 stage/trash/photos 摘要，诊断用，不做判定 |
| `smoke.mjs` | 首页、JS/CSS 资源、`/api/photos` 与深层 `/view/<folder>/<file>` 路由是否都通 |
| `boot.mjs` | 多实例横向对比：卡片数、查看器、模态框、控制台报错 |

性能探针与附加检查（只读浏览，不改数据）：

| 脚本 | 用途 | 关键环境变量 |
| --- | --- | --- |
| `prod-smoke.mjs` | 对 3000 生产实例做只读冒烟：版本、模式、缩略图、搜索、查看器 | `BASE`、`EXPECT_VERSION` |
| `perf-render.mjs` | 手机视口 + CPU 节流下的首屏阻塞、滚动掉帧、CLS | `BASE`、`THROTTLE`、`EXPECT_CARDS`、`BLOCK_THUMBS`、`SCROLL_STEPS` |
| `perf-click.mjs` | 勾选/翻页时整页重渲染代价（含 CDP 输入开销） | `BASE`、`THROTTLE` |
| `perf-click2.mjs` | 页面内测量，去掉 CDP 开销，看 React 提交与绘制耗时 | `BASE`、`THROTTLE` |
| `summarize.py` | 把 `perf-render` 的 JSON 压成一行，便于 A/B 对比 | 标准输入 |

## 这些脚本之外还有两层更快的检查

```bash
cd backend && cargo test      # 后端纯逻辑，60 条（含彩绘分类、机号规整、拍摄点档案）
cd frontend && npm test       # 前端 utils：分组/路径/分批状态/格式化/搜索/窗口化/拍摄点/彩绘，98 条
```

`suite.sh` 会把前端单元测试放在最前面跑（装了 vitest 才跑，没装就跳过）。
GitHub Actions 的 `.github/workflows/test.yml` 只跑这两层加一次 `npm run build` —— 端到端套件要真实图库和 Podman，CI 里跑不了。

## 已知坑

- **套件之间必须重新播种。** `parity.mjs` 会把 `ParitySeed/P1.jpg` 改名成 `PVPBXDXP_RENAMED.jpg`、把 P2/P3/P4 送进回收站，`batch4-ui.mjs` 又要在库里搜 `P1`。共用一个可写实例而不重新 `seed`，后面的套件就会看到 0 张结果 —— `suite.sh` 因此在每个套件前都 seed 一次。
- **`parity.mjs` 的总数从 `/api/photos` 现取，不写死张数。** 前端按帧分批挂载，脚本会等卡片补齐再断言；`LIB` 仍要指向真实的 Aviation 库，因为搜索、GPS 深链和 `probe-manifest.txt` 都依赖真数据的形状。另注意扫描只下降到 3 层目录（`backend/src/utils.rs` 里的 `collect_photo_paths`），更深的路径不进列表，所以「库里有 N 张」和「列表有 M 张」可以不一样。
- **只读实例的 EXIF 只在内存里。** `READ_ONLY=true` 不落盘，全新图库（库里没有 `.photo_viewer/meta.json`）刚起来那几分钟「N 张含EXIF」远小于总数，stats 文案和查看器信息面板都会红。`parity.mjs` 因此先等两个数追平再断言（`EXIF_WARM_TIMEOUT`，默认 25 分钟）。macOS 上生产实例早就把 meta 写进图库目录，所以一上来就是满的。
- **`parity.mjs` 会开两个浏览器**（只读实例一个、可写实例一个）。脚本结束时都会关掉，但如果中途超时或被 Ctrl-C，容器会挂着，用 `podman rm -f pv-verify-parity` 收掉。
- **macOS 上 `/tmp` 没有共享进 Podman 虚拟机。** 临时卷必须放在仓库目录内（`verify/.scratch`），否则容器里 `statfs` 直接报 no such file or directory。
- **Windows（podman machine + Git Bash）另有一层坑，`suite.sh` 里用 `command -v cygpath` 与 macOS 分支隔开：**
  - 挂载源必须是宿主原生路径（`D:\...`）。Git Bash 会把 `/d/...` 这类参数改写坏，podman 报 `invalid option type "\\Git\\work"` → 全程 `MSYS_NO_PATHCONV=1` + `cygpath -w`（`hp()`）。
  - `localhost` 先解析到 `::1`，而 win-ports 只转发 IPv4 → 健康检查一律写 `127.0.0.1`。
  - 不显式给 `--network` 时 rootless machine 默认走 pasta（容器拿 NAT 地址、不收入站），浏览器容器怎么都连不上应用容器 → 三个实例都 `--network podman`，靠容器 IP 互访。
  - NTFS 挂进容器后 `utimes` 一律 EPERM，而 `seed.mjs` 要给样本照片铺 mtime（时间分组断言靠它）→ 可写临时库改放 machine 自己的命名卷 `pv-verify-photos` / `pv-verify-probe`。
  - 命名卷根目录归 root，而套件容器里的 node 跑在 alpine-chrome 的 `chrome`（uid 1000）下 → `fresh_vols` 先 chmod 777；应用容器（root）建出来的 `.trash`、`.photo_viewer` 默认 755，`unlink` 要父目录写权限，`seed.mjs` 清场会 EACCES → Windows 上应用容器统一 `umask 000` 起（`APP_LAUNCH`）。
  - `core.autocrlf=true` 会把 `probe-manifest.txt` 变成 CRLF，14 条路径统统“文件不存在” → 仓库加了 `.gitattributes` 把这些文件钉成 LF。
- **`probe-manifest.txt` 挑的是真实库里 14 张小原图**，如果这些文件被改名或删掉，`seed_probe` 会直接报错退出（相似对比就没有可断言的对象）。换一个库时按同样的思路重挑一份小的即可。
- **不要把宿主目录挂到容器里的 `/lib`、`/usr` 这类路径。** podman 会报 `exec container process (missing dynamic library?) /bin/sh: No such file or directory`，看着像镜像坏了，其实是挂载点盖掉了 glibc。换 `/src` 之类的路径就好。
- **DNS。** 地图瓦片、`npm ci` 需要 `--dns=8.8.8.8 --dns=1.1.1.1`，虚拟机默认解析器会超时。
- **SELinux 标签。** 挂载宿主目录的实例要 `--security-opt label=disable`，否则读不到图库。
- **antd v6 的提示是 `.ant-message-notice`**，不是 `.ant-notification`；选择器写错会误判成“没弹提示”。
- **查看器的键盘快捷键在输入框聚焦时不生效**（设计如此）。脚本要先 `blur` 或点空白，否则按键断言假失败。
- **`#loading` 在列表到达后 300 ms 才隐藏**，卡片随后按帧挂载。等 `#loading:not(.show)` 只是首屏完成，卡片数要另外等。
- **分批队列的两端都是异步的，别用固定 sleep。** 「恢复」只是往队列 POST 一条 op，机器忙（同一台机上只读实例正在给全库提 EXIF）时 POST 还没落地就点「应用」，应用在空队列上返回 `applied:0`，那条 op 随后才进队列 —— 断言就看到「恢复没生效、文件回不来」。`applyStaged` 因此先等队列里真的有这条 restore、应用后再轮询到队列清空（`parity.mjs` 的 `viewer delete -> staged pill -> apply -> trash -> restore`）。
- **`LiveryModal` 点机号会 `onClose()`**（跳相册是既定行为，不是 bug），所以 `livery.mjs` 里点完机号要重新打开提醒面板才点得到「删」，否则在已经卸载的 DOM 里找不到那一行。
- **FUSE 图库慢。** 真实库经 Synology Drive 挂载，首次扫描和缩略图很慢；判断“卡住”前先看 `/api/config` 是否已返回。
- **性能数字有噪声。** 本机跑别的容器（例如 `webaip-pod`）会污染结果，A/B 要交替重复多次，别只看单次滚动均值。

## 加断言的规矩

- 断言要能被下一次改动检验：改行为就改断言，但要在提交说明里写清为什么改。
- 写操作只落在 `verify/.scratch` 或自建测试卷，**永远不要对着真实图库跑写断言**。
- 新脚本进这张表，同时更新 `suite.sh`，别留只在个人机器上能跑的验证。
