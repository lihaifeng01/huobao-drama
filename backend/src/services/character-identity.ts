/**
 * 角色身份：别名、按名字/别名匹配同一角色、合并重复角色
 *
 * 跨集一致性依赖「同一个人始终是同一条 characters 记录」：
 * - 提取去重时，名字、归一化名字、别名任一命中即复用已有角色（见 extract-tools save_dedup_characters）
 * - 已经重复创建的角色可由用户合并：关联、造型、生成记录迁到目标角色，源角色名并入别名后软删除
 */
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'

type CharacterRow = typeof schema.characters.$inferSelect

const ALIAS_MAX = 20
const ALIAS_LEN_MAX = 50

/** 名字归一化：去掉括号内的定位/别名、空白，统一小写（「林小雨（主角）」≡「林小雨」） */
export function normalizeName(name: string): string {
  return (name || '')
    .replace(/[（(][^（()）]*[）)]/g, '') // 去掉成对的中/英文括号内容（角色定位/别名）
    .replace(/[（(].*$/, '')              // 兜底：未闭合括号从首个括号截断
    .replace(/[\s　]+/g, '')          // 去空白与全角空格
    .toLowerCase()
    .trim()
}

/** 库中 aliases（JSON 字符串）→ 数组；容错非法 JSON */
export function parseAliases(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.map(a => String(a || '').trim()).filter(Boolean) : []
  } catch {
    return []
  }
}

/**
 * 规整用户/Agent 传入的别名：支持数组或「、，, /」分隔的字符串；
 * 去空、截长、按归一化去重，并剔除与角色本名相同的项
 */
export function cleanAliases(input: unknown, ownName: string): string[] {
  const list = Array.isArray(input)
    ? input
    : String(input ?? '').split(/[、，,/／\n]+/)
  const own = normalizeName(ownName)
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of list) {
    const alias = String(item ?? '').trim().slice(0, ALIAS_LEN_MAX)
    const key = normalizeName(alias)
    if (!alias || !key || key === own || seen.has(key)) continue
    seen.add(key)
    out.push(alias)
    if (out.length >= ALIAS_MAX) break
  }
  return out
}

/** 角色的全部身份键（归一化后的本名 + 别名） */
export function identityKeys(char: Pick<CharacterRow, 'name' | 'aliases'>): Set<string> {
  const keys = new Set<string>()
  const own = normalizeName(char.name)
  if (own) keys.add(own)
  for (const alias of parseAliases(char.aliases)) {
    const key = normalizeName(alias)
    if (key) keys.add(key)
  }
  return keys
}

/**
 * 在同项目角色中找与 name 对应的角色：精确本名 → 归一化本名 → 别名
 * 返回 { match, via }，via 用于日志（'exact' | 'name' | 'alias'）
 */
export function findCharacterByName(chars: CharacterRow[], name: string): { match?: CharacterRow; via?: 'exact' | 'name' | 'alias' } {
  const exact = chars.find(c => c.name === name)
  if (exact) return { match: exact, via: 'exact' }
  const key = normalizeName(name)
  if (!key) return {}
  const byName = chars.find(c => c.name && normalizeName(c.name) === key)
  if (byName) return { match: byName, via: 'name' }
  const byAlias = chars.find(c => parseAliases(c.aliases).some(a => normalizeName(a) === key))
  if (byAlias) return { match: byAlias, via: 'alias' }
  return {}
}

/** 别名不能与同项目其他角色的本名/别名冲突，返回首个冲突（无冲突返回 null） */
export function findAliasConflict(chars: CharacterRow[], aliases: string[], exceptId: number): { alias: string; owner: string } | null {
  for (const alias of aliases) {
    const key = normalizeName(alias)
    const owner = chars.find(c => c.id !== exceptId && identityKeys(c).has(key))
    if (owner) return { alias, owner: owner.name }
  }
  return null
}

export async function projectCharacters(dramaId: number) {
  return db.select().from(schema.characters)
    .where(and(eq(schema.characters.dramaId, dramaId), isNull(schema.characters.deletedAt)))
}

/**
 * 视频提示词里把 @源名 改写为 @目标名。按 @ 后的整段文本前缀匹配（与前端 resolveVideoPromptRefs 一致），
 * 若该段更长地匹配了其他角色名（如「小雨妈」之于「小雨」），则不改写
 */
export function rewriteMentions(prompt: string, fromNames: string[], toName: string, otherNames: string[]): string {
  if (!prompt) return prompt
  const froms = [...new Set(fromNames.filter(Boolean))].sort((a, b) => b.length - a.length)
  return prompt.replace(/@([^\s@]+)/g, (m, raw: string) => {
    const from = froms.find(n => raw.startsWith(n))
    if (!from) return m
    if (otherNames.some(o => o.length > from.length && raw.startsWith(o))) return m
    return `@${toName}${raw.slice(from.length)}`
  })
}

export interface MergeResult {
  merged: string[]
  episodeLinks: number
  storyboardLinks: number
  looksMoved: number
  looksCreated: number
  promptsRewritten: number
}

/**
 * 把 sourceIds 合并进 targetId（同一项目），单事务完成：
 * 1. 源角色默认形象：目标无图 → 继承为目标形象；目标有图且不同 → 转为目标的一个造型（以源名命名），
 *    原先使用源默认形象的集/镜头改为指向该造型，保证已有画面不变
 * 2. 集关联、镜头关联迁到目标（目标已关联的去重）
 * 3. 源角色的造型、生成记录迁到目标
 * 4. 目标空字段由源补齐；源本名与别名并入目标别名
 * 5. 本项目镜头视频提示词中的 @源名 改写为 @目标名
 * 6. 源角色软删除
 */
export function mergeCharacters(target: CharacterRow, sources: CharacterRow[], allInProject: CharacterRow[]): MergeResult {
  const ts = new Date().toISOString()
  const result: MergeResult = { merged: [], episodeLinks: 0, storyboardLinks: 0, looksMoved: 0, looksCreated: 0, promptsRewritten: 0 }

  db.transaction((tx) => {
    let targetImage = target.imageUrl
    const targetUpdates: Partial<typeof schema.characters.$inferInsert> = { updatedAt: ts }
    let aliases = parseAliases(target.aliases)

    for (const src of sources) {
      // 1. 源默认形象的去向
      let defaultLookId: number | null = null
      if (src.imageUrl && !targetImage) {
        targetImage = src.imageUrl
        targetUpdates.imageUrl = src.imageUrl
        targetUpdates.localPath = src.localPath
        targetUpdates.finalPrompt = src.finalPrompt
      } else if (src.imageUrl && src.imageUrl !== targetImage) {
        const inserted = tx.insert(schema.characterLooks).values({
          characterId: target.id,
          name: src.name,
          description: src.styling || '',
          imageUrl: src.imageUrl,
          createdAt: ts,
          updatedAt: ts,
        }).returning({ id: schema.characterLooks.id }).get()
        defaultLookId = inserted.id
        result.looksCreated++
      }

      // 2a. 集关联；movedEpisodes = 关联被迁过来（造型随集关联保留）的集
      const targetEpisodes = new Set(tx.select().from(schema.episodeCharacters)
        .where(eq(schema.episodeCharacters.characterId, target.id)).all().map(l => l.episodeId))
      const movedEpisodes = new Set<number>()
      for (const link of tx.select().from(schema.episodeCharacters).where(eq(schema.episodeCharacters.characterId, src.id)).all()) {
        if (targetEpisodes.has(link.episodeId)) {
          tx.delete(schema.episodeCharacters).where(eq(schema.episodeCharacters.id, link.id)).run()
        } else {
          tx.update(schema.episodeCharacters)
            .set({ characterId: target.id, lookId: link.lookId ?? defaultLookId })
            .where(eq(schema.episodeCharacters.id, link.id)).run()
          targetEpisodes.add(link.episodeId)
          movedEpisodes.add(link.episodeId)
        }
        result.episodeLinks++
      }

      // 2b. 镜头关联（复合主键 storyboard_id + character_id）
      // 跟随本集的镜头（lookId 为空）：所在集的关联已随迁移带上造型 → 继续跟随；
      // 所在集目标角色原本就有关联（源关联被去重删除）→ 显式指定源默认造型，保证画面不变
      const targetShots = new Set(tx.select().from(schema.storyboardCharacters)
        .where(eq(schema.storyboardCharacters.characterId, target.id)).all().map(l => l.storyboardId))
      const shotLinks = tx.select().from(schema.storyboardCharacters).where(eq(schema.storyboardCharacters.characterId, src.id)).all()
      const shotEpisode = new Map(shotLinks.length
        ? tx.select({ id: schema.storyboards.id, episodeId: schema.storyboards.episodeId }).from(schema.storyboards)
          .where(inArray(schema.storyboards.id, shotLinks.map(l => l.storyboardId))).all().map(r => [r.id, r.episodeId])
        : [])
      for (const link of shotLinks) {
        const where = and(eq(schema.storyboardCharacters.storyboardId, link.storyboardId), eq(schema.storyboardCharacters.characterId, src.id))
        if (targetShots.has(link.storyboardId)) {
          tx.delete(schema.storyboardCharacters).where(where).run()
        } else {
          const followsMovedEpisode = movedEpisodes.has(shotEpisode.get(link.storyboardId) ?? -1)
          tx.update(schema.storyboardCharacters)
            .set({ characterId: target.id, lookId: link.lookId ?? (followsMovedEpisode ? null : defaultLookId) })
            .where(where).run()
          targetShots.add(link.storyboardId)
        }
        result.storyboardLinks++
      }

      // 3. 造型与生成记录
      const moved = tx.update(schema.characterLooks).set({ characterId: target.id, updatedAt: ts })
        .where(and(eq(schema.characterLooks.characterId, src.id), isNull(schema.characterLooks.deletedAt))).run()
      result.looksMoved += moved.changes
      tx.update(schema.sysTask).set({ characterId: target.id }).where(eq(schema.sysTask.characterId, src.id)).run()

      // 4. 补齐空字段 + 别名
      for (const key of ['role', 'description', 'appearance', 'styling', 'personality'] as const) {
        if (!target[key] && !targetUpdates[key] && src[key]) targetUpdates[key] = src[key]
      }
      aliases = cleanAliases([...aliases, src.name, ...parseAliases(src.aliases)], target.name)

      // 6. 软删除源角色
      tx.update(schema.characters).set({ deletedAt: ts, updatedAt: ts }).where(eq(schema.characters.id, src.id)).run()
      result.merged.push(src.name)
    }

    targetUpdates.aliases = JSON.stringify(aliases)
    tx.update(schema.characters).set(targetUpdates).where(eq(schema.characters.id, target.id)).run()

    // 5. 改写本项目镜头视频提示词中的 @源名（含源别名）
    const sourceIds = new Set(sources.map(s => s.id))
    const fromNames = sources.flatMap(s => [s.name, ...parseAliases(s.aliases)])
    const otherNames = allInProject.filter(c => !sourceIds.has(c.id)).map(c => c.name)
    const episodeIds = tx.select({ id: schema.episodes.id }).from(schema.episodes)
      .where(eq(schema.episodes.dramaId, target.dramaId)).all().map(e => e.id)
    if (episodeIds.length) {
      const shots = tx.select().from(schema.storyboards).where(inArray(schema.storyboards.episodeId, episodeIds)).all()
      for (const sb of shots) {
        const next = rewriteMentions(sb.videoPrompt || '', fromNames, target.name, otherNames)
        if (next !== (sb.videoPrompt || '')) {
          tx.update(schema.storyboards).set({ videoPrompt: next, updatedAt: ts }).where(eq(schema.storyboards.id, sb.id)).run()
          result.promptsRewritten++
        }
      }
    }
  })

  return result
}
