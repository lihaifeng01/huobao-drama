/**
 * 视频合成工具 — 上传多个视频，按指定顺序拼成一个
 *
 * 片段的分辨率、帧率、有无音轨可能各不相同，concat demuxer 直接拼会花屏或音画错位，
 * 所以用 concat 滤镜：每段先缩放并补黑边到统一尺寸、统一 30fps；没音轨的补静音，
 * 音轨长短不一的补齐/截断到画面时长，避免越拼越不同步。
 */
import fs from 'fs'
import path from 'path'
import { v4 as uuid } from 'uuid'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { getAbsolutePath } from '../utils/storage.js'
import { extractVideoPoster } from '../utils/video-poster.js'
import { toSnakeCase } from '../utils/transform.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { ensureFfmpeg, probeVideo, runFfmpeg } from './subtitle.js'
import { ToolError, saveToolVideo, toolDir, type ToolVideo } from './tool-media.js'

type Job = typeof schema.mergeToolJobs.$inferSelect

const LABEL = 'MergeTool'
const SUB_DIR = 'tool-merge'
const MAX_CLIPS = 50
const FPS = 30

export interface MergeClip {
  url: string
  name: string
  width: number
  height: number
  duration: number
  has_audio: boolean
}

/** 上传一个片段（未合成前只是文件，不建记录） */
export async function uploadClip(file: File): Promise<MergeClip> {
  const v = await saveToolVideo(file, SUB_DIR)
  return toClip(v, path.basename(file.name).slice(0, 200))
}

function toClip(v: ToolVideo, name: string): MergeClip {
  return { url: v.url, name, width: v.width, height: v.height, duration: v.duration, has_audio: v.hasAudio }
}

export function serializeJob(job: Job) {
  let clips: MergeClip[] = []
  try { clips = JSON.parse(job.clips) } catch { /* 损坏时返回空列表 */ }
  return { ...toSnakeCase(job), clips }
}

export async function listJobs() {
  return db.select().from(schema.mergeToolJobs)
    .where(isNull(schema.mergeToolJobs.deletedAt))
    .orderBy(desc(schema.mergeToolJobs.id))
    .limit(100)
}

export async function getJob(id: number): Promise<Job> {
  const [job] = await db.select().from(schema.mergeToolJobs)
    .where(and(eq(schema.mergeToolJobs.id, id), isNull(schema.mergeToolJobs.deletedAt)))
  if (!job) throw new ToolError('任务不存在')
  return job
}

/** libx264 + yuv420p 要求宽高为偶数 */
function even(n: number) {
  return Math.max(2, Math.round(n / 2) * 2)
}

/** 拼 ffmpeg 参数（纯函数，便于测试）：视频输入在前，补静音的 anullsrc 输入在后 */
export function buildMergeArgs(clips: { abs: string; duration: number; hasAudio: boolean }[], width: number, height: number, outPath: string) {
  const args: string[] = ['-y']
  for (const c of clips) args.push('-i', c.abs)
  const silentIndex = new Map<number, number>()
  clips.forEach((c, i) => {
    if (c.hasAudio) return
    silentIndex.set(i, clips.length + silentIndex.size)
    args.push('-f', 'lavfi', '-t', c.duration.toFixed(3), '-i', 'anullsrc=r=48000:cl=stereo')
  })
  const parts: string[] = []
  const pairs: string[] = []
  clips.forEach((c, i) => {
    parts.push(`[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${FPS},format=yuv420p[v${i}]`)
    const audioIn = c.hasAudio ? `${i}:a` : `${silentIndex.get(i)}:a`
    parts.push(`[${audioIn}]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${c.duration.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`)
    pairs.push(`[v${i}][a${i}]`)
  })
  parts.push(`${pairs.join('')}concat=n=${clips.length}:v=1:a=1[v][a]`)
  args.push(
    '-filter_complex', parts.join(';'),
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    outPath,
  )
  return args
}

/**
 * 开始合成（异步）。clips 为按顺序排好的片段（只认本工具上传目录下的文件）；
 * size 缺省用第一个片段的分辨率。
 */
export async function startMerge(input: { clips: { url: string; name?: string }[]; width?: number; height?: number; name?: string }) {
  const list = Array.isArray(input.clips) ? input.clips : []
  if (list.length < 2) throw new ToolError('至少需要两个视频才能合成')
  if (list.length > MAX_CLIPS) throw new ToolError(`一次最多合成 ${MAX_CLIPS} 个视频`)
  await ensureFfmpeg()

  // 不信任前端传来的画面信息，逐个重新读取；路径限定在工具目录内，防止拼接任意文件
  const clips: (MergeClip & { abs: string })[] = []
  for (const item of list) {
    const url = String(item?.url || '').replace(/^\/+/, '')
    if (!url.startsWith(`static/${SUB_DIR}/`) || url.includes('..')) throw new ToolError('片段地址无效，请重新上传')
    const abs = getAbsolutePath(url)
    if (!fs.existsSync(abs)) throw new ToolError(`片段「${item?.name || url}」的文件已丢失，请重新上传`)
    const info = await probeVideo(abs).catch(() => null)
    if (!info?.width) throw new ToolError(`无法读取片段「${item?.name || url}」`)
    clips.push({ ...toClip({ url, ...info }, String(item?.name || path.basename(url)).slice(0, 200)), abs })
  }

  const width = even(Number(input.width) || clips[0].width)
  const height = even(Number(input.height) || clips[0].height)
  if (width > 4096 || height > 4096) throw new ToolError('输出分辨率不能超过 4096')
  const duration = clips.reduce((n, c) => n + c.duration, 0)
  const ts = now()
  const res = await db.insert(schema.mergeToolJobs).values({
    name: String(input.name || '').trim().slice(0, 200) || `${clips[0].name.replace(/\.[^.]+$/, '')} 等 ${clips.length} 个视频`,
    clips: JSON.stringify(clips.map(({ abs: _abs, ...c }) => c)),
    width,
    height,
    duration,
    status: 'merging',
    createdAt: ts,
    updatedAt: ts,
  })
  const id = getInsertId(res)
  logTaskStart(LABEL, 'merge', { jobId: id, clips: clips.length, width, height })

  ;(async () => {
    const outName = `${uuid()}.mp4`
    await runFfmpeg(buildMergeArgs(clips.map(c => ({ abs: c.abs, duration: c.duration, hasAudio: c.has_audio })), width, height, outName), toolDir(SUB_DIR))
    const outputUrl = `static/${SUB_DIR}/${outName}`
    await extractVideoPoster(outputUrl)
    const real = await probeVideo(getAbsolutePath(outputUrl)).catch(() => null)
    await db.update(schema.mergeToolJobs)
      .set({ status: 'done', outputUrl, duration: real?.duration || duration, updatedAt: now() })
      .where(eq(schema.mergeToolJobs.id, id))
    logTaskSuccess(LABEL, 'merge', { jobId: id, outputUrl })
  })().catch(async (err: Error) => {
    logTaskError(LABEL, 'merge', { jobId: id, error: err.message })
    await db.update(schema.mergeToolJobs)
      .set({ status: 'failed', errorMsg: err.message, updatedAt: now() })
      .where(eq(schema.mergeToolJobs.id, id))
  })
  return getJob(id)
}

export async function deleteJob(id: number) {
  await getJob(id)
  await db.update(schema.mergeToolJobs).set({ deletedAt: now(), updatedAt: now() }).where(eq(schema.mergeToolJobs.id, id))
}

/** 服务重启时进行中的合成已丢失 */
export async function resetInterruptedMergeJobs() {
  await db.update(schema.mergeToolJobs)
    .set({ status: 'failed', errorMsg: '服务重启，合成已中断，请重新合成' })
    .where(eq(schema.mergeToolJobs.status, 'merging'))
}
