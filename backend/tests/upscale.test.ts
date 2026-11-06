import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { eq } from 'drizzle-orm'

// Isolated DB/storage; never read or modify user data.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-upscale-'))
process.env.SQLITE_PATH = path.join(root, 'upscale.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
const { db, schema } = await import('../src/db/index.ts')
const { ffmpegPath } = await import('../src/utils/ffmpeg.ts')
const { probeVideo, buildEpisodeSrt } = await import('../src/services/subtitle.ts')
const { upscaleDimensions, enqueueUpscale, clearUpscale } = await import('../src/services/upscale.ts')
const { effectiveShotVideo, isUpscaleCurrent, isSubtitleCurrent, isSubtitledVideoCurrent, needsSubtitleReburn } = await import('../src/services/shot-video.ts')
const { mergeEpisodeVideos } = await import('../src/services/ffmpeg-merge.ts')
const { default: upscaleRoutes } = await import('../src/routes/upscale.ts')
const { default: subtitleRoutes } = await import('../src/routes/subtitles.ts')

type Row = typeof schema.storyboards.$inferSelect

function makeVideo(rel: string, size: string, withAudio = true) {
  const args = ['-y', '-f', 'lavfi', '-i', `testsrc=s=${size}:d=2:r=10`]
  if (withAudio) args.push('-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-shortest', '-c:a', 'aac')
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(root, rel))
  const r = spawnSync(ffmpegPath!, args)
  assert.equal(r.status, 0, r.stderr?.toString())
}

async function row(id: number): Promise<Row> {
  const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id))
  return sb
}

async function waitFor(id: number, done: (sb: Row) => boolean) {
  for (let i = 0; i < 300; i++) {
    const sb = await row(id)
    if (done(sb)) return sb
    await new Promise(r => setTimeout(r, 200))
  }
  throw new Error('timeout')
}
const upscaleSettled = (sb: Row) => sb.upscaleStatus !== 'processing'
const subtitleSettled = (sb: Row) => sb.subtitleStatus !== 'processing'

async function post(app: any, url: string, body: unknown) {
  const res = await app.request(url, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
  return { status: res.status, body: await res.json() as any }
}

async function uploadSrt(id: number, srt: string) {
  const form = new FormData()
  form.append('file', new File([srt], 'shot.srt'))
  const res = await subtitleRoutes.request(`/storyboards/${id}/upload`, { method: 'POST', body: form })
  assert.equal(res.status, 200, await res.text())
}

const ts = new Date().toISOString()
async function storyboard(episodeId: number, n: number, videoUrl: string) {
  const res = await db.insert(schema.storyboards).values({ episodeId, storyboardNumber: n, videoUrl, createdAt: ts, updatedAt: ts })
  return Number(res.lastInsertRowid)
}

test('目标尺寸：按短边等比放大，宽高取偶数，横竖屏都对', () => {
  assert.deepEqual(upscaleDimensions(1280, 720, '1080p'), { width: 1920, height: 1080 })
  assert.deepEqual(upscaleDimensions(720, 1280, '1080p'), { width: 1080, height: 1920 })
  assert.deepEqual(upscaleDimensions(854, 480, '1440p'), { width: 2562, height: 1440 })
  assert.deepEqual(upscaleDimensions(1280, 720, '2160p'), { width: 3840, height: 2160 })
})

test('增强结果单独存放；字幕版自动改压在增强版上；拼接用生效视频；原视频重新生成后增强作废；清除后回到原视频', async () => {
  await fs.mkdir(path.join(root, 'static', 'videos'), { recursive: true })
  makeVideo('static/videos/a.mp4', '320x180')
  makeVideo('static/videos/b.mp4', '320x180', false)
  makeVideo('static/videos/a2.mp4', '320x180')
  const a = await storyboard(1, 1, 'static/videos/a.mp4')
  const b = await storyboard(1, 2, 'static/videos/b.mp4')

  // 先在原视频上做好字幕（手动上传，不需要字幕服务）
  await uploadSrt(a, '1\n00:00:00,200 --> 00:00:01,500\n你好\n')
  const sub0 = await waitFor(a, subtitleSettled)
  assert.equal(sub0.subtitleStatus, 'completed', sub0.subtitleError || '')
  assert.equal(sub0.subtitledBaseVideo, 'static/videos/a.mp4')
  const srtBefore = sub0.subtitleUrl

  // 增强（不传 target 默认 1080p）
  const r = await post(upscaleRoutes, `/storyboards/${a}`, {})
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const up = await waitFor(a, upscaleSettled)
  assert.equal(up.upscaleStatus, 'completed', up.upscaleError || '')
  assert.equal(up.videoUrl, 'static/videos/a.mp4', '原视频不被覆盖')
  assert.match(up.upscaledVideoUrl!, /^static\/upscaled\/.+\.mp4$/)
  assert.equal(up.upscaleSourceVideo, 'static/videos/a.mp4')
  assert.equal(up.upscaleTarget, '1080p')
  assert.equal(up.upscaleSourceSize, '320x180')
  assert.equal(up.upscaleSize, '1920x1080')
  const info = await probeVideo(path.join(root, up.upscaledVideoUrl!))
  assert.deepEqual([info.width, info.height, info.hasAudio], [1920, 1080, true])
  assert.ok(isUpscaleCurrent(up))
  assert.equal(effectiveShotVideo(up), up.upscaledVideoUrl)

  // 字幕文本仍有效；字幕版自动用原 SRT 重新压到增强版上（来源仍是手动上传）
  const sub1 = await waitFor(a, sb => subtitleSettled(sb) && sb.subtitledBaseVideo === up.upscaledVideoUrl)
  assert.equal(sub1.subtitleStatus, 'completed', sub1.subtitleError || '')
  assert.equal(sub1.subtitleUrl, srtBefore)
  assert.equal(sub1.subtitleOrigin, 'upload')
  assert.ok(isSubtitleCurrent(sub1) && isSubtitledVideoCurrent(sub1))
  const burned = await probeVideo(path.join(root, sub1.subtitledVideoUrl!))
  assert.deepEqual([burned.width, burned.height], [1920, 1080])

  // 无音轨视频也能增强
  const rb = await post(upscaleRoutes, `/storyboards/${b}`, { target: '1440p' })
  assert.equal(rb.status, 200, JSON.stringify(rb.body))
  const upB = await waitFor(b, upscaleSettled)
  assert.equal(upB.upscaleStatus, 'completed', upB.upscaleError || '')
  const infoB = await probeVideo(path.join(root, upB.upscaledVideoUrl!))
  assert.deepEqual([infoB.width, infoB.height, infoB.hasAudio], [2560, 1440, false])

  // 拼接：带字幕时 a 用压在增强版上的字幕版，b 用增强版；不带字幕时都用增强版
  const m1 = await mergeEpisodeVideos(1, 1, [a, b])
  const [merge1] = await db.select().from(schema.videoMerges).where(eq(schema.videoMerges.id, m1))
  assert.deepEqual(JSON.parse(merge1.scenes!), [sub1.subtitledVideoUrl, upB.upscaledVideoUrl])
  const m2 = await mergeEpisodeVideos(1, 1, [a, b], false)
  const [merge2] = await db.select().from(schema.videoMerges).where(eq(schema.videoMerges.id, m2))
  assert.deepEqual(JSON.parse(merge2.scenes!), [up.upscaledVideoUrl, upB.upscaledVideoUrl])
  // 整集字幕时长照常（增强不改时长）
  assert.match(await buildEpisodeSrt(1), /00:00:00,200 --> 00:00:01,500/)

  // 批量「全部增强」：同规格已有有效结果的跳过
  const batch = await post(upscaleRoutes, '/episodes/1', { target: '1080p' })
  assert.equal(batch.status, 200)
  assert.deepEqual(batch.body.data.storyboard_ids, [b]) // b 是 1440p，换 1080p 规格要重做
  assert.equal(batch.body.data.already_done, 1)
  await waitFor(b, upscaleSettled)

  // 清除增强：生效视频回到原视频，字幕版自动改回压在原视频上
  const del = await upscaleRoutes.request(`/storyboards/${a}`, { method: 'DELETE' })
  assert.equal(del.status, 200)
  const cleared = await waitFor(a, sb => subtitleSettled(sb) && sb.subtitledBaseVideo === 'static/videos/a.mp4')
  assert.equal(cleared.upscaledVideoUrl, null)
  assert.equal(effectiveShotVideo(cleared), 'static/videos/a.mp4')
  assert.ok(isSubtitledVideoCurrent(cleared))
  assert.equal(cleared.subtitleUrl, srtBefore)

  // 再增强一次，然后原视频重新生成：增强结果和字幕都作废，生效视频是新原视频
  await post(upscaleRoutes, `/storyboards/${a}`, {})
  await waitFor(a, upscaleSettled)
  await waitFor(a, sb => subtitleSettled(sb) && needsSubtitleReburn(sb) === false)
  await db.update(schema.storyboards).set({ videoUrl: 'static/videos/a2.mp4' }).where(eq(schema.storyboards.id, a))
  const regen = await row(a)
  assert.equal(isUpscaleCurrent(regen), false)
  assert.equal(effectiveShotVideo(regen), 'static/videos/a2.mp4')
  assert.equal(isSubtitleCurrent(regen), false)
  assert.equal(isSubtitledVideoCurrent(regen), false)
  assert.equal(needsSubtitleReburn(regen), false, '字幕文本已过期，不能自动重新压制')
  const m3 = await mergeEpisodeVideos(1, 1, [a])
  const [merge3] = await db.select().from(schema.videoMerges).where(eq(schema.videoMerges.id, m3))
  assert.deepEqual(JSON.parse(merge3.scenes!), ['static/videos/a2.mp4'])

  for (let i = 0; i < 150; i++) {
    const rows = await db.select().from(schema.videoMerges)
    if (rows.every(x => x.status !== 'processing')) break
    await new Promise(r => setTimeout(r, 200))
  }
})

test('校验：目标规格、已达到目标分辨率、没有视频、处理中清除', async () => {
  makeVideo('static/videos/hd.mp4', '1920x1080')
  makeVideo('static/videos/c.mp4', '320x180')
  const hd = await storyboard(2, 1, 'static/videos/hd.mp4')
  const c = await storyboard(2, 2, 'static/videos/c.mp4')
  const none = await db.insert(schema.storyboards).values({ episodeId: 2, storyboardNumber: 3, createdAt: ts, updatedAt: ts })

  const bad = await post(upscaleRoutes, `/storyboards/${c}`, { target: '8k' })
  assert.equal(bad.status, 400)
  assert.match(bad.body.message, /1080p \/ 1440p \/ 2160p/)

  const high = await post(upscaleRoutes, `/storyboards/${hd}`, { target: '1080p' })
  assert.equal(high.status, 400)
  assert.match(high.body.message, /1920x1080.*无需增强/)
  assert.equal((await row(hd)).upscaleStatus, null, '被跳过的镜头状态不变')

  const noVideo = await post(upscaleRoutes, `/storyboards/${Number(none.lastInsertRowid)}`, {})
  assert.equal(noVideo.status, 400)
  assert.match(noVideo.body.message, /还没有视频/)

  // 批量：高清镜头带原因跳过，其余入队
  const batch = await post(upscaleRoutes, '/episodes/2', { target: '1080p' })
  assert.equal(batch.status, 200)
  assert.deepEqual(batch.body.data.storyboard_ids, [c])
  assert.deepEqual(batch.body.data.skipped.map((s: any) => [s.storyboard_id, s.reason]), [[hd, 'already_high']])
  // 处理中不能清除，也不能重复入队
  await assert.rejects(clearUpscale(c), /正在增强中/)
  const again = await enqueueUpscale([c], '1080p')
  assert.deepEqual(again.skipped.map(s => s.reason), ['queued'])
  const done = await waitFor(c, upscaleSettled)
  assert.equal(done.upscaleStatus, 'completed', done.upscaleError || '')
  assert.ok(existsSync(path.join(root, done.upscaledVideoUrl!)))
})
