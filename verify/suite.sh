#!/usr/bin/env bash
# 一键验证：起临时实例 → 播种测试库 → 跑核心套件 → 清理。
#
#   ./verify/suite.sh                                   # 验 latest 镜像
#   ./verify/suite.sh localhost/photo-viewer:mobile6     # 指哪个镜像验哪个
#   LIB=/path/to/Aviation ./verify/suite.sh              # 换真实图库路径
#
# 安全边界：
#   - 只用 3901/3902 两个临时端口，绝不碰 3000 端口的生产实例；
#   - 真实图库以 :ro 挂载，只用于浏览/渲染类断言；
#   - 所有写操作发生在 verify/.scratch 下的临时卷，跑完即删。
# macOS 注意：Podman 虚拟机没共享 /tmp，临时卷必须放在仓库目录内。
set -uo pipefail

IMAGE=${1:-localhost/photo-viewer:latest}
CHROME=${CHROME:-docker.io/zenika/alpine-chrome:with-node}
LIB=${LIB:-"$HOME/Library/CloudStorage/SynologyDrive-Photos/Photos/Aviation"}
RO_PORT=${RO_PORT:-3901}
RW_PORT=${RW_PORT:-3902}
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRATCH="$HERE/.scratch"
OUT="$HERE/out"
FAILED=""

log() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
app_ip() { podman inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$1"; }

# 在 chrome 容器里跑一个套件：挂载 verify/ 自身，puppeteer-core 来自 verify/node_modules。
# $1=容器名后缀 $2=脚本 $3=允许的 FAIL 条数 $4..=额外的 podman 参数（一般是 -e）
run_suite() {
  local tag=$1 script=$2 allow=$3; shift 3
  local raw="$OUT/$tag.log"
  log "$script"
  podman run --rm --name "pv-verify-$tag" --shm-size=1g --network podman \
    -v "$HERE:/work" -w /work \
    -e CHROME_PATH=/usr/lib/chromium/chromium -e OUT_DIR=/work/out \
    "$@" --entrypoint node "$CHROME" "$script" 2>&1 \
    | tee "$raw" | grep -E '^(PASS|FAIL)|passed|total=' | sed 's/^/  /'
  local code=${PIPESTATUS[0]}
  # 套件正常会自己关浏览器；超时或异常时容器会挂着，这里兜底收掉
  podman rm -f "pv-verify-$tag" >/dev/null 2>&1
  local fails
  fails=0
  [ -f "$raw" ] && fails=$(grep -c '^FAIL' "$raw" || true)
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
    -v "$SCRATCH/photos:/verify-photos:rw" -v "$HERE:/work" -w /work \
    -e WRITE_IP="$RW_IP" -e CHROME_PATH=/usr/lib/chromium/chromium \
    --entrypoint node "$CHROME" seed.mjs 2>&1 | sed 's/^/  /'
}

cleanup() {
  log "清理临时实例"
  podman ps -a --format '{{.Names}}' | grep '^pv-verify-' | xargs -r podman rm -f >/dev/null 2>&1
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
[ -d "$HERE/../frontend/node_modules/vitest" ] && {
  log "前端单元测试（vitest）"
  podman run --rm --security-opt label=disable \
    -v "$HERE/../frontend:/work" -w /work --entrypoint npm \
    docker.io/library/node:22-alpine run test 2>&1 | tee "$OUT/unit.log" \
    | grep -E 'Test Files|Tests  |FAIL' | sed 's/^/  /'
  grep -q 'Test Files.*failed' "$OUT/unit.log" && {
    echo "  !! 单元测试失败，完整日志 $OUT/unit.log"
    FAILED="$FAILED unit"
  }
}

podman ps -a --format '{{.Names}}' | grep '^pv-verify-' | xargs -r podman rm -f >/dev/null 2>&1
mkdir -p "$SCRATCH/photos"
podman run -d --name pv-verify-ro --security-opt label=disable -p "$RO_PORT:80" \
  -e READ_ONLY=true -e PHASH_WARMUP=false -v "$LIB:/photos:ro" "$IMAGE" >/dev/null || exit 2
podman run -d --name pv-verify-rw --security-opt label=disable -p "$RW_PORT:80" \
  -e READ_ONLY=false -e PHASH_WARMUP=false -v "$SCRATCH/photos:/photos:rw" "$IMAGE" >/dev/null || exit 2
for _ in $(seq 1 40); do
  curl -sf -o /dev/null "localhost:$RO_PORT/api/config" && curl -sf -o /dev/null "localhost:$RW_PORT/api/config" && break
  sleep 1
done
RO_IP=$(app_ip pv-verify-ro)
RW_IP=$(app_ip pv-verify-rw)
echo "只读 $RO_IP:$RO_PORT（真实库 $LIB，浏览类断言）"
echo "可写 $RW_IP:$RW_PORT（临时库 $SCRATCH/photos，写操作类断言）"
curl -s "localhost:$RW_PORT/api/config" | sed 's/^/  /'

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

log "结果"
if [ -z "$FAILED" ]; then
  echo "  全部套件通过；逐条结果与截图在 $OUT/"
else
  echo "  失败：$FAILED"
  echo "  完整日志在 $OUT/*.log"
  exit 1
fi
