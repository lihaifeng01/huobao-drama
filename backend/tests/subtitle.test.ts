import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { eq } from 'drizzle-orm'

// Isolated DB/storage; never read or modify user data.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-subtitle-'))
process.env.SQLITE_PATH = path.join(root, 'subtitle.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
const { db, schema } = await import('../src/db/index.ts')
const { ffmpegPath } = await import('../src/utils/ffmpeg.ts')
const { enqueueSubtitles, buildEpisodeSrt } = await import('../src/services/subtitle.ts')
const { buildTranscriptionBody, parseTranscription } = await import('../src/services/adapters/aliyun-asr.ts')
const { sentencesToCues, cuesToSrt, parseSrt, formatSrtTime } = await import('../src/utils/srt.ts')
const { mergeEpisodeVideos } = await import('../src/services/ffmpeg-merge.ts')

test('SRT 时间格式与长句切分', () => {
  assert.equal(formatSrtTime(3_723_456), '01:02:03,456')
  // 短句原样，句末句号去掉、问号保留
  assert.deepEqual(sentencesToCues([{ begin_time: 0, end_time: 1000, text: '你好。' }]), [{ start: 0, end: 1000, text: '你好' }])
  assert.equal(sentencesToCues([{ begin_time: 0, end_time: 1000, text: '真的吗？' }])[0].text, '真的吗？')
  // 有字级时间戳时按字切，时间取首尾字
  const words = '今天天气很好我们一起去公园散步吧'.split('').map((ch, i) => ({ begin_time: i * 100, end_time: i * 100 + 90, text: ch, punctuation: i === 5 ? '，' : '' }))
  const cues = sentencesToCues([{ begin_time: 0, end_time: 1600, text: '今天天气很好，我们一起去公园散步吧', words }], 8)
  // 末尾两个字并回上一条，不单独成行
  assert.deepEqual(cues.map(c => c.text), ['今天天气很好', '我们一起去公园散步吧'])
  assert.equal(cues[1].start, 600)
  assert.equal(cues[1].end, 1590)
  // 无字级时间戳的超长片段均分，不留一两个字的尾巴（竖屏每行 12）
  const balanced = sentencesToCues([{ begin_time: 1300, end_time: 3800, text: '我等了你整整三年，今天无论如何都要把话说清楚！' }], 12)
  assert.deepEqual(balanced.map(c => c.text), ['我等了你整整三年', '今天无论如何都', '要把话说清楚！'])
  // 无字级时间戳时按标点切，并按字数分配时长
  const byText = sentencesToCues([{ begin_time: 0, end_time: 2000, text: '这是第一句话，这是第二句话' }], 8)
  assert.deepEqual(byText.map(c => c.text), ['这是第一句话', '这是第二句话'])
  assert.equal(byText[1].end, 2000)
  // SRT 往返
  assert.deepEqual(parseSrt(cuesToSrt(byText)), byText)
})

test('请求体按模型区分 file_url / file_urls，parameters 必传', () => {
  const qa = buildTranscriptionBody('qwen-audio-3.0-asr-flash-filetrans', 'oss://a/b.mp3')
  assert.deepEqual(qa.input, { file_urls: ['oss://a/b.mp3'] })
  assert.ok(qa.parameters)
  const q3 = buildTranscriptionBody('qwen3-asr-flash-filetrans', 'oss://a/b.mp3')
  assert.deepEqual(q3.input, { file_url: 'oss://a/b.mp3' })
  assert.equal(parseTranscription({ transcripts: [] }).length, 0)
})

// ---- 端到端：本地视频 → 抽音频 → 上传 → 识别（模拟百炼）→ SRT → 压制 ----

type Call = { method: string; url: string; headers: Record<string, string>; json?: any; formKeys?: string[] }
const calls: Call[] = []
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input)
  const headers = Object.fromEntries(new Headers(init?.headers).entries())
  const method = init?.method || 'GET'
  const json = (body: any) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  if (url.startsWith('https://dashscope.test/api/v1/uploads')) {
    calls.push({ method, url, headers })
    return json({ request_id: 'r', data: { policy: 'P', signature: 'S', upload_dir: 'dashscope-instant/abc', upload_host: 'https://oss.test', oss_access_key_id: 'AK', x_oss_object_acl: 'private', x_oss_forbid_overwrite: 'true' } })
  }
  if (url === 'https://oss.test') {
    calls.push({ method, url, headers, formKeys: [...(init.body as FormData).keys()] })
    return new Response('', { status: 200 })
  }
  if (url === 'https://dashscope.test/api/v1/services/audio/asr/transcription') {
    calls.push({ method, url, headers, json: JSON.parse(init.body) })
    return json({ output: { task_status: 'PENDING', task_id: 'task-1' } })
  }
  if (url === 'https://dashscope.test/api/v1/tasks/task-1') {
    calls.push({ method, url, headers })
    return json({ output: { task_id: 'task-1', task_status: 'SUCCEEDED', results: [{ file_url: 'oss://x', transcription_url: 'https://result.test/r.json', subtask_status: 'SUCCEEDED' }] } })
  }
  if (url === 'https://result.test/r.json') {
    return json({ transcripts: [{ channel_id: 0, sentences: [{ begin_time: 200, end_time: 1500, text: '你好，世界。' }] }] })
  }
  return realFetch(input, init)
}) as typeof fetch

function makeVideo(rel: string, withAudio: boolean) {
  const abs = path.join(root, rel)
  const args = ['-y', '-f', 'lavfi', '-i', 'color=c=gray:s=320x180:d=2']
  if (withAudio) args.push('-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-shortest', '-c:a', 'aac')
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', abs)
  const r = spawnSync(ffmpegPath!, args)
  assert.equal(r.status, 0, r.stderr?.toString())
}

async function waitStatus(id: number) {
  for (let i = 0; i < 100; i++) {
    const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id))
    if (sb.subtitleStatus !== 'processing') return sb
    await new Promise(r => setTimeout(r, 200))
  }
  throw new Error('timeout')
}

test('镜头字幕：识别、生成 SRT、压制字幕版，整集字幕按成片时间轴平移', async () => {
  await fs.mkdir(path.join(root, 'static', 'videos'), { recursive: true })
  makeVideo('static/videos/a.mp4', true)
  makeVideo('static/videos/b.mp4', true)
  makeVideo('static/videos/silent.mp4', false)

  const ts = new Date().toISOString()
  await db.insert(schema.aiServiceConfigs).values({
    serviceType: 'subtitle', provider: 'aliyun', name: 'asr', baseUrl: 'https://dashscope.test', apiKey: 'sk-test',
    model: JSON.stringify(['qwen-audio-3.0-asr-flash-filetrans']), isActive: true, createdAt: ts, updatedAt: ts,
  })
  const ids: number[] = []
  for (const [n, video] of [[1, 'static/videos/a.mp4'], [2, 'static/videos/b.mp4'], [3, 'static/videos/silent.mp4']] as const) {
    const res = await db.insert(schema.storyboards).values({ episodeId: 1, storyboardNumber: n, videoUrl: video, createdAt: ts, updatedAt: ts })
    ids.push(Number(res.lastInsertRowid))
  }

  const accepted = await enqueueSubtitles(ids)
  assert.deepEqual(accepted, ids)
  const [a, b, silent] = [await waitStatus(ids[0]), await waitStatus(ids[1]), await waitStatus(ids[2])]

  assert.equal(a.subtitleStatus, 'completed', a.subtitleError || '')
  assert.equal(a.subtitleSourceVideo, 'static/videos/a.mp4')
  assert.ok(existsSync(path.join(root, a.subtitleUrl!)))
  assert.ok(existsSync(path.join(root, a.subtitledVideoUrl!)))
  assert.match(await fs.readFile(path.join(root, a.subtitleUrl!), 'utf8'), /00:00:00,200 --> 00:00:01,500\n你好，世界/)
  assert.equal(b.subtitleStatus, 'completed')
  assert.equal(silent.subtitleStatus, 'no_speech')

  // 用量：有音轨的两个镜头各记一次语音识别（按视频时长），无音轨的没调用识别、不记
  const usage = (await db.select().from(schema.usageRecords)).filter(r => r.serviceType === 'subtitle' && r.refType === 'storyboard_subtitle')
  assert.deepEqual(usage.map(r => r.refId).sort(), [ids[0], ids[1]].sort())
  for (const r of usage) {
    assert.equal(r.status, 'succeeded')
    assert.equal(r.provider, 'aliyun')
    assert.ok(r.quantity > 0)
    assert.equal(r.points, 2) // 默认每分钟 2 积分，不足 1 分钟按 1 分钟
  }

  // 请求核对：上传凭证与识别模型一致；oss:// 地址；异步与 OSS 解析头
  const policy = calls.find(c => c.url.includes('/uploads'))!
  assert.match(policy.url, /action=getPolicy/)
  assert.match(policy.url, /model=qwen-audio-3.0-asr-flash-filetrans/)
  assert.equal(policy.headers.authorization, 'Bearer sk-test')
  const upload = calls.find(c => c.url === 'https://oss.test')!
  assert.equal(upload.formKeys!.at(-1), 'file')
  const submit = calls.find(c => c.json)!
  assert.equal(submit.headers['x-dashscope-async'], 'enable')
  assert.equal(submit.headers['x-dashscope-ossresourceresolve'], 'enable')
  assert.match(submit.json.input.file_urls[0], /^oss:\/\/dashscope-instant\/abc\/.+\.mp3$/)

  // 整集字幕：第二个镜头的字幕平移约 2 秒
  const cues = parseSrt(await buildEpisodeSrt(1))
  assert.equal(cues.length, 2)
  assert.ok(Math.abs(cues[1].start - 2200) < 100, `offset ${cues[1].start}`)

  // 拼接默认使用字幕版；视频重新生成后字幕过期，回退原视频
  await db.update(schema.storyboards).set({ videoUrl: 'static/videos/silent.mp4' }).where(eq(schema.storyboards.id, ids[1]))
  const mergeId = await mergeEpisodeVideos(1, 1, ids.slice(0, 2))
  const [merge] = await db.select().from(schema.videoMerges).where(eq(schema.videoMerges.id, mergeId))
  assert.deepEqual(JSON.parse(merge.scenes!), [a.subtitledVideoUrl, 'static/videos/silent.mp4'])
  const plainId = await mergeEpisodeVideos(1, 1, ids.slice(0, 1), false)
  const [plain] = await db.select().from(schema.videoMerges).where(eq(schema.videoMerges.id, plainId))
  assert.deepEqual(JSON.parse(plain.scenes!), ['static/videos/a.mp4'])
  // 等后台拼接结束再退出，避免临时目录被占用
  for (let i = 0; i < 100; i++) {
    const rows = await db.select().from(schema.videoMerges)
    if (rows.every(r => r.status !== 'processing')) break
    await new Promise(r => setTimeout(r, 200))
  }
})

test('按工作台所选配置与模型识别；模型不在该配置中时拒绝', async () => {
  const ts = new Date().toISOString()
  const res = await db.insert(schema.aiServiceConfigs).values({
    serviceType: 'subtitle', provider: 'aliyun', name: 'asr-q3', baseUrl: 'https://dashscope.test', apiKey: 'sk-q3',
    model: JSON.stringify(['qwen-audio-3.0-asr-flash-filetrans', 'qwen3-asr-flash-filetrans']), priority: -1, isActive: true, createdAt: ts, updatedAt: ts,
  })
  const configId = Number(res.lastInsertRowid)
  const sb = await db.insert(schema.storyboards).values({ episodeId: 2, storyboardNumber: 1, videoUrl: 'static/videos/a.mp4', createdAt: ts, updatedAt: ts })
  const id = Number(sb.lastInsertRowid)

  await assert.rejects(enqueueSubtitles([id], { configId, model: 'not-a-model' }), /没有模型 not-a-model/)
  // 非字幕类型的配置 id 不能冒充
  const img = await db.insert(schema.aiServiceConfigs).values({ serviceType: 'image', provider: 'openai', name: 'img', baseUrl: 'x', apiKey: 'x', model: '[]', isActive: true, createdAt: ts, updatedAt: ts })
  await assert.rejects(enqueueSubtitles([id], { configId: Number(img.lastInsertRowid) }), /所选字幕配置不存在/)

  calls.length = 0
  assert.deepEqual(await enqueueSubtitles([id], { configId, model: 'qwen3-asr-flash-filetrans' }), [id])
  const done = await waitStatus(id)
  assert.equal(done.subtitleStatus, 'completed', done.subtitleError || '')
  const policy = calls.find(c => c.url.includes('/uploads'))!
  assert.match(policy.url, /model=qwen3-asr-flash-filetrans/)
  assert.equal(policy.headers.authorization, 'Bearer sk-q3')
  const submit = calls.find(c => c.json)!
  assert.equal(submit.json.model, 'qwen3-asr-flash-filetrans')
  assert.match(submit.json.input.file_url, /^oss:\/\//)
})
