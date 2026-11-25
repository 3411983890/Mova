#!/usr/bin/env bash
# 负责：在 Debian/Ubuntu x86_64 上按需安装 Mova 的 Linux 运行依赖。
# 被谁调用：install-mova.sh --runtime。

set -euo pipefail
umask 077
export PATH="$HOME/.local/bin:$PATH"

if [[ $(uname -m) != x86_64 ]] || ! command -v apt-get >/dev/null; then
    echo '自动依赖安装支持 x86_64 Ubuntu/Debian。其余环境请自行安装依赖后运行 install-mova.sh。' >&2
    exit 1
fi

work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
mkdir -p "$HOME/.local/bin" "$HOME/.local/share/mova/runtime"
download() { curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --retry 2 --connect-timeout 15 --max-time 300 "$1" --output "$2"; }
node_ready() { node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' 2>/dev/null && command -v npm >/dev/null; }
browser_ready() { chrome-headless-shell --version >/dev/null 2>&1; }

if ! command -v curl >/dev/null || ! command -v bwrap >/dev/null || ! browser_ready; then
    sudo apt-get update
    packages=(ca-certificates curl bubblewrap)
    if ! browser_ready; then
        audio=libasound2
        if apt-cache show libasound2t64 >/dev/null 2>&1; then audio=libasound2t64; fi
        packages+=(unzip libnspr4 libnss3 libatk1.0-0 libatk-bridge2.0-0 libdrm2 libgbm1 libx11-6 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxrandr2 libxkbcommon0 "$audio" fonts-liberation)
    fi
    sudo apt-get install -y "${packages[@]}"
fi

if ! node_ready; then
    node_series=https://nodejs.org/dist/latest-v24.x
    download "$node_series/SHASUMS256.txt" "$work/node-checksums"
    node_archive=$(awk '$2 ~ /^node-v24\.[0-9]+\.[0-9]+-linux-x64\.tar\.xz$/ { print $2; exit }' "$work/node-checksums")
    [[ -n $node_archive ]]
    download "$node_series/$node_archive" "$work/$node_archive"
    (cd "$work"; grep -F "  $node_archive" node-checksums | sha256sum --check --strict)
    tar -xJf "$work/$node_archive" -C "$work"
    node_dir="$HOME/.local/share/mova/runtime/${node_archive%.tar.xz}"
    if [[ ! -x $node_dir/bin/node ]]; then mv "$work/${node_archive%.tar.xz}" "$node_dir"; fi
    ln -sfn "$node_dir/bin/node" "$HOME/.local/bin/node"
    ln -sfn "$node_dir/bin/npm" "$HOME/.local/bin/npm"
fi

if ! command -v mihomo >/dev/null; then
    download https://github.com/MetaCubeX/mihomo/releases/download/v1.19.34/mihomo-linux-amd64-compatible-v1.19.34.gz "$work/mihomo.gz"
    (cd "$work"; printf '%s  mihomo.gz\n' 2763f5b414527f7baf6dc57e3f82f3ab561eedf34bfd7c2f2cde1f7e592efe06 | sha256sum --check --strict)
    gzip -dc "$work/mihomo.gz" > "$work/mihomo"
    install -m 0700 "$work/mihomo" "$HOME/.local/bin/mihomo"
fi

if ! browser_ready; then
    download https://storage.googleapis.com/chrome-for-testing-public/157.0.8103.78/linux64/chrome-headless-shell-linux64.zip "$work/chrome.zip"
    (cd "$work"; printf '%s  chrome.zip\n' f90329720fb61e5a76da9b6b509b6ad12a484c9c5df0359403e935177c6d153a | sha256sum --check --strict)
    unzip -q "$work/chrome.zip" -d "$work"
    chrome_dir="$HOME/.local/share/mova/runtime/chrome-headless-shell-157.0.8103.78"
    if [[ ! -x $chrome_dir/chrome-headless-shell ]]; then mv "$work/chrome-headless-shell-linux64" "$chrome_dir"; fi
    ln -sfn "$chrome_dir/chrome-headless-shell" "$HOME/.local/bin/chrome-headless-shell"
fi

if ! command -v codex >/dev/null; then npm install --global --prefix "$HOME/.local" @openai/codex@0.169.0; fi
if ! command -v agy >/dev/null; then
    download https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.10-5253791805734912/linux-x64/cli_linux_x64.tar.gz "$work/agy.tar.gz"
    (cd "$work"; printf '%s  agy.tar.gz\n' 713ae840845d74736e2d4a96f5d84e3353d614e73a875793ddf500997ccee09595448cebfd8e94fdd90ce2a0fa97707bd1cc29763dcfe01c945d80c92234378f | sha512sum --check --strict)
    mkdir "$work/agy"
    tar -xzf "$work/agy.tar.gz" -C "$work/agy"
    agy_bin=$(find "$work/agy" -type f -name agy -print -quit)
    [[ -n $agy_bin ]]
    install -m 0700 "$agy_bin" "$HOME/.local/bin/agy"
fi

if ! bwrap --unshare-net --ro-bind /usr /usr --symlink usr/lib /lib --symlink usr/lib64 /lib64 -- /usr/bin/true; then
    echo '此 Linux 主机未允许 Bubblewrap 创建隔离命名空间。请先在系统放行该能力，再运行订阅模型。' >&2
    exit 1
fi
node --version
codex --version
agy --version
chrome-headless-shell --version
mihomo -v
