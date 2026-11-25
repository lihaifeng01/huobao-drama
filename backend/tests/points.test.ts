import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { eq } from 'drizzle-orm'

// Isolated DB/storage; never read or modify user data.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-points-'))
process.env.SQLITE_PATH = path.join(root, 'points.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
process.env.HUOBAO_AUTH_MODE = 'login'
process.env.FFMPEG_BIN = '/usr/bin/false'
process.env.FFPROBE_BIN = '/usr/bin/false'
const { db, schema } = await import('../src/db/index.ts')
const { Hono } = await import('hono')
const { runAsActor } = await import('../src/services/actor.ts')
const { generateWithUsage } = await import('../src/agents/usage.ts')
const { assertPointsAvailable } = await import('../src/services/points.ts')
const api = new Hono().route('/api/v1', (await import('../src/api.ts')).default)

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
let imageFails = false
const server = http.createServer(async (req, res) => {
  for await (const _ of req) { /* drain */ }
  const json = (code: number, data: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(data)) }
  if (req.url?.includes('/images/generations')) {
    if (imageFails) return json(400, { error: { message: 'bad request' } })
    return json(200, { data: [{ b64_json: png.toString('base64') }] })
  }
  res.writeHead(404).end()
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${(server.address() as any).port}`

function client() {
  let cookie = ''
  return async (method: string, url: string, body?: any) => {
    const headers: Record<string, string> = {}
    if (cookie) headers.Cookie = cookie
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const res = await api.request(`/api/v1${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    const set = res.headers.get('set-cookie')
    if (set) cookie = set.split(';')[0]
    return { status: res.status, json: await res.json() as any }
  }
}

const ts = new Date().toISOString()
const imageConfig = db.insert(schema.aiServiceConfigs).values({ serviceType: 'image', provider: 'openai', name: '图片', baseUrl: base, apiKey: 'k', model: '["img-a"]', priority: 1, createdAt: ts, updatedAt: ts }).returning().get()
const row = (id: number) => db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get()!
async function waitFor<T>(fn: () => T | undefined | false, label: string): Promise<T> {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const v = fn()
    if (v) return v
    await new Promise(r => setTimeout(r, 20))
  }
  assert.fail(`timeout: ${label}`)
}

test('admins grant points to regular users; zero balance blocks paid features; admins are unlimited', async () => {
  const sa = client()
  await sa('POST', '/auth/setup', { username: 'root', password: 'rootpass' })
  const manager = client()
  assert.equal((await sa('POST', '/users', { username: 'boss', password: 'bosspass', role: 'admin' })).status, 201)
  await manager('POST', '/auth/login', { username: 'boss', password: 'bosspass' })
  const alice = client()
  await alice('POST', '/auth/register', { username: 'alice', password: 'secret1' })
  const aliceId = (await alice('GET', '/auth/me')).json.data.id
  const bossId = (await manager('GET', '/auth/me')).json.data.id

  // 新用户 0 积分；管理员不设上限
  assert.deepEqual((await alice('GET', '/points/me')).json.data, { unlimited: false, granted: 0, used: 0, balance: 0 })
  assert.deepEqual((await sa('GET', '/points/me')).json.data, { unlimited: true })
  assert.deepEqual((await manager('GET', '/points/me')).json.data, { unlimited: true })

  const drama = (await alice('POST', '/dramas', { title: '积分项目' })).json.data
  const ep = db.insert(schema.episodes).values({ dramaId: drama.id, episodeNumber: 1, title: 'E1', imageConfigId: imageConfig.id, createdAt: ts, updatedAt: ts }).returning().get()
  const sb = db.insert(schema.storyboards).values({ episodeId: ep.id, storyboardNumber: 1, createdAt: ts, updatedAt: ts }).returning().get()
  const generate = (c: ReturnType<typeof client>) => c('POST', '/tasks', { type: 'image', prompt: 'p', storyboard_id: sb.id, config_id: imageConfig.id, model: 'img-a' })

  // 0 积分：不能生图，也不会留下任务 / 用量记录
  const blocked = await generate(alice)
  assert.equal(blocked.status, 400)
  assert.match(blocked.json.message, /积分已用完/)
  assert.equal(db.select().from(schema.sysTask).all().length, 0)
  assert.equal(db.select().from(schema.usageRecords).all().length, 0)

  // 只有管理员能看账户列表和分配
  assert.equal((await alice('GET', '/points/accounts')).status, 403)
  assert.equal((await alice('POST', '/points/grant', { user_id: aliceId, amount: 10 })).status, 403)
  const accounts = (await manager('GET', '/points/accounts')).json.data
  assert.deepEqual(accounts.map((a: any) => [a.username, a.balance]), [['alice', 0]])

  // 校验：非整数 / 0 / 管理员账号 / 不存在的账号 / 扣减到负数
  for (const amount of [0, 1.5, 'abc', 10_000_001]) {
    assert.equal((await manager('POST', '/points/grant', { user_id: aliceId, amount })).status, 400, `amount ${amount}`)
  }
  assert.equal((await manager('POST', '/points/grant', { user_id: bossId, amount: 10 })).status, 400)
  assert.equal((await manager('POST', '/points/grant', { user_id: 9999, amount: 10 })).status, 404)
  assert.equal((await manager('POST', '/points/grant', { user_id: aliceId, amount: -1 })).status, 400)

  // 普通管理员分配 25 积分（每张图 10 积分）
  const granted = await manager('POST', '/points/grant', { user_id: aliceId, amount: 25, note: '首次' })
  assert.equal(granted.status, 200)
  assert.deepEqual(granted.json.data, { user_id: aliceId, granted: 25, used: 0, balance: 25 })

  const img1 = (await generate(alice)).json.data.id
  const img2 = (await generate(alice)).json.data.id
  await waitFor(() => row(img1).status === 'completed' && row(img2).status === 'completed', 'images')
  assert.equal((await alice('GET', '/points/me')).json.data.balance, 5)

  // 余额 5 < 单价 10：同样不能用
  const short = await generate(alice)
  assert.equal(short.status, 400)
  assert.match(short.json.message, /积分不足.*需要 10.*剩余 5/)

  // 上游失败退还积分，余额恢复
  assert.equal((await manager('POST', '/points/grant', { user_id: aliceId, amount: 5 })).json.data.balance, 10)
  imageFails = true
  const img3 = (await generate(alice)).json.data.id
  await waitFor(() => row(img3).status === 'failed', 'image failed')
  imageFails = false
  await waitFor(() => db.select().from(schema.usageRecords).all().find(r => r.refId === img3)?.status === 'refunded', 'refunded')
  assert.equal((await alice('GET', '/points/me')).json.data.balance, 10)

  // 扣减；用完后再次被拦
  assert.equal((await manager('POST', '/points/grant', { user_id: aliceId, amount: -10, note: '回收' })).json.data.balance, 0)
  assert.equal((await generate(alice)).status, 400)

  // 文本模型（单价 0）：余额为 0 不能用，有余额就能用；管理员不受限
  await assert.rejects(runAsActor({ id: aliceId }, () => generateWithUsage('t', undefined, async () => 'ok')), /积分已用完/)
  await assert.rejects(assertPointsAvailable({ serviceType: 'subtitle', userId: aliceId }), /积分已用完/)
  await manager('POST', '/points/grant', { user_id: aliceId, amount: 1 })
  assert.equal(await runAsActor({ id: aliceId }, () => generateWithUsage('t', undefined, async () => 'ok')), 'ok')
  await assert.rejects(assertPointsAvailable({ serviceType: 'subtitle', userId: aliceId }), /积分不足/)
  assert.equal(await runAsActor({ id: bossId }, () => generateWithUsage('t', undefined, async () => 'ok')), 'ok')
  await manager('POST', '/points/grant', { user_id: aliceId, amount: -1 })

  // 管理员（超级管理员与普通管理员）不受限制，没有任何分配记录也能生成
  const bossDrama = (await manager('POST', '/dramas', { title: '管理员项目' })).json.data
  const bossEp = db.insert(schema.episodes).values({ dramaId: bossDrama.id, episodeNumber: 1, title: 'E1', imageConfigId: imageConfig.id, createdAt: ts, updatedAt: ts }).returning().get()
  const bossSb = db.insert(schema.storyboards).values({ episodeId: bossEp.id, storyboardNumber: 1, createdAt: ts, updatedAt: ts }).returning().get()
  const bossGen = await manager('POST', '/tasks', { type: 'image', prompt: 'p', storyboard_id: bossSb.id, config_id: imageConfig.id, model: 'img-a' })
  assert.equal(bossGen.status, 201)
  assert.equal((await generate(sa)).status, 201)

  // 流水：管理员看全部，普通用户只看自己
  const ledger = (await manager('GET', '/points/ledger')).json.data
  assert.equal(ledger.total, 5)
  assert.deepEqual(ledger.items.map((i: any) => i.delta), [-1, 1, -10, 5, 25])
  assert.equal(ledger.items[0].operator_name, 'boss')
  assert.equal((await alice('GET', '/points/ledger')).json.data.total, 5)
})

test.after(() => server.close())
