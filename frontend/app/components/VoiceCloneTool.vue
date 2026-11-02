<template>
  <section class="voice-tool" @dragenter.prevent="onDragEnter" @dragover.prevent @dragleave="onDragLeave" @drop.prevent="onDrop">
    <!-- 音色列表 -->
    <div class="card job-pane">
      <div class="pane-head">
        <span class="pane-title">{{ t('tools.voice.list') }}</span>
        <span class="dim pane-count">{{ jobs.length }}</span>
        <button type="button" class="btn btn-sm btn-primary ml-auto" :disabled="uploading" @click="sampleInput?.click()">
          <Loader2 v-if="uploading" :size="12" class="animate-spin" />
          <Upload v-else :size="12" />
          {{ uploading ? t('tools.voice.uploading', { pct: uploadPct }) : t('tools.voice.uploadSample') }}
        </button>
        <input ref="sampleInput" type="file" accept=".mp3,.wav,.m4a,audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a" hidden @change="onPickSample" />
      </div>
      <div v-if="!jobs.length" class="job-empty">
        <AudioLines :size="26" :stroke-width="1.4" />
        <span>{{ t('tools.voice.empty') }}</span>
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
          <div class="job-icon"><Mic :size="16" /></div>
          <div class="job-main">
            <div class="job-name" :title="j.name">{{ j.name }}</div>
            <div class="job-meta">
              <span :class="['job-badge', 'is-' + jobState(j).cls]">
                <Loader2 v-if="j.status !== 'idle'" :size="10" class="animate-spin" />
                {{ jobState(j).label }}
              </span>
              <span class="dim mono">{{ formatDuration(j.sample_duration) }}</span>
            </div>
          </div>
          <button type="button" class="btn btn-ghost btn-icon btn-sm" :title="t('common.delete')" :disabled="j.status !== 'idle'" @click.stop="toDelete = j">
            <Trash2 :size="13" />
          </button>
        </div>
      </div>
    </div>

    <!-- 详情 -->
    <div v-if="!selected" class="card detail-empty" :class="{ dragging }" role="button" tabindex="0" @click="sampleInput?.click()">
      <Upload :size="30" :stroke-width="1.3" />
      <div class="detail-empty-title">{{ t('tools.voice.dropTitle') }}</div>
      <div class="dim">{{ t('tools.voice.dropDesc') }}</div>
    </div>
    <div v-else class="card detail">
      <div class="detail-head">
        <input
          v-if="renaming"
          ref="renameInput"
          v-model="renameValue"
          class="input rename-input"
          maxlength="100"
          @keydown.enter.prevent="saveRename"
          @keydown.esc.prevent="renaming = false"
          @blur="saveRename"
        />
        <template v-else>
          <span class="detail-name" :title="selected.name">{{ selected.name }}</span>
          <button type="button" class="btn btn-ghost btn-icon btn-sm" :title="t('tools.voice.rename')" @click="startRename"><Pencil :size="12" /></button>
        </template>
        <span :class="['job-badge', 'is-' + jobState(selected).cls, 'ml-auto']">{{ jobState(selected).label }}</span>
      </div>

      <div class="detail-body">
        <div v-if="selected.error_msg" class="panel-error">{{ selected.error_msg }}</div>

        <!-- 样本 -->
        <div class="sample-row">
          <span class="sample-label">{{ t('tools.voice.sample') }}</span>
          <audio :key="selected.sample_url" :src="'/' + selected.sample_url" controls preload="metadata" class="audio" />
          <span class="dim small mono">{{ formatDuration(selected.sample_duration) }}</span>
        </div>

        <!-- 1. 复刻 -->
        <div class="panel-section">
          <div class="section-title"><span class="section-num">1</span>{{ t('tools.voice.stepClone') }}</div>
          <div class="model-row">
            <ModelSelect
              v-if="modelOptions.length"
              v-model="cloneModel"
              :label="t('tools.voice.previewModel')"
              :options="modelOptions"
              :default-label="t('episode.model.defaultWith', { model: modelOptions[0].model })"
              :show-config="multiConfig"
            />
            <span v-else class="dim">
              {{ t('tools.voice.noConfig') }}
              <NuxtLink v-if="isAdmin" to="/settings">{{ t('episode.sub.gotoSettings') }}</NuxtLink>
            </span>
          </div>
          <div class="form-grid">
            <label class="field">
              <span class="field-label">{{ t('tools.voice.voiceId') }}</span>
              <input v-model="voiceIdInput" class="input mono" :placeholder="t('tools.voice.voiceIdPlaceholder')" maxlength="256" />
            </label>
            <label class="field">
              <span class="field-label">{{ t('tools.voice.previewText') }}</span>
              <input v-model="previewText" class="input" maxlength="300" :placeholder="t('tools.voice.previewTextPlaceholder')" />
            </label>
          </div>
          <div class="btn-row">
            <label class="check"><input v-model="noiseReduction" type="checkbox" /> {{ t('tools.voice.noiseReduction') }}</label>
            <label class="check"><input v-model="volumeNormalization" type="checkbox" /> {{ t('tools.voice.volumeNormalization') }}</label>
          </div>
          <div class="btn-row">
            <button type="button" class="btn btn-sm btn-primary" :disabled="busy || !modelOptions.length" @click="clone">
              <Loader2 v-if="selected.status === 'cloning'" :size="12" class="animate-spin" />
              <Sparkles v-else :size="12" />
              {{ selected.status === 'cloning' ? t('tools.voice.cloning') : (selected.cloned ? t('tools.voice.reclone') : t('tools.voice.clone')) }}
            </button>
            <span v-if="selected.cloned" class="dim small">{{ t('tools.voice.recloneHint') }}</span>
          </div>
          <div v-if="selected.cloned" class="clone-result">
            <div class="clone-line">
              <span class="dim">{{ t('tools.voice.voiceIdLabel') }}</span>
              <code class="mono voice-id">{{ selected.voice_id }}</code>
              <button type="button" class="btn btn-ghost btn-icon btn-sm" :title="t('tools.voice.copy')" @click="copyVoiceId"><Copy :size="12" /></button>
            </div>
            <div v-if="selected.demo_url" class="clone-line">
              <span class="dim">{{ t('tools.voice.demo') }}</span>
              <audio :key="selected.demo_url" :src="'/' + selected.demo_url" controls preload="metadata" class="audio" />
            </div>
            <div class="dim small warn">{{ t('tools.voice.expireHint') }}</div>
          </div>
        </div>

        <!-- 2. 合成 -->
        <div class="panel-section">
          <div class="section-title"><span class="section-num">2</span>{{ t('tools.voice.stepSynth') }}</div>
          <template v-if="selected.cloned">
            <div class="model-row">
              <ModelSelect
                v-if="synthOptions.length"
                v-model="synthModel"
                :label="t('tools.voice.synthModel')"
                :options="synthOptions"
                :default-label="t('episode.model.defaultWith', { model: synthOptions[0].model })"
              />
              <span v-else class="dim small warn">{{ t('tools.voice.configGone') }}</span>
            </div>
            <textarea v-model="synthText" class="textarea" rows="4" :maxlength="SYNTH_MAX" :placeholder="t('tools.voice.textPlaceholder')" />
            <div class="btn-row">
              <label class="speed">
                <span class="dim small">{{ t('tools.voice.speed') }}</span>
                <input v-model.number="speed" type="range" min="0.5" max="2" step="0.1" />
                <span class="mono small">{{ Number(speed).toFixed(1) }}×</span>
              </label>
              <span class="dim small ml-auto">{{ synthText.length }} / {{ SYNTH_MAX }}</span>
              <button type="button" class="btn btn-sm btn-primary" :disabled="busy || !synthText.trim() || !synthOptions.length" @click="synthesize">
                <Loader2 v-if="selected.status === 'synthesizing'" :size="12" class="animate-spin" />
                <AudioLines v-else :size="12" />
                {{ selected.status === 'synthesizing' ? t('tools.voice.synthesizing') : t('tools.voice.synthesize') }}
              </button>
            </div>
            <div v-if="selected.outputs.length" class="output-list">
              <div v-for="(o, i) in selected.outputs" :key="o.url" class="output-row">
                <div class="output-text" :title="o.text">{{ o.text }}</div>
                <div class="output-ctrl">
                  <audio :src="'/' + o.url" controls preload="none" class="audio" />
                  <span class="dim small mono">{{ o.model }}</span>
                  <a class="btn btn-ghost btn-icon btn-sm" :href="'/' + o.url" :download="`${selected.name}-${selected.outputs.length - i}.mp3`" :title="t('tools.voice.download')"><Download :size="12" /></a>
                  <button type="button" class="btn btn-ghost btn-icon btn-sm" :title="t('common.delete')" @click="removeOutput(o)"><X :size="12" /></button>
                </div>
              </div>
            </div>
            <div v-else class="dim small">{{ t('tools.voice.noOutputs') }}</div>
          </template>
          <div v-else class="dim small">{{ t('tools.voice.needClone') }}</div>
        </div>
      </div>
    </div>

    <div v-if="dragging" class="drop-mask">
      <Upload :size="28" />
      <span>{{ t('tools.voice.dropTitle') }}</span>
    </div>

    <ConfirmDialog
      :open="!!toDelete"
      :message="t('tools.voice.deleteConfirm', { name: toDelete?.name || '' })"
      @cancel="toDelete = null"
      @confirm="confirmDelete"
    />
  </section>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { AudioLines, Copy, Download, Loader2, Mic, Pencil, Sparkles, Trash2, Upload, X } from 'lucide-vue-next'
import { aiConfigAPI, voiceCloneToolAPI } from '~/composables/useApi'
import { useAuth } from '~/composables/useAuth'
import { toastError } from '~/composables/useToast'

const { t } = useI18n()
const { isAdmin } = useAuth()
const SYNTH_MAX = 5000

const jobs = shallowRef([])
const selectedId = ref(null)
const selected = computed(() => jobs.value.find(j => j.id === selectedId.value) || null)
const busy = computed(() => !!selected.value && selected.value.status !== 'idle')

async function loadJobs() {
  try {
    jobs.value = await voiceCloneToolAPI.list()
    if (!selected.value && jobs.value.length) selectedId.value = jobs.value[0].id
  } catch (e) { toastError(e) }
}
function patchJob(job) {
  jobs.value = jobs.value.map(j => (j.id === job.id ? job : j))
}

function jobState(j) {
  if (j.status === 'cloning') return { cls: 'pending', label: t('tools.voice.cloning') }
  if (j.status === 'synthesizing') return { cls: 'pending', label: t('tools.voice.synthesizing') }
  if (j.cloned) return { cls: 'done', label: t('tools.voice.stateCloned') }
  if (j.error_msg) return { cls: 'failed', label: t('tools.voice.stateFailed') }
  return { cls: 'idle', label: t('tools.voice.stateNew') }
}
function formatDuration(sec) {
  const s = Math.round(Number(sec) || 0)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// 有进行中的操作时轮询；结束时提示结果
let pollTimer = null
watch(() => jobs.value.some(j => j.status !== 'idle'), active => {
  if (active && !pollTimer) pollTimer = setInterval(loadJobs, 2000)
  if (!active && pollTimer) { clearInterval(pollTimer); pollTimer = null }
})
watch(() => selected.value && `${selected.value.id}:${selected.value.status}`, (cur, prev) => {
  if (!cur || !prev || cur.split(':')[0] !== prev.split(':')[0]) return
  const was = prev.split(':')[1]
  if (was === 'idle' || selected.value.status !== 'idle') return
  if (selected.value.error_msg) toastError(selected.value.error_msg)
  else toast.success(was === 'cloning' ? t('tools.voice.cloneDone') : t('tools.voice.synthDone'))
})
onBeforeUnmount(() => { if (pollTimer) clearInterval(pollTimer) })

// ===== 上传样本 =====
const sampleInput = ref(null)
const uploading = ref(false)
const uploadPct = ref(0)
async function uploadSample(file) {
  if (!file || uploading.value) return
  uploading.value = true
  uploadPct.value = 0
  try {
    const job = await voiceCloneToolAPI.create(file, r => { uploadPct.value = Math.round(r * 100) })
    await loadJobs()
    selectedId.value = job.id
    toast.success(t('tools.voice.uploaded'))
  } catch (e) {
    toastError(e)
  } finally {
    uploading.value = false
  }
}
function onPickSample(e) {
  const file = e.target.files?.[0]
  e.target.value = ''
  uploadSample(file)
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
  const file = [...(e.dataTransfer?.files || [])].find(f => /\.(mp3|wav|m4a)$/i.test(f.name))
  if (file) uploadSample(file)
  else toast.warning(t('tools.voice.notAudio'))
}

// ===== 改名 =====
const renaming = ref(false)
const renameValue = ref('')
const renameInput = ref(null)
function startRename() {
  renameValue.value = selected.value?.name || ''
  renaming.value = true
  nextTick(() => renameInput.value?.select())
}
async function saveRename() {
  if (!renaming.value) return
  renaming.value = false
  const name = renameValue.value.trim()
  if (!selected.value || !name || name === selected.value.name) return
  try { patchJob(await voiceCloneToolAPI.rename(selected.value.id, name)) } catch (e) { toastError(e) }
}

// ===== 模型选择：'provider/model' 复合键，按优先级排序，首个为默认 =====
const audioConfigs = ref([])
const MODEL_KEY = 'huobao:model:audio'
const cloneModel = ref((() => { try { return localStorage.getItem(MODEL_KEY) || '' } catch { return '' } })())
watch(cloneModel, v => { try { v ? localStorage.setItem(MODEL_KEY, v) : localStorage.removeItem(MODEL_KEY) } catch { /* 静默 */ } })
function optionsOf(configs) {
  const out = []
  const seen = new Set()
  for (const c of [...configs].sort((a, b) => (b.priority || 0) - (a.priority || 0))) {
    for (const m of (Array.isArray(c.model) ? c.model : [])) {
      const key = `${c.id}/${m}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ key, model: m, provider: c.provider, configId: c.id, configName: c.name || c.provider })
    }
  }
  return out
}
const modelOptions = computed(() => optionsOf(audioConfigs.value.filter(c => c.is_active)))
const multiConfig = computed(() => new Set(modelOptions.value.map(o => o.configId)).size > 1)
watch(modelOptions, opts => {
  if (cloneModel.value && opts.length && !opts.some(o => o.key === cloneModel.value)) cloneModel.value = ''
})
// 合成只能用复刻时的那条配置（音色属于该账号）
const synthOptions = computed(() => optionsOf(audioConfigs.value.filter(c => c.is_active && c.id === selected.value?.config_id)))
const synthModel = ref('')
watch(() => selected.value?.id, () => { synthModel.value = '' })

// ===== 复刻 =====
const voiceIdInput = ref('')
const previewText = ref('')
const noiseReduction = ref(false)
const volumeNormalization = ref(false)
watch(() => selected.value?.id, () => { voiceIdInput.value = ''; renaming.value = false })
async function clone() {
  if (!selected.value) return
  const opt = modelOptions.value.find(o => o.key === cloneModel.value)
  try {
    patchJob(await voiceCloneToolAPI.clone(selected.value.id, {
      ...(opt ? { config_id: opt.configId, model: opt.model } : {}),
      voice_id: voiceIdInput.value.trim() || undefined,
      preview_text: (previewText.value.trim() || t('tools.voice.previewTextPlaceholder')),
      noise_reduction: noiseReduction.value,
      volume_normalization: volumeNormalization.value,
    }))
  } catch (e) { toastError(e) }
}
async function copyVoiceId() {
  try {
    await navigator.clipboard.writeText(selected.value?.voice_id || '')
    toast.success(t('tools.voice.copied'))
  } catch { toast.warning(t('tools.voice.copyFailed')) }
}

// ===== 合成 =====
const synthText = ref('')
const speed = ref(1)
async function synthesize() {
  if (!selected.value) return
  const opt = synthOptions.value.find(o => o.key === synthModel.value)
  try {
    patchJob(await voiceCloneToolAPI.synthesize(selected.value.id, {
      text: synthText.value.trim(),
      model: opt?.model,
      speed: Number(speed.value),
    }))
  } catch (e) { toastError(e) }
}
async function removeOutput(o) {
  if (!selected.value) return
  try { patchJob(await voiceCloneToolAPI.removeOutput(selected.value.id, o.url)) } catch (e) { toastError(e) }
}

// ===== 删除 =====
const toDelete = ref(null)
async function confirmDelete() {
  const j = toDelete.value
  toDelete.value = null
  if (!j) return
  try {
    await voiceCloneToolAPI.del(j.id)
    if (selectedId.value === j.id) selectedId.value = null
    await loadJobs()
  } catch (e) { toastError(e) }
}

onMounted(() => {
  loadJobs()
  aiConfigAPI.list('audio').then(list => { audioConfigs.value = list || [] }).catch(() => {})
})
</script>

<style scoped>
.voice-tool { position: relative; flex: 1; min-width: 0; min-height: 0; display: flex; gap: 12px; }
.card { padding: 0; }
.job-pane { width: 290px; flex-shrink: 0; display: flex; flex-direction: column; min-height: 0; }
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
.job-icon { width: 36px; height: 36px; border-radius: 8px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; background: var(--overlay-track); color: var(--text-2); }
.job-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.job-name { font-size: 12.5px; font-weight: 600; color: var(--text-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.job-meta { display: flex; align-items: center; gap: 6px; font-size: 11px; }
.job-badge { display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; border-radius: 999px; font-size: 10.5px; background: var(--overlay-track); color: var(--text-2); white-space: nowrap; }
.job-badge.is-done { background: var(--success-bg); color: var(--success); }
.job-badge.is-failed { background: var(--error-bg); color: var(--error); }
.job-badge.is-pending { background: var(--warning-bg); color: var(--tag-warning-text); }

.detail-empty {
  flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
  border-style: dashed; color: var(--text-2); cursor: pointer; font-size: 12.5px;
}
.detail-empty-title { font-size: 14px; font-weight: 650; color: var(--text-0); }
.detail { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
.detail-head { display: flex; align-items: center; gap: 6px; padding: 12px 14px; border-bottom: 1px solid var(--border); min-height: 52px; }
.detail-name { font-size: 14px; font-weight: 650; color: var(--text-0); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rename-input { max-width: 320px; padding: 4px 8px; }
.detail-body { flex: 1; overflow-y: auto; }
.panel-error { margin: 12px 14px 0; padding: 8px 10px; border-radius: var(--radius); background: var(--error-bg); color: var(--error); font-size: 12px; }
.sample-row { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--border); }
.sample-label { font-size: 12px; color: var(--text-2); flex-shrink: 0; }
.audio { height: 32px; flex: 1; min-width: 0; max-width: 420px; }
.panel-section { padding: 14px; display: flex; flex-direction: column; gap: 10px; border-bottom: 1px solid var(--border); max-width: 860px; }
.panel-section:last-child { border-bottom: none; }
.section-title { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 650; color: var(--text-0); }
.section-num { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 50%; background: var(--accent-bg); color: var(--accent-text); font-size: 11px; }
.model-row { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.form-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); gap: 10px; }
.field { display: flex; flex-direction: column; gap: 4px; }
.field-label { font-size: 12px; color: var(--text-2); }
.btn-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.check { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-1); cursor: pointer; }
.check input { accent-color: var(--accent); }
.small { font-size: 11.5px; }
.warn { color: var(--tag-warning-text); }
.clone-result { display: flex; flex-direction: column; gap: 8px; padding: 10px; border: 1px solid var(--border); border-radius: var(--radius); }
.clone-line { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.voice-id { padding: 2px 6px; border-radius: 4px; background: var(--overlay-track); color: var(--text-0); font-size: 12px; word-break: break-all; }
.speed { display: inline-flex; align-items: center; gap: 8px; }
.speed input { width: 140px; accent-color: var(--accent); }
.output-list { display: flex; flex-direction: column; gap: 6px; }
.output-row { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius); }
.output-text { font-size: 12.5px; color: var(--text-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.output-ctrl { display: flex; align-items: center; gap: 6px; }

.drop-mask {
  position: absolute; inset: 0; z-index: 5;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px;
  border: 2px dashed var(--accent); border-radius: var(--radius-lg);
  background: var(--accent-bg); color: var(--accent-text); font-weight: 650; pointer-events: none;
}

@media (max-width: 1100px) {
  .voice-tool { flex-direction: column; }
  .job-pane { width: auto; max-height: 240px; }
  .form-grid { grid-template-columns: 1fr; }
}
</style>
