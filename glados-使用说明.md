# GLaDOS 自动签到脚本（2026 challenge 版）

## 能否把配置和脚本合并成一个文件？

不能做成由 Quantumult X 自动拆分安装的纯本地单文件。Quantumult X 的配置项只保存脚本文件名，JavaScript 本体必须独立放在 `Quantumult X/Scripts/` 目录。官方配置 API 也不能由脚本自行添加 `rewrite_local`、`task_local` 或 MITM hostname。

已提供 `GLaDOS-QX-本地包.zip`，方便一次下载和保存；解压后仍需把 `Scripts/glados.autosign.js` 放进 QX 的 Scripts 目录，并将配置片段合并进现有配置。若要真正“一键订阅安装”，脚本和 Gallery/snippet 必须有可访问的网络地址，这与纯本地方案冲突。

文件：`glados.autosign.js`

## 为什么旧脚本失效

旧脚本直接向 `/api/user/checkin` 提交 `{"token":"glados.cloud"}`。当前网页已经改为两阶段签到：

1. 请求 `GET /api/user/checkin/challenge` 获取一次性 `nonce` 和有效期 `ttl`；
2. challenge 至少存活 2.5 秒；
3. 计算 `SHA-256(nonce + ".glados-observe-v1")`；
4. 向同一域名的 `POST /api/user/checkin` 提交 `token`、`nonce`、`proof` 和验证状态。

另外，新登录会话通常使用完整的 `gld:sess` + `gld:sess.sig` Cookie，服务端还可能根据登录时的 User-Agent 做设备一致性校验。

## 新脚本做了什么

- 自动请求 challenge、等待 2.7 秒并生成 SHA-256 proof；
- 不再写死 `glados.cloud`，自动沿用抓取会话的域名；
- 保存完整 Cookie、User-Agent 和浏览器客户端提示请求头；
- 兼容 `gld:sess` 新会话，也保留旧 `koa:sess` 识别；
- 明确处理 `device-mismatch`、会话失效、challenge 过期等错误；
- 不尝试绕过 Cloudflare Turnstile，遇到交互验证时提示网页手动签到；
- 兼容 Surge、Loon、Shadowrocket、Quantumult X。

## 本地配置步骤（Quantumult X）

1. 将 `glados.autosign.js` 保存到以下任一目录：
   - `iCloud Drive/Quantumult X/Scripts/`
   - `我的 iPhone/Quantumult X/Scripts/`
2. 将 `glados-local.conf` 中的三段配置复制到 Quantumult X 配置文件对应部分。
3. 启用 MitM，并确认 GLaDOS 域名已加入 hostname。
4. 登录 GLaDOS，打开 `/console/checkin` 页面一次。页面加载 challenge 时应收到“会话获取成功”通知。
5. 在 Quantumult X 的定时任务中手动运行一次“GLaDOS签到”进行测试。

## 本地配置内容

```ini
[rewrite_local]
^https?:\/\/glados\.[^/]+\/api\/user\/checkin(?:\/challenge)?(?:\?.*)?$ url script-request-header glados.autosign.js

[task_local]
15 7,15 * * * glados.autosign.js, tag=GLaDOS签到

[mitm]
hostname = glados.cloud, glados.network, glados.rocks, glados.space
```

## 常见问题

- **提示未找到会话**：登录后重新打开签到页，确认已启用重写和 MITM。
- **提示 device-mismatch**：不要复制别的设备 Cookie；在当前代理设备/浏览器重新登录并抓取。
- **提示 Turnstile**：这是交互式验证，去网页手动完成签到；脚本不会代答或绕过。
- **换了域名或重新登录**：重新打开签到页抓取一次。
- **Cookie 安全**：Cookie 等同于登录凭证，不要发给他人，也不要写入公开仓库。
