import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const page = readFileSync(new URL('../app/views/drama/episode.vue', import.meta.url), 'utf8')

test('regenerating a shot that already has a video stays pending after task refresh', () => {
  // 已有视频不能再让 processing 任务被跳过，否则重绘中状态在 refresh 后立刻消失
  assert.match(page, /if \(t\.status === 'processing'\) pending\.add\(sbId\)\n\s*else if \(t\.status === 'failed' && !hasVid\(/)
  assert.doesNotMatch(page, /if \(hasVid\(sbs\.value\.find\(s => s\.id === sbId\)\)\) continue/)
})

test('video history shows a placeholder while generating and the buttons are disabled', () => {
  assert.match(page, /v-if="sbVideoHistory\.length \|\| isPendingVideo\(selectedSb\?\.id\)" class="video-player-history"/)
  assert.match(page, /v-if="isPendingVideo\(selectedSb\?\.id\)"\s*class="video-history-item is-pending"/)
  assert.match(page, /:disabled="isPendingVideo\(selectedSb\?\.id\)"/)
  assert.match(page, /:disabled="isPendingVideo\(task\.storyboard\?\.id\)"/)
  assert.match(page, /if \(isPendingVideo\(sb\?\.id\)\) return t\('episode\.asset\.generating'\)/)
})

test('placeholder tooltip text exists in every locale', () => {
  for (const lang of ['zh', 'en', 'ja', 'ko']) {
    const vid = JSON.parse(readFileSync(new URL(`../app/locales/${lang}.json`, import.meta.url), 'utf8')).episode.vid
    assert.ok(vid.historyPendingTitle, lang)
  }
})

test('task polling does not reset the history preview (Set as main stays available)', () => {
  // 单个 getter 返回数组会在每次 refresh 时被判定为变化，导致预览被清空
  assert.doesNotMatch(page, /watch\(\(\) => \[selectedSb\.value\?\.id, getVideoUrl\(selectedSb\.value\)\]/)
  assert.match(page, /watch\(\[\(\) => selectedSb\.value\?\.id, \(\) => getVideoUrl\(selectedSb\.value\)\], \(\[id\], \[oldId\]\) =>/)
  assert.match(page, /loadSbVideoHistory\(\{ keepPreview: id === oldId \}\)/)
})
