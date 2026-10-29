import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

// Isolated DB/storage; never read or modify user data.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-subtitle-tool-'))
process.env.SQLITE_PATH = path.join(root, 'tool.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
const { db, schema } = await import('../src/db/index.ts')
const { ffmpegPath } = await import('../src/utils/ffmpeg.ts')
const tools = (await import('../src/routes/tools.ts')).default
const { cuesToAss, normalizeSubtitleStyle, defaultSubtitleStyle } = await import('../src/utils/ass.ts')

// 模拟百炼：上传凭证 → OSS → 提交 → 查询 → 结果
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input)
  const json = (body: any) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  if (url.startsWith('https://dashscope.test/api/v1/uploads')) return json({ data: { policy: 'P', signature: 'S', upload_dir: 'd', upload_host: 'https://oss.test', oss_access_key_id: 'AK', x_oss_object_acl: 'private', x_oss_forbid_overwrite: 'true' } })
  if (url === 'https://oss.test') return new Response('', { status: 200 })
  if (url.endsWith('/services/audio/asr/transcription')) return json({ output: { task_status: 'PENDING', task_id: 't1' } })
  if (url.endsWith('/tasks/t1')) return json({ output: { task_status: 'SUCCEEDED', results: [{ transcription_url: 'https://result.test/r.json', subtask_status: 'SUCCEEDED' }] } })
  if (url === 'https://result.test/r.json') return json({ transcripts: [{ sentences: [{ begin_time: 200, end_time: 1500, text: '你好，世界。' }] }] })
  return realFetch(input, init)
}) as typeof fetch

const call = async (method: string, url: string, body?: any) => {
  const init: RequestInit = { method }
  if (body instanceof FormData) init.body = body
  else if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { 'Content-Type': 'application/json' } }
  const res = await tools.request(url, init)
  return { status: res.status, json: await res.json() as any }
}
const form = (name: string, content: Buffer | string) => {
  const fd = new FormData()
  fd.append('file', new Blob([content]), name)
  return fd
}
async function waitIdle(id: number) {
  for (let i = 0; i < 150; i++) {
    const { json } = await call('GET', `/subtitle-jobs/${id}`)
    if (json.data.status === 'idle') return json.data
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error('timeout')
}

test('ASS 样式：按视频像素设字号与距底高度，花括号转义', () => {
  const ass = cuesToAss([{ start: 0, end: 1500, text: '你好{x}' }], { width: 720, height: 1280, fontName: 'F', style: { fontSize: 40, bottomPercent: 10 } })
  assert.match(ass, /PlayResX: 720\nPlayResY: 1280/)
  assert.match(ass, /Style: Default,F,40,.*,2,36,36,128,1/)
  assert.match(ass, /Dialogue: 0,0:00:00\.00,0:00:01\.50,Default,,0,0,0,,你好｛x｝/)
  // 非法输入回落默认，越界值夹到范围内
  assert.deepEqual(normalizeSubtitleStyle({}, 720, 1280), defaultSubtitleStyle(720, 1280))
  assert.equal(normalizeSubtitleStyle({ font_size: 9999, bottom_percent: -5 }, 720, 1280).fontSize, 320)
  assert.equal(normalizeSubtitleStyle({ font_size: 9999, bottom_percent: -5 }, 720, 1280).bottomPercent, 0)
})

test('字幕工具：上传视频 → 自动识别 → 上传 GBK 字幕替换 → 自定义样式合成 → 删除', async () => {
  const ts = new Date().toISOString()
  await db.insert(schema.aiServiceConfigs).values({
    serviceType: 'subtitle', provider: 'aliyun', name: 'asr', baseUrl: 'https://dashscope.test', apiKey: 'sk',
    model: JSON.stringify(['qwen-audio-3.0-asr-flash-filetrans']), isActive: true, createdAt: ts, updatedAt: ts,
  })
  const video = path.join(root, 'in.mp4')
  const r = spawnSync(ffmpegPath!, ['-y', '-f', 'lavfi', '-i', 'color=size=720x1280:rate=25:color=gray:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', video])
  assert.equal(r.status, 0, r.stderr?.toString())

  assert.equal((await call('POST', '/subtitle-jobs', form('a.txt', 'x'))).status, 400)
  const created = await call('POST', '/subtitle-jobs', form('我的视频.mp4', await fs.readFile(video)))
  assert.equal(created.status, 200, JSON.stringify(created.json))
  const job = created.json.data
  assert.equal(job.name, '我的视频.mp4')
  assert.equal(job.width, 720)
  assert.equal(job.height, 1280)
  assert.equal(job.has_audio, true)
  assert.deepEqual(job.style, job.default_style)

  // 没字幕不能合成
  assert.match((await call('POST', `/subtitle-jobs/${job.id}/burn`, {})).json.message, /还没有字幕/)

  await call('POST', `/subtitle-jobs/${job.id}/transcribe`, {})
  let cur = await waitIdle(job.id)
  assert.equal(cur.error_msg, null)
  assert.equal(cur.subtitle_source, 'asr')
  assert.match(await fs.readFile(path.join(root, cur.subtitle_url), 'utf8'), /你好，世界/)

  // 手动上传 GBK 编码的 SRT（「再见」）覆盖识别结果
  const gbk = Buffer.concat([Buffer.from('1\r\n00:00:00,500 --> 00:00:01,800\r\n'), Buffer.from([0xd4, 0xd9, 0xbc, 0xfb]), Buffer.from('\r\n')])
  assert.match((await call('POST', `/subtitle-jobs/${job.id}/subtitle`, form('x.ass', 'x'))).json.message, /\.srt/)
  cur = (await call('POST', `/subtitle-jobs/${job.id}/subtitle`, form('sub.srt', gbk))).json.data
  assert.equal(cur.subtitle_source, 'upload')
  assert.match(await fs.readFile(path.join(root, cur.subtitle_url), 'utf8'), /00:00:00,500 --> 00:00:01,800\n再见/)

  await call('POST', `/subtitle-jobs/${job.id}/burn`, { font_size: 60, bottom_percent: 30 })
  cur = await waitIdle(job.id)
  assert.equal(cur.error_msg, null)
  assert.deepEqual(cur.style, { font_size: 60, bottom_percent: 30 })
  assert.ok(existsSync(path.join(root, cur.output_url)))
  // 字幕更新后旧成品作废
  cur = (await call('POST', `/subtitle-jobs/${job.id}/subtitle`, form('sub.srt', gbk))).json.data
  assert.equal(cur.output_url, null)

  assert.equal((await call('DELETE', `/subtitle-jobs/${job.id}`)).status, 200)
  assert.equal((await call('GET', `/subtitle-jobs/${job.id}`)).status, 404)
  assert.equal((await call('GET', '/subtitle-jobs')).json.data.length, 0)
})

test.after(async () => { await fs.rm(root, { recursive: true, force: true }) })
