import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('episodes store a summary with source hash and edited flag', () => {
  const ddl = read('src/db/sqlite-schema.ts')
  for (const col of ['summary TEXT', 'summary_source_hash TEXT', 'summary_edited INTEGER DEFAULT 0', 'summary_updated_at TEXT']) {
    assert.match(ddl, new RegExp(`ALTER TABLE episodes ADD COLUMN ${col}`))
  }
})

test('recap is injected into rewriter/extractor/storyboard agents only, lazily generating missing summaries', () => {
  const agents = read('src/agents/index.ts')
  const svc = read('src/services/episode-summary.ts')
  const mastra = read('src/mastra/index.ts')

  assert.match(agents, /const RECAP_AGENT_TYPES = new Set\(\['script_rewriter', 'extractor', 'storyboard_breaker'\]\)/)
  assert.match(agents, /return \[baseInstructions, skillInstructions, recap, languageDirective\]/)
  // 内部摘要 Agent 不进 validAgentTypes，但挂到 Mastra 实例
  assert.match(agents, /export const auxiliaryAgents/)
  assert.match(mastra, /agents: \{ \.\.\.agentRegistry, \.\.\.auxiliaryAgents \}/)
  // 动态导入 mastra，避免 mastra → agents → episode-summary 的循环依赖
  assert.match(svc, /await import\('\.\.\/mastra\/index\.js'\)/)
  assert.doesNotMatch(svc, /^import .*mastra\/index/m)
  // 过期判断 + 手写不被自动覆盖 + 并发去重
  assert.match(svc, /return state === 'missing' \|\| \(state === 'stale' && !ep\.summaryEdited\)/)
  assert.match(svc, /const inflight = new Map<number, Promise<string>>\(\)/)
  assert.match(svc, /export const RECAP_MAX_EPISODES = 8/)
})

test('episodes route exposes recap and summary endpoints', () => {
  const route = read('src/routes/episodes.ts')
  assert.match(route, /app\.get\('\/:id\/recap'/)
  assert.match(route, /app\.post\('\/:id\/summary'/)
  assert.match(route, /app\.put\('\/:id\/summary'/)
  assert.match(route, /in_recap: i >= prev\.length - RECAP_MAX_EPISODES/)
})
