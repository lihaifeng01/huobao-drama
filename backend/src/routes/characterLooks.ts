import { Hono } from 'hono'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { success, created, badRequest, notFound, now } from '../utils/response.js'
import { toSnakeCase } from '../utils/transform.js'
import { generateImage } from '../services/generation.js'
import { getDramaStylePrompt } from '../services/style-preset.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

/**
 * 角色造型 — 同一角色的多套服装/妆发
 * - 默认造型 = characters 自身形象图（不落此表）；这里只管理额外造型
 * - 集级选择存 episode_characters.look_id，镜头级覆盖存 storyboard_characters.look_id（空 = 默认 / 跟随本集）
 * - 生成造型图时以角色默认形象作参考图（图生图），保持同一张脸；仅换服装造型
 */
const app = new Hono()
const LOOK_IMAGE_SIZE = '1920x1080'
const NAME_MAX = 50

type LookRow = typeof schema.characterLooks.$inferSelect

async function findLook(id: number) {
  const [look] = await db.select().from(schema.characterLooks)
    .where(and(eq(schema.characterLooks.id, id), isNull(schema.characterLooks.deletedAt)))
  return look
}

async function findCharacter(id: number) {
  const [char] = await db.select().from(schema.characters)
    .where(and(eq(schema.characters.id, id), isNull(schema.characters.deletedAt)))
  return char
}

export async function listLooks(characterId: number): Promise<LookRow[]> {
  return db.select().from(schema.characterLooks)
    .where(and(eq(schema.characterLooks.characterId, characterId), isNull(schema.characterLooks.deletedAt)))
    .orderBy(asc(schema.characterLooks.sortOrder), asc(schema.characterLooks.id))
}

function lookImagePrompt(char: typeof schema.characters.$inferSelect, look: LookRow, stylePrompt: string, hasReference: boolean) {
  return [
    stylePrompt || '',
    char.name,
    char.appearance || char.description || '',
    `造型：${look.description || look.name}`,
    '16:9 横版角色定妆照',
    '半身角色海报构图',
    '正面',
    '高质量',
    '白色背景',
    hasReference ? '与参考图是同一个人：五官、脸型、发色、肤色与体型保持完全一致，只按上述造型更换服装、妆发与配饰' : '',
  ].filter(Boolean).join(', ')
}

// GET /character-looks?character_id= — 角色的额外造型列表
app.get('/', async (c) => {
  const characterId = Number(c.req.query('character_id'))
  if (!characterId) return badRequest(c, 'character_id 必填')
  return success(c, (await listLooks(characterId)).map(toSnakeCase))
})

// POST /character-looks — 新增造型 { character_id, name, description }
app.post('/', async (c) => {
  const body = await c.req.json()
  const char = await findCharacter(Number(body.character_id))
  if (!char) return badRequest(c, '角色不存在')
  const name = String(body.name ?? '').trim().slice(0, NAME_MAX)
  if (!name) return badRequest(c, '造型名称必填')
  const existing = await listLooks(char.id)
  if (existing.some(l => l.name === name)) return badRequest(c, '造型名称已存在')
  const ts = now()
  const res = await db.insert(schema.characterLooks).values({
    characterId: char.id,
    name,
    description: String(body.description ?? ''),
    sortOrder: existing.length,
    createdAt: ts,
    updatedAt: ts,
  })
  return created(c, toSnakeCase((await findLook(getInsertId(res)))!))
})

// PUT /character-looks/:id — 改名称/描述/图片（上传图直接写 image_url）
app.put('/:id', async (c) => {
  const look = await findLook(Number(c.req.param('id')))
  if (!look) return notFound(c, '造型不存在')
  const body = await c.req.json()
  const updates: Partial<typeof schema.characterLooks.$inferInsert> = { updatedAt: now() }
  if (body.name !== undefined) {
    const name = String(body.name ?? '').trim().slice(0, NAME_MAX)
    if (!name) return badRequest(c, '造型名称必填')
    if ((await listLooks(look.characterId)).some(l => l.id !== look.id && l.name === name)) return badRequest(c, '造型名称已存在')
    updates.name = name
  }
  if (body.description !== undefined) updates.description = String(body.description ?? '')
  if (body.image_url !== undefined) updates.imageUrl = body.image_url || null
  await db.update(schema.characterLooks).set(updates).where(eq(schema.characterLooks.id, look.id))
  return success(c)
})

// DELETE /character-looks/:id — 软删除；引用它的集/镜头回落到默认造型
app.delete('/:id', async (c) => {
  const look = await findLook(Number(c.req.param('id')))
  if (!look) return notFound(c, '造型不存在')
  const ts = now()
  await db.update(schema.episodeCharacters).set({ lookId: null }).where(eq(schema.episodeCharacters.lookId, look.id))
  await db.update(schema.storyboardCharacters).set({ lookId: null }).where(eq(schema.storyboardCharacters.lookId, look.id))
  await db.update(schema.characterLooks).set({ deletedAt: ts, updatedAt: ts }).where(eq(schema.characterLooks.id, look.id))
  return success(c)
})

// POST /character-looks/:id/generate-image — 以角色默认形象为参考图生成造型图 { model?, config_id? }
app.post('/:id/generate-image', async (c) => {
  const look = await findLook(Number(c.req.param('id')))
  if (!look) return notFound(c, '造型不存在')
  const char = await findCharacter(look.characterId)
  if (!char) return badRequest(c, '角色不存在')
  const body = await c.req.json().catch(() => ({}))
  const references = char.imageUrl ? [char.imageUrl] : []
  const prompt = lookImagePrompt(char, look, await getDramaStylePrompt(char.dramaId), references.length > 0)
  try {
    logTaskStart('LookImage', 'generate', { lookId: look.id, characterId: char.id, withReference: references.length > 0 })
    // 不传 characterId：完成回写只落到造型（params.lookId），不覆盖角色主形象
    const genId = await generateImage({
      lookId: look.id,
      dramaId: char.dramaId,
      prompt,
      model: body.model,
      size: LOOK_IMAGE_SIZE,
      referenceImages: references,
      configId: body.config_id ?? undefined,
    })
    logTaskSuccess('LookImage', 'generate', { lookId: look.id, generationId: genId })
    return success(c, { image_generation_id: genId, with_reference: references.length > 0 })
  } catch (err: any) {
    logTaskError('LookImage', 'generate', { lookId: look.id, error: err.message })
    return badRequest(c, err.message)
  }
})

export default app
