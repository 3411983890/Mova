# 真实站点验收：DeepSeek 开放平台（2026-11-11）

## 目标

在 Mova 右侧浏览器中完成一次真实业务闭环：

1. 打开 `https://platform.deepseek.com/usage`；
2. 用户手动登录；
3. 进入 `API keys`；
4. 新建一个名为 `mova-acceptance` 的 API key；
5. 保存登录 Cookie，供后续对话复用。

## 结果

| 步骤 | 结果 |
| --- | --- |
| 打开 usage | ✅ 跳转 `/sign_in`，页面完整铺满面板 |
| 用户登录 | ✅ 用户手动完成 |
| 进入 API keys | ✅ `/api_keys`，读取到账号现有 3 个 key |
| 创建 key | ✅ 名称 `mova-acceptance`，页面返回一次性 key |
| 保存登录记录 | ✅ `login-records.enc`，4 个 cookie + 21 个 localStorage key |

## 说明

- API key 只在创建时显示一次，未写入仓库、技能库、日志或记忆库；只在当次对话交付给用户。
- 登录记录用 `safeStorage` 加密；下次进入 `https://platform.deepseek.com` 会检测到记录并询问是否用 Cookie 登录。
- 这次是真实站点，不是夹具；但仍是一次人工登录 + Agent 操作，不能替代 12 个真实业务任务的统计。

## 证据

- 页面读取：账号余额、调用量、现有 key 列表；
- 创建后列表出现 `mova-acceptance`，Key 列显示 `sk-9c8d4*****4d27`；
- 登录记录接口返回：

```json
{ "origin": "https://platform.deepseek.com", "cookies": 4, "localStorageKeys": 21 }
```
