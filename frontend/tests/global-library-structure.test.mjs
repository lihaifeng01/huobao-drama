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
  assert.match(page, /libraryAPI\.updateFile\(d\.item\.id, \{ folder_id: targetId \}\)/)
  assert.match(page, /<ConfirmDialog/)
  assert.doesNotMatch(page, /[^D]confirm\(/)
})

test('library page supports nested folders with full breadcrumb and folder move', () => {
  const page = read('app/pages/library.vue')
  const useApi = read('app/composables/useApi.ts')

  assert.match(useApi, /moveFolder: \(id: number, parentId: number \| null\)/)
  assert.match(useApi, /folderTree: \(category: LibraryCategory\)/)
  assert.match(page, /libraryAPI\.createFolder\(category\.value, name, location\.value\.type === 'folder' \? location\.value\.id : null\)/)
  assert.match(page, /v-for="\(p, i\) in folderPath"/)
  assert.match(page, /openMoveDialog\('folder', f\)/)
  // 移动文件夹时排除自身子树
  assert.match(page, /const exclude = kind === 'folder' \? subtreeOf\(folders, item\.id\) : new Set\(\)/)
})

test('project pages can apply a library image to characters and scenes', () => {
  const picker = read('app/components/LibraryPicker.vue')
  const detail = read('app/views/drama/detail.vue')
  const episode = read('app/views/drama/episode.vue')

  assert.match(picker, /emit\('select', \{ image_url: m\.image_url, name: m\.name \}\)/)
  assert.match(picker, /libraryAPI\.project\(cat, here\.id\)/)
  for (const view of [detail, episode]) {
    assert.match(view, /<LibraryPicker/)
    assert.match(view, /library-pick-btn/)
    assert.match(view, /toast\.success\(t\('library\.picker\.applied'\)\)/)
  }
  // 道具不在素材库分类内，不出现选择入口
  assert.match(detail, /v-if="g\.kindKey === 'scene'" class="btn btn-icon btn-sm library-pick-btn"/)
  assert.match(detail, /v-if="editTarget\.kindKey !== 'prop'"/)
  assert.match(episode, /v-if="assetDetail\.type !== 'prop'"/)
  // 写回与上传共用同一函数，存相对路径
  assert.match(detail, /const payload = \{ image_url: path, local_path: path \}/)
  assert.match(episode, /const payload = \{ image_url: path, local_path: path \}/)
})
