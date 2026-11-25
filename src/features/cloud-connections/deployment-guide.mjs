/**
 * 负责：提供可复制的 Linux 部署提示词和本机验证命令。
 * 不负责：执行命令、连接服务器或保存用户凭据。
 * 被谁调用：cloud-connections-settings.jsx。
 */

import { CLOUD_HEALTH_PATH, LOCAL_MOVA_ORIGIN } from '../../services/cloud-connection.mjs';

export const LOCAL_START_COMMAND = 'bash scripts/install-mova.sh --runtime --service';

export const DEPLOYMENT_PROMPT = `请帮我把当前版本的 Mova CLI 部署到我自己的 Linux 云电脑，并陪我验证 Windows 桌面连接。

1. 先确认我授权使用的 SSH 连接、Linux 发行版和架构，以及 Mova 源码或正式发布包的位置。检查仓库中的 docs/plans/Mova-Linux-CLI详细开发方案.md 和实际 CLI 命令。保留已有安装与配置。
2. 在 Ubuntu/Debian x86_64 从源码或解包目录以普通用户运行 ${LOCAL_START_COMMAND}，安装运行依赖和 systemd 用户服务。验证 ~/.local/bin/mova doctor 与服务器内的 ${LOCAL_MOVA_ORIGIN}${CLOUD_HEALTH_PATH}。
3. 用 ~/.local/bin/mova pair code 为 Windows 生成一次性管理员配对码，让我在 Mova 的「云端与连接」输入。配对后由我确认同步选定的 VPN 线路。账号授权由我在 Linux 终端完成，请指引我运行 mova model login codex 或 mova model login gemini。
4. 先给我选择私有网络或 SSH 转发。如我明确需要跨设备 HTTPS 地址，再使用我提供的域名配置 TLS 反向代理。调试端口、数据库、Mihomo 控制器保留在本机。请让我自行完成需要凭据的步骤。
5. 交付桌面端应填写的服务地址和部署检查结果。提交一项任务后退出终端，重连查看结果。手机使用相同的 HTTPS 地址与桌面生成的一次性配对码。请同时交付备份和回滚命令。`;
