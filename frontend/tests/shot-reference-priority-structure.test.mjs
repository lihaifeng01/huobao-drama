import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('shot references keep character images first and surface truncation', () => {
  const page = read('app/views/drama/episode.vue')

  // 单一来源：提交的参考图与 @名字 → @图片N 映射共用 collectShotReferences
  assert.match(page, /function getShotReferenceImages\(sb\) \{\n  return collectShotReferences\(sb\)\.kept\.map\(r => r\.imageUrl\)\n\}/)
  assert.match(page, /collectShotReferences\(sb\)\.kept\.forEach\(\(a, i\) =>/)
  // 优先级：角色 → 场景 → 道具
  const body = page.slice(page.indexOf('function collectShotReferences'), page.indexOf('function getShotReferenceImages'))
  const iChar = body.indexOf("push('character'")
  const iScene = body.indexOf("push('scene'")
  const iProp = body.indexOf("push('prop'")
  assert.ok(iChar > 0 && iChar < iScene && iScene < iProp, 'character → scene → prop')
  // 超限不再静默丢弃：检查器标记 + 提示 + 生成时 toast
  assert.match(page, /'is-dropped': droppedRefKeys\.has\(asset\.key\)/)
  assert.match(page, /episode\.ref\.truncatedHint/)
  assert.match(page, /episode\.ref\.truncatedToast/)
  assert.match(page, /episode\.ref\.truncatedBatchToast/)
  // Nuxt 自动导入：本地声明 ref/computed 等会让整个文件丢失对应自动导入
  assert.doesNotMatch(page, /\b(const|let|var) (ref|computed|watch|reactive)\b/)
})
