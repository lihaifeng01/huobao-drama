import { Hono } from 'hono'
import { success, badRequest, notFound } from '../utils/response.js'
import {
  ToolError, createJob, deleteJob, getJob, listJobs, serializeJob, startBurn, startTranscribe, uploadSubtitle,
} from '../services/subtitle-tool.js'
import * as mergeTool from '../services/merge-tool.js'

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

/** 工具任务按用户隔离：只能看到、操作自己的任务（未挂鉴权中间件的测试里不过滤） */
function uid(c: any): number | undefined {
  return c.get('user')?.id
}

async function fileField(c: any): Promise<File> {
  const body = await c.req.parseBody()
  const file = body['file']
  if (!file || !(file instanceof File)) throw new ToolError('文件必填')
  return file
}

// GET /tools/subtitle-jobs — 字幕工具任务列表（新的在前）
app.get('/subtitle-jobs', async (c) => success(c, (await listJobs(uid(c))).map(serializeJob)))

// POST /tools/subtitle-jobs — 上传视频（multipart file），新建任务
app.post('/subtitle-jobs', (c) => handle(c, async () => serializeJob(await createJob(await fileField(c), uid(c)))))

app.get('/subtitle-jobs/:id', (c) => handle(c, async () => serializeJob(await getJob(Number(c.req.param('id')), uid(c)))))

// POST /tools/subtitle-jobs/:id/transcribe — 自动识别字幕，body 可带 config_id / model
app.post('/subtitle-jobs/:id/transcribe', (c) => handle(c, async () => {
  const id = Number(c.req.param('id'))
  await getJob(id, uid(c))
  const body = await c.req.json().catch(() => ({}))
  await startTranscribe(id, {
    configId: Number(body?.config_id) || undefined,
    model: typeof body?.model === 'string' && body.model.trim() ? body.model.trim() : undefined,
  })
  return serializeJob(await getJob(id))
}))

// POST /tools/subtitle-jobs/:id/subtitle — 手动上传字幕文件（multipart file，.srt / .vtt）
app.post('/subtitle-jobs/:id/subtitle', (c) => handle(c, async () => {
  const id = Number(c.req.param('id'))
  await getJob(id, uid(c))
  return serializeJob(await uploadSubtitle(id, await fileField(c)))
}))

// POST /tools/subtitle-jobs/:id/burn — 合成字幕，body: { font_size, bottom_percent }
app.post('/subtitle-jobs/:id/burn', (c) => handle(c, async () => {
  const id = Number(c.req.param('id'))
  await getJob(id, uid(c))
  await startBurn(id, await c.req.json().catch(() => ({})))
  return serializeJob(await getJob(id))
}))

// DELETE /tools/subtitle-jobs/:id — 软删除
app.delete('/subtitle-jobs/:id', (c) => handle(c, async () => {
  await getJob(Number(c.req.param('id')), uid(c))
  await deleteJob(Number(c.req.param('id')))
  return null
}))

// ===== 视频合成 =====

// POST /tools/merge-clips — 上传一个片段（multipart file），返回画面信息
app.post('/merge-clips', (c) => handle(c, async () => mergeTool.uploadClip(await fileField(c))))

// GET /tools/merge-jobs — 合成记录（新的在前）
app.get('/merge-jobs', async (c) => success(c, (await mergeTool.listJobs(uid(c))).map(mergeTool.serializeJob)))

app.get('/merge-jobs/:id', (c) => handle(c, async () => mergeTool.serializeJob(await mergeTool.getJob(Number(c.req.param('id')), uid(c)))))

// POST /tools/merge-jobs — 按顺序合成，body: { clips: [{ url, name }], width?, height?, name? }
app.post('/merge-jobs', (c) => handle(c, async () => mergeTool.serializeJob(await mergeTool.startMerge(await c.req.json().catch(() => ({})), uid(c)))))

// DELETE /tools/merge-jobs/:id — 软删除
app.delete('/merge-jobs/:id', (c) => handle(c, async () => {
  await mergeTool.deleteJob(Number(c.req.param('id')), uid(c))
  return null
}))

export default app
