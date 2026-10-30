/**
 * 接口鉴权（挂在 /api/v1/* 上，路径判断均为去掉 /api/v1 前缀后的相对路径）
 * 1. authGuard：除公开接口外都要求登录，当前用户放进 c.get('user')；免登模式下固定为本机超级管理员
 * 2. settingsGuard：设置相关接口仅管理员（super_admin / admin）可用；普通用户只能读工作台需要的配置
 * 3. projectGuard：项目相关接口按路径参数、请求体、查询参数里引用的实体归到项目，非项目成员 403
 */
import type { Context, MiddlewareHandler } from 'hono'
import { authMode, isAdmin, localUser, sessionUser, type UserRow } from '../services/auth.js'
import { canAccessDrama, dramaOf, type EntityKind } from '../services/project-access.js'
import { forbidden, unauthorized } from '../utils/response.js'

declare module 'hono' {
  interface ContextVariableMap {
    user: UserRow
  }
}

const API_PREFIX = '/api/v1'

function relPath(c: Context) {
  const p = c.req.path
  return p.startsWith(API_PREFIX) ? p.slice(API_PREFIX.length) || '/' : p
}

const PUBLIC_PATHS = new Set(['/health', '/auth/status', '/auth/login', '/auth/register', '/auth/setup'])

export const authGuard: MiddlewareHandler = async (c, next) => {
  if (c.req.method === 'OPTIONS' || PUBLIC_PATHS.has(relPath(c))) return next()
  const user = authMode() === 'none' ? await localUser() : await sessionUser(c)
  if (!user) return unauthorized(c)
  c.set('user', user)
  return next()
}

/** 返回 true 表示该请求需要管理员 */
function needsAdmin(method: string, path: string) {
  const read = method === 'GET' || method === 'HEAD'
  // 整块仅管理员：提示词、技能、存储、服务端更新、账号管理
  if (/^\/(prompts|skills|storage|server-update|users)(\/|$)/.test(path)) return true
  // 工作台要读 AI 配置（模型下拉）和风格预设（新建项目），只放开读
  if (/^\/(ai-configs|style-presets)(\/|$)/.test(path)) return !read
  // 全局内容语言：读放开，改仅管理员；新手引导记录任何人可写
  if (path === '/settings/content-language') return !read
  return false
}

export const settingsGuard: MiddlewareHandler = async (c, next) => {
  const path = relPath(c)
  // 成员选择器要列出可选账号，普通用户也能用（只返回最少字段）
  if (path === '/users/options') return next()
  if (needsAdmin(c.req.method, path) && !isAdmin(c.get('user'))) return forbidden(c, '仅管理员可使用设置相关功能')
  return next()
}

// ---------- 项目访问 ----------

/** 路径里直接带实体 id 的接口 */
const PATH_RULES: [RegExp, EntityKind][] = [
  [/^\/dramas\/(\d+)(\/|$)/, 'drama'],
  [/^\/episodes\/(\d+)(\/|$)/, 'episode'],
  [/^\/storyboards\/(\d+)(\/|$)/, 'storyboard'],
  [/^\/characters\/(\d+)(\/|$)/, 'character'],
  [/^\/character-looks\/(\d+)(\/|$)/, 'look'],
  [/^\/scenes\/(\d+)(\/|$)/, 'scene'],
  [/^\/props\/(\d+)(\/|$)/, 'prop'],
  [/^\/tasks\/(\d+)(\/|$)/, 'task'],
  [/^\/merge\/episodes\/(\d+)(\/|$)/, 'episode'],
  [/^\/subtitles\/episodes\/(\d+)(\/|$)/, 'episode'],
  [/^\/subtitles\/storyboards\/(\d+)(\/|$)/, 'storyboard'],
  [/^\/library\/[a-z]+\/projects\/(\d+)(\/|$)/, 'drama'],
]

/** 请求体 / 查询参数里引用实体的字段（只在项目相关接口上检查） */
const REF_FIELDS: Record<string, EntityKind> = {
  drama_id: 'drama',
  episode_id: 'episode',
  storyboard_id: 'storyboard',
  character_id: 'character',
  scene_id: 'scene',
  prop_id: 'prop',
  character_ids: 'character',
  storyboard_ids: 'storyboard',
  prop_ids: 'prop',
  source_ids: 'character', // POST /characters/:id/merge
}

const PROJECT_SCOPED = /^\/(dramas|episodes|storyboards|characters|character-looks|scenes|props|tasks|merge|subtitles|agent)(\/|$)/

async function collectRefs(c: Context, path: string): Promise<[EntityKind, number][]> {
  const refs: [EntityKind, number][] = []
  for (const [re, kind] of PATH_RULES) {
    const m = path.match(re)
    if (m) refs.push([kind, Number(m[1])])
  }
  if (!PROJECT_SCOPED.test(path)) return refs

  const add = (key: string, value: unknown) => {
    const kind = REF_FIELDS[key]
    if (!kind || value === undefined || value === null || value === '') return
    for (const v of Array.isArray(value) ? value : [value]) {
      const n = Number(v)
      if (Number.isInteger(n) && n > 0) refs.push([kind, n])
    }
  }
  for (const [k, v] of Object.entries(c.req.query())) add(k, v)
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method)
    && (c.req.header('content-type') || '').includes('application/json')) {
    // c.req.json() 会缓存解析结果，后续路由再读不受影响
    const body = await c.req.json().catch(() => null)
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      for (const [k, v] of Object.entries(body)) add(k, v)
    }
  }
  return refs
}

export const projectGuard: MiddlewareHandler = async (c, next) => {
  const user = c.get('user')
  if (!user) return next()
  const refs = await collectRefs(c, relPath(c))
  const checked = new Set<number>()
  for (const [kind, id] of refs) {
    const dramaId = await dramaOf(kind, id)
    if (dramaId == null || checked.has(dramaId)) continue
    if (!await canAccessDrama(user, dramaId)) return forbidden(c, '你不是该项目的成员，无权访问')
    checked.add(dramaId)
  }
  return next()
}
