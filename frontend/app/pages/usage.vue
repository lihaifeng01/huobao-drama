<template>
  <div class="page usage-page">
    <div class="usage-head">
      <div>
        <h1 class="usage-title">{{ t('usage.title') }}</h1>
        <p class="usage-sub">{{ isAdmin ? t('usage.subAdmin') : t('usage.subSelf') }}</p>
      </div>
      <div class="usage-filters">
        <div class="chip-row">
          <button
            v-for="r in RANGES"
            :key="r"
            type="button"
            class="filter-chip"
            :class="{ on: range === r }"
            @click="range = r"
          >{{ t(`usage.range.${r}`) }}</button>
        </div>
        <div v-if="isAdmin && isMultiUser" class="member-select">
          <BaseSelect v-model="memberId" :options="memberOptions" :searchable="true" />
        </div>
      </div>
    </div>

    <!-- 四个分类 -->
    <div class="type-grid">
      <button
        v-for="s in summary"
        :key="s.service_type"
        type="button"
        class="card type-card"
        :class="{ on: activeType === s.service_type }"
        @click="selectType(s.service_type)"
      >
        <div class="type-top">
          <component :is="TYPE_ICONS[s.service_type]" :size="16" class="type-icon" />
          <span class="type-name">{{ t(`usage.type.${s.service_type}`) }}</span>
          <span class="type-count">{{ t('usage.calls', { n: fmtInt(s.count) }) }}</span>
        </div>
        <div class="type-main">
          <template v-if="s.service_type === 'text'">
            <span class="type-points">{{ fmtTokens(s.quantity) }}</span>
            <span class="type-points-unit">tokens</span>
          </template>
          <template v-else>
            <span class="type-points">{{ fmtInt(s.points) }}</span>
            <span class="type-points-unit">{{ t('usage.pointsUnit') }}</span>
          </template>
        </div>
        <div class="type-foot">
          <span v-if="s.service_type !== 'text'">{{ t('usage.amount', { q: fmtQuantity(s.service_type, s.quantity) }) }}</span>
          <span v-else>{{ t('usage.textOnly') }}</span>
          <span v-if="s.held" class="tag tag-warning">{{ t('usage.status.held') }} {{ s.held }}</span>
          <span v-if="s.refunded" class="tag">{{ t(s.service_type === 'text' ? 'usage.status.failed' : 'usage.status.refunded') }} {{ s.refunded }}</span>
        </div>
      </button>
    </div>

    <!-- 选中分类：每个模型的用量 -->
    <section v-if="activeType" class="card usage-card">
      <div class="usage-card-head">
        <h2 class="usage-card-title">{{ t('usage.byModel', { type: t(`usage.type.${activeType}`) }) }}</h2>
        <button v-if="activeModel" class="btn btn-ghost btn-sm" @click="selectModel(null)">{{ t('usage.clearModel') }}</button>
      </div>
      <div class="table-wrap">
        <table class="usage-table">
          <thead>
            <tr>
              <th>{{ t('usage.col.model') }}</th>
              <th class="num">{{ t('usage.col.count') }}</th>
              <th class="num hide-sm">{{ t('usage.col.succeeded') }}</th>
              <th class="num hide-sm">{{ activeType === 'text' ? t('usage.status.failed') : t('usage.status.refunded') }}</th>
              <th v-if="activeType !== 'text'" class="num hide-sm">{{ t('usage.status.held') }}</th>
              <th class="num">{{ t('usage.col.amount') }}</th>
              <th v-if="activeType !== 'text'" class="num">{{ t('usage.col.points') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="modelsLoading"><td :colspan="7" class="empty">{{ t('common.loading') }}</td></tr>
            <tr v-else-if="!models.length"><td :colspan="7" class="empty">{{ t('usage.empty') }}</td></tr>
            <tr
              v-for="m in models"
              v-else
              :key="`${m.provider}|${m.model}`"
              class="clickable"
              :class="{ on: activeModel && activeModel.provider === m.provider && activeModel.model === m.model }"
              @click="selectModel(m)"
            >
              <td>
                <div class="model-cell">
                  <span class="mono truncate">{{ m.model || t('usage.unknownModel') }}</span>
                  <span class="tag">{{ m.provider || '—' }}</span>
                </div>
              </td>
              <td class="num">{{ fmtInt(m.count) }}</td>
              <td class="num hide-sm">{{ fmtInt(m.succeeded) }}</td>
              <td class="num hide-sm">{{ fmtInt(m.refunded) }}</td>
              <td v-if="activeType !== 'text'" class="num hide-sm">{{ fmtInt(m.held) }}</td>
              <td class="num">{{ fmtQuantity(activeType, m.quantity) }}</td>
              <td v-if="activeType !== 'text'" class="num strong">{{ fmtInt(m.points) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- 使用记录明细 -->
    <section class="card usage-card">
      <div class="usage-card-head">
        <h2 class="usage-card-title">
          {{ t('usage.history') }}
          <span v-if="activeModel" class="history-scope">· {{ activeModel.model || t('usage.unknownModel') }}</span>
          <span v-else-if="activeType" class="history-scope">· {{ t(`usage.type.${activeType}`) }}</span>
        </h2>
        <span class="dim">{{ t('usage.total', { n: fmtInt(records.total) }) }}</span>
      </div>
      <div class="table-wrap">
        <table class="usage-table">
          <thead>
            <tr>
              <th>{{ t('usage.col.time') }}</th>
              <th v-if="isAdmin && isMultiUser && !memberId">{{ t('usage.col.user') }}</th>
              <th class="hide-sm">{{ t('usage.col.project') }}</th>
              <th>{{ t('usage.col.source') }}</th>
              <th class="hide-sm">{{ t('usage.col.model') }}</th>
              <th class="num">{{ t('usage.col.amount') }}</th>
              <th class="num">{{ t('usage.col.points') }}</th>
              <th>{{ t('usage.col.status') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="recordsLoading"><td colspan="8" class="empty">{{ t('common.loading') }}</td></tr>
            <tr v-else-if="!records.items.length"><td colspan="8" class="empty">{{ t('usage.empty') }}</td></tr>
            <tr v-for="r in records.items" v-else :key="r.id">
              <td class="dim nowrap">{{ fmtTime(r.created_at) }}</td>
              <td v-if="isAdmin && isMultiUser && !memberId" class="truncate">{{ r.user_name || '—' }}</td>
              <td class="hide-sm truncate">{{ r.drama_title || '—' }}</td>
              <td class="nowrap">{{ sourceLabel(r) }}</td>
              <td class="hide-sm"><span class="mono truncate">{{ r.model || '—' }}</span></td>
              <td class="num nowrap">
                {{ fmtQuantity(r.service_type, r.quantity) }}
                <span v-if="r.detail?.usageMissing" class="tag" :title="t('usage.usageMissingHint')">?</span>
              </td>
              <td class="num" :class="{ struck: r.status === 'refunded' }">{{ r.service_type === 'text' ? '—' : fmtInt(r.points) }}</td>
              <td><span class="tag" :class="STATUS_CLASS[r.status]">{{ statusLabel(r) }}</span></td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="records.total > PAGE_SIZE" class="pager">
        <button class="btn btn-sm btn-icon" :disabled="page <= 1" :title="t('usage.prev')" @click="page--"><ChevronLeft :size="14" /></button>
        <span class="dim">{{ page }} / {{ pageCount }}</span>
        <button class="btn btn-sm btn-icon" :disabled="page >= pageCount" :title="t('usage.next')" @click="page++"><ChevronRight :size="14" /></button>
      </div>
    </section>

    <p class="usage-note">{{ t('usage.note') }}</p>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Image as ImageIcon, Video, Captions, MessageSquareText, ChevronLeft, ChevronRight } from 'lucide-vue-next'
import { usageAPI, userAPI, type UsageType, type UsageFilter } from '~/composables/useApi'
import { useAuth } from '~/composables/useAuth'
import { toastError } from '~/composables/useToast'
import BaseSelect from '~/components/BaseSelect.vue'

const TYPE_ICONS: Record<UsageType, any> = { image: ImageIcon, video: Video, subtitle: Captions, text: MessageSquareText }
const RANGES = ['month', 'week', 'days30', 'all'] as const
const PAGE_SIZE = 20
const STATUS_CLASS: Record<string, string> = { succeeded: 'tag-success', pending: 'tag-info', held: 'tag-warning', refunded: '' }

const { t, locale } = useI18n()
const { isAdmin, isMultiUser } = useAuth()

const range = ref<typeof RANGES[number]>('month')
const memberId = ref<number | ''>('')
const members = ref<{ id: number; display_name: string; username: string }[]>([])
const memberOptions = computed(() => [
  { label: t('usage.allMembers'), value: '' },
  ...members.value.map(u => ({ label: `${u.display_name}（${u.username}）`, value: u.id })),
])

const summary = ref<any[]>([])
const activeType = ref<UsageType | null>(null)
const models = ref<any[]>([])
const modelsLoading = ref(false)
const activeModel = ref<{ provider: string; model: string } | null>(null)
const records = ref<{ total: number; items: any[] }>({ total: 0, items: [] })
const recordsLoading = ref(false)
const page = ref(1)
const pageCount = computed(() => Math.max(1, Math.ceil(records.value.total / PAGE_SIZE)))

/** 时间范围 → from（本地时区的本月 1 日 / N 天前） */
function baseFilter(): UsageFilter {
  const f: UsageFilter = {}
  const d = new Date()
  if (range.value === 'month') f.from = new Date(d.getFullYear(), d.getMonth(), 1).toISOString()
  else if (range.value === 'week') f.from = new Date(d.getTime() - 7 * 86400_000).toISOString()
  else if (range.value === 'days30') f.from = new Date(d.getTime() - 30 * 86400_000).toISOString()
  if (memberId.value) f.user_id = Number(memberId.value)
  return f
}

async function loadSummary() {
  try {
    summary.value = await usageAPI.summary(baseFilter())
  } catch (e) {
    toastError(e)
  }
}

async function loadModels() {
  if (!activeType.value) { models.value = []; return }
  modelsLoading.value = true
  try {
    models.value = await usageAPI.models(activeType.value, baseFilter())
  } catch (e) {
    toastError(e)
  } finally {
    modelsLoading.value = false
  }
}

async function loadRecords() {
  recordsLoading.value = true
  try {
    records.value = await usageAPI.records({
      ...baseFilter(),
      service_type: activeType.value || undefined,
      ...(activeModel.value ? { provider: activeModel.value.provider, model: activeModel.value.model } : {}),
      page: page.value,
      page_size: PAGE_SIZE,
    })
  } catch (e) {
    toastError(e)
  } finally {
    recordsLoading.value = false
  }
}

/** 点分类：展开该分类的模型用量，明细也只看这个分类；再点一次取消 */
function selectType(type: UsageType) {
  activeType.value = activeType.value === type ? null : type
  activeModel.value = null
  page.value = 1
  loadModels()
  loadRecords()
}

/** 点模型：明细只看这个模型；再点一次取消 */
function selectModel(m: { provider: string; model: string } | null) {
  const same = m && activeModel.value && activeModel.value.provider === m.provider && activeModel.value.model === m.model
  activeModel.value = m && !same ? { provider: m.provider, model: m.model } : null
  page.value = 1
  loadRecords()
}

function reloadAll() {
  page.value = 1
  loadSummary()
  loadModels()
  loadRecords()
}

watch([range, memberId], reloadAll)
watch(page, loadRecords)

// ---------- 格式化 ----------
const fmtInt = (n: number) => Number(n || 0).toLocaleString(locale.value)
function fmtTokens(n: number) {
  const v = Number(n || 0)
  return v >= 10_000 ? `${(v / 1000).toLocaleString(locale.value, { maximumFractionDigits: 1 })}k` : fmtInt(v)
}
function fmtQuantity(type: string | null, q: number) {
  const v = Number(q || 0)
  switch (type) {
    case 'image': return t('usage.qty.image', { n: fmtInt(v) })
    case 'video': return t('usage.qty.video', { n: v.toLocaleString(locale.value, { maximumFractionDigits: 1 }) })
    case 'subtitle': return t('usage.qty.subtitle', { n: (v / 60).toLocaleString(locale.value, { maximumFractionDigits: 1 }) })
    case 'text': return `${fmtTokens(v)} tokens`
    default: return String(v)
  }
}
function fmtTime(iso: string) {
  return new Date(iso).toLocaleString(locale.value, { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}
/** 发起场景：agent:xxx / extract:xxx 归成一类显示 */
function sourceLabel(r: any) {
  const src = String(r.source || r.service_type)
  const key = src.startsWith('agent:') ? 'agent' : src.startsWith('extract:') ? 'extract' : src
  const label = t(`usage.source.${key}`)
  return label.startsWith('usage.source.') ? src : label
}
function statusLabel(r: any) {
  if (r.status === 'refunded' && r.service_type === 'text') return t('usage.status.failed')
  return t(`usage.status.${r.status}`)
}

onMounted(async () => {
  if (isAdmin.value && isMultiUser.value) userAPI.options().then(list => { members.value = list }).catch(() => {})
  await loadSummary()
  loadRecords()
})
</script>

<style scoped>
.usage-page { padding: 20px 28px 48px; overflow-y: auto; height: 100%; }
.usage-page > * { max-width: 1180px; margin-left: auto; margin-right: auto; }
.usage-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; }
.usage-title { font-size: 20px; font-weight: 700; color: var(--text-0); margin: 0; }
.usage-sub { margin: 4px 0 0; font-size: 13px; color: var(--text-3); }
.usage-filters { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.chip-row { display: flex; gap: 6px; flex-wrap: wrap; }
.filter-chip {
  min-height: 30px; padding: 0 12px;
  border: 1px solid var(--border); border-radius: var(--radius-pill);
  background: var(--surface-raised); color: var(--text-2);
  font: 600 12px var(--font-body); cursor: pointer;
  transition: all 0.15s var(--ease-out);
}
.filter-chip:hover { color: var(--text-0); border-color: var(--border-hover); }
.filter-chip.on { background: var(--inverse-surface); color: var(--on-inverse); border-color: transparent; }
.member-select { width: 200px; }

.type-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 14px; }
.type-card {
  display: flex; flex-direction: column; gap: 10px;
  padding: 14px 16px; text-align: left;
  font: inherit; color: inherit; cursor: pointer;
  transition: border-color 0.15s var(--ease-out), box-shadow 0.15s var(--ease-out);
}
.type-card.on { border-color: var(--accent); box-shadow: 0 0 0 3px var(--button-focus); }
.type-card:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--button-focus); }
.type-top { display: flex; align-items: center; gap: 8px; }
.type-icon { color: var(--accent-text); }
.type-name { font-size: 13px; font-weight: 700; color: var(--text-0); }
.type-count { margin-left: auto; font-size: 11.5px; color: var(--text-3); }
.type-main { display: flex; align-items: baseline; gap: 6px; }
.type-points { font-size: 26px; font-weight: 800; letter-spacing: -0.02em; color: var(--text-0); font-variant-numeric: tabular-nums; }
.type-points-unit { font-size: 12px; color: var(--text-3); }
.type-foot { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 11.5px; color: var(--text-2); }

.usage-card { padding: 0; overflow: hidden; margin-bottom: 14px; }
.usage-card:hover { border-color: var(--border); }
.usage-card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--border); }
.usage-card-title { margin: 0; font-size: 14px; font-weight: 700; color: var(--text-0); }
.history-scope { font-weight: 500; color: var(--text-2); }
.table-wrap { overflow-x: auto; }
.usage-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.usage-table th { text-align: left; font-weight: 600; font-size: 11.5px; color: var(--text-3); padding: 9px 16px; border-bottom: 1px solid var(--border); white-space: nowrap; }
.usage-table td { padding: 9px 16px; border-bottom: 1px solid var(--border); color: var(--text-1); max-width: 240px; }
.usage-table tr:last-child td { border-bottom: none; }
.usage-table .num { text-align: right; font-variant-numeric: tabular-nums; }
.usage-table .strong { font-weight: 700; color: var(--text-0); }
.usage-table .empty { text-align: center; color: var(--text-3); padding: 20px; }
.usage-table tr.clickable { cursor: pointer; }
.usage-table tr.clickable:hover td { background: var(--bg-hover); }
.usage-table tr.on td { background: var(--accent-bg); }
.model-cell { display: flex; align-items: center; gap: 8px; min-width: 0; }
.struck { text-decoration: line-through; color: var(--text-3) !important; }
.nowrap { white-space: nowrap; }
.dim { color: var(--text-3); font-size: 12px; }
.mono { font-family: var(--font-mono); }
.pager { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 10px; border-top: 1px solid var(--border); }
.usage-note { font-size: 12px; color: var(--text-3); line-height: 1.6; margin-top: 4px; }
@media (max-width: 900px) { .type-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 640px) {
  .usage-page { padding: 16px; }
  .hide-sm { display: none; }
  .member-select { width: 100%; }
}
</style>
