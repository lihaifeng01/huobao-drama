import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('shot references resolve the character look: shot override → episode look → default', () => {
  const helper = read('app/composables/useCharacterIdentity.ts')
  const page = read('app/views/drama/episode.vue')

  assert.match(helper, /const lookId = shotLookId === 0 \? null : \(shotLookId \?\? char\.episode_look_id \?\? null\)/)
  assert.match(page, /push\('character', char\.id, char\.name \|\| '', resolveCharacterLook\(char, sb\)\.imageUrl\)/)
  assert.match(page, /const imageUrl = resolveCharacterLook\(char, sb\)\.imageUrl/)
  assert.match(page, /episodeAPI\.setCharacterLook\(episode\.value\.id, c\.id, lookId\)/)
  assert.match(page, /storyboardAPI\.setCharacterLook\(sb\.id, char\.id, lookId\)/)
  assert.match(page, /<CharacterLooksPanel/)
})

test('project detail edits aliases, manages looks and merges duplicates', () => {
  const page = read('app/views/drama/detail.vue')
  const api = read('app/composables/useApi.ts')

  assert.match(api, /merge: \(id: number, sourceIds: number\[\]\) =>/)
  assert.match(api, /export const lookAPI = \{/)
  assert.match(page, /aliases: editDraft\.aliases/)
  assert.match(page, /<CharacterLooksPanel :character="editTarget"/)
  assert.match(page, /characterAPI\.merge\(d\.target\.id, d\.selected\)/)
  // 合并弹窗须 Teleport 到 body，否则被素材详情弹窗盖住
  assert.match(page, /<Teleport to="body">\n\s+<div v-if="mergeDialog\.open"/)
})

test('locale messages never contain a bare @ (vue-i18n linked-message syntax breaks rendering)', () => {
  for (const lang of ['zh', 'en', 'ja', 'ko']) {
    const msgs = JSON.parse(read(`app/locales/${lang}.json`))
    const bad = []
    const walk = (o, p) => {
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === 'string') { if (/@/.test(v.replace(/\{'@'\}/g, ''))) bad.push(p + k) } else walk(v, p + k + '.')
      }
    }
    walk(msgs, '')
    assert.deepEqual(bad, [], `${lang}: escape @ as {'@'}`)
    assert.ok(msgs.looks?.title && msgs.identity?.aliases, `${lang} has looks/identity`)
  }
})
