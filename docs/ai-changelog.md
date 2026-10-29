# AI 变更记录

记录每次由 AI 完成的功能改动、设计取舍和注意事项，供后续接手的 AI（或开发者）快速了解来龙去脉。

## 维护规则

- **开始工作前先读本文件**，尤其是「通用注意事项」与相关条目的「注意事项」。
- **每次改动完成后追加一条**，新条目写在「变更条目」最上方（倒序）。
- 条目要写清：日期、分支、做了什么、关键文件、设计取舍、注意事项/已知限制、如何验证。
- 只记录对后来者有用的信息（为什么这么做、哪里容易踩坑），不要复述 diff。
- 若某条目的功能后来被修改或推翻，在原条目末尾补一句「→ 见 YYYY-MM-DD 条目」，不要删除历史。

条目模板：

```markdown
### YYYY-MM-DD · 标题
- **分支**：`branch-name`（是否已合并）
- **改动**：……
- **关键文件**：`path/to/file`
- **设计取舍**：……
- **注意事项**：……
- **验证**：……
```

---

## 通用注意事项

**测试基线**
- `master` 上已有一批过期的结构测试一直失败（截至 2026-10-25：后端 `node --test tests/*.mjs` 失败 12 个，前端失败 25 个）。判断是否引入回归，看**失败数量和名单是否不变**，不要试图让它们全绿。
- 后端类型检查：`cd backend && npm run typecheck`。前端没有装 vue-tsc，用 `npm run generate` 能否构建成功作为基本检查。
- 后端还有一批 TypeScript 测试（`backend/tests/*.ts`，包括视频恢复、交付、中转站等），`node --test tests/*.mjs` 不会跑到它们。要用 `cd backend && npx tsx --test tests/*.ts` 单独跑，这批目前应全部通过。

**依赖安装（云端沙箱）**
- `package-lock.json` 里部分包的 resolved 地址是 `packages.aliyun.com`，沙箱网络访问不了。临时做法：把 lockfile 里 `https://packages.aliyun.com/69c39010f167bac7fd2502e3/npm/npm-registry/` 替换成 `https://registry.npmjs.org/` 后执行 `npm ci`，装完用 `git checkout` 还原 lockfile，**不要提交改过的 lockfile**。

**前端（Nuxt）**
- Nuxt 会自动导入 `ref`、`computed` 等。**不要在 `.vue` 文件里把局部变量命名为 `ref` / `computed` / `watch` / `reactive`**：自动导入一旦检测到同名的本地声明，就会放弃给整个文件注入导入，页面运行时报 `ref is not defined`（2026-10-25 踩过）。
- `components/` 下的组件自动注册，模板里直接用，无需 import。
- vue-i18n 文案里的 `@` 要写成 `{'@'}`，否则整段文案编译失败（报 `SyntaxError: 10`），**所在组件整块不渲染**。`frontend/tests/character-looks-structure.test.mjs` 会扫描四个语言文件拦截这个问题。新增文案要同时加 zh / en / ja / ko 四个语言文件。
- 在一个弹窗里再打开另一个弹窗（确认框、素材库选择、合并角色等），第二个弹窗要同时满足两点：`<Teleport to="body">`，**并且**加上 `overlay-nested` 类（`z-index: var(--z-modal-nested)`，等于 130）。剧集工作台的素材详情弹窗是 `z-index: 118`，普通 `.overlay` 只有 100，光 Teleport 照样会被盖住。分层约定写在 `studio.css` 的注释里，`frontend/tests/nested-modal-layer.test.mjs` 会检查这一点。
- 图片路径在库里存相对路径 `static/...`，展示时补前导 `/`；列表用 `thumbOf()` 取缩略图，加载失败时用 `thumbFallback` 回退原图。

**后端**
- 删除一律软删除（写 `deleted_at`），不要物理删除行或文件。
- 新表写在 `src/db/sqlite-schema.ts`（DDL，启动时幂等执行）和 `src/db/schema.ts`（Drizzle 定义）。`CREATE TABLE IF NOT EXISTS` 不会给已存在的表补列，给已有表加列用 `sqlite-schema.ts` 里的 `ADDED_COLUMNS`：启动时先查 `PRAGMA table_info`，缺列才执行 `ALTER`。
  - 以后加列直接往 `ADDED_COLUMNS` 数组里追加条目。依赖新列的索引放进 `POST_COLUMN_STATEMENTS`，它在补列之后执行。
- 写结构测试（`tests/*.structure.test.mjs`）时，如果把代码挪到了别的文件，要同步改测试里读的文件路径，别删断言。

**本地端到端验证**
- 用临时数据目录启动后端，同时托管已构建的前端，不会影响真实数据：
  ```bash
  HUOBAO_DATA_DIR=<tmp>/data SQLITE_PATH=<tmp>/data/t.sqlite3 PORT=5699 \
  FRONTEND_DIST=<repo>/frontend/.output/public npx tsx src/index.ts
  ```
  前端先执行 `npm run generate`。它会生成一个 `frontend/dist` 符号链接，不要提交。
- 沙箱里已预装 Playwright 和 Chromium，直接 `require('playwright')` 即可。
- 跳过新手引导：`localStorage.setItem('huobao:tours', JSON.stringify(['index','detail','episode']))`。
- 造测试数据时会碰到的接口约束：
  - `POST /episodes` 要求已有启用的图片/视频配置，可以显式传 `image_config_id` / `video_config_id`。
  - 剧集页的「资产制作」需要该集有剧本内容（`PUT /episodes/:id` 写 `script_content`），否则显示「尚未准备就绪」。
  - `POST /storyboards` 不接收 `video_prompt`，要再用 `PUT /storyboards/:id` 写入。
  - 角色、场景、道具创建时传 `episode_id` 才会关联到该集。
- 用 `pkill -f "tsx src/index.ts"` 停服务时，如果同一条命令里出现了这串文字，会把当前 shell 自己也杀掉。改用 `pkill -f "[t]sx src/index[.]ts"`，并且单独执行。即使用了方括号写法，如果同一条命令的 heredoc 里写了启动命令 `npx tsx src/index.ts`，也照样会被匹配。所以写启动脚本和执行它要分成两次调用。
- 要验证 Agent / 文本模型流程，同样可以模拟 OpenAI 的 `/v1/chat/completions`：`stream: true` 时返回 SSE，否则返回普通 JSON。把每次请求的 system 消息记下来，就能检查 instructions 里实际拼进了什么。
- 要验证真实的生图流程，可以起一个本地 HTTP 服务模拟 OpenAI 图片接口（`/v1/images/generations` 和 `/v1/images/edits`，返回 `{ data: [{ b64_json }] }`），再用 `POST /ai-configs` 添加一个 `provider: openai`、`base_url` 指向这个服务的配置。这样能检查参考图有没有真的发出去、生成结果写回到了哪里。

---

## 变更条目

### 2026-10-29 · 生成视频时禁止模型自带字幕
- **分支**：`dev`
- **现象**：视频模型有时会生成带字幕的视频。提示词里带「角色名说：「台词」」时尤其容易出现，而且和「字幕制作」压制的字幕重叠，事后也去不掉。
- **改动**
  - `services/video-prompt-guard.ts` 的 `withNoSubtitleDirective`：`generateVideo` 提交前，在提示词末尾追加一行约束。语言跟随全局内容语言，比如中文是「画面中不要出现字幕、对白文字或水印。」。已经带过任意语言版本的约束就不再追加，空提示词不处理。存进 `sys_task.prompt` 的就是追加后的内容，恢复任务时照用。
  - `video-prompt` 技能（四种语言）的禁止事项里加了一条：不要要求画面显示字幕或对白文字。
- **设计取舍**
  - 主要靠提交环节兜底，而不是只改 SKILL.md。原因有三：桌面版升级不会覆盖已有的技能文件（`cpSync force:false`，只有 `prompts/` 会强制刷新），Docker 只在首次启动时复制一次 workspace，镜头上已保存的视频提示词也不会重新生成。改技能只对新安装和新生成的提示词生效。
  - 只禁止字幕、对白文字和水印，不禁止所有文字：招牌、手机屏幕这类场景里本来就有的文字是正常画面。
  - ~~约束放在末尾，不打乱首行的「出场人物/场景」信息头~~ → 后来改到最前面，写法也改成短句，见下一条。
  - 目前不可关闭。如果以后有需要模型生成字幕的场景，再加开关。
- **注意事项**：这只是提示词层面的约束，模型不保证 100% 遵守，个别镜头仍可能带字，需要重新生成。各厂商的 `negative_prompt` 字段没有用：Seedance 不支持，Wan 3.0 是否支持没有核实。
- **验证**：新增 `backend/tests/video-prompt-guard.test.ts`（2 项），断言提交到视频服务的请求体和 `sys_task.prompt` 都带有这条约束。后端 TS 测试共 37 项通过，结构测试仍是 12 个失败。没有用真实视频模型对比过效果。
- **后续调整（同日）**：约束放在末尾时，用户实测仍会出字幕。在视频提示词**最前面**手动加上「注意：不要带字幕。」后，就不再出字幕了。所以改为加在开头，写法也换成这句短句（英文 `Note: no subtitles.`，日、韩同理）。用户手写的同一句话会被识别，不会重复添加。查过 Wan 3.0 官方 API：没有 `negative_prompt`，也没有字幕相关参数。官方提示词指南的做法是在提示词里写「负向清单：…无字幕水印…」。

### 2026-10-29 · 新增：字幕制作（语音识别 → SRT → 压制字幕版）
- **分支**：`feat/video-subtitles`（从 `dev` 拉出，未合并）
- **改动**
  - 设置 → AI 服务新增「字幕」服务类型（`service_type: 'subtitle'`，仅 `aliyun`），预设阿里云百炼录音文件识别，默认模型 `qwen-audio-3.0-asr-flash-filetrans`，也可选 `qwen3-asr-flash-filetrans`。「测试」走 `GET /api/v1/uploads?action=getPolicy`，不产生计费任务。
  - 剧集工作台「制作」下新增「字幕制作」子步骤（视频制作之后），主流程跑马灯变为五段。支持单镜头生成 / 重新生成、选择模式批量、全部生成；每个镜头可下载 SRT 和字幕版视频；「整集字幕」下载与成片时间轴对齐的 SRT。
  - 导出页拼接时默认使用字幕版镜头，可用「使用字幕版 / 不用字幕版」切换（`POST /merge/episodes/:id/merge` 新增 `with_subtitles`，默认 true）。
  - 剧集工作台顶栏新增「字幕」模型选择框，和文本、图片、视频一致：选中值存 `huobao:model:subtitle`，为 `provider/model` 复合键。字幕接口新增可选的 `config_id` / `model`，缺省时走默认（启用配置中优先级最高者的首个模型）。后端会校验 `config_id` 确实是字幕配置、`model` 在该配置的模型列表里。所选值在入队时记下，处理时按它解析，所以上传凭证和识别用的是同一个模型。字幕制作页的模型标签显示实际生效的模型。最初版本没有这个选择框，只能去设置页改优先级，用户反馈后补上。
  - 导出页的镜头缩略图、镜头预览弹窗和其中的下载链接都跟随这个开关（`exportVideoUrl()`），用字幕版的镜头左下角有字幕角标。最初只有拼接请求跟随开关，预览始终是原视频，用户反馈后修正。已拼好的成片不受开关影响，它是拼接当时的结果。
- **关键文件**：`backend/src/services/adapters/aliyun-asr.ts`（百炼接口）、`backend/src/services/subtitle.ts`（抽音频、队列、压制、整集 SRT）、`backend/src/utils/srt.ts`（切句与 SRT）、`backend/src/routes/subtitles.ts`、`frontend/app/views/drama/episode.vue`（`prodTab === 'subtitles'`）、`frontend/app/pages/settings.vue`。
- **流程**：ffmpeg 抽 16kHz 单声道 mp3 → `getPolicy` 拿临时上传凭证 → 表单上传到 `upload_host`，得到 `oss://` 地址（48 小时有效）→ `POST /api/v1/services/audio/asr/transcription`（`X-DashScope-Async: enable` + `X-DashScope-OssResourceResolve: enable`）→ 每 3 秒轮询 `/api/v1/tasks/{id}`，最长 15 分钟 → 下载 `transcription_url` 的 JSON → 切句写 SRT → `subtitles` 滤镜压制（`-c:a copy`）。
- **设计取舍**
  - 走百炼临时存储而不是 `PUBLIC_BASE_URL`：桌面版没有公网地址也能用。代价是 Base URL 必须是 `dashscope.aliyuncs.com` / `dashscope-intl.aliyuncs.com`，文档只在这两个域名上提供上传凭证接口（业务空间专属域名是否支持未验证）。上传和识别用的 model 必须一致。
  - 请求体按模型区分：`qwen-audio-*` 用 `input.file_urls`（数组），`qwen3-asr-*` 用 `input.file_url` 并开 `enable_words`。`parameters` 必须传，省略会导致任务失败。查询结果兼容 `output.results[]` 与 `output.result` 两种形态。
  - 状态直接存在 `storyboards` 上（新增 `subtitle_status / subtitle_error / subtitled_video_url / subtitle_source_video`，复用原本闲置的 `subtitle_url`），没进 `sys_task`。`subtitle_source_video` 记录生成时的 `video_url`，镜头视频重新生成后两者不一致即视为「已过期」，拼接和整集 SRT 都会忽略过期字幕。
  - 进程内队列，最多同时处理 2 个镜头。服务重启时 `resetInterruptedSubtitles` 把 `processing` 标为失败，需用户重试（不做断点恢复）。
  - 长句切分：有字级时间戳按字切，没有就按标点切再按字数分配时长；句末逗号句号去掉、问号叹号保留。每行宽度横屏 18、竖屏 12（全角算 1，ASCII 算 0.5）。
  - 压制直接 `spawn` ffmpeg，`cwd` 设为 SRT 所在目录、滤镜里只写文件名，避开 Windows 盘符冒号在滤镜参数里的转义问题。字体按平台选：macOS `PingFang SC`、Windows `Microsoft YaHei`、Linux `Noto Sans CJK SC`。
- **注意事项**
  - `backend/tests/remove-audio-tts-structure.test.mjs` 断言 `services/ai.ts` 里不能出现 `audio` 字样，所以 ai.ts 的注释里没写完整模型名。
  - 前端两个结构测试做了收窄而非删除：「测试」按钮允许 text 和 subtitle；禁止 `dashscope.aliyuncs.com` 的断言只作用于视频预设。
  - 视频没有音轨、或识别结果为空时状态为 `no_speech`，算作完成，不生成字幕版视频。
  - 字幕样式（字号、描边、位置）目前写死在 `burnSubtitles`，没有 UI。
  - **Docker**：运行时镜像用的是 Debian 的系统 ffmpeg（带 libass），但 slim 镜像没有中文字体，压出来的中文会是空白方块。所以 `Dockerfile` 加装了 `fonts-wqy-microhei`，Linux 下的字体名也相应改成 `WenQuanYi Micro Hei`。已用 `docker build` 在 arm64 上构建，并在容器内实际跑通识别和压制，截帧确认中文正常。
  - 切句后来又修过一次：原来超长片段按上限硬切，竖屏时会剩下「楚！」这种一两个字、只显示 0.2 秒的尾巴。现在无字级时间戳时按行数均分；有字级时间戳时，末尾过短的一条并回上一条，允许超出上限 30%。
  - **没有用真实百炼接口验证过**（没有可用的 Key），接口细节按官方文档实现：https://help.aliyun.com/zh/model-studio/qwen-audio-asr-filetrans-http-api 、https://help.aliyun.com/zh/model-studio/get-temporary-file-url 。
- **验证**
  - `backend/tests/subtitle.test.ts`（3 项）：切句与 SRT、请求体按模型区分、端到端（模拟百炼 → 抽音频、上传、识别、压制、无音轨、整集 SRT 偏移、拼接取字幕版 / 过期回退 / 关闭开关）。后端 TS 测试共 34 项通过；`.mjs` 结构测试仍是 12 个失败，前端结构测试仍是 25 个失败。
  - 本地端到端：临时数据目录 + 本地模拟百炼服务，在设置页和剧集工作台实际操作批量生成、预览字幕版、整集 SRT 下载、导出页开关。抽帧确认横屏和 720x1280 竖屏的中文字幕都正常渲染（macOS，内置 ffmpeg-static 带 libass）。
  - 注意本机默认 Node 是 v20，而 `better-sqlite3` 按 Node 22 编译。跑测试前要切到 v22（`~/.nvm/versions/node/v22.23.1/bin`）。

### 2026-10-26 · 记录：角色别名匹配的现状（未改代码）
- **分支**：`dev`，仅文档。用户决定先维持现状，有问题再改。下面描述的是当前代码的实际行为，已对照代码核实。
- **自动匹配（提取角色时）**：`save_dedup_characters` 调 `findCharacterByName`（`backend/src/services/character-identity.ts`），任一步命中就复用已有角色、不新建：
  1. 名字完全相同。
  2. 归一化后相同：去掉中 / 英文括号里的定位或别名、去空白、忽略大小写，比如「林小雨（女主）」等于「林小雨」。
  3. 归一化后命中已有角色的某个别名。
  4. 用 Agent 给的别名反查：提取指令（`services/extraction.ts`）要求 Agent 遇到剧本换称呼时，用已有角色名保存、把称呼放进 `aliases`；Agent 也能从 `read_existing_characters` 的返回里看到每个角色的 `aliases`。**反查只认已有角色的本名**（`hit.via !== 'alias'`），只撞上别人别名的不合并，防止 Agent 搞混把两个人合成一个。
- **别名自动积累**：命中已有角色时，本次的提取名和 Agent 给的别名会经 `cleanAliases` 并入该角色的别名（去重、剔除本名的变体），和其他角色名字或别名冲突的跳过。新建角色时 Agent 给的别名同样会过一遍冲突过滤。
- **需要用户手动处理的情况**
  - 新称呼第一次出现、Agent 也没认出来时，会新建一个重复角色。处理办法：项目详情 → 素材库 → 角色编辑弹窗 →「合并重复角色…」。合并后源角色的名字和别名并入目标角色，以后自动匹配。
  - 推荐的做法：事先在角色编辑弹窗的「别名 / 称呼」里填好已知叫法（用「、」或逗号分隔）。
  - 手动新建角色时，名字不能和别人的别名相同；手动填写别名时也不能和别人的名字或别名冲突。都会返回 400 和中文提示。
- **别名目前不生效的地方**（已知，暂不处理，记在下方待办）
  - **视频提示词 `@别名` 不映射参考图**：`episode.vue` 的 `getShotReferenceIndexMap` 只按角色正式名建 `@名字 → @图片N` 的映射，`@小雨` 不会被改写成参考图编号。缓解措施：提示词 Agent 用的是素材列表里的正式名；合并角色时 `rewriteMentions` 会把 `@源名`、`@源别名` 改写成 `@目标名`。只有用户手写 `@别名` 时才会遇到。
  - **分镜拆解 / 提示词 Agent 看不到别名**：`storyboard-tools.ts`、`image-prompt-tools.ts` 给 Agent 的角色列表里没有 `aliases`。剧本里用别名称呼角色时，分镜绑定哪个角色要靠模型自己从剧情推断（前情提要里有人物信息，可以帮上一部分）。
  - **不会主动提示疑似重复的角色**：合并弹窗只是列出全部其他角色，由用户自己判断和勾选。

### 2026-10-26 · 修复：弹窗内打开的确认框 / 选择器被遮挡
- **分支**：`dev`
- **现象**：在剧集工作台的角色详情弹窗里删除造型，点删除没反应。确认框其实已经打开了，但被详情弹窗盖住，点击落在了详情弹窗上。
- **原因**：剧集工作台的 `.asset-detail-overlay` 是 `z-index: 118`，`ConfirmDialog` 用的是普通 `.overlay`（100）。虽然确认框 Teleport 到了 body，但层级更低，照样被盖住。项目详情页没有这个问题，因为那里的编辑弹窗在一个单独的层叠上下文里。从剧集工作台详情弹窗打开的「从素材库选择图片」用的也是 100，按同样的原因判断也被遮挡（修复前没有单独测量）。
- **改动**
  - `studio.css` 新增「叠加模态」层：`--z-modal-nested: 130`，高于所有普通模态（100–120），低于菜单（1000），以及 `.overlay.overlay-nested`。
  - `ConfirmDialog`、`LibraryPicker`、项目详情页的合并角色弹窗都加上了 `overlay-nested`。确认框始终在最上层。
- **验证**
  - 用 Playwright 的 `elementFromPoint` 检查：剧集工作台和项目详情页里的删除造型确认框、素材库选择器，以及合并角色弹窗，都在最上层；剧集工作台里真正点击确认后，造型确实被删除了。
  - 素材库页面（25 项）和别名 / 合并 / 造型（13 项）的端到端测试回归通过。
  - 新增 `frontend/tests/nested-modal-layer.test.mjs`。前端结构测试失败数仍是 25。

### 2026-10-26 · 硅基流动请求体对照官方文档校正
- **分支**：`dev`
- **依据**：硅基流动官方 API 文档 https://api-docs.siliconflow.cn/docs/api/images-generations-post （用户在环境里放行了 `api-docs.siliconflow.cn` 后已读到原文；`api.siliconflow.cn` 本身仍不在白名单，所以没能实际调用接口）。
- **文档要点**
  - 接口：`POST /v1/images/generations`，JSON 请求体。
  - `image`：参考图，base64（`data:image/png;base64,...`）或网址都可以。
  - `image2` / `image3`：**仅 Qwen/Qwen-Image-Edit-2509 支持**。
  - `image_size`（`"宽x高"`）：**Qwen-Image-Edit / Edit-2509 不支持这个字段，其他模型都必填**。文档强烈建议使用推荐值，并列出了 Kolors 和 Qwen-Image 的推荐分辨率。
  - 文档里没有 `size` / `n` / `response_format`。
  - 响应：`{ images: [{ url }], timings, seed }`，图片网址 1 小时内有效。
  - 默认会给生成的图片加「AI 生成」明水印，可以用请求头 `X-Enable-Watermark: 0` 关闭，但关闭后开发者有法定义务自己加明水印。**这里没有改**，保持默认加水印。
- **改动**（`backend/src/services/adapters/openai-image.ts`）
  - 硅基流动单独组请求体 `buildSiliconFlowRequest`，只包含 `model`、`prompt`、`image_size`（按模型决定是否带）和参考图字段，不再发 OpenAI 的 `size` / `n` / `response_format`。
  - `siliconFlowImageSize(model, size)`：Qwen-Image-Edit 系列返回 null（不带这个字段）；Kolors / Qwen-Image 取宽高比最接近的推荐值，比如 Qwen-Image 的 1920x1080 → 1664x928；其他模型原样使用。
  - Edit-2509 有多张参考图时，依次填入 `image2` / `image3`。
- **修正了上一条的判断**：上一条认为「沿用 `size` 不改，避免影响已有尺寸」是错的。按文档，`image_size` 对非 Edit 模型是**必填**，原来只发 `size`，Z-Image-Turbo 这类模型的文生图请求本身就可能失败。
- **仍未核实**：FLUX Kontext 的 `input_image` 不在这个官方 API 页上（来自硅基流动的模型发布博客），保留原映射。
- **验证**：`backend/tests/image-reference-fallback.test.ts` 新增 2 项，按文档逐条断言请求体字段和尺寸映射，共 10 项通过；后端 TypeScript 测试共 31 项通过。

### 2026-10-26 · 图片参考图兼容：识别硅基流动；不支持参考图时降级为纯文字生成并提示
- **分支**：`dev`
- **背景**：用户在本地用硅基流动（`provider: openai`，`base_url` 为 `https://api.siliconflow.cn`，模型 `Tongyi-MAI/Z-Image-Turbo`）生成角色造型时报 `API error 404`。原因是 OpenAI 适配器只要带参考图，就把请求改发到 `/v1/images/edits`，而硅基流动没有这个端点。
- **改动**
  - `backend/src/services/adapters/openai-image.ts`：
    - `isSiliconFlow(baseUrl)`：按域名识别硅基流动（`siliconflow.cn` / `siliconflow.com`）。
    - 硅基流动带参考图时，不再走 edits，而是在 generations 的 JSON 请求体里加参考图字段。字段名由 `siliconFlowReferenceField(model)` 决定：名字里含 Kontext 的模型用 `input_image`，含 Edit 或 Kolors 的用 `image`，其余视为纯文生图模型，不发参考图，并在返回的请求上标记 `referenceDropped: 'model_unsupported'`。只发第一张参考图。
    - 响应解析兼容硅基流动的 `{ images: [{ url }] }`。
  - `backend/src/services/generation.ts`：
    - 带参考图的图片请求如果被拒（400 / 404 / 405 / 415 / 422），自动去掉参考图按纯文字重试一次，原因记为 `request_rejected`。401 / 403 / 429 / 5xx 不降级，照常失败。
    - 降级原因写入任务 `params.referenceFallback`，并打 `reference-fallback` 警告日志。
    - 请求日志里的 base64 图片折叠成 `[data URL, N chars]`。
  - 前端 `CharacterLooksPanel.vue`：造型图生成完成时，如果任务带有 `referenceFallback`，弹出警告「人脸可能与原角色不一致」，分模型不支持和服务拒绝两种文案。造型面板的说明文字也写明了支持参考图的模型。
- **设计取舍**
  - 降级而不是直接失败：至少能出图，同时明确提示人脸可能对不上。
  - 硅基流动的纯文生图模型（如 Z-Image-Turbo）可能会**悄悄忽略** `image` 字段，靠报错发现不了，所以按模型名提前判断并提示。
- **注意事项 / 未核实**
  - 当时没能访问硅基流动官方文档，字段规则来自搜索到的摘要和博客。→ 已对照官方文档核实并校正，见 2026-10-26「硅基流动请求体对照官方文档校正」条目。
  - **按模型名判断是启发式的**：名字里没有 edit / kolors / kontext、但其实支持参考图的模型，会被当成纯文生图（会提示，不会报错）。要扩充的话改 `siliconFlowReferenceField` 即可。
  - `image2` / `image3` 和 `image_size` 的处理已在后一条校正（`image_size` 对非 Edit 模型是必填，这里原来的「沿用 `size`」是错的）。
  - 降级提示目前只在造型面板里显示。其他带参考图的生图入口（`POST /tasks` 的 `reference_images`）同样会降级，但只记日志和任务参数，界面上不提示。
- **验证**
  - `backend/tests/image-reference-fallback.test.ts`（8 项，在进程内拦截 fetch，走真实的 `generateImage` → 任务 → 回写流程）：硅基流动的 Edit / Kontext / 纯文生图三种模型、`images` 响应解析、OpenAI 兼容中转 edits 404 后降级、401 不降级、不带参考图时行为不变。
  - Playwright：模拟一个 edits 返回 404 的中转服务，界面上弹出降级提示，造型图正常生成。
  - 原有的 OpenAI edits 路径（造型生图的接口测试）不受影响。后端 TypeScript 测试 29 项全部通过，结构测试失败数仍是 12 / 25。

### 2026-10-26 · `master` 合并到 `dev`
- **分支**：`dev`，用 merge commit 合入 `master` 的 4 个新提交：
  - 桌面版 4.0.9 发布和 macOS 打包修复
  - README 改版（新增 `README.en.md`、按钮式入口）
  - 视频生成恢复 / 交付改造：`sys_task` 新增 `config_id`、`config_base_url`、`stage`、`error_code` 列；新增 `services/video-download.ts`；`generation.ts` 大改
  - 桌面版启动流程和默认对话模型选择修复
- **冲突与处理**
  - `backend/src/db/sqlite-schema.ts`：`master` 在 `initSqliteSchema` 里自己写了一段给 `sys_task` 补列的循环，和 `dev` 的 `ADDED_COLUMNS` 循环挨着冲突。两段都保留，原样不改（都是幂等的）。以后再加列，统一往 `ADDED_COLUMNS` 里加。
  - `backend/src/services/generation.ts`：`getVideoAdapter(config.provider, config)` 保留 `dev` 传入的 `config`（中转站自定义适配器要用）；同时保留 `master` 新加的 `duration` 和「拿到 taskId 立即 `markPolling`」。`master` 的 MiniMax/Firemux 交付恢复那一行 `getVideoAdapter('minimax')` 没改，因为它是专门针对 Firemux 的 `/recover` 接口；恢复后的轮询走 `recoveryConfig` → `getConfigById`，已经带上了中转站的设置。
  - `frontend/app/views/drama/episode.vue` 的 `genVid`：`master` 加了「可以恢复就先恢复 / 新建前先确认」，`dev` 有参考图超限提示。合并后的顺序是：先走恢复判断和确认，再显示超限提示，这样只在真正发起新生成时才提示。
  - `README.md`：取 `master` 的中英对照版；Docker 镜像名沿用 `dev` 的 `lhf/huobao-drama`。`master` 新增的 `README.en.md` 也改成了同样的镜像名。
- **注意事项**
  - `desktop/` 目录合并后和 `master` 完全一致（`dev` 和功能分支都没改过它）。
  - 批量生成视频时，`master` 的新逻辑对之前失败的镜头会逐个弹出 `window.confirm` 确认，这是 `master` 原有的行为，合并时没有改。
- **验证**
  - 结构测试：以合并前的 `dev` 和 `master` 为两个基线做三方对比，没有「合并后失败、但在两边都通过」的测试，失败数仍是 12 / 25。
  - 后端 TypeScript 测试 21 项全部通过。
  - 后端类型检查、前端构建通过。
  - 7 组端到端测试全部重新跑过并通过：素材库、多级文件夹和选图、参考图优先级、别名合并造型（接口 + 界面）、前情摘要（接口 + 界面）。

### 2026-10-25 · 两个功能分支合并到 `dev`
- **分支**：`dev`。先后合并了 `feature/asset-library` 和 `feature/character-consistency`，都用 merge commit。两个功能分支保留，没有删除，也没有合并到 `master`。
- **合并前 `dev` 上已有的改动**（来自其他人，不在本记录的条目里）：
  - 中转站模式：`backend/src/services/adapters/custom.ts`，`agents/index.ts` 的 `getModel` 接入了 `withCustomHeadersFetch`。
  - Docker 打包优化、弹窗点 × 关闭、设置页改动。
- **冲突与处理**
  - `backend/src/db/sqlite-schema.ts`：两边各加了新表和 `ADDED_COLUMNS` 机制，git 把两个 `CREATE TABLE` 块交错在了一起。以素材库一侧为底，补进 `character_looks` 表和别名 / 造型 / 摘要的补列条目，`POST_COLUMN_STATEMENTS` 保留 `library_folders.parent_id` 的索引。核对过两侧的每一行都在结果里。
  - `backend/src/agents/index.ts`：import 冲突，同时保留 `withCustomHeadersFetch` 和 `logTaskError`。
  - `detail.vue` / `episode.vue`：两边各自新增的弹窗（`LibraryPicker`、合并弹窗、`EpisodeRecapDialog`）和图标 import 都保留。
  - `docs/ai-changelog.md`：取角色一致性分支的版本（它是素材库分支版本的超集），再改成合并后的状态。
- **注意事项**
  - 素材库的「从素材库选图」只会替换角色的**默认形象**。如果某集选用了别的造型，这一集的画面仍然用那个造型。
- **验证**：后端类型检查、全部结构测试（与 `dev` 合并前的失败名单对比）、前端构建，并重新跑了素材库、定妆锁定 / 参考图、别名合并造型、前情摘要四组端到端测试。

### 2026-10-25 · 前情摘要（跨集剧情连续性）
- **分支**：`feature/character-consistency`，接在「角色别名 / 造型」之后；2026-10-25 已合并到 `dev`
- **背景**：每集剧本单独上传，各集的 Agent 原本拿不到前几集的剧情。
- **改动**
  - `episodes` 表新增 4 列（通过 `ADDED_COLUMNS` 补列）：
    - `summary`：本集摘要。
    - `summary_source_hash`：生成摘要时所依据剧本的哈希，剧本改动后对不上即视为过期。
    - `summary_edited`：用户手动编辑过的摘要不会被自动覆盖。
    - `summary_updated_at`。
  - `backend/src/services/episode-summary.ts`：
    - `generateEpisodeSummary`：同一集的并发请求只生成一次。
    - `saveEditedSummary`、`summaryState`（none / missing / stale / fresh）。
    - `ensureSummaries`：补齐缺失的摘要，以及过期且没被手动编辑过的摘要。
    - `buildRecapBlock`：拼「前情提要」。
  - 摘要用一个内部辅助 Agent `episode_summarizer` 生成（`agents/index.ts` 的 `auxiliaryAgents`，挂在 Mastra 实例上，**不在 `validAgentTypes` 里**，所以不出现在提示词 / 技能设置页）。输出固定四段：【剧情】【人物状态】【未解悬念】【结尾】，不超过 400 字，会跟随内容语言设置。
  - 注入：`buildInstructions` 对 `script_rewriter`、`extractor`、`storyboard_breaker` 三个 Agent，在技能之后、语言指令之前拼入前情提要。
    - 范围：紧邻的前 8 集（`RECAP_MAX_EPISODES`），总长约 6000 字，单集截到 800 字，从最近一集往前放，放不下的省略。
    - 缺失或过期的摘要在这时**懒生成**，单集失败只记日志，不影响 Agent 主流程。
    - `prompt_generator` 不注入：角色和场景的图片提示词不该混进剧情。
  - 接口：
    - `GET /episodes/:id/recap`：返回前面所有集和本集的摘要状态，`in_recap` 表示该集是否在注入范围内。
    - `POST /episodes/:id/summary`：同步生成，会覆盖手动编辑的版本。
    - `PUT /episodes/:id/summary`：手动编辑，传空串清除。
  - 前端：剧集工作台顶栏新增「前情提要」按钮，打开 `components/EpisodeRecapDialog.vue`，可以查看、生成、编辑前几集和本集的摘要。手动编辑过的摘要在剧本改动后会显示过期提示。
- **设计取舍**
  - 注入点选在 `buildInstructions`：它按请求解析，已经拿得到 `episodeId`。这样聊天、提取、分镜等所有入口都自动生效，不用逐个入口去改。
  - 懒生成而不是保存剧本时就生成：不会在用户没用到时偷偷消耗 token。代价是某一集第一次运行 Agent 时可能要多等几次摘要调用（最多 8 集，3 个并发）。
  - `episode-summary.ts` 里用**动态 import** 引入 `mastra/index.js`，因为 agents → episode-summary → mastra → agents 会形成循环依赖。
- **注意事项**
  - 摘要用当时的内容语言生成，之后切换语言不会重新生成已有摘要。
  - Mastra 可能在多步循环中多次解析 instructions，前情提要每次都会重新查库（很轻）。只有缺失或过期时才会调用模型。
  - 「省略了更早的集」的提示是按前面集的总数判断的，没有剧本的空集也会被算进去。
- **验证**
  - 用本地模拟的 chat 服务通过 API 跑了 14 项：第 1 集不注入；只给缺失的那集补摘要；按集号顺序注入；三个 Agent 有、`prompt_generator` 没有；摘要最新时不重复生成；剧本改动后过期；两个 Agent 并发时只生成一次；手动编辑的不被覆盖；显式重新生成会覆盖手写；清空；没有剧本时返回 400。
  - Playwright 测了弹窗：第 1 集的提示、生成、编辑、过期提示。
  - 结构测试：`backend/tests/episode-recap-structure.test.mjs`、`frontend/tests/episode-recap-structure.test.mjs`。

### 2026-10-25 · 角色别名与合并重复角色；角色造型（多套服装/妆发）
- **分支**：`feature/character-consistency`，接在「定妆锁定」之后；2026-10-25 已合并到 `dev`
- **改动 1：别名与合并**
  - `characters.aliases`：JSON 字符串数组，通过 `ADDED_COLUMNS` 补列。
  - `backend/src/services/character-identity.ts` 统一放了 `normalizeName`、`parseAliases`、`cleanAliases`、`findCharacterByName`（按 本名 → 归一化名 → 别名 的顺序匹配）、`findAliasConflict` 和 `mergeCharacters`。`extract-tools.ts` 里原来的 `normalizeName` 已移到这里。
  - 提取：`read_existing_characters` 会返回 `aliases`。`save_dedup_characters` 支持别名命中，Agent 也可以在 `aliases` 里写剧本对这个人的其他称呼；本次提取用到的名字会自动并入别名。提取指令在 `services/extraction.ts`，四种语言的 extractor SKILL 文档也已更新。
  - 接口：
    - `PUT /characters/:id` 可以修改 `aliases`（同一项目内不能和其他角色的本名或别名冲突）。
    - `POST /characters` 不允许新建一个名字等于别人别名的角色。
    - `POST /characters/:id/merge { source_ids }` 合并重复角色。
  - 合并在一个事务里完成：
    - 集关联、镜头关联迁到目标角色（目标已有的关联去重）。
    - 造型和生成记录迁到目标角色。
    - 目标为空的字段用源角色的补上。
    - 源角色的名字和别名并入目标别名。
    - 本项目所有镜头视频提示词里的 `@源名` 改写成 `@目标名`；如果 @ 后面更长地匹配了别的角色名（比如「小雨妈」之于「小雨」）就不改。
    - 源角色软删除。
  - **合并后画面不变的规则**：源角色的默认形象，如果目标没有图，就成为目标的形象；如果目标已有不同的图，就转成目标的一个造型（用源角色名命名）。原来用源默认形象的集、镜头：
    - 集关联被迁过来的：这个集选用该造型；其中跟随本集的镜头继续跟随。
    - 目标原本已在该集的（源的集关联被去重删除）：这些镜头显式指定该造型。
  - 前端：项目详情页的角色编辑弹窗里新增「别名 / 称呼」输入框和「合并重复角色…」按钮（合并弹窗用 Teleport 渲染）。
  - 顺手修复：`GET /dramas` 和 `GET /dramas/:id` 原来会返回已软删除的角色、场景、道具，导致详情页显示已删除的素材。现在已过滤。
- **改动 2：角色造型**
  - 新表 `character_looks`。**默认造型就是角色自身的形象图，不写进这张表**，所以已有数据不需要迁移。
  - `episode_characters.look_id`：本集用哪套造型，空 = 默认造型。
  - `storyboard_characters.look_id`：单个镜头覆盖，空 = 跟随本集，**0 = 强制默认造型**（比如本集换了装，回忆镜头要用原来的样子）。
  - 接口：
    - `GET/POST/PUT/DELETE /character-looks`，在 `routes/characterLooks.ts`。删除造型时，引用它的集和镜头回到默认。
    - `PUT /episodes/:id/characters/:characterId/look` 设置本集造型；`PUT /storyboards/:id/character-look` 设置镜头覆盖。
    - `GET /episodes/:id/characters` 额外返回 `looks` 和 `episode_look_id`；`GET /episodes/:id/storyboards` 额外返回 `character_looks`（`{ 角色ID: 造型ID }`）。
  - 生成造型图：`POST /character-looks/:id/generate-image`。以角色默认形象作参考图，提示词里要求「同一个人，只换造型」。任务参数里带 `lookId`、**不带 `characterId`**，完成后 `writeBackImageAssets` 只写到这个造型，不会覆盖角色主形象。
  - 两处 `syncStoryboardCharacters`（`routes/storyboards.ts` 和 `agents/tools/storyboard-tools.ts`）原来都是先删再插。现在重建关联时会保留每个角色的 `look_id`，否则改一次角色绑定或 Agent 重拆分镜，造型选择就丢了。
  - 前端：
    - 新组件 `components/CharacterLooksPanel.vue`，放在项目详情页的角色编辑弹窗和剧集工作台的角色详情弹窗里。
    - 剧集工作台的角色卡片上有「造型 · xx」下拉，用来选本集造型。
    - 视频检查器里新增「本镜头造型」，选项有：跟随本集、默认造型、各套造型。
    - `composables/useCharacterIdentity.ts` 里的 `resolveCharacterLook(char, sb)` 按 镜头覆盖 → 本集选择 → 默认 的顺序解析。参考图（`collectShotReferences`）和参考素材面板都用它。选中的造型还没有图时，暂用默认形象。
- **注意事项 / 已知限制**
  - **火山引擎（Seedream）图片适配器目前不发送参考图**（`services/adapters/volcengine-image.ts`），所以用它生成造型图时没法参考人脸，只能靠提示词。OpenAI 和 Gemini 支持参考图。没有改火山适配器，因为没有真实接口可以验证。
  - 角色卡片和项目详情页上的大图仍然是默认形象，本集选用的造型只在卡片的标签上显示。
  - 合并时，如果源角色和目标角色都在同一集，源角色在这一集选的造型会丢失（以目标的为准）。
  - 视频提示词里的 `@别名` 不会自动映射到参考图，所以合并时会把 `@源名` 改写成目标名。
- **验证**
  - 用临时库直接调用提取工具：别名命中、Agent 给的别名反查、和别人别名冲突时不合并（测试时发现并修复了把两个人误合并的问题）。
  - 通过 API 测试别名、合并、造型的完整流程（包括「目标已在该集」的分支），用本地模拟的 OpenAI 服务确认造型生图发出了 1 张参考图、结果只写到造型上。
  - Playwright 走了一遍完整界面流程（别名 → 合并 → 新建造型并生成 → 选本集造型 → 镜头覆盖为默认造型），拦截提交请求核对参考图和 `@图片N` 改写结果。
  - 结构测试：`backend/tests/character-identity-structure.test.mjs`、`frontend/tests/character-looks-structure.test.mjs`。`backend/tests/asset-extract-structure.test.mjs` 因为代码挪了位置，测试读的文件路径已同步修改。

### 2026-10-25 · 已定妆资产锁定视觉设定；分镜参考图角色优先
- **分支**：`feature/character-consistency`（基于 `master`）；2026-10-25 已合并到 `dev`
- **背景**：每集单独上传剧本、单独提取资产。角色本来就是项目级的（`characters.drama_id` 加 `episode_characters` 多对多），按名字和归一化名字复用同一条记录，跨集用的是同一张定妆图。但有两处会让形象悄悄漂移，本次修复：
- **改动 1：定妆锁定**（`backend/src/agents/tools/extract-tools.ts`）
  - `isLocked(row) = !!row.imageUrl`：有图即视为已定妆。
  - 后续集提取合并时：
    - 角色：不再覆盖 `appearance`、`styling`；`role`、`description`（人物设定）照常合并。
    - 场景：不再覆盖 `prompt`、`lighting`。
    - 道具：不再覆盖 `description`、`finalPrompt`（原逻辑会在后续集提到该道具时把最终提示词清空）；`type` 照常合并。
  - `read_existing_*` 工具会给每个资产返回 `locked` 字段，`save_dedup_*` 的结果里也会带上 `locked` 计数。
- **改动 2：参考图优先级**（`frontend/app/views/drama/episode.vue`）
  - 新增 `collectShotReferences(sb)`，返回 `{ kept, dropped }`，顺序为**角色 → 场景 → 道具**（原来场景在最前）。超出模型上限（`refImageLimit`：Wan 3.0 为 10，其他为 9）的部分放进 `dropped`。
  - `getShotReferenceImages`（实际提交的参考图）和 `getShotReferenceIndexMap`（把 `@名字` 改写成 `@图片N名字`）都基于它，保证提交顺序和序号一致。**以后改参考图顺序只改这一个函数**。
  - 超限时：检查器显示「已提交/上限」，未提交的素材加 `.is-dropped` 样式和「未提交」标记，下方有提示；单个生成弹 toast，批量生成汇总提示。
- **设计取舍**
  - 锁定条件用「是否有图」而不是新增一个锁定字段：不用改表结构，而且「有图」正好是需要保护的时刻。
  - 只拦提取流程，用户在编辑弹窗里手动修改（走 PUT 接口）不受影响。
- **注意事项 / 已知限制**
  - 已定妆的角色如果后面换装，提取不会再更新它的描述，需要手动编辑，或等「角色造型」功能（见下方待办）。
  - 参考图按图片 URL 去重。两个资产用同一张图时，第二个没有序号，`@名字` 不会被改写（这是原有行为）。
- **验证**
  - 在临时库上直接调用提取工具，模拟两集提取（第 2 集用近名「林小雨（女主）」和新描述），检查锁定、非视觉字段合并、未定妆资产照常覆盖。
  - Playwright：一个镜头绑定 7 个角色、1 个场景、2 个道具，拦截 `POST /api/v1/tasks` 校验提交顺序和 `@图片N` 改写结果。
  - 结构测试：`backend/tests/asset-lock-structure.test.mjs`、`frontend/tests/shot-reference-priority-structure.test.mjs`。

### 2026-10-24 · 全局素材库（多级文件夹、项目内从素材库选图）
- **分支**：`feature/asset-library`（基于 `master`，分两次提交）；2026-10-25 已合并到 `dev`
- **改动**
  - 顶部导航新增「素材」（`/library`，`frontend/app/pages/library.vue`），分「角色」和「场景」两类。
  - 根目录有三块：
    - 我的文件夹：用户自建，可多级嵌套。
    - 项目文件夹：每个项目自动对应一个，实时读取该项目的 characters / scenes，**只读、不落表**。
    - 根目录文件：用户上传的图片。
  - 文件支持多选上传、拖拽上传、重命名、移动、删除、预览。文件夹支持新建（在当前位置下）、重命名、移动、删除（连同整棵子树）。面包屑显示完整路径。位置记录在 URL 参数里（`?category=&folder=&project=`）。
  - 新增 `frontend/app/components/LibraryPicker.vue`。项目详情页（`views/drama/detail.vue`）和剧集工作台（`views/drama/episode.vue`）的角色、场景卡片和详情弹窗里都加了「从素材库选择」入口，选中后把图片写回该角色/场景的 `image_url` 和 `local_path`。道具没有这个入口。
- **关键文件**
  - 后端：`backend/src/routes/library.ts`（挂在 `/api/v1/library`），表 `library_folders`（含 `parent_id`）和 `library_files`。
  - 前端：`frontend/app/composables/useApi.ts` 里的 `libraryAPI`。
- **设计取舍**
  - 项目文件夹由 `dramas` 加 `characters` / `scenes` 实时聚合，避免和项目数据不同步。
  - 素材库文件只软删除，物理文件保留。所以项目里引用了素材库图片后，再删素材库里的文件，项目不受影响。
  - 文件夹名在**同一上级目录下**唯一；移动文件夹时禁止移入它自己或它的下层文件夹（后端 `subtreeIds` 校验，前端选项里也排除）。
  - 给已有表加列：`sqlite-schema.ts` 新增 `ADDED_COLUMNS`（先查 `PRAGMA table_info`，缺列才执行 `ALTER`），依赖新列的索引放在 `POST_COLUMN_STATEMENTS`，在补列之后执行。以后加列沿用这个机制。
- **注意事项 / 已知限制**
  - 卡片按钮区空间很紧，卡片上的素材库入口是只有图标的 `btn-icon btn-sm`（样式类 `.library-pick-btn`），带文字的按钮只放在弹窗里。加按钮前先截图确认，否则角色名会被挤成竖排。
  - 素材库目前只有角色和场景两类，没有道具。
  - 剧集工作台更换图片后，会同步刷新已打开的详情弹窗（`setAssetImage`），之前的上传也有这个问题，一并修了。
- **验证**
  - 用 curl 逐个调接口（包括各种错误情况）。
  - 在旧结构的数据库上启动，验证自动补列。
  - Playwright 覆盖完整流程（素材页 26 项、嵌套文件夹和选图 18 项）。
  - 结构测试：`backend/tests/library-structure.test.mjs`、`frontend/tests/global-library-structure.test.mjs`。

---

## 待办 / 已讨论未实施

来自 2026-10-25 关于「跨集角色一致性」的讨论，第 1–5 项（含前情摘要）已在上面实施：

- **火山引擎图片适配器支持参考图**：让 Seedream 生成造型图时也能参考人脸。需要先用真实接口确认参数格式。

角色别名的已知缺口（2026-10-26 用户决定先观察，**有问题再改**，现状见同日「角色别名匹配的现状」条目）：

- **`@别名` 映射参考图**：在 `getShotReferenceIndexMap` 里把角色的别名也映射到同一个参考图编号，前端角色数据里已经有 `aliases`。
- **分镜 / 提示词 Agent 可见别名**：在 `storyboard-tools.ts` 的上下文读取和 `image-prompt-tools.ts` 的角色列表里带上 `aliases`，帮分镜绑定到正确的角色。
- **疑似重复角色提示**：在项目详情页标出可能是同一人的角色，比如名字互相包含、一个角色的名字出现在另一个的别名里，或者在合并弹窗里优先列出这些候选。
