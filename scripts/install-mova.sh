#!/usr/bin/env bash
# 负责：为当前 Linux 用户安装 Mova CLI、可选用户服务、原子切换与回滚。
# 不负责：登录订阅、导入网络密钥或替用户开放公网端口。
# 被谁调用：Linux 操作者和开发部署验收。

set -euo pipefail
umask 077
export PATH="$HOME/.local/bin:$PATH"

if [[ $(uname -s) != Linux || $EUID == 0 ]]; then
    echo '请从普通 Linux 用户安装 Mova CLI。' >&2
    exit 1
fi

source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
install_dir="$HOME/.local/share/mova/cloud-cli"
launcher="$HOME/.local/bin/mova"
service_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
rollback=false
service=false
runtime=false
for argument in "$@"; do
    case "$argument" in
        --service) service=true ;;
        --rollback) rollback=true ;;
        --runtime) runtime=true ;;
        *) printf '用法：bash scripts/install-mova.sh [--runtime] [--service] [--rollback]\n' >&2; exit 1 ;;
    esac
done

mkdir -p -- "$install_dir/releases" "$HOME/.local/bin"
exec 9>"$install_dir/install.lock"
flock -x 9

if $runtime && ! $rollback; then bash "$source_dir/scripts/install-mova-runtime.sh"; fi
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' 2>/dev/null; then
    printf '请先安装 Node.js 24 或更高版本。\n' >&2
    exit 1
fi

switch_link() {
    local name=$1 target=$2
    local temp="$name.$$.new"
    ln -s -- "$target" "$temp"
    mv -fT -- "$temp" "$name"
}

current=$(readlink -- "$install_dir/current" || true)
if $rollback; then
    next=$(readlink -- "$install_dir/previous" || true)
    if [[ -z $next || ! -f "$install_dir/$next/scripts/mova.mjs" ]]; then
        printf '没有可回滚的版本。\n' >&2
        exit 1
    fi
else
    release=$(mktemp -d "$install_dir/releases/$(date -u +%Y%m%d-%H%M%S)-XXXXXXXX")
    next="releases/$(basename -- "$release")"
    mkdir -p -- "$release/scripts" "$release/src/services"
    for file in mova.mjs mova-control.mjs mova-health.mjs mova-restore.mjs; do
        install -m 0700 -- "$source_dir/scripts/$file" "$release/scripts/$file"
    done
    install -m 0600 -- "$source_dir/src/services/cloud-connection.mjs" "$release/src/services/"
    tar --exclude='*.test.*' -C "$source_dir" -cf - electron | tar -C "$release" -xf -
    node "$release/scripts/mova.mjs" --help >/dev/null
fi

existing=$(readlink -- "$launcher" || true)
if [[ -e $launcher || -L $launcher ]]; then
    if [[ $existing != "$install_dir/current/scripts/mova.mjs" && $existing != "$HOME/.local/share/mova/browser-cli/scripts/mova.mjs" ]]; then
        printf '已存在其他 mova 命令，请先处理 %s。\n' "$launcher" >&2
        exit 1
    fi
fi

switch_link "$install_dir/current" "$next"
switch_link "$launcher" "$install_dir/current/scripts/mova.mjs"

if $service; then
    mkdir -p -- "$service_dir"
    unit="$service_dir/mova-cloud.service"
    cat > "$unit" <<'UNIT'
[Unit]
Description=Mova personal cloud service

[Service]
Type=simple
ExecStart=%h/.local/bin/mova serve
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=-%h/.config/mova/cloud.env
UMask=0077
Restart=on-failure
RestartSec=3s
TimeoutStopSec=25s

[Install]
WantedBy=default.target
UNIT
    undo_switch() {
        if [[ -n $current ]]; then
            switch_link "$install_dir/current" "$current"
            systemctl --user restart mova-cloud.service || true
        else
            systemctl --user disable --now mova-cloud.service || true
            rm -f -- "$install_dir/current" "$launcher"
            if [[ -n $existing ]]; then switch_link "$launcher" "$existing"; fi
        fi
    }
    if ! systemctl --user daemon-reload || ! systemctl --user enable mova-cloud.service || ! systemctl --user restart mova-cloud.service; then
        undo_switch
        printf '用户服务启动失败，请检查 journalctl --user -u mova-cloud.service。\n' >&2
        exit 1
    fi
    # An active systemd process is insufficient evidence that the listeners were ready.
    ready=false
    for _ in {1..35}; do
        if "$launcher" doctor >/dev/null 2>&1; then ready=true; break; fi
        sleep 0.25
    done
    if ! $ready; then
        undo_switch
        printf '服务未通过本机检查，请查看用户服务日志。\n' >&2
        exit 1
    fi
fi
if [[ -n $current && $current != "$next" ]]; then switch_link "$install_dir/previous" "$current"; fi
printf 'Mova 版本路径：%s/%s\n' "$install_dir" "$next"
printf '命令：%s\n' "$launcher"
