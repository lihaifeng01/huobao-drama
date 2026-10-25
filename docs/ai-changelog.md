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

**依赖安装（云端沙箱）**
- `package-lock.json` 里部分包的 resolved 地址是 `packages.aliyun.com`，沙箱网络访问不了。临时做法：把 lockfile 里 `https://packages.aliyun.com/69c39010f167bac7fd2502e3/npm/npm-registry/` 替换成 `https://registry.npmjs.org/` 后执行 `npm ci`，装完用 `git checkout` 还原 lockfile，**不要提交改过的 lockfile**。

**前端（Nuxt）**
- Nuxt 会自动导入 `ref`、`computed` 等。**不要在 `.vue` 文件里把局部变量命名为 `ref` / `computed` / `watch` / `reactive`**：自动导入一旦检测到同名的本地声明，就会放弃给整个文件注入导入，页面运行时报 `ref is not defined`（2026-10-25 踩过）。
- `components/` 下的组件自动注册，模板里直接用，无需 import。
- vue-i18n 文案里的 `@` 要写成 `{'@'}`，否则整段文案编译失败（报 `SyntaxError: 10`），**所在组件整块不渲染**。`frontend/tests/character-looks-structure.test.mjs` 会扫描四个语言文件拦截这个问题。新增文案要同时加 zh / en / ja / ko 四个语言文件。
- 在一个弹窗里再打开另一个弹窗（比如素材详情弹窗里的「合并角色」），第二个弹窗要用 `<Teleport to="body">`，否则会被第一个弹窗盖住、点不到。
- 图片路径在库里存相对路径 `static/...`，展示时补前导 `/`；列表用 `thumbOf()` 取缩略图，加载失败时用 `thumbFallback` 回退原图。

**后端**
- 删除一律软删除（写 `deleted_at`），不要物理删除行或文件。
- 新表写在 `src/db/sqlite-schema.ts`（DDL，启动时幂等执行）和 `src/db/schema.ts`（Drizzle 定义）。`CREATE TABLE IF NOT EXISTS` 不会给已存在的表补列，给已有表加列用 `sqlite-schema.ts` 里的 `ADDED_COLUMNS`：启动时先查 `PRAGMA table_info`，缺列才执行 `ALTER`。
  - `feature/asset-library` 和 `feature/character-consistency` 两个分支各自加了这套机制，代码相同，只是 `ADDED_COLUMNS` 数组里的条目不同。将来两个分支都合并时，`sqlite-schema.ts` 会冲突，**把两边的数组条目合在一起即可**。
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
- 要验证真实的生图流程，可以起一个本地 HTTP 服务模拟 OpenAI 图片接口（`/v1/images/generations` 和 `/v1/images/edits`，返回 `{ data: [{ b64_json }] }`），再用 `POST /ai-configs` 添加一个 `provider: openai`、`base_url` 指向这个服务的配置。这样能检查参考图有没有真的发出去、生成结果写回到了哪里。

---

## 变更条目

### 2026-10-25 · 角色别名与合并重复角色；角色造型（多套服装/妆发）
- **分支**：`feature/character-consistency`（未合并），接在「定妆锁定」之后
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
- **分支**：`feature/character-consistency`（基于 `master`，未合并）
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
- **分支**：`feature/asset-library`（基于 `master`，未合并；分两次提交）
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

来自 2026-10-25 关于「跨集角色一致性」的讨论，第 1、2、3、4 项已在上面实施：

- **火山引擎图片适配器支持参考图**：让 Seedream 生成造型图时也能参考人脸。需要先用真实接口确认参数格式。
- **前情摘要**：每集完成后生成摘要，提供给后续集的改写和分镜 Agent。目前 Agent 上下文只有 `episodeId` 和 `dramaId`（`backend/src/agents/context.ts`），拿不到前几集的剧情。
