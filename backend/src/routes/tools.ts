import { Hono } from 'hono'
import { success, badRequest, notFound } from '../utils/response.js'
import {
  ToolError, createJob, deleteJob, getJob, listJobs, serializeJob, startBurn, startTranscribe, uploadSubtitle,
} from '../services/subtitle-tool.js'

const app = new Hono()

/** 业务错误返回 400（任务不存在返回 404），其他异常交给全局错误处理 */
async function handle(c: any, fn: () => Promise<any>) {
  try {
    return success(c, await fn())
  } catch (err: any) {
    if (err instanceof ToolError && err.message === '任务不存在') return notFound(c, err.message)
    if (err instanceof ToolError || err instanceof Error) return badRequest(c, err.message)
    throw err
  }
}

async function fileField(c: any): Promise<File> {
  const body = await c.req.parseBody()
  const file = body['file']
  if (!file || !(file instanceof File)) throw new ToolError('文件必填')
  return file
}

// GET /tools/subtitle-jobs — 字幕工具任务列表（新的在前）
app.get('/subtitle-jobs', async (c) => success(c, (await listJobs()).map(serializeJob)))

// POST /tools/subtitle-jobs — 上传视频（multipart file），新建任务
app.post('/subtitle-jobs', (c) => handle(c, async () => serializeJob(await createJob(await fileField(c)))))

app.get('/subtitle-jobs/:id', (c) => handle(c, async () => serializeJob(await getJob(Number(c.req.param('id'))))))

// POST /tools/subtitle-jobs/:id/transcribe — 自动识别字幕，body 可带 config_id / model
app.post('/subtitle-jobs/:id/transcribe', (c) => handle(c, async () => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({}))
  await startTranscribe(id, {
    configId: Number(body?.config_id) || undefined,
    model: typeof body?.model === 'string' && body.model.trim() ? body.model.trim() : undefined,
  })
  return serializeJob(await getJob(id))
}))

// POST /tools/subtitle-jobs/:id/subtitle — 手动上传字幕文件（multipart file，.srt / .vtt）
app.post('/subtitle-jobs/:id/subtitle', (c) => handle(c, async () =>
  serializeJob(await uploadSubtitle(Number(c.req.param('id')), await fileField(c)))))

// POST /tools/subtitle-jobs/:id/burn — 合成字幕，body: { font_size, bottom_percent }
app.post('/subtitle-jobs/:id/burn', (c) => handle(c, async () => {
  const id = Number(c.req.param('id'))
  await startBurn(id, await c.req.json().catch(() => ({})))
  return serializeJob(await getJob(id))
}))

// DELETE /tools/subtitle-jobs/:id — 软删除
app.delete('/subtitle-jobs/:id', (c) => handle(c, async () => {
  await getJob(Number(c.req.param('id')))
  await deleteJob(Number(c.req.param('id')))
  return null
}))

export default app
