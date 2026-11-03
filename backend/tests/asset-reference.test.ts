import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_ASSET_REFERENCE_IMAGES,
  cleanReferenceImagesInput,
  parseReferenceImages,
  withReferenceHint,
} from '../src/services/asset-reference.ts'

test('parseReferenceImages: JSON 字符串 / 数组都能解析，统一去掉前导斜杠并去重', () => {
  assert.deepEqual(parseReferenceImages('["static/a.png","/static/a.png","https://x.com/b.png"]'), ['static/a.png', 'https://x.com/b.png'])
  assert.deepEqual(parseReferenceImages(['static/a.png']), ['static/a.png'])
})

test('parseReferenceImages: 脏数据返回空数组或被过滤', () => {
  assert.deepEqual(parseReferenceImages(null), [])
  assert.deepEqual(parseReferenceImages(''), [])
  assert.deepEqual(parseReferenceImages('not json'), [])
  assert.deepEqual(parseReferenceImages('{"a":1}'), [])
  assert.deepEqual(parseReferenceImages(['file:///etc/passwd', 1, '', 'static/ok.png']), ['static/ok.png'])
})

test('cleanReferenceImagesInput: 合法输入写 JSON，空数组 / null 写 null', () => {
  assert.deepEqual(cleanReferenceImagesInput(['static/a.png', '/static/a.png']), { value: '["static/a.png"]' })
  assert.deepEqual(cleanReferenceImagesInput([]), { value: null })
  assert.deepEqual(cleanReferenceImagesInput(null), { value: null })
})

test('cleanReferenceImagesInput: 非数组、非法地址、超过上限都报错', () => {
  assert.ok('error' in cleanReferenceImagesInput('static/a.png'))
  assert.ok('error' in cleanReferenceImagesInput(['../secret.png']))
  assert.ok('error' in cleanReferenceImagesInput([42]))
  const tooMany = Array.from({ length: MAX_ASSET_REFERENCE_IMAGES + 1 }, (_, i) => `static/${i}.png`)
  assert.ok('error' in cleanReferenceImagesInput(tooMany))
})

test('withReferenceHint: 有参考图才追加说明，按素材类型区分', () => {
  assert.equal(withReferenceHint('p', 'character', []), 'p')
  assert.match(withReferenceHint('p', 'character', ['static/a.png']), /^p\n\n参考图说明：.*人物/)
  assert.match(withReferenceHint('p', 'scene', ['static/a.png']), /不要出现任何人物/)
  assert.match(withReferenceHint('p', 'prop', ['static/a.png']), /白底单品/)
})
