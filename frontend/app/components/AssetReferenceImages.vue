<template>
  <section class="asset-refs" :aria-label="t('assetRefs.title')">
    <div class="refs-heading">
      <div class="refs-label"><Images :size="14" /><span>{{ t('assetRefs.title') }}</span><span class="refs-count">{{ refs.length }}/{{ MAX_REFS }}</span></div>
      <div class="refs-actions">
        <button v-if="libraryCategory" type="button" class="btn btn-sm" :disabled="busy || full" :title="t('assetRefs.fromLibrary')" @click="pickerOpen = true">
          <FolderOpen :size="12" />{{ t('assetRefs.fromLibrary') }}
        </button>
        <button type="button" class="btn btn-sm" :disabled="busy || full" @click="fileInput?.click()">
          <Loader2 v-if="busy" :size="12" class="animate-spin" />
          <Upload v-else :size="12" />
          {{ busy ? t('assetRefs.saving') : t('assetRefs.upload') }}
        </button>
      </div>
      <input ref="fileInput" class="refs-file-input" type="file" accept="image/png,image/jpeg,image/webp" multiple :disabled="busy" :aria-label="t('assetRefs.upload')" @change="upload" />
    </div>

    <div v-if="refs.length" class="refs-grid">
      <div v-for="(r, i) in refs" :key="r" class="refs-tile">
        <img :src="thumbOf(src(r))" :alt="t('assetRefs.alt', { n: i + 1 })" loading="lazy" @error="thumbFallback($event, src(r))" />
        <button type="button" class="refs-remove" :disabled="busy" :title="t('assetRefs.remove')" :aria-label="t('assetRefs.remove')" @click="remove(r)"><X :size="12" /></button>
      </div>
    </div>
    <p v-else class="refs-hint">{{ t(`assetRefs.empty.${kind}`) }}</p>
    <p class="refs-note">{{ t('assetRefs.note') }}</p>

    <LibraryPicker
      v-if="libraryCategory"
      :open="pickerOpen"
      :category="libraryCategory"
      :title="t('assetRefs.pickerTitle')"
      :applying="busy"
      @close="pickerOpen = false"
      @select="onPick"
    />
  </section>
</template>

<script setup lang="ts">
import { FolderOpen, Images, Loader2, Upload, X } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { characterAPI, propAPI, sceneAPI, uploadAPI } from '~/composables/useApi'
import { toastError } from '~/composables/useToast'
import { thumbOf, thumbFallback } from '~/composables/useMedia'
import { parseAssetReferenceImages } from '~/composables/useAssetReferences'

type AssetKind = 'character' | 'scene' | 'prop'

const MAX_REFS = 4
const MAX_BYTES = 10 * 1024 * 1024

const props = defineProps<{
  kind: AssetKind
  item: { id: number; reference_images?: unknown; referenceImages?: unknown }
}>()
const emit = defineEmits<{ updated: [id: number, refs: string[]] }>()
const { t } = useI18n()

const fileInput = ref<HTMLInputElement | null>(null)
const pickerOpen = ref(false)
// 卡片与弹窗可能同时挂载同一素材，按 kind:id 共用保存锁
const busyKeys = useState<string[]>('asset-refs-busy', () => [])
const busyKey = computed(() => `${props.kind}:${props.item.id}`)
const busy = computed(() => busyKeys.value.includes(busyKey.value))

const refs = computed(() => parseAssetReferenceImages(props.item.reference_images ?? props.item.referenceImages))
const full = computed(() => refs.value.length >= MAX_REFS)
// 素材库只有角色 / 场景两个分类；道具只支持上传
const libraryCategory = computed(() => (props.kind === 'prop' ? '' : props.kind))

function src(raw: string) {
  return /^https?:\/\//i.test(raw) || raw.startsWith('/') ? raw : `/${raw}`
}

function apiFor(kind: AssetKind) {
  return kind === 'character' ? characterAPI : kind === 'scene' ? sceneAPI : propAPI
}

async function save(next: string[], successMsg: string) {
  const id = props.item.id
  const key = busyKey.value
  busyKeys.value = [...busyKeys.value, key]
  try {
    await apiFor(props.kind).update(id, { reference_images: next })
    emit('updated', id, next)
    toast.success(successMsg)
  } catch (error) {
    toastError(error)
  } finally {
    busyKeys.value = busyKeys.value.filter(value => value !== key)
  }
}

async function upload(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files || [])
  input.value = ''
  if (!files.length || busy.value) return
  const room = MAX_REFS - refs.value.length
  if (room <= 0) { toast.error(t('assetRefs.full', { max: MAX_REFS })); return }
  const valid = files.filter(f => /^image\/(png|jpe?g|webp)$/i.test(f.type) || /\.(png|jpe?g|webp)$/i.test(f.name))
  if (valid.length < files.length) toast.error(t('assetRefs.invalidFormat'))
  const sized = valid.filter(f => f.size > 0 && f.size <= MAX_BYTES)
  if (sized.length < valid.length) toast.error(t('assetRefs.tooLarge'))
  if (sized.length > room) toast.warning(t('assetRefs.truncated', { max: MAX_REFS }))
  const picked = sized.slice(0, room)
  if (!picked.length) return

  const key = busyKey.value
  busyKeys.value = [...busyKeys.value, key]
  const uploaded: string[] = []
  try {
    for (const file of picked) {
      const res = await uploadAPI.image(file)
      if (res?.path) uploaded.push(res.path)
    }
  } catch (error) {
    toastError(error)
  } finally {
    busyKeys.value = busyKeys.value.filter(value => value !== key)
  }
  if (uploaded.length) await save([...refs.value, ...uploaded], t('assetRefs.saved'))
}

async function onPick({ image_url }: { image_url: string }) {
  pickerOpen.value = false
  if (!image_url || busy.value) return
  const value = image_url.startsWith('/static/') ? image_url.slice(1) : image_url
  if (refs.value.includes(value)) { toast.info(t('assetRefs.duplicate')); return }
  if (full.value) { toast.error(t('assetRefs.full', { max: MAX_REFS })); return }
  await save([...refs.value, value], t('assetRefs.saved'))
}

async function remove(value: string) {
  if (busy.value) return
  await save(refs.value.filter(r => r !== value), t('assetRefs.removed'))
}
</script>

<style scoped>
.asset-refs { min-width: 0; display: flex; flex-direction: column; gap: 8px; border-top: 1px solid var(--border); padding-top: 12px; margin-top: 4px; cursor: default; }
.refs-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; flex-wrap: wrap; }
.refs-label { display: flex; align-items: center; gap: 6px; color: var(--text-1); font-size: 12px; font-weight: 600; min-width: 0; }
.refs-label svg { color: var(--text-3); flex-shrink: 0; }
.refs-count { color: var(--text-3); font-weight: 400; font-size: 11px; }
.refs-actions { display: flex; gap: 6px; flex-shrink: 0; }
.refs-file-input { display: none; }
.refs-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; }
.refs-tile { position: relative; aspect-ratio: 1; border-radius: 6px; overflow: hidden; background: var(--bg-2, var(--border)); border: 1px solid var(--border); }
.refs-tile img { width: 100%; height: 100%; object-fit: cover; display: block; }
.refs-remove { position: absolute; top: 3px; right: 3px; width: 20px; height: 20px; display: inline-flex; align-items: center; justify-content: center; border: none; border-radius: 50%; background: rgba(0, 0, 0, 0.6); color: #fff; cursor: pointer; opacity: 0.85; transition: opacity 0.15s, background 0.15s; }
.refs-remove:hover { opacity: 1; background: var(--action-danger); }
.refs-remove:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.refs-remove:disabled { opacity: 0.4; cursor: default; }
.refs-hint, .refs-note { margin: 0; font-size: 11px; line-height: 1.6; }
.refs-hint { color: var(--text-2); }
.refs-note { color: var(--text-3); }
</style>
