<template>
  <section class="merge-tool" @dragenter.prevent="onDragEnter" @dragover.prevent @dragleave="onDragLeave" @drop.prevent="onDrop">
    <!-- 片段列表：拖动或用箭头调整顺序 -->
    <div class="card clip-pane">
      <div class="pane-head">
        <span class="pane-title">{{ t('tools.merge.clips') }}</span>
        <span class="dim pane-count">{{ t('tools.merge.clipStat', { n: clips.length, dur: formatDuration(totalDuration) }) }}</span>
        <div class="ml-auto flex gap-1">
          <button v-if="clips.length" type="button" class="btn btn-sm btn-ghost" :disabled="uploading" @click="clips = []">{{ t('tools.merge.clear') }}</button>
          <button type="button" class="btn btn-sm btn-primary" :disabled="uploading" @click="clipInput?.click()">
            <Loader2 v-if="uploading" :size="12" class="animate-spin" />
            <Plus v-else :size="12" />
            {{ uploading ? t('tools.merge.uploading', { done: uploadDone, total: uploadTotal, pct: uploadPct }) : t('tools.merge.addVideos') }}
          </button>
        </div>
        <input ref="clipInput" type="file" accept="video/*,.mkv" multiple hidden @change="onPickClips" />
      </div>

      <div v-if="!clips.length" class="clip-empty" role="button" tabindex="0" @click="clipInput?.click()">
        <Upload :size="30" :stroke-width="1.3" />
        <div class="clip-empty-title">{{ t('tools.merge.dropTitle') }}</div>
        <div class="dim">{{ t('tools.merge.dropDesc') }}</div>
      </div>
      <div v-else class="clip-list">
        <div
          v-for="(c, i) in clips"
          :key="c.url"
          :class="['clip-row', { dragging: dragIdx === i, 'drop-before': overIdx === i && dragIdx !== null && dragIdx > i, 'drop-after': overIdx === i && dragIdx !== null && dragIdx < i }]"
          draggable="true"
          @dragstart="onRowDragStart(i, $event)"
          @dragover.prevent="onRowDragOver(i)"
          @drop.prevent.stop="onRowDrop(i)"
          @dragend="dragIdx = null; overIdx = null"
        >
          <GripVertical :size="14" class="clip-grip" />
          <span class="clip-index mono">{{ i + 1 }}</span>
          <video class="clip-thumb" :src="'/' + c.url" :poster="posterOf('/' + c.url) || undefined" preload="none" muted playsinline tabindex="-1" />
          <div class="clip-main">
            <div class="clip-name" :title="c.name">{{ c.name }}</div>
            <div class="clip-meta dim mono">
              {{ c.width }}×{{ c.height }} · {{ formatDuration(c.duration) }}
              <span v-if="!c.has_audio" class="clip-mute" :title="t('tools.merge.noAudioHint')"><VolumeX :size="11" /> {{ t('tools.merge.noAudio') }}</span>
            </div>
          </div>
          <div class="clip-actions">
            <button type="button" class="btn btn-ghost btn-icon btn-sm" :disabled="i === 0" :title="t('tools.merge.moveUp')" @click="move(i, -1)"><ArrowUp :size="13" /></button>
            <button type="button" class="btn btn-ghost btn-icon btn-sm" :disabled="i === clips.length - 1" :title="t('tools.merge.moveDown')" @click="move(i, 1)"><ArrowDown :size="13" /></button>
            <button type="button" class="btn btn-ghost btn-icon btn-sm" :title="t('common.delete')" @click="clips = clips.filter((_, k) => k !== i)"><X :size="13" /></button>
          </div>
        </div>
      </div>

      <div class="merge-foot">
        <label class="size-field">
          <span class="dim">{{ t('tools.merge.outputSize') }}</span>
          <select v-model="sizeKey" class="input size-select" :disabled="!clips.length" @change="sizePicked = true">
            <option v-for="o in sizeOptions" :key="o.key" :value="o.key">{{ o.label }}</option>
          </select>
        </label>
        <button type="button" class="btn btn-primary ml-auto" :disabled="clips.length < 2 || uploading || submitting" @click="merge">
          <Loader2 v-if="submitting" :size="13" class="animate-spin" />
          <Combine v-else :size="13" />
          {{ t('tools.merge.start', { n: clips.length }) }}
        </button>
      </div>
      <div class="dim foot-hint">{{ t('tools.merge.hint') }}</div>
    </div>

    <!-- 合成记录 -->
    <div class="card job-pane">
      <div class="pane-head">
        <span class="pane-title">{{ t('tools.merge.jobs') }}</span>
        <span class="dim pane-count">{{ jobs.length }}</span>
      </div>
      <div v-if="playing" class="player">
        <video :key="playing.id" :src="'/' + playing.output_url" :poster="posterOf('/' + playing.output_url) || undefined" controls autoplay playsinline />
      </div>
      <div v-if="!jobs.length" class="job-empty dim">{{ t('tools.merge.noJobs') }}</div>
      <div v-else class="job-list">
        <div v-for="j in jobs" :key="j.id" :class="['job-row', { active: playing?.id === j.id }]">
          <div class="job-main">
            <div class="job-name" :title="j.name">{{ j.name }}</div>
            <div class="job-meta">
              <span :class="['job-badge', 'is-' + j.status]">
                <Loader2 v-if="j.status === 'merging'" :size="10" class="animate-spin" />
                {{ t('tools.merge.status.' + j.status) }}
              </span>
              <span class="dim mono">{{ t('tools.merge.jobMeta', { n: j.clips.length, w: j.width, h: j.height, dur: formatDuration(j.duration) }) }}</span>
            </div>
            <div v-if="j.status === 'failed' && j.error_msg" class="job-error" :title="j.error_msg">{{ j.error_msg }}</div>
          </div>
          <div class="job-actions">
            <button v-if="j.output_url" type="button" class="btn btn-sm" @click="playing = playing?.id === j.id ? null : j">
              <Play :size="11" /> {{ t('tools.merge.preview') }}
            </button>
            <a v-if="j.output_url" class="btn btn-sm" :href="'/' + j.output_url" :download="downloadName(j)"><Download :size="11" /></a>
            <button type="button" class="btn btn-sm" :title="t('tools.merge.reuse')" :disabled="uploading" @click="reuse(j)"><RotateCcw :size="11" /></button>
            <button type="button" class="btn btn-ghost btn-icon btn-sm" :title="t('common.delete')" :disabled="j.status === 'merging'" @click="toDelete = j"><Trash2 :size="13" /></button>
          </div>
        </div>
      </div>
    </div>

    <div v-if="dragging" class="drop-mask">
      <Upload :size="28" />
      <span>{{ t('tools.merge.dropTitle') }}</span>
    </div>

    <ConfirmDialog
      :open="!!toDelete"
      :message="t('tools.merge.deleteConfirm', { name: toDelete?.name || '' })"
      @cancel="toDelete = null"
      @confirm="confirmDelete"
    />
  </section>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Upload, Loader2, Plus, GripVertical, ArrowUp, ArrowDown, X, VolumeX, Combine, Play, Download, Trash2, RotateCcw } from 'lucide-vue-next'
import { mergeToolAPI } from '~/composables/useApi'
import { posterOf } from '~/composables/useMedia'
import { toastError } from '~/composables/useToast'

const { t } = useI18n()

function formatDuration(sec) {
  const s = Math.round(Number(sec) || 0)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// ===== 片段（草稿）：已上传但还没合成，存本地，刷新不丢 =====
const DRAFT_KEY = 'huobao:tools:merge-draft'
const clips = ref((() => {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || '[]').filter(c => c?.url) } catch { return [] }
})())
watch(clips, v => { try { localStorage.setItem(DRAFT_KEY, JSON.stringify(v)) } catch { /* 静默 */ } }, { deep: true })
const totalDuration = computed(() => clips.value.reduce((n, c) => n + (Number(c.duration) || 0), 0))

function move(i, delta) {
  const j = i + delta
  if (j < 0 || j >= clips.value.length) return
  const next = [...clips.value]
  ;[next[i], next[j]] = [next[j], next[i]]
  clips.value = next
}

// 行内拖动排序（与外部文件拖入区分：只认本列表发起的拖动）
const dragIdx = ref(null)
const overIdx = ref(null)
function onRowDragStart(i, e) {
  dragIdx.value = i
  e.dataTransfer.effectAllowed = 'move'
  e.dataTransfer.setData('text/x-huobao-clip', String(i))
}
function onRowDragOver(i) { if (dragIdx.value !== null) overIdx.value = i }
function onRowDrop(i) {
  const from = dragIdx.value
  dragIdx.value = null
  overIdx.value = null
  if (from === null || from === i) return
  const next = [...clips.value]
  const [item] = next.splice(from, 1)
  next.splice(i, 0, item)
  clips.value = next
}

// ===== 上传：可多选，逐个上传 =====
const clipInput = ref(null)
const uploading = ref(false)
const uploadDone = ref(0)
const uploadTotal = ref(0)
const uploadPct = ref(0)
async function uploadClips(files) {
  const list = [...files].filter(f => f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(f.name))
  if (!list.length) { toast.warning(t('tools.subtitle.notVideo')); return }
  if (uploading.value) return
  uploading.value = true
  uploadDone.value = 0
  uploadTotal.value = list.length
  let failed = 0
  for (const f of list) {
    uploadPct.value = 0
    try {
      const clip = await mergeToolAPI.uploadClip(f, r => { uploadPct.value = Math.round(r * 100) })
      clips.value = [...clips.value, clip]
    } catch (e) {
      failed++
      toastError(e)
    }
    uploadDone.value++
  }
  uploading.value = false
  if (list.length - failed > 0) toast.success(t('tools.merge.added', { n: list.length - failed }))
}
function onPickClips(e) {
  const files = e.target.files ? [...e.target.files] : []
  e.target.value = ''
  if (files.length) uploadClips(files)
}

// 外部文件拖入
const dragging = ref(false)
let dragDepth = 0
function isFileDrag(e) { return e.dataTransfer?.types?.includes('Files') }
function onDragEnter(e) {
  if (!isFileDrag(e)) return
  dragDepth++
  dragging.value = true
}
function onDragLeave(e) {
  if (!isFileDrag(e)) return
  dragDepth = Math.max(0, dragDepth - 1)
  if (!dragDepth) dragging.value = false
}
function onDrop(e) {
  if (!isFileDrag(e)) return
  dragDepth = 0
  dragging.value = false
  uploadClips(e.dataTransfer.files)
}

// ===== 输出尺寸：默认第一个片段；可选其他片段的尺寸或常用尺寸 =====
const sizeKey = ref('')
const sizeOptions = computed(() => {
  const out = []
  const seen = new Set()
  const add = (w, h, label) => {
    const key = `${w}x${h}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ key, w, h, label })
  }
  if (clips.value[0]) add(clips.value[0].width, clips.value[0].height, t('tools.merge.sizeFirst', { w: clips.value[0].width, h: clips.value[0].height }))
  clips.value.forEach((c, i) => add(c.width, c.height, t('tools.merge.sizeClip', { n: i + 1, w: c.width, h: c.height })))
  for (const [w, h] of [[1080, 1920], [720, 1280], [1920, 1080], [1280, 720]]) add(w, h, `${w}×${h}`)
  return out
})
// 没手动选过时始终跟随第一个片段；手动选的尺寸失效（片段被删）时也回到第一个片段
const sizePicked = ref(false)
watch(sizeOptions, opts => {
  if (!sizePicked.value || !opts.some(o => o.key === sizeKey.value)) {
    sizePicked.value = false
    sizeKey.value = opts[0]?.key || ''
  }
}, { immediate: true })
watch(() => clips.value.length, n => { if (!n) sizePicked.value = false })

// ===== 合成 =====
const submitting = ref(false)
async function merge() {
  const size = sizeOptions.value.find(o => o.key === sizeKey.value)
  submitting.value = true
  try {
    const job = await mergeToolAPI.merge({
      clips: clips.value.map(c => ({ url: c.url, name: c.name })),
      ...(size ? { width: size.w, height: size.h } : {}),
    })
    jobs.value = [job, ...jobs.value.filter(j => j.id !== job.id)]
    toast.success(t('tools.merge.started'))
  } catch (e) {
    toastError(e)
  } finally {
    submitting.value = false
  }
}
// 用某次记录的片段与顺序重新编辑
function reuse(j) {
  clips.value = j.clips.map(c => ({ ...c }))
  nextTick(() => {
    sizeKey.value = `${j.width}x${j.height}`
    sizePicked.value = sizeOptions.value.some(o => o.key === sizeKey.value)
    if (!sizePicked.value) sizeKey.value = sizeOptions.value[0]?.key || ''
  })
}

// ===== 合成记录 =====
const jobs = ref([])
const playing = ref(null)
async function loadJobs() {
  try {
    jobs.value = await mergeToolAPI.list()
    if (playing.value) playing.value = jobs.value.find(j => j.id === playing.value.id) || null
  } catch (e) { toastError(e) }
}
let pollTimer = null
watch(() => jobs.value.some(j => j.status === 'merging'), active => {
  if (active && !pollTimer) pollTimer = setInterval(loadJobs, 2500)
  if (!active && pollTimer) { clearInterval(pollTimer); pollTimer = null }
})
// 合成结束时提示，并直接播放成功的结果
watch(() => jobs.value.map(j => `${j.id}:${j.status}`).join(','), (cur, prev) => {
  if (!prev) return
  const before = new Map(prev.split(',').filter(Boolean).map(x => x.split(':')))
  for (const j of jobs.value) {
    if (before.get(String(j.id)) !== 'merging' || j.status === 'merging') continue
    if (j.status === 'done') { toast.success(t('tools.merge.done')); playing.value = j }
    else toastError(j.error_msg, { fallback: 'tools.merge.failed' })
  }
})
function downloadName(j) {
  return `${String(j.name || 'merged').replace(/[\\/:*?"<>|]/g, '_')}.mp4`
}
const toDelete = ref(null)
async function confirmDelete() {
  const j = toDelete.value
  toDelete.value = null
  if (!j) return
  try {
    await mergeToolAPI.del(j.id)
    if (playing.value?.id === j.id) playing.value = null
    await loadJobs()
  } catch (e) { toastError(e) }
}

onMounted(loadJobs)
onBeforeUnmount(() => { if (pollTimer) clearInterval(pollTimer) })
</script>

<style scoped>
.merge-tool { position: relative; flex: 1; min-width: 0; min-height: 0; display: flex; gap: 12px; }
.card { padding: 0; display: flex; flex-direction: column; min-height: 0; }
.clip-pane { flex: 1; min-width: 0; }
.job-pane { width: 380px; flex-shrink: 0; }
.pane-head { display: flex; align-items: center; gap: 8px; padding: 12px; border-bottom: 1px solid var(--border); }
.pane-title { font-size: 13px; font-weight: 650; color: var(--text-0); }
.pane-count { font-size: 12px; }

.clip-empty {
  flex: 1; margin: 12px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
  border: 1.5px dashed var(--border-strong); border-radius: var(--radius); color: var(--text-2); font-size: 12.5px; cursor: pointer;
}
.clip-empty-title { font-size: 14px; font-weight: 650; color: var(--text-0); }
.clip-list { flex: 1; overflow-y: auto; padding: 6px; display: flex; flex-direction: column; gap: 4px; }
.clip-row {
  display: flex; align-items: center; gap: 10px; padding: 6px 8px;
  border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-raised);
}
.clip-row:hover { border-color: var(--border-strong); }
.clip-row.dragging { opacity: 0.45; }
.clip-row.drop-before { box-shadow: 0 -2px 0 var(--accent); }
.clip-row.drop-after { box-shadow: 0 2px 0 var(--accent); }
.clip-grip { color: var(--text-3); cursor: grab; flex-shrink: 0; }
.clip-index { width: 18px; text-align: center; font-size: 12px; color: var(--text-2); flex-shrink: 0; }
.clip-thumb { width: 72px; height: 44px; object-fit: cover; border-radius: 6px; background: var(--media-surface); flex-shrink: 0; pointer-events: none; }
.clip-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.clip-name { font-size: 12.5px; font-weight: 600; color: var(--text-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.clip-meta { font-size: 11px; display: flex; align-items: center; gap: 6px; }
.clip-mute { display: inline-flex; align-items: center; gap: 3px; color: var(--tag-warning-text); }
.clip-actions { display: flex; gap: 2px; flex-shrink: 0; }

.merge-foot { display: flex; align-items: center; gap: 10px; padding: 12px; border-top: 1px solid var(--border); }
.size-field { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.size-select { width: auto; min-width: 200px; padding: 5px 8px; }
.foot-hint { padding: 0 12px 12px; font-size: 11.5px; }

.player { padding: 10px 12px 0; }
.player video { width: 100%; max-height: 36vh; display: block; border-radius: var(--radius); background: #000; }
.job-empty { padding: 24px 12px; text-align: center; font-size: 12px; }
.job-list { flex: 1; overflow-y: auto; padding: 6px; display: flex; flex-direction: column; gap: 4px; }
.job-row { display: flex; align-items: center; gap: 8px; padding: 8px; border: 1px solid transparent; border-radius: var(--radius); }
.job-row:hover { background: var(--bg-hover); }
.job-row.active { background: var(--accent-bg); border-color: var(--accent); }
.job-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.job-name { font-size: 12.5px; font-weight: 600; color: var(--text-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.job-meta { display: flex; align-items: center; gap: 6px; font-size: 11px; flex-wrap: wrap; }
.job-badge { display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; border-radius: 999px; font-size: 10.5px; background: var(--overlay-track); color: var(--text-2); }
.job-badge.is-done { background: var(--success-bg); color: var(--success); }
.job-badge.is-failed { background: var(--error-bg); color: var(--error); }
.job-badge.is-merging { background: var(--warning-bg); color: var(--tag-warning-text); }
.job-error { font-size: 11px; color: var(--error); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.job-actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
.job-actions a.btn { text-decoration: none; }

.drop-mask {
  position: absolute; inset: 0; z-index: 5;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px;
  border: 2px dashed var(--accent); border-radius: var(--radius-lg);
  background: var(--accent-bg); color: var(--accent-text); font-weight: 650; pointer-events: none;
}

@media (max-width: 1100px) {
  .merge-tool { flex-direction: column; }
  .job-pane { width: auto; }
}
</style>
