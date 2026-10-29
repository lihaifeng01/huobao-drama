import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('dialogs opened on top of other dialogs use the nested modal layer', () => {
  const css = read('app/assets/studio.css')
  // 叠加模态层须高于所有普通模态（素材详情 118、图片预览 120），低于菜单
  assert.match(css, /--z-modal-nested: 130;/)
  assert.match(css, /\.overlay\.overlay-nested \{ z-index: var\(--z-modal-nested\); \}/)
  const nested = Number(css.match(/--z-modal-nested: (\d+);/)[1])
  const menu = Number(css.match(/--z-menu: (\d+);/)[1])
  for (const file of ['app/views/drama/detail.vue', 'app/views/drama/episode.vue']) {
    for (const [, z] of read(file).matchAll(/overlay[^{]*\{[^}]*?z-index: (\d+)/g)) {
      assert.ok(Number(z) < nested, `${file}: modal z-index ${z} must stay below nested layer ${nested}`)
    }
  }
  assert.ok(nested < menu)

  assert.match(read('app/components/ConfirmDialog.vue'), /class="overlay overlay-nested"/)
  assert.match(read('app/components/LibraryPicker.vue'), /class="overlay overlay-nested"/)
  assert.match(read('app/views/drama/detail.vue'), /v-if="mergeDialog\.open" class="overlay overlay-nested"/)
})
