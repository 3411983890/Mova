# Mova Design · OpenPencil 布局移植版

更新日期：2026-11-12。

直接打开 `canvas.html`。依赖同目录 `canvas.css`、`canvas-openpencil.css` 与 `canvas.js`，无需构建、安装或后台。保留 Mova 外壳和当前旅行示例；编辑器布局依据 OpenPencil 组件结构及用户提供的截图移植为原生 HTML/CSS/JS，未运行 Vue 组件或接入 OpenPencil 编辑引擎。来源、范围和 MIT 许可见 `vendor/open-pencil-ui/NOTICE.md`。

- 底部：选择、画板及尺寸下拉、矩形及图片下拉、钢笔、文字；省略参考图右侧手形、评论、表情。钢笔提示尚未接入编辑引擎；平移继续使用 H 或空格拖动。
- 图册入口：原刷新位置改为图册，点击从左侧滑出 Pages/Layers，再次点击收起。仅保留这两个板块。Pages 支持新增、切换和双击重命名；每页画板独立。Layers 可选择当前页的画板与额外对象。
- 右侧：点击画板或对象自动从右侧展开属性。删除 Share 行和 Design/Code/AI/zoom 行，从对象名称开始，保留 Frame、Position、Auto layout、Appearance、Fill、Theme 等区块。右上角关闭可收起。
- 属性：名称、画板预设、尺寸、位置、旋转、翻转、圆角、裁切、透明度、填充色、主题色影响当前示例。Flow、Direction、Gap、Padding、Anchor、Blend 控件保存选项，布局算法和混合渲染尚未接入。
- 播放：右上角单一播放图标，点击在当前画布区域预览并变成暂停图标；可通过示例卡片与底部导航切换页面。再次点击或按 Escape 恢复画板。
- 删除：独立缩放组、画板/探索方向/属性入口整行、底部保存状态整行。画布不显示尺标。缩放继续使用 Ctrl/Command+滚轮、加减键、Shift+1 适应画布。
- 保存：使用独立本地存储 `mova-canvas.prototype.v1`；撤销重做、图片导入、文字编辑、HTML/JSON 导出继续保留。

验收：`qa/openpencil-check.mjs` 真实 Edge 浏览器验证删除项、工具数量、侧栏锚点、选中展开、属性修改、播放/暂停与页面导航、Pages 新增切换、画板预设和窄屏布局，共 18 项通过，浏览器异常 0。结果 `qa/openpencil-results.json`；截图 `qa/shots/openpencil-*.png`。此前 `canvas-morph` 是历史浮层版本，不再被当前页面加载。
