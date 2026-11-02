import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

// Isolated DB/storage; never read or modify user data.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-voice-clone-'))
process.env.SQLITE_PATH = path.join(root, 'tool.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
const { db, schema } = await import('../src/db/index.ts')
const { eq } = await import('drizzle-orm')
const { ffmpegPath } = await import('../src/utils/ffmpeg.ts')
const tools = (await import('../src/routes/tools.ts')).default
const { isValidVoiceId, generateVoiceId } = await import('../src/services/adapters/minimax-voice.ts')

// 模拟 MiniMax：上传样本 → 复刻（返回试听地址）→ 合成（十六进制 mp3）
const requests: { url: string; body: any; auth: string | null }[] = []
let cloneFails = false
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input)
  const json = (body: any) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  const auth = new Headers(init?.headers).get('authorization')
  if (url === 'https://minimax.test/v1/files/upload') {
    const fd = init.body as FormData
    requests.push({ url, body: { purpose: fd.get('purpose'), file: (fd.get('file') as File)?.size }, auth })
    return json({ file: { file_id: 123456 }, base_resp: { status_code: 0, status_msg: 'success' } })
  }
  if (url === 'https://minimax.test/v1/voice_clone') {
    const body = JSON.parse(init.body)
    requests.push({ url, body, auth })
    if (cloneFails) return json({ base_resp: { status_code: 2038, status_msg: 'no cloning permission' } })
    return json({ input_sensitive: false, demo_audio: 'https://cdn.test/demo.mp3', base_resp: { status_code: 0, status_msg: 'success' } })
  }
  if (url === 'https://cdn.test/demo.mp3') return new Response(Buffer.from('ID3demo'), { status: 200 })
  if (url === 'https://minimax.test/v1/t2a_v2') {
    const body = JSON.parse(init.body)
    requests.push({ url, body, auth })
    return json({ data: { audio: Buffer.from('ID3speech').toString('hex'), status: 2 }, extra_info: { usage_characters: 4 }, base_resp: { status_code: 0, status_msg: 'success' } })
  }
  return realFetch(input, init)
}) as typeof fetch

const call = async (method: string, url: string, body?: any) => {
  const init: RequestInit = { method }
  if (body instanceof FormData) init.body = body
  else if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { 'Content-Type': 'application/json' } }
  const res = await tools.request(url, init)
  return { status: res.status, json: await res.json() as any }
}
const form = (name: string, content: Buffer | string, extra: Record<string, string> = {}) => {
  const fd = new FormData()
  fd.append('file', new Blob([content]), name)
  for (const [k, v] of Object.entries(extra)) fd.append(k, v)
  return fd
}
async function waitIdle(id: number) {
  for (let i = 0; i < 150; i++) {
    const { json } = await call('GET', `/voice-clones/${id}`)
    if (json.data.status === 'idle') return json.data
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error('timeout')
}
function makeAudio(name: string, seconds: number) {
  const out = path.join(root, name)
  const r = spawnSync(ffmpegPath!, ['-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-c:a', 'libmp3lame', out])
  assert.equal(r.status, 0, r.stderr?.toString())
  return out
}

test('voice_id 规则', () => {
  assert.ok(isValidVoiceId(generateVoiceId()))
  assert.ok(isValidVoiceId('MyVoice_01'))
  assert.equal(isValidVoiceId('1abcdefgh'), false)
  assert.equal(isValidVoiceId('short'), false)
  assert.equal(isValidVoiceId('abcdefgh_'), false)
})

test('音色复刻：上传样本 → 复刻（含试听）→ 合成 → 用量记录 → 删除', async () => {
  const ts = new Date().toISOString()
  const [cfg] = await db.insert(schema.aiServiceConfigs).values({
    serviceType: 'audio', provider: 'minimax', name: 'mm', baseUrl: 'https://minimax.test', apiKey: 'sk-mm',
    model: JSON.stringify(['speech-2.8-hd', 'speech-2.8-turbo']), isActive: true, createdAt: ts, updatedAt: ts,
  }).returning()

  // 格式、时长校验
  assert.equal((await call('POST', '/voice-clones', form('a.txt', 'x'))).status, 400)
  const tooShort = await call('POST', '/voice-clones', form('short.mp3', await fs.readFile(makeAudio('short.mp3', 3))))
  assert.equal(tooShort.status, 400)
  assert.match(tooShort.json.message, /10 秒/)

  const created = await call('POST', '/voice-clones', form('林晚.mp3', await fs.readFile(makeAudio('ok.mp3', 12)), { name: '林晚' }))
  assert.equal(created.status, 200, JSON.stringify(created.json))
  const job = created.json.data
  assert.equal(job.name, '林晚')
  assert.equal(job.cloned, false)
  assert.ok(job.sample_duration >= 11)

  // 未复刻不能合成；不存在的模型拒绝
  assert.equal((await call('POST', `/voice-clones/${job.id}/synthesize`, { text: '你好' })).status, 400)
  assert.equal((await call('POST', `/voice-clones/${job.id}/clone`, { model: 'nope' })).status, 400)
  assert.equal((await call('POST', `/voice-clones/${job.id}/clone`, { voice_id: '1bad' })).status, 400)

  const cloning = await call('POST', `/voice-clones/${job.id}/clone`, { config_id: cfg.id, model: 'speech-2.8-turbo', voice_id: 'LinWan_001', preview_text: '你好呀', noise_reduction: true })
  assert.equal(cloning.status, 200, JSON.stringify(cloning.json))
  const cloned = await waitIdle(job.id)
  assert.equal(cloned.error_msg, null)
  assert.equal(cloned.cloned, true)
  assert.equal(cloned.voice_id, 'LinWan_001')
  assert.equal(cloned.config_id, cfg.id)
  assert.ok(cloned.demo_url && existsSync(path.join(root, cloned.demo_url)))

  const upload = requests.find(r => r.url.endsWith('/files/upload'))!
  assert.equal(upload.body.purpose, 'voice_clone')
  assert.equal(upload.auth, 'Bearer sk-mm')
  const clone = requests.find(r => r.url.endsWith('/voice_clone'))!
  assert.deepEqual(clone.body, {
    file_id: 123456, voice_id: 'LinWan_001', need_noise_reduction: true, need_volume_normalization: false,
    text: '你好呀', model: 'speech-2.8-turbo',
  })

  // 合成：文字为空 / 语速越界拒绝；正常合成写回 outputs
  assert.equal((await call('POST', `/voice-clones/${job.id}/synthesize`, { text: '  ' })).status, 400)
  assert.equal((await call('POST', `/voice-clones/${job.id}/synthesize`, { text: 'x', speed: 5 })).status, 400)
  const synth = await call('POST', `/voice-clones/${job.id}/synthesize`, { text: '今天天气', speed: 1.2 })
  assert.equal(synth.status, 200, JSON.stringify(synth.json))
  const done = await waitIdle(job.id)
  assert.equal(done.error_msg, null)
  assert.equal(done.outputs.length, 1)
  assert.equal(done.outputs[0].text, '今天天气')
  assert.equal(done.outputs[0].model, 'speech-2.8-hd')
  assert.equal((await fs.readFile(path.join(root, done.outputs[0].url))).toString(), 'ID3speech')
  const t2a = requests.find(r => r.url.endsWith('/t2a_v2'))!
  assert.equal(t2a.body.voice_setting.voice_id, 'LinWan_001')
  assert.equal(t2a.body.voice_setting.speed, 1.2)
  assert.equal(t2a.body.model, 'speech-2.8-hd')

  // 用量：复刻、合成各一条，音频只统计不计积分
  const usage = await db.select().from(schema.usageRecords).where(eq(schema.usageRecords.serviceType, 'audio'))
  assert.deepEqual(usage.map(u => [u.refType, u.status, u.points]).sort(), [['voice_clone', 'succeeded', 0], ['voice_synthesis', 'succeeded', 0]])

  // 移除合成结果、改名
  assert.equal((await call('DELETE', `/voice-clones/${job.id}/outputs?url=${encodeURIComponent(done.outputs[0].url)}`)).json.data.outputs.length, 0)
  assert.equal((await call('PUT', `/voice-clones/${job.id}`, { name: '新名字' })).json.data.name, '新名字')

  // 服务商返回业务错误：记到 error_msg，已有的复刻结果不变，用量退还
  cloneFails = true
  await call('POST', `/voice-clones/${job.id}/clone`, {})
  const failed = await waitIdle(job.id)
  assert.match(failed.error_msg, /no cloning permission/)
  assert.equal(failed.voice_id, 'LinWan_001')
  const refunded = await db.select().from(schema.usageRecords).where(eq(schema.usageRecords.status, 'refunded'))
  assert.equal(refunded.length, 1)

  assert.equal((await call('DELETE', `/voice-clones/${job.id}`)).status, 200)
  assert.equal((await call('GET', `/voice-clones/${job.id}`)).status, 404)
  assert.equal((await call('GET', '/voice-clones')).json.data.length, 0)
})
