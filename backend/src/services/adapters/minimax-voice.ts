/**
 * MiniMax 音色快速复刻 + 语音合成（工具页「音色复刻」）
 *
 * 流程（https://platform.minimaxi.com/docs/guides/speech-voice-clone）：
 *   1. POST /v1/files/upload（multipart，purpose=voice_clone）上传样本 → file_id
 *   2. POST /v1/voice_clone { file_id, voice_id, text?, model? } → 注册音色；带 text + model 时返回试听音频 demo_audio
 *   3. POST /v1/t2a_v2 { model, text, voice_setting: { voice_id } } → 十六进制编码的 mp3
 *
 * 复刻得到的是临时音色：7 天内没有正式用于语音合成就会被服务商删除。
 * 所有接口都用 base_resp.status_code 表示业务结果（0 = 成功），HTTP 200 也可能是失败。
 */
import fs from 'fs'
import path from 'path'
import type { AIConfig } from '../ai.js'
import { joinProviderUrl } from './url.js'
import { logTaskProgress, redactUrl } from '../../utils/task-logger.js'

const LABEL = 'MiniMaxVoice'

export class VoiceProviderError extends Error {}

/** voice_id 规则：8–256 位，字母开头，只含字母数字 - _，不能以 - 或 _ 结尾 */
export function isValidVoiceId(id: string) {
  return /^[A-Za-z][A-Za-z0-9_-]{6,254}[A-Za-z0-9]$/.test(id)
}

/** 生成一个满足规则、几乎不会重复的 voice_id */
export function generateVoiceId() {
  return `huobao${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

function url(config: AIConfig, p: string) {
  return joinProviderUrl(config.baseUrl, '/v1', p)
}

function authHeaders(config: AIConfig, json = true): Record<string, string> {
  const h: Record<string, string> = { Authorization: `Bearer ${config.apiKey}` }
  if (json) h['Content-Type'] = 'application/json'
  return h
}

async function readJson(resp: Response, action: string) {
  const text = await resp.text()
  let data: any = null
  try { data = text ? JSON.parse(text) : null } catch { /* 非 JSON */ }
  if (!resp.ok) {
    const msg = data?.base_resp?.status_msg || data?.message || text.slice(0, 200) || resp.statusText
    throw new VoiceProviderError(`${action}失败（HTTP ${resp.status}）：${msg}`)
  }
  const code = data?.base_resp?.status_code
  if (code !== undefined && code !== 0) {
    throw new VoiceProviderError(`${action}失败：${data?.base_resp?.status_msg || `错误码 ${code}`}（${code}）`)
  }
  if (!data) throw new VoiceProviderError(`${action}失败：服务返回内容无法解析`)
  return data
}

/** 上传复刻样本，返回 file_id */
export async function uploadCloneSample(config: AIConfig, fileAbs: string, filename?: string): Promise<string> {
  const form = new FormData()
  form.append('purpose', 'voice_clone')
  form.append('file', new Blob([fs.readFileSync(fileAbs)]), filename || path.basename(fileAbs))
  const target = url(config, '/files/upload')
  logTaskProgress(LABEL, 'upload', { url: redactUrl(target) })
  const data = await readJson(await fetch(target, { method: 'POST', headers: authHeaders(config, false), body: form }), '上传音色样本')
  const fileId = data?.file?.file_id
  if (fileId === undefined || fileId === null || fileId === '') throw new VoiceProviderError('上传音色样本失败：未返回 file_id')
  return String(fileId)
}

export interface CloneVoiceInput {
  fileId: string
  voiceId: string
  /** 试听文本；与 model 同时给出时服务商会返回一段试听音频 */
  previewText?: string
  model?: string
  noiseReduction?: boolean
  volumeNormalization?: boolean
}

/** 注册复刻音色；返回试听音频地址（没要试听时为 null） */
export async function cloneVoice(config: AIConfig, input: CloneVoiceInput): Promise<{ demoAudio: string | null }> {
  const body: Record<string, unknown> = {
    // 官方示例里 file_id 是整数；纯数字时按数字传，兼容中转站
    file_id: /^\d+$/.test(input.fileId) ? Number(input.fileId) : input.fileId,
    voice_id: input.voiceId,
    need_noise_reduction: !!input.noiseReduction,
    need_volume_normalization: !!input.volumeNormalization,
  }
  if (input.previewText && input.model) {
    body.text = input.previewText
    body.model = input.model
  }
  const data = await readJson(await fetch(url(config, '/voice_clone'), {
    method: 'POST', headers: authHeaders(config), body: JSON.stringify(body),
  }), '复刻音色')
  if (data?.input_sensitive && data.input_sensitive !== 0 && data.input_sensitive !== false) {
    throw new VoiceProviderError('复刻音色失败：音色样本未通过服务商内容审核')
  }
  return { demoAudio: typeof data?.demo_audio === 'string' && data.demo_audio ? data.demo_audio : null }
}

export interface SynthesizeInput {
  voiceId: string
  text: string
  model: string
  /** 语速 0.5–2，默认 1 */
  speed?: number
}

/** 用指定音色合成语音，返回 mp3 数据 */
export async function synthesizeSpeech(config: AIConfig, input: SynthesizeInput): Promise<{ audio: Buffer; characters: number | null }> {
  const body = {
    model: input.model,
    text: input.text,
    stream: false,
    voice_setting: { voice_id: input.voiceId, speed: input.speed ?? 1, vol: 1, pitch: 0 },
    audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
    output_format: 'hex',
  }
  const data = await readJson(await fetch(url(config, '/t2a_v2'), {
    method: 'POST', headers: authHeaders(config), body: JSON.stringify(body),
  }), '语音合成')
  const hex = data?.data?.audio
  if (typeof hex !== 'string' || !hex) throw new VoiceProviderError('语音合成失败：服务未返回音频')
  const audio = Buffer.from(hex, 'hex')
  if (!audio.length) throw new VoiceProviderError('语音合成失败：返回的音频为空')
  const chars = Number(data?.extra_info?.usage_characters)
  return { audio, characters: Number.isFinite(chars) ? chars : null }
}

/** 下载服务商返回的试听音频（地址有时效，必须转存） */
export async function downloadAudio(src: string): Promise<Buffer> {
  const resp = await fetch(src)
  if (!resp.ok) throw new VoiceProviderError(`下载试听音频失败（HTTP ${resp.status}）`)
  return Buffer.from(await resp.arrayBuffer())
}

/** 设置页「测试」：查询音色列表，不产生费用 */
export function buildVoiceProbe(baseUrl: string, apiKey?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  return {
    method: 'POST',
    url: joinProviderUrl(baseUrl, '/v1', '/get_voice'),
    headers,
    body: { voice_type: 'voice_cloning' } as unknown,
  }
}
