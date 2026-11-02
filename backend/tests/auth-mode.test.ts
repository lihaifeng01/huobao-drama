import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// Isolated DB/storage; never read or modify user data.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-auth-mode-'))
process.env.SQLITE_PATH = path.join(root, 'auth-mode.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
process.env.HUOBAO_AUTH_MODE = 'none'
const { db, schema } = await import('../src/db/index.ts')
const { authMode, initAuth } = await import('../src/services/auth.ts')
const { Hono } = await import('hono')
const api = new Hono().route('/api/v1', (await import('../src/api.ts')).default)

const call = async (method: string, url: string, body?: any, cookie = '') => {
  const headers: Record<string, string> = {}
  if (cookie) headers.Cookie = cookie
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await api.request(`/api/v1${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: res.status, cookie: res.headers.get('set-cookie')?.split(';')[0] || '', json: await res.json() as any }
}

test('mode defaults: desktop → none, otherwise login; explicit setting wins', () => {
  const saved = { mode: process.env.HUOBAO_AUTH_MODE, desktop: process.env.HUOBAO_DESKTOP }
  delete process.env.HUOBAO_AUTH_MODE
  delete process.env.HUOBAO_DESKTOP
  assert.equal(authMode(), 'login')
  process.env.HUOBAO_DESKTOP = '1'
  assert.equal(authMode(), 'none')
  process.env.HUOBAO_AUTH_MODE = 'login'
  assert.equal(authMode(), 'login')
  process.env.HUOBAO_AUTH_MODE = saved.mode
  if (saved.desktop === undefined) delete process.env.HUOBAO_DESKTOP
  else process.env.HUOBAO_DESKTOP = saved.desktop
})

test('none mode runs as a passwordless local super admin; switching to login lets setup claim it', async () => {
  // 升级前的老数据：没有归属
  const ts = new Date().toISOString()
  await db.insert(schema.dramas).values({ title: '老项目', status: 'draft', createdAt: ts, updatedAt: ts })
  await db.insert(schema.libraryFolders).values({ category: 'scene', name: '老文件夹', createdAt: ts, updatedAt: ts })

  await initAuth()
  const status = (await call('GET', '/auth/status')).json.data
  assert.equal(status.mode, 'none')
  assert.equal(status.initialized, true)
  assert.equal(status.user.role, 'super_admin')
  const localId = status.user.id

  // 不带 cookie 也能用全部接口（含设置），老数据归到本机用户
  assert.equal((await call('GET', '/prompts')).status, 200)
  assert.equal((await call('GET', '/dramas')).json.data.items[0].creator.id, localId)
  assert.deepEqual((await call('GET', '/library/scene')).json.data.folders.map((f: any) => f.name), ['老文件夹'])
  const drama = (await call('POST', '/dramas', { title: '桌面项目' })).json.data
  assert.equal(drama.created_by, localId)

  // 登录相关接口在免登模式下不可用
  for (const url of ['/auth/login', '/auth/register', '/auth/setup']) {
    assert.equal((await call('POST', url, { username: 'x', password: 'secret1' })).status, 400, url)
  }
  assert.equal((await call('PUT', '/auth/password', { old_password: '', new_password: 'secret1' })).status, 400)

  // 切到登录模式：本机用户没有密码，状态为未初始化，旧会话 / 无 cookie 都是 401
  process.env.HUOBAO_AUTH_MODE = 'login'
  assert.deepEqual((await call('GET', '/auth/status')).json.data, { mode: 'login', initialized: false, user: null })
  assert.equal((await call('GET', '/dramas')).status, 401)
  assert.equal((await call('POST', '/auth/login', { username: 'admin', password: '' })).status, 400)
  assert.equal((await call('POST', '/auth/register', { username: 'early', password: 'secret1' })).status, 400)

  // 初始化页认领本机用户：同一个 id，数据都还在
  const setup = await call('POST', '/auth/setup', { username: 'boss', password: 'bosspass' })
  assert.equal(setup.status, 201)
  assert.equal(setup.json.data.id, localId)
  assert.equal(setup.json.data.username, 'boss')
  const titles = (await call('GET', '/dramas', undefined, setup.cookie)).json.data.items.map((d: any) => d.title).sort()
  assert.deepEqual(titles, ['桌面项目', '老项目'])
  assert.equal((await call('POST', '/auth/setup', { username: 'boss2', password: 'bosspass' })).status, 403)
  assert.equal((await call('POST', '/auth/login', { username: 'boss', password: 'bosspass' })).status, 200)
})
