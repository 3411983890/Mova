# Mova Mobile · iOS 26 Liquid Glass 无限画板设计

基于 **iOS 26 Human Interface Guidelines (`402 × 874 pt` iPhone 16 Pro 视口)** 与 **[Kyant0/AndroidLiquidGlass](https://github.com/Kyant0/AndroidLiquidGlass) (`com.kyant.backdrop`)** 光学着色器算法构建的手机版 Mova 无限画板交互原型。

## 启动预览

```powershell
cd mobiledesign
npm install
npm run dev
```

默认运行在 `http://127.0.0.1:5186/`。

## 画板内容与特性

- **01 对话流**：纯黑 OLED 画布、顶部渐进式磨砂遮罩、悬浮液态玻璃导航栏（`44pt` 圆形侧栏菜单钮 + `92×44pt` 双图标操作胶囊）、`Plain text` 代码卡片（支持一键复制）、响应工具栏与重叠站点来源徽章、底部单行液态玻璃输入胶囊。
- **02 聚焦输入与原生键盘**：双层液态玻璃输入卡片（闪烁光标、`+` 附件弹层、`DeepSeek V4.1 高` 等模型与思考档位切换菜单、实时语音/发送动态按钮）及 iOS 26 圆角键帽拼音键盘（支持点击候选词与键帽实时输入并发送）。
- **03 侧边抽屉栏**：`Mova` 标题与液态玻璃搜索按钮、五大核心入口（`定时任务`、`资料库`、`长期记忆`、`CodeMova`、`MovaBot`）、最近对话列表、底部高饱和蓝色液态玻璃「聊天」胶囊与头像岛，以及右侧推开的圆角主屏预览。
- **04 基础组件规范**：Kyant SDF 弯月面透镜折射（`sdRoundedRect` + `circleMap` + `gradSdRoundedRect`）与光谱色散测试台、色彩语义变量及 SF Pro / PingFang SC 动态字阶规范。
- **无限画布控制**：空白处拖拽或按住 `Space` / `H` 键抓手平移，滚轮以光标为中心缩放，顶部导航一键聚焦各画框，右上角「液态玻璃参数」支持实时调节弯月面厚度、边缘折射位移、磨砂模糊、鲜艳度、光谱色散及边缘高光模式。
