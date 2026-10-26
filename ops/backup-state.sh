#!/usr/bin/env bash
# photo-viewer 状态/缓存文件的备份与搬家。
#
#   ops/backup-state.sh backup [输出目录]        # 默认输出到 ~/photo-viewer-backups
#   ops/backup-state.sh migrate <外部缓存目录>    # 把库里的 .photo_viewer 搬到快盘，配合 PHOTO_VIEWER_CACHE_DIR
#
# 可选环境变量：
#   PHOTOS_DIR  照片库路径；不设就从 photo-viewer-pod.yaml 的 hostPath 读
#   IMAGE       用来算缓存目录的镜像，默认 localhost/photo-viewer:latest
#   KEEP        backup 保留最近几份，默认 10
#
# migrate 的可选参数：<外部缓存目录> 后面可以跟 --with-thumbs（默认不搬 93MB 缩略图，
# 让新库自己重建）和 --force（目标目录非空也继续）。
# <外部缓存目录> 会同时当成宿主路径和容器内路径：容器看不见 macOS 的任意路径，
# 只有把它原样挂进容器（photo-viewer-pod.yaml 里 cache-volume 那段注释）搬过去才有用。
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
YAML="$REPO/photo-viewer-pod.yaml"
IMAGE=${IMAGE:-localhost/photo-viewer:latest}
KEEP=${KEEP:-10}
STATE_NAME=".photo_viewer"

log() { printf '%s\n' "$*"; }
die() { printf '!! %s\n' "$*" >&2; exit 1; }

photos_dir() {
  if [ -n "${PHOTOS_DIR:-}" ]; then
    printf '%s' "$PHOTOS_DIR"
  else
    [ -f "$YAML" ] || die "没有 PHOTOS_DIR，也找不到 $YAML"
    grep -E '^[[:space:]]*path:[[:space:]]' "$YAML" | tail -1 | sed 's/^[[:space:]]*path:[[:space:]]*//'
  fi
}

# 缓存目录的命名规则只在后端里有一份，问它要，别在脚本里复刻。
# 老镜像不认 --print-state-dir，会当成普通启动把服务跑起来 —— 所以只在 10 秒内
# 等它打印一行，等不到就判定镜像太旧，绝不因为探测而留下一个正在跑的实例。
resolve_state_dir() { # $1=照片库路径 $2=外部缓存根目录（可空）
  local name=pv-state-probe res=""
  podman run -d --name "$name" \
    -e "PHOTOS_DIR=$1" -e "PHOTO_VIEWER_CACHE_DIR=${2:-}" \
    --entrypoint photo-viewer "$IMAGE" --print-state-dir >/dev/null 2>&1 || return 1
  for _ in $(seq 1 10); do
    res=$(podman logs "$name" 2>/dev/null | tail -1)
    [ -n "$res" ] && break
    sleep 1
  done
  podman rm -f "$name" >/dev/null 2>&1
  [ -n "$res" ] || return 1
  printf '%s' "$res"
}

backup() {
  local dest=${1:-"$HOME/photo-viewer-backups"}
  local lib out stamp
  lib=$(photos_dir)
  [ -d "$lib" ] || die "找不到照片库：$lib"
  out=$(resolve_state_dir "$lib" "${PHOTO_VIEWER_CACHE_DIR:-}")
  [ -n "$out" ] || die "问 $IMAGE 要缓存目录失败：镜像得在（podman images），而且要支持 --print-state-dir（2026-10-27 之后构建的才有）"
  stamp=$(date '+%Y%m%d-%H%M%S')
  mkdir -p "$dest"

  if [ -d "$out" ]; then
    log "状态目录：$out"
    tar -czf "$dest/photo-viewer-state-$stamp.tar.gz" -C "$(dirname "$out")" "$(basename "$out")" \
      || die "打包失败"
  else
    [ -n "${PHOTO_VIEWER_CACHE_DIR:-}" ] && die "缓存目录不存在：$out"
    log "库里还没有 $STATE_NAME，先跑一次服务让它生成"
  fi

  # 老版本直接写在库根上的三个 json，可能还没迁走
  local legacy=()
  for f in .photo_viewer_meta.json .photo_viewer_hash_cache.json .photo_viewer_exif_overrides.json; do
    [ -f "$lib/$f" ] && legacy+=("$f")
  done
  if [ ${#legacy[@]} -gt 0 ]; then
    log "顺带备份库根目录的旧文件：${legacy[*]}"
    tar -czf "$dest/photo-viewer-legacy-$stamp.tar.gz" -C "$lib" "${legacy[@]}"
  fi

  ls -1t "$dest"/photo-viewer-state-*.tar.gz "$dest"/photo-viewer-legacy-*.tar.gz 2>/dev/null \
    | tail -n +$((KEEP + 1)) | xargs -r rm -f
  log "备份完成：$dest/photo-viewer-state-$stamp.tar.gz"
}

migrate() {
  local target=${1:-}
  shift 2 2>/dev/null || true
  local with_thumbs=0 force=0
  for a in "$@"; do
    case "$a" in
      --with-thumbs) with_thumbs=1 ;;
      --force) force=1 ;;
      *) die "不认识参数：$a" ;;
    esac
  done
  [ -n "$target" ] || die "用法：ops/backup-state.sh migrate <外部缓存目录> [--with-thumbs] [--force]"

  local lib src dest_dir
  lib=$(photos_dir)
  src="$lib/$STATE_NAME"
  [ -d "$src" ] || die "库里没有 $src，没什么可搬的"

  dest_dir=$(resolve_state_dir "$lib" "$target")
  [ -n "$dest_dir" ] || die "问 $IMAGE 要缓存目录失败：镜像要支持 --print-state-dir（2026-10-27 之后构建的才有）"

  log "从 $src"
  log "到 $dest_dir"
  if [ -d "$dest_dir" ] && [ -n "$(ls -A "$dest_dir" 2>/dev/null)" ] && [ "$force" -ne 1 ]; then
    die "$dest_dir 已经有内容，确认要覆盖就加 --force"
  fi

  mkdir -p "$dest_dir"
  if [ "$with_thumbs" -eq 1 ]; then
    rsync -a "$src/" "$dest_dir/" || die "搬运失败"
  else
    rsync -a --exclude 'thumbs/' "$src/" "$dest_dir/" || die "搬运失败"
    log "缩略图没搬（默认），第一次访问会重新生成；要一起搬就加 --with-thumbs"
  fi
  [ -f "$dest_dir/meta.json" ] || die "搬完还是看不到 meta.json，检查一下权限"

  log
  log "下一步 1/2：把这条路径同时给容器用（photo-viewer-pod.yaml 里有现成的注释块，解开即可）："
  log "        env:          - name: PHOTO_VIEWER_CACHE_DIR / value: $target"
  log "        volumeMounts: - name: cache-volume / mountPath: $target"
  log "        volumes:      - name: cache-volume / hostPath.path: $target"
  log "      三条路径必须一模一样，否则容器读不到你刚拷过去的文件。"
  log "下一步 2/2：podman play kube --replace photo-viewer-pod.yaml"
  log "确认启动横幅里的 State/缓存 → 指向新目录之后，再删库里的 $src —— 回收站 .trash 留在库里，别一起删。"
}

case ${1:-} in
  backup) shift; backup "$@" ;;
  migrate) shift; migrate "$@" ;;
  *) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
