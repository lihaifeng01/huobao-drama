/**
 * 账号与会话
 * - 角色：super_admin（唯一，初始化时创建）/ admin / user；user 不能使用设置相关接口
 * - 密码：scrypt + 随机盐，存 `scrypt$<salt hex>$<hash hex>`
 * - 会话：随机 token 放 httpOnly cookie，库里只存 sha256；30 天有效，剩余不足一半时自动续期
 * - 暂不做验证码 / 邮箱验证
 */
import crypto from 'crypto'
import type { Context } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { and, eq, isNull, lt, sql } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { now } from '../utils/response.js'

export type Role = 'super_admin' | 'admin' | 'user'
export type UserRow = typeof schema.users.$inferSelect

export const ROLES: Role[] = ['super_admin', 'admin', 'user']
export const SESSION_COOKIE = 'huobao_session'
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000

export class AuthError extends Error {
  constructor(message: string, public status: 400 | 401 | 403 | 404 = 400) { super(message) }
}

// ---------- 密码 ----------

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(password, salt, 64)
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [algo, saltHex, hashHex] = String(stored || '').split('$')
  if (algo !== 'scrypt' || !saltHex || !hashHex) return false
  const expected = Buffer.from(hashHex, 'hex')
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length)
  return crypto.timingSafeEqual(actual, expected)
}

// ---------- 校验 ----------

export function cleanUsername(raw: unknown): string {
  const name = String(raw ?? '').trim()
  if (name.length < 3 || name.length > 32) throw new AuthError('用户名长度需为 3–32 个字符')
  if (!/^[A-Za-z0-9_.\-@一-龥]+$/.test(name)) throw new AuthError('用户名只能包含中文、字母、数字和 _ . - @')
  return name
}

export function cleanPassword(raw: unknown): string {
  const pwd = String(raw ?? '')
  if (pwd.length < 6 || pwd.length > 128) throw new AuthError('密码长度需为 6–128 个字符')
  return pwd
}

export function cleanDisplayName(raw: unknown): string | null {
  const name = String(raw ?? '').trim().slice(0, 32)
  return name || null
}

// ---------- 用户 ----------

export function serializeUser(u: UserRow) {
  return {
    id: u.id,
    username: u.username,
    display_name: u.displayName || u.username,
    role: u.role as Role,
    status: u.status,
    last_login_at: u.lastLoginAt,
    created_at: u.createdAt,
  }
}

/** 成员选择等场景只暴露最少字段 */
export function publicUser(u: UserRow) {
  return { id: u.id, username: u.username, display_name: u.displayName || u.username, role: u.role as Role }
}

export async function findUser(id: number) {
  const [u] = await db.select().from(schema.users).where(and(eq(schema.users.id, id), isNull(schema.users.deletedAt)))
  return u
}

export async function findUserByName(username: string) {
  // username 列是 COLLATE NOCASE，等值比较不区分大小写
  const [u] = await db.select().from(schema.users)
    .where(and(eq(schema.users.username, username), isNull(schema.users.deletedAt)))
  return u
}

export async function hasUsers(): Promise<boolean> {
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(schema.users)
  return Number(row?.n || 0) > 0
}

export async function createUser(input: { username: unknown; password: unknown; displayName?: unknown; role?: Role }) {
  const username = cleanUsername(input.username)
  const password = cleanPassword(input.password)
  // 软删除的账号也占用用户名（唯一索引不区分 deleted_at），提示统一为已存在
  const [taken] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.username, username))
  if (taken) throw new AuthError('用户名已存在')
  const ts = now()
  const res = await db.insert(schema.users).values({
    username,
    displayName: cleanDisplayName(input.displayName),
    passwordHash: hashPassword(password),
    role: input.role || 'user',
    status: 'active',
    createdAt: ts,
    updatedAt: ts,
  })
  return (await findUser(getInsertId(res)))!
}

/**
 * 创建超级管理员（仅在没有任何账号时允许），并把账号体系之前的老项目归到其名下
 */
export async function createSuperAdmin(input: { username: unknown; password: unknown; displayName?: unknown }) {
  if (await hasUsers()) throw new AuthError('系统已初始化', 403)
  const user = await createUser({ ...input, role: 'super_admin' })
  await db.update(schema.dramas).set({ createdBy: user.id }).where(isNull(schema.dramas.createdBy))
  return user
}

/** Docker / 服务器部署：环境变量预置超级管理员，免去首次打开时的初始化页 */
export async function bootstrapSuperAdminFromEnv() {
  const username = process.env.HUOBAO_ADMIN_USERNAME
  const password = process.env.HUOBAO_ADMIN_PASSWORD
  if (!username || !password || await hasUsers()) return
  try {
    await createSuperAdmin({ username, password })
    console.log(`👤 已按环境变量创建超级管理员「${username}」`)
  } catch (err: any) {
    console.error(`⚠️ 按环境变量创建超级管理员失败：${err.message}`)
  }
}

// ---------- 会话 ----------

function sha256(s: string) {
  return crypto.createHash('sha256').update(s).digest('hex')
}

export async function startSession(c: Context, user: UserRow) {
  const token = crypto.randomBytes(32).toString('base64url')
  const ts = now()
  await db.insert(schema.userSessions).values({
    tokenHash: sha256(token),
    userId: user.id,
    createdAt: ts,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
  })
  await db.update(schema.users).set({ lastLoginAt: ts }).where(eq(schema.users.id, user.id))
  // 顺手清理过期会话
  await db.delete(schema.userSessions).where(lt(schema.userSessions.expiresAt, ts))
  writeCookie(c, token)
}

function writeCookie(c: Context, token: string) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
    // 反代 HTTPS 时浏览器看到的是 https，cookie 带 Secure 更安全；本地 http 不能带
    secure: c.req.header('x-forwarded-proto') === 'https' || new URL(c.req.url).protocol === 'https:',
  })
}

function readToken(c: Context): string | undefined {
  const auth = c.req.header('authorization')
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim()
  return getCookie(c, SESSION_COOKIE)
}

/** 解析当前登录用户；禁用/删除的账号视为未登录 */
export async function sessionUser(c: Context): Promise<UserRow | null> {
  const token = readToken(c)
  if (!token) return null
  const tokenHash = sha256(token)
  const [session] = await db.select().from(schema.userSessions).where(eq(schema.userSessions.tokenHash, tokenHash))
  if (!session) return null
  const expires = new Date(session.expiresAt).getTime()
  if (expires <= Date.now()) {
    await db.delete(schema.userSessions).where(eq(schema.userSessions.tokenHash, tokenHash))
    return null
  }
  const user = await findUser(session.userId)
  if (!user || user.status !== 'active') return null
  // 滑动续期：剩余不足一半时延长
  if (expires - Date.now() < SESSION_TTL_MS / 2) {
    await db.update(schema.userSessions)
      .set({ expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString() })
      .where(eq(schema.userSessions.tokenHash, tokenHash))
    if (!c.req.header('authorization')) writeCookie(c, token)
  }
  return user
}

export async function endSession(c: Context) {
  const token = readToken(c)
  if (token) await db.delete(schema.userSessions).where(eq(schema.userSessions.tokenHash, sha256(token)))
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
}

/** 改密码 / 禁用 / 删除账号后让该账号所有会话失效 */
export async function revokeSessions(userId: number) {
  await db.delete(schema.userSessions).where(eq(schema.userSessions.userId, userId))
}

// ---------- 角色 ----------

export function isSuperAdmin(u: UserRow | null | undefined) {
  return u?.role === 'super_admin'
}

export function isAdmin(u: UserRow | null | undefined) {
  return u?.role === 'super_admin' || u?.role === 'admin'
}
