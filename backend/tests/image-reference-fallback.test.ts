import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { eq } from 'drizzle-orm'

// Isolated DB/storage; never read or modify user tasks/configurations.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-ref-fallback-'))
process.env.SQLITE_PATH = path.join(root, 'tasks.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
const { db, schema } = await import('../src/db/index.ts')
const { generateImage } = await import('../src/services/generation.ts')
const { OpenAIImageAdapter, isSiliconFlow, siliconFlowReferenceField } = await import('../src/services/adapters/openai-image.ts')

// 参考图（角色默认形象）落在 static/uploads 下，与真实上传路径一致
const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#c0392b' } }).png().toBuffer()
await fs.mkdir(path.join(root, 'static', 'uploads'), { recursive: true })
await fs.writeFile(path.join(root, 'static', 'uploads', 'portrait.png'), png)
const portrait = 'static/uploads/portrait.png'

// 拦截外部图片服务：硅基流动 / 不带 edits 端点的 OpenAI 兼容中转 / 生成结果下载
type Call = { url: string; json?: any; multipart?: string[] }
let calls: Call[] = []
let editsStatus = 404
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input instanceof Request ? input.url : input)
  if (url.startsWith('https://img.example.test/')) return new Response(png, { headers: { 'Content-Type': 'image/png' } })
  if (url.includes('api.siliconflow.cn') || url.includes('relay.example.test')) {
    const call: Call = { url }
    if (init?.body instanceof FormData) call.multipart = [...init.body.keys()]
    else if (typeof init?.body === 'string') call.json = JSON.parse(init.body)
    calls.push(call)
    if (url.endsWith('/images/edits')) return new Response('{"error":"Not Found"}', { status: editsStatus })
    // 硅基流动格式：{ images: [{ url }] }
    return Response.json({ images: [{ url: 'https://img.example.test/out.png' }], seed: 1 })
  }
  return realFetch(input, init)
}) as typeof fetch

const ts = new Date().toISOString()
const config = (baseUrl: string) => db.insert(schema.aiServiceConfigs)
  .values({ serviceType: 'image', provider: 'openai', name: baseUrl, baseUrl, apiKey: 'k', model: '["x"]', createdAt: ts, updatedAt: ts })
  .returning().get()
const siliconflow = config('https://api.siliconflow.cn')
const relay = config('https://relay.example.test')
const char = db.insert(schema.characters).values({ dramaId: 1, name: '林小雨', imageUrl: portrait, createdAt: ts, updatedAt: ts }).returning().get()

const task = (id: number) => db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get()!
async function settle(id: number) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const row = task(id)
    if (row.status !== 'processing') return { ...row, params: JSON.parse(row.params || '{}') }
    await new Promise(r => setTimeout(r, 20))
  }
  throw new Error(`task ${id} did not finish`)
}
async function generateLook(configId: number, model: string, references = [portrait]) {
  calls = []
  const look = db.insert(schema.characterLooks).values({ characterId: char.id, name: model, createdAt: ts, updatedAt: ts }).returning().get()
  const id = await generateImage({ lookId: look.id, dramaId: 1, prompt: '婚纱造型', model, referenceImages: references, configId })
  const row = await settle(id)
  const lookRow = db.select().from(schema.characterLooks).where(eq(schema.characterLooks.id, look.id)).get()!
  return { row, look: lookRow }
}

test('SiliconFlow host and per-model reference field are recognised', () => {
  assert.equal(isSiliconFlow('https://api.siliconflow.cn'), true)
  assert.equal(isSiliconFlow('https://api.siliconflow.com/v1'), true)
  assert.equal(isSiliconFlow('https://siliconflow.cn.evil.example'), false)
  assert.equal(isSiliconFlow('https://api.openai.com'), false)
  assert.equal(siliconFlowReferenceField('Qwen/Qwen-Image-Edit-2509'), 'image')
  assert.equal(siliconFlowReferenceField('Kwai-Kolors/Kolors'), 'image')
  assert.equal(siliconFlowReferenceField('black-forest-labs/FLUX.1-Kontext-pro'), 'input_image')
  assert.equal(siliconFlowReferenceField('Tongyi-MAI/Z-Image-Turbo'), null)
})

test('SiliconFlow parses { images: [{ url }] } responses', () => {
  const adapter = new OpenAIImageAdapter()
  assert.deepEqual(adapter.parseGenerateResponse({ images: [{ url: 'https://x/y.png' }] }), { isAsync: false, imageUrl: 'https://x/y.png' })
})

test('SiliconFlow edit model: reference goes into generations JSON as image (no /images/edits)', async () => {
  const { row, look } = await generateLook(siliconflow.id, 'Qwen/Qwen-Image-Edit-2509')
  assert.equal(row.status, 'completed', row.errorMsg || '')
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /\/v1\/images\/generations$/)
  assert.match(calls[0].json.image, /^data:image\//)
  assert.equal(row.params.referenceFallback, undefined)
  assert.ok(look.imageUrl, 'look image written back')
})

test('SiliconFlow Kontext model uses input_image', async () => {
  const { row } = await generateLook(siliconflow.id, 'black-forest-labs/FLUX.1-Kontext-pro')
  assert.equal(row.status, 'completed')
  assert.match(calls[0].json.input_image, /^data:image\//)
  assert.equal(calls[0].json.image, undefined)
})

test('SiliconFlow text-to-image model: reference dropped, generated from text, fallback recorded', async () => {
  const { row, look } = await generateLook(siliconflow.id, 'Tongyi-MAI/Z-Image-Turbo')
  assert.equal(row.status, 'completed', row.errorMsg || '')
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /\/v1\/images\/generations$/)
  assert.equal(calls[0].json.image, undefined)
  assert.equal(row.params.referenceFallback, 'model_unsupported')
  assert.equal(row.params.lookId, look.id, 'existing params preserved')
  assert.ok(look.imageUrl)
})

test('OpenAI-compatible relay without /images/edits: 404 → retried text-only via generations', async () => {
  editsStatus = 404
  const { row, look } = await generateLook(relay.id, 'some-image-model')
  assert.equal(row.status, 'completed', row.errorMsg || '')
  assert.deepEqual(calls.map(c => new URL(c.url).pathname), ['/v1/images/edits', '/v1/images/generations'])
  assert.deepEqual(calls[0].multipart, ['model', 'prompt', 'size', 'n', 'image[]'])
  assert.equal(calls[1].json.image, undefined)
  assert.equal(row.params.referenceFallback, 'request_rejected')
  assert.ok(look.imageUrl)
})

test('auth errors are not treated as "references unsupported": no retry, task fails', async () => {
  editsStatus = 401
  const { row } = await generateLook(relay.id, 'some-image-model')
  assert.equal(row.status, 'failed')
  assert.equal(calls.length, 1)
  assert.equal(row.params.referenceFallback, undefined)
  editsStatus = 404
})

test('no reference images: plain generations, no fallback flag', async () => {
  const { row } = await generateLook(siliconflow.id, 'Tongyi-MAI/Z-Image-Turbo', [])
  assert.equal(row.status, 'completed')
  assert.equal(calls[0].json.image, undefined)
  assert.equal(row.params.referenceFallback, undefined)
})
