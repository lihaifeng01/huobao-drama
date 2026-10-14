# 更新记录

## 2026-10-14 — AI 服务「自定义配置」（中转站适配）

### 背景
视频配置选择 `aliyun` 等官方服务商后，请求 URL 会被自动追加官方路径（如 `/api/v1/services/aigc/video-generation/video-synthesis`），请求体也固定为官方结构，无法对接中转站（如 GPT Router 的 `/v1/video/generations`）。其他服务商同理。

### 新增
- 设置页「添加/编辑服务」弹窗新增折叠区「自定义配置（中转站 / 非官方端点）」，适用于文本、图片、视频：
  - **提交 URL**：原样使用，不再追加官方路径前缀；文本服务作为 Base URL 原样传给 SDK。
  - **轮询 URL**：支持 `{task_id}` 占位符；留空为「提交 URL + `/` + 任务 ID」。
  - **鉴权方式**：`Bearer 密钥` / `Authorization: 密钥`（无 Bearer）/ `x-api-key` / 不带鉴权。
  - **额外请求头**（JSON）：覆盖同名请求头。
  - **额外请求体字段**（JSON，图片/视频）：浅合并到官方请求体，值为 `null` 删除该字段。
  - **请求体模板**（JSON，仅视频）：整体替换官方请求体，不再触发 Seedance/Wan 模型名校验。变量：`{{model}}` `{{prompt}}` `{{duration}}` `{{ratio}}` `{{resolution}}` `{{generate_audio}}` `{{watermark}}` `{{seed}}` `{{first_frame}}` `{{last_frame}}` `{{reference_images}}` `{{reference_videos}}` `{{reference_audios}}`；支持默认值 `{{duration|5}}`；取值为空的字段自动省略。
  - **响应解析路径**（仅视频）：自定义任务 ID、状态、视频地址、错误信息的点号路径及成功/失败状态值；留空则自动识别常见结构。
  - 「填入 GPT Router 示例」按钮：一键填入示例 URL、鉴权与请求体模板。
- 「测试配置」配置了提交 URL 时直接探测该 URL（视频/图片发空请求体，不产生计费任务），并应用自定义鉴权与请求头；422 视为端点可达。
- 四种界面语言（zh/en/ja/ko）同步新增文案。

### 实现要点
- 配置存放于 `ai_service_configs.settings.custom`，无需改表结构；未配置时行为与之前完全一致。
- 新增 [backend/src/services/adapters/custom.ts](backend/src/services/adapters/custom.ts)：配置校验（URL 协议、请求头名/值合法性、对象类型）、请求改写、模板渲染、通用响应解析、适配器包装。
- `getImageAdapter` / `getVideoAdapter` 新增可选 `config` 参数，含 `custom` 时返回包装后的适配器；`generation.ts` 调用处同步传入。
- `getTextProviderBaseUrl` 在存在自定义提交 URL 时原样返回；文本模型的 fetch 叠加自定义鉴权/请求头。
- `/ai-configs` 的创建、更新、测试接口支持 `custom` 字段并做校验；读取接口透出 `custom`。
- 新增测试 [backend/tests/custom-video-options.test.ts](backend/tests/custom-video-options.test.ts)。

### 注意
- 请求体模板与响应路径仅对视频生效；中转站的轮询地址与返回字段如与默认推断不一致，需在轮询 URL / 响应解析路径中手动指定。
- 测试配置接口仍要求 `base_url` 非空；前端在其为空时会用提交 URL 代填。
