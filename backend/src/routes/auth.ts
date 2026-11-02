import { Hono } from 'hono'
import type { Context } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, created, badRequest, unauthorized, now } from '../utils/response.js'
import {
  AuthError, authMode, cleanDisplayName, cleanPassword, createSuperAdmin, createUser, endSession, findUserByName,
  hashPassword, localUser, needsSetup, revokeSessions, serializeUser, sessionUser, startSession, verifyPassword,
} from '../services/auth.js'

/**
 * 登录 / 注册 / 初始化
 * - status、setup、login、register 为公开接口（见 middleware/auth.ts 的 PUBLIC_PATHS）
 * - 暂不做验证码
 * - 免登模式（HUOBAO_AUTH_MODE=none）下只有 status / me / profile 有意义，其余返回 400
 */
const app = new Hono()

const NO_LOGIN = '当前为免登模式，无需登录'

// 免登模式下拒绝登录相关操作
app.use('/:action{setup|register|login|password}', async (c, next) => {
  if (authMode() === 'none') return badRequest(c, NO_LOGIN)
  return next()
})

function fail(c: Context, err: unknown) {
  if (err instanceof AuthError) return c.json({ code: err.status, message: err.message }, err.status)
  throw err
}

// GET /auth/status — 模式 + 是否已初始化（有设好密码的超级管理员）+ 当前用户
app.get('/status', async (c) => {
  if (authMode() === 'none') {
    return success(c, { mode: 'none', initialized: true, user: serializeUser(await localUser()) })
  }
  const user = await sessionUser(c)
  return success(c, { mode: 'login', initialized: !await needsSetup(), user: user ? serializeUser(user) : null })
})

// POST /auth/setup — 首次使用：创建超级管理员并登录（已有账号时拒绝）
app.post('/setup', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  try {
    const user = await createSuperAdmin({ username: body.username, password: body.password, displayName: body.display_name })
    await startSession(c, user)
    return created(c, serializeUser(user))
  } catch (err) { return fail(c, err) }
})

// POST /auth/register — 自助注册，角色固定为普通用户
app.post('/register', async (c) => {
  if (await needsSetup()) return badRequest(c, '系统尚未初始化，请先创建超级管理员')
  const body = await c.req.json().catch(() => ({}))
  try {
    const user = await createUser({ username: body.username, password: body.password, displayName: body.display_name, role: 'user' })
    await startSession(c, user)
    return created(c, serializeUser(user))
  } catch (err) { return fail(c, err) }
})

// POST /auth/login
app.post('/login', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const username = String(body.username ?? '').trim()
  const password = String(body.password ?? '')
  if (!username || !password) return badRequest(c, '请输入用户名和密码')
  const user = await findUserByName(username)
  if (!user || !verifyPassword(password, user.passwordHash)) return unauthorized(c, '用户名或密码错误')
  if (user.status !== 'active') return c.json({ code: 403, message: '账号已被禁用，请联系管理员' }, 403)
  await startSession(c, user)
  return success(c, serializeUser(user))
})

// POST /auth/logout
app.post('/logout', async (c) => {
  await endSession(c)
  return success(c)
})

// GET /auth/me
app.get('/me', (c) => success(c, serializeUser(c.get('user'))))

// PUT /auth/profile — 改自己的显示名
app.put('/profile', async (c) => {
  const user = c.get('user')
  const body = await c.req.json().catch(() => ({}))
  await db.update(schema.users).set({ displayName: cleanDisplayName(body.display_name), updatedAt: now() })
    .where(eq(schema.users.id, user.id))
  return success(c)
})

// PUT /auth/password — 改自己的密码（需旧密码），其他设备上的登录随之失效
app.put('/password', async (c) => {
  const user = c.get('user')
  const body = await c.req.json().catch(() => ({}))
  if (!verifyPassword(String(body.old_password ?? ''), user.passwordHash)) return badRequest(c, '原密码不正确')
  try {
    const password = cleanPassword(body.new_password)
    await db.update(schema.users).set({ passwordHash: hashPassword(password), updatedAt: now() })
      .where(eq(schema.users.id, user.id))
    await revokeSessions(user.id)
    await startSession(c, user)
    return success(c)
  } catch (err) { return fail(c, err) }
})

export default app
