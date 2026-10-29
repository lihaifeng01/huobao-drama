<template>
  <Teleport to="body">
    <!-- 叠加模态：常从素材详情弹窗内打开 -->
    <div v-if="open" class="overlay overlay-nested" @click.self="emit('close')">
      <div class="dialog picker-dialog" role="dialog" aria-modal="true" :aria-label="dialogTitle">
        <div class="picker-head">
          <div class="picker-head-copy">
            <h2 class="dialog-title">{{ dialogTitle }}</h2>
            <p class="picker-hint">{{ t('library.picker.hint') }}</p>
          </div>
          <button type="button" class="btn btn-icon btn-sm" :title="t('common.close')" @click="emit('close')"><X :size="15" /></button>
        </div>

        <div class="picker-toolbar">
          <nav class="crumbs" aria-label="breadcrumb">
            <button type="button" class="crumb" :class="{ current: !trail.length }" @click="goTo(-1)">{{ categoryLabel }}</button>
            <template v-for="(c, i) in trail" :key="i">
              <ChevronRight :size="13" class="crumb-sep" />
              <span v-if="i === trail.length - 1" class="crumb current"><span class="truncate">{{ c.name }}</span></span>
              <button v-else type="button" class="crumb" @click="goTo(i)"><span class="truncate">{{ c.name }}</span></button>
            </template>
          </nav>
          <label class="search-box">
            <Search :size="14" :stroke-width="1.8" />
            <input v-model.trim="keyword" class="input" :placeholder="t('library.searchPlaceholder')" />
          </label>
        </div>

        <div class="picker-body">
          <div v-if="loading" class="picker-loading"><Loader2 :size="18" class="animate-spin" /></div>
          <template v-else>
            <div v-if="visibleFolders.length" class="picker-grid">
              <button
                v-for="f in visibleFolders"
                :key="f.key"
                type="button"
                class="picker-tile folder"
                @click="enter(f)"
              >
                <span class="picker-cover">
                  <img v-if="f.cover" :src="thumbOf(src(f.cover))" loading="lazy" alt="" @error="thumbFallback($event, src(f.cover))" />
                  <span v-else class="picker-empty"><Folder :size="22" :stroke-width="1.3" /></span>
                  <span v-if="f.project" class="picker-badge">{{ t('library.projectTag') }}</span>
                </span>
                <span class="picker-name">
                  <FolderOpen :size="13" :stroke-width="1.9" class="picker-folder-icon" />
                  <span class="truncate">{{ f.name }}</span>
                  <span class="picker-count">{{ f.count }}</span>
                </span>
              </button>
            </div>

            <div v-if="visibleImages.length" class="picker-grid">
              <button
                v-for="m in visibleImages"
                :key="m.key"
                type="button"
                class="picker-tile image"
                :class="{ disabled: !m.image_url }"
                :disabled="!m.image_url || applying"
                :title="m.image_url ? m.name : t('library.noImage')"
                @click="choose(m)"
              >
                <span class="picker-cover">
                  <img v-if="m.image_url" :src="thumbOf(src(m.image_url))" loading="lazy" :alt="m.name" @error="thumbFallback($event, src(m.image_url))" />
                  <span v-else class="picker-empty"><ImageOff :size="20" :stroke-width="1.3" /><span>{{ t('library.noImage') }}</span></span>
                  <span v-if="m.image_url" class="picker-use"><Check :size="14" :stroke-width="2.4" />{{ t('library.picker.use') }}</span>
                </span>
                <span class="picker-name"><span class="truncate">{{ m.name }}</span></span>
              </button>
            </div>

            <div v-if="!visibleFolders.length && !visibleImages.length" class="picker-empty-state">
              {{ keyword ? t('library.empty.search') : t('library.picker.empty') }}
            </div>
          </template>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { Check, ChevronRight, Folder, FolderOpen, ImageOff, Loader2, Search, X } from 'lucide-vue-next'
import { libraryAPI } from '~/composables/useApi'
import { toastError } from '~/composables/useToast'
import { thumbOf, thumbFallback } from '~/composables/useMedia'

/**
 * LibraryPicker — 从全局素材库选择一张角色/场景图片
 * 可浏览：我的文件夹（含子文件夹）、根目录文件、各项目文件夹中已有图片的角色/场景。
 * 选中后 emit('select', { image_url, name })，image_url 为 static/... 相对路径（与生图回写一致）。
 */
const props = defineProps({
  open: { type: Boolean, default: false },
  category: { type: String, default: 'character' }, // character | scene
  title: { type: String, default: '' },
  applying: { type: Boolean, default: false },
})
const emit = defineEmits(['close', 'select'])

const { t } = useI18n()

const categoryLabel = computed(() => t(`library.category.${props.category === 'scene' ? 'scene' : 'character'}`))
const dialogTitle = computed(() => props.title || t('library.picker.title', { category: categoryLabel.value }))

// trail：面包屑，每段 { type: 'folder'|'project', id, name }；空数组即根目录
const trail = ref([])
const loading = ref(false)
const keyword = ref('')
const folders = ref([])
const images = ref([])

function src(raw) {
  if (!raw) return ''
  return /^https?:\/\//i.test(raw) || raw.startsWith('/') ? raw : `/${raw}`
}

let seq = 0
async function load() {
  const my = ++seq
  const cat = props.category === 'scene' ? 'scene' : 'character'
  const here = trail.value[trail.value.length - 1]
  loading.value = true
  try {
    if (!here) {
      const res = await libraryAPI.overview(cat)
      if (my !== seq) return
      folders.value = [
        ...res.folders.map(f => ({ key: 'f' + f.id, type: 'folder', id: f.id, name: f.name, cover: f.cover, count: f.count })),
        ...res.project_folders.map(p => ({ key: 'p' + p.drama_id, type: 'project', id: p.drama_id, name: p.name, cover: p.cover, count: p.count, project: true })),
      ]
      images.value = res.files.map(f => ({ key: 'file' + f.id, name: f.name, image_url: f.image_url }))
    } else if (here.type === 'folder') {
      const res = await libraryAPI.folder(cat, here.id)
      if (my !== seq) return
      folders.value = res.folders.map(f => ({ key: 'f' + f.id, type: 'folder', id: f.id, name: f.name, cover: f.cover, count: f.count }))
      images.value = res.files.map(f => ({ key: 'file' + f.id, name: f.name, image_url: f.image_url }))
    } else {
      const res = await libraryAPI.project(cat, here.id)
      if (my !== seq) return
      folders.value = []
      // 有图的排前面，无图的置灰保留（便于用户确认项目里确实有这个角色/场景）
      images.value = res.items
        .map(m => ({ key: 'item' + m.id, name: m.name, image_url: m.image_url }))
        .sort((a, b) => Number(!!b.image_url) - Number(!!a.image_url))
    }
  } catch (e) {
    if (my === seq) toastError(e)
  } finally {
    if (my === seq) loading.value = false
  }
}

function enter(f) {
  trail.value = [...trail.value, { type: f.type, id: f.id, name: f.name }]
}
function goTo(i) {
  trail.value = trail.value.slice(0, i + 1)
}
function choose(m) {
  if (!m.image_url || props.applying) return
  emit('select', { image_url: m.image_url, name: m.name })
}

function matches(text) {
  const k = keyword.value.toLowerCase()
  return !k || String(text || '').toLowerCase().includes(k)
}
const visibleFolders = computed(() => folders.value.filter(f => matches(f.name)))
const visibleImages = computed(() => images.value.filter(m => matches(m.name)))

watch(trail, () => { keyword.value = ''; load() })
watch(() => [props.open, props.category], ([open]) => {
  if (!open) return
  keyword.value = ''
  if (trail.value.length) trail.value = []
  else load()
}, { immediate: true })

function onKeydown(e) { if (e.key === 'Escape') emit('close') }
watch(() => props.open, (v) => {
  if (v) window.addEventListener('keydown', onKeydown)
  else window.removeEventListener('keydown', onKeydown)
}, { immediate: true })
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<style scoped>
.picker-dialog {
  width: min(860px, calc(100vw - 32px));
  height: min(640px, calc(100vh - 64px));
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.picker-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 18px 20px 10px;
}
.picker-head-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.picker-hint { font-size: 12px; color: var(--text-3); }
.picker-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 20px 12px;
  border-bottom: 1px solid var(--border);
}
.crumbs { display: flex; align-items: center; gap: 2px; min-width: 0; flex: 1; overflow: hidden; }
.crumb {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  max-width: 180px;
  padding: 4px 8px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-2);
  font-size: 12.5px;
  font-weight: 600;
}
button.crumb { cursor: pointer; }
button.crumb:hover { background: var(--bg-hover); color: var(--text-0); }
.crumb.current { color: var(--text-0); }
.crumb-sep { color: var(--text-3); flex-shrink: 0; }
.search-box { position: relative; width: 200px; flex: 0 0 auto; }
.search-box svg {
  position: absolute;
  left: 11px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-3);
  pointer-events: none;
}
.search-box .input { padding-left: 32px; border-radius: var(--radius-pill); background: var(--bg-hover); }

.picker-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 20px 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.picker-loading { flex: 1; display: flex; align-items: center; justify-content: center; color: var(--text-3); }
.picker-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 10px;
}
.picker-tile {
  appearance: none;
  display: flex;
  flex-direction: column;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-raised);
  overflow: hidden;
  cursor: pointer;
  text-align: left;
  transition: border-color 0.15s var(--ease-out), box-shadow 0.15s var(--ease-out);
}
.picker-tile:hover:not(:disabled) { border-color: var(--accent); }
.picker-tile:focus-visible { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3.5px var(--button-focus); }
.picker-tile.disabled { cursor: not-allowed; opacity: 0.55; }
.picker-cover {
  position: relative;
  display: block;
  aspect-ratio: 16 / 10;
  background: var(--bg-2);
  overflow: hidden;
}
.picker-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.picker-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  color: var(--text-3);
  font-size: 10.5px;
}
.picker-tile.folder .picker-empty { background: linear-gradient(135deg, var(--accent-bg) 0%, var(--bg-1) 75%); color: var(--accent-text); }
.picker-badge {
  position: absolute;
  top: 6px;
  left: 6px;
  padding: 1px 7px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--border);
  background: var(--surface-raised);
  color: var(--text-2);
  font-size: 10px;
  font-weight: 600;
}
.picker-use {
  position: absolute;
  inset: auto 6px 6px auto;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  background: var(--accent);
  color: var(--on-accent);
  font-size: 11px;
  font-weight: 600;
  opacity: 0;
  transition: opacity 0.15s var(--ease-out);
}
.picker-tile:hover .picker-use,
.picker-tile:focus-visible .picker-use { opacity: 1; }
.picker-name {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  padding: 7px 9px 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-0);
}
.picker-name .truncate { flex: 1; min-width: 0; }
.picker-folder-icon { flex-shrink: 0; color: var(--accent-text); }
.picker-count { flex-shrink: 0; font-size: 10.5px; font-weight: 500; color: var(--text-3); }
.picker-empty-state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
  font-size: 13px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-lg);
  min-height: 160px;
}

@media (max-width: 640px) {
  .picker-toolbar { flex-wrap: wrap; }
  .search-box { width: 100%; }
  .picker-grid { grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); }
}
</style>
