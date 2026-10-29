import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, badRequest, notFound, now } from '../utils/response.js'
import { buildEpisodeSrt, enqueueSubtitles } from '../services/subtitle.js'
import { logTaskError, logTaskStart } from '../utils/task-logger.js'

const app = new Hono()

// POST /subtitles/storyboards/:id — 单个镜头生成字幕
app.post('/storyboards/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id))
  if (!sb) return notFound(c, '镜头不存在')
  if (!sb.videoUrl) return badRequest(c, '该镜头还没有视频，请先生成视频')
  try {
    logTaskStart('SubtitleAPI', 'storyboard', { storyboardId: id })
    const accepted = await enqueueSubtitles([id])
    return success(c, { storyboard_ids: accepted })
  } catch (err: any) {
    logTaskError('SubtitleAPI', 'storyboard', { storyboardId: id, error: err.message })
    return badRequest(c, err.message)
  }
})

// POST /subtitles/episodes/:id — 批量生成（body.storyboard_ids 可选；缺省为本集所有有视频的镜头）
app.post('/episodes/:id', async (c) => {
  const episodeId = Number(c.req.param('id'))
  let ids: number[] | undefined
  try {
    const body = await c.req.json()
    if (Array.isArray(body?.storyboard_ids)) ids = body.storyboard_ids.map(Number).filter(Boolean)
  } catch { /* 无 body 时处理全部 */ }

  const sbs = (await db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId)))
    .filter(sb => sb.videoUrl && !sb.deletedAt && (!ids || ids.includes(sb.id)))
    .sort((a, b) => a.storyboardNumber - b.storyboardNumber)
  if (!sbs.length) return badRequest(c, '所选镜头还没有可加字幕的视频')
  try {
    logTaskStart('SubtitleAPI', 'episode', { episodeId, count: sbs.length })
    const accepted = await enqueueSubtitles(sbs.map(sb => sb.id))
    return success(c, { storyboard_ids: accepted })
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
    subtitledVideoUrl: null, subtitleSourceVideo: null, updatedAt: now(),
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
