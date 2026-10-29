/**
 * Provider Adapter 注册表
 * 根据 provider 名称返回对应的 Adapter 实例
 */
import { OpenAIImageAdapter } from './openai-image'
import { GeminiImageAdapter } from './gemini-image'
import { VolcEngineImageAdapter } from './volcengine-image'
import { VolcEngineVideoAdapter } from './volcengine-video'
import { MiniMaxVideoAdapter } from './minimax-video'
import { AliyunWanVideoAdapter } from './aliyun-wan-video'
import { withCustomImage, withCustomVideo } from './custom'
import type { AIConfig, ImageProviderAdapter, VideoProviderAdapter } from './types'

// 图片 Adapter 注册表
export const imageAdapters: Record<string, ImageProviderAdapter> = {
  openai: new OpenAIImageAdapter(),
  gemini: new GeminiImageAdapter(),
  volcengine: new VolcEngineImageAdapter(),
}

// 视频 Adapter 注册表
export const videoAdapters: Record<string, VideoProviderAdapter> = {
  volcengine: new VolcEngineVideoAdapter(),
  minimax: new MiniMaxVideoAdapter(),
  aliyun: new AliyunWanVideoAdapter(),
}

/**
 * 获取图片 Adapter
 * @param provider 厂商名称
 * @param config 传入含 custom 的配置时，返回叠加了自定义 URL/请求头/字段的 Adapter
 * @returns 对应的 Adapter
 */
export function getImageAdapter(provider: string, config?: Pick<AIConfig, 'custom'>): ImageProviderAdapter {
  const adapter = imageAdapters[provider.toLowerCase()]
  if (!adapter) throw new Error(`Unsupported image provider: ${provider}`)
  return config?.custom ? withCustomImage(adapter, config.custom) : adapter
}

/**
 * 获取视频 Adapter
 * @param provider 厂商名称
 * @param config 传入含 custom 的配置时，返回叠加了自定义 URL/请求体/响应解析的 Adapter
 * @returns 对应的 Adapter
 */
export function getVideoAdapter(provider: string, config?: Pick<AIConfig, 'custom'>): VideoProviderAdapter {
  const adapter = videoAdapters[provider.toLowerCase()]
  if (!adapter) throw new Error(`Unsupported video provider: ${provider}`)
  return config?.custom ? withCustomVideo(adapter, config.custom) : adapter
}
