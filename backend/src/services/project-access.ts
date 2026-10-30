/**
 * 项目（drama）访问控制
 * - 可见 / 可操作：超级管理员、创建人（dramas.created_by）、项目成员（drama_members）
 * - 修改成员、转让、删除项目：仅创建人与超级管理员
 * - 剧集 / 分镜 / 角色 / 场景 / 道具 / 造型 / 生成任务都通过 dramaOf() 归到所属项目再判断
 */
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { isSuperAdmin, type UserRow } from './auth.js'
import { now } from '../utils/response.js'

export type EntityKind = 'drama' | 'episode' | 'storyboard' | 'character' | 'scene' | 'prop' | 'look' | 'task'

/** 实体所属项目 id；实体不存在返回 null（交给业务路由按原逻辑报 404 / 400） */
export async function dramaOf(kind: EntityKind, id: number): Promise<number | null> {
  if (!Number.isFinite(id) || id <= 0) return null
  switch (kind) {
    case 'drama': {
      const [r] = await db.select({ id: schema.dramas.id }).from(schema.dramas).where(eq(schema.dramas.id, id))
      return r?.id ?? null
    }
    case 'episode': {
      const [r] = await db.select({ d: schema.episodes.dramaId }).from(schema.episodes).where(eq(schema.episodes.id, id))
      return r?.d ?? null
    }
    case 'storyboard': {
      const [r] = await db.select({ e: schema.storyboards.episodeId }).from(schema.storyboards).where(eq(schema.storyboards.id, id))
      return r ? dramaOf('episode', r.e) : null
    }
    case 'character': {
      const [r] = await db.select({ d: schema.characters.dramaId }).from(schema.characters).where(eq(schema.characters.id, id))
      return r?.d ?? null
    }
    case 'scene': {
      const [r] = await db.select({ d: schema.scenes.dramaId }).from(schema.scenes).where(eq(schema.scenes.id, id))
      return r?.d ?? null
    }
    case 'prop': {
      const [r] = await db.select({ d: schema.props.dramaId }).from(schema.props).where(eq(schema.props.id, id))
      return r?.d ?? null
    }
    case 'look': {
      const [r] = await db.select({ c: schema.characterLooks.characterId }).from(schema.characterLooks).where(eq(schema.characterLooks.id, id))
      return r ? dramaOf('character', r.c) : null
    }
    case 'task': {
      const [t] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id))
      return t ? taskDramaId(t) : null
    }
  }
}

/** 生成任务的项目：优先 drama_id，没有时按分镜 / 角色 / 场景 / 道具反查 */
export async function taskDramaId(t: typeof schema.sysTask.$inferSelect): Promise<number | null> {
  if (t.dramaId) return t.dramaId
  if (t.storyboardId) return dramaOf('storyboard', t.storyboardId)
  if (t.characterId) return dramaOf('character', t.characterId)
  if (t.sceneId) return dramaOf('scene', t.sceneId)
  if (t.propId) return dramaOf('prop', t.propId)
  return null
}

/** 用户可见的项目 id；超级管理员返回 null 表示全部 */
export async function accessibleDramaIds(user: UserRow): Promise<Set<number> | null> {
  if (isSuperAdmin(user)) return null
  const owned = await db.select({ id: schema.dramas.id }).from(schema.dramas).where(eq(schema.dramas.createdBy, user.id))
  const joined = await db.select({ id: schema.dramaMembers.dramaId }).from(schema.dramaMembers).where(eq(schema.dramaMembers.userId, user.id))
  return new Set([...owned, ...joined].map(r => r.id))
}

export async function canAccessDrama(user: UserRow, dramaId: number): Promise<boolean> {
  if (isSuperAdmin(user)) return true
  const [d] = await db.select({ createdBy: schema.dramas.createdBy }).from(schema.dramas).where(eq(schema.dramas.id, dramaId))
  if (!d) return true // 不存在的项目交给业务路由报错
  if (d.createdBy === user.id) return true
  const [m] = await db.select().from(schema.dramaMembers)
    .where(and(eq(schema.dramaMembers.dramaId, dramaId), eq(schema.dramaMembers.userId, user.id)))
  return !!m
}

export function canManageDrama(user: UserRow, drama: { createdBy: number | null }) {
  return isSuperAdmin(user) || (drama.createdBy != null && drama.createdBy === user.id)
}

/** 项目成员列表（不含创建人），只返回仍有效的账号 */
export async function listMembers(dramaId: number) {
  const rows = await db.select({ user: schema.users }).from(schema.dramaMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.dramaMembers.userId))
    .where(and(eq(schema.dramaMembers.dramaId, dramaId), isNull(schema.users.deletedAt)))
  return rows.map(r => r.user)
}

/**
 * 覆盖项目成员；创建人自动排除（创建人不需要成员身份），不存在 / 已删除的账号忽略
 */
export async function setMembers(dramaId: number, createdBy: number | null, userIds: unknown) {
  const ids = Array.isArray(userIds)
    ? [...new Set(userIds.map(Number).filter(n => Number.isInteger(n) && n > 0 && n !== createdBy))]
    : []
  const valid = ids.length
    ? (await db.select({ id: schema.users.id }).from(schema.users)
      .where(and(inArray(schema.users.id, ids), isNull(schema.users.deletedAt)))).map(r => r.id)
    : []
  await db.delete(schema.dramaMembers).where(eq(schema.dramaMembers.dramaId, dramaId))
  const ts = now()
  if (valid.length) {
    await db.insert(schema.dramaMembers).values(valid.map(userId => ({ dramaId, userId, createdAt: ts })))
  }
  return valid
}

/**
 * 转让项目：接收人成为创建人（从成员表移除），原创建人留作普通成员，避免转让后自己失去访问
 */
export async function transferDrama(drama: { id: number; createdBy: number | null }, toUserId: number) {
  const ts = now()
  await db.update(schema.dramas).set({ createdBy: toUserId, updatedAt: ts }).where(eq(schema.dramas.id, drama.id))
  await db.delete(schema.dramaMembers)
    .where(and(eq(schema.dramaMembers.dramaId, drama.id), eq(schema.dramaMembers.userId, toUserId)))
  if (drama.createdBy != null) {
    const [already] = await db.select().from(schema.dramaMembers)
      .where(and(eq(schema.dramaMembers.dramaId, drama.id), eq(schema.dramaMembers.userId, drama.createdBy)))
    if (!already) await db.insert(schema.dramaMembers).values({ dramaId: drama.id, userId: drama.createdBy, createdAt: ts })
  }
}
