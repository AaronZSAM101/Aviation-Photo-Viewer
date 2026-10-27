#!/usr/bin/env bash
# P2-4 RAW 分支探针。
#
#   IMAGE=localhost/photo-viewer:p2c ./verify/raw-probe.sh
#
# 为什么是“合成 RAW”：这台机器上能找到的 CR2/DNG 都在云盘里且是没下载的占位文件，
# 读第一个字节就超时，拿不到真样本。exiftool 又不肯把 PreviewImage 写进 JPEG 容器
# （只有 TIFF/RAW 才支持那个标签），但它肯写 ThumbnailImage —— 而本项目取内嵌图正是
# 先 PreviewImage、拿不到再 ThumbnailImage，所以用 ThumbnailImage 造样本能覆盖到
# 同一条“起 exiftool 取字节 → image 解码”的代码路径。三张样本各管一段：
#   IMG_0001.CR2  带内嵌图（走 exiftool 提取）
#   IMG_0002.CR2  纯垃圾字节（走“读不出就 422”，不能 500、不能拖垮扫描）
#   IMG_0003.CR2  普通 JPEG 改名（走按文件内容兜底的解码分支）
# 它不证明 exiftool 对某个具体机型的解析能力；真机 RAW 进图库后请再跑一次本脚本
# （把 SRC 换成真实文件即可，断言不用改）。
#
# 安全边界：只在 verify/.scratch/raw 里造文件，只监听 3905，绝不碰 3000。
set -uo pipefail

IMAGE=${IMAGE:-localhost/photo-viewer:latest}
PORT=${PORT:-3905}
NAME=pv-raw-probe
HERE="$(cd "$(dirname "$0")" && pwd)"
LIB=${LIB:-"$HOME/Library/CloudStorage/SynologyDrive-Photos/Photos/Aviation"}
RAW="$HERE/.scratch/raw/photos"
FAILS=0

say() { printf '\033[1m== %s\033[0m\n' "$*"; }
ok() { printf '  PASS %s\n' "$1"; }
bad() { printf '  FAIL %s\n' "$1"; FAILS=$((FAILS + 1)); }
http() { curl -s -o "$2" -w '%{http_code} %{content_type} %{size_download}' "$1"; }

# Windows(Git Bash) 的 podman.exe 只认宿主原生路径，MSYS 会把 /d/... 改写坏
export MSYS_NO_PATHCONV=1
hp() { command -v cygpath >/dev/null 2>&1 && cygpath -w "$1" || printf '%s' "$1"; }

podman rm -f "$NAME" >/dev/null 2>&1
rm -rf "$HERE/.scratch/raw"
mkdir -p "$RAW"

say "造合成 RAW（从 $LIB 取两张 JPEG）"
SRC1=$(find "$LIB" -maxdepth 3 -type f -iname '*.jpg' -size +300k 2>/dev/null | head -1)
SRC2=$(find "$LIB" -maxdepth 3 -type f -iname '*.jpg' -size +300k 2>/dev/null | sed -n 2p)
[ -n "$SRC1" ] && [ -n "$SRC2" ] || { echo "  !! 找不到源 JPEG"; exit 2; }
cp "$SRC2" "$RAW/_inner.jpg"
cp "$SRC1" "$RAW/IMG_0001.jpg"
# 参数要整体加引号：bash 会把词里的 < 当成重定向
podman run --rm --security-opt label=disable -v "$(hp "$RAW"):/raw" --entrypoint exiftool \
  "$IMAGE" -overwrite_original "-ThumbnailImage<=/raw/_inner.jpg" /raw/IMG_0001.jpg 2>&1 | sed 's/^/  /'
mv "$RAW/IMG_0001.jpg" "$RAW/IMG_0001.CR2"
# 先把 decode.rs 依赖的机制单独验一遍：-b -q 取标签要能拿回足够大的内嵌图，
# 而且 exiftool 得正常退出（warning 走 stderr，不影响 stdout 的字节）
INSIDE=$(podman run --rm --security-opt label=disable -v "$(hp "$RAW"):/raw" --entrypoint /bin/sh \
  "$IMAGE" -c 'exiftool -b -q "-ThumbnailImage" /raw/IMG_0001.CR2 2>/dev/null | wc -c')
echo "  内嵌图取回 $INSIDE 字节"
[ "$INSIDE" -ge 40000 ] 2>/dev/null && ok "exiftool 能把内嵌图按字节取出来" || bad "内嵌图取回 $INSIDE 字节，够不到 40KB 门槛"
# 纯垃圾字节：验证解码失败时是干净地 422/空 EXIF，不是 500 或者把整次扫描带崩
dd if=/dev/urandom of="$RAW/IMG_0002.CR2" bs=4096 count=1 >/dev/null
# 普通 JPEG 直接改名成 RAW：没有内嵌标签，只能靠按内容兜底的那一遍解码
cp "$SRC2" "$RAW/IMG_0003.CR2"
rm -f "$RAW/_inner.jpg"
ls -la "$RAW" | sed 's/^/  /'

say "起临时实例（$IMAGE，端口 $PORT）"
podman run -d --name "$NAME" --security-opt label=disable -p "$PORT:80" \
  -e READ_ONLY=false -e PHASH_WARMUP=false -v "$(hp "$RAW"):/photos:rw" "$IMAGE" >/dev/null || exit 2
BASE="http://$NAME"
for _ in $(seq 1 30); do
  podman exec "$NAME" curl -sf -o /dev/null localhost:80/api/config && break
  sleep 1
done

say "扫描：RAW 进得了列表"
for _ in $(seq 1 30); do
  LIST=$(podman exec "$NAME" curl -s localhost:80/api/photos)
  echo "$LIST" | grep -q 'IMG_0001.CR2' && break
  sleep 1
done
echo "$LIST" | grep -q 'IMG_0001.CR2' && ok "IMG_0001.CR2 在列表里" || bad "列表缺少 RAW：$(echo "$LIST" | head -c 160)"
echo "$LIST" | grep -q 'IMG_0002.CR2' && ok "无预览的 IMG_0002.CR2 也在列表里" || bad "列表缺少第二张 RAW"
if echo "$LIST" | grep -o '"filename":"IMG_0001.CR2"[^}]*' | grep -q '"make"'; then
  ok "RAW 的 EXIF 读到了 make/尺寸字段"
else
  bad "RAW 的 EXIF 缺失：$(echo "$LIST" | grep -o 'IMG_0001.CR2[^]]\{0,200\}')"
fi

say "解码：缩略图 / 预览 / 感知哈希"
T=$(podman exec "$NAME" curl -s -o /tmp/t.jpg -w '%{http_code} %{content_type} %{size_download}' 'localhost:80/thumb/IMG_0001.CR2')
echo "  thumb   -> $T"
case "$T" in 200*image/jpeg*) [ -n "$T" ] && ok "RAW 缩略图 200/jpeg" ;; *) bad "RAW 缩略图不是 200/jpeg" ;; esac
P=$(podman exec "$NAME" curl -s -o /tmp/p.jpg -w '%{http_code} %{content_type} %{size_download}' 'localhost:80/preview/IMG_0001.CR2')
echo "  preview -> $P"
case "$P" in 200*image/jpeg*) ok "RAW 预览 200/jpeg（不会把 RAW 字节直接甩给浏览器）" ;; *) bad "RAW 预览异常" ;; esac
H=$(podman exec "$NAME" curl -s 'localhost:80/api/hash/IMG_0001.CR2')
echo "  hash    -> $(echo "$H" | head -c 160)"
echo "$H" | grep -q '"phash"' && ok "RAW 能算出感知哈希" || bad "RAW 哈希失败"
B=$(podman exec "$NAME" curl -s -o /dev/null -w '%{http_code}' 'localhost:80/thumb/IMG_0002.CR2')
echo "  thumb(垃圾字节) -> $B"
if [ "$B" = "422" ] || [ "$B" = "200" ]; then
  ok "读不出图时返回 $B（不是 500，也不会卡住）"
else
  bad "读不出图返回 $B，期望 422 或 200"
fi
C=$(podman exec "$NAME" curl -s -o /dev/null -w '%{http_code} %{content_type}' 'localhost:80/thumb/IMG_0003.CR2')
echo "  thumb(JPEG 改名) -> $C"
case "$C" in 200*image/jpeg*) ok "扩展名是 RAW 但里面是 JPEG：按内容兜底也能出图" ;; *) bad "改名 JPEG 没走通内容兜底：$C" ;; esac
D=$(podman exec "$NAME" curl -s -o /dev/null -w '%{http_code}' 'localhost:80/api/photos')
[ "$D" = "200" ] && ok "带垃圾 RAW 的库照样能扫完（列表 200）" || bad "列表返回 $D"

say "清理"
podman rm -f "$NAME" >/dev/null 2>&1
[ "${KEEP_RAW:-0}" = "1" ] || rm -rf "$HERE/.scratch/raw"

say "结果"
if [ "$FAILS" -eq 0 ]; then
  echo "  RAW 分支全部通过"
else
  echo "  失败 $FAILS 条"
  exit 1
fi
