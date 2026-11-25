# Mova iOS 开发环境与框架

2026-11-17

## 结论

当前工程采用 Windows + Expo SDK 58 + React Native + TypeScript + iPhone 真机。独立移动工程位于 `mobile/`，有自己的依赖和锁文件，不加入桌面端 npm workspace。聊天使用侧栏导航、原生文本输入、iOS Liquid Glass 和原生设置页面栈，可在 Expo Go 预览。后续用 EAS Build 的 macOS 云环境完成签名、开发版和发布版构建。

当前已实现：黑色聊天画布、侧栏会话列表和搜索、新建/删除、双态悬浮输入栏、原生键盘、行动计划示例、复制/朗读/分享与运行内反馈、演示开关和原生设置。所有会话明确标注演示，仅保留在内存，不请求模型服务。

尚未实现：真实模型、设备配对、服务器会话同步、任务和审批、推送、图片上传、离线持久化。设置中始终如实显示服务未连接。手机端不会直接读取 Electron IPC、电脑文件或数据库。

## 论证与边界

- Windows 可以运行 Metro 开发服务器，iPhone 运行 Expo Go。iOS 本地编译、苹果模拟器和 Xcode 原生诊断仍需要 macOS。
- 已根据用户 iPhone 的实际错误截图升级为 SDK 58：手机上的 Expo Go 要求 SDK 58.0.0。后续以真机支持版本为准，再整组升级原生依赖。
- 新设计以会话抽屉替换底部标签栏，根 Stack 继续提供原生设置与帮助页面。iOS 26 及以上用 `expo-glass-effect` 的系统 UIVisualEffectView，旧系统使用清晰深色回退。设置开关仍使用 `@expo/ui/swift-ui`。
- 状态函数不导入 React Native；Provider 管理本次运行的状态，页面只消费 Provider。这是后续接入真实客户端的替换边界。
- 本次用户明确授权搭建移动工程，移动端允许安装 Expo 官方模板所需依赖；桌面端零新增依赖约束继续适用。
- 目录结构统一维护在 [结构说明](../architecture.md)，此处不重复目录树。

## 2026-11-17 新 UI 实施

设计来源：[Mova · iOS 液态玻璃聊天界面](https://www.figma.com/design/ZEt96OduuCiI54KgFI2XTR?node-id=0-1)。Figma MCP 返回 Starter 读取额度耗尽；已在用户浏览器中查看实际画板，并与仓库内原始设计构建文件 `design/figma-mobile/compose.js`、`finish.js` 和 `icons.json` 对照。实现直接复用原图标，不以画板截图代替界面。原界面快照位于 `.mova-backups/mobile-before-figma-ui/`。

- 主入口显示设计稿行动计划示例；元信息使用“演示对话”，不伪造实际模型和思考时长。
- 顶栏支持抽屉、新聊天和原生菜单。抽屉支持会话选择、搜索、长按删除、新聊天与设置；资料库、记忆及其他模式如实提示尚未连接服务。
- 空闲输入栏高 60 点，聚焦后为双层工具栏；系统键盘出现时输入栏随键盘抬升。草稿按会话分开保存于内存。
- 加号提供系统菜单粘贴文字与清空输入；话筒指向系统键盘听写。蓝色按钮有文字时发送，无文字时朗读最近回复，不表示已实现双向语音对话。
- 回复支持复制、系统朗读、系统分享和本次运行内的点赞。全部图标来自设计源文件，保存 SVG 与 1x/2x/3x PNG；调用使用明确尺寸，保持原比例。
- 应用采用设计稿纯黑外观；不绘制假状态栏、Home Indicator 或键盘。设置和预览帮助保留系统页面展示。

## Windows 日常启动

在项目根目录执行：

```powershell
cd C:\Users\34119\Documents\Mova\mobile
npm ci
npm start
```

依赖已安装时只需 `npm start`。开发服务默认使用端口 8081，明确选择 Expo Go 与 LAN 模式。电脑需要保持运行，手机与电脑连接同一家庭网络。终端二维码包含实际 LAN 地址；不要把 `localhost` 或 `127.0.0.1` 当作手机连接电脑的地址。

如果局域网无法连接，先确认 iPhone 的本地网络权限、电脑私有网络的 Node 防火墙许可以及路由器是否隔离无线设备。不要关闭全部防火墙。也可运行 `npm run start:tunnel`；首次会提示安装 Expo 的隧道工具，隧道是否可达取决于网络环境。

## iPhone 操作

1. 在 App Store 安装或更新 **Expo Go**。如要求登录，用免费 Expo 账号登录；电脑端按提示运行 `npx expo login` 并使用同一账号。账号登录由用户自己完成。
2. 连接与 Windows 电脑相同的家庭 Wi-Fi。电脑可用同一路由器的网线连接。
3. 用 iPhone 自带相机扫描开发终端二维码，选择在 Expo Go 中打开。也可将终端提供的 `exp://` 链接发送到手机后点击。
4. 弹出本地网络权限时选允许。如果曾拒绝，在「设置 → App → Expo Go → 本地网络」中开启（路径随 iOS 版本可能不同）。
5. 打开 Mova，依次检查新建对话、发送演示消息、返回列表、设置开关和深浅色外观。

Expo Go 阶段无需付费 Apple Developer Program，也无需开启 iPhone 开发者模式。真机安装自己的开发版 App 时再按 Apple / Expo 指引完成会员、设备注册、签名和开发者模式配置。

## 校验命令

在 `mobile/` 运行：

```powershell
npm run typecheck
npm test
npm run check:expo
npm run export:ios
```

`export:ios` 验证 iOS JavaScript 和资源打包，**不等于**签名 IPA 构建或 iPhone 真机验收。Windows 不能据此验证 UIKit/SwiftUI 的最终视觉、键盘和原生崩溃。浏览器补充预览用 `npm run web`。

桌面回归遵循仓库门禁：`node scripts/accept.mjs`。新增测试只验证演示发送开关、消息长度、重复 ID 和会话隔离，不发网络请求、不打开 Electron。

## 云构建的下一步

已提供 `eas.json` 的 development、preview、production 配置。项目尚未绑定任何 Expo 账号或 Apple 账号，未创建远端项目、上传代码或付费。

准备生成自己的安装包时：

1. 在 `mobile/` 执行 `npx expo install expo-dev-client`。
2. 执行 `npx eas-cli@latest login`，由用户登录 Expo。
3. 执行 `npx eas-cli@latest build:configure` 绑定实际 EAS 项目；按账号归属确定唯一 iOS Bundle Identifier。当前不预填虚构标识和 projectId。
4. 执行 `npx eas-cli@latest device:create` 注册测试 iPhone。
5. 执行 `npx eas-cli@latest build --platform ios --profile development`，在云端构建并由用户完成 Apple 账户签名配置。
6. 扫码安装开发版，在 iPhone 开启开发者模式，然后用 `npm run start:dev-client` 启动日常开发。

云构建中将上传项目代码；应先确认实际构建账号和 Apple 开发者归属。生产发布还需 App Store Connect 记录和正式审核，`eas.json` 不代表这些已经完成。

## 后续服务接入

客户端面向通用 Mova 服务，不绑定 Windows 地址。开发时可连接电脑上的网关，部署后可接 Linux 服务。跨端目标以 [云电脑 CLI 与 iPhone 方案](Mova云电脑CLI与iPhone跨端助手方案.md) 为准；其中早期的纯 SwiftUI 客户端设想在本次 Windows 开发条件下调整为 React Native + Expo，并通过 Expo UI 使用 SwiftUI 组件。

下一步先确定可用服务端，再做一次性设备配对、Keychain 凭证、真实会话接口、流式回复与断线补齐。电脑和手机不能通过各自的回环地址互相连接。数据库、浏览器调试口和文件执行能力继续留在受控服务端。

## 官方资料

- [Expo 工程创建与 SDK 过渡说明](https://docs.expo.dev/more/create-expo/)
- [SDK 58 原生标签栏](https://docs.expo.dev/versions/v58.0.0/sdk/router/native-tabs/)
- [SDK 58 SwiftUI Toggle](https://docs.expo.dev/versions/v58.0.0/sdk/ui/swift-ui/toggle/)
- [Expo 真机开发构建](https://docs.expo.dev/tutorial/eas/ios-development-build-for-devices/)
