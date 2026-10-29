import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('characters carry aliases; extraction matches by name, normalized name or alias', () => {
  const identity = read('src/services/character-identity.ts')
  const tools = read('src/agents/tools/extract-tools.ts')
  const ddl = read('src/db/sqlite-schema.ts')

  assert.match(ddl, /ALTER TABLE characters ADD COLUMN aliases TEXT/)
  assert.match(identity, /export function findCharacterByName\(/)
  assert.match(tools, /findCharacterByName\(charsInProject, char\.name\)/)
  // Agent 给的别名反查只认已有角色本名，撞上别人的别名不合并
  assert.match(tools, /if \(hit\.match && hit\.via !== 'alias'\)/)
  assert.match(tools, /aliases: parseAliases\(c\.aliases\)/)
})

test('merge moves links/looks/history in one transaction and keeps existing visuals', () => {
  const identity = read('src/services/character-identity.ts')
  const route = read('src/routes/characters.ts')

  assert.match(route, /app\.post\('\/:id\/merge'/)
  assert.match(route, /只能合并同一项目中的角色/)
  assert.match(identity, /db\.transaction\(\(tx\) =>/)
  // 源默认形象转为目标造型；跟随本集的镜头视集关联是否随迁移决定是否显式指定
  assert.match(identity, /tx\.insert\(schema\.characterLooks\)/)
  assert.match(identity, /lookId: link\.lookId \?\? \(followsMovedEpisode \? null : defaultLookId\)/)
  assert.match(identity, /rewriteMentions\(sb\.videoPrompt/)
  assert.doesNotMatch(identity, /tx\.delete\(schema\.characters\)/)
})

test('character looks: separate table, episode and shot selection, generation writes back to the look', () => {
  const ddl = read('src/db/sqlite-schema.ts')
  const looks = read('src/routes/characterLooks.ts')
  const gen = read('src/services/generation.ts')
  const episodes = read('src/routes/episodes.ts')
  const storyboards = read('src/routes/storyboards.ts')
  const tools = read('src/agents/tools/storyboard-tools.ts')

  assert.match(ddl, /CREATE TABLE IF NOT EXISTS character_looks/)
  assert.match(ddl, /ALTER TABLE episode_characters ADD COLUMN look_id INTEGER/)
  assert.match(ddl, /ALTER TABLE storyboard_characters ADD COLUMN look_id INTEGER/)
  // 生成造型图：以默认形象为参考图，且不传 characterId（不覆盖主形象）
  assert.match(looks, /const references = char\.imageUrl \? \[char\.imageUrl\] : \[\]/)
  assert.match(looks, /generateImage\(\{\n\s+lookId: look\.id,/)
  assert.doesNotMatch(looks, /generateImage\(\{[^}]*characterId/)
  assert.match(gen, /if \(params\.lookId\) \{\n\s+await db\.update\(schema\.characterLooks\)/)
  // 集级 / 镜头级选择；镜头 0 = 强制默认造型
  assert.match(episodes, /app\.put\('\/:id\/characters\/:characterId\/look'/)
  assert.match(episodes, /episode_look_id:/)
  assert.match(episodes, /character_looks: looksByStoryboard\.get\(row\.id\) \|\| \{\}/)
  assert.match(storyboards, /app\.put\('\/:id\/character-look'/)
  assert.match(storyboards, /body\.look_id === 0/)
  // 重建镜头角色关联时保留造型覆盖（两处 sync 都要）
  for (const src of [storyboards, tools]) assert.match(src, /lookId: lookByChar\.get\(characterId\) \?\? null/)
})

test('drama endpoints hide soft-deleted assets', () => {
  const route = read('src/routes/dramas.ts')
  for (const table of ['characters', 'scenes']) {
    assert.match(route, new RegExp(`and\\(eq\\(schema\\.${table}\\.dramaId, drama\\.id\\), isNull\\(schema\\.${table}\\.deletedAt\\)\\)`))
  }
  for (const table of ['characters', 'scenes', 'props']) {
    assert.match(route, new RegExp(`and\\(eq\\(schema\\.${table}\\.dramaId, id\\), isNull\\(schema\\.${table}\\.deletedAt\\)\\)`))
  }
})
