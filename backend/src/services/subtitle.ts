/**
 * 字幕制作 — 镜头视频抽音频 → 字幕服务识别 → 生成 SRT → FFmpeg 压制到视频
 *
 * 状态直接记在 storyboards 上：subtitle_status = processing / completed / no_speech / failed。
 * subtitle_source_video 记录生成时依据的 video_url，镜头视频重新生成后两者不一致，即视为字幕过期。
 * 字幕来源（subtitle_origin）：asr = 语音识别；upload = 用户上传 SRT / VTT，跳过识别直接压制（不需要字幕服务，没有音轨也行）。
 * 字幕版压在「生效视频」上（有画质增强版就用增强版），记录在 subtitled_base_video；有效性规则见 shot-video.ts。
 * 生效视频变化后（做了 / 清除了画质增强）用现有 SRT 自动重新压制（mode = reburn），不重新识别。
 */
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { v4 as uuid } from 'uuid'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { getAbsolutePath } from '../utils/storage.js'
import { STORAGE_ROOT } from '../utils/paths.js'
import { ffmpeg, ffmpegPath, checkFfmpegSuite } from '../utils/ffmpeg.js'
import { extractVideoPoster } from '../utils/video-poster.js'
import { cuesToSrt, decodeSubtitleFile, parseSrt, sentencesToCues, type SrtCue } from '../utils/srt.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { getActiveConfig, getConfigById, type AIConfig } from './ai.js'
import { transcribeAudioFile } from './adapters/aliyun-asr.js'
import { currentActorId } from './actor.js'
import { completeUsage, failUsage, startUsage } from './usage.js'
import { dramaOf } from './project-access.js'
import { effectiveShotVideo, isSubtitleCurrent, needsSubtitleReburn } from './shot-video.js'

export { isSubtitleCurrent }

type Storyboard = typeof schema.storyboards.$inferSelect

const LABEL = 'SubtitleTask'
const MAX_CONCURRENCY = 2

/** 工作台顶栏选择的字幕配置与模型；都不传 = 启用配置中优先级最高者的默认模型 */
export interface SubtitleSelection {
  configId?: number
  model?: string
}

export async function getSubtitleConfig(sel: SubtitleSelection = {}): Promise<AIConfig> {
  let config: AIConfig | null
  if (sel.configId) {
    const [row] = await db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, sel.configId))
    if (row?.serviceType !== 'subtitle') throw new Error('所选字幕配置不存在')
    config = await getConfigById(sel.configId)
    if (!config) throw new Error('所选字幕配置已停用或已删除，请重新选择')
  } else {
    config = await getActiveConfig('subtitle')
    if (!config) throw new Error('未配置字幕服务，请先到「设置 → AI 服务」添加并启用字幕服务')
  }
  if (sel.model) {
    const [row] = await db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, config.id!))
    const models: string[] = row?.model ? JSON.parse(row.model) : []
    if (!models.includes(sel.model)) throw new Error(`字幕配置「${row?.name || config.provider}」中没有模型 ${sel.model}`)
    config = { ...config, model: sel.model }
  }
  if (!config.apiKey) throw new Error('字幕服务未填写 API Key')
  if (!config.model) throw new Error('字幕服务未配置模型')
  return config
}

export async function ensureFfmpeg() {
  const suite = await checkFfmpegSuite()
  if (!suite.ffmpeg || !suite.ffprobe || !ffmpegPath) {
    throw new Error('本机 ffmpeg 不可用，无法制作字幕。请删除 node_modules 后在本机重新 npm install，或设置 FFMPEG_BIN / FFPROBE_BIN 指向有效的可执行文件后重启服务')
  }
}

// ---------- 并发队列：识别和压制都较重，限制同时处理的镜头数 ----------

// 入队时记下所选配置与模型，处理时按它解析（用户中途切换顶栏选择不影响已入队的镜头）
// userId 也在入队时记下：出队处理时已经不在发起请求的上下文里了（用量统计归属）
// mode：asr = 识别后压制；upload = 用手动上传的 SRT（uploadedSrt）压制；reburn = 用镜头现有的 SRT 重新压制到当前生效视频
interface QueueItem { id: number; sel: SubtitleSelection; userId: number | null; mode: 'asr' | 'upload' | 'reburn'; uploadedSrt?: string }
const queue: QueueItem[] = []
const queued = new Set<number>()
let running = 0

/** 把镜头加入字幕队列；返回实际入队的 id（没有视频或已在队列中的跳过） */
export async function enqueueSubtitles(storyboardIds: number[], sel: SubtitleSelection = {}): Promise<number[]> {
  await ensureFfmpeg()
  await getSubtitleConfig(sel)
  const accepted: number[] = []
  for (const id of storyboardIds) {
    if (queued.has(id)) continue
    const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id))
    if (!sb?.videoUrl) continue
    queued.add(id)
    queue.push({ id, sel, userId: currentActorId(), mode: 'asr' })
    accepted.push(id)
    await db.update(schema.storyboards)
      .set({ subtitleStatus: 'processing', subtitleError: null, updatedAt: now() })
      .where(eq(schema.storyboards.id, id))
  }
  pump()
  return accepted
}

export class SubtitleUploadError extends Error {}

export const SUBTITLE_UPLOAD_EXT = new Set(['.srt', '.vtt'])
export const SUBTITLE_UPLOAD_MAX_BYTES = 5 * 1024 * 1024

/**
 * 手动上传镜头字幕（SRT / WebVTT，UTF-8 / UTF-16 / GBK）：统一转存为 UTF-8 SRT 后入队压制。
 * 校验失败抛 SubtitleUploadError（路由返回 400）。返回解析出的字幕条数。
 */
export async function enqueueUploadedSubtitle(storyboardId: number, file: File): Promise<{ cues: number }> {
  const name = file.name || ''
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase() : ''
  if (!SUBTITLE_UPLOAD_EXT.has(ext)) throw new SubtitleUploadError('仅支持 .srt / .vtt 字幕文件')
  if (!file.size) throw new SubtitleUploadError('字幕文件为空')
  if (file.size > SUBTITLE_UPLOAD_MAX_BYTES) throw new SubtitleUploadError('字幕文件不能超过 5MB')
  if (queued.has(storyboardId)) throw new SubtitleUploadError('该镜头的字幕正在制作中，请等当前任务结束后再上传')

  const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  if (!sb?.videoUrl) throw new SubtitleUploadError('该镜头还没有视频，请先生成视频')
  const videoAbs = getAbsolutePath(effectiveShotVideo(sb)!)
  if (!fs.existsSync(videoAbs)) throw new SubtitleUploadError('镜头视频文件已丢失（本地文件不存在），请重新生成视频')

  const cues = parseSrt(decodeSubtitleFile(Buffer.from(await file.arrayBuffer())))
    .filter(c => c.end > c.start)
  if (!cues.length) throw new SubtitleUploadError('字幕文件里没有可识别的字幕条目，请检查格式')

  await ensureFfmpeg()
  // 时间轴整体落在视频之后，多半是传成了整集字幕或别的镜头的字幕，压出来会一句都看不到
  const { duration } = await probeVideo(videoAbs)
  if (duration > 0 && cues[0].start >= duration * 1000 && cues.every(c => c.start >= duration * 1000)) {
    throw new SubtitleUploadError(`字幕时间轴都在视频结束（${duration.toFixed(1)} 秒）之后，请确认上传的是这个镜头的字幕（时间从 0 开始）`)
  }

  const subDir = path.join(STORAGE_ROOT, 'subtitles')
  fs.mkdirSync(subDir, { recursive: true })
  const srtName = `${uuid()}.srt`
  fs.writeFileSync(path.join(subDir, srtName), cuesToSrt(cues), 'utf-8')

  queued.add(storyboardId)
  queue.push({ id: storyboardId, sel: {}, userId: currentActorId(), mode: 'upload', uploadedSrt: `static/subtitles/${srtName}` })
  await db.update(schema.storyboards)
    .set({ subtitleStatus: 'processing', subtitleError: null, updatedAt: now() })
    .where(eq(schema.storyboards.id, storyboardId))
  logTaskStart(LABEL, 'upload', { storyboardId, cues: cues.length, file: name })
  pump()
  return { cues: cues.length }
}

/**
 * 生效视频变化后，把字幕仍有效的镜头用现有 SRT 重新压制（不识别、不计费）。
 * 返回实际入队的 id；不需要重新压制或已在队列中的跳过（在队列中的会在当前任务结束后再检查一次）。
 */
export async function enqueueSubtitleReburn(storyboardIds: number[]): Promise<number[]> {
  const accepted: number[] = []
  for (const id of storyboardIds) {
    if (queued.has(id)) continue
    const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id))
    if (!sb || !needsSubtitleReburn(sb)) continue
    if (!accepted.length) await ensureFfmpeg()
    queued.add(id)
    queue.push({ id, sel: {}, userId: currentActorId(), mode: 'reburn' })
    accepted.push(id)
    await db.update(schema.storyboards)
      .set({ subtitleStatus: 'processing', subtitleError: null, updatedAt: now() })
      .where(eq(schema.storyboards.id, id))
  }
  pump()
  return accepted
}

function pump() {
  while (running < MAX_CONCURRENCY && queue.length) {
    const { id, sel, userId, mode, uploadedSrt } = queue.shift()!
    running++
    const job = mode === 'upload' ? burnUploadedSubtitle(id, uploadedSrt!)
      : mode === 'reburn' ? reburnSubtitle(id)
      : processStoryboard(id, sel, userId)
    job
      .catch(async (err: Error) => {
        logTaskError(LABEL, 'subtitle', { storyboardId: id, error: err.message })
        await db.update(schema.storyboards)
          .set({ subtitleStatus: 'failed', subtitleError: err.message, updatedAt: now() })
          .where(eq(schema.storyboards.id, id))
      })
      .finally(() => {
        running--
        queued.delete(id)
        // 处理期间生效视频又变了（例如画质增强刚好完成），按新的生效视频再压一次
        enqueueSubtitleReburn([id]).catch(() => {})
        pump()
      })
  }
}

/** 服务重启时进行中的字幕任务已丢失，标记为失败让用户重试 */
export async function resetInterruptedSubtitles() {
  await db.update(schema.storyboards)
    .set({ subtitleStatus: 'failed', subtitleError: '服务重启，字幕任务已中断，请重新生成' })
    .where(eq(schema.storyboards.subtitleStatus, 'processing'))
}

// ---------- 单个镜头处理 ----------

/** 读取镜头的原视频与生效视频（字幕文本属于原视频，字幕版压在生效视频上） */
async function loadShotVideos(id: number) {
  const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id))
  if (!sb?.videoUrl) throw new Error('镜头还没有视频')
  const sourceVideo = sb.videoUrl
  const baseVideo = effectiveShotVideo(sb)!
  const videoAbs = getAbsolutePath(sourceVideo)
  if (!fs.existsSync(videoAbs)) throw new Error('镜头视频文件已丢失（本地文件不存在），请重新生成视频')
  const baseAbs = getAbsolutePath(baseVideo)
  if (!fs.existsSync(baseAbs)) throw new Error('画质增强版视频文件已丢失，请重新增强或清除增强结果')
  return { sb, sourceVideo, videoAbs, baseVideo, baseAbs }
}

async function processStoryboard(id: number, sel: SubtitleSelection, userId: number | null) {
  const { sourceVideo, videoAbs, baseVideo, baseAbs } = await loadShotVideos(id)

  const config = await getSubtitleConfig(sel)
  logTaskStart(LABEL, 'subtitle', { storyboardId: id, configId: config.id, model: config.model })

  const info = await probeVideo(videoAbs)
  if (!info.hasAudio) {
    await finish(id, sourceVideo, baseVideo, { status: 'no_speech', error: '视频没有音轨，无法识别字幕' })
    return
  }

  const portrait = info.height > info.width
  const cues = await transcribeVideoCues(videoAbs, config, portrait, LABEL, {
    userId, dramaId: await dramaOf('storyboard', id), refType: 'storyboard_subtitle', refId: id, source: 'shot_subtitle', duration: info.duration,
  })
  if (!cues.length) {
    await finish(id, sourceVideo, baseVideo, { status: 'no_speech', error: '未识别到语音' })
    return
  }

  const subDir = path.join(STORAGE_ROOT, 'subtitles')
  fs.mkdirSync(subDir, { recursive: true })
  const srtName = `${uuid()}.srt`
  fs.writeFileSync(path.join(subDir, srtName), cuesToSrt(cues), 'utf-8')
  const subtitleUrl = `static/subtitles/${srtName}`

  const videoDir = path.join(STORAGE_ROOT, 'subtitled')
  fs.mkdirSync(videoDir, { recursive: true })
  const videoName = `${uuid()}.mp4`
  await burnSubtitles(baseAbs, path.join(subDir, srtName), path.join(videoDir, videoName), portrait)
  const subtitledVideoUrl = `static/subtitled/${videoName}`
  await extractVideoPoster(subtitledVideoUrl)

  await finish(id, sourceVideo, baseVideo, { status: 'completed', subtitleUrl, subtitledVideoUrl, origin: 'asr' })
  logTaskSuccess(LABEL, 'subtitle', { storyboardId: id, cues: cues.length, subtitleUrl, subtitledVideoUrl })
}

/** 把一份 SRT 按工作流固定样式压到镜头当前的生效视频上 */
async function burnSrtOnShot(id: number, subtitleUrl: string, origin: 'asr' | 'upload') {
  const { sourceVideo, baseVideo, baseAbs } = await loadShotVideos(id)
  const srtAbs = getAbsolutePath(subtitleUrl)
  if (!fs.existsSync(srtAbs)) throw new Error('字幕文件已丢失，请重新生成或重新上传字幕')

  const info = await probeVideo(baseAbs)
  const videoDir = path.join(STORAGE_ROOT, 'subtitled')
  fs.mkdirSync(videoDir, { recursive: true })
  const videoName = `${uuid()}.mp4`
  await burnSubtitles(baseAbs, srtAbs, path.join(videoDir, videoName), info.height > info.width, info.hasAudio)
  const subtitledVideoUrl = `static/subtitled/${videoName}`
  await extractVideoPoster(subtitledVideoUrl)

  await finish(id, sourceVideo, baseVideo, { status: 'completed', subtitleUrl, subtitledVideoUrl, origin })
  return subtitledVideoUrl
}

/** 手动上传的字幕：不识别，直接按工作流固定样式压制 */
async function burnUploadedSubtitle(id: number, subtitleUrl: string) {
  const subtitledVideoUrl = await burnSrtOnShot(id, subtitleUrl, 'upload')
  logTaskSuccess(LABEL, 'upload', { storyboardId: id, subtitleUrl, subtitledVideoUrl })
}

/** 生效视频变了：用镜头现有的 SRT 重新压制，字幕来源保持不变 */
async function reburnSubtitle(id: number) {
  const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id))
  if (!sb?.subtitleUrl || !isSubtitleCurrent(sb)) throw new Error('字幕已过期，请重新生成字幕')
  const origin = sb.subtitleOrigin === 'upload' ? 'upload' : 'asr'
  logTaskStart(LABEL, 'reburn', { storyboardId: id, base: effectiveShotVideo(sb) })
  const subtitledVideoUrl = await burnSrtOnShot(id, sb.subtitleUrl, origin)
  logTaskSuccess(LABEL, 'reburn', { storyboardId: id, subtitledVideoUrl })
}

/** 用量统计上下文：谁发起、归属哪个项目、对应哪条业务记录、音频时长（秒） */
export interface TranscribeUsage {
  userId: number | null
  dramaId: number | null
  refType: string
  refId: number
  source: string
  duration: number
}

/** 抽 16kHz 单声道音频 → 识别 → 切成字幕条目（字幕工具与工作流共用）；无语音返回空数组 */
export async function transcribeVideoCues(videoAbs: string, config: AIConfig, portrait: boolean, label = LABEL, usage?: TranscribeUsage): Promise<SrtCue[]> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-sub-'))
  let tracked = false
  try {
    const audioPath = path.join(tmpDir, `${uuid()}.mp3`)
    await runFfmpeg(['-y', '-i', videoAbs, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '64k', audioPath])
    // 抽音频之后、调用识别之前记用量：本地 ffmpeg 失败不算付费调用
    if (usage) {
      await startUsage({
        serviceType: 'subtitle', provider: config.provider, model: config.model, configId: config.id,
        source: usage.source, refType: usage.refType, refId: usage.refId, quantity: usage.duration,
        dramaId: usage.dramaId, userId: usage.userId,
      }).then(() => { tracked = true }).catch(() => {})
    }
    const sentences = await transcribeAudioFile(config, audioPath, label)
    // 识别完成即计（没识别到语音也调用过了）
    if (tracked) await completeUsage(usage!.refType, usage!.refId).catch(() => {})
    return sentencesToCues(sentences, portrait ? 12 : 18)
  } catch (err) {
    if (tracked) await failUsage(usage!.refType, usage!.refId, { refund: true, errorCode: 'transcribe_failed' }).catch(() => {})
    throw err
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

async function finish(id: number, sourceVideo: string, baseVideo: string, r: { status: string; error?: string; subtitleUrl?: string; subtitledVideoUrl?: string; origin?: 'asr' | 'upload' }) {
  await db.update(schema.storyboards).set({
    subtitleStatus: r.status,
    subtitleError: r.error ?? null,
    subtitleUrl: r.subtitleUrl ?? null,
    subtitledVideoUrl: r.subtitledVideoUrl ?? null,
    subtitleSourceVideo: sourceVideo,
    subtitledBaseVideo: baseVideo,
    subtitleOrigin: r.origin ?? 'asr',
    updatedAt: now(),
  }).where(eq(schema.storyboards.id, id))
}

// ---------- FFmpeg ----------

export function probeVideo(filePath: string): Promise<{ hasAudio: boolean; width: number; height: number; duration: number }> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, meta) => {
      if (err) { reject(new Error(`读取视频信息失败：${err.message}`)); return }
      const video = meta.streams.find(s => s.codec_type === 'video')
      resolve({
        hasAudio: meta.streams.some(s => s.codec_type === 'audio'),
        width: Number(video?.width) || 0,
        height: Number(video?.height) || 0,
        duration: Number(meta.format.duration) || 0,
      })
    })
  })
}

/** 直接 spawn ffmpeg：subtitles 滤镜的文件路径以 cwd 相对名传入，避开 Windows 盘符冒号的转义问题 */
export function runFfmpeg(args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = ''
    let child
    try {
      child = spawn(ffmpegPath!, args, { cwd, windowsHide: true })
    } catch (err) {
      reject(err)
      return
    }
    child.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-4000) })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg 处理失败（退出码 ${code}）：${stderr.split('\n').filter(Boolean).slice(-3).join(' ')}`))
    })
  })
}

export function subtitleFont() {
  if (process.platform === 'darwin') return 'PingFang SC'
  if (process.platform === 'win32') return 'Microsoft YaHei'
  // Docker 镜像内装的是文泉驿微米黑；其他 Linux 上找不到时 fontconfig 会回退到已装的中文字体
  return 'WenQuanYi Micro Hei'
}

function burnSubtitles(videoAbs: string, srtAbs: string, outAbs: string, portrait: boolean, hasAudio = true) {
  // SRT 渲染时 libass 以 384x288 为坐标基准，竖屏画面横向更窄，字号相应缩小
  const style = [
    `FontName=${subtitleFont()}`,
    `FontSize=${portrait ? 11 : 16}`,
    'PrimaryColour=&H00FFFFFF',
    'OutlineColour=&H00000000',
    'BorderStyle=1',
    'Outline=1',
    'Shadow=0',
    `MarginV=${portrait ? 36 : 18}`,
  ].join(',')
  return runFfmpeg([
    '-y', '-i', videoAbs,
    '-vf', `subtitles=${path.basename(srtAbs)}:charenc=UTF-8:force_style='${style}'`,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
    ...(hasAudio ? ['-c:a', 'copy'] : ['-an']),
    '-movflags', '+faststart',
    outAbs,
  ], path.dirname(srtAbs))
}

// ---------- 整集字幕：按拼接顺序把各镜头字幕平移到成片时间轴 ----------

export async function buildEpisodeSrt(episodeId: number): Promise<string> {
  const sbs = (await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber))
    .filter(sb => sb.videoUrl && !sb.deletedAt)

  const all: SrtCue[] = []
  let offset = 0
  for (const sb of sbs) {
    // 时长按拼接时实际使用的生效视频取（增强版与原视频时长一致，原视频丢失时也能拼）
    const videoAbs = getAbsolutePath(effectiveShotVideo(sb)!)
    if (!fs.existsSync(videoAbs)) continue
    const duration = (await probeVideo(videoAbs).catch(() => null))?.duration ?? (sb.duration || 0)
    if (sb.subtitleUrl && isSubtitleCurrent(sb)) {
      const srtAbs = getAbsolutePath(sb.subtitleUrl)
      if (fs.existsSync(srtAbs)) {
        for (const c of parseSrt(fs.readFileSync(srtAbs, 'utf-8'))) {
          all.push({ start: c.start + offset, end: c.end + offset, text: c.text })
        }
      }
    }
    offset += Math.round(duration * 1000)
  }
  return cuesToSrt(all)
}
