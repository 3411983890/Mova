# 被动接管验证（2026-11-11）

> 脚本：`scripts/passive-takeover-check.cjs`  
> 环境：Windows / Electron 45.2.3

## 行为

1. Agent 持有 `agent` 锁；
2. 用户在页面里按键/点击（`before-input-event` / `before-mouse-event`）；
3. controller 立即把锁切到 `human`，显示接管横幅；
4. Agent 下一个操作返回 `human-in-control`；
5. 用户点“我已处理，继续” → `respondHandoff(id,'resume')` → 锁回 `agent`；
6. Agent 重新 snapshot 继续。

Agent 自己通过 CDP 发出的输入被 `internalInput` 标记包住，不会误触发。

## 结果

```json
{
  "takeover": {
    "id": "p1",
    "reason": "user-input",
    "note": "你正在操作浏览器，Agent 已暂停",
    "passive": true
  },
  "blocked": "human-in-control",
  "closed": { "id": "p1" },
  "resumed": "full"
}
```

`resumed: "full"` 表示恢复后第一次 snapshot 成功。

## 复现

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
node_modules\electron\dist\electron.exe scripts\passive-takeover-check.cjs
```

## 限制

- 键盘/鼠标事件通过 `sendInputEvent` 模拟；真实触控/输入法未测；
- 被动接管只作用于当前 target 的输入；后台 Space 的输入不会抢占；
- 接管期间 Agent 的工具直接失败，不会排队等待（用户恢复后由模型重试）。
