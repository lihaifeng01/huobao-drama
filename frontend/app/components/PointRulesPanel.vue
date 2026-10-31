<template>
  <div class="rules-panel">
    <div v-if="loading" class="rules-empty">{{ t('common.loading') }}</div>
    <template v-else>
      <section v-for="type in POINT_TYPES" :key="type" class="card rules-card">
        <div class="rules-head">
          <component :is="TYPE_ICONS[type]" :size="16" class="rules-icon" />
          <div class="rules-heading">
            <div class="rules-title">{{ t(`usage.type.${type}`) }}</div>
            <div class="rules-sub">{{ t('points.defaultHint') }}</div>
          </div>
          <label class="rules-default">
            <span>{{ t('points.default') }}</span>
            <input
              v-model="draft.defaults[type]"
              class="input points-input"
              type="number"
              min="0"
              step="1"
              inputmode="numeric"
            />
            <span class="rules-unit">{{ t(`points.unit.${type}`) }}</span>
          </label>
        </div>

        <div v-for="m in modelsOf(type)" :key="m.key" class="rules-row">
          <div class="rules-model">
            <span class="rules-model-name mono truncate">{{ m.model }}</span>
            <span class="rules-model-meta truncate">
              <span class="tag">{{ m.provider || '—' }}</span>
              <span v-if="m.configName">{{ m.configName }}</span>
              <span v-if="m.orphan" class="tag tag-warning">{{ t('points.notInConfig') }}</span>
            </span>
          </div>
          <input
            v-model="draft.models[m.key]"
            class="input points-input"
            type="number"
            min="0"
            step="1"
            inputmode="numeric"
            :placeholder="t('points.followDefault', { n: draft.defaults[type] ?? 0 })"
          />
          <span class="rules-unit">{{ t(`points.unit.${type}`) }}</span>
        </div>
        <p v-if="!modelsOf(type).length" class="rules-empty">{{ t('points.noModels') }}</p>
      </section>

      <section class="card rules-card rules-text">
        <div class="rules-head">
          <component :is="TYPE_ICONS.text" :size="16" class="rules-icon" />
          <div class="rules-heading">
            <div class="rules-title">{{ t('usage.type.text') }}</div>
            <div class="rules-sub">{{ t('points.textNote') }}</div>
          </div>
        </div>
      </section>

      <div class="rules-foot">
        <span v-if="dirty" class="rules-dirty">{{ t('points.unsaved') }}</span>
        <button class="btn" :disabled="!dirty || saving" @click="reset">{{ t('points.discard') }}</button>
        <button class="btn btn-primary" :disabled="!dirty || saving" @click="save">{{ saving ? t('common.loading') : t('common.save') }}</button>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { toast } from 'vue-sonner'
import { useI18n } from 'vue-i18n'
import { Image as ImageIcon, Video, Captions, MessageSquareText } from 'lucide-vue-next'
import { usageAPI } from '~/composables/useApi'
import { toastError } from '~/composables/useToast'

/**
 * 积分规则：每个类型的默认积分 + 单个模型覆盖（留空 = 跟随默认）
 * 模型列表取自 AI 服务配置里登记的模型；已有覆盖但配置里已删掉的模型也列出，方便清理
 */
const POINT_TYPES = ['image', 'video', 'subtitle'] as const
type PointType = typeof POINT_TYPES[number]
const TYPE_ICONS = { image: ImageIcon, video: Video, subtitle: Captions, text: MessageSquareText }

const { t } = useI18n()
const loading = ref(true)
const saving = ref(false)

interface ModelRow { key: string; type: PointType; provider: string; model: string; configName: string; orphan: boolean }
const rows = ref<ModelRow[]>([])
// 输入框绑定字符串 / 数字都有可能，统一在保存时规整
const draft = reactive<{ defaults: Record<string, any>; models: Record<string, any> }>({ defaults: {}, models: {} })
let original = { defaults: {} as Record<string, any>, models: {} as Record<string, any> }

const keyOf = (type: string, provider: string, model: string) => `${type}|${provider}|${model}`
const modelsOf = (type: PointType) => rows.value.filter(r => r.type === type)

const norm = (v: unknown) => (v === '' || v === null || v === undefined ? '' : String(Number(v)))
const dirty = computed(() =>
  POINT_TYPES.some(type => norm(draft.defaults[type]) !== norm(original.defaults[type]))
  || rows.value.some(r => norm(draft.models[r.key]) !== norm(original.models[r.key])))

async function load() {
  loading.value = true
  try {
    const data = await usageAPI.rules()
    const list: ModelRow[] = []
    const seen = new Set<string>()
    for (const c of data.candidates) {
      const key = keyOf(c.service_type, c.provider, c.model)
      if (seen.has(key)) continue
      seen.add(key)
      list.push({ key, type: c.service_type, provider: c.provider, model: c.model, configName: c.config_name, orphan: false })
    }
    for (const m of data.models) {
      const key = keyOf(m.service_type, m.provider, m.model)
      if (seen.has(key)) continue
      seen.add(key)
      list.push({ key, type: m.service_type, provider: m.provider, model: m.model, configName: '', orphan: true })
    }
    rows.value = list
    original = {
      defaults: { ...data.defaults },
      models: Object.fromEntries(data.models.map(m => [keyOf(m.service_type, m.provider, m.model), m.points])),
    }
    reset()
  } catch (e) {
    toastError(e)
  } finally {
    loading.value = false
  }
}

function reset() {
  draft.defaults = { ...original.defaults }
  draft.models = Object.fromEntries(rows.value.map(r => [r.key, original.models[r.key] ?? '']))
}

function validPoints(v: unknown) {
  const n = Number(v)
  return Number.isInteger(n) && n >= 0
}

async function save() {
  const defaults: Record<string, number> = {}
  for (const type of POINT_TYPES) {
    if (!validPoints(draft.defaults[type]) || draft.defaults[type] === '') {
      toast.error(t('points.invalid', { name: t(`usage.type.${type}`) }))
      return
    }
    defaults[type] = Number(draft.defaults[type])
  }
  const models: { service_type: string; provider: string; model: string; points: number | null }[] = []
  for (const r of rows.value) {
    const now = norm(draft.models[r.key])
    if (now === norm(original.models[r.key])) continue
    if (now !== '' && !validPoints(now)) {
      toast.error(t('points.invalid', { name: r.model }))
      return
    }
    models.push({ service_type: r.type, provider: r.provider, model: r.model, points: now === '' ? null : Number(now) })
  }
  saving.value = true
  try {
    await usageAPI.saveRules({ defaults, models })
    toast.success(t('points.saved'))
    await load()
  } catch (e) {
    toastError(e)
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.rules-panel { display: flex; flex-direction: column; gap: 14px; }
.rules-card { overflow: hidden; }
.rules-card:hover { border-color: var(--border); }
.rules-head {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  padding: 14px 20px;
  border-bottom: 1px solid var(--border);
}
.rules-text .rules-head { border-bottom: none; }
.rules-icon { color: var(--accent-text); flex-shrink: 0; }
.rules-heading { min-width: 0; flex: 1; }
.rules-title { font-size: 14px; font-weight: 700; color: var(--text-0); }
.rules-sub { font-size: 11.5px; color: var(--text-3); margin-top: 2px; }
.rules-default { display: flex; align-items: center; gap: 8px; font-size: 12.5px; font-weight: 600; color: var(--text-1); }
.rules-row { display: flex; align-items: center; gap: 10px; padding: 10px 20px; }
.rules-row + .rules-row { border-top: 1px solid var(--border); }
.rules-model { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.rules-model-name { font-size: 13px; color: var(--text-0); }
.rules-model-meta { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--text-3); }
.points-input { width: 110px; flex-shrink: 0; text-align: right; }
.rules-unit { width: 64px; flex-shrink: 0; font-size: 12px; font-weight: 400; color: var(--text-3); }
.rules-empty { margin: 0; padding: 12px 20px; font-size: 12px; color: var(--text-3); }
.rules-foot { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.rules-dirty { margin-right: auto; font-size: 12px; color: var(--warn-text); }
.mono { font-family: var(--font-mono); }
@media (max-width: 640px) {
  .rules-row { flex-wrap: wrap; }
  .rules-model { flex-basis: 100%; }
}
</style>
