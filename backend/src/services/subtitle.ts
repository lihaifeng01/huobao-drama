/**
 * 字幕制作 — 镜头视频抽音频 → 字幕服务识别 → 生成 SRT → FFmpeg 压制到视频
 *
 * 状态直接记在 storyboards 上：subtitle_status = processing / completed / no_speech / failed。
 * subtitle_source_video 记录生成时依据的 video_url，镜头视频重新生成后两者不一致，即视为字幕过期。
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
import { cuesToSrt, parseSrt, sentencesToCues, type SrtCue } from '../utils/srt.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { getActiveConfig, getConfigById, type AIConfig } from './ai.js'
import { transcribeAudioFile } from './adapters/aliyun-asr.js'
import { currentActorId } from './actor.js'
import { completeUsage, failUsage, startUsage } from './usage.js'
import { dramaOf } from './project-access.js'

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

/** 字幕是否对应当前镜头视频（视频重新生成后字幕过期） */
export function isSubtitleCurrent(sb: Storyboard) {
  return !!sb.subtitleSourceVideo && sb.subtitleSourceVideo === sb.videoUrl
}

// ---------- 并发队列：识别和压制都较重，限制同时处理的镜头数 ----------

// 入队时记下所选配置与模型，处理时按它解析（用户中途切换顶栏选择不影响已入队的镜头）
// userId 也在入队时记下：出队处理时已经不在发起请求的上下文里了（用量统计归属）
const queue: { id: number; sel: SubtitleSelection; userId: number | null }[] = []
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
    queue.push({ id, sel, userId: currentActorId() })
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
    const { id, sel, userId } = queue.shift()!
    running++
    processStoryboard(id, sel, userId)
      .catch(async (err: Error) => {
        logTaskError(LABEL, 'subtitle', { storyboardId: id, error: err.message })
        await db.update(schema.storyboards)
          .set({ subtitleStatus: 'failed', subtitleError: err.message, updatedAt: now() })
          .where(eq(schema.storyboards.id, id))
      })
      .finally(() => {
        running--
        queued.delete(id)
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

async function processStoryboard(id: number, sel: SubtitleSelection, userId: number | null) {
  const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id))
  if (!sb?.videoUrl) throw new Error('镜头还没有视频')
  const sourceVideo = sb.videoUrl
  const videoAbs = getAbsolutePath(sourceVideo)
  if (!fs.existsSync(videoAbs)) throw new Error('镜头视频文件已丢失（本地文件不存在），请重新生成视频')

  const config = await getSubtitleConfig(sel)
  logTaskStart(LABEL, 'subtitle', { storyboardId: id, configId: config.id, model: config.model })

  const info = await probeVideo(videoAbs)
  if (!info.hasAudio) {
    await finish(id, sourceVideo, { status: 'no_speech', error: '视频没有音轨，无法识别字幕' })
    return
  }

  const portrait = info.height > info.width
  const cues = await transcribeVideoCues(videoAbs, config, portrait, LABEL, {
    userId, dramaId: await dramaOf('storyboard', id), refType: 'storyboard_subtitle', refId: id, source: 'shot_subtitle', duration: info.duration,
  })
  if (!cues.length) {
    await finish(id, sourceVideo, { status: 'no_speech', error: '未识别到语音' })
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
  await burnSubtitles(videoAbs, path.join(subDir, srtName), path.join(videoDir, videoName), portrait)
  const subtitledVideoUrl = `static/subtitled/${videoName}`
  await extractVideoPoster(subtitledVideoUrl)

  await finish(id, sourceVideo, { status: 'completed', subtitleUrl, subtitledVideoUrl })
  logTaskSuccess(LABEL, 'subtitle', { storyboardId: id, cues: cues.length, subtitleUrl, subtitledVideoUrl })
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

async function finish(id: number, sourceVideo: string, r: { status: string; error?: string; subtitleUrl?: string; subtitledVideoUrl?: string }) {
  await db.update(schema.storyboards).set({
    subtitleStatus: r.status,
    subtitleError: r.error ?? null,
    subtitleUrl: r.subtitleUrl ?? null,
    subtitledVideoUrl: r.subtitledVideoUrl ?? null,
    subtitleSourceVideo: sourceVideo,
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

function burnSubtitles(videoAbs: string, srtAbs: string, outAbs: string, portrait: boolean) {
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
    '-c:a', 'copy',
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
    const videoAbs = getAbsolutePath(sb.videoUrl!)
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
