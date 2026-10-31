# Our Free Model 独立本地服务

这是独立产品的源码入口，不需要 DSH、Cordis、DSH profile 或宿主凭据库。
已提供独立 HTTP 服务、网页管理、EAC 和十个账号渠道；独立安装制品尚未发布。
本阶段从完整仓库运行，暂不能仅复制本目录或将它单独作为 npm 包安装。

## 启动

需要符合仓库 `engines` 要求的 Node.js。在仓库根目录执行：

```powershell
npm run start:standalone
```

也可以指定端口和数据目录：

```powershell
npm run start:standalone -- --port 18900 --data-dir F:\ofm-data
```

启动打印管理页面的一次性登录链接、实际 API 地址与密钥文件位置，不打印 API Key。
在浏览器打开管理链接即可使用控制台，链接 10 分钟内有效且仅能兑换一次。
默认端口是 `18900`；
端口被占用时沿用共享监听器的自动选端口逻辑。后续启动优先使用本产品上次保存的端口；
`--port` 可以覆盖，`0` 表示由系统分配。

## 数据与鉴权

- 默认目录：`~/.our-free-model`；环境变量 `OFM_HOME` 或 `--data-dir` 可以覆盖。
- 不读取 `DSH_HOME`，不导入 DSH 的配置或凭据。
- 账号凭据保存在 `channel-credentials.json`，账号池、积分与账本位于 `channel-pack/`；
  EAC 授权保存在 `eac-user.json`，均属于当前独立数据目录。
- 首次启动不会自动搬迁插件账号。需要迁移时，在插件中导出账号备份，再在独立网页的
  “免费账号渠道 → 供应商与备份”手动导入。备份包含明文凭据，请妥善保存。
- API Key 为此产品单独生成，保存在该目录的 `settings.json` 的 `forwardKey` 字段。
- `GET /health` 提供不含凭据的产品状态；推理接口与模型清单需要 `Authorization: Bearer <API Key>`。
- 同一个数据目录只能启动一个本地服务实例。正常退出会清除 `service.lock`。
- 异常退出后若锁仍存在，先检查锁文件记录的 PID，确认旧进程已停止，再移除该锁文件。
- 管理页面和管理 API 只监听回环地址；局域网推理需要显式开启独立中继。

插件仍使用 `DSH_HOME/our-free-model` 或 `~/.dsh/our-free-model`，两者默认互不影响。
不要主动把独立服务的 `OFM_HOME` 指向插件的数据目录。

### 免费车道的出网传输（Bun 或 Node）

OpenCode 免费车道的请求默认交给本机 Bun 可执行文件发送，插件本身不下载任何东西。
查找顺序：`OUR_FREE_MODEL_BUN`、`BUN_INSTALL/bin`、`~/.bun/bin`、`PATH`。
没有 Bun 时服务仍能启动，但模型清单刷新会报
`OpenCode free inference requires a local Bun executable…`，免费车道不可用。两种处理：

1. 安装 Bun（独立安装，或用 `OUR_FREE_MODEL_BUN` 指向原生可执行文件）；
2. 设置 `OUR_FREE_MODEL_FREE_TRANSPORT=node`，走 Node 的旧传输。这是上游保留的
   诊断/回退路径；**不要把 Node 回退当成可用的 OC 通道**。

2026-10-31 在同一台机器、同一出口复测，闸门要**同时**满足两个条件：

| 传输 | 上游流式 | 结果 |
| --- | --- | --- |
| Bun | `stream: true` | 3/3 成功 |
| Bun | `stream: false` | 429 `FreeUsageLimitError` |
| Node | `stream: true` | 429 |
| Node | `stream: false` | 429 |

插件向上游始终发流式请求（下游客户端可以是非流式），所以装好 Bun 即满足两个条件。
报错正文写“免费额度用尽”是误导，它同时被用作客户端闸门的拒绝文案；先确认没开
`node` 回退，再怀疑额度。`OUR_FREE_MODEL_FREE_TRANSPORT=node` 只用于诊断。
Kilo 车道不需要 Bun，两条传输都正常。

**Bun worker 中途退出时怎么读报错**：传输失败会写成
`upstream request failed: Bun worker exited with code <N> after <N> response bytes (ENOTFOUND).`
括号里是 worker 自己 `catch` 到的错误码（DNS、`ECONNRESET`、`ETIMEDOUT` 等），
`after ... bytes` 说明死在响应中途还是连接阶段。worker 的 stderr 只回传这一行错误码，
URL、请求头和正文一律不落到日志里。

**上游排队后不回包就断开**：2026-10-31 实测，网关会为排队中的请求保持约 65 秒，
然后在不发送任何响应字节的情况下直接断开（worker 报 `ECONNRESET`）。这在客户端看
是 `Bun worker exited with code 1 before any response header (ECONNRESET)`。因为此时
还没有向客户端写过任何字节、请求体也已序列化好，服务会**立即重放一次**；重放仍被
断开才按传输错误返回，并写成
`upstream request failed: fetch failed — … (the gateway reset the connection before answering)`。
重放只针对「连接在响应头之前被重置」，真正的拒绝（有状态码）、客户端取消和第二次
重置都不会被重试。

## 会话保持（每个对话独立的上游会话）

免费车道按上游会话区分状态与额度。独立服务不会再把所有下游请求塞进同一个
`forward:shared`，而是给每个对话分配并复用各自的 `ses_…`：

- 键的优先级：请求头 `session-id` / `session_id` / `x-session-id` /
  `conversation-id` / `conversation_id` / `x-conversation-id` →
  请求体 `metadata.session_id`、`session_id`、`conversation_id`、
  `conversation`、`chat_id`、`prompt_cache_key` → Claude Code
  `metadata.user_id` 尾部的 `_session_<uuid>` → `user` 字段 → API Key + 模型 +
  首条用户消息的指纹（没有携带任何标识的客户端也能按对话分开）。
- 同一个键在 30 分钟空闲内复用同一个上游会话；超过 TTL 或表满（LRU，默认 1024
  条）后换新会话。
- 状态写在数据目录的 `session-affinity.json` 与 `session-map.json`，重启后保持；
  独立服务不再写入 `~/.dsh`。
- 配置在 `settings.json`：

  ```json
  "sessionAffinity": { "enabled": true, "ttlMinutes": 30, "maxEntries": 1024 }
  ```

  环境变量覆盖：`OFM_SESSION_AFFINITY=0` 关闭，`OFM_SESSION_TTL_MINUTES`、
  `OFM_SESSION_MAX` 调整。关闭后回到按 `user` 分桶的历史行为。

会话保持只解决“不同对话共用一个上游会话”的问题，不放宽上游的限额与条款：
同一出口 IP 的 429 不会因为换会话而消失；Kilo 免费池的提示词仍可能被上游记录。

## 去掉 `-free` 的模型别名

请求 `deepseek-v4.1-flash` 会自动路由到 `deepseek-v4.1-flash-free`，响应里的
`model` 字段改写回 `deepseek-v4.1-flash`；流式响应的每一帧同样如此。覆盖
Chat Completions、Responses 与 Messages 三条下游协议。

- 只在 `-free` 兄弟 id **确实可路由**时生效；请求的 id 本身存在时优先用它。
- 已经带 `-free` 的请求原样透传，不会被二次改写。
- `/v1/models` 两种写法都列出：`deepseek-v4.1-flash-free` 与
  `deepseek-v4.1-flash`。别名行带 `x_ofm_alias` 指向真实 id，客户端在列表里
  直接选哪一个都能用；new-api 里手填去掉 `-free` 的名字同样有效。
- Gemini 路径（`/v1beta/models/...`）不在这个别名范围内。
- 对外错误消息会去掉 `Our Free Model`、`free model`、`free tier`、
  `FreeUsageLimitError` 等内部名；模型 id 里的 `-free`/`:free` 也会在报错文本中
  显示为去掉后缀的形式（如 `deepseek-v4.1-flash`），只有 HTTP 状态、错误类型和
  必要参数保留。

## 局域网推理

首次启动默认关闭。可在本机管理接口中设置，或通过 CLI 显式开启并保存：

```powershell
npm run start:standalone -- --lan --lan-port 18901
npm run start:standalone -- --no-lan
```

`--lan-port` 单独使用只保存端口，不启用中继。省略开关时沿用已保存设置。
中继监听 `0.0.0.0`，仅转发模型清单及 Chat Completions、Responses、Messages、
Messages count_tokens 推理路径（支持 `/v1` 前缀和无前缀形式）。
流式响应与取消沿用本机推理实现。`/`、`/health`、页面资源和所有管理路径均不转发；
OPTIONS 只返回 CORS 预检，不返回管理数据。

LAN 客户端使用本机管理接口单独生成的 LAN Key，不能使用或索取本机 `forwardKey`。
LAN Key 保存在当前独立目录的 `settings.json` 的 `standaloneLanKey` 字段中；
关闭中继、正常退出和重启均保留该密钥。轮换 LAN Key 立即使旧 LAN Key 失效，
本机 API Key 和管理会话继续可用。轮换本机 API Key 后中继自动使用新本机密钥。
只把 LAN Key 交给可信客户端，并在需要时通过防火墙限制访问来源。

本机管理 API 使用已有会话或本机 Bearer Key，契约如下：

| 接口 | 请求或返回 |
| --- | --- |
| `POST /api/management/settings` | 接受 `standaloneLanEnabled`（布尔）和 `standaloneLanPort`（0 到 65535 整数）；返回 `settings` 和 `lan` |
| `GET /api/management/summary` | `settings` 包含上述设置；`lan` 包含运行状态，不含密钥 |
| `GET /api/management/lan/key` | `{key}`；尚未生成时为空字符串 |
| `POST /api/management/lan/key/rotate` | 请求必须恰好是 `{confirm:true}`；返回新 `{key}` |

`lan` 字段为 `{enabled,running,host,requestedPort,port,addresses,baseUrls,error}`。
`enabled` 表示保存的 LAN 意愿；服务总开关关闭时它可以为 true，而 `running` 为 false。
`requestedPort` 为期望端口，0 表示每次启动自动分配；实际端口只出现在 `port`，
不会写回覆盖期望端口，停止时为 null。固定端口被占用时保留设置，
`running:false` 且 `error` 给出失败代码；释放端口后重新应用设置可重试。
关闭服务总开关或 LAN 开关会立即停止中继并释放端口，正常退出也会释放端口。
`baseUrls` 为检测到的本机网卡 IPv4 地址及实际端口，切换网络后重新读取摘要即可更新。
未知字段、自定义监听 host、目标地址和客户端提交的密钥均不接受。

这只解决 issue #351 的 LAN 推理接入。issue #216 的 Docker / FPK / NAS
远程管理部署仍未实现：管理监听器和 Host 信任围栏仍限 loopback，
不支持 `--host`、`OFM_ALLOW_NON_LOOPBACK` 或 `OFM_TRUSTED_HOSTS` 放宽管理访问。
容器映射中继端口可供已配置的推理客户端连接，但不能据此从 LAN 打开管理页，
也没有提供容器镜像、FPK 包或容器内账号 OAuth 登录适配。

## 当前接口与渠道

- `GET /v1/models`
- `POST /v1/chat/completions`，包括流式与非流式请求
- `POST /v1/responses`，包括流式与非流式请求
- 匿名免费模型与 Kilo 免费模型
- EAC 原 GitHub 授权、签名请求和资源池；独立应用使用自己的授权文件
- LobsterAI、
  Qoder、Qoder 中国版、TRAE、Cline、Loomy、Raccoon、MiniMax Code、ZCode、Gemini
- 原渠道登录、账号池和轮换、续期、模型开关、每日签到、积分锁定、账本及备份
- 本地模型缓存、用量统计、周期刷新、请求取消与退出清理
- `GET /`：独立中文网页控制台
- `/api/management/*`：同源管理接口，使用管理会话或 API Key 鉴权

启动先绑定监听器，再异步刷新模型清单。首次运行默认不发可用性探测请求；
`--probe` 可启用并保存自动探测设置，以后启动沿用，可在网页设置中关闭。
上游不可达时保留缓存；`--no-refresh` 跳过核心的启动刷新与周期任务，
手动刷新、探测和推理仍可用。账号渠道初始化目录、登录轮询、续期和自动签到沿用渠道自身规则；
`--no-refresh` 不会关闭这些任务，自动签到可在渠道页面关闭。
自动探测遇到限流遵守核心退避；页面主动探测会强制重新检查，并产生推理请求。

独立账号渠道采用每实例 Worker 隔离，通过同一个服务端口和 API Key 提供
`provider/model` 模型 ID。启动先挂载 HTTP，账号清单在后台加载，不等待所有供应商网络响应。
EAC 在独立页面自行授权；不会使用 DSH 的 EAC token。原插件的宿主判定保持原样。
插件热重载、自更新和宿主 Agent 自动续跑不挂载在独立入口。

## 网页管理

独立端已更新概览、渠道管理、模型清单、用量统计、服务设置和公共导航；
API 接入和登录继续保留已有控制逻辑。资源全部由本机服务提供，
渠道、模型、用量统计和服务设置按需加载，不依赖 CDN。视觉与体积记录见
[`第一阶段验收`](../../docs/verification/2026-10-09-standalone-ui-phase1.md)、
[`模型清单验收`](../../docs/verification/2026-10-09-standalone-model-browser.md)和
[`用量统计验收`](../../docs/verification/2026-10-09-standalone-usage-dashboard.md)和
[`服务设置验收`](../../docs/verification/2026-10-09-standalone-settings-page.md)。

修改前端后，在仓库根目录执行：

```powershell
npm ci --prefix packages/standalone --ignore-scripts
npm run typecheck:standalone
npm run build:standalone-ui
node scripts/build-standalone-ui.mjs --check
```

`frontend/` 是源码，`web/` 是提交的构建输出。服务启动时载入这些资源；
重新构建后需要重启服务。开发工具只用于构建，不作为网页资源公开。

模型页使用 TanStack Virtual 按可视区域挂载条目，支持动态行高和长 ID 换行。
聚焦滚动区域后可按 Home/End 到达首尾；复制或测试按钮获得焦点时保留所在条目。
搜索和筛选只改变当前视图，刷新及切页后保留，退出管理后清空。
单模型测试可取消；切页或退出时中断测试请求。刷新和探测属于服务端共享任务，
离开页面会取消前端等待，不承诺停止服务端整个刷新任务。

- **概览**：推理状态、接入地址、模型数量、最近 7 天 Token 用量和本机服务信息。
- **模型清单**：名称/ID 搜索、渠道/能力/状态/公开范围组合筛选、复制模型 ID、
  刷新清单、主动探测，以及可取消的单模型测试和结果展示。
- **用量统计**：累计用户回合、物理请求、输入/输出 Token、失败与恢复回合，
  最近 7/14/30 个本地自然日趋势（默认 14 天），以及按模型搜索、排序和每页 20 条统计。
  历史估算有明确说明，未知性能显示“—”；读取和刷新统计不发送推理请求。
- **免费账号渠道**：十张渠道卡片、登录与账号管理；渠道用量、请求日志、
  供应商启停、永久积分锁定、昵称、账号优先级、限流重置与备份导入导出。
- **EAC 协付渠道**：GitHub 授权、状态、取消、退出和资源池。授权页面由用户打开并完成。
- **服务设置**：暂停或恢复推理、地区模型、断流恢复、输出上限、刷新间隔和自动探测。
- **API 接入**：复制地址、主动查看或隐藏密钥、复制调用示例、确认后轮换密钥。

登录链接的临时凭证位于 URL fragment，页面兑换后移除。浏览器使用 8 小时有效的
HttpOnly、SameSite=Strict 管理 Cookie；重启服务或退出管理会清除会话。
链接已使用或过期时，可用 `settings.json` 中的 `forwardKey` 登录。
登录页提供本机获取令牌入口：Windows 打开 PowerShell，macOS 打开系统 Terminal，
读取当前服务实际数据目录中的密钥并复制到剪贴板，再回页面粘贴登录。
该操作只接受本机页面的同源请求，只执行固定动作，不接受网页提供的命令或路径，
也不会把密钥返回给未登录的网页。每次成功打开后 30 秒内不能重复打开。
打开失败时，可展开「手动获取与其他系统」，复制当前系统默认目录的取令牌命令，
或直接从配置文件读取 `forwardKey`；自定义目录以启动参数为准。
macOS 首次打开可能需要允许本地服务控制 Terminal。Linux 使用手动说明
或服务启动时打印的一次性登录链接；Windows 和 macOS 也保留这些备用入口。
轮换密钥会立即使旧密钥及其他管理会话失效，当前管理会话保留，客户端需更新配置。
推理接口仍要求 Bearer API Key，管理 Cookie 不能用于推理。暂停推理后管理页面仍可访问。

页面每 15 秒更新状态，读取状态不发送推理请求。主动探测和模型测试会消耗上游额度；
模型测试限制 64 个输出 Token、60 秒超时，真实用量计入统计。
统计保存用量与性能，不保存提示词和回答；推理内容仍发送至模型上游，
Kilo 免费池的提示词可能被上游记录，请勿发送敏感内容。

服务设置有未保存提示、数字范围校验和撤销修改。后台轮询及切页不会覆盖编辑草稿，
退出管理后草稿清空；撤销恢复最近同步的已保存值。保存期间禁止重复提交，
失败时保留输入，保存成功以服务端返回值为准。自动探测开关仍控制原有周期任务；
以 `--no-refresh` 启动时，保存设置不会恢复自动任务。

## Gemini 与 Cline 网络连接

这两条渠道的登录、续期和模型请求会读取 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`；没有环境代理时，Windows 自动读取当前用户的手动系统代理。环境代理遵守 `NO_PROXY`，系统代理遵守 `ProxyOverride`，回环请求不自动使用代理。无需设置 `NODE_USE_ENV_PROXY`。

Windows 手动代理配置最多缓存 30 秒；PAC 自动配置脚本不在支持范围内。Gemini 需要能访问 Google 的授权、令牌、身份和 Code Assist 端点；浏览器授权成功不代表后台连接成功，网络错误会显示连接路径和底层错误码。免费车道的出口见下一节。

## 出口与 429 故障转移

免费车道的额度按**出口地址**计算，同一出口的 429 不会因为换会话而消失。独立服务
因此支持一个本地出口：默认直连，被 429 拒绝时换一个节点再试。

### 配置

管理页暂未提供入口，直接编辑 `settings.json` 后重启服务：

```json
"egress": {
  "enabled": true,
  "mode": "subscription",
  "policy": "failover",
  "url": "<订阅链接>",
  "mihomoPath": "",
  "nodeCooldownHours": 5,
  "delayRefreshMinutes": 60,
  "maxAttempts": 3
}
```

| 字段 | 含义 |
| --- | --- |
| `enabled` | 是否把出口跑起来。关闭即完全直连，其余字段不生效 |
| `mode` | `subscription` 由本服务拉起 mihomo 加载订阅；`client` 直接拨一个现成代理（如 `http://127.0.0.1:7890`），不能换节点 |
| `policy` | `always` 全部走出口（旧行为）；`failover` 默认直连，429 才切 |
| `url` | 订阅链接或代理地址。含凭据，只写不读，日志只显示主机名 |
| `mihomoPath` | 留空则在 `PATH` 与常见安装目录里查找 |
| `nodeCooldownHours` | 一个节点被 429 后要冷却多久，默认 5 |
| `delayRefreshMinutes` | 延迟测量间隔，默认 60 分钟 |
| `maxAttempts` | 一个回合最多试几个出口，默认 3（直连 + 2 个节点） |

**mihomo 用本机已有的二进制**，不随包分发：`/usr/local/bin/mihomo`、`PATH` 里的
`mihomo`，或 `mihomoPath` 指定的路径。缺失时报错指向该字段，不会静默失败。

### 节点域名必须用订阅自带的 DNS 解析

这是本功能唯一一个真正容易踩的坑。订阅里的节点主机名**不在公共 DNS 里**：用系统
解析器拿到的地址不接受节点端口，表现为"所有节点都超时"。实测同一份订阅：

| 解析方式 | 结果 |
| --- | --- |
| 系统解析器 | 71 个节点全部 TCP 超时 |
| 订阅自带的 DoH 段 | 68–71 个可用，香港 214 ms、新加坡 324 ms |

因此服务会读取订阅里的 `dns:` 段并原样写进自己的 mihomo 配置（只去掉 `listen:`，
避免和本机解析器抢端口）。订阅读不到时退回系统解析并写一条日志，节点多半不可用。

### 选哪个节点：一个池子，按延迟排

**直连也是池子里的一员，延迟记为 0。** 收到请求时，取"上次 429 已超过 5 小时"的节点中
延迟最低的那个发起；任何一条路径被 429，它就像节点一样冷却 5 小时并退出池子，下一次
按同样的规则重选，最多重试 `maxAttempts - 1` 次（默认共 3 次尝试）。切换路径时同时
换一个新的会话 id。

因为直连的延迟是 0，健康时它永远排第一；一旦它 429，接下来五个小时所有回合都直接从
最快的节点起步，日志里会写一行：

```
our-free-model: starting on "🇭🇰1香港-专线(AnyTLS)" (the direct route is cooling)
```

mihomo 的分组是 `select`，节点由插件决定而不是让 mihomo 自己 `url-test` 重排——因为
选择要记住 429，而 `url-test` 只记得最近一次延迟。

`<数据目录>/egress/nodes.json`（0600）记录每个路径，`direct` 也在其中：

```jsonc
{ "version": 1, "updatedAt": 1793449637001,
  "nodes": {
    "direct": { "delayMs": 0, "last429At": 1793449000000 },
    "🇭🇰1香港-专线(AnyTLS)": { "delayMs": 213, "delayAt": 1793449637001, "last429At": 0, "lastFailAt": 0, "fails": 0 }
  } }
```

- **延迟**：每小时测量一次（`delayRefreshMinutes`），升序选；旧读数只是排序提示，不会因此排除节点
- **429**：`last429At` 在 `nodeCooldownHours`（默认 5 小时）内排除该路径；过了窗口自动回到池子
- **连接失败**：只冷却 10 分钟。这条只作用于节点，不作用于直连——出站被重置说明不了本机地址有问题
- **全部冷却**：取 429 最早的那条再试一次，而不是直接放弃

### 一次 429 会发生什么

```
第 1 次：直连              429 → 直连冷却 5 小时、换会话 id
第 2 次：🇭🇰1香港 (213ms)   429 → 该节点冷却、换会话 id
第 3 次：🇭🇰2香港 (213ms)   429 → 到达 maxAttempts，交还失败
```

429 时请求没被受理、没生成内容，重发是安全的；其它 4xx 是请求本身的问题，换地址也
是同样的答案，超时与断流同样不切换。切换各留一行日志，原始报错也留在日志里：

```
our-free-model: code=RATE_LIMIT status=429 raw="Free usage limit reached. Free models work in OpenCode ..."
our-free-model: RATE_LIMIT from the direct route; retrying over "🇭🇰2香港-专线(AnyTLS)" with a fresh session
```

**会话 id 为什么要换**：它按 `ses_<反向时间戳><base62>` 的编码被上游校验，是我们自己铸的；
同一个 id 被拒后再拿去新地址试，等于把旧账带过去。只有重试那一跳换，正常回合沿用对话
自己的 id，上游 KV 缓存不受影响。

### 托管细节

配置写在 `<数据目录>/egress/mihomo.yaml`，混合端口与控制器端口随机分配且都带本机
凭据；订阅与 DNS 段都在这份 0600 文件里。子进程退出会写日志。`client` 模式不托管
任何进程。

## 对外的错误文案

调用方看到的错误只有“状态码 + 固定短语”，例如 `429 usage limit reached`、
`403 this client is not allowed to use the model`、`502 the upstream gateway failed`。
上游自己的整句话（包括它的产品名、网址和升级提示）只写进日志，不出现在任何 API
响应里，`-free` 之类的字样同样不会出现。

未知的上游错误不会退化成透传：归类不出来的失败回答 `NNN the model request failed`，
没有状态码的回答 `the model request failed`。

自己写的提示照常返回，因为它们只讲怎么修，不提供应商：模型名不存在、请求体校验失败、
工具调用违约、空响应、`the gateway's front proxy answered HTTP 503 with an HTML error
page` 等。

日志行形如：

```
our-free-model: code=LANE_LOCKED status=403 model=deepseek-v4.1-flash-free raw="OpenCode's free tier can only be used from within OpenCode"
```

`journalctl -u dsh-our-free-model -f | grep 'our-free-model: code='` 可看到全部上游原文。

## 验证

```powershell
npm run test:standalone
npm run test:management
npm run test:standalone-channels
node scripts/channel-network-test.mjs
node scripts/standalone-lan-test.mjs
npm run test:contributor
```

独立服务专项测试只使用本机 HTTP 替身，不访问真实上游。测试覆盖独立数据与密钥、
两个 API 协议、流式响应、缓存、并发刷新、退出清理及进程级 DSH 依赖隔离。
管理专项测试覆盖会话、同源防护、设置校验与持久化、暂停后恢复、模型操作、
密钥轮换、重启与自动刷新调度；浏览器验收使用独立数据目录和本机上游替身。
渠道专项运行真实适配器与原授权逻辑，网络重定向至本机替身，覆盖多实例隔离、
工具和图片、Chat/Responses、积分锁定、备份、用量、取消与退出。未逐家验收外部真实账号登录。

加载本机替身的验收进程会在管理摘要中标记 `networkMode: fixture`，网页显示醒目的测试提示。
替身进程不能用于真实账号登录；实际使用应按上方命令启动独立服务，
并使用正式的独立数据目录，避免将测试账号和模拟额度误当成真实数据。

## 重新生成渠道产物

运行服务无需安装 React 或 esbuild，仓库包含已生成的本地脚本和样式。修改生成器或共享页面后执行：

```powershell
npm ci --prefix packages/standalone --ignore-scripts
npm run build:standalone-channels
npm run build:standalone-ui
node scripts/build-standalone-channels.mjs --check
node scripts/build-standalone-ui.mjs --check
```

生成器只替换平台承载及页面连接方式，不修改原插件的 `client.js` 与渠道包。
原渠道的 WASM 和共享核心仍来自完整仓库；单独复制本目录不能运行。
