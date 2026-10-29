import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

// Isolated DB/storage; never read or modify user data.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-merge-tool-'))
process.env.SQLITE_PATH = path.join(root, 'merge.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
await import('../src/db/index.ts')
const { ffmpegPath } = await import('../src/utils/ffmpeg.ts')
const { probeVideo } = await import('../src/services/subtitle.ts')
const { buildMergeArgs } = await import('../src/services/merge-tool.ts')
const tools = (await import('../src/routes/tools.ts')).default

const call = async (method: string, url: string, body?: any) => {
  const init: RequestInit = { method }
  if (body instanceof FormData) init.body = body
  else if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { 'Content-Type': 'application/json' } }
  const res = await tools.request(url, init)
  return { status: res.status, json: await res.json() as any }
}
const form = (name: string, content: Buffer) => {
  const fd = new FormData()
  fd.append('file', new Blob([content]), name)
  return fd
}
function makeVideo(name: string, size: string, dur: number, rate: number, withAudio: boolean) {
  const out = path.join(root, name)
  const args = ['-y', '-f', 'lavfi', '-i', `color=size=${size}:rate=${rate}:color=gray:duration=${dur}`]
  if (withAudio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${dur}`, '-shortest', '-c:a', 'aac')
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', out)
  const r = spawnSync(ffmpegPath!, args)
  assert.equal(r.status, 0, r.stderr?.toString())
  return fs.readFile(out)
}

test('合成参数：统一尺寸与帧率，无音轨补静音，音轨按画面时长补齐', () => {
  const args = buildMergeArgs([
    { abs: '/a.mp4', duration: 2, hasAudio: true },
    { abs: '/b.mp4', duration: 1.5, hasAudio: false },
  ], 1280, 720, 'out.mp4')
  assert.deepEqual(args.slice(0, 5), ['-y', '-i', '/a.mp4', '-i', '/b.mp4'])
  assert.deepEqual(args.slice(5, 11), ['-f', 'lavfi', '-t', '1.500', '-i', 'anullsrc=r=48000:cl=stereo'])
  const filter = args[args.indexOf('-filter_complex') + 1]
  assert.match(filter, /\[0:v\]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720/)
  assert.match(filter, /\[2:a\]aresample=48000.*atrim=duration=1\.500.*\[a1\]/)
  assert.match(filter, /\[v0\]\[a0\]\[v1\]\[a1\]concat=n=2:v=1:a=1\[v\]\[a\]$/)
})

test('视频合成：上传多个不同规格的片段，按指定顺序合成', async () => {
  const landscape = await call('POST', '/merge-clips', form('横屏.mp4', await makeVideo('l.mp4', '1280x720', 2, 30, true)))
  const portrait = await call('POST', '/merge-clips', form('竖屏无声.mp4', await makeVideo('p.mp4', '720x1280', 1.5, 25, false)))
  const small = await call('POST', '/merge-clips', form('4比3.mp4', await makeVideo('s.mp4', '640x480', 1, 24, true)))
  assert.equal(landscape.status, 200, JSON.stringify(landscape.json))
  assert.equal(portrait.json.data.has_audio, false)
  assert.equal(small.json.data.width, 640)

  assert.match((await call('POST', '/merge-jobs', { clips: [landscape.json.data] })).json.message, /至少需要两个/)
  assert.match((await call('POST', '/merge-jobs', { clips: [landscape.json.data, { url: 'static/uploads/x.mp4' }] })).json.message, /地址无效/)
  assert.match((await call('POST', '/merge-jobs', { clips: [landscape.json.data, { url: 'static/tool-merge/../../t.sqlite3' }] })).json.message, /地址无效/)

  // 顺序：4:3 → 竖屏无声 → 横屏；输出尺寸缺省取第一个片段
  const order = [small.json.data, portrait.json.data, landscape.json.data].map(c => ({ url: c.url, name: c.name }))
  const started = await call('POST', '/merge-jobs', { clips: order })
  assert.equal(started.status, 200, JSON.stringify(started.json))
  assert.equal(started.json.data.status, 'merging')
  assert.deepEqual(started.json.data.clips.map((c: any) => c.name), ['4比3.mp4', '竖屏无声.mp4', '横屏.mp4'])
  assert.equal(started.json.data.width, 640)

  let job: any
  for (let i = 0; i < 200; i++) {
    job = (await call('GET', `/merge-jobs/${started.json.data.id}`)).json.data
    if (job.status !== 'merging') break
    await new Promise(r => setTimeout(r, 100))
  }
  assert.equal(job.status, 'done', job.error_msg || '')
  const out = await probeVideo(path.join(root, job.output_url))
  assert.equal(out.width, 640)
  assert.equal(out.height, 480)
  assert.equal(out.hasAudio, true)
  assert.ok(Math.abs(out.duration - 4.5) < 0.3, `duration ${out.duration}`)

  // 指定输出尺寸（奇数会取偶）
  const sized = await call('POST', '/merge-jobs', { clips: order.slice(0, 2), width: 1081, height: 1920 })
  assert.equal(sized.json.data.width, 1082)
  for (let i = 0; i < 200; i++) {
    job = (await call('GET', `/merge-jobs/${sized.json.data.id}`)).json.data
    if (job.status !== 'merging') break
    await new Promise(r => setTimeout(r, 100))
  }
  assert.equal(job.status, 'done', job.error_msg || '')

  assert.equal((await call('GET', '/merge-jobs')).json.data.length, 2)
  assert.equal((await call('DELETE', `/merge-jobs/${started.json.data.id}`)).status, 200)
  assert.equal((await call('GET', '/merge-jobs')).json.data.length, 1)
})

test.after(async () => { await fs.rm(root, { recursive: true, force: true }) })
