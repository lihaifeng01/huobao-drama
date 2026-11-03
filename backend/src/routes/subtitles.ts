import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, badRequest, notFound, now } from '../utils/response.js'
import { bodyLimit } from 'hono/body-limit'
import { SUBTITLE_UPLOAD_MAX_BYTES, SubtitleUploadError, buildEpisodeSrt, enqueueSubtitles, enqueueUploadedSubtitle, isSubtitleCurrent, type SubtitleSelection } from '../services/subtitle.js'
import { logTaskError, logTaskStart } from '../utils/task-logger.js'

const app = new Hono()

/** 用户手动上传、且仍对应当前视频的字幕 */
function isManualSubtitle(sb: typeof schema.storyboards.$inferSelect) {
  return sb.subtitleOrigin === 'upload' && sb.subtitleStatus === 'completed' && isSubtitleCurrent(sb)
}

/** body.config_id / body.model：工作台顶栏所选字幕配置与模型，缺省走默认 */
function readSelection(body: any): SubtitleSelection {
  return {
    configId: Number(body?.config_id) || undefined,
    model: typeof body?.model === 'string' && body.model.trim() ? body.model.trim() : undefined,
  }
}

// POST /subtitles/storyboards/:id — 单个镜头生成字幕
app.post('/storyboards/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id))
  if (!sb) return notFound(c, '镜头不存在')
  if (!sb.videoUrl) return badRequest(c, '该镜头还没有视频，请先生成视频')
  const sel = readSelection(await c.req.json().catch(() => ({})))
  try {
    logTaskStart('SubtitleAPI', 'storyboard', { storyboardId: id, ...sel })
    const accepted = await enqueueSubtitles([id], sel)
    return success(c, { storyboard_ids: accepted })
  } catch (err: any) {
    logTaskError('SubtitleAPI', 'storyboard', { storyboardId: id, error: err.message })
    return badRequest(c, err.message)
  }
})

// POST /subtitles/storyboards/:id/upload — 手动上传字幕文件（multipart file，.srt / .vtt），跳过识别直接压制
app.post('/storyboards/:id/upload', bodyLimit({
  maxSize: SUBTITLE_UPLOAD_MAX_BYTES + 64 * 1024,
  onError: (c) => badRequest(c, '字幕文件不能超过 5MB'),
}), async (c) => {
  const id = Number(c.req.param('id'))
  const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id))
  if (!sb || sb.deletedAt) return notFound(c, '镜头不存在')
  // 不吞 parseBody 的异常：没有 Content-Length 时超限错误在读取请求体时才抛出，要交给 bodyLimit 转成 400
  const body = await c.req.parseBody()
  const file = body['file']
  if (!file || !(file instanceof File)) return badRequest(c, '请选择字幕文件')
  try {
    const result = await enqueueUploadedSubtitle(id, file)
    return success(c, { storyboard_id: id, cues: result.cues })
  } catch (err: any) {
    if (!(err instanceof SubtitleUploadError)) logTaskError('SubtitleAPI', 'upload', { storyboardId: id, error: err.message })
    return badRequest(c, err.message)
  }
})

// POST /subtitles/episodes/:id — 批量生成（body.storyboard_ids 可选；缺省为本集所有有视频的镜头）
app.post('/episodes/:id', async (c) => {
  const episodeId = Number(c.req.param('id'))
  let ids: number[] | undefined
  let sel: SubtitleSelection = {}
  try {
    const body = await c.req.json()
    if (Array.isArray(body?.storyboard_ids)) ids = body.storyboard_ids.map(Number).filter(Boolean)
    sel = readSelection(body)
  } catch { /* 无 body 时处理全部 */ }

  const sbs = (await db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId)))
    .filter(sb => sb.videoUrl && !sb.deletedAt && (!ids || ids.includes(sb.id)))
    .sort((a, b) => a.storyboardNumber - b.storyboardNumber)
  if (!sbs.length) return badRequest(c, '所选镜头还没有可加字幕的视频')
  // 「全部生成」不覆盖用户手动上传且仍有效的字幕；显式勾选的镜头照常重新识别
  const targets = ids ? sbs : sbs.filter(sb => !isManualSubtitle(sb))
  if (!targets.length) return success(c, { storyboard_ids: [], skipped_uploaded: sbs.length })
  try {
    logTaskStart('SubtitleAPI', 'episode', { episodeId, count: targets.length, ...sel })
    const accepted = await enqueueSubtitles(targets.map(sb => sb.id), sel)
    return success(c, { storyboard_ids: accepted, skipped_uploaded: sbs.length - targets.length })
  } catch (err: any) {
    logTaskError('SubtitleAPI', 'episode', { episodeId, error: err.message })
    return badRequest(c, err.message)
  }
})

// DELETE /subtitles/storyboards/:id — 清除镜头字幕（文件保留，只解除关联）
app.delete('/storyboards/:id', async (c) => {
  const id = Number(c.req.param('id'))
  await db.update(schema.storyboards).set({
    subtitleStatus: null, subtitleError: null, subtitleUrl: null,
    subtitledVideoUrl: null, subtitleSourceVideo: null, subtitleOrigin: null, updatedAt: now(),
  }).where(eq(schema.storyboards.id, id))
  return success(c)
})

// GET /subtitles/episodes/:id/srt — 整集字幕（与成片时间轴对齐），作为附件下载
app.get('/episodes/:id/srt', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!ep) return notFound(c, '剧集不存在')
  const srt = await buildEpisodeSrt(episodeId)
  if (!srt.trim()) return badRequest(c, '本集还没有可下载的字幕')
  const filename = `episode-${ep.episodeNumber ?? episodeId}.srt`
  return c.body(srt, 200, {
    'Content-Type': 'application/x-subrip; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
  })
})

export default app
