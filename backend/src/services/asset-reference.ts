/**
 * 素材（角色 / 场景 / 道具）参考图
 *
 * 存在各表的 reference_images 列（JSON 字符串数组）。生成素材图时作为参考图发给图片模型，
 * 交给 generateImage → normalizeReferenceImages 统一转成压缩后的 data URL。
 * 服务 / 模型不支持参考图时由 generation.ts 自动降级为纯文字生成（params.referenceFallback）。
 */

export type AssetKind = 'character' | 'scene' | 'prop'

/** 单个素材最多保存的参考图数量（多数图片接口 1–4 张效果最稳；硅基流动只发第一张） */
export const MAX_ASSET_REFERENCE_IMAGES = 4

function isAcceptedRef(value: string) {
  return value.startsWith('static/') || value.startsWith('/static/') || /^https?:\/\//i.test(value)
}

/** 库里的 JSON 字符串（或数组）→ 去重后的地址数组；脏数据一律丢弃 */
export function parseReferenceImages(raw: unknown): string[] {
  let list: unknown = raw
  if (typeof raw === 'string') {
    try { list = JSON.parse(raw) } catch { return [] }
  }
  if (!Array.isArray(list)) return []
  const out: string[] = []
  for (const item of list) {
    const value = typeof item === 'string' ? item.trim() : ''
    if (!value || !isAcceptedRef(value)) continue
    const normalized = value.startsWith('/static/') ? value.slice(1) : value
    if (!out.includes(normalized)) out.push(normalized)
  }
  return out
}

/**
 * PUT 接口传入的 reference_images → 写库值。
 * 返回 { value } 或 { error }；空数组写 null。
 */
export function cleanReferenceImagesInput(input: unknown): { value: string | null } | { error: string } {
  if (input === null) return { value: null }
  if (!Array.isArray(input)) return { error: 'reference_images 必须是数组' }
  if (input.some(item => typeof item !== 'string' || (item.trim() && !isAcceptedRef(item.trim())))) {
    return { error: '参考图地址无效，只支持上传后的 static/ 路径或 http(s) 地址' }
  }
  const list = parseReferenceImages(input)
  if (list.length > MAX_ASSET_REFERENCE_IMAGES) return { error: `参考图最多 ${MAX_ASSET_REFERENCE_IMAGES} 张` }
  return { value: list.length ? JSON.stringify(list) : null }
}

/** 带参考图时追加到生图提示词末尾，说明参考图该怎么用（不同素材要保留的东西不同） */
export function referencePromptHint(kind: AssetKind, count: number): string {
  if (count <= 0) return ''
  if (kind === 'character') {
    return '参考图说明：以参考图中的人物为准，五官、脸型、发型发色、肤色、体型与服饰特征保持一致，按上述要求的构图与画风重新绘制，不要照搬参考图的背景与姿势'
  }
  if (kind === 'scene') {
    return '参考图说明：参照参考图的空间布局、建筑与陈设、材质和色调来绘制该场景，按上述要求的视角与画风重新绘制，画面中不要出现任何人物'
  }
  return '参考图说明：以参考图中的物品为准，外形、结构、材质、颜色与细节保持一致，按上述要求的白底单品构图重新绘制'
}

/** 合并提示词与参考图说明 */
export function withReferenceHint(prompt: string, kind: AssetKind, refs: string[]): string {
  const hint = referencePromptHint(kind, refs.length)
  return hint ? `${prompt.trim()}\n\n${hint}` : prompt
}
