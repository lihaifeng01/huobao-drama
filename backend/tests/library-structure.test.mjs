import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('library tables are created at startup and mapped in drizzle', () => {
  const ddl = read('src/db/sqlite-schema.ts')
  const schema = read('src/db/schema.ts')

  assert.match(ddl, /CREATE TABLE IF NOT EXISTS library_folders/)
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS library_files/)
  assert.match(schema, /export const libraryFolders = sqliteTable\('library_folders'/)
  assert.match(schema, /export const libraryFiles = sqliteTable\('library_files'/)
})

test('library route aggregates project folders, user folders and uploaded files', () => {
  const route = read('src/routes/library.ts')
  const index = read('src/index.ts')

  assert.match(index, /api\.route\('\/library', library\)/)
  // 仅角色 / 场景两类
  assert.match(route, /const CATEGORIES = \['character', 'scene'\] as const/)
  // 根目录：项目文件夹（由 dramas 实时聚合）+ 我的文件夹 + 根目录文件
  assert.match(route, /project_folders: projectFolders/)
  assert.match(route, /folders: userFolders/)
  assert.match(route, /files: files\.filter\(x => !x\.folderId\)/)
  // 项目文件夹只读：只有 GET
  assert.match(route, /app\.get\('\/:category\/projects\/:dramaId'/)
  assert.doesNotMatch(route, /app\.(post|put|delete)\('\/:category\/projects/)
  // 上传只收图片，生成缩略图
  assert.match(route, /IMAGE_EXT\.has\(extOf\(file\.name\)\)/)
  assert.match(route, /generateImageThumb\(path\)/)
  // 软删除
  assert.doesNotMatch(route, /db\.delete\(/)
})
