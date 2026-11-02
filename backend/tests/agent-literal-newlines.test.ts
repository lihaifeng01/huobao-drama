import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { initSqliteSchema } from '../src/db/sqlite-schema.ts'
import { fixAgentText, fixLiteralNewlines } from '../src/utils/agent-text.ts'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-literal-newlines-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
const { db, schema } = await import('../src/db/index.ts')
const { storyboardTools } = await import('../src/agents/tools/storyboard-tools.ts')
const { RequestContext } = await import('@mastra/core/request-context')

const LITERAL = '0-3秒：中景。\\n3-6秒：近景。'
const REAL = '0-3秒：中景。\n3-6秒：近景。'

test('fixLiteralNewlines converts backslash-n / backslash-r-n, keeps escaped backslashes and real newlines', () => {
  assert.equal(fixLiteralNewlines(LITERAL), REAL)
  assert.equal(fixLiteralNewlines('a\\r\\nb\\rc'), 'a\nb\nc')
  assert.equal(fixLiteralNewlines('路径 C:\\\\new 保留'), '路径 C:\\\\new 保留')
  assert.equal(fixLiteralNewlines(REAL), REAL)
  assert.equal(fixLiteralNewlines('#林晚说：“我是来救你的。”'), '#林晚说：“我是来救你的。”')
})

test('fixAgentText walks nested tool input and leaves non-strings alone', () => {
  const out = fixAgentText({ storyboards: [{ shot_number: 1, video_prompt: LITERAL, character_ids: [1, 2], scene_id: null }] })
  assert.deepEqual(out, { storyboards: [{ shot_number: 1, video_prompt: REAL, character_ids: [1, 2], scene_id: null }] })
})

test('startup cleanup converts existing rows once and keeps updated_at', () => {
  const sqlite = new Database(':memory:')
  initSqliteSchema(sqlite)
  sqlite.prepare("INSERT INTO dramas (title, created_at, updated_at) VALUES ('d', 't0', 't0')").run()
  sqlite.prepare("INSERT INTO episodes (drama_id, episode_number, title, script_content, content, created_at, updated_at) VALUES (1, 1, 'e', ?, ?, 't0', 't0')").run(LITERAL, LITERAL)
  sqlite.prepare("INSERT INTO storyboards (episode_id, storyboard_number, video_prompt, created_at, updated_at) VALUES (1, 1, ?, 't0', 't0')").run(LITERAL)
  initSqliteSchema(sqlite)
  const sb = sqlite.prepare('SELECT video_prompt, updated_at FROM storyboards').get() as any
  assert.equal(sb.video_prompt, REAL)
  assert.equal(sb.updated_at, 't0')
  const ep = sqlite.prepare('SELECT script_content, content FROM episodes').get() as any
  assert.equal(ep.script_content, REAL)
  assert.equal(ep.content, LITERAL, '用户原始小说 content 不动')
})

test('update_storyboard tool and PUT /storyboards save real newlines', async () => {
  const ts = new Date().toISOString()
  const drama = db.insert(schema.dramas).values({ title: 'd', createdAt: ts, updatedAt: ts }).returning().get()
  const ep = db.insert(schema.episodes).values({ dramaId: drama.id, episodeNumber: 1, title: 'e', createdAt: ts, updatedAt: ts }).returning().get()
  const sb = db.insert(schema.storyboards).values({ episodeId: ep.id, storyboardNumber: 1, createdAt: ts, updatedAt: ts }).returning().get()
  const requestContext = new RequestContext()
  requestContext.set('episodeId', ep.id)
  requestContext.set('dramaId', drama.id)
  const res = await (storyboardTools.updateStoryboard as any).execute({ storyboard_id: sb.id, video_prompt: LITERAL }, { requestContext })
  assert.ok(!res?.error, JSON.stringify(res))
  assert.equal(db.select().from(schema.storyboards).where(eq(schema.storyboards.id, sb.id)).get()!.videoPrompt, REAL)

  const app = new Hono()
  app.route('/storyboards', (await import('../src/routes/storyboards.ts')).default)
  const put = await app.request(`/storyboards/${sb.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ description: LITERAL }) })
  assert.equal(put.status, 200)
  assert.equal(db.select().from(schema.storyboards).where(eq(schema.storyboards.id, sb.id)).get()!.description, REAL)
})
