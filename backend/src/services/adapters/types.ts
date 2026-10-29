/**
 * 图片生成 Provider Adapter 接口
 */
export interface ImageProviderAdapter {
  /** 厂商标识 */
  provider: string

  /**
   * 构建图片生成请求
   * @param config AI 配置 { baseUrl, apiKey, model }
   * @param record 图片生成记录
   */
  buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord): ProviderRequest

  /**
   * 解析生成响应，判断是同步还是异步
   */
  parseGenerateResponse(result: any): ImageGenResponse

  /**
   * 构建轮询请求
   * @param config AI 配置
   * @param taskId 任务 ID
   */
  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest

  /**
   * 解析轮询响应
   */
  parsePollResponse(result: any): ImagePollResponse

  /**
   * 从响应中提取图片 URL（用于直接下载）
   * 返回 null 表示图片数据是 base64 格式，需要用 extractImageBase64 处理
   */
  extractImageUrl(result: any): string | null

  /**
   * 从响应中提取 base64 图片数据
   * 仅用于 Gemini 等只返回 base64 的厂商
   */
  extractImageBase64(result: any): { data: string; mimeType: string } | null
}

/**
 * 视频生成 Provider Adapter 接口
 */
export interface VideoProviderAdapter {
  provider: string

  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest

  parseGenerateResponse(result: any): VideoGenResponse

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest

  parsePollResponse(result: any): VideoPollResponse

  extractVideoUrl(result: any): string | null
}

// ============ 通用类型 ============

export interface ProviderRequest {
  url: string
  method: string
  headers: Record<string, string>
  /**
   * 普通请求为可 JSON 序列化的对象（generation.ts 统一 JSON.stringify）；
   * multipart 上传（如 OpenAI /v1/images/edits）直接返回 FormData，
   * 此时 headers 不要设置 Content-Type，边界由 fetch 自动生成。
   */
  body: any
  /**
   * 构建请求时已放弃参考图（如硅基流动的纯文生图模型不支持参考图），生成会按纯文字进行；
   * generation.ts 据此在任务 params 记 referenceFallback，前端提示人脸可能不一致
   */
  referenceDropped?: 'model_unsupported'
}

export interface AIConfig {
  id?: number
  provider: string
  baseUrl: string
  apiKey: string
  model: string
  /** 自定义端点/请求结构覆盖，存于 ai_service_configs.settings.custom */
  custom?: CustomOptions | null
}

/**
 * 自定义配置：让中转站等非官方端点按原样使用 URL，并适配请求/响应结构。
 * 所有字段可选，未设置的部分沿用该 provider 官方适配器的行为。
 */
export interface CustomOptions {
  /** 提交请求的完整 URL，原样使用，不再追加官方路径前缀（文本服务则作为 Base URL 原样传给 SDK） */
  generate_url?: string
  /** 轮询 URL，可含 {task_id}；缺省为 generate_url + "/" + task_id */
  poll_url?: string
  /** 鉴权头格式：bearer=Authorization: Bearer key；raw=Authorization: key；x-api-key；none */
  auth_scheme?: 'bearer' | 'raw' | 'x-api-key' | 'none'
  /** 额外请求头（覆盖同名头） */
  headers?: Record<string, string>
  /** 请求体模板（仅视频）：整体替换官方请求体，支持 {{var}} / {{var|default}} 占位符 */
  body_template?: Record<string, unknown>
  /** 额外请求体字段：浅合并到最终请求体，值为 null 表示删除该字段 */
  extra_body?: Record<string, unknown>
  /** 响应解析路径（仅视频，点号路径）；设置后改用通用解析器 */
  response?: CustomResponseOptions
}

export interface CustomResponseOptions {
  task_id_path?: string
  status_path?: string
  video_url_path?: string
  error_path?: string
  /** 视为成功的状态值（忽略大小写） */
  done_values?: string[]
  /** 视为失败的状态值（忽略大小写） */
  failed_values?: string[]
}

export interface ImageGenerationRecord {
  id: number
  model?: string | null
  prompt?: string | null
  size?: string | null
  frameType?: string | null
  referenceImages?: string | null
  // ... 其他字段
}

export interface VideoGenerationRecord {
  id: number
  model?: string | null
  prompt?: string | null
  referenceMode?: string | null
  imageUrl?: string | null
  firstFrameUrl?: string | null
  lastFrameUrl?: string | null
  referenceImageUrls?: string | null
  referenceVideoUrls?: string | null
  referenceAudioUrls?: string | null
  referenceFileUrl?: string | null
  referenceLinkUrl?: string | null
  generateAudio?: number | boolean | null
  duration?: number | null
  aspectRatio?: string | null
  resolution?: string | null
  seed?: number | null
  promptExtend?: number | boolean | null
  watermark?: number | boolean | null
  // ... 其他字段
}

export interface ImageGenResponse {
  isAsync: boolean
  taskId?: string
  /** 同步模式下直接返回的图片 URL */
  imageUrl?: string
}

export interface ImagePollResponse {
  status: 'pending' | 'processing' | 'completed' | 'failed'
  imageUrl?: string
  error?: string
}

export interface VideoGenResponse {
  isAsync: boolean
  taskId?: string
  videoUrl?: string
  duration?: number
}

export interface VideoPollResponse {
  status: 'pending' | 'processing' | 'completed' | 'failed'
  stage?: 'transferring'
  videoUrl?: string
  duration?: number
  error?: string
}
