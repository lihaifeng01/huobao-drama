/**
 * OpenAI DALL-E 图片生成 Adapter
 * 文生图端点: /v1/images/generations (注意 /v1 前缀)
 * 参考生图端点: /v1/images/edits (multipart/form-data, image[] 文件上传)
 * 响应格式: { data: [{ url: "..." }] } 或 { data: [{ b64_json: "..." }] }
 *
 * 硅基流动（OpenAI 兼容地址）没有 /v1/images/edits，按其官方文档单独组请求体
 * （https://api-docs.siliconflow.cn/docs/api/images-generations-post）：
 * - 参考图：image（base64 data URL 或 URL）；image2 / image3 仅 Qwen/Qwen-Image-Edit-2509 支持；
 *   FLUX Kontext 用 input_image（来自其模型发布说明，官方 API 页未列出）
 * - 尺寸：image_size（"宽x高"），Qwen-Image-Edit / Edit-2509 不支持此字段，其他模型必填；按模型推荐值就近取
 * - 不发 OpenAI 的 size / n / response_format；响应为 { images: [{ url }] }
 * 纯文生图模型不支持参考图，此时不发参考图并标记 referenceDropped。
 */
import type {
  ImageProviderAdapter,
  ProviderRequest,
  AIConfig,
  ImageGenerationRecord,
  ImageGenResponse,
  ImagePollResponse,
} from './types'
import { joinProviderUrl } from './url'
import { parseDataUrl } from '../../utils/storage.js'

/** 是否硅基流动（按服务地址的域名判断） */
export function isSiliconFlow(baseUrl: string | null | undefined): boolean {
  try {
    return /(^|\.)siliconflow\.(cn|com)$/i.test(new URL(baseUrl || '').hostname)
  } catch {
    return false
  }
}

/**
 * 硅基流动按模型决定参考图字段；null = 该模型是纯文生图、不接受参考图。
 * 依据硅基流动文档与模型发布说明：Qwen-Image-Edit / Kolors 等图生图模型用 image，FLUX.1 Kontext 用 input_image。
 */
export function siliconFlowReferenceField(model: string): 'image' | 'input_image' | null {
  if (/kontext/i.test(model)) return 'input_image'
  if (/edit|kolors/i.test(model)) return 'image'
  return null
}

/** Qwen-Image-Edit 系列：不接受 image_size；其中 Edit-2509 额外支持 image2 / image3 */
function isQwenImageEdit(model: string): boolean {
  return /qwen-image-edit/i.test(model)
}

// 硅基流动官方文档给出的推荐分辨率
const KOLORS_SIZES = ['1024x1024', '960x1280', '768x1024', '720x1440', '720x1280']
const QWEN_IMAGE_SIZES = ['1328x1328', '1664x928', '928x1664', '1472x1140', '1140x1472', '1584x1056', '1056x1584']

/**
 * 硅基流动 image_size：Kolors / Qwen-Image 取宽高比最接近的推荐值（文档强烈建议用推荐值），
 * 其他模型原样使用「宽x高」。返回 null 表示该模型不接受 image_size。
 */
export function siliconFlowImageSize(model: string, size: string | null | undefined): string | null {
  if (isQwenImageEdit(model)) return null
  const [w, h] = String(size || '1024x1024').toLowerCase().split('x').map(Number)
  const width = w > 0 ? w : 1024
  const height = h > 0 ? h : 1024
  const candidates = /kolors/i.test(model) ? KOLORS_SIZES : /qwen-image/i.test(model) ? QWEN_IMAGE_SIZES : null
  if (!candidates) return `${width}x${height}`
  const target = Math.log(width / height)
  return candidates.reduce((best, cur) => {
    const [cw, ch] = cur.split('x').map(Number)
    const [bw, bh] = best.split('x').map(Number)
    return Math.abs(Math.log(cw / ch) - target) < Math.abs(Math.log(bw / bh) - target) ? cur : best
  })
}

export class OpenAIImageAdapter implements ImageProviderAdapter {
  provider = 'openai'

  buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord): ProviderRequest {
    const model = record.model || config.model || 'gpt-image-2'
    const isGptImage = model.startsWith('gpt-image-')
    const isGptImage2 = model === 'gpt-image-2'
    const size = isGptImage2
      ? this.normalizeGptImage2Size(record.size)
      : isGptImage
      ? this.normalizeGptImageSize(record.size)
      : record.size || '1024x1024'

    // 有参考图 → 走 edits（multipart 上传图片文件）；无参考图 → 纯文生图 generations
    // 硅基流动例外：没有 edits 端点，按其文档单独组请求体（见文件头）
    const refs = this.parseReferenceImages(record.referenceImages)
    if (isSiliconFlow(config.baseUrl)) {
      return this.buildSiliconFlowRequest(config, model, record.prompt, record.size, refs)
    }
    if (refs.length) {
      return this.buildEditsRequest(config, model, record.prompt, size, refs)
    }

    const body: any = {
      model,
      prompt: record.prompt,
      size,
      n: 1,
    }

    if (!isGptImage) {
      body.response_format = 'url'
    }

    return {
      url: joinProviderUrl(config.baseUrl, '/v1', '/images/generations'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body,
    }
  }

  /** 硅基流动 /v1/images/generations：字段按其官方文档（见文件头），参考图为 JSON 字段而非 multipart */
  private buildSiliconFlowRequest(
    config: AIConfig,
    model: string,
    prompt: string | null | undefined,
    size: string | null | undefined,
    refs: string[],
  ): ProviderRequest {
    const body: Record<string, unknown> = { model, prompt: prompt || '' }
    const imageSize = siliconFlowImageSize(model, size)
    if (imageSize) body.image_size = imageSize

    let referenceDropped: ProviderRequest['referenceDropped']
    if (refs.length) {
      const field = siliconFlowReferenceField(model)
      if (!field) {
        referenceDropped = 'model_unsupported'
      } else {
        body[field] = refs[0]
        // 多参考图：仅 Qwen/Qwen-Image-Edit-2509 支持 image2 / image3
        if (/qwen-image-edit-2509/i.test(model)) {
          if (refs[1]) body.image2 = refs[1]
          if (refs[2]) body.image3 = refs[2]
        }
      }
    }

    return {
      url: joinProviderUrl(config.baseUrl, '/v1', '/images/generations'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body,
      ...(referenceDropped ? { referenceDropped } : {}),
    }
  }

  private parseReferenceImages(raw?: string | null): string[] {
    if (!raw) return []
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : []
    } catch {
      return []
    }
  }

  /**
   * /v1/images/edits：参考图以 multipart/form-data 的 image[] 文件上传。
   * 参考图在 generation.ts 已归一化为 data URL（本地压缩 / 远程下载），
   * 这里只做 base64 → Blob 的转换；multipart 边界由 fetch 自动设置，不要手填 Content-Type。
   */
  private buildEditsRequest(
    config: AIConfig,
    model: string,
    prompt: string | null | undefined,
    size: string,
    refs: string[],
  ): ProviderRequest {
    const form = new FormData()
    form.append('model', model)
    form.append('prompt', prompt || '')
    form.append('size', size)
    form.append('n', '1')

    let appended = 0
    for (const ref of refs) {
      const parsed = parseDataUrl(ref)
      if (!parsed) continue
      const buffer = Buffer.from(parsed.data, 'base64')
      const ext = parsed.mimeType === 'image/png' ? 'png' : parsed.mimeType === 'image/webp' ? 'webp' : 'jpg'
      form.append('image[]', new Blob([buffer], { type: parsed.mimeType }), `reference-${++appended}.${ext}`)
    }
    if (!appended) {
      throw new Error('参考图片无法解析为可上传的文件（仅支持 data URL 形式的图片）')
    }

    return {
      url: joinProviderUrl(config.baseUrl, '/v1', '/images/edits'),
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: form,
    }
  }

  private normalizeGptImageSize(size?: string | null): string {
    const allowed = ['1024x1024', '1536x1024', '1024x1536', 'auto']
    if (!size) return '1024x1024'

    const normalized = size.toLowerCase()
    if (allowed.includes(normalized)) return normalized

    const [width, height] = normalized.split('x').map(Number)
    if (!width || !height) return 'auto'
    if (width === height) return '1024x1024'
    return width > height ? '1536x1024' : '1024x1536'
  }

  private normalizeGptImage2Size(size?: string | null): string {
    if (!size) return '1024x1024'
    const normalized = size.toLowerCase()
    if (normalized === 'auto') return 'auto'

    const [rawWidth, rawHeight] = normalized.split('x').map(Number)
    if (!rawWidth || !rawHeight) return 'auto'

    const width = this.roundToMultiple(Math.min(4096, Math.max(256, rawWidth)), 16)
    const height = this.roundToMultiple(Math.min(4096, Math.max(256, rawHeight)), 16)
    return `${width}x${height}`
  }

  private roundToMultiple(value: number, multiple: number): number {
    return Math.max(multiple, Math.round(value / multiple) * multiple)
  }

  parseGenerateResponse(result: any): ImageGenResponse {
    // OpenAI DALL-E 3 目前是同步返回，但规范上也有异步 task 模式
    if (result.task_id || result.id) {
      return { isAsync: true, taskId: result.task_id || result.id }
    }
    // 硅基流动返回 { images: [{ url }] }
    const imageUrl = result.data?.[0]?.url || result.images?.[0]?.url || result.url
    if (imageUrl) {
      return { isAsync: false, imageUrl }
    }
    // b64_json 模式
    const b64 = result.data?.[0]?.b64_json
    if (b64) {
      // 对于 base64，返回特殊标记，实际处理在 extractImageBase64
      return { isAsync: false, imageUrl: undefined }
    }
    throw new Error('No image URL in response')
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return {
      url: joinProviderUrl(config.baseUrl, '/v1', `/images/task/${taskId}`),
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: undefined,
    }
  }

  parsePollResponse(result: any): ImagePollResponse {
    if (result.status === 'completed') {
      return {
        status: 'completed',
        imageUrl: result.image_url || result.data?.[0]?.url || null,
      }
    }
    if (result.status === 'failed') {
      return { status: 'failed', error: result.error?.message || 'Generation failed' }
    }
    return { status: result.status || 'processing' }
  }

  extractImageUrl(result: any): string | null {
    return result.data?.[0]?.url || result.images?.[0]?.url || result.image_url || null
  }

  extractImageBase64(result: any): { data: string; mimeType: string } | null {
    const b64 = result.data?.[0]?.b64_json
    if (b64) {
      return { data: b64, mimeType: 'image/png' }
    }
    return null
  }
}
