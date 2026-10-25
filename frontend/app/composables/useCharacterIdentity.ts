/**
 * 角色身份辅助：别名解析、镜头内造型解析
 * 后端约定见 backend/src/services/character-identity.ts 与 routes/characterLooks.ts
 */

/** characters.aliases（JSON 字符串或数组）→ 字符串数组 */
export function parseAliases(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(a => String(a || '').trim()).filter(Boolean)
  if (!raw || typeof raw !== 'string') return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.map(a => String(a || '').trim()).filter(Boolean) : []
  } catch {
    return []
  }
}

interface LookLike { id: number; name: string; image_url?: string | null }
interface CharacterLike {
  id: number
  image_url?: string | null
  imageUrl?: string | null
  looks?: LookLike[]
  episode_look_id?: number | null
}
interface StoryboardLike { character_looks?: Record<number | string, number> }

/**
 * 解析角色在某镜头中使用的造型：镜头覆盖 → 本集选择 → 默认造型（角色形象图）
 * 镜头覆盖 0 = 强制默认造型（如换装后的回忆镜头）
 * 选中的造型还没有图时回落到默认形象图（fallback=true），保证仍有参考图
 */
export function resolveCharacterLook(char: CharacterLike, sb?: StoryboardLike | null) {
  const shotLookId = sb?.character_looks?.[char.id] ?? null
  const lookId = shotLookId === 0 ? null : (shotLookId ?? char.episode_look_id ?? null)
  const look = lookId ? (char.looks || []).find(l => l.id === lookId) || null : null
  const defaultImage = char.image_url || char.imageUrl || ''
  const imageUrl = look?.image_url || defaultImage
  return {
    look,
    lookId: look ? look.id : null,
    fromShot: shotLookId !== null,
    imageUrl,
    fallback: !!look && !look.image_url,
  }
}
