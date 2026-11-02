/**
 * 音色复刻工具 — 独立于剧集工作流：上传人声样本 → 复刻成服务商音色 → 输入文字用该音色合成语音
 *
 * 一个任务对应一段样本 / 一个复刻音色，文件都放在 static/tool-voices/。
 * status 只表示正在进行的操作（idle / cloning / synthesizing）；是否复刻成功看 cloned_at。
 * 复刻出的音色属于配置里 API Key 对应的服务商账号，所以合成必须用复刻时的那条配置。
 */
import fs from 'fs'
import path from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { v4 as uuid } from 'uuid'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { getAbsolutePath } from '../utils/storage.js'
import { toSnakeCase } from '../utils/transform.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { getActiveConfig, getConfigById, type AIConfig } from './ai.js'
import {
  cloneVoice, downloadAudio, generateVoiceId, isValidVoiceId, synthesizeSpeech, uploadCloneSample,
} from './adapters/minimax-voice.js'
import { ensureFfmpeg, probeVideo } from './subtitle.js'
import { ToolError, extOf, toolDir } from './tool-media.js'
import { completeUsage, failUsage, startUsage } from './usage.js'

export { ToolError }

type Job = typeof schema.voiceCloneJobs.$inferSelect

const LABEL = 'VoiceCloneTool'
const SUB_DIR = 'tool-voices'
export const VOICE_SAMPLE_EXT = new Set(['.mp3', '.wav', '.m4a'])
export const VOICE_SAMPLE_MAX_BYTES = 20 * 1024 * 1024
const SAMPLE_MIN_SECONDS = 10
const SAMPLE_MAX_SECONDS = 300
export const SYNTH_TEXT_MAX = 5000
const OUTPUTS_KEEP = 20

export interface VoiceSelection {
  configId?: number
  model?: string
}

export interface VoiceOutput {
  url: string
  text: string
  model: string
  created_at: string
}

function parseOutputs(job: Job): VoiceOutput[] {
  try {
    const list = job.outputs ? JSON.parse(job.outputs) : []
    return Array.isArray(list) ? list : []
  } catch { return [] }
}

/** 接口返回：字段转蛇形，outputs 解析为数组，cloned 方便前端判断 */
export function serializeJob(job: Job) {
  return { ...toSnakeCase(job), outputs: parseOutputs(job), cloned: !!job.clonedAt }
}

/** userId 给出时只认该用户的任务（按用户隔离；别人的任务一律视为不存在） */
export async function getJob(id: number, userId?: number): Promise<Job> {
  const [job] = await db.select().from(schema.voiceCloneJobs)
    .where(and(eq(schema.voiceCloneJobs.id, id), isNull(schema.voiceCloneJobs.deletedAt)))
  if (!job || (userId !== undefined && job.userId !== userId)) throw new ToolError('任务不存在')
  return job
}

export async function listJobs(userId?: number): Promise<Job[]> {
  return db.select().from(schema.voiceCloneJobs)
    .where(and(isNull(schema.voiceCloneJobs.deletedAt), userId !== undefined ? eq(schema.voiceCloneJobs.userId, userId) : undefined))
    .orderBy(desc(schema.voiceCloneJobs.id))
    .limit(100)
}

async function update(id: number, values: Partial<Job>) {
  await db.update(schema.voiceCloneJobs).set({ ...values, updatedAt: now() }).where(eq(schema.voiceCloneJobs.id, id))
}

/** 选音频配置：指定 config_id 时校验类型和模型，否则用启用配置中优先级最高者的默认模型 */
export async function getVoiceConfig(sel: VoiceSelection = {}): Promise<AIConfig> {
  let config: AIConfig | null
  if (sel.configId) {
    const [row] = await db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, sel.configId))
    if (row?.serviceType !== 'audio') throw new ToolError('所选音频配置不存在')
    config = await getConfigById(sel.configId)
    if (!config) throw new ToolError('所选音频配置已停用或已删除，请重新选择')
  } else {
    config = await getActiveConfig('audio')
    if (!config) throw new ToolError('未配置音频服务，请先到「设置 → AI 服务」添加并启用音频服务')
  }
  if (sel.model) {
    const [row] = await db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, config.id!))
    const models: string[] = row?.model ? JSON.parse(row.model) : []
    if (!models.includes(sel.model)) throw new ToolError(`音频配置「${row?.name || config.provider}」中没有模型 ${sel.model}`)
    config = { ...config, model: sel.model }
  }
  if (!config.apiKey) throw new ToolError('音频服务未填写 API Key')
  if (!config.model) throw new ToolError('音频服务未配置模型')
  return config
}

/** 上传样本建任务：MP3 / WAV / M4A，10 秒 – 5 分钟，不超过 20MB（MiniMax 复刻要求） */
export async function createJob(file: File, opts: { name?: string; userId?: number } = {}): Promise<Job> {
  const ext = extOf(file.name)
  if (!VOICE_SAMPLE_EXT.has(ext)) throw new ToolError('音色样本仅支持 MP3、WAV、M4A 格式')
  if (file.size > VOICE_SAMPLE_MAX_BYTES) throw new ToolError('音色样本不能超过 20MB')
  await ensureFfmpeg()

  const filename = `${uuid()}${ext}`
  const abs = path.join(toolDir(SUB_DIR), filename)
  await pipeline(Readable.fromWeb(file.stream() as any), fs.createWriteStream(abs))
  const info = await probeVideo(abs).catch(() => null)
  if (!info?.hasAudio) {
    fs.rmSync(abs, { force: true })
    throw new ToolError(`无法读取「${file.name}」的音频，请上传有效的人声录音`)
  }
  const duration = Number(info.duration) || 0
  if (duration < SAMPLE_MIN_SECONDS || duration > SAMPLE_MAX_SECONDS) {
    fs.rmSync(abs, { force: true })
    throw new ToolError(`音色样本时长需在 ${SAMPLE_MIN_SECONDS} 秒到 ${SAMPLE_MAX_SECONDS / 60} 分钟之间（当前 ${duration.toFixed(1)} 秒）`)
  }

  const sampleName = path.basename(file.name).slice(0, 200)
  const name = String(opts.name || '').trim().slice(0, 100) || sampleName.replace(/\.[^.]+$/, '') || filename
  const ts = now()
  const res = await db.insert(schema.voiceCloneJobs).values({
    userId: opts.userId ?? null,
    name,
    sampleUrl: `static/${SUB_DIR}/${filename}`,
    sampleName,
    sampleDuration: duration,
    status: 'idle',
    createdAt: ts,
    updatedAt: ts,
  })
  return getJob(getInsertId(res))
}

function assertIdle(job: Job) {
  if (job.status === 'cloning') throw new ToolError('正在复刻音色，请稍候')
  if (job.status === 'synthesizing') throw new ToolError('正在合成语音，请稍候')
}

function saveAudio(buf: Buffer, ext = '.mp3') {
  const name = `${uuid()}${ext}`
  fs.writeFileSync(path.join(toolDir(SUB_DIR), name), buf)
  return `static/${SUB_DIR}/${name}`
}

export async function renameJob(id: number, name: string) {
  const n = String(name || '').trim().slice(0, 100)
  if (!n) throw new ToolError('名称不能为空')
  await update(id, { name: n })
  return getJob(id)
}

export interface CloneOptions extends VoiceSelection {
  voiceId?: string
  previewText?: string
  noiseReduction?: boolean
  volumeNormalization?: boolean
}

/**
 * 复刻音色（异步）。已复刻过的任务再次复刻会换一个新的 voice_id（服务商不允许重复 ID）。
 * 带试听文本时顺带生成一段试听音频，转存到本地。
 */
export async function startClone(id: number, opts: CloneOptions = {}) {
  const job = await getJob(id)
  assertIdle(job)
  const config = await getVoiceConfig(opts)
  const voiceId = (opts.voiceId || '').trim() || generateVoiceId()
  if (!isValidVoiceId(voiceId)) {
    throw new ToolError('音色 ID 需为 8–256 位，以英文字母开头，只能包含字母、数字、- 和 _，且不能以 - 或 _ 结尾')
  }
  const previewText = String(opts.previewText || '').trim().slice(0, 300)
  await update(id, { status: 'cloning', errorMsg: null })
  logTaskStart(LABEL, 'clone', { jobId: id, configId: config.id, model: config.model, voiceId })

  ;(async () => {
    let tracked = false
    try {
      const fileId = await uploadCloneSample(config, getAbsolutePath(job.sampleUrl), job.sampleName || undefined)
      await startUsage({
        serviceType: 'audio', provider: config.provider, model: config.model, configId: config.id,
        source: 'tool_voice_clone', refType: 'voice_clone', refId: id, quantity: 1, userId: job.userId ?? null,
      }).then(() => { tracked = true }).catch(() => {})
      const { demoAudio } = await cloneVoice(config, {
        fileId, voiceId, previewText: previewText || undefined, model: config.model,
        noiseReduction: opts.noiseReduction, volumeNormalization: opts.volumeNormalization,
      })
      if (tracked) await completeUsage('voice_clone', id).catch(() => {})
      // 试听音频转存失败不影响复刻结果
      let demoUrl: string | null = null
      if (demoAudio) {
        try { demoUrl = saveAudio(await downloadAudio(demoAudio)) } catch (err: any) {
          logTaskError(LABEL, 'demo-download', { jobId: id, error: err.message })
        }
      }
      await update(id, {
        status: 'idle', provider: config.provider, configId: config.id ?? null, voiceId, demoUrl, clonedAt: now(),
      })
      logTaskSuccess(LABEL, 'clone', { jobId: id, voiceId, demo: !!demoUrl })
    } catch (err) {
      if (tracked) await failUsage('voice_clone', id, { refund: true, errorCode: 'clone_failed' }).catch(() => {})
      throw err
    }
  })().catch(async (err: Error) => {
    logTaskError(LABEL, 'clone', { jobId: id, error: err.message })
    await update(id, { status: 'idle', errorMsg: err.message })
  })
}

export interface SynthOptions {
  text?: string
  model?: string
  speed?: number
}

/** 用复刻好的音色合成语音（异步），结果追加到 outputs 头部 */
export async function startSynthesize(id: number, opts: SynthOptions = {}) {
  const job = await getJob(id)
  assertIdle(job)
  if (!job.clonedAt || !job.voiceId) throw new ToolError('请先复刻音色')
  if (!job.configId) throw new ToolError('复刻时使用的音频配置已不存在，请重新复刻')
  const text = String(opts.text || '').trim()
  if (!text) throw new ToolError('请输入要合成的文字')
  if (text.length > SYNTH_TEXT_MAX) throw new ToolError(`单次合成不能超过 ${SYNTH_TEXT_MAX} 字`)
  const speed = opts.speed === undefined || opts.speed === null ? 1 : Number(opts.speed)
  if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) throw new ToolError('语速需在 0.5 到 2 之间')
  let config: AIConfig
  try {
    config = await getVoiceConfig({ configId: job.configId, model: opts.model || undefined })
  } catch (err: any) {
    throw new ToolError(`${err.message}（音色只能用复刻时的配置合成）`)
  }
  await update(id, { status: 'synthesizing', errorMsg: null })
  logTaskStart(LABEL, 'synthesize', { jobId: id, configId: config.id, model: config.model, chars: text.length })

  ;(async () => {
    let tracked = false
    try {
      await startUsage({
        serviceType: 'audio', provider: config.provider, model: config.model, configId: config.id,
        source: 'tool_voice_synthesis', refType: 'voice_synthesis', refId: id, quantity: 1, userId: job.userId ?? null,
      }).then(() => { tracked = true }).catch(() => {})
      const { audio } = await synthesizeSpeech(config, { voiceId: job.voiceId!, text, model: config.model, speed })
      if (tracked) await completeUsage('voice_synthesis', id).catch(() => {})
      const url = saveAudio(audio)
      const latest = await getJob(id)
      const outputs = [{ url, text, model: config.model, created_at: now() }, ...parseOutputs(latest)].slice(0, OUTPUTS_KEEP)
      await update(id, { status: 'idle', outputs: JSON.stringify(outputs) })
      logTaskSuccess(LABEL, 'synthesize', { jobId: id, url })
    } catch (err) {
      if (tracked) await failUsage('voice_synthesis', id, { refund: true, errorCode: 'synthesis_failed' }).catch(() => {})
      throw err
    }
  })().catch(async (err: Error) => {
    logTaskError(LABEL, 'synthesize', { jobId: id, error: err.message })
    await update(id, { status: 'idle', errorMsg: err.message })
  })
}

/** 从列表里移除一条合成结果（只改记录，不删文件） */
export async function removeOutput(id: number, url: string) {
  const job = await getJob(id)
  await update(id, { outputs: JSON.stringify(parseOutputs(job).filter(o => o.url !== url)) })
  return getJob(id)
}

export async function deleteJob(id: number) {
  await update(id, { deletedAt: now() })
}

/** 服务重启时进行中的操作已丢失，复位并提示重试 */
export async function resetInterruptedVoiceJobs() {
  await db.update(schema.voiceCloneJobs)
    .set({ status: 'idle', errorMsg: '服务重启，操作已中断，请重试' })
    .where(inArray(schema.voiceCloneJobs.status, ['cloning', 'synthesizing']))
}
