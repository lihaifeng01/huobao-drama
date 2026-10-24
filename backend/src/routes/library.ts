import { Hono } from 'hono'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import sharp from 'sharp'
import { db, getInsertId, schema } from '../db/index.js'
import { success, created, badRequest, notFound, now } from '../utils/response.js'
import { toSnakeCase } from '../utils/transform.js'
import { saveUploadedFile, generateImageThumb, getAbsolutePath } from '../utils/storage.js'

/**
 * 全局素材库 — 项目之外聚合查看角色/场景素材
 * - 项目文件夹：每个未删除项目自动对应一个，内容实时取自该项目的 characters / scenes（只读）
 * - 我的文件夹：用户自建，可多级嵌套（parent_id），存放用户上传的素材文件
 * - 根目录文件：folder_id 为空的上传文件
 */
const app = new Hono()

const CATEGORIES = ['character', 'scene'] as const
type Category = typeof CATEGORIES[number]

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
const IMAGE_MAX = 20 * 1024 * 1024 // 20MB
const NAME_MAX = 100

type FolderRow = typeof schema.libraryFolders.$inferSelect
type FileRow = typeof schema.libraryFiles.$inferSelect

function parseCategory(raw: string | undefined): Category | null {
  return CATEGORIES.includes(raw as Category) ? raw as Category : null
}

function cleanName(raw: unknown): string {
  return String(raw ?? '').trim().slice(0, NAME_MAX)
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i).toLowerCase() : ''
}

async function findFolder(id: number, category?: Category) {
  const conds = [eq(schema.libraryFolders.id, id), isNull(schema.libraryFolders.deletedAt)]
  if (category) conds.push(eq(schema.libraryFolders.category, category))
  const [folder] = await db.select().from(schema.libraryFolders).where(and(...conds))
  return folder
}

/** 同一父目录下文件夹不重名 */
async function folderNameTaken(category: Category, parentId: number | null, name: string, exceptId?: number) {
  const rows = await db.select().from(schema.libraryFolders)
    .where(and(eq(schema.libraryFolders.category, category), eq(schema.libraryFolders.name, name), isNull(schema.libraryFolders.deletedAt)))
  return rows.some(r => (r.parentId ?? null) === parentId && r.id !== exceptId)
}

async function loadCategory(category: Category) {
  const folders = await db.select().from(schema.libraryFolders)
    .where(and(eq(schema.libraryFolders.category, category), isNull(schema.libraryFolders.deletedAt)))
    .orderBy(desc(schema.libraryFolders.updatedAt))
  const files = await db.select().from(schema.libraryFiles)
    .where(and(eq(schema.libraryFiles.category, category), isNull(schema.libraryFiles.deletedAt)))
    .orderBy(desc(schema.libraryFiles.createdAt))
  return { folders, files }
}

/** 文件夹自身 + 全部后代 id */
function subtreeIds(folders: FolderRow[], rootId: number): Set<number> {
  const ids = new Set([rootId])
  let grew = true
  while (grew) {
    grew = false
    for (const f of folders) {
      if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) { ids.add(f.id); grew = true }
    }
  }
  return ids
}

/** 根 → 当前 的路径（防御环：最多走 folders.length 步） */
function folderPath(folders: FolderRow[], id: number) {
  const byId = new Map(folders.map(f => [f.id, f]))
  const path: { id: number; name: string }[] = []
  let cur = byId.get(id)
  for (let i = 0; cur && i <= folders.length; i++) {
    path.unshift({ id: cur.id, name: cur.name })
    cur = cur.parentId ? byId.get(cur.parentId) : undefined
  }
  return path
}

/** 文件夹卡片：count 为子树内文件总数，folder_count 为直接子文件夹数，cover 取子树内最新文件 */
function folderCard(folders: FolderRow[], files: FileRow[], f: FolderRow) {
  const ids = subtreeIds(folders, f.id)
  const inside = files.filter(x => x.folderId && ids.has(x.folderId))
  return {
    id: f.id,
    parent_id: f.parentId ?? null,
    name: f.name,
    count: inside.length,
    folder_count: folders.filter(x => x.parentId === f.id).length,
    cover: inside[0]?.imageUrl || '',
    updated_at: f.updatedAt,
  }
}

function serializeFile(row: FileRow) {
  return toSnakeCase(row)
}

/** 项目内素材统一成库条目形态：角色取名称/外貌，场景取地点/描述 */
function projectItem(category: Category, row: any) {
  if (category === 'character') {
    return {
      id: row.id,
      name: row.name,
      description: row.appearance || row.description || '',
      tag: row.role || '',
      image_url: row.imageUrl || '',
      updated_at: row.updatedAt,
    }
  }
  return {
    id: row.id,
    name: row.location,
    description: row.prompt || '',
    tag: row.time || '',
    image_url: row.imageUrl || '',
    updated_at: row.updatedAt,
  }
}

async function projectRows(category: Category, dramaIds: number[]) {
  if (!dramaIds.length) return []
  const table = category === 'character' ? schema.characters : schema.scenes
  return db.select().from(table)
    .where(and(inArray(table.dramaId, dramaIds), isNull(table.deletedAt)))
}

// GET /library/:category — 根目录：项目文件夹 + 顶层我的文件夹 + 根目录文件
app.get('/:category', async (c) => {
  const category = parseCategory(c.req.param('category'))
  if (!category) return badRequest(c, '素材分类无效')

  const dramas = await db.select().from(schema.dramas)
    .where(isNull(schema.dramas.deletedAt))
    .orderBy(desc(schema.dramas.updatedAt))
  const rows = await projectRows(category, dramas.map(d => d.id))
  const projectFolders = dramas.map((d) => {
    const items = rows.filter(r => r.dramaId === d.id)
    return {
      drama_id: d.id,
      name: d.title,
      count: items.length,
      cover: items.find(r => r.imageUrl)?.imageUrl || '',
      updated_at: d.updatedAt,
    }
  })

  const { folders, files } = await loadCategory(category)
  return success(c, {
    project_folders: projectFolders,
    folders: folders.filter(f => !f.parentId).map(f => folderCard(folders, files, f)),
    files: files.filter(x => !x.folderId).map(serializeFile),
  })
})

// GET /library/:category/folders — 全部文件夹（扁平，含 parent_id），供移动/选择弹窗构建树
app.get('/:category/folders', async (c) => {
  const category = parseCategory(c.req.param('category'))
  if (!category) return badRequest(c, '素材分类无效')
  const { folders } = await loadCategory(category)
  return success(c, folders.map(f => ({ id: f.id, parent_id: f.parentId ?? null, name: f.name })))
})

// GET /library/:category/folders/:id — 文件夹内：路径 + 子文件夹 + 文件
app.get('/:category/folders/:id', async (c) => {
  const category = parseCategory(c.req.param('category'))
  if (!category) return badRequest(c, '素材分类无效')
  const folder = await findFolder(Number(c.req.param('id')), category)
  if (!folder) return notFound(c, '文件夹不存在')
  const { folders, files } = await loadCategory(category)
  return success(c, {
    folder: toSnakeCase(folder),
    path: folderPath(folders, folder.id),
    folders: folders.filter(f => f.parentId === folder.id).map(f => folderCard(folders, files, f)),
    files: files.filter(x => x.folderId === folder.id).map(serializeFile),
  })
})

// GET /library/:category/projects/:dramaId — 项目文件夹内素材（只读）
app.get('/:category/projects/:dramaId', async (c) => {
  const category = parseCategory(c.req.param('category'))
  if (!category) return badRequest(c, '素材分类无效')
  const dramaId = Number(c.req.param('dramaId'))
  const [drama] = await db.select().from(schema.dramas)
    .where(and(eq(schema.dramas.id, dramaId), isNull(schema.dramas.deletedAt)))
  if (!drama) return notFound(c, '项目不存在')
  const rows = await projectRows(category, [dramaId])
  return success(c, {
    drama: { id: drama.id, title: drama.title },
    items: rows.map(r => projectItem(category, r)),
  })
})

// POST /library/:category/folders — 新建文件夹（parent_id 为空即顶层）
app.post('/:category/folders', async (c) => {
  const category = parseCategory(c.req.param('category'))
  if (!category) return badRequest(c, '素材分类无效')
  const body = await c.req.json()
  const name = cleanName(body.name)
  if (!name) return badRequest(c, '文件夹名称必填')
  let parentId: number | null = null
  if (body.parent_id) {
    const parent = await findFolder(Number(body.parent_id), category)
    if (!parent) return badRequest(c, '上级文件夹不存在')
    parentId = parent.id
  }
  if (await folderNameTaken(category, parentId, name)) return badRequest(c, '文件夹名称已存在')
  const ts = now()
  const res = await db.insert(schema.libraryFolders).values({ category, parentId, name, createdAt: ts, updatedAt: ts })
  const folder = await findFolder(getInsertId(res))
  return created(c, toSnakeCase(folder!))
})

// PUT /library/folders/:id — 重命名 / 移动（parent_id 为 null 移到顶层；不能移入自身或其子文件夹）
app.put('/folders/:id', async (c) => {
  const folder = await findFolder(Number(c.req.param('id')))
  if (!folder) return notFound(c, '文件夹不存在')
  const category = folder.category as Category
  const body = await c.req.json()
  const updates: Record<string, any> = { updatedAt: now() }
  let name = folder.name
  let parentId = folder.parentId ?? null
  if (body.name !== undefined) {
    name = cleanName(body.name)
    if (!name) return badRequest(c, '文件夹名称必填')
    updates.name = name
  }
  if (body.parent_id !== undefined) {
    if (body.parent_id === null || body.parent_id === '') {
      parentId = null
    } else {
      const parent = await findFolder(Number(body.parent_id), category)
      if (!parent) return badRequest(c, '上级文件夹不存在')
      const { folders } = await loadCategory(category)
      if (subtreeIds(folders, folder.id).has(parent.id)) return badRequest(c, '不能移动到自身或其子文件夹')
      parentId = parent.id
    }
    updates.parentId = parentId
  }
  if (await folderNameTaken(category, parentId, name, folder.id)) return badRequest(c, '文件夹名称已存在')
  await db.update(schema.libraryFolders).set(updates).where(eq(schema.libraryFolders.id, folder.id))
  return success(c)
})

// DELETE /library/folders/:id — 软删除文件夹及其全部子文件夹、文件
app.delete('/folders/:id', async (c) => {
  const folder = await findFolder(Number(c.req.param('id')))
  if (!folder) return notFound(c, '文件夹不存在')
  const { folders } = await loadCategory(folder.category as Category)
  const ids = [...subtreeIds(folders, folder.id)]
  const ts = now()
  await db.update(schema.libraryFiles).set({ deletedAt: ts, updatedAt: ts })
    .where(and(inArray(schema.libraryFiles.folderId, ids), isNull(schema.libraryFiles.deletedAt)))
  await db.update(schema.libraryFolders).set({ deletedAt: ts, updatedAt: ts }).where(inArray(schema.libraryFolders.id, ids))
  return success(c)
})

// POST /library/:category/files — 上传素材图片（multipart: file, folder_id?, name?, description?）
app.post('/:category/files', async (c) => {
  const category = parseCategory(c.req.param('category'))
  if (!category) return badRequest(c, '素材分类无效')
  const body = await c.req.parseBody()
  const file = body['file']
  if (!file || !(file instanceof File)) return badRequest(c, '文件必填')
  if (!IMAGE_EXT.has(extOf(file.name))) return badRequest(c, `仅支持 ${Array.from(IMAGE_EXT).join('/')} 格式的图片`)

  let folderId: number | null = null
  if (body['folder_id']) {
    const folder = await findFolder(Number(body['folder_id']), category)
    if (!folder) return badRequest(c, '文件夹不存在')
    folderId = folder.id
  }

  const buffer = await file.arrayBuffer()
  if (buffer.byteLength > IMAGE_MAX) return badRequest(c, `图片大小不能超过 ${IMAGE_MAX / 1024 / 1024}MB`)
  const path = await saveUploadedFile(buffer, 'uploads', file.name)
  await generateImageThumb(path)
  let width: number | null = null
  let height: number | null = null
  try {
    const meta = await sharp(getAbsolutePath(path)).metadata()
    width = meta.width ?? null
    height = meta.height ?? null
  } catch { /* 尺寸读取失败不影响上传 */ }

  const name = cleanName(body['name']) || cleanName(file.name.replace(/\.[^.]+$/, '')) || file.name
  const ts = now()
  const res = await db.insert(schema.libraryFiles).values({
    category,
    folderId,
    name,
    description: typeof body['description'] === 'string' ? body['description'] : '',
    imageUrl: path,
    fileSize: buffer.byteLength,
    width,
    height,
    createdAt: ts,
    updatedAt: ts,
  })
  const [row] = await db.select().from(schema.libraryFiles).where(eq(schema.libraryFiles.id, getInsertId(res)))
  if (folderId) await db.update(schema.libraryFolders).set({ updatedAt: ts }).where(eq(schema.libraryFolders.id, folderId))
  return created(c, serializeFile(row))
})

// PUT /library/files/:id — 重命名 / 改描述 / 移动（folder_id 为 null 移回根目录）
app.put('/files/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [file] = await db.select().from(schema.libraryFiles)
    .where(and(eq(schema.libraryFiles.id, id), isNull(schema.libraryFiles.deletedAt)))
  if (!file) return notFound(c, '文件不存在')
  const body = await c.req.json()
  const updates: Record<string, any> = { updatedAt: now() }
  if (body.name !== undefined) {
    const name = cleanName(body.name)
    if (!name) return badRequest(c, '名称必填')
    updates.name = name
  }
  if (body.description !== undefined) updates.description = String(body.description ?? '')
  if (body.folder_id !== undefined) {
    if (body.folder_id === null || body.folder_id === '') {
      updates.folderId = null
    } else {
      const folder = await findFolder(Number(body.folder_id), file.category as Category)
      if (!folder) return badRequest(c, '文件夹不存在')
      updates.folderId = folder.id
    }
  }
  await db.update(schema.libraryFiles).set(updates).where(eq(schema.libraryFiles.id, id))
  return success(c)
})

// DELETE /library/files/:id — 软删除
app.delete('/files/:id', async (c) => {
  const id = Number(c.req.param('id'))
  await db.update(schema.libraryFiles).set({ deletedAt: now(), updatedAt: now() }).where(eq(schema.libraryFiles.id, id))
  return success(c)
})

export default app
