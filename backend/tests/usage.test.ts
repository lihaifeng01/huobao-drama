import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { eq } from 'drizzle-orm'

// Isolated DB/storage; never read or modify user data.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-usage-'))
process.env.SQLITE_PATH = path.join(root, 'usage.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
process.env.HUOBAO_AUTH_MODE = 'login'
process.env.FFMPEG_BIN = '/usr/bin/false'
process.env.FFPROBE_BIN = '/usr/bin/false'
const { db, schema } = await import('../src/db/index.ts')
const { computePoints, isRefundableTaskFailure, resolveUnitPoints } = await import('../src/services/usage.ts')
const { recoverVideoTask, resumeInterruptedTasks } = await import('../src/services/generation.ts')
const { Hono } = await import('hono')
const api = new Hono().route('/api/v1', (await import('../src/api.ts')).default)

// ---- 模拟上游：OpenAI 图片 / 对话、MiniMax 视频 ----
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(32)])
let imageFails = false
let videoAvailable = true
const server = http.createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  const json = (code: number, data: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(data)) }
  if (req.url?.includes('/images/generations')) {
    if (imageFails) return json(400, { error: { message: 'bad request' } })
    return json(200, { data: [{ b64_json: png.toString('base64') }] })
  }
  if (req.url?.includes('/chat/completions')) {
    return json(200, {
      id: 'c1', object: 'chat.completion', created: 1, model: 'mock-text',
      choices: [{ index: 0, message: { role: 'assistant', content: '好的' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500 },
    })
  }
  if (req.method === 'POST') {
    // MiniMax 同步返回成功结果，实际时长 8 秒（请求 6 秒）
    return json(200, { task: { id: 'up-1', status: 'succeeded', duration: 8, content: { url: `${base}/content` } } })
  }
  if (req.url === '/content') {
    if (!videoAvailable) { res.writeHead(404).end(); return }
    res.end(mp4); return
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
const imageConfig = db.insert(schema.aiServiceConfigs).values({ serviceType: 'image', provider: 'openai', name: '图片', baseUrl: base, apiKey: 'k', model: '["img-a","img-b"]', priority: 1, createdAt: ts, updatedAt: ts }).returning().get()
const videoConfig = db.insert(schema.aiServiceConfigs).values({ serviceType: 'video', provider: 'minimax', name: '视频', baseUrl: base, apiKey: 'k', model: '["MiniMax-H3"]', priority: 1, createdAt: ts, updatedAt: ts }).returning().get()
db.insert(schema.aiServiceConfigs).values({ serviceType: 'text', provider: 'openai', name: '文本', baseUrl: base, apiKey: 'k', model: '["mock-text"]', priority: 1, createdAt: ts, updatedAt: ts }).run()

const row = (id: number) => db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get()!
const usageOf = (id: number) => db.select().from(schema.usageRecords)
  .where(eq(schema.usageRecords.refId, id)).all().find(r => r.refType === 'sys_task')!
async function waitFor<T>(fn: () => T | undefined | false, label: string): Promise<T> {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const v = fn()
    if (v) return v
    await new Promise(r => setTimeout(r, 20))
  }
  assert.fail(`timeout: ${label}`)
}

test('rules: defaults per type, per-model override, formulas, refund classification', async () => {
  assert.equal(await resolveUnitPoints('image', 'openai', 'img-a'), 10)
  assert.equal(await resolveUnitPoints('video', 'minimax', 'x'), 20)
  assert.equal(await resolveUnitPoints('subtitle', 'aliyun', 'x'), 2)
  assert.equal(await resolveUnitPoints('text', 'openai', 'x'), 0)

  assert.equal(computePoints('image', 10, 1), 10)
  assert.equal(computePoints('video', 20, 7.2), 144)
  assert.equal(computePoints('subtitle', 2, 61), 4) // 2 分钟
  assert.equal(computePoints('subtitle', 2, 0), 2) // 至少 1 分钟
  assert.equal(computePoints('text', 5, 999999), 0)

  assert.equal(isRefundableTaskFailure({ taskId: null, resultUrl: null, errorCode: null }), true)
  assert.equal(isRefundableTaskFailure({ taskId: 'x', resultUrl: null, errorCode: 'generation_failed' }), true)
  assert.equal(isRefundableTaskFailure({ taskId: 'x', resultUrl: 'u', errorCode: 'delivery_failed' }), false)
  assert.equal(isRefundableTaskFailure({ taskId: null, resultUrl: null, errorCode: 'submission_unknown' }), false)
})

test('records image / video / text usage per user, with model breakdown and visibility', async () => {
  const root = client()
  await root('POST', '/auth/setup', { username: 'root', password: 'rootpass' })
  const alice = client()
  await alice('POST', '/auth/register', { username: 'alice', password: 'secret1' })
  const aliceId = (await alice('GET', '/auth/me')).json.data.id

  // 规则：普通用户可读不可改；管理员改类型默认值 + 单个模型覆盖
  assert.equal((await alice('PUT', '/usage/rules', { defaults: { image: 1 } })).status, 403)
  const rules0 = (await alice('GET', '/usage/rules')).json.data
  assert.deepEqual(rules0.defaults, { image: 10, video: 20, subtitle: 2 })
  assert.ok(rules0.candidates.some((c: any) => c.service_type === 'image' && c.model === 'img-b' && c.provider === 'openai'))
  assert.equal((await root('PUT', '/usage/rules', { defaults: { video: -1 } })).status, 400)
  assert.equal((await root('PUT', '/usage/rules', {
    defaults: { image: 12, video: 15 },
    models: [{ service_type: 'image', provider: 'openai', model: 'img-b', points: 30 }],
  })).status, 200)
  assert.equal(await resolveUnitPoints('image', 'openai', 'img-a'), 12)
  assert.equal(await resolveUnitPoints('image', 'openai', 'img-b'), 30)

  const drama = (await alice('POST', '/dramas', { title: '用量项目' })).json.data
  const ep = db.insert(schema.episodes).values({ dramaId: drama.id, episodeNumber: 1, title: 'E1', imageConfigId: imageConfig.id, videoConfigId: videoConfig.id, createdAt: ts, updatedAt: ts }).returning().get()
  const sb = db.insert(schema.storyboards).values({ episodeId: ep.id, storyboardNumber: 1, createdAt: ts, updatedAt: ts }).returning().get()

  // 图片：两张不同模型，一张上游 400（没接单 → 退还）
  const img1 = (await alice('POST', '/tasks', { type: 'image', prompt: 'p', storyboard_id: sb.id, config_id: imageConfig.id, model: 'img-a' })).json.data.id
  const img2 = (await alice('POST', '/tasks', { type: 'image', prompt: 'p', storyboard_id: sb.id, config_id: imageConfig.id, model: 'img-b' })).json.data.id
  await waitFor(() => row(img1).status === 'completed' && row(img2).status === 'completed', 'images')
  await waitFor(() => usageOf(img2).status === 'succeeded', 'image usage')
  imageFails = true
  const img3 = (await alice('POST', '/tasks', { type: 'image', prompt: 'p', storyboard_id: sb.id, config_id: imageConfig.id, model: 'img-a' })).json.data.id
  await waitFor(() => row(img3).status === 'failed', 'image failed')
  imageFails = false
  assert.equal(row(img1).userId, aliceId)
  assert.deepEqual([usageOf(img1).points, usageOf(img1).status, usageOf(img1).source], [12, 'succeeded', 'shot_image'])
  assert.deepEqual([usageOf(img2).points, usageOf(img2).model], [30, 'img-b'])
  assert.equal(usageOf(img3).status, 'refunded')
  assert.equal(usageOf(img1).dramaId, drama.id)

  // 视频：请求 6 秒，上游实际 8 秒 → 按 8 秒重算
  const vid = (await alice('POST', '/tasks', { type: 'video', prompt: 'p', storyboard_id: sb.id, config_id: videoConfig.id, duration: 6 })).json.data.id
  await waitFor(() => row(vid).status === 'completed', 'video')
  await waitFor(() => usageOf(vid).status === 'succeeded', 'video usage')
  assert.deepEqual([usageOf(vid).quantity, usageOf(vid).points, usageOf(vid).unitPoints], [8, 120, 15])

  // 视频转存失败 → 待恢复（计积分）；恢复成功 → 成功
  videoAvailable = false
  const vid2 = (await alice('POST', '/tasks', { type: 'video', prompt: 'p2', storyboard_id: sb.id, config_id: videoConfig.id, duration: 6, force_new: true })).json.data.id
  await waitFor(() => row(vid2).status === 'failed', 'video failed')
  await waitFor(() => usageOf(vid2).status === 'held', 'video held')
  assert.equal(usageOf(vid2).points, 90) // 失败时按请求 6 秒预估
  videoAvailable = true
  await recoverVideoTask(vid2)
  await waitFor(() => usageOf(vid2).status === 'succeeded', 'video recovered')
  assert.equal(usageOf(vid2).points, 120)

  // 服务中断时还在提交的视频（没有上游编号）→ 提交结果未知，待恢复
  const stuck = db.insert(schema.sysTask).values({ type: 'video', storyboardId: sb.id, dramaId: drama.id, userId: aliceId, provider: 'minimax', status: 'processing', stage: 'submitting', createdAt: ts, updatedAt: ts }).returning().get()
  db.insert(schema.usageRecords).values({ userId: aliceId, dramaId: drama.id, serviceType: 'video', provider: 'minimax', model: 'MiniMax-H3', refType: 'sys_task', refId: stuck.id, quantity: 5, unitPoints: 15, points: 75, status: 'pending', createdAt: ts, updatedAt: ts }).run()
  await resumeInterruptedTasks()
  assert.equal(usageOf(stuck.id).status, 'held')

  // 文本：按 token 统计，不计积分
  const chat = await alice('POST', '/agent/script_rewriter/chat', { message: 'hi', drama_id: drama.id, episode_id: ep.id })
  assert.equal(chat.status, 200, JSON.stringify(chat.json))
  const text = await waitFor(() => db.select().from(schema.usageRecords).where(eq(schema.usageRecords.serviceType, 'text')).all()
    .find(r => r.source === 'agent:script_rewriter'), 'text usage')
  assert.deepEqual([text.userId, text.dramaId, text.model, text.provider, text.quantity, text.points, text.status],
    [aliceId, drama.id, 'mock-text', 'openai', 1500, 0, 'succeeded'])
  assert.deepEqual(JSON.parse(text.detail!), { inputTokens: 1200, outputTokens: 300, usageMissing: false })

  // 汇总：四个分类；点开图片看每个模型
  const summary = (await alice('GET', '/usage/summary')).json.data
  const byType = Object.fromEntries(summary.map((s: any) => [s.service_type, s]))
  assert.deepEqual(Object.keys(byType), ['image', 'video', 'subtitle', 'text'])
  assert.deepEqual([byType.image.count, byType.image.succeeded, byType.image.refunded, byType.image.quantity, byType.image.points], [3, 2, 1, 2, 42])
  assert.deepEqual([byType.video.count, byType.video.held, byType.video.points], [3, 1, 315])
  assert.deepEqual([byType.text.quantity, byType.text.points], [1500, 0])
  assert.equal(byType.subtitle.count, 0)
  const models = (await alice('GET', '/usage/summary/image/models')).json.data
  assert.deepEqual(models.map((m: any) => [m.model, m.count, m.points]), [['img-b', 1, 30], ['img-a', 2, 12]])
  assert.equal((await alice('GET', '/usage/summary/bogus/models')).status, 400)

  // 明细：按分类 + 模型筛选，带项目名和发起人
  const recs = (await alice('GET', '/usage/records?service_type=image&provider=openai&model=img-a')).json.data
  assert.equal(recs.total, 2)
  assert.deepEqual([recs.items[0].drama_title, recs.items[0].user_name], ['用量项目', 'alice'])

  // 可见范围：bob 只看到自己的（空）；管理员看全部，也能按成员筛选
  const bob = client()
  await bob('POST', '/auth/register', { username: 'bob', password: 'secret2' })
  assert.equal((await bob('GET', '/usage/summary')).json.data.find((s: any) => s.service_type === 'image').count, 0)
  assert.equal((await bob('GET', `/usage/records?user_id=${aliceId}`)).json.data.total, 0)
  assert.equal((await root('GET', '/usage/summary')).json.data.find((s: any) => s.service_type === 'image').count, 3)
  const bobId = (await bob('GET', '/auth/me')).json.data.id
  assert.equal((await root('GET', `/usage/summary?user_id=${bobId}`)).json.data.find((s: any) => s.service_type === 'image').count, 0)

  // 时间范围
  const future = new Date(Date.now() + 3600_000).toISOString()
  assert.equal((await alice('GET', `/usage/records?from=${encodeURIComponent(future)}`)).json.data.total, 0)

  // 删除单个模型覆盖 → 回到类型默认值
  assert.equal((await root('PUT', '/usage/rules', { models: [{ service_type: 'image', provider: 'openai', model: 'img-b', points: null }] })).status, 200)
  assert.equal(await resolveUnitPoints('image', 'openai', 'img-b'), 12)
  server.close()
})
