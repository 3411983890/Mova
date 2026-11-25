#!/usr/bin/env bash
# 负责：打包可以直接复制到 Linux 的 Mova CLI 安装源。
# 被谁调用：CLI 发布与部署。

set -euo pipefail
umask 077
if [[ $# != 1 || $1 != *.tar.gz ]]; then
    echo '用法：bash scripts/package-mova-cli.sh <mova-cli.tar.gz>' >&2
    exit 1
fi
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
output=$(realpath -m -- "$1")
if [[ -e $output || -L $output ]]; then echo '输出文件已经存在。' >&2; exit 1; fi
stage=$(mktemp -d)
trap 'rm -rf -- "$stage"' EXIT
mkdir -p "$stage/mova-cli/scripts" "$stage/mova-cli/src/services"
for file in install-mova.sh install-mova-runtime.sh mova.mjs mova-control.mjs mova-health.mjs mova-restore.mjs; do
    install -m 0700 "$source_dir/scripts/$file" "$stage/mova-cli/scripts/$file"
done
install -m 0600 "$source_dir/src/services/cloud-connection.mjs" "$stage/mova-cli/src/services/"
tar --exclude='*.test.*' -C "$source_dir" -cf - electron | tar -C "$stage/mova-cli" -xf -
tar -C "$stage" -czf "$stage/mova-cli.tar.gz" mova-cli
( set -o noclobber; cat "$stage/mova-cli.tar.gz" > "$output" )
sha256sum -- "$output"
