<template>
  <div
    class="page"
    @dragenter.prevent="onDragEnter"
    @dragover.prevent
    @dragleave="onDragLeave"
    @drop.prevent="onDrop"
  >
    <!-- 头部：标题 + 分类切换 + 操作 -->
    <div class="library-head">
      <div class="head-left">
        <h1 class="library-title">{{ t('library.title') }}</h1>
        <span class="library-sub">{{ t('library.sub') }}</span>
      </div>
      <div class="seg category-seg" role="tablist">
        <button
          v-for="c in categories"
          :key="c.value"
          type="button"
          role="tab"
          class="seg-item"
          :class="{ on: category === c.value }"
          :aria-selected="category === c.value"
          @click="switchCategory(c.value)"
        >
          <component :is="c.icon" :size="13" :stroke-width="1.9" />
          {{ c.label }}
        </button>
      </div>
      <div class="head-actions">
        <button v-if="location.type !== 'project'" type="button" class="btn" @click="openNameDialog('createFolder')">
          <FolderPlus :size="14" :stroke-width="1.8" />
          {{ t('library.newFolder') }}
        </button>
        <button v-if="canUpload" type="button" class="btn btn-primary" :disabled="uploading" @click="fileInput?.click()">
          <Loader2 v-if="uploading" :size="14" class="animate-spin" />
          <Upload v-else :size="14" :stroke-width="2" />
          {{ uploading ? t('library.uploading', { done: uploadProgress.done, total: uploadProgress.total }) : t('library.upload') }}
        </button>
        <a v-if="location.type === 'project'" class="btn" :href="`/drama/${location.id}`" @click.prevent="navigateTo(`/drama/${location.id}`)">
          <ExternalLink :size="14" :stroke-width="1.8" />
          {{ t('library.openProject') }}
        </a>
        <input ref="fileInput" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden @change="onFilePicked" />
      </div>
    </div>

    <!-- 面包屑 + 搜索 -->
    <div class="toolbar">
      <nav class="crumbs" aria-label="breadcrumb">
        <button type="button" class="crumb" :class="{ current: location.type === 'root' }" @click="goRoot">
          {{ categoryLabel }}
        </button>
        <template v-if="location.type === 'folder'">
          <template v-for="(p, i) in folderPath" :key="p.id">
            <ChevronRight :size="13" class="crumb-sep" />
            <span v-if="i === folderPath.length - 1" class="crumb current"><span class="truncate">{{ p.name }}</span></span>
            <button v-else type="button" class="crumb" @click="openFolder(p)"><span class="truncate">{{ p.name }}</span></button>
          </template>
        </template>
        <template v-else-if="location.type === 'project'">
          <ChevronRight :size="13" class="crumb-sep" />
          <span class="crumb current">
            <span class="truncate">{{ currentTitle }}</span>
            <span class="tag tag-accent">{{ t('library.projectTag') }}</span>
          </span>
        </template>
      </nav>
      <label class="search-box">
        <Search :size="14" :stroke-width="1.8" />
        <input v-model.trim="keyword" class="input" :placeholder="t('library.searchPlaceholder')" />
      </label>
    </div>

    <p v-if="location.type === 'project'" class="readonly-hint dim">
      <Info :size="12" :stroke-width="1.8" />
      {{ t('library.readonlyHint') }}
    </p>

    <!-- 加载骨架 -->
    <div v-if="loading" class="tile-grid">
      <div v-for="i in 8" :key="i" class="card skeleton-card">
        <div class="skeleton-cover"></div>
        <div class="skeleton-body"><div class="skeleton-line w-60"></div></div>
      </div>
    </div>

    <!-- 根目录：我的文件夹 / 项目文件夹 / 文件；文件夹内：子文件夹 / 文件 -->
    <template v-else-if="location.type !== 'project'">
      <section v-if="visibleFolders.length" class="lib-section">
        <div class="section-head">
          <Folder :size="14" :stroke-width="1.9" />
          <span>{{ location.type === 'root' ? t('library.sections.myFolders') : t('library.sections.subFolders') }}</span>
          <span class="section-count">{{ visibleFolders.length }}</span>
        </div>
        <div class="tile-grid">
          <article
            v-for="f in visibleFolders"
            :key="'folder-' + f.id"
            class="card tile folder-tile"
            tabindex="0"
            role="button"
            @click="openFolder(f)"
            @keydown.enter.prevent="openFolder(f)"
          >
            <div class="tile-cover">
              <img v-if="f.cover" :src="thumbOf(src(f.cover))" loading="lazy" @error="thumbFallback($event, src(f.cover))" />
              <div v-else class="tile-empty"><Folder :size="26" :stroke-width="1.3" /></div>
              <div class="tile-more" @click.stop>
                <AppMenu
                  :open="menuKey === 'folder-' + f.id"
                  placement="bottom-end"
                  :min-width="130"
                  @update:open="(v) => { menuKey = v ? 'folder-' + f.id : null }"
                >
                  <template #trigger>
                    <button type="button" class="btn btn-icon btn-sm more-btn" :title="t('common.more')"><MoreHorizontal :size="15" /></button>
                  </template>
                  <AppMenuItem @click="menuKey = null; openNameDialog('renameFolder', f)">{{ t('library.actions.rename') }}</AppMenuItem>
                  <AppMenuItem @click="menuKey = null; openMoveDialog('folder', f)">{{ t('library.actions.move') }}</AppMenuItem>
                  <AppMenuItem danger @click="menuKey = null; folderToDelete = f">{{ t('library.actions.delete') }}</AppMenuItem>
                </AppMenu>
              </div>
            </div>
            <div class="tile-body">
              <FolderOpen :size="14" :stroke-width="1.9" class="tile-icon" />
              <span class="tile-name truncate" :title="f.name">{{ f.name }}</span>
              <span class="tile-count">{{ folderStats(f) }}</span>
            </div>
          </article>
        </div>
      </section>

      <section v-if="location.type === 'root' && visibleProjectFolders.length" class="lib-section">
        <div class="section-head">
          <LayoutGrid :size="14" :stroke-width="1.9" />
          <span>{{ t('library.sections.projectFolders') }}</span>
          <span class="section-count">{{ visibleProjectFolders.length }}</span>
          <span class="section-hint dim">{{ t('library.projectHint') }}</span>
        </div>
        <div class="tile-grid">
          <article
            v-for="p in visibleProjectFolders"
            :key="'project-' + p.drama_id"
            class="card tile folder-tile project-tile"
            tabindex="0"
            role="button"
            @click="openProject(p)"
            @keydown.enter.prevent="openProject(p)"
          >
            <div class="tile-cover">
              <img v-if="p.cover" :src="thumbOf(src(p.cover))" loading="lazy" @error="thumbFallback($event, src(p.cover))" />
              <div v-else class="tile-empty"><Folder :size="26" :stroke-width="1.3" /></div>
              <span class="tile-badge">{{ t('library.projectTag') }}</span>
            </div>
            <div class="tile-body">
              <FolderOpen :size="14" :stroke-width="1.9" class="tile-icon" />
              <span class="tile-name truncate" :title="p.name">{{ p.name }}</span>
              <span class="tile-count">{{ t('library.itemCount', { n: p.count }) }}</span>
            </div>
          </article>
        </div>
      </section>
    </template>

    <!-- 文件：根目录文件 / 我的文件夹内文件（共用一套卡片） -->
    <section v-if="!loading && location.type !== 'project'" class="lib-section">
      <div v-if="location.type === 'root' || visibleFolders.length" class="section-head">
        <ImageIcon :size="14" :stroke-width="1.9" />
        <span>{{ t('library.sections.files') }}</span>
        <span class="section-count">{{ visibleFiles.length }}</span>
      </div>
      <div v-if="visibleFiles.length" class="tile-grid">
        <article
          v-for="f in visibleFiles"
          :key="'file-' + f.id"
          class="card tile file-tile clickable"
          tabindex="0"
          role="button"
          @click="openViewer(f.name, f.image_url)"
          @keydown.enter.prevent="openViewer(f.name, f.image_url)"
        >
          <div class="tile-cover">
            <img :src="thumbOf(src(f.image_url))" :alt="f.name" loading="lazy" @error="thumbFallback($event, src(f.image_url))" />
            <div class="tile-more" @click.stop @keydown.enter.stop>
              <AppMenu
                :open="menuKey === 'file-' + f.id"
                placement="bottom-end"
                :min-width="130"
                @update:open="(v) => { menuKey = v ? 'file-' + f.id : null }"
              >
                <template #trigger>
                  <button type="button" class="btn btn-icon btn-sm more-btn" :title="t('common.more')"><MoreHorizontal :size="15" /></button>
                </template>
                <AppMenuItem @click="menuKey = null; openViewer(f.name, f.image_url)">{{ t('library.actions.preview') }}</AppMenuItem>
                <AppMenuItem @click="menuKey = null; openNameDialog('renameFile', f)">{{ t('library.actions.rename') }}</AppMenuItem>
                <AppMenuItem @click="menuKey = null; openMoveDialog('file', f)">{{ t('library.actions.move') }}</AppMenuItem>
                <AppMenuItem danger @click="menuKey = null; fileToDelete = f">{{ t('library.actions.delete') }}</AppMenuItem>
              </AppMenu>
            </div>
          </div>
          <div class="tile-body column">
            <span class="tile-name truncate" :title="f.name">{{ f.name }}</span>
            <span v-if="f.width && f.height" class="tile-desc dim mono">{{ f.width }}×{{ f.height }}</span>
          </div>
        </article>
      </div>
      <div v-else class="empty-state">
        <div class="empty-icon">
          <FolderOpen v-if="location.type === 'folder'" :size="24" :stroke-width="1.4" />
          <Upload v-else :size="24" :stroke-width="1.4" />
        </div>
        <p class="empty-title">
          {{ keyword ? t('library.empty.search') : (location.type === 'folder' ? t('library.empty.folder') : t('library.empty.files', { category: categoryLabel })) }}
        </p>
        <p v-if="!keyword" class="empty-desc">{{ location.type === 'folder' ? t('library.empty.folderDesc') : t('library.empty.filesDesc') }}</p>
      </div>
    </section>

    <!-- 项目文件夹内（只读） -->
    <template v-if="!loading && location.type === 'project'">
      <div v-if="visibleProjectItems.length" class="tile-grid">
        <article
          v-for="m in visibleProjectItems"
          :key="'item-' + m.id"
          class="card tile file-tile"
          :class="{ clickable: !!m.image_url }"
          :tabindex="m.image_url ? 0 : -1"
          @click="m.image_url && openViewer(m.name, m.image_url)"
          @keydown.enter.prevent="m.image_url && openViewer(m.name, m.image_url)"
        >
          <div class="tile-cover">
            <img v-if="m.image_url" :src="thumbOf(src(m.image_url))" loading="lazy" @error="thumbFallback($event, src(m.image_url))" />
            <div v-else class="tile-empty">
              <component :is="category === 'character' ? User : MapPin" :size="22" :stroke-width="1.3" />
              <span>{{ t('library.noImage') }}</span>
            </div>
          </div>
          <div class="tile-body column">
            <div class="tile-row">
              <span class="tile-name truncate" :title="m.name">{{ m.name }}</span>
              <span v-if="m.tag" class="tag">{{ m.tag }}</span>
            </div>
            <span v-if="m.description" class="tile-desc truncate dim" :title="m.description">{{ m.description }}</span>
          </div>
        </article>
      </div>
      <div v-else class="empty-state">
        <div class="empty-icon"><component :is="category === 'character' ? User : MapPin" :size="24" :stroke-width="1.4" /></div>
        <p class="empty-title">{{ keyword ? t('library.empty.search') : t('library.empty.project', { category: categoryLabel }) }}</p>
        <p v-if="!keyword" class="empty-desc">{{ t('library.empty.projectDesc') }}</p>
      </div>
    </template>

    <!-- 拖拽上传遮罩 -->
    <div v-if="dragging" class="drop-mask">
      <Upload :size="28" :stroke-width="1.6" />
      <span>{{ t('library.dropHint', { target: location.type === 'folder' ? currentTitle : categoryLabel }) }}</span>
    </div>

    <!-- 新建 / 重命名 -->
    <div v-if="nameDialog.open" class="overlay" @click.self="nameDialog.open = false">
      <div class="dialog name-dialog">
        <div class="dialog-head">
          <h2 class="dialog-title">{{ nameDialogTitle }}</h2>
        </div>
        <form class="dialog-form" @submit.prevent="submitNameDialog">
          <div class="dialog-body">
            <input
              ref="nameInput"
              v-model="nameDialog.value"
              class="input"
              maxlength="100"
              :placeholder="nameDialog.mode === 'renameFile' ? t('library.dialogs.fileNamePlaceholder') : t('library.dialogs.folderNamePlaceholder')"
              required
            />
          </div>
          <div class="dialog-foot">
            <button type="button" class="btn" @click="nameDialog.open = false">{{ t('common.cancel') }}</button>
            <button type="submit" class="btn btn-primary" :disabled="!nameDialog.value.trim() || nameDialog.saving">
              <Loader2 v-if="nameDialog.saving" :size="13" class="animate-spin" />
              {{ t('common.confirm') }}
            </button>
          </div>
        </form>
      </div>
    </div>

    <!-- 移动 -->
    <div v-if="moveDialog.open" class="overlay" @click.self="moveDialog.open = false">
      <div class="dialog name-dialog">
        <div class="dialog-head">
          <h2 class="dialog-title">{{ moveDialog.kind === 'folder' ? t('library.dialogs.moveFolderTitle') : t('library.dialogs.moveTitle') }}</h2>
        </div>
        <div class="dialog-body">
          <label class="field">
            <span class="field-label">{{ t('library.dialogs.moveTarget') }}</span>
            <BaseSelect v-model="moveDialog.target" :options="moveOptions" />
          </label>
        </div>
        <div class="dialog-foot">
          <button type="button" class="btn" @click="moveDialog.open = false">{{ t('common.cancel') }}</button>
          <button type="button" class="btn btn-primary" :disabled="moveDialog.saving" @click="submitMove">
            <Loader2 v-if="moveDialog.saving" :size="13" class="animate-spin" />
            {{ t('common.confirm') }}
          </button>
        </div>
      </div>
    </div>

    <!-- 大图预览 -->
    <div v-if="viewer.open" class="overlay viewer-overlay" @click.self="viewer.open = false">
      <div class="dialog viewer-dialog">
        <div class="viewer-head">
          <span class="viewer-title truncate">{{ viewer.title }}</span>
          <button type="button" class="btn btn-icon btn-sm" :title="t('common.close')" @click="viewer.open = false"><X :size="15" /></button>
        </div>
        <img :src="viewer.src" :alt="viewer.title" class="viewer-img" />
      </div>
    </div>

    <ConfirmDialog
      :open="!!folderToDelete"
      :title="t('library.dialogs.deleteFolderTitle')"
      :message="folderToDelete?.folder_count
        ? t('library.dialogs.deleteFolderNestedMessage', { name: folderToDelete?.name, n: folderToDelete?.count || 0 })
        : t('library.dialogs.deleteFolderMessage', { name: folderToDelete?.name, n: folderToDelete?.count || 0 })"
      :loading="deleting"
      @confirm="confirmDeleteFolder"
      @cancel="folderToDelete = null"
    />
    <ConfirmDialog
      :open="!!fileToDelete"
      :title="t('library.dialogs.deleteFileTitle')"
      :message="t('library.dialogs.deleteFileMessage', { name: fileToDelete?.name })"
      :loading="deleting"
      @confirm="confirmDeleteFile"
      @cancel="fileToDelete = null"
    />
  </div>
</template>

<script setup>
import { toast } from 'vue-sonner'
import { useI18n } from 'vue-i18n'
import {
  ChevronRight, ExternalLink, Folder, FolderOpen, FolderPlus, Image as ImageIcon, Info,
  LayoutGrid, Loader2, MapPin, MoreHorizontal, Search, Upload, User, X,
} from 'lucide-vue-next'
import { libraryAPI } from '~/composables/useApi'
import { toastError } from '~/composables/useToast'
import { thumbOf, thumbFallback } from '~/composables/useMedia'
import AppMenu from '~/components/AppMenu.vue'
import AppMenuItem from '~/components/AppMenuItem.vue'
import BaseSelect from '~/components/BaseSelect.vue'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()

const IMAGE_RE = /\.(png|jpe?g|webp|gif)$/i

// ===== 位置状态：全部走 URL query，刷新/返回保持所在目录 =====
const category = computed(() => (route.query.category === 'scene' ? 'scene' : 'character'))
const location = computed(() => {
  if (route.query.folder) return { type: 'folder', id: Number(route.query.folder) }
  if (route.query.project) return { type: 'project', id: Number(route.query.project) }
  return { type: 'root', id: null }
})
const categories = computed(() => ([
  { value: 'character', label: t('library.category.character'), icon: User },
  { value: 'scene', label: t('library.category.scene'), icon: MapPin },
]))
const categoryLabel = computed(() => t(`library.category.${category.value}`))
const canUpload = computed(() => location.value.type !== 'project')

function switchCategory(value) {
  if (value === category.value) return
  router.replace({ query: { category: value } })
}
function goRoot() { router.push({ query: { category: category.value } }) }
function openFolder(f) { router.push({ query: { category: category.value, folder: f.id } }) }
function openProject(p) { router.push({ query: { category: category.value, project: p.drama_id } }) }

// ===== 数据 =====
const loading = ref(false)
const overview = ref({ project_folders: [], folders: [], files: [] })
const folderData = ref({ folder: null, path: [], folders: [], files: [] })
const projectData = ref({ drama: null, items: [] })
const keyword = ref('')

const folderPath = computed(() => folderData.value.path || [])
const currentTitle = computed(() => {
  if (location.value.type === 'folder') return folderData.value.folder?.name || ''
  if (location.value.type === 'project') return projectData.value.drama?.title || ''
  return ''
})

let loadSeq = 0
async function load({ silent = false } = {}) {
  const seq = ++loadSeq
  const loc = location.value
  const cat = category.value
  if (!silent) loading.value = true
  try {
    if (loc.type === 'folder') {
      const res = await libraryAPI.folder(cat, loc.id)
      if (seq === loadSeq) folderData.value = res
    } else if (loc.type === 'project') {
      const res = await libraryAPI.project(cat, loc.id)
      if (seq === loadSeq) projectData.value = res
    } else {
      const res = await libraryAPI.overview(cat)
      if (seq === loadSeq) overview.value = res
    }
  } catch (e) {
    if (seq !== loadSeq) return
    toastError(e)
    // 文件夹/项目已不存在（被删或链接失效）时回到根目录
    if (loc.type !== 'root') goRoot()
  } finally {
    if (seq === loadSeq) loading.value = false
  }
}

watch(() => [category.value, location.value.type, location.value.id], () => {
  keyword.value = ''
  load()
})
onMounted(load)

// ===== 搜索过滤 =====
function matches(...texts) {
  const k = keyword.value.toLowerCase()
  return !k || texts.some(s => String(s || '').toLowerCase().includes(k))
}
const currentFolders = computed(() => (location.value.type === 'folder' ? folderData.value.folders : overview.value.folders))
const visibleFolders = computed(() => currentFolders.value.filter(f => matches(f.name)))
const visibleProjectFolders = computed(() => overview.value.project_folders.filter(p => matches(p.name)))
const currentFiles = computed(() => (location.value.type === 'folder' ? folderData.value.files : overview.value.files))
const visibleFiles = computed(() => currentFiles.value.filter(f => matches(f.name, f.description)))
const visibleProjectItems = computed(() => projectData.value.items.filter(m => matches(m.name, m.description, m.tag)))

function src(raw) {
  if (!raw) return ''
  return /^https?:\/\//i.test(raw) || raw.startsWith('/') ? raw : `/${raw}`
}

const menuKey = ref(null)

function folderStats(f) {
  return f.folder_count
    ? t('library.folderStats', { folders: f.folder_count, files: f.count })
    : t('library.fileCount', { n: f.count })
}

// ===== 上传（按钮多选 + 拖拽） =====
const fileInput = ref(null)
const uploading = ref(false)
const uploadProgress = ref({ done: 0, total: 0 })
const dragging = ref(false)
let dragDepth = 0

function onFilePicked(e) {
  const files = Array.from(e.target.files || [])
  e.target.value = ''
  uploadFiles(files)
}
function hasFiles(e) { return Array.from(e.dataTransfer?.types || []).includes('Files') }
function onDragEnter(e) {
  if (!canUpload.value || !hasFiles(e)) return
  dragDepth++
  dragging.value = true
}
function onDragLeave(e) {
  if (!dragging.value) return
  dragDepth = Math.max(0, dragDepth - 1)
  if (!dragDepth || !e.relatedTarget) { dragDepth = 0; dragging.value = false }
}
function onDrop(e) {
  dragDepth = 0
  dragging.value = false
  if (!canUpload.value) return
  uploadFiles(Array.from(e.dataTransfer?.files || []))
}

async function uploadFiles(files) {
  if (!files.length || uploading.value) return
  const images = files.filter(f => IMAGE_RE.test(f.name))
  const skipped = files.length - images.length
  if (skipped) toast.warning(t('library.toast.uploadSkipped', { n: skipped }))
  if (!images.length) return
  const folderId = location.value.type === 'folder' ? location.value.id : null
  const cat = category.value
  uploading.value = true
  uploadProgress.value = { done: 0, total: images.length }
  let ok = 0
  for (const f of images) {
    try {
      await libraryAPI.upload(cat, f, folderId)
      ok++
    } catch (e) {
      toastError(e)
    }
    uploadProgress.value.done++
  }
  uploading.value = false
  if (ok) toast.success(t('library.toast.uploaded', { n: ok }))
  load({ silent: true })
}

// ===== 新建 / 重命名 =====
const nameDialog = ref({ open: false, mode: 'createFolder', target: null, value: '', saving: false })
const nameInput = ref(null)
const nameDialogTitle = computed(() => ({
  createFolder: t('library.dialogs.newFolderTitle'),
  renameFolder: t('library.dialogs.renameFolderTitle'),
  renameFile: t('library.dialogs.renameFileTitle'),
}[nameDialog.value.mode]))

function openNameDialog(mode, target = null) {
  nameDialog.value = { open: true, mode, target, value: target?.name || '', saving: false }
  nextTick(() => { nameInput.value?.focus(); nameInput.value?.select() })
}

async function submitNameDialog() {
  const d = nameDialog.value
  const name = d.value.trim()
  if (!name || d.saving) return
  d.saving = true
  try {
    if (d.mode === 'createFolder') {
      await libraryAPI.createFolder(category.value, name, location.value.type === 'folder' ? location.value.id : null)
      toast.success(t('library.toast.folderCreated'))
    } else if (d.mode === 'renameFolder') {
      await libraryAPI.renameFolder(d.target.id, name)
      toast.success(t('library.toast.renamed'))
    } else {
      await libraryAPI.updateFile(d.target.id, { name })
      toast.success(t('library.toast.renamed'))
    }
    d.open = false
    load({ silent: true })
  } catch (e) {
    toastError(e)
  } finally {
    d.saving = false
  }
}

// ===== 移动（文件 / 文件夹） =====
const ROOT_TARGET = 'root'
const moveDialog = ref({ open: false, kind: 'file', item: null, target: ROOT_TARGET, saving: false })
const moveTree = ref([])

/** 扁平文件夹列表 → 按层级缩进的先序列表；exclude 为不可选子树（移动文件夹时排除自身及后代） */
function flattenTree(folders, exclude = new Set()) {
  const children = new Map()
  for (const f of folders) {
    const key = f.parent_id ?? null
    if (!children.has(key)) children.set(key, [])
    children.get(key).push(f)
  }
  const out = []
  const walk = (parentId, depth) => {
    const list = (children.get(parentId) || []).slice().sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
    for (const f of list) {
      if (exclude.has(f.id)) continue
      out.push({ ...f, depth })
      walk(f.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}

function subtreeOf(folders, rootId) {
  const ids = new Set([rootId])
  let grew = true
  while (grew) {
    grew = false
    for (const f of folders) {
      if (f.parent_id && ids.has(f.parent_id) && !ids.has(f.id)) { ids.add(f.id); grew = true }
    }
  }
  return ids
}

const moveOptions = computed(() => ([
  { label: t('library.dialogs.rootFolder'), value: ROOT_TARGET },
  ...moveTree.value.map(f => ({ label: `${'\u3000'.repeat(f.depth)}${f.depth ? '└ ' : ''}${f.name}`, value: f.id })),
]))

function currentParentOf(kind, item) {
  return (kind === 'folder' ? item.parent_id : item.folder_id) || null
}

async function openMoveDialog(kind, item) {
  moveTree.value = []
  moveDialog.value = { open: true, kind, item, target: currentParentOf(kind, item) || ROOT_TARGET, saving: false }
  try {
    const folders = await libraryAPI.folderTree(category.value)
    const exclude = kind === 'folder' ? subtreeOf(folders, item.id) : new Set()
    moveTree.value = flattenTree(folders, exclude)
  } catch (e) {
    toastError(e)
  }
}

async function submitMove() {
  const d = moveDialog.value
  if (d.saving) return
  const targetId = d.target === ROOT_TARGET ? null : Number(d.target)
  if (currentParentOf(d.kind, d.item) === targetId) { d.open = false; return }
  d.saving = true
  try {
    if (d.kind === 'folder') await libraryAPI.moveFolder(d.item.id, targetId)
    else await libraryAPI.updateFile(d.item.id, { folder_id: targetId })
    toast.success(t('library.toast.moved'))
    d.open = false
    load({ silent: true })
  } catch (e) {
    toastError(e)
  } finally {
    d.saving = false
  }
}

// ===== 删除 =====
const folderToDelete = ref(null)
const fileToDelete = ref(null)
const deleting = ref(false)

async function confirmDeleteFolder() {
  const f = folderToDelete.value
  if (!f || deleting.value) return
  deleting.value = true
  try {
    await libraryAPI.delFolder(f.id)
    toast.success(t('library.toast.deleted'))
    folderToDelete.value = null
    load({ silent: true })
  } catch (e) {
    toastError(e)
  } finally {
    deleting.value = false
  }
}

async function confirmDeleteFile() {
  const f = fileToDelete.value
  if (!f || deleting.value) return
  deleting.value = true
  try {
    await libraryAPI.delFile(f.id)
    toast.success(t('library.toast.deleted'))
    fileToDelete.value = null
    load({ silent: true })
  } catch (e) {
    toastError(e)
  } finally {
    deleting.value = false
  }
}

// ===== 预览 =====
const viewer = ref({ open: false, title: '', src: '' })
function openViewer(title, raw) {
  if (!raw) return
  viewer.value = { open: true, title, src: src(raw) }
}
</script>

<style scoped>
.page {
  position: relative;
  padding: 20px 28px 48px;
  overflow-y: auto;
  height: 100%;
  display: flex;
  flex-direction: column;
  animation: fadeUp 0.35s var(--ease-out) both;
  background: var(--surface-base);
}

.library-head {
  display: flex;
  align-items: center;
  gap: var(--sp-4);
  padding-bottom: var(--sp-4);
}
.head-left { display: flex; align-items: baseline; gap: 12px; min-width: 0; }
.library-title {
  font-size: 20px;
  font-weight: 650;
  letter-spacing: -0.02em;
  color: var(--text-0);
  white-space: nowrap;
}
.library-sub { color: var(--text-3); font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.category-seg { flex-shrink: 0; }
.category-seg .seg-item { display: inline-flex; align-items: center; gap: 5px; }
.head-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; margin-left: auto; }
.head-actions a.btn { text-decoration: none; }

.toolbar {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  margin-bottom: var(--sp-4);
}
.crumbs { display: flex; align-items: center; gap: 4px; min-width: 0; flex: 1; }
.crumb {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 4px 8px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-2);
  font-size: 13px;
  font-weight: 600;
}
button.crumb { cursor: pointer; }
button.crumb:hover { background: var(--bg-hover); color: var(--text-0); }
.crumb.current { color: var(--text-0); }
.crumb-sep { color: var(--text-3); flex-shrink: 0; }
.search-box { position: relative; width: 240px; flex: 0 0 auto; }
.search-box svg {
  position: absolute;
  left: 12px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-3);
  pointer-events: none;
}
.search-box .input {
  padding-left: 34px;
  border-radius: var(--radius-pill);
  border-color: var(--border);
  background: var(--bg-hover);
}
.search-box .input:focus { background: var(--surface-input); }

.readonly-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: -6px 0 14px;
  font-size: 12px;
}

.lib-section + .lib-section { margin-top: 26px; }
.section-head {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 12px;
  font-size: 13px;
  font-weight: 650;
  color: var(--text-1);
}
.section-count {
  padding: 1px 8px;
  border-radius: var(--radius-pill);
  background: var(--overlay-track);
  color: var(--text-2);
  font-size: 11px;
  font-weight: 600;
}
.section-hint { font-size: 11.5px; font-weight: 400; margin-left: 4px; }

/* 卡片网格 */
.tile-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 14px;
}
.tile {
  position: relative;
  overflow: hidden;
  animation: fadeUp 0.28s var(--ease-out) both;
  transition: border-color 0.16s var(--ease-out);
}
.folder-tile, .tile.clickable { cursor: pointer; }
.tile:hover { border-color: var(--border-strong); }
.tile:focus-visible {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3.5px var(--button-focus);
}
.tile-cover {
  position: relative;
  aspect-ratio: 16 / 10;
  background: var(--bg-2);
  border-bottom: 1px solid var(--border);
  overflow: hidden;
}
.tile-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.folder-tile .tile-cover img { filter: saturate(0.92); }
.tile-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: var(--text-3);
  font-size: 11px;
}
.folder-tile .tile-empty { background: linear-gradient(135deg, var(--accent-bg) 0%, var(--bg-1) 75%); color: var(--accent-text); }
.tile-badge {
  position: absolute;
  top: 8px;
  left: 8px;
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--border);
  background: var(--surface-raised);
  color: var(--text-2);
  font-size: 10.5px;
  font-weight: 600;
}
.tile-more { position: absolute; top: 6px; right: 6px; }
.tile-more :deep(.more-btn) {
  width: 28px;
  min-width: 28px;
  height: 28px;
  min-height: 28px;
  background: var(--surface-raised);
  border: 1px solid var(--border);
  color: var(--text-2);
  opacity: 0;
  transition: opacity 0.15s var(--ease-out);
}
.tile:hover .tile-more :deep(.more-btn),
.tile-more:focus-within :deep(.more-btn) { opacity: 1; }
.tile-body {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px 11px;
  min-width: 0;
}
.tile-body.column { flex-direction: column; align-items: stretch; gap: 4px; }
.tile-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
.tile-icon { color: var(--accent-text); flex-shrink: 0; }
.tile-name { flex: 1; min-width: 0; font-size: 13px; font-weight: 600; color: var(--text-0); }
.tile-count { flex-shrink: 0; font-size: 11px; color: var(--text-3); }
.tile-desc { font-size: 11px; }

/* 骨架 */
.skeleton-card { overflow: hidden; }
.skeleton-cover {
  aspect-ratio: 16 / 10;
  background: var(--bg-2);
  animation: skeleton-pulse 1.4s ease-in-out infinite alternate;
}
.skeleton-body { padding: 12px; }
.skeleton-line {
  height: 12px;
  border-radius: 99px;
  background: var(--bg-2);
  animation: skeleton-pulse 1.4s ease-in-out infinite alternate;
}
.skeleton-line.w-60 { width: 60%; }
@keyframes skeleton-pulse { to { opacity: 0.55; } }

/* 空状态 */
.empty-state {
  flex: 1;
  min-height: 200px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-lg);
  background: var(--surface-raised);
  text-align: center;
  padding: 24px;
}
.empty-icon {
  width: 52px;
  height: 52px;
  border-radius: var(--radius-lg);
  background: var(--bg-2);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
  margin-bottom: 4px;
}
.empty-title { font-size: 14px; font-weight: 600; color: var(--text-1); }
.empty-desc { font-size: 12px; color: var(--text-3); max-width: 280px; line-height: 1.6; }

/* 拖拽遮罩 */
.drop-mask {
  position: fixed;
  inset: 60px 0 0 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  background: color-mix(in srgb, var(--bg-base) 82%, transparent);
  border: 2px dashed var(--accent);
  color: var(--accent-text);
  font-size: 14px;
  font-weight: 600;
  pointer-events: none;
}

/* 弹窗 */
.name-dialog { width: 420px; max-width: calc(100vw - 32px); }
.dialog-form { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.field { display: flex; flex-direction: column; gap: 6px; }
.field-label { font-size: 12px; font-weight: 600; color: var(--text-1); }
.viewer-overlay { align-items: center; }
.viewer-dialog { width: min(960px, calc(100vw - 48px)); padding: 14px; }
.viewer-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.viewer-title { font-size: 13px; font-weight: 600; color: var(--text-1); }
.viewer-img { width: 100%; max-height: 76vh; object-fit: contain; border-radius: var(--radius); background: var(--bg-2); display: block; }

@media (max-width: 760px) {
  .page { padding: 16px 16px 40px; }
  .library-head { flex-wrap: wrap; }
  .library-sub { display: none; }
  .toolbar { flex-wrap: wrap; }
  .search-box { width: 100%; flex: 1 1 100%; }
  .tile-grid { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
  .section-hint { display: none; }
}
</style>
