import { Hono } from 'hono'
import type { Context } from 'hono'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, created, badRequest, forbidden, notFound, now } from '../utils/response.js'
import {
  AuthError, cleanDisplayName, cleanPassword, createUser, findUser, hashPassword, isSuperAdmin,
  publicUser, revokeSessions, serializeUser, type Role,
} from '../services/auth.js'

/**
 * 账号管理：仅超级管理员（/users/options 除外，供成员选择器使用）
 * 超级管理员只有一个，不能被改角色、禁用或删除
 */
const app = new Hono()
const ASSIGNABLE_ROLES: Role[] = ['admin', 'user']

function fail(c: Context, err: unknown) {
  if (err instanceof AuthError) return c.json({ code: err.status, message: err.message }, err.status)
  throw err
}

async function activeUsers() {
  return db.select().from(schema.users)
    .where(and(isNull(schema.users.deletedAt), eq(schema.users.status, 'active')))
    .orderBy(asc(schema.users.id))
}

// GET /users/options — 可选为项目成员的账号（所有登录用户可用）
app.get('/options', async (c) => success(c, (await activeUsers()).map(publicUser)))

app.use('*', async (c, next) => {
  if (!isSuperAdmin(c.get('user'))) return forbidden(c, '仅超级管理员可以管理账号')
  return next()
})

// GET /users — 全部账号（含禁用）
app.get('/', async (c) => {
  const rows = await db.select().from(schema.users).where(isNull(schema.users.deletedAt)).orderBy(asc(schema.users.id))
  return success(c, rows.map(serializeUser))
})

// POST /users — 超级管理员直接建号 { username, password, display_name?, role? }
app.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const role = (body.role || 'user') as Role
  if (!ASSIGNABLE_ROLES.includes(role)) return badRequest(c, '角色只能是普通管理员或普通用户')
  try {
    const user = await createUser({ username: body.username, password: body.password, displayName: body.display_name, role })
    return created(c, serializeUser(user))
  } catch (err) { return fail(c, err) }
})

// PUT /users/:id — 改角色 / 状态 / 显示名
app.put('/:id', async (c) => {
  const target = await findUser(Number(c.req.param('id')))
  if (!target) return notFound(c, '账号不存在')
  const body = await c.req.json().catch(() => ({}))
  const updates: Record<string, any> = { updatedAt: now() }
  if (body.display_name !== undefined) updates.displayName = cleanDisplayName(body.display_name)
  if (body.role !== undefined || body.status !== undefined) {
    if (isSuperAdmin(target)) return badRequest(c, '不能修改超级管理员的角色或状态')
    if (body.role !== undefined) {
      if (!ASSIGNABLE_ROLES.includes(body.role)) return badRequest(c, '角色只能是普通管理员或普通用户')
      updates.role = body.role
    }
    if (body.status !== undefined) {
      if (!['active', 'disabled'].includes(body.status)) return badRequest(c, '状态无效')
      updates.status = body.status
    }
  }
  await db.update(schema.users).set(updates).where(eq(schema.users.id, target.id))
  if (updates.status === 'disabled') await revokeSessions(target.id)
  return success(c, serializeUser((await findUser(target.id))!))
})

// PUT /users/:id/password — 重置密码，该账号已有登录全部失效
app.put('/:id/password', async (c) => {
  const target = await findUser(Number(c.req.param('id')))
  if (!target) return notFound(c, '账号不存在')
  const body = await c.req.json().catch(() => ({}))
  try {
    const password = cleanPassword(body.password)
    await db.update(schema.users).set({ passwordHash: hashPassword(password), updatedAt: now() }).where(eq(schema.users.id, target.id))
    await revokeSessions(target.id)
    return success(c)
  } catch (err) { return fail(c, err) }
})

// DELETE /users/:id — 软删除；其创建的项目保留，超级管理员仍可管理
app.delete('/:id', async (c) => {
  const target = await findUser(Number(c.req.param('id')))
  if (!target) return notFound(c, '账号不存在')
  if (isSuperAdmin(target)) return badRequest(c, '不能删除超级管理员')
  const ts = now()
  await db.update(schema.users).set({ deletedAt: ts, updatedAt: ts }).where(eq(schema.users.id, target.id))
  await revokeSessions(target.id)
  return success(c)
})

export default app
