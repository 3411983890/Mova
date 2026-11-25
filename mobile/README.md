# Mova Mobile

独立的 Expo SDK 58 + React Native + TypeScript iPhone 客户端。

在本目录执行 `npm ci` 安装依赖，`npm start` 启动 Expo Go 局域网预览。iPhone 安装 Expo Go，连接同一家庭 Wi-Fi，然后用系统相机扫描终端二维码。

在「设置 → 服务连接」输入 Mova Linux 的 HTTPS 地址和 Windows 桌面生成的一次性配对码，即可使用共享 Bot、对话和任务。打开 App 时自动同步，离线时能查看最近保存的任务。首次连接前可试用本地演示。

真机分发可用 `eas build --platform ios --profile preview`。关联实际 EAS 项目并配置 Apple 构建签名。启用任务推送时还需在该项目配置 APNs，Linux 服务设置 `MOVA_ENABLE_PUSH=1`，再在手机「设置」开启任务状态通知。[Expo 推送配置](https://docs.expo.dev/push-notifications/push-notifications-setup/)

校验：`npm run typecheck`、`npm test`、`npm run check:expo`、`npm run export:ios`。iOS 导出只是 JS 和资源打包，不是已签名安装包。

Linux 服务安装、环境变量和配对见 [Mova Linux CLI 部署](../docs/plans/Mova-Linux-CLI详细开发方案.md#当前版本部署与使用)。手机开发环境见 [iOS 开发环境与框架](../docs/plans/Mova-iOS开发环境与框架.md)。
