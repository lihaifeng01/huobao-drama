/**
 * 画质增强（超分）— 第一期只有 FFmpeg 引擎：lanczos 插值放大 + 轻度锐化，本地处理，不计费。
 *
 * 结果单独存在 upscaled_video_url，不覆盖原视频 video_url；有效性与「生效视频」的规则见 shot-video.ts。
 * upscale_status 只表示最近一次操作（processing / completed / failed）：重新增强失败时，
 * 之前的增强结果仍然保留、仍然生效（界面上同时显示失败原因）。
 * 增强结果变化（完成 / 清除）后，字幕仍有效的镜头会自动用现有 SRT 重新压制到新的生效视频上。
 */
import fs from 'fs'
import path from 'path'
import { v4 as uuid } from 'uuid'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { getAbsolutePath } from '../utils/storage.js'
import { STORAGE_ROOT } from '../utils/paths.js'
import { checkFfmpegSuite, ffmpegPath } from '../utils/ffmpeg.js'
import { extractVideoPoster } from '../utils/video-poster.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { enqueueSubtitleReburn, probeVideo, runFfmpeg } from './subtitle.js'

const LABEL = 'UpscaleTask'

/** 目标规格 → 画面短边像素（横屏是高、竖屏是宽） */
export const UPSCALE_TARGETS = { '1080p': 1080, '1440p': 1440, '2160p': 2160 } as const
export type UpscaleTarget = keyof typeof UPSCALE_TARGETS
export const DEFAULT_UPSCALE_TARGET: UpscaleTarget = '1080p'

export function isUpscaleTarget(value: unknown): value is UpscaleTarget {
  return typeof value === 'string' && value in UPSCALE_TARGETS
}

export class UpscaleError extends Error {}

/** 按目标短边等比放大，宽高取偶数（libx264 / yuv420p 要求） */
export function upscaleDimensions(width: number, height: number, target: UpscaleTarget) {
  const short = Math.min(width, height)
  const scale = UPSCALE_TARGETS[target] / short
  const even = (n: number) => Math.max(2, Math.round(n * scale / 2) * 2)
  return { width: even(width), height: even(height) }
}

async function ensureFfmpeg() {
  const suite = await checkFfmpegSuite()
  if (!suite.ffmpeg || !suite.ffprobe || !ffmpegPath) {
    throw new UpscaleError('本机 ffmpeg 不可用，无法做画质增强。请删除 node_modules 后在本机重新 npm install，或设置 FFMPEG_BIN / FFPROBE_BIN 指向有效的可执行文件后重启服务')
  }
}

// ---------- 队列：放大与重新编码很吃 CPU，同时只处理一个镜头 ----------

const queue: { id: number; target: UpscaleTarget }[] = []
const queued = new Set<number>()
let running = false

export type UpscaleSkipReason = 'no_video' | 'queued' | 'missing_file' | 'already_high'
export interface UpscaleEnqueueResult {
  accepted: number[]
  skipped: { id: number; reason: UpscaleSkipReason; message: string }[]
}

/**
 * 把镜头加入画质增强队列。入队前同步检查：没有视频、正在处理、视频文件丢失、
 * 原视频短边已达到目标（放大没有意义）的跳过，并给出原因。
 */
export async function enqueueUpscale(storyboardIds: number[], target: UpscaleTarget): Promise<UpscaleEnqueueResult> {
  await ensureFfmpeg()
  const result: UpscaleEnqueueResult = { accepted: [], skipped: [] }
  for (const id of storyboardIds) {
    const skip = (reason: UpscaleSkipReason, message: string) => { result.skipped.push({ id, reason, message }) }
    if (queued.has(id)) { skip('queued', '该镜头正在增强中'); continue }
    const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id))
    if (!sb?.videoUrl || sb.deletedAt) { skip('no_video', '该镜头还没有视频，请先生成视频'); continue }
    const abs = getAbsolutePath(sb.videoUrl)
    if (!fs.existsSync(abs)) { skip('missing_file', '镜头视频文件已丢失（本地文件不存在），请重新生成视频'); continue }
    const info = await probeVideo(abs).catch(() => null)
    if (!info?.width || !info.height) { skip('missing_file', '无法读取镜头视频的分辨率'); continue }
    if (Math.min(info.width, info.height) >= UPSCALE_TARGETS[target]) {
      skip('already_high', `原视频已是 ${info.width}x${info.height}，不低于 ${target}，无需增强`)
      continue
    }
    queued.add(id)
    queue.push({ id, target })
    result.accepted.push(id)
    await db.update(schema.storyboards)
      .set({ upscaleStatus: 'processing', upscaleError: null, upscaleTarget: target, updatedAt: now() })
      .where(eq(schema.storyboards.id, id))
  }
  pump()
  return result
}

function pump() {
  if (running || !queue.length) return
  const { id, target } = queue.shift()!
  running = true
  processStoryboard(id, target)
    .catch(async (err: Error) => {
      logTaskError(LABEL, 'upscale', { storyboardId: id, error: err.message })
      await db.update(schema.storyboards)
        .set({ upscaleStatus: 'failed', upscaleError: err.message, updatedAt: now() })
        .where(eq(schema.storyboards.id, id))
    })
    .finally(() => {
      running = false
      queued.delete(id)
      pump()
    })
}

/** 服务重启时进行中的任务已丢失，标记为失败让用户重试（之前的增强结果保留） */
export async function resetInterruptedUpscales() {
  await db.update(schema.storyboards)
    .set({ upscaleStatus: 'failed', upscaleError: '服务重启，画质增强已中断，请重新增强' })
    .where(eq(schema.storyboards.upscaleStatus, 'processing'))
}

/** FFmpeg：lanczos 放大 + 轻度锐化（unsharp 只作用于亮度），音轨原样复制 */
export function upscaleArgs(inputAbs: string, outputAbs: string, width: number, height: number, hasAudio: boolean) {
  return [
    '-y', '-i', inputAbs,
    '-vf', `scale=${width}:${height}:flags=lanczos,unsharp=5:5:0.6:5:5:0.0,setsar=1`,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
    ...(hasAudio ? ['-c:a', 'copy'] : ['-an']),
    '-movflags', '+faststart',
    outputAbs,
  ]
}

async function processStoryboard(id: number, target: UpscaleTarget) {
  const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id))
  if (!sb?.videoUrl) throw new Error('镜头还没有视频')
  const sourceVideo = sb.videoUrl
  const inputAbs = getAbsolutePath(sourceVideo)
  if (!fs.existsSync(inputAbs)) throw new Error('镜头视频文件已丢失（本地文件不存在），请重新生成视频')

  const info = await probeVideo(inputAbs)
  const size = upscaleDimensions(info.width, info.height, target)
  logTaskStart(LABEL, 'upscale', { storyboardId: id, target, from: `${info.width}x${info.height}`, to: `${size.width}x${size.height}` })

  const dir = path.join(STORAGE_ROOT, 'upscaled')
  fs.mkdirSync(dir, { recursive: true })
  const name = `${uuid()}.mp4`
  await runFfmpeg(upscaleArgs(inputAbs, path.join(dir, name), size.width, size.height, info.hasAudio))
  const upscaledVideoUrl = `static/upscaled/${name}`
  await extractVideoPoster(upscaledVideoUrl)

  // 处理期间原视频被重新生成了：结果对应的是旧视频，不写回，避免把过期结果当成有效
  const [latest] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id))
  if (latest?.videoUrl !== sourceVideo) throw new Error('增强期间镜头视频已重新生成，结果已作废，请重新增强')

  await db.update(schema.storyboards).set({
    upscaledVideoUrl,
    upscaleStatus: 'completed',
    upscaleError: null,
    upscaleSourceVideo: sourceVideo,
    upscaleTarget: target,
    upscaleSize: `${size.width}x${size.height}`,
    upscaleSourceSize: `${info.width}x${info.height}`,
    updatedAt: now(),
  }).where(eq(schema.storyboards.id, id))
  logTaskSuccess(LABEL, 'upscale', { storyboardId: id, upscaledVideoUrl })

  // 生效视频换成了增强版：已有字幕自动重新压制到增强版上
  await enqueueSubtitleReburn([id]).catch((err: Error) => logTaskError(LABEL, 'reburn', { storyboardId: id, error: err.message }))
}

/** 清除增强结果（文件保留，只解除关联），生效视频回到原视频；正在增强时不允许清除 */
export async function clearUpscale(id: number) {
  if (queued.has(id)) throw new UpscaleError('该镜头正在增强中，请等处理结束后再清除')
  await db.update(schema.storyboards).set({
    upscaledVideoUrl: null, upscaleStatus: null, upscaleError: null, upscaleSourceVideo: null,
    upscaleTarget: null, upscaleSize: null, upscaleSourceSize: null, updatedAt: now(),
  }).where(eq(schema.storyboards.id, id))
  // 字幕版若压在增强版上，改回压在原视频上
  await enqueueSubtitleReburn([id]).catch((err: Error) => logTaskError(LABEL, 'reburn', { storyboardId: id, error: err.message }))
}
