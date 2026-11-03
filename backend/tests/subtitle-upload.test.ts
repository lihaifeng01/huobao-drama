import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { eq } from 'drizzle-orm'

// Isolated DB/storage; never read or modify user data.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-subtitle-upload-'))
process.env.SQLITE_PATH = path.join(root, 'subtitle-upload.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
const { db, schema } = await import('../src/db/index.ts')
const { ffmpegPath } = await import('../src/utils/ffmpeg.ts')
const { buildEpisodeSrt } = await import('../src/services/subtitle.ts')
const { default: subtitles } = await import('../src/routes/subtitles.ts')

function makeVideo(rel: string, withAudio: boolean) {
  const abs = path.join(root, rel)
  const args = ['-y', '-f', 'lavfi', '-i', 'color=c=gray:s=320x180:d=2']
  if (withAudio) args.push('-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-shortest', '-c:a', 'aac')
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', abs)
  const r = spawnSync(ffmpegPath!, args)
  assert.equal(r.status, 0, r.stderr?.toString())
}

function hasAudioStream(rel: string) {
  const r = spawnSync(ffmpegPath!, ['-i', path.join(root, rel)])
  return /Audio:/.test(r.stderr.toString())
}

async function waitStatus(id: number) {
  for (let i = 0; i < 100; i++) {
    const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id))
    if (sb.subtitleStatus !== 'processing') return sb
    await new Promise(r => setTimeout(r, 200))
  }
  throw new Error('timeout')
}

async function upload(id: number, name: string, content: string | Uint8Array) {
  const form = new FormData()
  form.append('file', new File([content], name))
  const res = await subtitles.request(`/storyboards/${id}/upload`, { method: 'POST', body: form })
  return { status: res.status, body: await res.json() as any }
}

const ts = new Date().toISOString()
async function storyboard(episodeId: number, n: number, videoUrl: string | null) {
  const res = await db.insert(schema.storyboards).values({ episodeId, storyboardNumber: n, videoUrl, createdAt: ts, updatedAt: ts })
  return Number(res.lastInsertRowid)
}

test('手动上传字幕：不需要字幕服务，GBK VTT 转 UTF-8 SRT，压制字幕版；无音轨视频也能压', async () => {
  await fs.mkdir(path.join(root, 'static', 'videos'), { recursive: true })
  makeVideo('static/videos/a.mp4', true)
  makeVideo('static/videos/silent.mp4', false)
  const a = await storyboard(1, 1, 'static/videos/a.mp4')
  const silent = await storyboard(1, 2, 'static/videos/silent.mp4')

  // 没有任何字幕服务配置。GBK 编码的 WebVTT：省略小时的时间、时间后带样式设置、文本带 <v> 标签
  const gbkBytes = Buffer.concat([
    Buffer.from('WEBVTT\n\n00:00.300 --> 00:01.200 align:center\n<v x>'),
    Buffer.from([0xc4, 0xe3, 0xba, 0xc3]), // 你好（GBK）
    Buffer.from('\n\n00:01.200 --> 00:01.900\n'),
    Buffer.from([0xb5, 0xda, 0xb6, 0xfe, 0xbe, 0xe4]), // 第二句（GBK）
    Buffer.from('\n'),
  ])
  const r1 = await upload(a, 'shot1.vtt', new Uint8Array(gbkBytes))
  assert.equal(r1.status, 200, JSON.stringify(r1.body))
  assert.equal(r1.body.data.cues, 2)

  const r2 = await upload(silent, 'shot2.srt', '1\n00:00:00,000 --> 00:00:01,000\n无声镜头的字幕\n')
  assert.equal(r2.status, 200, JSON.stringify(r2.body))

  const done = await waitStatus(a)
  assert.equal(done.subtitleStatus, 'completed', done.subtitleError || '')
  assert.equal(done.subtitleOrigin, 'upload')
  assert.equal(done.subtitleSourceVideo, 'static/videos/a.mp4')
  assert.equal(await fs.readFile(path.join(root, done.subtitleUrl!), 'utf8'),
    '1\n00:00:00,300 --> 00:00:01,200\n你好\n\n2\n00:00:01,200 --> 00:00:01,900\n第二句\n')
  assert.ok(existsSync(path.join(root, done.subtitledVideoUrl!)))
  assert.ok(hasAudioStream(done.subtitledVideoUrl!))

  const s = await waitStatus(silent)
  assert.equal(s.subtitleStatus, 'completed', s.subtitleError || '')
  assert.ok(existsSync(path.join(root, s.subtitledVideoUrl!)))
  assert.equal(hasAudioStream(s.subtitledVideoUrl!), false)

  // 整集字幕照常拼接（第二个镜头偏移 2 秒）
  const srt = await buildEpisodeSrt(1)
  assert.match(srt, /00:00:02,000 --> 00:00:03,000\n无声镜头的字幕/)

  // 「全部生成」跳过手动上传的字幕（全部跳过时不需要字幕服务）
  const batch = await subtitles.request('/episodes/1', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })
  const batchBody = await batch.json() as any
  assert.equal(batch.status, 200, JSON.stringify(batchBody))
  assert.deepEqual(batchBody.data, { storyboard_ids: [], skipped_uploaded: 2 })

  // 清除字幕时来源一起清掉
  await subtitles.request(`/storyboards/${a}`, { method: 'DELETE' })
  const [cleared] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, a))
  assert.equal(cleared.subtitleOrigin, null)
  assert.equal(cleared.subtitleUrl, null)
})

test('手动上传字幕：格式、内容、时间轴、视频缺失等校验', async () => {
  makeVideo('static/videos/c.mp4', true)
  const c = await storyboard(2, 1, 'static/videos/c.mp4')
  const noVideo = await storyboard(2, 2, null)

  const cases: [number, string, string, RegExp][] = [
    [c, 'a.txt', '1\n00:00:00,000 --> 00:00:01,000\nx\n', /\.srt \/ \.vtt/],
    [c, 'a.srt', '', /为空|请选择字幕文件/],
    [c, 'a.srt', 'just some text\nwithout timing', /没有可识别的字幕条目/],
    [c, 'a.srt', '1\n00:00:05,000 --> 00:00:06,000\n在视频之后\n', /视频结束/],
    [noVideo, 'a.srt', '1\n00:00:00,000 --> 00:00:01,000\nx\n', /还没有视频/],
    [99999, 'a.srt', '1\n00:00:00,000 --> 00:00:01,000\nx\n', /镜头不存在/],
  ]
  for (const [id, name, content, expected] of cases) {
    const r = await upload(id, name, content)
    assert.notEqual(r.status, 200, `${name} 应被拒绝`)
    assert.match(r.body.message, expected)
  }
  const tooBig = await upload(c, 'big.srt', 'x'.repeat(5 * 1024 * 1024 + 100 * 1024))
  assert.equal(tooBig.status, 400)
  assert.match(tooBig.body.message, /5MB/)

  // 处理中再次上传被拒
  const ok = await upload(c, 'a.srt', '1\n00:00:00,000 --> 00:00:01,000\n第一次\n')
  assert.equal(ok.status, 200)
  const again = await upload(c, 'a.srt', '1\n00:00:00,000 --> 00:00:01,000\n第二次\n')
  assert.equal(again.status, 400)
  assert.match(again.body.message, /正在制作中/)
  const done = await waitStatus(c)
  assert.equal(done.subtitleStatus, 'completed', done.subtitleError || '')
  // 部分超出视频时长的字幕是允许的
  const partial = await upload(c, 'p.srt', '1\n00:00:01,500 --> 00:00:03,000\n跨过结尾\n')
  assert.equal(partial.status, 200, JSON.stringify(partial.body))
  assert.equal((await waitStatus(c)).subtitleStatus, 'completed')
})
