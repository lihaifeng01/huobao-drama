/**
 * 工具页共用：接收上传的视频（流式写盘）并读取画面信息
 */
import fs from 'fs'
import path from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { v4 as uuid } from 'uuid'
import { STORAGE_ROOT } from '../utils/paths.js'
import { extractVideoPoster } from '../utils/video-poster.js'
import { ensureFfmpeg, probeVideo } from './subtitle.js'

export const TOOL_VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi'])
export const TOOL_VIDEO_MAX_BYTES = 500 * 1024 * 1024

/** 业务错误（参数不对、状态不允许等），路由层返回 400 */
export class ToolError extends Error {}

export interface ToolVideo {
  url: string
  width: number
  height: number
  duration: number
  hasAudio: boolean
}

export function toolDir(subDir: string) {
  const dir = path.join(STORAGE_ROOT, subDir)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function extOf(name: string) {
  return path.extname(name || '').toLowerCase()
}

/** 保存上传的视频到 static/<subDir>/，读取分辨率/时长/是否有音轨，并生成海报帧；读不出画面时删除文件并报错 */
export async function saveToolVideo(file: File, subDir: string): Promise<ToolVideo> {
  const ext = extOf(file.name)
  if (!TOOL_VIDEO_EXT.has(ext)) throw new ToolError(`仅支持 ${[...TOOL_VIDEO_EXT].join('/')} 格式的视频`)
  if (file.size > TOOL_VIDEO_MAX_BYTES) throw new ToolError(`视频大小不能超过 ${TOOL_VIDEO_MAX_BYTES / 1024 / 1024}MB`)
  await ensureFfmpeg()

  const filename = `${uuid()}${ext}`
  const abs = path.join(toolDir(subDir), filename)
  // 流式写盘，大文件不再整块复制一份
  await pipeline(Readable.fromWeb(file.stream() as any), fs.createWriteStream(abs))
  const url = `static/${subDir}/${filename}`

  const info = await probeVideo(abs).catch(() => null)
  if (!info?.width || !info?.height) {
    fs.rmSync(abs, { force: true })
    throw new ToolError(`无法读取「${file.name}」的视频画面，请确认文件是完整的视频`)
  }
  await extractVideoPoster(url)
  return { url, width: info.width, height: info.height, duration: info.duration, hasAudio: info.hasAudio }
}
