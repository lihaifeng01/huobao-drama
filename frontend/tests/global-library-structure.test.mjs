import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('header nav exposes the global library tab', () => {
  const layout = read('app/layouts/default.vue')
  assert.match(layout, /<NuxtLink to="\/library" class="nav-link"/)
  assert.match(layout, /t\('layout\.nav\.library'\)/)
  for (const lang of ['zh', 'en', 'ja', 'ko']) {
    const msgs = JSON.parse(read(`app/locales/${lang}.json`))
    assert.ok(msgs.layout.nav.library, `${lang} nav.library`)
    assert.ok(msgs.library.category.character && msgs.library.category.scene, `${lang} library.category`)
  }
})

test('library page splits characters / scenes and browses folders and files', () => {
  const page = read('app/pages/library.vue')
  const useApi = read('app/composables/useApi.ts')

  assert.match(useApi, /export const libraryAPI = \{/)
  assert.match(useApi, /upload: \(category: LibraryCategory, f: File, folderId\?: number \| null\)/)
  // 分类 + 位置均走 URL query
  assert.match(page, /route\.query\.category === 'scene'/)
  assert.match(page, /route\.query\.folder/)
  assert.match(page, /route\.query\.project/)
  // 三类内容：我的文件夹 / 项目文件夹 / 文件
  assert.match(page, /library\.sections\.myFolders/)
  assert.match(page, /library\.sections\.projectFolders/)
  assert.match(page, /library\.sections\.files/)
  // 项目文件夹只读，不可上传
  assert.match(page, /const canUpload = computed\(\(\) => location\.value\.type !== 'project'\)/)
  // 文件操作
  assert.match(page, /libraryAPI\.createFolder/)
  assert.match(page, /libraryAPI\.updateFile\(d\.file\.id, \{ folder_id: folderId \}\)/)
  assert.match(page, /<ConfirmDialog/)
  assert.doesNotMatch(page, /[^D]confirm\(/)
})
