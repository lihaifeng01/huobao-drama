/**
 * 阿里云百炼录音文件识别（Qwen-Audio-ASR-Filetrans / Qwen3-ASR-Filetrans）
 *
 * 流程：getPolicy 拿临时上传凭证 → 上传本地音频得到 oss:// 临时地址（48 小时有效）
 *      → 异步提交识别任务 → 轮询 /tasks/{id} → 下载 transcription_url 的结果 JSON。
 * 文档：
 *   https://help.aliyun.com/zh/model-studio/qwen-audio-asr-filetrans-http-api
 *   https://help.aliyun.com/zh/model-studio/get-temporary-file-url
 * 本地文件走临时 oss:// 地址，桌面版无公网地址也能用；调用时必须带 X-DashScope-OssResourceResolve。
 */
import fs from 'fs'
import path from 'path'
import { joinProviderUrl } from './url.js'
import type { AIConfig } from '../ai.js'
import { logTaskProgress, redactUrl } from '../../utils/task-logger.js'

export interface AsrWord {
  begin_time: number
  end_time: number
  text: string
  punctuation?: string
}

export interface AsrSentence {
  begin_time: number
  end_time: number
  text: string
  words?: AsrWord[]
}

const POLL_INTERVAL_MS = 3_000
const POLL_TIMEOUT_MS = 15 * 60_000

function apiUrl(config: AIConfig, p: string) {
  return joinProviderUrl(config.baseUrl, '/api/v1', p)
}

async function readJson(resp: Response, action: string) {
  const text = await resp.text()
  let json: any = null
  try { json = text ? JSON.parse(text) : null } catch { /* 非 JSON 响应 */ }
  if (!resp.ok) {
    const msg = json?.message || json?.code || text.slice(0, 200) || resp.statusText
    throw new Error(`字幕服务${action}失败（HTTP ${resp.status}）：${msg}`)
  }
  return json
}

/** Qwen3-ASR-Filetrans 的入参是单个 file_url；Qwen-Audio-ASR-Filetrans 是 file_urls 数组 */
export function buildTranscriptionBody(model: string, fileUrl: string) {
  if (/^qwen3-asr/i.test(model)) {
    return { model, input: { file_url: fileUrl }, parameters: { channel_id: [0], enable_words: true } }
  }
  // parameters 必须传（哪怕为空），省略会导致任务识别失败
  return { model, input: { file_urls: [fileUrl] }, parameters: { channel_id: [0] } }
}

/** 上传本地文件，返回 oss:// 临时地址。上传用的 model 必须与识别调用的 model 一致 */
export async function uploadTempFile(config: AIConfig, filePath: string): Promise<string> {
  const policyUrl = new URL(apiUrl(config, '/uploads'))
  policyUrl.searchParams.set('action', 'getPolicy')
  policyUrl.searchParams.set('model', config.model)
  const policyResp = await fetch(policyUrl, {
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(30_000),
  })
  const policy = (await readJson(policyResp, '获取上传凭证'))?.data
  if (!policy?.upload_host || !policy?.upload_dir) throw new Error('字幕服务获取上传凭证失败：响应缺少 upload_host')

  const key = `${policy.upload_dir}/${path.basename(filePath)}`
  const form = new FormData()
  form.append('OSSAccessKeyId', policy.oss_access_key_id)
  form.append('Signature', policy.signature)
  form.append('policy', policy.policy)
  form.append('x-oss-object-acl', policy.x_oss_object_acl)
  form.append('x-oss-forbid-overwrite', policy.x_oss_forbid_overwrite)
  form.append('key', key)
  form.append('success_action_status', '200')
  // file 必须是最后一个字段
  form.append('file', new Blob([fs.readFileSync(filePath)]), path.basename(filePath))
  const uploadResp = await fetch(policy.upload_host, { method: 'POST', body: form, signal: AbortSignal.timeout(5 * 60_000) })
  if (!uploadResp.ok) {
    const text = await uploadResp.text().catch(() => '')
    throw new Error(`字幕服务上传音频失败（HTTP ${uploadResp.status}）：${text.slice(0, 200)}`)
  }
  return `oss://${key}`
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** 识别一个音频文件，返回句级结果（毫秒时间戳，含字级时间戳时一并返回） */
export async function transcribeAudioFile(config: AIConfig, filePath: string, label = 'Subtitle'): Promise<AsrSentence[]> {
  const fileUrl = await uploadTempFile(config, filePath)
  logTaskProgress(label, 'asr-uploaded', { model: config.model })

  const submitUrl = apiUrl(config, '/services/audio/asr/transcription')
  const submitResp = await fetch(submitUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
      'X-DashScope-Async': 'enable',
      'X-DashScope-OssResourceResolve': 'enable',
    },
    body: JSON.stringify(buildTranscriptionBody(config.model, fileUrl)),
    signal: AbortSignal.timeout(30_000),
  })
  const submitted = await readJson(submitResp, '提交识别任务')
  const taskId = submitted?.output?.task_id
  if (!taskId) throw new Error(`字幕服务提交识别任务失败：${submitted?.message || '响应缺少 task_id'}`)
  logTaskProgress(label, 'asr-submitted', { taskId, url: redactUrl(submitUrl) })

  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS)
    const pollResp = await fetch(apiUrl(config, `/tasks/${taskId}`), {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(30_000),
    })
    const output = (await readJson(pollResp, '查询识别任务'))?.output || {}
    const status = String(output.task_status || '').toUpperCase()
    if (status === 'PENDING' || status === 'RUNNING') continue
    // Qwen-Audio 返回 results[]（逐子任务）；Qwen3-ASR 返回 result
    const result = Array.isArray(output.results) ? output.results[0] : output.result
    if (status === 'SUCCEEDED' && result?.transcription_url && (result.subtask_status ?? 'SUCCEEDED') === 'SUCCEEDED') {
      const resultResp = await fetch(result.transcription_url, { signal: AbortSignal.timeout(60_000) })
      return parseTranscription(await readJson(resultResp, '下载识别结果'))
    }
    const reason = result?.message || result?.code || output.message || output.code || status || '未知错误'
    throw new Error(`字幕识别失败：${reason}`)
  }
  throw new Error('字幕识别超时（超过 15 分钟未完成）')
}

/** 取第一条音轨的句子；无语音时返回空数组 */
export function parseTranscription(json: any): AsrSentence[] {
  const transcript = Array.isArray(json?.transcripts) ? json.transcripts[0] : null
  const sentences = Array.isArray(transcript?.sentences) ? transcript.sentences : []
  return sentences
    .filter((s: any) => String(s?.text || '').trim())
    .map((s: any) => ({
      begin_time: Number(s.begin_time) || 0,
      end_time: Number(s.end_time) || 0,
      text: String(s.text).trim(),
      words: Array.isArray(s.words) ? s.words : undefined,
    }))
}

/** 探测连通性与鉴权：getPolicy 不创建计费任务 */
export function buildAsrProbe(baseUrl: string, model: string, apiKey?: string) {
  const url = new URL(joinProviderUrl(baseUrl, '/api/v1', '/uploads'))
  url.searchParams.set('action', 'getPolicy')
  url.searchParams.set('model', model || 'qwen-audio-3.0-asr-flash-filetrans')
  return {
    method: 'GET',
    url: url.toString(),
    headers: { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), 'Content-Type': 'application/json' } as Record<string, string>,
    body: undefined as unknown,
  }
}
