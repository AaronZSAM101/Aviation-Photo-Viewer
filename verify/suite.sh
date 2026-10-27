#!/usr/bin/env bash
# 一键验证：起临时实例 → 播种测试库 → 跑核心套件 → 清理。
#
#   ./verify/suite.sh                                   # 验 latest 镜像
#   ./verify/suite.sh localhost/photo-viewer:mobile6     # 指哪个镜像验哪个
#   LIB=/path/to/Aviation ./verify/suite.sh              # 换真实图库路径
#
# 安全边界：
#   - 只用 3901/3902/3903 三个临时端口，绝不碰 3000 端口的生产实例；
#   - 真实图库以 :ro 挂载，只用于浏览/渲染类断言和抽一小份样本库；
#   - 所有写操作发生在 verify/.scratch 下的临时卷，跑完即删。
# macOS 注意：Podman 虚拟机没共享 /tmp，临时卷必须放在仓库目录内。
set -uo pipefail

IMAGE=${1:-localhost/photo-viewer:latest}
CHROME=${CHROME:-docker.io/zenika/alpine-chrome:with-node}
LIB=${LIB:-"$HOME/Library/CloudStorage/SynologyDrive-Photos/Photos/Aviation"}
RO_PORT=${RO_PORT:-3901}
RW_PORT=${RW_PORT:-3902}
SIM_PORT=${SIM_PORT:-3903}
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRATCH="$HERE/.scratch"
OUT="$HERE/out"
FAILED=""

log() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
app_ip() { podman inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$1"; }

# Windows 上的 podman.exe 只认宿主原生路径（D:\...），而 Git Bash 会把 /d/... 这类
# 参数"好心"改写坏（实测报 invalid option type "\\Git\\work"）。所以挂载源一律先转成
# 宿主路径，并关掉 MSYS 的自动转换；macOS/Linux 上 hp 就是原样返回。
export MSYS_NO_PATHCONV=1
hp() { command -v cygpath >/dev/null 2>&1 && cygpath -w "$1" || printf '%s' "$1"; }

# Windows 上可写临时库必须放进 machine 自己的卷：seed.mjs 要给样本照片铺 mtime（P1..P6 落在
# 2024-01-02..07，时间分组断言靠它），而 NTFS 经 podman machine 挂进容器后 utimes 一律
# EPERM。macOS/Linux 维持原样，仍然是仓库里的 .scratch 目录，方便直接在磁盘上看证据。
if command -v cygpath >/dev/null 2>&1; then
  PHOTOS_VOL=pv-verify-photos
  PROBE_VOL=pv-verify-probe
else
  PHOTOS_VOL=
  PROBE_VOL=
fi
photos_src() { [ -n "$PHOTOS_VOL" ] && printf '%s' "$PHOTOS_VOL" || hp "$SCRATCH/photos"; }
probe_src() { [ -n "$PROBE_VOL" ] && printf '%s' "$PROBE_VOL" || hp "$SCRATCH/probe/photos"; }
# 套件容器里 node 跑在 alpine-chrome 的 chrome 用户下，而应用容器是 root：它建出来的
# .trash / .photo_viewer 是 755，unlink 要父目录写权限，seed.mjs 清场直接 EACCES。
# umask 000 让应用落的目录天生 777。macOS/Linux 挂的是宿主用户自己的目录，本来就可删，不动。
APP_LAUNCH=("$IMAGE")
if command -v cygpath >/dev/null 2>&1; then
  APP_LAUNCH=(--entrypoint /bin/sh "$IMAGE" -c 'umask 000; exec photo-viewer')
fi
fresh_vols() {
  [ -z "$PHOTOS_VOL" ] && return 0
  podman volume rm -f "$PHOTOS_VOL" "$PROBE_VOL" >/dev/null 2>&1
  podman volume create "$PHOTOS_VOL" >/dev/null || return 1
  podman volume create "$PROBE_VOL" >/dev/null || return 1
  # 卷根默认归 root，而 seed.mjs 跑在 zenika/alpine-chrome 里、那镜像用非 root 的 chrome
  # 用户起 node，mkdir 直接 EACCES。仓库目录在 macOS 上是宿主用户属主，所以没这问题。
  podman run --rm -v "$PHOTOS_VOL:/d:rw" --entrypoint chmod "$IMAGE" -R 777 /d >/dev/null 2>&1
  podman run --rm -v "$PROBE_VOL:/d:rw" --entrypoint chmod "$IMAGE" -R 777 /d >/dev/null 2>&1
}

# 在 chrome 容器里跑一个套件：挂载 verify/ 自身，puppeteer-core 来自 verify/node_modules。
# $1=容器名后缀 $2=脚本 $3=允许的 FAIL 条数 $4..=额外的 podman 参数（一般是 -e）
run_suite() {
  local tag=$1 script=$2 allow=$3; shift 3
  local raw="$OUT/$tag.log"
  log "$script"
  podman run --rm --name "pv-verify-$tag" --shm-size=1g --network podman \
    -v "$(hp "$HERE"):/work" -w /work \
    -e CHROME_PATH=/usr/lib/chromium/chromium -e OUT_DIR=/work/out \
    "$@" --entrypoint node "$CHROME" "$script" 2>&1 \
    | tee "$raw" | grep -E '^(PASS|FAIL)|passed|total=' | sed 's/^/  /'
  local code=${PIPESTATUS[0]}
  # 套件正常会自己关浏览器；超时或异常时容器会挂着，这里兜底收掉
  podman rm -f "pv-verify-$tag" >/dev/null 2>&1
  local fails
  fails=0
  [ -f "$raw" ] && fails=$(grep -c '^FAIL ' "$raw" || true)
  [ -z "$fails" ] && fails=0
  if [ "$fails" -gt "$allow" ]; then
    echo "  !! $script 有 $fails 条 FAIL（允许 $allow），完整日志 $raw"
    FAILED="$FAILED $script"
  elif [ "$code" -ne 0 ] && [ "$fails" -eq 0 ]; then
    echo "  !! $script 退出码 $code 却没有一条 FAIL，脚本自己挂了，完整日志 $raw"
    FAILED="$FAILED $script(退出码)"
  elif [ "$code" -ne 0 ]; then
    echo "  （$script 因为 $fails 条 FAIL 以非 0 退出，在允许的 $allow 条以内）"
  fi
}

# parity 会把 P1.jpg 改名、把 P2/P3/P4 送进回收站，后面的套件必须看到干净的库
seed() {
  podman run --rm --shm-size=1g --network podman \
    -v "$(photos_src):/verify-photos:rw" -v "$(hp "$HERE"):/work" -w /work \
    -e WRITE_IP="$RW_IP" -e CHROME_PATH=/usr/lib/chromium/chromium \
    --entrypoint node "$CHROME" seed.mjs 2>&1 | sed 's/^/  /'
}

# 相似对比要在真实库上算 1 分钟指纹，所以给它一份从真实库抽出来的样本库：
# probe-manifest.txt 里的 14 张小原图 + 前 4 张的副本，副本用来保证一定有"疑似同一张"的结果。
seed_probe() {
  [ -n "$PHOTOS_VOL" ] || mkdir -p "$SCRATCH/probe/photos"
  local files=()
  while IFS= read -r line; do
    [ -n "$line" ] && files+=("$line")
  done < "$HERE/probe-manifest.txt"
  podman run --rm --security-opt label=disable \
    -v "$(hp "$LIB"):/src:ro" -v "$(probe_src):/probe-photos" \
    --entrypoint /bin/sh "$IMAGE" -c '
      set -e
      mkdir -p /probe-photos/ProbeA /probe-photos/ProbeB
      for f in "$@"; do cp "/src/$f" "/probe-photos/ProbeA/$(basename "$f")"; done
      i=0
      for f in "$@"; do
        i=$((i + 1))
        [ "$i" -le 4 ] && cp "/src/$f" "/probe-photos/ProbeB/dup-$i.jpg"
      done
      echo "样本照片 $(find /probe-photos -name "*.jpg" | wc -l) 张"
    ' _ "${files[@]}" 2>&1 | sed 's/^/  /'
}

cleanup() {
  log "清理临时实例"
  podman ps -a --format '{{.Names}}' | grep '^pv-verify-' | xargs -r podman rm -f >/dev/null 2>&1
  [ -z "$PHOTOS_VOL" ] || podman volume rm -f "$PHOTOS_VOL" "$PROBE_VOL" >/dev/null 2>&1
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

[ -d "$LIB" ] || { echo "找不到图库：$LIB（用 LIB=... 指定）"; exit 2; }
[ -d "$HERE/node_modules/puppeteer-core" ] || {
  echo "缺少依赖，先装一次："
  echo "  podman run --rm --security-opt label=disable --dns=8.8.8.8 --dns=1.1.1.1 \\"
  echo "    -v \"$HERE:/work\" -w /work --entrypoint npm docker.io/library/node:22-alpine ci --no-audit --no-fund"
  exit 2
}

log "起临时实例（$IMAGE）"
mkdir -p "$OUT"
# 给这一轮盖个时间戳：out/ 里留着上一轮的日志，看板得能分辨哪些属于正在跑的这轮
date +%s > "$OUT/run-start"
[ -d "$HERE/../frontend/node_modules/vitest" ] && {
  log "前端单元测试（vitest）"
  # 用 ./node_modules/.bin/vitest 而不是 `npm run test`：npm 以 root 进容器时会把脚本
  # 降到挂载目录的宿主 uid，而 virtiofs 只把写权限给了 root，mkdir node_modules/.vitest-daemon 直接 EACCES。
  podman run --rm --security-opt label=disable \
    -v "$(hp "$(cd "$HERE/../frontend" && pwd)"):/work" -w /work --entrypoint ./node_modules/.bin/vitest \
    docker.io/library/node:22-alpine run 2>&1 | tee "$OUT/unit.log" \
    | grep -E 'Test Files|Tests  |FAIL' | sed 's/^/  /'
  grep -q 'Test Files.*failed' "$OUT/unit.log" && {
    echo "  !! 单元测试失败，完整日志 $OUT/unit.log"
    FAILED="$FAILED unit"
  }
}

# 必须显式 --network podman：不给网络参数时，podman 5+ 在 rootless machine 上默认走
# pasta（容器拿到 192.168.49.x 的 NAT 地址，不接受入站），浏览器容器就怎么也连不上应用
# 容器；macOS 上默认本来就是这张 bridge，写死它是无害的。
podman ps -a --format '{{.Names}}' | grep '^pv-verify-' | xargs -r podman rm -f >/dev/null 2>&1
fresh_vols || exit 2
[ -n "$PHOTOS_VOL" ] || mkdir -p "$SCRATCH/photos"
podman run -d --name pv-verify-ro --network podman --security-opt label=disable -p "$RO_PORT:80" \
  -e READ_ONLY=true -e PHASH_WARMUP=false -v "$(hp "$LIB"):/photos:ro" "${APP_LAUNCH[@]}" >/dev/null || exit 2
podman run -d --name pv-verify-rw --network podman --security-opt label=disable -p "$RW_PORT:80" \
  -e READ_ONLY=false -e PHASH_WARMUP=false -v "$(photos_src):/photos:rw" "${APP_LAUNCH[@]}" >/dev/null || exit 2
seed_probe
podman run -d --name pv-verify-sim --network podman --security-opt label=disable -p "$SIM_PORT:80" \
  -e READ_ONLY=false -e PHASH_WARMUP=false -v "$(probe_src):/photos:rw" "${APP_LAUNCH[@]}" >/dev/null || exit 2
for _ in $(seq 1 40); do
  # Windows 上 localhost 会先解析到 ::1，而 win-ports 只转发了 IPv4 → 一律写 127.0.0.1
  curl -sf -o /dev/null "127.0.0.1:$RO_PORT/api/config" \
  && curl -sf -o /dev/null "127.0.0.1:$RW_PORT/api/config" \
  && curl -sf -o /dev/null "127.0.0.1:$SIM_PORT/api/config" && break
  sleep 1
done
RO_IP=$(app_ip pv-verify-ro)
RW_IP=$(app_ip pv-verify-rw)
SIM_IP=$(app_ip pv-verify-sim)
echo "只读 $RO_IP:$RO_PORT（真实库 $LIB，浏览类断言）"
echo "可写 $RW_IP:$RW_PORT（临时库 $SCRATCH/photos，写操作类断言）"
echo "样本 $SIM_IP:$SIM_PORT（18 张，相似对比断言）"
curl -s "127.0.0.1:$RW_PORT/api/config" | sed 's/^/  /'

log "播种 9 张测试照片（ParitySeed / ParitySeed2）"
seed

run_suite parity parity.mjs 0 -e READ_BASE="http://$RO_IP" -e WRITE_BASE="http://$RW_IP"
seed
run_suite batch4 batch4-ui.mjs 0 -e WRITE_BASE="http://$RW_IP"
seed
run_suite conflict conflict-ui.mjs 0 -e WRITE_BASE="http://$RW_IP"

# 手机视口只做浏览类断言，打真实库的只读实例；3 条 FAIL 是只读模式按设计隐藏的 3 个管理入口
log "重新播种，把临时库恢复干净"
seed
run_suite mobile mobile-ui.mjs 3 -e BASE="http://$RO_IP"

# 相似对比走独立样本实例，前面几个套件的改名/删除不会影响它
run_suite similar similar.mjs 0 -e BASE="http://$SIM_IP"

# 彩绘提醒：临时实例都不给 AIRFRAME_URL，验的是「没配数据源时怎么说」+ 关注表读写闭环
run_suite livery livery.mjs 0 -e BASE="http://$RW_IP" -e RO_BASE="http://$RO_IP"

log "结果"
if [ -z "$FAILED" ]; then
  echo "  全部套件通过；逐条结果与截图在 $OUT/"
else
  echo "  失败：$FAILED"
  echo "  完整日志在 $OUT/*.log"
  exit 1
fi
