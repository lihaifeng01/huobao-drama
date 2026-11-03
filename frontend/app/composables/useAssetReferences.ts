import { toast } from 'vue-sonner'
import { taskAPI } from '~/composables/useApi'

/** characters / scenes / props 的 reference_images（JSON 字符串或数组）→ 地址数组 */
export function parseAssetReferenceImages(raw: unknown): string[] {
  let list: unknown = raw
  if (typeof raw === 'string') {
    try { list = JSON.parse(raw) } catch { return [] }
  }
  if (!Array.isArray(list)) return []
  return list.filter((item): item is string => typeof item === 'string' && !!item.trim())
}

function parseTaskParams(raw: unknown): Record<string, any> {
  if (!raw) return {}
  if (typeof raw === 'object') return raw as Record<string, any>
  try { return JSON.parse(String(raw)) || {} } catch { return {} }
}

/**
 * 带参考图生成素材图后，在后台等任务结束：服务 / 模型不支持参考图时后端已降级为纯文字生成
 * （任务 params.referenceFallback），这里弹出提示，告诉用户结果没参考上传的图。
 * 生成结果本身由调用方原有的刷新逻辑处理，这里只负责提示。
 */
export function warnIfReferenceDropped(res: any, t: (key: string, values?: Record<string, unknown>) => string) {
  const taskId = Number(res?.image_generation_id)
  if (!taskId || !(Number(res?.reference_count) > 0)) return
  void (async () => {
    // 图片任务后端上限 10 分钟
    for (let i = 0; i < 150; i++) {
      await new Promise(r => setTimeout(r, 4000))
      let task: any
      try { task = await taskAPI.get(taskId) } catch { continue }
      if (task?.status === 'failed') return
      if (task?.status !== 'completed') continue
      const fallback = parseTaskParams(task.params).referenceFallback
      if (fallback) toast.warning(t(`assetRefs.fallback.${fallback === 'model_unsupported' ? 'model' : 'service'}`), { duration: 8000 })
      return
    }
  })()
}
