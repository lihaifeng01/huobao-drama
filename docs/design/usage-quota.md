# 设计：用量统计与积分额度

> 状态：**一期（只统计）已实施**（2026-10-31，分支 `feat/usage-points`），二期（额度、扣减、拦截）未实施。一期的实际做法见 §0，和下文原设计有出入的以 §0 为准。
> 前置：账号体系与团队协作（见 `docs/ai-changelog.md` 2026-10-30 两条）

## 0. 一期实施情况（以此为准）

**已定的决策**（原 §11 的问题）：叫「积分」；失败退还按 §5.3；文本只统计不扣；每月发放用「重置」（二期）。

**和原设计的差异**

- 一期没有余额，所以没有建 `point_accounts` / `point_ledger`，改为**每次付费调用一行用量记录** `usage_records`，自带状态：`pending`（进行中，按请求量预估）/ `succeeded`（按实际量重算）/ `refunded`（失败已退还，不计积分）/ `held`（失败但上游可能已收费，待恢复，计积分）。二期的余额流水可以直接由这些记录的状态变化驱动。
- 规则表简化为 `point_rules (service_type, provider, model, points)`：`provider`、`model` 为空串 = 该类型默认值；`provider + model` = 单个模型覆盖。匹配顺序：provider + model 精确 → 只按 model → 类型默认。**没有做**前缀匹配、视频分辨率系数、参考成本，需要时再加列。
- 记录里存发起时的单价快照 `unit_points`，规则之后修改不影响已有记录（完成时按快照和实际量重算）。
- 可设置积分的类型：图片（每张）、视频（每秒）、字幕（每分钟，按音频时长向上取整，至少 1 分钟）。文本固定 0，只记 token（`detail` 里有输入 / 输出 token，中转站没返回用量时标 `usageMissing`）。
- 默认值种子：图片 10、视频 20、字幕 2、文本 0，`INSERT OR IGNORE`，不覆盖管理员修改。

**代码位置**

- 后端：`services/actor.ts`（AsyncLocalStorage，`authGuard` 里 `runAsActor`）、`services/usage.ts`（规则、记录、汇总查询）、`agents/usage.ts`（`generateWithUsage` 包住 5 处 `agent.generate`；`getModel` 把实际模型记到请求上下文）、`routes/usage.ts`；`services/generation.ts`（`createTask` → `trackTaskUsage`，完成 / `failTask` 时更新）、`services/subtitle.ts`（`transcribeVideoCues` 的可选 `usage` 参数，镜头字幕队列入队时记下发起人）。`sys_task` 加了 `user_id`。
- 接口：`GET /usage/summary`（四个分类）、`GET /usage/summary/:type/models`（某分类下每个模型）、`GET /usage/records`（明细，可按分类 / 模型 / 状态 / 时间 / 成员筛选，分页）、`GET|PUT /usage/rules`。普通用户只能看自己的；管理员可看全部或按成员筛选。规则读放开、改仅管理员。
- 前端：顶栏「用量」→ `pages/usage.vue`（四个分类卡片，点击展开该分类的模型用量，再点模型筛选明细）；设置 →「积分规则」→ `components/PointRulesPanel.vue`（每类默认值 + AI 服务配置里登记的每个模型，留空跟随默认）。

**一期不做**：余额、发放、扣减、402 拦截、工作台预估、账号页积分管理（都在二期）。

## 1. 背景与定位

加了账号之后，团队成员共用管理员在「设置」里配的同一批 API Key。生图、生视频、语音识别、文本模型都是按次 / 按量付费的，但现在：

- 不知道谁、哪个项目、哪个模型花了多少；
- 没法限制个人用量，一个人批量重跑视频就能把预算用完。

本设计给系统加上**用量统计**和**内部积分额度**。积分只是内部计量单位，由超级管理员分配，用来做成本控制。

### 1.1 目标

1. 记录每一次付费调用：谁发起、哪个项目、哪个服务 / 模型、用量多少、折合多少积分、结果如何。
2. 按人 / 按项目 / 按模型 / 按时间汇总，供管理员查看。
3. 可选的额度控制：超级管理员给每个账号分配积分，余额不足时不能发起新的付费任务。
4. 失败的任务按规则退还积分，不让用户为没拿到的结果买单。

### 1.2 非目标（明确不做）

- **充值、支付、订单、发票、对外售卖**。本项目许可证为 CC BY-NC-SA 4.0（禁止商用），这些功能不在本仓库实现。
- 精确到「元」的真实成本核算。各厂商计价方式不同，中转站价格也不透明，系统只按管理员配置的规则折算积分（可另填参考单价用于报表估算，见 §4.2）。
- 对外开放的计量 API / 多租户隔离。

### 1.3 两种账号模式下的行为

| | 登录模式（Web / Docker） | 免登模式（桌面版） |
|---|---|---|
| 用量统计 | 记录 | 记录（个人看自己的花费也有用） |
| 积分额度 | 可开启 | 不提供（单人使用，无意义） |
| 界面 | 余额、配额管理、用量报表 | 只在设置里显示用量报表 |

## 2. 计费点盘点（现状）

所有付费调用归为四类，入口都已经比较集中：

| 类型 | 计费入口 | 发起位置 | 计量依据 | 结果回写 |
|---|---|---|---|---|
| 图片 | `services/generation.ts` → `generateImage` → `createTask` | `routes/tasks.ts`、`characters.ts`（单个 + 批量）、`scenes.ts`、`props.ts`、`characterLooks.ts` | 张数（目前每次 1 张） | `sys_task` 状态：completed / failed |
| 视频 | `generateVideo` → `createTask` | `routes/tasks.ts` | 时长（`params.duration`，默认 5 秒）× 分辨率 | 同上，另有 `recoverVideoTask` 恢复 |
| 语音识别 | `services/subtitle.ts` → `transcribeVideoCues` | 剧集字幕（`enqueueSubtitles`）、字幕工具（`startTranscribe`） | 音频时长（识别前已用 ffprobe 读出） | 字幕状态写在 `storyboards` / `subtitle_tool_jobs` |
| 文本模型 | Mastra `agent.generate` | `routes/agent.ts`、`extraction.ts`、`episode-summary.ts`、`video-prompts.ts`、`final-prompt.ts` | token（AI SDK 返回的 `totalUsage`，中转站可能不返回） | 同步返回 |

不计费：FFmpeg 拼接、视频合成工具、压制字幕（都是本地计算）；「测试连接」（现有代码已保证不创建计费任务）。

## 3. 核心概念

- **计费规则（rule）**：「某类服务 / 某个模型，每单位扣多少积分」。管理员在设置里维护。
- **账户（account）**：每个用户一个积分余额，外加额度设置（每月发放、是否不限额）。
- **流水（ledger）**：只追加不修改的记账表，余额 = 流水合计。每一笔扣减、退还、发放、调整都是一行。
- **预扣（hold）→ 结算（settle）/ 释放（release）**：异步任务提交时先按预估量扣积分（防止并发超额），完成时按实际量多退少补，失败时按规则释放。

## 4. 数据模型

新表写在 `backend/src/db/sqlite-schema.ts` + `schema.ts`，加列走 `ADDED_COLUMNS`（遵循现有约定）。

### 4.1 `point_accounts` —— 每个用户一行

```sql
CREATE TABLE IF NOT EXISTS point_accounts (
  user_id INTEGER PRIMARY KEY,
  balance INTEGER NOT NULL DEFAULT 0,        -- 当前余额（流水合计的缓存，便于加锁校验）
  unlimited INTEGER NOT NULL DEFAULT 0,      -- 1 = 不限额（只记录不拦截）
  monthly_grant INTEGER NOT NULL DEFAULT 0,  -- 每月发放额度，0 = 不自动发放
  grant_policy TEXT NOT NULL DEFAULT 'reset',-- reset：每月重置为 monthly_grant；accumulate：每月累加
  last_granted_period TEXT,                  -- 已发放到的月份，如 '2026-11'，用于幂等
  updated_at TEXT NOT NULL
)
```

- `balance` 是缓存字段，和流水在同一个事务里更新；提供一个「按流水重算余额」的校验脚本。
- 积分用**整数**存，避免浮点误差。需要小数单价时用「千分点」等方式放大（见 §4.2）。

### 4.2 `point_rules` —— 计费规则

```sql
CREATE TABLE IF NOT EXISTS point_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_type TEXT NOT NULL,      -- image | video | subtitle | text
  provider TEXT,                   -- 为空 = 匹配该类型所有厂商
  model TEXT,                      -- 为空 = 匹配所有模型；支持前缀匹配，如 'doubao-seedance-*'
  unit TEXT NOT NULL,              -- image：per_image；video：per_second；subtitle：per_minute；text：per_1k_tokens
  points INTEGER NOT NULL,         -- 每单位积分
  resolution_factors TEXT,         -- 仅视频：JSON，如 {"480p":1,"720p":1.5,"1080p":3}
  ref_cost_cents INTEGER,          -- 可选：每单位参考成本（分），只用于报表估算，不影响扣分
  is_active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
```

**匹配顺序**：provider + model 精确 → provider + model 前缀 → 只匹配 provider → 只匹配 service_type。都没命中时用该类型的**默认规则**（种子数据，见 §9）。

**计算公式**：

- 图片：`points × 张数`
- 视频：`ceil(points × 秒数 × resolution_factor)`
- 语音识别：`points × ceil(音频秒数 / 60)`
- 文本：`ceil(points × totalTokens / 1000)`（默认 points = 0，即只记录不扣分，见 §11 待定 3）

### 4.3 `point_ledger` —— 流水（只追加）

```sql
CREATE TABLE IF NOT EXISTS point_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,          -- hold | settle | release | charge | grant | adjust
  amount INTEGER NOT NULL,     -- 有符号：扣减为负，退还 / 发放为正
  balance_after INTEGER NOT NULL,
  hold_id INTEGER,             -- settle / release 指向对应的 hold 行
  drama_id INTEGER,            -- 归属项目（工具类任务为空）
  ref_type TEXT,               -- sys_task | storyboard_subtitle | subtitle_tool_job | agent_run
  ref_id INTEGER,
  service_type TEXT,           -- image | video | subtitle | text
  provider TEXT,
  model TEXT,
  quantity REAL,               -- 计量值：张数 / 秒数 / 分钟数 / token 数
  unit TEXT,
  rule_id INTEGER,             -- 按哪条规则计算（规则之后被改也能追溯）
  operator_id INTEGER,         -- grant / adjust 的操作人
  note TEXT,
  created_at TEXT NOT NULL
)
CREATE INDEX idx_point_ledger_user ON point_ledger (user_id, created_at)
CREATE INDEX idx_point_ledger_ref ON point_ledger (ref_type, ref_id)
CREATE INDEX idx_point_ledger_drama ON point_ledger (drama_id, created_at)
```

`kind` 含义：

| kind | 何时写 | amount |
|---|---|---|
| `hold` | 异步任务提交前预扣 | 负 |
| `settle` | 任务完成，按实际量多退少补（差额为 0 也写一行，作为「已结算」标记） | 正或负 |
| `release` | 任务失败，按退还规则退回 | 正 |
| `charge` | 同步调用（文本模型）事后直接扣 | 负 |
| `grant` | 每月自动发放 / 重置 | 正或负（重置时可能为负） |
| `adjust` | 超级管理员手动加减 | 正或负 |

一笔 hold 的状态由流水推出：没有对应的 settle / release = **进行中**；有 settle = **已结算**；有 release = **已退还**。

### 4.4 现有表加列

| 表 | 列 | 用途 |
|---|---|---|
| `sys_task` | `user_id INTEGER` | 发起人。恢复任务、报表都靠它 |
| `sys_task` | `hold_id INTEGER` | 对应的预扣流水 |
| `subtitle_tool_jobs` | `hold_id INTEGER` | 同上（`user_id` 已有） |
| `storyboards` | `subtitle_hold_id INTEGER` | 剧集字幕的预扣 |

`sys_task.user_id` 即使不开积分也有价值（谁生成的这张图），建议第一期就加。

## 5. 关键流程

### 5.1 「当前操作人」怎么传到计费点

`generateImage` 有 7 个调用点，逐个加 `userId` 参数容易漏。改用 Node 的 `AsyncLocalStorage`：

- 新建 `services/actor.ts`，导出 `runAsActor(user, fn)` 和 `currentActor()`。
- `middleware/auth.ts` 的 `authGuard` 在拿到用户后执行 `return runAsActor(user, () => next())`。同一请求里的路由、服务函数、Mastra agent 的工具调用都能拿到当前用户。
- `createTask`、`transcribeVideoCues` 的调用方、agent 调用封装里读 `currentActor()`。
- **后台续跑不需要 actor**：任务创建时已把 `user_id`、`hold_id` 写进行里，之后的结算 / 释放都按行上的字段处理。`resumeInterruptedTasks` 不会重复预扣。
- 没有 actor 的调用（单元测试直接挂路由）：只记录、不扣分，和现在的工具隔离逻辑一致。

### 5.2 图片 / 视频（异步，预扣模式）

```
路由 → generateImage/Video
        └─ createTask
             ├─ 计算预估积分（规则 + 请求参数：视频取 duration × 分辨率系数）
             ├─ 事务内：检查余额 → 写 hold 流水 → 扣 balance → 插入 sys_task(user_id, hold_id)
             │     余额不足 → 抛错「积分不足：需要 N，当前余额 M」，任务不创建
             └─ runBackground(processTask)
                   ├─ 完成 → handleImageComplete / handleVideoComplete → settle（按实际量多退少补）
                   └─ 失败 → failTask → 按 §5.3 决定 release 或保持
```

- 检查和扣减必须在**同一个 SQLite 事务**里（better-sqlite3 的事务是同步的，单进程下天然串行），防止并发提交超额。
- 视频实际时长：适配器能拿到就用（如通义万相 `usage.output_video_duration`），拿不到就按请求的 duration 结算。
- 批量生成角色图（`characters/batch-generate-images`）逐个调用 `generateImage`：余额不够时前面几个成功、后面的失败。返回值里要带上「因积分不足跳过 N 个」，前端提示。

### 5.3 失败退还规则

现在的失败分几种，上游是否已经收费不同，处理也不同：

| 失败情况 | 怎么识别 | 上游是否可能已收费 | 默认处理 |
|---|---|---|---|
| 提交前 / 提交时失败 | `sys_task.taskId` 为空（上游没接单） | 否 | **全额退还** |
| 上游明确失败（含内容审核拦截） | `errorCode = generation_failed` | 多数厂商不收费 | **全额退还**（可在设置里改为不退） |
| 轮询超时 / 结果转存失败 | 有 `taskId`，`errorCode = delivery_failed` 或超时 | **可能已收费**，且可恢复 | **保持预扣**，状态显示「待恢复」 |
| 恢复成功 | `recoverVideoTask` 完成 | — | 正常 settle |
| 用户放弃恢复、强制重新生成 | `forceNew = true` 新建任务 | — | 新任务重新预扣；旧任务的预扣**仍保持**（与现有「重新生成需确认可能再次计费」提示一致） |
| 管理员处理悬挂预扣 | 用量页「待恢复」列表 | — | 管理员可手动「退还」或「确认扣除」 |

「待恢复」的预扣不会自动退还：现有代码允许任意时间恢复，自动退还后再恢复成功会少扣。如果一直没人处理，在报表里单独列出。

### 5.4 语音识别（剧集字幕 + 字幕工具）

- 剧集字幕：`enqueueSubtitles` 入队时逐个镜头预扣，hold_id 写到 `storyboards.subtitle_hold_id`。处理时识别前已经拿到音频时长，完成后按实际时长 settle；状态为 `no_speech` 时按「已调用」结算（服务端已识别过）；`failed` 时全额退还。
- 字幕工具：`startTranscribe` 时预扣（任务有 `duration` 字段），完成 / 失败同上。
- 服务重启时 `resetInterruptedSubtitles` / `resetInterruptedToolJobs` 会把进行中的任务置为失败，**同时释放预扣**（服务重启后不会续跑，用户需要重试）。

### 5.5 文本模型（同步，事后记账）

- 封装一个 `runAgent(agent, messages, options, meta)`，替换 5 处 `agent.generate` 调用。它在调用前检查余额（开启额度且余额 ≤ 0 时拒绝），调用后从 `result.totalUsage` 取 token 数写 `charge` 流水。
- token 用量拿不到时（部分中转站不返回 usage）：记一行 quantity 为空的流水，标注「未返回用量」，不扣分。
- 文本没有预扣，余额可能被扣成小负数，可以接受。
- 默认规则 points = 0：只统计 token，不扣分（见 §11 待定 3）。

### 5.6 每月发放

- 每次读取账户时检查 `last_granted_period`：如果早于当前月份就补发（惰性执行，不需要定时任务；服务停机跨月也不会漏）。
- `reset` 策略：写一行 `grant`，amount = `monthly_grant - balance`，把余额置为 monthly_grant。**进行中的预扣不受影响**（它们已经从 balance 里扣掉了，结算 / 退还时照常加减）。
- `accumulate` 策略：amount = `monthly_grant`。
- 月份按服务器时区（Docker 里是 UTC，需要在设置里可选时区，或固定按 `Asia/Shanghai`，见 §11 待定 4）。

## 6. 接口设计

挂在 `api.ts`。权限沿用现有中间件：读规则 / 改规则属于「设置」（管理员），分配积分属于「账号管理」（超级管理员）。

### 6.1 个人

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/usage/me` | 余额、是否不限额、本月发放额、本月已用、进行中预扣合计 |
| GET | `/usage/me/ledger?cursor=&limit=` | 自己的流水（分页） |
| POST | `/usage/estimate` | 预估积分：`{ items: [{ service_type, provider?, model?, quantity, resolution? }] }` → 每项积分和合计，供前端在批量操作前提示 |

### 6.2 管理员（`admin` 及以上）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/usage/summary?from=&to=&group_by=user\|drama\|model\|day&service_type=` | 汇总：次数、用量、积分、参考成本 |
| GET | `/usage/ledger?user_id=&drama_id=&kind=&from=&to=` | 全部流水 |
| GET | `/usage/pending-holds` | 「待恢复」等进行中的预扣 |
| GET / POST / PUT / DELETE | `/usage/rules` | 计费规则增删改 |
| GET / PUT | `/usage/settings` | 总开关：`quota_enabled`、`refund_on_generation_failed`、月份时区 |

### 6.3 超级管理员

| 方法 | 路径 | 说明 |
|---|---|---|
| PUT | `/users/:id/points` | 账户设置：`{ unlimited?, monthly_grant?, grant_policy? }` |
| POST | `/users/:id/points/adjust` | 手动加减：`{ amount, note }`（note 必填） |
| POST | `/usage/holds/:id/release` · `/settle` | 处理悬挂预扣 |

### 6.4 错误约定

余额不足统一返回 **402**，`{ code: 402, message: '积分不足：需要 30，当前余额 12', data: { required: 30, balance: 12 } }`。前端 `useApi` 对 402 弹统一提示，不跳转。

## 7. 前端设计

| 位置 | 内容 | 显示条件 |
|---|---|---|
| 顶栏用户菜单 | 头像旁显示余额（「1,280 点」），菜单里加「我的用量」 | 登录模式 + 开启额度 |
| `/usage/me`（我的用量） | 余额、本月已用、流水列表（可按类型筛选，点击跳转到对应项目 / 镜头） | 登录模式 |
| 剧集工作台 | 生成按钮的提示文字里带预估积分（如「生成视频 · 约 15 点」）；批量生成前的确认框显示合计 | 开启额度 |
| 剧集工作台任务列表 | 失败任务显示「已退还」或「待恢复（已预扣 15 点）」 | 开启额度 |
| 设置 → 新 tab「用量与积分」 | 总开关、退还策略、计费规则表格（按服务类型分组，可增删改，带「恢复默认」） | 管理员 |
| `/usage`（用量报表） | 时间范围 + 维度切换（人 / 项目 / 模型 / 天），表格 + 简单趋势图；「待恢复」预扣列表 | 管理员；免登模式下放在设置里 |
| 账号管理页 | 新增「积分」列（余额 / 不限额）；每行「额度设置」「调整积分」「查看流水」 | 超级管理员 + 开启额度 |

文案统一叫「积分」还是「点数 / 额度」见 §11 待定 1。新增文案按约定加四个语言文件。

## 8. 边界情况

- **并发**：同一用户同时点多个生成，扣减在事务里串行，后到的会因余额不足失败，不会扣成负数（文本模型除外，见 §5.5）。
- **用户被删除 / 禁用**：进行中的任务照常完成和结算，流水保留。
- **项目被转让**：流水记的是发起人和当时的项目，转让不影响历史归属。
- **规则被修改**：只影响之后新建的任务；已预扣的任务按 hold 时的 `rule_id` 结算。
- **免登 → 登录切换**：免登期间的流水属于本机 admin，认领后归超级管理员，自然延续。
- **超级管理员**：默认 `unlimited = 1`（只记录不拦截），可以手动改。
- **关闭额度开关**：只停止拦截，统计照常；已有预扣照常结算 / 退还。重新打开时余额保持原样。
- **余额一致性**：提供 `npm run points:verify`，按流水重算每个账户余额并和 `balance` 比对，不一致时输出差异（不自动修）。

## 9. 默认规则（种子数据，管理员可改）

数值只是起点，按管理员的实际成本调整。基准：1 点 ≈ 1 分钱的参考成本。

| 服务 | 单位 | 默认积分 |
|---|---|---|
| 图片（所有模型） | 每张 | 10 |
| 视频（所有模型） | 每秒，480p ×1 / 720p ×1.5 / 1080p ×3 | 20 |
| 语音识别 | 每分钟 | 2 |
| 文本模型 | 每 1k token | 0（只统计） |

种子写法沿用风格预设的「缺失才插入、不覆盖用户修改」。

## 10. 分期实施

| 期 | 内容 | 价值 | 风险 |
|---|---|---|---|
| **一期：只统计** | `actor` 上下文；`sys_task.user_id`；`point_rules` + `point_ledger`；所有计费点写流水（只 `charge` / 记录，不扣、不拦）；用量报表页；设置里的规则管理 | 立刻知道谁花了多少，零打扰 | 低：不改变任何现有行为 |
| **二期：额度** | `point_accounts`；hold / settle / release 全流程；402 拦截；每月发放；账号页积分管理；工作台预估和余额显示 | 能控制成本 | 中：失败分支多，结算要和任务状态机严格对齐 |
| **三期（可选）** | 项目预算（项目维度的上限）、余额不足预警、导出 CSV | 按项目控成本 | 低 |

一期上线后跑一段时间，用真实数据校准默认规则，再决定二期的额度数值。

## 11. 待你决定的问题（已决定，见 §0；保留原建议备查）

| # | 问题 | 我的建议 |
|---|---|---|
| 1 | 叫「积分」、「点数」还是「额度」 | 「点数」：中性，不像会员积分，也不暗示能充值 |
| 2 | 内容审核拦截的失败是否退还 | 默认退还，设置里可关 |
| 3 | 文本模型是否扣点 | 默认不扣，只统计 token；规则里设 points > 0 即可开启 |
| 4 | 月份按哪个时区切换 | 固定 `Asia/Shanghai`，用户群在国内 |
| 5 | 每月发放用「重置」还是「累加」 | 默认重置，防止长期不用的账号囤积大额点数 |
| 6 | 普通管理员是否默认不限额 | 不默认；只有超级管理员默认不限额 |
| 7 | 余额不足时，「待恢复」的视频任务能否继续恢复 | 能。恢复不重新扣点（预扣还在），不应被余额卡住 |
| 8 | 一期是否就加 `sys_task.user_id` 并在任务列表显示发起人 | 加，团队协作里「谁生成的」本身就有用 |

## 12. 测试要点

- **单元**：规则匹配顺序与前缀匹配；四类公式（视频分辨率系数、语音按分钟向上取整、token 向上取整）；每月发放的 reset / accumulate 与幂等。
- **流程（`backend/tests/points.test.ts`，沿用 `auth.test.ts` 的完整中间件写法）**：
  - 用模拟的图片 / 视频服务（`changelog` 通用注意事项里的本地 mock 做法）跑通「预扣 → 完成 → 结算」，以及实际时长与请求时长不同时的差额。
  - 失败分支逐个覆盖 §5.3 表格：提交失败退还、上游失败退还 / 不退、超时保持预扣、恢复后结算、强制重新生成再次预扣。
  - 余额不足返回 402，任务不创建；并发两个请求只有一个成功。
  - 批量生成角色图在余额中途耗尽时的部分成功与返回信息。
  - 服务重启：进行中的图片 / 视频任务续跑后正常结算，不重复预扣；字幕任务被复位时释放预扣。
  - 关闭额度后只记录不拦截；免登模式不拦截。
  - `points:verify` 在人为篡改 balance 后能报出差异。
- **端到端（Playwright）**：工作台显示预估点数；余额不足的提示；账号页调整积分后余额实时变化；报表按人 / 项目切换。

## 13. 涉及的现有文件（预估）

- 后端：`services/generation.ts`（createTask / failTask / 完成回调 / recover）、`services/subtitle.ts`、`services/subtitle-tool.ts`、5 处 `agent.generate` 调用、`middleware/auth.ts`（actor 上下文）、`routes/tasks.ts`（402 透传）、`routes/characters.ts`（批量结果）、`db/sqlite-schema.ts`、`db/schema.ts`、`api.ts`。
- 新增：`services/actor.ts`、`services/points.ts`（规则匹配、hold / settle / release、发放）、`routes/usage.ts`。
- 前端：`composables/useApi.ts`（402 处理、usageAPI）、`layouts/default.vue`、`pages/users.vue`、`pages/settings.vue`（新 tab）、新增 `pages/usage.vue`、`views/drama/episode.vue`（预估与任务状态）、四个语言文件。
