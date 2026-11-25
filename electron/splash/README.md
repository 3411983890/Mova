# 启动动画（electron/splash/）

这里的两个文件是**生成物**，不要手改：

| 文件 | 来源 |
| --- | --- |
| `mova-startup.html` | 原始自包含动画页面，去掉内联 `<script>`，末尾换成 `<script src="mova-startup.js">` |
| `mova-startup.js` | 原页面里那 5 段内联脚本，按原顺序拼接 |

## 为什么必须拆

应用的所有 `mova://` 响应都带 CSP `script-src 'self'`（`electron/main.cjs` 的 `CSP`），
**内联脚本会被静默拦掉**：iframe 里只剩一张静止画面，控制台之外没有任何提示。
另外默认 CSP 是 `frame-ancestors 'none'`，会让覆盖层里的 iframe 直接失效，
所以这份文档单独用 `SPLASH_CSP`（只放宽到 `frame-ancestors 'self'`）。

## 怎么改

```powershell
# 1) 换了一份新的自包含动画 HTML 之后，重新拆分
node scripts/split-splash.mjs "路径\mova-startup.html"
# 2) 拷进 dist（build 会自动做，见 scripts/build.mjs 的 staticEntries）
npm run build
```

页面本身挂在 `index.html` 的 `#boot-splash` 覆盖层里，什么时候收掉由 `app.js` 的
`hideBootSplash()` 决定（会话与记忆都读回来、且至少播 1.8 秒）。
