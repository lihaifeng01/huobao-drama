<template>
  <Teleport to="body">
    <div v-if="open" class="overlay" @click.self="emit('close')">
      <div class="dialog recap-dialog" role="dialog" aria-modal="true" :aria-label="t('recap.title')">
        <div class="recap-head">
          <div class="recap-head-copy">
            <h2 class="dialog-title">{{ t('recap.title') }}</h2>
            <p class="recap-desc">{{ t('recap.desc', { n: data?.max_episodes || 8 }) }}</p>
          </div>
          <button type="button" class="btn btn-icon btn-sm" :title="t('common.close')" @click="emit('close')"><X :size="15" /></button>
        </div>

        <div class="recap-body">
          <div v-if="loading" class="recap-loading"><Loader2 :size="18" class="animate-spin" /></div>
          <template v-else-if="data">
            <section class="recap-section">
              <div class="recap-section-title">{{ t('recap.previous') }}</div>
              <p v-if="!data.previous.length" class="recap-empty">{{ t('recap.firstEpisode') }}</p>
              <article
                v-for="ep in data.previous"
                :key="ep.id"
                class="recap-card"
                :class="{ 'is-out': !ep.in_recap }"
              >
                <RecapCardBody :ep="ep" />
              </article>
            </section>

            <section class="recap-section">
              <div class="recap-section-title">{{ t('recap.current') }}</div>
              <p class="recap-hint">{{ t('recap.currentHint') }}</p>
              <article class="recap-card">
                <RecapCardBody :ep="data.current" />
              </article>
            </section>
          </template>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { h } from 'vue'
import { toast } from 'vue-sonner'
import { useI18n } from 'vue-i18n'
import { Loader2, X } from 'lucide-vue-next'
import { episodeAPI } from '~/composables/useApi'
import { toastError } from '~/composables/useToast'

/**
 * EpisodeRecapDialog — 前情提要：查看/生成/编辑前几集与本集的剧情摘要
 * 运行剧本改写、资产提取、分镜拆解时，后端会把紧邻前 N 集的摘要拼进 Agent 指令（缺失/过期自动补）。
 * 这里供用户核对与修正：手动编辑过的摘要不会被自动重新生成覆盖。
 */
const props = defineProps({
  open: { type: Boolean, default: false },
  episodeId: { type: Number, default: null },
  model: { type: String, default: '' },
  configId: { type: Number, default: null },
})
const emit = defineEmits(['close'])

const { t } = useI18n()

const data = ref(null)
const loading = ref(false)
const generating = ref(new Set())
const editingId = ref(null)
const draft = ref('')
const saving = ref(false)

async function load({ silent = false } = {}) {
  if (!props.episodeId) return
  if (!silent) loading.value = true
  try {
    data.value = await episodeAPI.recap(props.episodeId)
  } catch (e) {
    toastError(e)
  } finally {
    loading.value = false
  }
}
watch(() => [props.open, props.episodeId], ([open]) => {
  if (!open) return
  editingId.value = null
  load()
}, { immediate: true })

function setGenerating(id, on) {
  const next = new Set(generating.value)
  if (on) next.add(id)
  else next.delete(id)
  generating.value = next
}

async function generate(ep) {
  setGenerating(ep.id, true)
  try {
    await episodeAPI.generateSummary(ep.id, props.model || undefined, props.configId || undefined)
    toast.success(t('recap.generated', { n: ep.episode_number }))
    await load({ silent: true })
  } catch (e) {
    toastError(e)
  } finally {
    setGenerating(ep.id, false)
  }
}

function startEdit(ep) {
  editingId.value = ep.id
  draft.value = ep.summary || ''
}

async function saveEdit(ep) {
  if (saving.value) return
  saving.value = true
  try {
    await episodeAPI.saveSummary(ep.id, draft.value)
    editingId.value = null
    toast.success(t('common.saved'))
    await load({ silent: true })
  } catch (e) {
    toastError(e)
  } finally {
    saving.value = false
  }
}

const STATE_CLASS = { fresh: 'is-fresh', stale: 'is-stale', missing: 'is-missing', none: 'is-none' }
function stateLabel(ep) {
  if (ep.state === 'fresh' && ep.edited) return t('recap.state.edited')
  return t(`recap.state.${ep.state}`)
}

// 卡片内容（前几集与本集共用）：标题 + 状态 + 摘要/编辑框 + 操作
const RecapCardBody = (p) => {
  const ep = p.ep
  const busy = generating.value.has(ep.id)
  const editing = editingId.value === ep.id
  const canGenerate = ep.state !== 'none'
  return [
    h('div', { class: 'recap-card-head' }, [
      h('strong', { class: 'recap-card-title' }, t('recap.episodeTitle', { n: ep.episode_number, title: ep.title })),
      h('span', { class: ['recap-state', STATE_CLASS[ep.state], ep.edited ? 'is-edited' : ''] }, stateLabel(ep)),
      ep.in_recap === false ? h('span', { class: 'recap-out-tag' }, t('recap.outOfRange')) : null,
      h('span', { class: 'recap-card-actions' }, editing ? [
        h('button', { type: 'button', class: 'btn btn-sm', onClick: () => { editingId.value = null } }, t('common.cancel')),
        h('button', { type: 'button', class: 'btn btn-sm btn-primary', disabled: saving.value, onClick: () => saveEdit(ep) }, t('common.save')),
      ] : [
        h('button', { type: 'button', class: 'btn btn-sm', disabled: busy, onClick: () => startEdit(ep) }, t('recap.edit')),
        h('button', { type: 'button', class: 'btn btn-sm', disabled: busy || !canGenerate, title: canGenerate ? '' : t('recap.noScript'), onClick: () => generate(ep) }, [
          busy ? h(Loader2, { size: 12, class: 'animate-spin' }) : null,
          busy ? t('recap.generating') : (ep.summary ? t('recap.regenerate') : t('recap.generate')),
        ]),
      ]),
    ]),
    editing
      ? h('textarea', {
        class: 'textarea recap-textarea',
        rows: 7,
        value: draft.value,
        placeholder: t('recap.placeholder'),
        onInput: (e) => { draft.value = e.target.value },
      })
      : h('p', { class: ['recap-summary', ep.summary ? '' : 'dim'] }, ep.summary || (ep.state === 'none' ? t('recap.noScript') : t('recap.notGenerated'))),
    !editing && ep.state === 'stale' && ep.edited ? h('p', { class: 'recap-warn' }, t('recap.staleEditedHint')) : null,
  ]
}
RecapCardBody.props = ['ep']
</script>

<style scoped>
.recap-dialog {
  width: min(760px, calc(100vw - 32px));
  max-height: calc(100vh - 64px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.recap-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 18px 20px 14px;
  border-bottom: 1px solid var(--border);
}
.recap-head-copy { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.recap-desc { font-size: 12px; color: var(--text-3); line-height: 1.6; }
.recap-body { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 20px 20px; display: flex; flex-direction: column; gap: 18px; }
.recap-loading { display: flex; justify-content: center; padding: 40px 0; color: var(--text-3); }
.recap-section { display: flex; flex-direction: column; gap: 8px; }
.recap-section-title { font-size: 12px; font-weight: 700; color: var(--text-2); }
.recap-hint { font-size: 11.5px; color: var(--text-3); margin-top: -4px; }
.recap-empty { font-size: 12px; color: var(--text-3); padding: 12px; border: 1px dashed var(--border-strong); border-radius: var(--radius); }
.recap-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-raised);
}
.recap-card.is-out { opacity: 0.6; }
.recap-card :deep(.recap-card-head) { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.recap-card :deep(.recap-card-title) { font-size: 13px; color: var(--text-0); }
.recap-card :deep(.recap-state) {
  padding: 1px 8px;
  border-radius: var(--radius-pill);
  font-size: 10.5px;
  font-weight: 600;
  background: var(--overlay-track);
  color: var(--text-2);
}
.recap-card :deep(.recap-state.is-fresh) { background: var(--success-bg); color: var(--tag-success-text); }
.recap-card :deep(.recap-state.is-stale) { background: var(--warning-bg); color: var(--tag-warning-text); }
.recap-card :deep(.recap-state.is-fresh.is-edited) { background: var(--info-bg); color: var(--tag-info-text); }
.recap-card :deep(.recap-out-tag) { font-size: 10.5px; color: var(--text-3); }
.recap-card :deep(.recap-card-actions) { margin-left: auto; display: inline-flex; gap: 6px; }
.recap-card :deep(.recap-summary) { font-size: 12.5px; line-height: 1.7; color: var(--text-1); white-space: pre-wrap; word-break: break-word; }
.recap-card :deep(.recap-textarea) { font-size: 12.5px; line-height: 1.7; resize: vertical; }
.recap-card :deep(.recap-warn) { font-size: 11px; color: var(--tag-warning-text); }
</style>
