/**
 * 自定义配置层：在官方适配器之上叠加「原样 URL / 鉴权头 / 额外字段 / 请求体模板 / 响应路径」，
 * 用于中转站等与官方协议不一致的端点。未设置 custom 时行为与官方适配器完全一致。
 */
import type {
  AIConfig,
  CustomOptions,
  CustomResponseOptions,
  ImageProviderAdapter,
  ProviderRequest,
  VideoGenerationRecord,
  VideoGenResponse,
  VideoPollResponse,
  VideoProviderAdapter,
} from './types'

const AUTH_SCHEMES = ['bearer', 'raw', 'x-api-key', 'none'] as const
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const AUTH_HEADER_NAMES = new Set(['authorization', 'x-api-key', 'x-goog-api-key'])

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

// ============ 配置解析与校验 ============

function normalizeUrl(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined
  const s = String(value).trim()
  if (!s) return undefined
  if (!/^https?:\/\//i.test(s)) throw new Error(`${field} 必须以 http:// 或 https:// 开头`)
  return s
}

function normalizeObject(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (!isPlainObject(value)) throw new Error(`${field} 必须为 JSON 对象`)
  return Object.keys(value).length ? value : undefined
}

function normalizeStringList(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new Error(`${field} 必须为字符串数组`)
  const list = value.map(v => String(v).trim()).filter(Boolean)
  return list.length ? list : undefined
}

function normalizeResponse(value: unknown): CustomResponseOptions | undefined {
  if (value === undefined || value === null) return undefined
  if (!isPlainObject(value)) throw new Error('response 必须为对象')
  const out: CustomResponseOptions = {}
  for (const key of ['task_id_path', 'status_path', 'video_url_path', 'error_path'] as const) {
    const s = typeof value[key] === 'string' ? (value[key] as string).trim() : ''
    if (s) out[key] = s
  }
  const done = normalizeStringList(value.done_values, 'response.done_values')
  const failed = normalizeStringList(value.failed_values, 'response.failed_values')
  if (done) out.done_values = done
  if (failed) out.failed_values = failed
  return Object.keys(out).length ? out : undefined
}

/** 校验并规整前端提交的 custom；非法内容抛出带中文说明的 Error，全空返回 null */
export function normalizeCustomOptions(input: unknown): CustomOptions | null {
  if (input === undefined || input === null) return null
  if (!isPlainObject(input)) throw new Error('custom 必须为对象')

  const out: CustomOptions = {}
  const generateUrl = normalizeUrl(input.generate_url, 'generate_url')
  const pollUrl = normalizeUrl(input.poll_url, 'poll_url')
  if (generateUrl) out.generate_url = generateUrl
  if (pollUrl) out.poll_url = pollUrl

  const scheme = typeof input.auth_scheme === 'string' ? input.auth_scheme.trim() : ''
  if (scheme) {
    if (!(AUTH_SCHEMES as readonly string[]).includes(scheme)) {
      throw new Error(`auth_scheme 仅支持 ${AUTH_SCHEMES.join(' / ')}`)
    }
    out.auth_scheme = scheme as CustomOptions['auth_scheme']
  }

  const headers = normalizeObject(input.headers, 'headers')
  if (headers) {
    const clean: Record<string, string> = {}
    for (const [name, raw] of Object.entries(headers)) {
      const value = String(raw)
      if (!HEADER_NAME_RE.test(name) || /[\r\n]/.test(value)) throw new Error(`非法请求头: ${name}`)
      clean[name] = value
    }
    out.headers = clean
  }

  const bodyTemplate = normalizeObject(input.body_template, 'body_template')
  const extraBody = normalizeObject(input.extra_body, 'extra_body')
  if (bodyTemplate) out.body_template = bodyTemplate
  if (extraBody) out.extra_body = extraBody
  if (bodyTemplate && !out.generate_url) throw new Error('使用请求体模板时必须填写提交 URL（generate_url）')

  const response = normalizeResponse(input.response)
  if (response) out.response = response

  return Object.keys(out).length ? out : null
}

/** 读取已保存的 settings JSON 中的 custom；损坏数据一律视为未设置 */
export function parseCustomOptions(settingsRaw: string | null | undefined): CustomOptions | null {
  if (!settingsRaw) return null
  try {
    return normalizeCustomOptions(JSON.parse(settingsRaw)?.custom)
  } catch {
    return null
  }
}

// ============ 请求改写 ============

function setHeader(headers: Record<string, string>, name: string, value: string) {
  const lower = name.toLowerCase()
  for (const key of Object.keys(headers)) if (key.toLowerCase() === lower) delete headers[key]
  headers[name] = value
}

/** 按 auth_scheme 重写鉴权头，再叠加自定义头；就地修改 headers */
export function applyCustomHeaders(headers: Record<string, string>, apiKey: string, custom: CustomOptions) {
  if (custom.auth_scheme) {
    for (const key of Object.keys(headers)) if (AUTH_HEADER_NAMES.has(key.toLowerCase())) delete headers[key]
    if (apiKey) {
      if (custom.auth_scheme === 'bearer') headers.Authorization = `Bearer ${apiKey}`
      else if (custom.auth_scheme === 'raw') headers.Authorization = apiKey
      else if (custom.auth_scheme === 'x-api-key') headers['x-api-key'] = apiKey
    }
  }
  for (const [name, value] of Object.entries(custom.headers || {})) setHeader(headers, name, value)
}

function appendPathSegment(url: string, segment: string): string {
  const encoded = encodeURIComponent(segment)
  try {
    const u = new URL(url)
    u.pathname = `${u.pathname.replace(/\/+$/, '')}/${encoded}`
    return u.toString()
  } catch {
    return `${url.replace(/\/+$/, '')}/${encoded}`
  }
}

function resolveUrl(original: string, custom: CustomOptions, taskId?: string): string {
  if (taskId === undefined) return custom.generate_url || original
  if (custom.poll_url) {
    return custom.poll_url.includes('{task_id}')
      ? custom.poll_url.split('{task_id}').join(encodeURIComponent(taskId))
      : appendPathSegment(custom.poll_url, taskId)
  }
  return custom.generate_url ? appendPathSegment(custom.generate_url, taskId) : original
}

/** 对官方适配器产出的请求应用 custom（taskId 缺省表示提交请求，否则为轮询请求） */
export function applyCustomRequest(
  req: ProviderRequest,
  apiKey: string,
  custom: CustomOptions,
  taskId?: string,
): ProviderRequest {
  const headers = { ...req.headers }
  applyCustomHeaders(headers, apiKey, custom)

  let body = req.body
  if (taskId === undefined && custom.extra_body && isPlainObject(body)) {
    body = { ...body }
    for (const [key, value] of Object.entries(custom.extra_body)) {
      if (value === null) delete body[key]
      else body[key] = value
    }
  }
  return { ...req, url: resolveUrl(req.url, custom, taskId), headers, body }
}

/** 文本服务：给 AI SDK 的 fetch 叠加自定义鉴权/请求头 */
export function withCustomHeadersFetch(custom: CustomOptions, apiKey: string, inner?: typeof fetch): typeof fetch {
  const base = inner || fetch
  return ((input: any, init?: any) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries())
    applyCustomHeaders(headers, apiKey, custom)
    return base(input, { ...init, headers })
  }) as typeof fetch
}

// ============ 请求体模板 ============

type Vars = Record<string, unknown>

const EXACT_RE = /^\{\{\s*([A-Za-z_]\w*)\s*(?:\|([^}]*))?\}\}$/
const INLINE_RE = /\{\{\s*([A-Za-z_]\w*)\s*(?:\|([^}]*))?\}\}/g
const REMOVE = Symbol('remove')

function isEmptyValue(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)
}

function parseDefault(raw: string | undefined): unknown {
  if (raw === undefined) return undefined
  const s = raw.trim()
  try { return JSON.parse(s) } catch { return s }
}

function resolveVar(vars: Vars, name: string, def: string | undefined): unknown {
  const v = vars[name]
  return isEmptyValue(v) ? parseDefault(def) : v
}

function renderNode(node: unknown, vars: Vars): unknown {
  if (typeof node === 'string') {
    const exact = EXACT_RE.exec(node)
    if (exact) {
      const v = resolveVar(vars, exact[1], exact[2])
      if (isEmptyValue(v)) return REMOVE
      return Array.isArray(v) ? [...v] : v
    }
    return node.replace(INLINE_RE, (_, name, def) => {
      const v = resolveVar(vars, name, def)
      return isEmptyValue(v) ? '' : String(v)
    })
  }
  if (Array.isArray(node)) return node.map(n => renderNode(n, vars)).filter(n => n !== REMOVE)
  if (isPlainObject(node)) {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(node)) {
      const rendered = renderNode(value, vars)
      if (rendered !== REMOVE) out[key] = rendered
    }
    return out
  }
  return node
}

function parseUrlArray(raw?: string | null): string[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((u): u is string => typeof u === 'string' && !!u.trim()) : []
  } catch {
    return []
  }
}

function optionalBool(v: number | boolean | null | undefined): boolean | undefined {
  if (v === null || v === undefined) return undefined
  return v !== false && v !== 0
}

function buildTemplateVars(config: AIConfig, record: VideoGenerationRecord): Vars {
  const first = (record.firstFrameUrl || record.imageUrl || '').trim()
  const duration = Number(record.duration)
  return {
    model: record.model || config.model,
    prompt: (record.prompt || '').trim(),
    duration: Number.isFinite(duration) && duration > 0 ? duration : undefined,
    ratio: record.aspectRatio,
    resolution: record.resolution,
    generate_audio: optionalBool(record.generateAudio),
    watermark: optionalBool(record.watermark),
    prompt_extend: optionalBool(record.promptExtend),
    seed: record.seed ?? undefined,
    image: first,
    first_frame: first,
    last_frame: (record.lastFrameUrl || '').trim(),
    reference_images: parseUrlArray(record.referenceImageUrls),
    reference_videos: parseUrlArray(record.referenceVideoUrls),
    reference_audios: parseUrlArray(record.referenceAudioUrls),
    reference_file: (record.referenceFileUrl || '').trim(),
    reference_link: (record.referenceLinkUrl || '').trim(),
  }
}

// ============ 通用响应解析 ============

const DEFAULT_PATHS = {
  task_id: ['task_id', 'id', 'data.task_id', 'data.id', 'output.task_id'],
  status: ['status', 'data.status', 'task_status', 'data.task_status', 'output.task_status', 'state'],
  video_url: [
    'video_url', 'url', 'data.video_url', 'data.url', 'content.video_url', 'output.video_url',
    'video.url', 'data.video.url', 'result.video_url', 'result.url', 'results.0.url', 'data.0.url',
  ],
  error: ['error.message', 'error', 'message', 'fail_reason', 'data.fail_reason', 'data.error.message', 'data.message', 'output.message'],
}
const DEFAULT_DONE = ['succeeded', 'success', 'succeed', 'completed', 'complete', 'done', 'finished']
const DEFAULT_FAILED = ['failed', 'failure', 'fail', 'error', 'canceled', 'cancelled', 'expired', 'rejected']

function getPath(obj: unknown, path: string): unknown {
  let cur: any = obj
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined
    cur = cur[seg]
  }
  return cur
}

function pick(result: unknown, userPath: string | undefined, defaults: string[]): unknown {
  const paths = userPath ? userPath.split(',').map(s => s.trim()).filter(Boolean) : defaults
  for (const p of paths) {
    const v = getPath(result, p)
    if (!isEmptyValue(v)) return v
  }
  return undefined
}

function pickString(result: unknown, userPath: string | undefined, defaults: string[]): string | undefined {
  const v = pick(result, userPath, defaults)
  if (v === undefined) return undefined
  if (typeof v === 'string') return v
  if (typeof v === 'number') return String(v)
  return undefined
}

function stringifyError(v: unknown, fallback: string): string {
  if (typeof v === 'string' && v) return v
  if (isPlainObject(v)) return String(v.message || JSON.stringify(v))
  return fallback
}

function preview(result: unknown): string {
  try { return JSON.stringify(result).slice(0, 300) } catch { return String(result).slice(0, 300) }
}

function classifyStatus(raw: string, r: CustomResponseOptions): 'completed' | 'failed' | 'processing' {
  const s = raw.trim().toLowerCase()
  const done = (r.done_values?.map(v => v.toLowerCase())) || DEFAULT_DONE
  const failed = (r.failed_values?.map(v => v.toLowerCase())) || DEFAULT_FAILED
  if (done.includes(s)) return 'completed'
  if (failed.includes(s)) return 'failed'
  return 'processing'
}

function genericParseGenerate(result: any, r: CustomResponseOptions): VideoGenResponse {
  const status = pickString(result, r.status_path, DEFAULT_PATHS.status)
  if (status && classifyStatus(status, r) === 'failed') {
    throw new Error(stringifyError(pick(result, r.error_path, DEFAULT_PATHS.error), `提交失败: ${preview(result)}`))
  }
  const taskId = pickString(result, r.task_id_path, DEFAULT_PATHS.task_id)
  if (taskId) return { isAsync: true, taskId }
  const videoUrl = pickString(result, r.video_url_path, DEFAULT_PATHS.video_url)
  if (videoUrl) return { isAsync: false, videoUrl }
  throw new Error(`响应中未找到任务 ID 或视频地址（可在自定义配置中指定响应路径）: ${preview(result)}`)
}

function genericParsePoll(result: any, r: CustomResponseOptions): VideoPollResponse {
  const status = pickString(result, r.status_path, DEFAULT_PATHS.status)
  const videoUrl = pickString(result, r.video_url_path, DEFAULT_PATHS.video_url)

  if (status === undefined) return videoUrl ? { status: 'completed', videoUrl } : { status: 'processing' }

  const kind = classifyStatus(status, r)
  if (kind === 'completed') {
    return videoUrl
      ? { status: 'completed', videoUrl }
      : { status: 'failed', error: `任务已成功但响应中未找到视频地址: ${preview(result)}` }
  }
  if (kind === 'failed') {
    return { status: 'failed', error: stringifyError(pick(result, r.error_path, DEFAULT_PATHS.error), '视频生成失败') }
  }
  return { status: 'processing' }
}

// ============ 适配器包装 ============

export function withCustomVideo(base: VideoProviderAdapter, custom: CustomOptions): VideoProviderAdapter {
  const generic = !!(custom.body_template || custom.response)
  const r = custom.response || {}

  return {
    provider: base.provider,
    buildGenerateRequest(config, record) {
      const req: ProviderRequest = custom.body_template
        ? {
            url: custom.generate_url!,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey}` },
            body: renderNode(custom.body_template, buildTemplateVars(config, record)),
          }
        : base.buildGenerateRequest(config, record)
      return applyCustomRequest(req, config.apiKey, custom)
    },
    parseGenerateResponse: (result) => generic ? genericParseGenerate(result, r) : base.parseGenerateResponse(result),
    buildPollRequest: (config, taskId) =>
      applyCustomRequest(base.buildPollRequest(config, taskId), config.apiKey, custom, taskId),
    parsePollResponse: (result) => generic ? genericParsePoll(result, r) : base.parsePollResponse(result),
    extractVideoUrl: (result) =>
      generic ? (pickString(result, r.video_url_path, DEFAULT_PATHS.video_url) ?? null) : base.extractVideoUrl(result),
  }
}

export function withCustomImage(base: ImageProviderAdapter, custom: CustomOptions): ImageProviderAdapter {
  return {
    provider: base.provider,
    buildGenerateRequest: (config, record) =>
      applyCustomRequest(base.buildGenerateRequest(config, record), config.apiKey, custom),
    parseGenerateResponse: (result) => base.parseGenerateResponse(result),
    buildPollRequest: (config, taskId) =>
      applyCustomRequest(base.buildPollRequest(config, taskId), config.apiKey, custom, taskId),
    parsePollResponse: (result) => base.parsePollResponse(result),
    extractImageUrl: (result) => base.extractImageUrl(result),
    extractImageBase64: (result) => base.extractImageBase64(result),
  }
}
