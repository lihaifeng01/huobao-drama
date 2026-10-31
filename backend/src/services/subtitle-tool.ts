/**
 * 字幕工具 — 独立于剧集工作流：上传本地视频 → 自动识别或上传字幕文件 → 按自定义字号/位置压制
 *
 * 一个任务对应一个视频，文件都放在 static/tool-subtitles/。
 * status 只表示正在进行的操作（idle / transcribing / burning）；有无字幕、成品看 subtitle_url / output_url。
 */
import fs from 'fs'
import path from 'path'
import { v4 as uuid } from 'uuid'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { getAbsolutePath } from '../utils/storage.js'
import { extractVideoPoster } from '../utils/video-poster.js'
import { cuesToSrt, decodeSubtitleFile, parseSrt } from '../utils/srt.js'
import { cuesToAss, defaultSubtitleStyle, normalizeSubtitleStyle, type SubtitleStyle } from '../utils/ass.js'
import { toSnakeCase } from '../utils/transform.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import {
  ensureFfmpeg, getSubtitleConfig, runFfmpeg, subtitleFont, transcribeVideoCues, type SubtitleSelection,
} from './subtitle.js'
import { ToolError, extOf, saveToolVideo, toolDir } from './tool-media.js'

export { ToolError }

type Job = typeof schema.subtitleToolJobs.$inferSelect

const LABEL = 'SubtitleTool'
const SUB_DIR = 'tool-subtitles'
const SUBTITLE_EXT = new Set(['.srt', '.vtt'])
const SUBTITLE_MAX_BYTES = 5 * 1024 * 1024

function storageDir() {
  return toolDir(SUB_DIR)
}

function jobStyle(job: Job): SubtitleStyle {
  let raw: any = null
  try { raw = job.style ? JSON.parse(job.style) : null } catch { /* 损坏时用默认 */ }
  return normalizeSubtitleStyle(raw, job.width || 1920, job.height || 1080)
}

/** 接口返回：字段转蛇形，style 解析为对象并附带该分辨率下的默认样式 */
export function serializeJob(job: Job) {
  const def = defaultSubtitleStyle(job.width || 1920, job.height || 1080)
  const style = jobStyle(job)
  return {
    ...toSnakeCase(job),
    style: { font_size: style.fontSize, bottom_percent: style.bottomPercent },
    default_style: { font_size: def.fontSize, bottom_percent: def.bottomPercent },
  }
}

/** userId 给出时只认该用户的任务（按用户隔离；别人的任务一律视为不存在） */
export async function getJob(id: number, userId?: number): Promise<Job> {
  const [job] = await db.select().from(schema.subtitleToolJobs)
    .where(and(eq(schema.subtitleToolJobs.id, id), isNull(schema.subtitleToolJobs.deletedAt)))
  if (!job || (userId !== undefined && job.userId !== userId)) throw new ToolError('任务不存在')
  return job
}

export async function listJobs(userId?: number): Promise<Job[]> {
  return db.select().from(schema.subtitleToolJobs)
    .where(and(isNull(schema.subtitleToolJobs.deletedAt), userId !== undefined ? eq(schema.subtitleToolJobs.userId, userId) : undefined))
    .orderBy(desc(schema.subtitleToolJobs.id))
    .limit(100)
}

async function update(id: number, values: Partial<Job>) {
  await db.update(schema.subtitleToolJobs).set({ ...values, updatedAt: now() }).where(eq(schema.subtitleToolJobs.id, id))
}

/** 上传视频建任务 */
export async function createJob(file: File, userId?: number): Promise<Job> {
  const video = await saveToolVideo(file, SUB_DIR)
  const ts = now()
  const res = await db.insert(schema.subtitleToolJobs).values({
    userId: userId ?? null,
    name: path.basename(file.name).slice(0, 200) || path.basename(video.url),
    videoUrl: video.url,
    width: video.width,
    height: video.height,
    duration: video.duration,
    hasAudio: video.hasAudio,
    status: 'idle',
    createdAt: ts,
    updatedAt: ts,
  })
  return getJob(getInsertId(res))
}

function assertIdle(job: Job) {
  if (job.status === 'transcribing') throw new ToolError('正在识别字幕，请稍候')
  if (job.status === 'burning') throw new ToolError('正在合成视频，请稍候')
}

function writeSrt(cues: Parameters<typeof cuesToSrt>[0]) {
  const name = `${uuid()}.srt`
  fs.writeFileSync(path.join(storageDir(), name), cuesToSrt(cues), 'utf-8')
  return `static/${SUB_DIR}/${name}`
}

/** 自动识别字幕（异步）；sel 为所选字幕配置与模型，缺省走默认 */
export async function startTranscribe(id: number, sel: SubtitleSelection = {}) {
  const job = await getJob(id)
  assertIdle(job)
  if (!job.hasAudio) throw new ToolError('视频没有音轨，无法识别字幕，可以手动上传字幕文件')
  await ensureFfmpeg()
  const config = await getSubtitleConfig(sel)
  await update(id, { status: 'transcribing', errorMsg: null })
  logTaskStart(LABEL, 'transcribe', { jobId: id, configId: config.id, model: config.model })

  ;(async () => {
    const portrait = (job.height || 0) > (job.width || 0)
    const cues = await transcribeVideoCues(getAbsolutePath(job.videoUrl), config, portrait, LABEL, {
      userId: job.userId ?? null, dramaId: null, refType: 'subtitle_tool_job', refId: id, source: 'tool_subtitle', duration: job.duration || 0,
    })
    if (!cues.length) throw new Error('未识别到语音，可以手动上传字幕文件')
    // 字幕变了，旧成品不再对应，需重新合成
    await update(id, { status: 'idle', subtitleUrl: writeSrt(cues), subtitleSource: 'asr', outputUrl: null })
    logTaskSuccess(LABEL, 'transcribe', { jobId: id, cues: cues.length })
  })().catch(async (err: Error) => {
    logTaskError(LABEL, 'transcribe', { jobId: id, error: err.message })
    await update(id, { status: 'idle', errorMsg: err.message })
  })
}

/** 手动上传字幕文件（SRT / WebVTT，UTF-8 或 GBK），统一转存为 UTF-8 SRT */
export async function uploadSubtitle(id: number, file: File) {
  const job = await getJob(id)
  assertIdle(job)
  if (!SUBTITLE_EXT.has(extOf(file.name))) throw new ToolError('仅支持 .srt / .vtt 字幕文件')
  if (file.size > SUBTITLE_MAX_BYTES) throw new ToolError('字幕文件不能超过 5MB')
  const cues = parseSrt(decodeSubtitleFile(Buffer.from(await file.arrayBuffer())))
  if (!cues.length) throw new ToolError('字幕文件里没有可识别的字幕条目，请检查格式')
  await update(id, { subtitleUrl: writeSrt(cues), subtitleSource: 'upload', outputUrl: null, errorMsg: null })
  return getJob(id)
}

/** 按字号/位置压制字幕（异步）。样式先保存，失败也保留，方便调整后重试 */
export async function startBurn(id: number, styleInput: any) {
  const job = await getJob(id)
  assertIdle(job)
  if (!job.subtitleUrl) throw new ToolError('还没有字幕，请先自动识别或上传字幕文件')
  await ensureFfmpeg()
  const width = job.width || 1920
  const height = job.height || 1080
  const style = normalizeSubtitleStyle(styleInput, width, height)
  await update(id, {
    status: 'burning',
    errorMsg: null,
    style: JSON.stringify({ font_size: style.fontSize, bottom_percent: style.bottomPercent }),
  })
  logTaskStart(LABEL, 'burn', { jobId: id, ...style })

  ;(async () => {
    const dir = storageDir()
    const cues = parseSrt(fs.readFileSync(getAbsolutePath(job.subtitleUrl!), 'utf-8'))
    const assName = `${uuid()}.ass`
    fs.writeFileSync(path.join(dir, assName), cuesToAss(cues, { width, height, fontName: subtitleFont(), style }), 'utf-8')
    const outName = `${uuid()}.mp4`
    try {
      // 文件名以 cwd 相对路径传入滤镜，避开 Windows 盘符冒号的转义问题
      await runFfmpeg([
        '-y', '-i', getAbsolutePath(job.videoUrl),
        '-vf', `ass=${assName}`,
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '192k',
        '-movflags', '+faststart',
        outName,
      ], dir)
    } finally {
      fs.rmSync(path.join(dir, assName), { force: true })
    }
    const outputUrl = `static/${SUB_DIR}/${outName}`
    await extractVideoPoster(outputUrl)
    await update(id, { status: 'idle', outputUrl })
    logTaskSuccess(LABEL, 'burn', { jobId: id, outputUrl })
  })().catch(async (err: Error) => {
    logTaskError(LABEL, 'burn', { jobId: id, error: err.message })
    await update(id, { status: 'idle', errorMsg: err.message })
  })
}

export async function deleteJob(id: number) {
  await update(id, { deletedAt: now() })
}

/** 服务重启时进行中的操作已丢失，复位并提示重试 */
export async function resetInterruptedToolJobs() {
  await db.update(schema.subtitleToolJobs)
    .set({ status: 'idle', errorMsg: '服务重启，操作已中断，请重试' })
    .where(inArray(schema.subtitleToolJobs.status, ['transcribing', 'burning']))
}
