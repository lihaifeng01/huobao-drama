/**
 * 镜头视频的「三个版本」及其有效性 —— 字幕、拼接导出、前端都按这里的规则判断，不要各写一套。
 *
 * - 原视频 video_url：视频生成的产物（视频制作页的「主视频」）。
 * - 画质增强版 upscaled_video_url：对原视频做超分的结果，单独存放，不覆盖 video_url。
 *   只有增强时依据的正是当前原视频（upscale_source_video === video_url）才有效；原视频重新生成后自动作废。
 * - 生效视频 = 有效的增强版，否则原视频。字幕压制、整集字幕、拼接导出都用生效视频。
 *
 * 字幕拆成两件事分别判断：
 * - 字幕文本（SRT）属于原视频：subtitle_source_video === video_url 即有效。画质增强不改时间轴，增强前后都能用。
 * - 字幕版视频是压在某个视频上的：subtitled_base_video === 生效视频 才有效。
 *   生效视频变了（做了增强 / 清除了增强）而字幕文本仍有效时，只需用现有 SRT 重新压制，不用重新识别或重新上传。
 */
import { schema } from '../db/index.js'

type Storyboard = typeof schema.storyboards.$inferSelect

/** 画质增强结果是否对应当前原视频 */
export function isUpscaleCurrent(sb: Storyboard) {
  return !!sb.upscaledVideoUrl && !!sb.videoUrl && sb.upscaleSourceVideo === sb.videoUrl
}

/** 生效视频：有效的增强版，否则原视频 */
export function effectiveShotVideo(sb: Storyboard): string | null {
  if (isUpscaleCurrent(sb)) return sb.upscaledVideoUrl!
  return sb.videoUrl || null
}

/** 字幕文本（SRT / 识别结果）是否对应当前原视频 */
export function isSubtitleCurrent(sb: Storyboard) {
  return !!sb.subtitleSourceVideo && sb.subtitleSourceVideo === sb.videoUrl
}

/** 字幕版视频压在哪个视频上（老数据没有记录，视为压在原视频上） */
export function subtitledBaseOf(sb: Storyboard) {
  return sb.subtitledBaseVideo || sb.subtitleSourceVideo || null
}

/** 字幕版视频是否可直接使用：字幕文本有效，且压制时用的正是当前生效视频 */
export function isSubtitledVideoCurrent(sb: Storyboard) {
  return !!sb.subtitledVideoUrl && isSubtitleCurrent(sb) && subtitledBaseOf(sb) === effectiveShotVideo(sb)
}

/** 字幕文本有效、但字幕版视频压在旧的生效视频上：需要用现有 SRT 重新压制 */
export function needsSubtitleReburn(sb: Storyboard) {
  return sb.subtitleStatus === 'completed' && !!sb.subtitleUrl && isSubtitleCurrent(sb)
    && subtitledBaseOf(sb) !== effectiveShotVideo(sb)
}
