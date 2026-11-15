/**
 * 视频尾帧提取 — 把上一分镜视频的最后一帧作为下一分镜的参考图 / 首帧
 */
import fs from 'fs'
import { getAbsolutePath } from './storage.js'
import { ffmpeg, checkFfmpegSuite } from './ffmpeg.js'

/** 由视频相对路径推导尾帧路径：static/videos/x.mp4 → static/videos/x_tail.jpg */
export function tailFramePathFor(relativePath: string): string {
  return relativePath.replace(/\.[^./]+$/, '_tail.jpg')
}

/** 抽取视频最后一帧（已存在则复用）。失败返回 null，不阻断主流程。 */
export async function extractVideoTailFrame(relativePath: string): Promise<string | null> {
  try {
    const { ffmpeg: ffmpegOk } = await checkFfmpegSuite()
    if (!ffmpegOk) return null

    const tailRel = tailFramePathFor(relativePath)
    const tailAbs = getAbsolutePath(tailRel)
    if (fs.existsSync(tailAbs) && fs.statSync(tailAbs).size > 0) return tailRel

    await new Promise<void>((resolve, reject) => {
      ffmpeg(getAbsolutePath(relativePath))
        .inputOptions(['-sseof', '-0.1'])
        .outputOptions(['-update', '1', '-frames:v', '1', '-q:v', '2'])
        .output(tailAbs)
        .on('end', () => resolve())
        .on('error', reject)
        .run()
    })
    return fs.existsSync(tailAbs) && fs.statSync(tailAbs).size > 0 ? tailRel : null
  } catch (err) {
    console.warn(`[video-tail-frame] 尾帧提取失败 ${relativePath}:`, (err as Error).message)
    return null
  }
}
