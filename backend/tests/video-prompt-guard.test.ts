import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { eq } from 'drizzle-orm'

// Isolated DB/storage; never read or modify user data.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-prompt-guard-'))
process.env.SQLITE_PATH = path.join(root, 'tasks.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
process.env.FFMPEG_BIN = '/usr/bin/false'
process.env.FFPROBE_BIN = '/usr/bin/false'
const { db, schema } = await import('../src/db/index.ts')
const { generateVideo } = await import('../src/services/generation.ts')
const { setContentLanguage } = await import('../src/services/app-settings.ts')
const { withNoSubtitleDirective } = await import('../src/services/video-prompt-guard.ts')

test('追加「不要生成字幕」：按内容语言、只追加一次、空提示词不处理', () => {
  const zh = withNoSubtitleDirective('0-3秒：@小明说：「你好」', 'zh')
  assert.equal(zh, '0-3秒：@小明说：「你好」\n画面中不要出现字幕、对白文字或水印。')
  assert.equal(withNoSubtitleDirective(zh, 'zh'), zh)
  // 语言切换后，已带其他语言约束的提示词也不重复追加
  assert.equal(withNoSubtitleDirective(zh, 'en'), zh)
  assert.match(withNoSubtitleDirective('A man walks in.', 'en'), /\nDo not render subtitles/)
  assert.equal(withNoSubtitleDirective('', 'zh'), '')
})

test('提交给视频服务的提示词带有约束', async () => {
  const bodies: any[] = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', d => raw += d)
    req.on('end', () => {
      if (req.method === 'POST') bodies.push(JSON.parse(raw || '{}'))
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ task: { id: 'up-1', status: 'failed', error: { message: 'stop here' } } }))
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as any).port}`
  const ts = new Date().toISOString()
  const config = db.insert(schema.aiServiceConfigs).values({ serviceType: 'video', provider: 'minimax', name: 't', baseUrl: base, apiKey: 'k', model: '["MiniMax-H3"]', createdAt: ts, updatedAt: ts }).returning().get()
  try {
    setContentLanguage('zh')
    const id = await generateVideo({ prompt: '@小明说：「你好」', configId: config.id, duration: 6 })
    // 等任务进入终态再关服务，否则后台轮询会一直重试、进程不退出
    const deadline = Date.now() + 20_000
    let task = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get()!
    while (task.status === 'processing' && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50))
      task = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get()!
    }
    assert.equal(task.status, 'failed')
    assert.match(task.prompt || '', /画面中不要出现字幕、对白文字或水印。$/)
    assert.match(JSON.stringify(bodies[0]), /画面中不要出现字幕、对白文字或水印/)
  } finally {
    await new Promise<void>(r => server.close(() => r()))
  }
})

test.after(async () => { await fs.rm(root, { recursive: true, force: true }) })
