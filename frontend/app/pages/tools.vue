<template>
  <div class="page" @dragenter.prevent="onDragEnter" @dragover.prevent @dragleave="onDragLeave" @drop.prevent="onDrop">
    <div class="tools-head">
      <h1 class="tools-title">{{ t('tools.title') }}</h1>
      <span class="tools-sub">{{ t('tools.sub') }}</span>
    </div>

    <div class="tools-body">
      <!-- 工具列表：目前只有「生成字幕」 -->
      <aside class="tool-nav">
        <button type="button" class="tool-nav-item on">
          <Captions :size="16" :stroke-width="1.8" />
          <span class="tool-nav-text">
            <span class="tool-nav-name">{{ t('tools.subtitle.name') }}</span>
            <span class="tool-nav-desc">{{ t('tools.subtitle.desc') }}</span>
          </span>
        </button>
      </aside>

      <section class="sub-tool">
        <!-- 任务列表 -->
        <div class="card job-pane">
          <div class="pane-head">
            <span class="pane-title">{{ t('tools.subtitle.jobs') }}</span>
            <span class="dim pane-count">{{ jobs.length }}</span>
            <button type="button" class="btn btn-sm btn-primary ml-auto" :disabled="uploading" @click="videoInput?.click()">
              <Loader2 v-if="uploading" :size="12" class="animate-spin" />
              <Upload v-else :size="12" />
              {{ uploading ? t('tools.subtitle.uploading', { pct: uploadPct }) : t('tools.subtitle.uploadVideo') }}
            </button>
            <input ref="videoInput" type="file" accept="video/*,.mkv" hidden @change="onPickVideo" />
          </div>
          <div v-if="!jobs.length" class="job-empty">
            <Film :size="26" :stroke-width="1.4" />
            <span>{{ t('tools.subtitle.emptyJobs') }}</span>
          </div>
          <div v-else class="job-list">
            <div
              v-for="j in jobs"
              :key="j.id"
              :class="['job-row', { active: selected?.id === j.id }]"
              role="button"
              tabindex="0"
              @click="selectedId = j.id"
              @keydown.enter.prevent="selectedId = j.id"
            >
              <video class="job-thumb" :src="'/' + j.video_url" :poster="posterOf('/' + j.video_url) || undefined" preload="none" muted playsinline tabindex="-1" />
              <div class="job-main">
                <div class="job-name" :title="j.name">{{ j.name }}</div>
                <div class="job-meta">
                  <span :class="['job-badge', 'is-' + jobState(j).cls]">
                    <Loader2 v-if="j.status !== 'idle'" :size="10" class="animate-spin" />
                    {{ jobState(j).label }}
                  </span>
                  <span class="dim mono">{{ j.width }}×{{ j.height }} · {{ formatDuration(j.duration) }}</span>
                </div>
              </div>
              <button type="button" class="btn btn-ghost btn-icon btn-sm" :title="t('common.delete')" :disabled="j.status !== 'idle'" @click.stop="toDelete = j">
                <Trash2 :size="13" />
              </button>
            </div>
          </div>
        </div>

        <!-- 任务详情 -->
        <div v-if="!selected" class="card detail-empty" :class="{ dragging }" role="button" tabindex="0" @click="videoInput?.click()">
          <Upload :size="30" :stroke-width="1.3" />
          <div class="detail-empty-title">{{ t('tools.subtitle.dropTitle') }}</div>
          <div class="dim">{{ t('tools.subtitle.dropDesc') }}</div>
        </div>
        <div v-else class="card detail">
          <div class="preview">
            <div class="preview-head">
              <span class="preview-name" :title="selected.name">{{ selected.name }}</span>
              <div v-if="selected.output_url" class="seg ml-auto">
                <button type="button" :class="['seg-item', { on: previewMode === 'edit' }]" @click="previewMode = 'edit'">{{ t('tools.subtitle.previewEdit') }}</button>
                <button type="button" :class="['seg-item', { on: previewMode === 'output' }]" @click="previewMode = 'output'">{{ t('tools.subtitle.previewOutput') }}</button>
              </div>
            </div>
            <div ref="stageWrap" class="stage-wrap">
              <div class="stage" :style="{ width: stageSize.w + 'px', height: stageSize.h + 'px' }">
                <video
                  :key="previewSrc"
                  ref="videoEl"
                  :src="previewSrc"
                  :poster="posterOf(previewSrc) || undefined"
                  controls
                  playsinline
                  preload="metadata"
                  @timeupdate="onTimeUpdate"
                  @seeked="onTimeUpdate"
                />
                <!-- 样式预览：按视频像素等比缩放，与合成结果一致 -->
                <div v-if="previewMode === 'edit' && overlayText" class="sub-overlay" :style="overlayStyle">{{ overlayText }}</div>
              </div>
            </div>
            <div v-if="previewMode === 'edit' && cues.length" class="dim preview-hint">{{ t('tools.subtitle.previewHint') }}</div>
          </div>

          <div class="panel">
            <div v-if="selected.error_msg" class="panel-error">{{ selected.error_msg }}</div>

            <!-- 1. 字幕 -->
            <div class="panel-section">
              <div class="section-title"><span class="section-num">1</span>{{ t('tools.subtitle.stepSubtitle') }}</div>
              <div class="model-row">
                <ModelSelect
                  v-if="modelOptions.length"
                  v-model="subtitleModel"
                  :label="t('tools.subtitle.model')"
                  :options="modelOptions"
                  :default-label="t('episode.model.defaultWith', { model: modelOptions[0].model })"
                  :show-config="multiConfig"
                />
                <span v-else class="dim">
                  {{ t('episode.sub.noConfig') }}
                  <NuxtLink to="/settings">{{ t('episode.sub.gotoSettings') }}</NuxtLink>
                </span>
              </div>
              <div class="btn-row">
                <button
                  type="button"
                  class="btn btn-sm btn-primary"
                  :disabled="busy || !modelOptions.length || !selected.has_audio"
                  :title="selected.has_audio ? '' : t('tools.subtitle.noAudio')"
                  @click="transcribe"
                >
                  <Loader2 v-if="selected.status === 'transcribing'" :size="12" class="animate-spin" />
                  <Sparkles v-else :size="12" />
                  {{ selected.status === 'transcribing' ? t('tools.subtitle.transcribing') : t('tools.subtitle.autoTranscribe') }}
                </button>
                <button type="button" class="btn btn-sm" :disabled="busy" @click="subtitleInput?.click()">
                  <FileUp :size="12" />
                  {{ t('tools.subtitle.uploadSubtitle') }}
                </button>
                <input ref="subtitleInput" type="file" accept=".srt,.vtt" hidden @change="onPickSubtitle" />
                <a
                  v-if="selected.subtitle_url"
                  class="btn btn-sm btn-ghost ml-auto"
                  :href="'/' + selected.subtitle_url"
                  :download="baseName(selected.name) + '.srt'"
                >
                  <Download :size="12" /> SRT
                </a>
              </div>
              <div v-if="!selected.has_audio" class="dim small">{{ t('tools.subtitle.noAudio') }}</div>
              <div v-if="selected.subtitle_url" class="cue-box">
                <div class="cue-box-head dim">
                  {{ selected.subtitle_source === 'upload' ? t('tools.subtitle.sourceUpload') : t('tools.subtitle.sourceAsr') }}
                  · {{ t('tools.subtitle.cueCount', { n: cues.length }) }}
                </div>
                <div class="cue-list">
                  <button
                    v-for="(c, i) in cues"
                    :key="i"
                    type="button"
                    :class="['cue', { on: currentCueIdx === i }]"
                    @click="seekTo(c.start)"
                  >
                    <span class="mono cue-time">{{ formatTime(c.start) }}</span>
                    <span class="cue-text">{{ c.text }}</span>
                  </button>
                </div>
              </div>
              <div v-else class="dim small">{{ t('tools.subtitle.noSubtitleYet') }}</div>
            </div>

            <!-- 2. 样式 -->
            <div class="panel-section">
              <div class="section-title">
                <span class="section-num">2</span>{{ t('tools.subtitle.stepStyle') }}
                <button type="button" class="btn btn-ghost btn-sm ml-auto" @click="resetStyle">{{ t('tools.subtitle.resetStyle') }}</button>
              </div>
              <label class="style-field">
                <span class="style-label">{{ t('tools.subtitle.fontSize') }}</span>
                <input v-model.number="fontSize" type="range" :min="12" :max="fontSizeMax" step="1" />
                <input v-model.number="fontSize" class="input style-num" type="number" :min="8" :max="fontSizeMax * 2" />
                <span class="dim small">px</span>
              </label>
              <label class="style-field">
                <span class="style-label">{{ t('tools.subtitle.position') }}</span>
                <input v-model.number="bottomPercent" type="range" min="0" max="90" step="1" />
                <input v-model.number="bottomPercent" class="input style-num" type="number" min="0" max="90" />
                <span class="dim small">%</span>
              </label>
              <div class="btn-row">
                <span class="dim small">{{ t('tools.subtitle.positionHint') }}</span>
                <div class="seg ml-auto">
                  <button v-for="p in positionPresets" :key="p.key" type="button" :class="['seg-item', { on: bottomPercent === p.value }]" @click="bottomPercent = p.value">{{ p.label }}</button>
                </div>
              </div>
              <div class="dim small">{{ t('tools.subtitle.fontDefault') }}</div>
            </div>

            <!-- 3. 合成 -->
            <div class="panel-section">
              <div class="section-title"><span class="section-num">3</span>{{ t('tools.subtitle.stepBurn') }}</div>
              <div class="btn-row">
                <button type="button" class="btn btn-sm btn-primary" :disabled="busy || !selected.subtitle_url" @click="burn">
                  <Loader2 v-if="selected.status === 'burning'" :size="12" class="animate-spin" />
                  <Clapperboard v-else :size="12" />
                  {{ selected.status === 'burning' ? t('tools.subtitle.burning') : (selected.output_url ? t('tools.subtitle.reburn') : t('tools.subtitle.burn')) }}
                </button>
                <a
                  v-if="selected.output_url"
                  class="btn btn-sm"
                  :href="'/' + selected.output_url"
                  :download="baseName(selected.name) + '-subtitled.mp4'"
                >
                  <Download :size="12" /> {{ t('tools.subtitle.downloadVideo') }}
                </a>
              </div>
              <div v-if="selected.output_url && styleDirty" class="dim small warn">{{ t('tools.subtitle.styleChanged') }}</div>
              <div v-else-if="!selected.subtitle_url" class="dim small">{{ t('tools.subtitle.needSubtitle') }}</div>
            </div>
          </div>
        </div>
      </section>
    </div>

    <div v-if="dragging" class="drop-mask">
      <Upload :size="28" />
      <span>{{ t('tools.subtitle.dropTitle') }}</span>
    </div>

    <ConfirmDialog
      :open="!!toDelete"
      :message="t('tools.subtitle.deleteConfirm', { name: toDelete?.name || '' })"
      @cancel="toDelete = null"
      @confirm="confirmDelete"
    />
  </div>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Captions, Upload, Loader2, Film, Trash2, Sparkles, FileUp, Download, Clapperboard } from 'lucide-vue-next'
import { aiConfigAPI, subtitleToolAPI } from '~/composables/useApi'
import { posterOf } from '~/composables/useMedia'
import { toastError } from '~/composables/useToast'

const { t } = useI18n()

const jobs = shallowRef([])
const selectedId = ref(null)
const selected = computed(() => jobs.value.find(j => j.id === selectedId.value) || null)
const busy = computed(() => !!selected.value && selected.value.status !== 'idle')

async function loadJobs() {
  try {
    jobs.value = await subtitleToolAPI.list()
    if (!selected.value && jobs.value.length) selectedId.value = jobs.value[0].id
  } catch (e) { toastError(e) }
}

function jobState(j) {
  if (j.status === 'transcribing') return { cls: 'pending', label: t('tools.subtitle.transcribing') }
  if (j.status === 'burning') return { cls: 'pending', label: t('tools.subtitle.burning') }
  if (j.output_url) return { cls: 'done', label: t('tools.subtitle.stateDone') }
  if (j.error_msg) return { cls: 'failed', label: t('tools.subtitle.stateFailed') }
  if (j.subtitle_url) return { cls: 'ready', label: t('tools.subtitle.stateReady') }
  return { cls: 'idle', label: t('tools.subtitle.stateNew') }
}

function formatDuration(sec) {
  const s = Math.round(Number(sec) || 0)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
function formatTime(ms) {
  const s = Math.floor(ms / 1000)
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.${Math.floor((ms % 1000) / 100)}`
}
function baseName(name) {
  return String(name || 'video').replace(/\.[^.]+$/, '')
}

// 有进行中的操作时轮询；结束时提示结果
let pollTimer = null
watch(() => jobs.value.some(j => j.status !== 'idle'), active => {
  if (active && !pollTimer) pollTimer = setInterval(loadJobs, 2500)
  if (!active && pollTimer) { clearInterval(pollTimer); pollTimer = null }
})
watch(() => selected.value && `${selected.value.id}:${selected.value.status}`, (cur, prev) => {
  if (!cur || !prev || cur.split(':')[0] !== prev.split(':')[0]) return
  const was = prev.split(':')[1]
  if (was === 'idle' || selected.value.status !== 'idle') return
  if (selected.value.error_msg) toastError(selected.value.error_msg)
  else toast.success(was === 'burning' ? t('tools.subtitle.burnDone') : t('tools.subtitle.transcribeDone'))
  if (was === 'burning' && selected.value.output_url) previewMode.value = 'output'
})
onBeforeUnmount(() => { if (pollTimer) clearInterval(pollTimer) })

// ===== 上传视频 =====
const videoInput = ref(null)
const uploading = ref(false)
const uploadPct = ref(0)
async function uploadVideo(file) {
  if (!file || uploading.value) return
  uploading.value = true
  uploadPct.value = 0
  try {
    const job = await subtitleToolAPI.create(file, r => { uploadPct.value = Math.round(r * 100) })
    await loadJobs()
    selectedId.value = job.id
    toast.success(t('tools.subtitle.uploaded'))
    // 有字幕服务且有音轨时直接开始识别
    if (job.has_audio && modelOptions.value.length) await transcribe()
  } catch (e) {
    toastError(e)
  } finally {
    uploading.value = false
  }
}
function onPickVideo(e) {
  const file = e.target.files?.[0]
  e.target.value = ''
  uploadVideo(file)
}
const dragging = ref(false)
let dragDepth = 0
function onDragEnter(e) {
  if (!e.dataTransfer?.types?.includes('Files')) return
  dragDepth++
  dragging.value = true
}
function onDragLeave() {
  dragDepth = Math.max(0, dragDepth - 1)
  if (!dragDepth) dragging.value = false
}
function onDrop(e) {
  dragDepth = 0
  dragging.value = false
  const file = [...(e.dataTransfer?.files || [])].find(f => f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(f.name))
  if (file) uploadVideo(file)
  else toast.warning(t('tools.subtitle.notVideo'))
}

// ===== 字幕：自动识别 / 手动上传 =====
const subtitleConfigs = ref([])
const SUBTITLE_MODEL_KEY = 'huobao:model:subtitle'
const subtitleModel = ref((() => { try { return localStorage.getItem(SUBTITLE_MODEL_KEY) || '' } catch { return '' } })())
watch(subtitleModel, v => { try { v ? localStorage.setItem(SUBTITLE_MODEL_KEY, v) : localStorage.removeItem(SUBTITLE_MODEL_KEY) } catch { /* 静默 */ } })
// 与剧集工作台顶栏同口径：'provider/model' 复合键，按优先级排序，首个为默认
const modelOptions = computed(() => {
  const out = []
  const seen = new Set()
  const sorted = [...subtitleConfigs.value].filter(c => c.is_active).sort((a, b) => (b.priority || 0) - (a.priority || 0))
  for (const c of sorted) {
    for (const m of (Array.isArray(c.model) ? c.model : [])) {
      const key = `${c.provider}/${m}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ key, model: m, provider: c.provider, configId: c.id, configName: c.name || c.provider })
    }
  }
  return out
})
const multiConfig = computed(() => new Set(modelOptions.value.map(o => o.configId)).size > 1)
watch(modelOptions, opts => {
  if (subtitleModel.value && opts.length && !opts.some(o => o.key === subtitleModel.value)) subtitleModel.value = ''
})
function selection() {
  const opt = modelOptions.value.find(o => o.key === subtitleModel.value)
  return opt ? { config_id: opt.configId, model: opt.model } : {}
}

async function transcribe() {
  if (!selected.value) return
  try {
    const job = await subtitleToolAPI.transcribe(selected.value.id, selection())
    patchJob(job)
  } catch (e) { toastError(e) }
}
const subtitleInput = ref(null)
async function onPickSubtitle(e) {
  const file = e.target.files?.[0]
  e.target.value = ''
  if (!file || !selected.value) return
  try {
    patchJob(await subtitleToolAPI.uploadSubtitle(selected.value.id, file))
    toast.success(t('tools.subtitle.subtitleUploaded'))
  } catch (err) { toastError(err) }
}
function patchJob(job) {
  jobs.value = jobs.value.map(j => (j.id === job.id ? job : j))
}

// 字幕条目：读取 SRT 文件用于列表与预览
const cues = ref([])
function parseSrt(text) {
  const toMs = s => {
    const m = String(s).trim().match(/^(?:(\d+):)?(\d+):(\d+)[,.](\d+)/)
    return m ? ((Number(m[1] || 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Math.round(Number(`0.${m[4]}`) * 1000) : 0
  }
  return String(text || '').replace(/\r/g, '').split(/\n{2,}/).map(block => {
    const lines = block.trim().split('\n')
    const i = lines.findIndex(l => l.includes('-->'))
    if (i < 0) return null
    const [a, b] = lines[i].split('-->')
    return { start: toMs(a), end: toMs(b), text: lines.slice(i + 1).join('\n') }
  }).filter(c => c && c.text)
}
watch(() => selected.value?.subtitle_url, async url => {
  cues.value = []
  if (!url) return
  try {
    const res = await fetch('/' + url)
    if (res.ok && selected.value?.subtitle_url === url) cues.value = parseSrt(await res.text())
  } catch { /* 静默 */ }
}, { immediate: true })

// ===== 预览 =====
const previewMode = ref('edit')
const previewSrc = computed(() => {
  const j = selected.value
  if (!j) return ''
  return '/' + (previewMode.value === 'output' && j.output_url ? j.output_url : j.video_url)
})
watch(selectedId, () => { previewMode.value = 'edit'; currentTime.value = 0 })
watch(() => selected.value?.output_url, url => { if (!url) previewMode.value = 'edit' })

const videoEl = ref(null)
const currentTime = ref(0)
function onTimeUpdate() { currentTime.value = (videoEl.value?.currentTime || 0) * 1000 }
function seekTo(ms) {
  if (previewMode.value !== 'edit') previewMode.value = 'edit'
  nextTick(() => { if (videoEl.value) videoEl.value.currentTime = ms / 1000 + 0.01; currentTime.value = ms })
}
const currentCueIdx = computed(() => cues.value.findIndex(c => currentTime.value >= c.start && currentTime.value < c.end))
// 没在播放某条字幕时用第一条示意，方便调样式
const overlayText = computed(() => cues.value[currentCueIdx.value]?.text || (currentTime.value < 1 ? cues.value[0]?.text : '') || '')

// 舞台按视频比例放进可用区域（contain），用于把视频像素换算成屏幕像素
const stageWrap = ref(null)
const wrapSize = ref({ w: 0, h: 0 })
let resizeObs = null
onMounted(() => {
  loadJobs()
  aiConfigAPI.list('subtitle').then(list => { subtitleConfigs.value = list || [] }).catch(() => {})
  resizeObs = new ResizeObserver(([entry]) => { wrapSize.value = { w: entry.contentRect.width, h: entry.contentRect.height } })
})
watch(stageWrap, el => { resizeObs?.disconnect(); if (el) resizeObs?.observe(el) })
onBeforeUnmount(() => resizeObs?.disconnect())
const stageSize = computed(() => {
  const j = selected.value
  const vw = j?.width || 16
  const vh = j?.height || 9
  const { w, h } = wrapSize.value
  if (!w || !h) return { w: 0, h: 0 }
  const scale = Math.min(w / vw, h / vh)
  return { w: Math.floor(vw * scale), h: Math.floor(vh * scale) }
})
const scale = computed(() => (selected.value?.height ? stageSize.value.h / selected.value.height : 1))

// ===== 样式 =====
const fontSize = ref(40)
const bottomPercent = ref(6)
watch(() => selected.value?.id, () => {
  const s = selected.value?.style
  if (!s) return
  fontSize.value = s.font_size
  bottomPercent.value = s.bottom_percent
}, { immediate: true })
const fontSizeMax = computed(() => Math.max(48, Math.round(Math.max(selected.value?.width || 0, selected.value?.height || 0) / 10)))
const styleDirty = computed(() => !!selected.value
  && (selected.value.style.font_size !== fontSize.value || selected.value.style.bottom_percent !== bottomPercent.value))
const positionPresets = computed(() => [
  { key: 'bottom', label: t('tools.subtitle.posBottom'), value: selected.value?.default_style?.bottom_percent ?? 6 },
  { key: 'middle', label: t('tools.subtitle.posMiddle'), value: 45 },
  { key: 'top', label: t('tools.subtitle.posTop'), value: 80 },
])
function resetStyle() {
  const d = selected.value?.default_style
  if (!d) return
  fontSize.value = d.font_size
  bottomPercent.value = d.bottom_percent
}
// 与后端 ASS 样式一致：白字黑描边（描边约为字号 7%），水平居中，左右各留 5%
const overlayStyle = computed(() => {
  const px = fontSize.value * scale.value
  const stroke = Math.max(1, Math.round(fontSize.value * 0.07)) * scale.value
  return {
    fontSize: `${px}px`,
    bottom: `${bottomPercent.value}%`,
    WebkitTextStroke: `${stroke * 2}px #000`,
    paintOrder: 'stroke fill',
  }
})

async function burn() {
  if (!selected.value) return
  try {
    patchJob(await subtitleToolAPI.burn(selected.value.id, { font_size: Number(fontSize.value), bottom_percent: Number(bottomPercent.value) }))
  } catch (e) { toastError(e) }
}

// ===== 删除 =====
const toDelete = ref(null)
async function confirmDelete() {
  const j = toDelete.value
  toDelete.value = null
  if (!j) return
  try {
    await subtitleToolAPI.del(j.id)
    if (selectedId.value === j.id) selectedId.value = null
    await loadJobs()
  } catch (e) { toastError(e) }
}
</script>

<style scoped>
.page {
  position: relative;
  padding: 20px 28px 28px;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: fadeUp 0.35s var(--ease-out) both;
  background: var(--surface-base);
}
.tools-head { display: flex; align-items: baseline; gap: 12px; padding-bottom: var(--sp-4); }
.tools-title { font-size: 20px; font-weight: 650; letter-spacing: -0.02em; color: var(--text-0); }
.tools-sub { color: var(--text-3); font-size: 12.5px; }
.tools-body { flex: 1; min-height: 0; display: flex; gap: 16px; }

.tool-nav { width: 200px; flex-shrink: 0; display: flex; flex-direction: column; gap: 4px; }
.tool-nav-item {
  display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px;
  border: 1px solid transparent; border-radius: var(--radius); background: transparent;
  color: var(--text-1); text-align: left; cursor: pointer;
}
.tool-nav-item.on { background: var(--accent-bg); border-color: var(--accent); color: var(--accent-text); }
.tool-nav-text { display: flex; flex-direction: column; gap: 2px; }
.tool-nav-name { font-size: 13px; font-weight: 650; }
.tool-nav-desc { font-size: 11.5px; color: var(--text-3); line-height: 1.4; }

.sub-tool { flex: 1; min-width: 0; display: flex; gap: 12px; }
.card { padding: 0; }
.job-pane { width: 280px; flex-shrink: 0; display: flex; flex-direction: column; min-height: 0; }
.pane-head { display: flex; align-items: center; gap: 8px; padding: 12px; border-bottom: 1px solid var(--border); }
.pane-title { font-size: 13px; font-weight: 650; color: var(--text-0); }
.pane-count { font-size: 12px; }
.job-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: var(--text-3); font-size: 12px; padding: 24px; text-align: center; }
.job-list { flex: 1; overflow-y: auto; padding: 6px; display: flex; flex-direction: column; gap: 4px; }
.job-row {
  display: flex; align-items: center; gap: 10px; padding: 6px 8px;
  border: 1px solid transparent; border-radius: var(--radius); cursor: pointer;
}
.job-row:hover { background: var(--bg-hover); }
.job-row.active { background: var(--accent-bg); border-color: var(--accent); }
.job-thumb { width: 56px; height: 40px; object-fit: cover; border-radius: 6px; background: var(--media-surface); flex-shrink: 0; pointer-events: none; }
.job-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.job-name { font-size: 12.5px; font-weight: 600; color: var(--text-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.job-meta { display: flex; align-items: center; gap: 6px; font-size: 11px; }
.job-badge { display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; border-radius: 999px; font-size: 10.5px; background: var(--overlay-track); color: var(--text-2); }
.job-badge.is-done { background: var(--success-bg); color: var(--success); }
.job-badge.is-ready { background: var(--accent-bg); color: var(--accent-text); }
.job-badge.is-failed { background: var(--error-bg); color: var(--error); }
.job-badge.is-pending { background: var(--warning-bg); color: var(--tag-warning-text); }

.detail-empty {
  flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
  border-style: dashed; color: var(--text-2); cursor: pointer; font-size: 12.5px;
}
.detail-empty-title { font-size: 14px; font-weight: 650; color: var(--text-0); }
.detail { flex: 1; min-width: 0; display: flex; min-height: 0; }
.preview { flex: 1; min-width: 0; display: flex; flex-direction: column; padding: 12px; gap: 8px; }
.preview-head { display: flex; align-items: center; gap: 8px; min-height: 30px; }
.preview-name { font-size: 13px; font-weight: 650; color: var(--text-0); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.stage-wrap { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; background: var(--media-surface); border-radius: var(--radius); overflow: hidden; }
.stage { position: relative; }
.stage video { width: 100%; height: 100%; display: block; background: #000; }
.sub-overlay {
  position: absolute; left: 5%; right: 5%;
  text-align: center; color: #fff; line-height: 1.2; white-space: pre-line;
  font-family: "PingFang SC", "Microsoft YaHei", "WenQuanYi Micro Hei", "Noto Sans CJK SC", sans-serif;
  pointer-events: none;
}
.preview-hint { font-size: 11.5px; }

.panel { width: 340px; flex-shrink: 0; border-left: 1px solid var(--border); overflow-y: auto; display: flex; flex-direction: column; }
.panel-error { margin: 12px 12px 0; padding: 8px 10px; border-radius: var(--radius); background: var(--error-bg); color: var(--error); font-size: 12px; }
.panel-section { padding: 14px; display: flex; flex-direction: column; gap: 10px; border-bottom: 1px solid var(--border); }
.panel-section:last-child { border-bottom: none; }
.section-title { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 650; color: var(--text-0); }
.section-num { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 50%; background: var(--accent-bg); color: var(--accent-text); font-size: 11px; }
.model-row { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.btn-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.small { font-size: 11.5px; }
.warn { color: var(--tag-warning-text); }
.cue-box { border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
.cue-box-head { padding: 6px 10px; font-size: 11.5px; border-bottom: 1px solid var(--border); }
.cue-list { max-height: 220px; overflow-y: auto; padding: 4px; }
.cue { display: flex; gap: 10px; width: 100%; padding: 4px 6px; border: none; border-radius: 6px; background: transparent; color: var(--text-1); font-size: 12.5px; text-align: left; cursor: pointer; }
.cue:hover { background: var(--bg-hover); }
.cue.on { background: var(--accent-bg); color: var(--accent-text); }
.cue-time { color: var(--text-3); font-size: 11px; padding-top: 1px; white-space: nowrap; }
.cue-text { white-space: pre-line; }
.style-field { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.style-label { width: 56px; flex-shrink: 0; color: var(--text-2); }
.style-field input[type="range"] { flex: 1; min-width: 0; accent-color: var(--accent); }
.style-num { width: 64px; flex-shrink: 0; padding: 4px 6px; }

.drop-mask {
  position: absolute; inset: 12px; z-index: 5;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px;
  border: 2px dashed var(--accent); border-radius: var(--radius-lg);
  background: var(--accent-bg); color: var(--accent-text); font-weight: 650; pointer-events: none;
}

@media (max-width: 1100px) {
  .tools-body { flex-direction: column; }
  .tool-nav { width: auto; flex-direction: row; }
  .sub-tool { flex-direction: column; }
  .job-pane { width: auto; max-height: 240px; }
  .detail { flex-direction: column; }
  .panel { width: auto; border-left: none; border-top: 1px solid var(--border); }
  .stage-wrap { min-height: 320px; }
}
</style>
