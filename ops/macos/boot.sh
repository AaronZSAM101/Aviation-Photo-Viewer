#!/usr/bin/env bash
# 开机/登录后把相册服务拉起来。
#
#   bash ops/macos/boot.sh          # 手动跑一次（幂等，已经健康就直接退出）
#   launchctl kickstart -k gui/$(id -u)/com.aaron.photo-viewer
#
# 三件事必须按顺序补齐，缺任何一条服务都不会自己活过来：
#   1. podman machine 不会随 macOS 启动；
#   2. VM 里的 podman-restart.service 出厂是 disabled，不打开它 restartPolicy: Always
#      只在“同一次开机内”有效，机器重启后容器不会被拉起；
#   3. Synology Drive 客户端比 launchd 慢，图库没挂载就起容器会得到一个空库。
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
YAML="$REPO/photo-viewer-pod.yaml"
MACHINE=${PV_MACHINE:-podman-machine-default}
POD=${PV_POD:-photo-viewer-pod}
HEALTH_URL=${PV_HEALTH_URL:-http://127.0.0.1:3000/api/config}

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }

export PATH="/opt/podman/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"

command -v podman >/dev/null || { log "找不到 podman，跳过本次拉起"; exit 1; }
[ -f "$YAML" ] || { log "找不到 $YAML"; exit 1; }

if [ "$(podman machine list --format '{{.Name}} {{.Running}}' | awk -v m="$MACHINE" '$1==m {print $2}')" != true ]; then
  log "启动 podman machine：$MACHINE"
  podman machine start "$MACHINE" >/dev/null 2>&1 || { log "machine 启动失败"; exit 1; }
fi

if [ "$(podman machine ssh 'systemctl is-enabled podman-restart.service' 2>/dev/null)" != enabled ]; then
  log "打开 VM 里的 podman-restart.service"
  podman machine ssh 'sudo systemctl enable --now podman-restart.service' >/dev/null 2>&1 ||
    log "打不开 podman-restart.service，继续（重启后不会自愈，只保证本次能起来）"
fi

LIB=$(grep -E '^[[:space:]]*path:[[:space:]]' "$YAML" | tail -1 | sed 's/^[[:space:]]*path:[[:space:]]*//')
for _ in $(seq 1 60); do
  [ -n "$LIB" ] && [ -d "$LIB" ] && break
  sleep 2
done
if [ -z "$LIB" ] || [ ! -d "$LIB" ]; then
  log "图库还没挂载好（$LIB），本次放弃，等下一个整点再试"
  exit 1
fi

if curl -sf -o /dev/null "$HEALTH_URL"; then
  log "已经在跑且健康：$HEALTH_URL"
  exit 0
fi

log "play kube：$YAML"
podman play kube --replace "$YAML" >/dev/null 2>&1 || { log "play kube 失败"; exit 1; }

for _ in $(seq 1 60); do
  curl -sf -o /dev/null "$HEALTH_URL" && { log "服务已就绪：$HEALTH_URL"; exit 0; }
  sleep 2
done
log "120 秒内没等到 $HEALTH_URL，看看 podman ps -a 和 podman pods inspect $POD"
exit 1
