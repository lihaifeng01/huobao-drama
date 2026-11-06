import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, badRequest, notFound } from '../utils/response.js'
import { logTaskError, logTaskStart } from '../utils/task-logger.js'
import { isUpscaleCurrent } from '../services/shot-video.js'
import {
  DEFAULT_UPSCALE_TARGET, UpscaleError, clearUpscale, enqueueUpscale, isUpscaleTarget, type UpscaleTarget,
} from '../services/upscale.js'

const app = new Hono()

function readTarget(body: any): UpscaleTarget | null {
  const raw = body?.target ?? DEFAULT_UPSCALE_TARGET
  return isUpscaleTarget(raw) ? raw : null
}

// POST /upscale/storyboards/:id — 单个镜头画质增强 { target?: '1080p' | '1440p' | '2160p' }
app.post('/storyboards/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id))
  if (!sb || sb.deletedAt) return notFound(c, '镜头不存在')
  const target = readTarget(await c.req.json().catch(() => ({})))
  if (!target) return badRequest(c, 'target 只支持 1080p / 1440p / 2160p')
  try {
    logTaskStart('UpscaleAPI', 'storyboard', { storyboardId: id, target })
    const result = await enqueueUpscale([id], target)
    if (!result.accepted.length) return badRequest(c, result.skipped[0]?.message || '无法增强该镜头')
    return success(c, { storyboard_ids: result.accepted, target })
  } catch (err: any) {
    if (!(err instanceof UpscaleError)) logTaskError('UpscaleAPI', 'storyboard', { storyboardId: id, error: err.message })
    return badRequest(c, err.message)
  }
})

// POST /upscale/episodes/:id — 批量增强 { storyboard_ids?, target? }
// 不传 storyboard_ids 时处理本集所有有视频、且还没有同规格有效增强结果的镜头；显式勾选的照常处理
app.post('/episodes/:id', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({}))
  const target = readTarget(body)
  if (!target) return badRequest(c, 'target 只支持 1080p / 1440p / 2160p')
  const ids: number[] | undefined = Array.isArray(body?.storyboard_ids) ? body.storyboard_ids.map(Number).filter(Boolean) : undefined

  const sbs = (await db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId)))
    .filter(sb => sb.videoUrl && !sb.deletedAt && (!ids || ids.includes(sb.id)))
    .sort((a, b) => a.storyboardNumber - b.storyboardNumber)
  if (!sbs.length) return badRequest(c, '所选镜头还没有可增强的视频')
  const targets = ids ? sbs : sbs.filter(sb => !(isUpscaleCurrent(sb) && sb.upscaleTarget === target))
  if (!targets.length) return success(c, { storyboard_ids: [], skipped: [], already_done: sbs.length, target })
  try {
    logTaskStart('UpscaleAPI', 'episode', { episodeId, count: targets.length, target })
    const result = await enqueueUpscale(targets.map(sb => sb.id), target)
    return success(c, {
      storyboard_ids: result.accepted,
      skipped: result.skipped.map(s => ({ storyboard_id: s.id, reason: s.reason, message: s.message })),
      already_done: sbs.length - targets.length,
      target,
    })
  } catch (err: any) {
    if (!(err instanceof UpscaleError)) logTaskError('UpscaleAPI', 'episode', { episodeId, error: err.message })
    return badRequest(c, err.message)
  }
})

// DELETE /upscale/storyboards/:id — 清除增强结果（文件保留，只解除关联），导出和字幕改回使用原视频
app.delete('/storyboards/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id))
  if (!sb || sb.deletedAt) return notFound(c, '镜头不存在')
  try {
    await clearUpscale(id)
    return success(c)
  } catch (err: any) {
    return badRequest(c, err.message)
  }
})

export default app
