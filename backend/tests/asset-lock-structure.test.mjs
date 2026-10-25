import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('assets with an image are locked: later extractions do not overwrite their visual description', () => {
  const tools = read('src/agents/tools/extract-tools.ts')

  assert.match(tools, /function isLocked\(row: \{ imageUrl: string \| null \}\): boolean \{\n  return !!row\.imageUrl\n\}/)
  // 读取已有资产时告知 Agent 定妆状态
  assert.equal((tools.match(/locked: isLocked\((c|s|p)\)/g) || []).length, 3)
  // 角色：外貌/妆造只在未定妆时合并，定位/人物设定照常合并
  assert.match(tools, /if \(isLocked\(existing\)\) \{[\s\S]*?save-characters-locked[\s\S]*?\} else \{\n\s+updates\.appearance = char\.appearance \|\| existing\.appearance\n\s+updates\.styling = /)
  assert.match(tools, /role: char\.role \|\| existing\.role,\n\s+description: char\.description \|\| existing\.description,/)
  // 场景：描述/光影只在未定妆时更新
  assert.match(tools, /if \(isLocked\(existing\)\) \{[\s\S]*?save-scenes-locked[\s\S]*?\} else \{\n\s+await db\.update\(schema\.scenes\)/)
  // 道具：外貌与最终提示词只在未定妆时变更
  assert.match(tools, /save-props-locked[\s\S]*?\} else \{\n\s+updates\.description = prop\.description \|\| existing\.description\n\s+updates\.finalPrompt = /)
})
