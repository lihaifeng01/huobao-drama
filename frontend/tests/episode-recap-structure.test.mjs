import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('episode workbench opens the recap dialog', () => {
  const page = read('app/views/drama/episode.vue')
  const dialog = read('app/components/EpisodeRecapDialog.vue')
  const api = read('app/composables/useApi.ts')

  assert.match(page, /class="btn recap-trigger"/)
  assert.match(page, /<EpisodeRecapDialog/)
  assert.match(api, /recap: \(id: number\) => api\.get\(`\/episodes\/\$\{id\}\/recap`\)/)
  assert.match(api, /saveSummary: \(id: number, summary: string\)/)
  assert.match(dialog, /episodeAPI\.generateSummary\(ep\.id/)
  assert.match(dialog, /episodeAPI\.saveSummary\(ep\.id, draft\.value\)/)
  for (const lang of ['zh', 'en', 'ja', 'ko']) {
    const msgs = JSON.parse(read(`app/locales/${lang}.json`))
    assert.ok(msgs.recap?.title && msgs.recap?.state?.stale, `${lang} recap messages`)
  }
})
