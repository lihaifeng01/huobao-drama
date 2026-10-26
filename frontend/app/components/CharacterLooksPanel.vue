<template>
  <section class="looks-panel">
    <div class="looks-head">
      <span class="looks-title">{{ t('looks.title') }}</span>
      <span class="looks-hint dim">{{ hasPortrait ? t('looks.hintWithRef') : t('looks.hintNoRef') }}</span>
    </div>

    <div class="looks-grid">
      <!-- 默认造型：角色自身形象图，只读展示 -->
      <article class="look-card is-default">
        <div class="look-cover">
          <img v-if="portrait" :src="thumbOf(portrait)" :alt="character.name" loading="lazy" @error="thumbFallback($event, portrait)" />
          <span v-else class="look-empty">{{ t('looks.noImage') }}</span>
          <span class="look-badge">{{ t('looks.default') }}</span>
        </div>
        <div class="look-body">
          <strong class="look-name truncate">{{ t('looks.defaultName') }}</strong>
          <span class="look-desc dim">{{ t('looks.defaultDesc') }}</span>
        </div>
      </article>

      <article v-for="look in looks" :key="look.id" class="look-card">
        <template v-if="editingId === look.id">
          <div class="look-form">
            <input v-model="draft.name" class="input" maxlength="50" :placeholder="t('looks.namePlaceholder')" />
            <textarea v-model="draft.description" class="textarea" rows="3" :placeholder="t('looks.descPlaceholder')" />
            <div class="look-form-actions">
              <button type="button" class="btn btn-sm" @click="editingId = null">{{ t('common.cancel') }}</button>
              <button type="button" class="btn btn-sm btn-primary" :disabled="!draft.name.trim() || saving" @click="saveEdit(look)">{{ t('common.save') }}</button>
            </div>
          </div>
        </template>
        <template v-else>
          <div class="look-cover">
            <img v-if="look.image_url" :src="thumbOf(src(look.image_url))" :alt="look.name" loading="lazy" @error="thumbFallback($event, src(look.image_url))" />
            <span v-else class="look-empty">{{ isPending(look) ? t('looks.generating') : t('looks.noImage') }}</span>
            <span v-if="isPending(look)" class="look-spinner"><Loader2 :size="16" class="animate-spin" /></span>
          </div>
          <div class="look-body">
            <strong class="look-name truncate" :title="look.name">{{ look.name }}</strong>
            <span class="look-desc dim" :title="look.description">{{ look.description || t('looks.noDesc') }}</span>
          </div>
          <div class="look-actions">
            <button type="button" class="btn btn-sm" :disabled="isPending(look)" @click="generate(look)">
              {{ look.image_url ? t('looks.regenerate') : t('looks.generate') }}
            </button>
            <button type="button" class="btn btn-icon btn-sm look-icon-btn" :title="t('looks.upload')" :disabled="isPending(look)" @click="upload(look)">
              <Upload :size="12" />
            </button>
            <button type="button" class="btn btn-icon btn-sm look-icon-btn" :title="t('looks.edit')" @click="startEdit(look)">
              <Pencil :size="12" />
            </button>
            <button type="button" class="btn btn-icon btn-sm look-icon-btn danger" :title="t('common.delete')" @click="lookToDelete = look">
              <Trash2 :size="12" />
            </button>
          </div>
        </template>
      </article>

      <!-- 新增造型 -->
      <article class="look-card is-add">
        <div v-if="adding" class="look-form">
          <input ref="nameInput" v-model="draft.name" class="input" maxlength="50" :placeholder="t('looks.namePlaceholder')" />
          <textarea v-model="draft.description" class="textarea" rows="3" :placeholder="t('looks.descPlaceholder')" />
          <div class="look-form-actions">
            <button type="button" class="btn btn-sm" @click="adding = false">{{ t('common.cancel') }}</button>
            <button type="button" class="btn btn-sm btn-primary" :disabled="!draft.name.trim() || saving" @click="create">{{ t('looks.create') }}</button>
          </div>
        </div>
        <button v-else type="button" class="look-add-btn" @click="startAdd">
          <Plus :size="16" />
          <span>{{ t('looks.add') }}</span>
        </button>
      </article>
    </div>

    <ConfirmDialog
      :open="!!lookToDelete"
      :title="t('looks.deleteTitle')"
      :message="t('looks.deleteMessage', { name: lookToDelete?.name })"
      :loading="deleting"
      @confirm="confirmDelete"
      @cancel="lookToDelete = null"
    />
  </section>
</template>

<script setup>
import { toast } from 'vue-sonner'
import { useI18n } from 'vue-i18n'
import { Loader2, Pencil, Plus, Trash2, Upload } from 'lucide-vue-next'
import { lookAPI, taskAPI, uploadAPI } from '~/composables/useApi'
import { toastError } from '~/composables/useToast'
import { thumbOf, thumbFallback } from '~/composables/useMedia'

/**
 * CharacterLooksPanel — 角色造型管理（同一角色的多套服装/妆发）
 * 默认造型即角色形象图（只读展示）；额外造型可新增/编辑/删除/生成/上传。
 * 生成时后端以默认形象为参考图，保持同一张脸。造型变化后 emit('changed') 供父组件刷新。
 */
const props = defineProps({
  character: { type: Object, required: true },
  configId: { type: Number, default: null },
})
const emit = defineEmits(['changed'])

const { t } = useI18n()

const looks = ref([])
const adding = ref(false)
const editingId = ref(null)
const saving = ref(false)
const draft = reactive({ name: '', description: '' })
const nameInput = ref(null)
const pendingIds = ref(new Set())
const lookToDelete = ref(null)
const deleting = ref(false)

function src(raw) {
  if (!raw) return ''
  return /^https?:\/\//i.test(raw) || raw.startsWith('/') ? raw : `/${raw}`
}
const portrait = computed(() => src(props.character.image_url || props.character.imageUrl || ''))
const hasPortrait = computed(() => !!portrait.value)
function isPending(look) { return pendingIds.value.has(look.id) }

async function load() {
  try {
    looks.value = await lookAPI.list(props.character.id)
  } catch (e) {
    toastError(e)
  }
}
watch(() => props.character.id, load, { immediate: true })

function startAdd() {
  editingId.value = null
  draft.name = ''
  draft.description = ''
  adding.value = true
  nextTick(() => nameInput.value?.focus())
}
function startEdit(look) {
  adding.value = false
  draft.name = look.name
  draft.description = look.description || ''
  editingId.value = look.id
}

async function create() {
  if (saving.value) return
  saving.value = true
  try {
    await lookAPI.create(props.character.id, { name: draft.name.trim(), description: draft.description })
    adding.value = false
    await load()
    emit('changed')
  } catch (e) {
    toastError(e)
  } finally {
    saving.value = false
  }
}

async function saveEdit(look) {
  if (saving.value) return
  saving.value = true
  try {
    await lookAPI.update(look.id, { name: draft.name.trim(), description: draft.description })
    editingId.value = null
    await load()
    emit('changed')
  } catch (e) {
    toastError(e)
  } finally {
    saving.value = false
  }
}

function setPending(id, on) {
  const next = new Set(pendingIds.value)
  if (on) next.add(id)
  else next.delete(id)
  pendingIds.value = next
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
function parseTaskParams(raw) {
  if (!raw) return {}
  if (typeof raw === 'object') return raw
  try { return JSON.parse(raw) || {} } catch { return {} }
}
async function generate(look) {
  setPending(look.id, true)
  try {
    const res = await lookAPI.generateImage(look.id, props.configId || undefined)
    const taskId = res?.image_generation_id
    // 轮询生成任务（最长约 4 分钟），完成后刷新造型列表
    for (let i = 0; taskId && i < 80; i++) {
      await sleep(3000)
      const task = await taskAPI.get(taskId)
      if (task?.status === 'completed') {
        toast.success(t('looks.generated', { name: look.name }))
        // 服务/模型不支持参考图时后端已降级为纯文字生成（params.referenceFallback），提示人脸可能不一致
        const fallback = parseTaskParams(task.params).referenceFallback
        if (fallback) toast.warning(t(`looks.referenceFallback.${fallback === 'model_unsupported' ? 'model' : 'service'}`), { duration: 8000 })
        break
      }
      if (task?.status === 'failed') {
        toastError(task.errorMsg || task.error_msg || t('looks.generateFailed'))
        break
      }
    }
    await load()
    emit('changed')
  } catch (e) {
    toastError(e)
  } finally {
    setPending(look.id, false)
  }
}

function upload(look) {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp'
  input.onchange = async () => {
    const file = input.files?.[0]
    if (!file) return
    setPending(look.id, true)
    try {
      const res = await uploadAPI.image(file)
      await lookAPI.update(look.id, { image_url: res.path })
      await load()
      emit('changed')
    } catch (e) {
      toastError(e)
    } finally {
      setPending(look.id, false)
    }
  }
  input.click()
}

async function confirmDelete() {
  const look = lookToDelete.value
  if (!look || deleting.value) return
  deleting.value = true
  try {
    await lookAPI.del(look.id)
    lookToDelete.value = null
    await load()
    emit('changed')
  } catch (e) {
    toastError(e)
  } finally {
    deleting.value = false
  }
}
</script>

<style scoped>
.looks-panel { display: flex; flex-direction: column; gap: 10px; }
.looks-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.looks-title { font-size: 13px; font-weight: 650; color: var(--text-0); }
.looks-hint { font-size: 11.5px; }
.looks-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 10px;
}
.look-card {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-raised);
  overflow: hidden;
  min-height: 190px;
}
.look-card.is-default { border-style: dashed; }
.look-cover {
  position: relative;
  aspect-ratio: 16 / 10;
  background: var(--bg-2);
  display: flex;
  align-items: center;
  justify-content: center;
}
.look-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.look-empty { font-size: 11px; color: var(--text-3); }
.look-spinner {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--bg-base) 55%, transparent);
  color: var(--accent);
}
.look-badge {
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
.look-body { display: flex; flex-direction: column; gap: 3px; padding: 8px 10px 4px; min-width: 0; }
.look-name { font-size: 12.5px; color: var(--text-0); }
.look-desc {
  font-size: 11px;
  line-height: 1.45;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.look-actions { display: flex; align-items: center; gap: 4px; padding: 4px 8px 8px; margin-top: auto; }
.look-actions .btn-sm:first-child { flex: 1; }
.look-icon-btn {
  width: var(--button-height-sm);
  min-width: var(--button-height-sm);
  height: var(--button-height-sm);
  min-height: var(--button-height-sm);
}
.look-icon-btn.danger:hover { color: var(--action-danger); }
.look-form { display: flex; flex-direction: column; gap: 6px; padding: 8px; flex: 1; }
.look-form .textarea { font-size: 12px; }
.look-form-actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: auto; }
.look-card.is-add { border-style: dashed; background: transparent; }
.look-add-btn {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: none;
  background: transparent;
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.look-add-btn:hover { color: var(--accent-text); }
</style>
