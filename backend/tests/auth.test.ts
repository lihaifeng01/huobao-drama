import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// Isolated DB/storage; never read or modify user data.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-auth-'))
process.env.SQLITE_PATH = path.join(root, 'auth.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
const { db, schema } = await import('../src/db/index.ts')
const { Hono } = await import('hono')
// 与 index.ts 一致挂在 /api/v1 下
const api = new Hono().route('/api/v1', (await import('../src/api.ts')).default)

/** 每个客户端各自保存 cookie，模拟不同浏览器 */
function client() {
  let cookie = ''
  return async (method: string, url: string, body?: any) => {
    const headers: Record<string, string> = {}
    if (cookie) headers.Cookie = cookie
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const res = await api.request(`/api/v1${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    const set = res.headers.get('set-cookie')
    if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0]
    return { status: res.status, json: await res.json() as any }
  }
}

test('setup, roles, settings guard, project membership and library visibility', async () => {
  const anon = client()
  const sa = client()
  const alice = client()
  const bob = client()

  // 未初始化：只能走 setup，注册被拒
  assert.deepEqual((await anon('GET', '/auth/status')).json.data, { mode: 'login', initialized: false, user: null })
  assert.equal((await anon('GET', '/dramas')).status, 401)
  assert.equal((await alice('POST', '/auth/register', { username: 'alice', password: 'secret1' })).status, 400)

  // 账号体系之前的老项目：创建超级管理员时归到其名下
  const ts = new Date().toISOString()
  await db.insert(schema.dramas).values({ title: '老项目', status: 'draft', createdAt: ts, updatedAt: ts })

  const setup = await sa('POST', '/auth/setup', { username: 'root', password: 'rootpass' })
  assert.equal(setup.status, 201)
  assert.equal(setup.json.data.role, 'super_admin')
  assert.equal((await anon('POST', '/auth/setup', { username: 'root2', password: 'rootpass' })).status, 403)

  // 注册（无验证码）→ 普通用户；用户名不区分大小写唯一
  assert.equal((await alice('POST', '/auth/register', { username: 'alice', password: 'secret1' })).json.data.role, 'user')
  assert.equal((await bob('POST', '/auth/register', { username: 'ALICE', password: 'secret1' })).status, 400)
  assert.equal((await bob('POST', '/auth/register', { username: 'bob', password: '123' })).status, 400)
  const bobUser = (await bob('POST', '/auth/register', { username: 'bob', password: 'secret2', display_name: '小鲍' })).json.data
  assert.equal(bobUser.display_name, '小鲍')

  // 登录
  assert.equal((await anon('POST', '/auth/login', { username: 'alice', password: 'wrong' })).status, 401)
  const relogin = client()
  assert.equal((await relogin('POST', '/auth/login', { username: 'Alice', password: 'secret1' })).status, 200)
  assert.equal((await relogin('GET', '/auth/me')).json.data.username, 'alice')

  // 普通用户不能用设置；能读 AI 配置但拿不到 Key
  await sa('POST', '/ai-configs', { service_type: 'text', provider: 'openai', name: 't', base_url: 'https://x.test', api_key: 'sk-secret', model: ['m'], priority: 1 })
  assert.equal((await alice('POST', '/ai-configs', { service_type: 'text', provider: 'openai', name: 'x', base_url: 'https://x.test', api_key: 'k', model: ['m'] })).status, 403)
  const aliceConfigs = (await alice('GET', '/ai-configs')).json.data
  assert.equal(aliceConfigs.length, 1)
  assert.equal(aliceConfigs[0].api_key, '')
  assert.equal((await sa('GET', '/ai-configs')).json.data[0].api_key, 'sk-secret')
  for (const url of ['/prompts', '/skills', '/storage', '/users']) {
    assert.equal((await alice('GET', url)).status, 403, url)
  }
  assert.equal((await alice('PUT', '/settings/content-language', { language: 'en' })).status, 403)
  assert.equal((await alice('PUT', '/settings/tours-seen', { seen: ['index'] })).status, 200)
  assert.equal((await alice('GET', '/style-presets')).status, 200)

  // 只有超级管理员能改角色；提升为普通管理员后可用设置，但仍不能管理账号
  const aliceId = (await alice('GET', '/auth/me')).json.data.id
  assert.equal((await alice('PUT', `/users/${aliceId}`, { role: 'admin' })).status, 403)
  assert.equal((await sa('PUT', `/users/${aliceId}`, { role: 'super_admin' })).status, 400)
  assert.equal((await sa('PUT', `/users/${setup.json.data.id}`, { role: 'user' })).status, 400)
  assert.equal((await sa('PUT', `/users/${aliceId}`, { role: 'admin' })).json.data.role, 'admin')
  assert.equal((await alice('GET', '/prompts')).status, 200)
  assert.equal((await alice('GET', '/users')).status, 403)
  assert.equal((await alice('GET', '/ai-configs')).json.data[0].api_key, 'sk-secret')

  // 成员选择器：所有登录用户可用，只返回最少字段
  const options = (await bob('GET', '/users/options')).json.data
  assert.deepEqual(options.map((u: any) => u.username).sort(), ['alice', 'bob', 'root'])
  assert.equal(options[0].password_hash, undefined)

  // alice 建项目时选 bob 为成员（创建人自身被忽略）
  const drama = (await alice('POST', '/dramas', { title: '协作项目', member_ids: [bobUser.id, aliceId] })).json.data
  const detail = (await alice('GET', `/dramas/${drama.id}`)).json.data
  assert.equal(detail.creator.username, 'alice')
  assert.deepEqual(detail.members.map((m: any) => m.username), ['bob'])
  assert.equal(detail.can_manage_members, true)

  // bob 是成员：可见、可操作项目内资源，但不能改成员、不能删项目
  const bobDetail = (await bob('GET', `/dramas/${drama.id}`)).json.data
  assert.equal(bobDetail.can_manage_members, false)
  const char = (await bob('POST', '/characters', { drama_id: drama.id, name: '林小雨' })).json.data
  assert.ok(char.id)
  assert.equal((await bob('PUT', `/dramas/${drama.id}/members`, { member_ids: [] })).status, 403)
  assert.equal((await bob('DELETE', `/dramas/${drama.id}`)).status, 403)

  // 第三个用户：看不到项目，也碰不到项目里的资源
  const carol = client()
  await carol('POST', '/auth/register', { username: 'carol', password: 'secret3' })
  assert.deepEqual((await carol('GET', '/dramas')).json.data.items, [])
  assert.equal((await carol('GET', '/dramas/stats')).json.data.total, 0)
  assert.equal((await carol('GET', `/dramas/${drama.id}`)).status, 403)
  assert.equal((await carol('PUT', `/characters/${char.id}`, { name: 'x' })).status, 403)
  assert.equal((await carol('POST', '/characters', { drama_id: drama.id, name: '入侵者' })).status, 403)
  assert.equal((await carol('GET', `/library/character/projects/${drama.id}`)).status, 403)
  assert.equal((await carol('POST', '/tasks', { type: 'image', prompt: 'p', character_id: char.id })).status, 403)

  // 素材库：项目文件夹只对成员可见；超级管理员看全部（含老项目）
  const folders = async (who: ReturnType<typeof client>) =>
    (await who('GET', '/library/character')).json.data.project_folders.map((f: any) => f.name).sort()
  assert.deepEqual(await folders(carol), [])
  assert.deepEqual(await folders(bob), ['协作项目'])
  assert.deepEqual(await folders(sa), ['协作项目', '老项目'])
  assert.equal((await sa('GET', '/dramas')).json.data.items.find((d: any) => d.title === '老项目').creator.username, 'root')

  // 生成任务列表按项目过滤
  await db.insert(schema.sysTask).values({ type: 'image', characterId: char.id, status: 'failed', createdAt: ts, updatedAt: ts })
  assert.equal((await carol('GET', '/tasks')).json.data.length, 0)
  assert.equal((await bob('GET', '/tasks')).json.data.length, 1)

  // 创建人中途改成员：换成 carol，bob 失去访问
  const updated = (await alice('PUT', `/dramas/${drama.id}/members`, { member_ids: [(await carol('GET', '/auth/me')).json.data.id] })).json.data
  assert.deepEqual(updated.members.map((m: any) => m.username), ['carol'])
  assert.equal((await bob('GET', `/dramas/${drama.id}`)).status, 403)
  assert.equal((await carol('GET', `/dramas/${drama.id}`)).status, 200)
  // 超级管理员不是创建人也能改
  assert.equal((await sa('PUT', `/dramas/${drama.id}/members`, { member_ids: [bobUser.id] })).status, 200)
  assert.equal((await bob('GET', `/dramas/${drama.id}`)).status, 200)

  // 禁用账号：已有会话立即失效，不能再登录
  assert.equal((await sa('PUT', `/users/${bobUser.id}`, { status: 'disabled' })).status, 200)
  assert.equal((await bob('GET', '/auth/me')).status, 401)
  assert.equal((await client()('POST', '/auth/login', { username: 'bob', password: 'secret2' })).status, 403)

  // 改密码：旧密码校验，改完旧会话失效、当前会话保持
  const other = client()
  await other('POST', '/auth/login', { username: 'carol', password: 'secret3' })
  assert.equal((await carol('PUT', '/auth/password', { old_password: 'bad', new_password: 'newpass' })).status, 400)
  assert.equal((await carol('PUT', '/auth/password', { old_password: 'secret3', new_password: 'newpass' })).status, 200)
  assert.equal((await carol('GET', '/auth/me')).status, 200)
  assert.equal((await other('GET', '/auth/me')).status, 401)

  // 退出登录
  assert.equal((await carol('POST', '/auth/logout')).status, 200)
  assert.equal((await carol('GET', '/auth/me')).status, 401)
})

test('per-user isolation for library folders/files and tool jobs; project transfer', async () => {
  const dave = client()
  const erin = client()
  await dave('POST', '/auth/register', { username: 'dave', password: 'secret4' })
  await erin('POST', '/auth/register', { username: 'erin', password: 'secret5' })
  const daveId = (await dave('GET', '/auth/me')).json.data.id
  const erinId = (await erin('GET', '/auth/me')).json.data.id

  // 我的文件夹：各看各的，同名不冲突，碰不到别人的
  const folder = (await dave('POST', '/library/character/folders', { name: '主角' })).json.data
  assert.equal((await erin('POST', '/library/character/folders', { name: '主角' })).status, 201)
  assert.deepEqual((await dave('GET', '/library/character')).json.data.folders.map((f: any) => f.name), ['主角'])
  assert.equal((await dave('GET', '/library/character/folders')).json.data.length, 1)
  assert.equal((await erin('GET', `/library/character/folders/${folder.id}`)).status, 404)
  assert.equal((await erin('PUT', `/library/folders/${folder.id}`, { name: 'x' })).status, 404)
  assert.equal((await erin('DELETE', `/library/folders/${folder.id}`)).status, 404)

  // 上传素材：只出现在自己的根目录 / 文件夹里，别人改不了删不了
  const sharp = (await import('sharp')).default
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#f80' } }).png().toBuffer()
  const fd = new FormData()
  fd.append('file', new Blob([png]), 'hero.png')
  // client() 只发 JSON，multipart 上传单独登录拿 cookie
  const login = await api.request('/api/v1/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'dave', password: 'secret4' }),
  })
  const daveCookie = login.headers.get('set-cookie')!.split(';')[0]
  const up = await api.request('/api/v1/library/character/files', { method: 'POST', headers: { Cookie: daveCookie }, body: fd })
  assert.equal(up.status, 201)
  const file = ((await up.json()) as any).data
  assert.equal((await dave('GET', '/library/character')).json.data.files.length, 1)
  assert.equal((await erin('GET', '/library/character')).json.data.files.length, 0)
  assert.equal((await erin('PUT', `/library/files/${file.id}`, { name: 'x' })).status, 404)
  assert.equal((await erin('DELETE', `/library/files/${file.id}`)).status, 404)
  assert.equal((await dave('PUT', `/library/files/${file.id}`, { folder_id: folder.id })).status, 200)
  assert.equal((await dave('GET', `/library/character/folders/${folder.id}`)).json.data.files.length, 1)

  // 工具任务：直接写库造一条 dave 的字幕任务和合成任务，erin 看不到也删不了
  const ts = new Date().toISOString()
  await db.insert(schema.subtitleToolJobs).values({ userId: daveId, name: 'a.mp4', videoUrl: 'static/x.mp4', status: 'idle', createdAt: ts, updatedAt: ts })
  await db.insert(schema.mergeToolJobs).values({ userId: daveId, name: 'm', clips: '[]', status: 'completed', createdAt: ts, updatedAt: ts })
  const subJobs = (await dave('GET', '/tools/subtitle-jobs')).json.data
  const mergeJobs = (await dave('GET', '/tools/merge-jobs')).json.data
  assert.equal(subJobs.length, 1)
  assert.equal(mergeJobs.length, 1)
  assert.equal((await erin('GET', '/tools/subtitle-jobs')).json.data.length, 0)
  assert.equal((await erin('GET', '/tools/merge-jobs')).json.data.length, 0)
  assert.equal((await erin('GET', `/tools/subtitle-jobs/${subJobs[0].id}`)).status, 404)
  assert.equal((await erin('POST', `/tools/subtitle-jobs/${subJobs[0].id}/burn`, {})).status, 404)
  assert.equal((await erin('DELETE', `/tools/subtitle-jobs/${subJobs[0].id}`)).status, 404)
  assert.equal((await erin('DELETE', `/tools/merge-jobs/${mergeJobs[0].id}`)).status, 404)
  assert.equal((await dave('DELETE', `/tools/merge-jobs/${mergeJobs[0].id}`)).status, 200)

  // 转让项目：成员不能转；创建人转给 erin 后自己留作成员、不能再管理；超级管理员可以再转回
  const drama = (await dave('POST', '/dramas', { title: '转让测试', member_ids: [erinId] })).json.data
  assert.equal((await erin('PUT', `/dramas/${drama.id}/owner`, { user_id: erinId })).status, 403)
  assert.equal((await dave('PUT', `/dramas/${drama.id}/owner`, { user_id: daveId })).status, 400)
  assert.equal((await dave('PUT', `/dramas/${drama.id}/owner`, { user_id: 99999 })).status, 400)
  const team = (await dave('PUT', `/dramas/${drama.id}/owner`, { user_id: erinId })).json.data
  assert.equal(team.creator.username, 'erin')
  assert.deepEqual(team.members.map((m: any) => m.username), ['dave'])
  assert.equal(team.can_manage_members, false)
  assert.equal((await dave('GET', `/dramas/${drama.id}`)).status, 200)
  assert.equal((await dave('PUT', `/dramas/${drama.id}/members`, { member_ids: [] })).status, 403)
  assert.equal((await erin('GET', `/dramas/${drama.id}`)).json.data.can_manage_members, true)
  const root = client()
  await root('POST', '/auth/login', { username: 'root', password: 'rootpass' })
  assert.equal((await root('PUT', `/dramas/${drama.id}/owner`, { user_id: daveId })).json.data.creator.username, 'dave')
})
