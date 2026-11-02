<template>
  <div class="member-picker">
    <input v-model.trim="keyword" class="input mp-search" :placeholder="t('members.searchPlaceholder')" />
    <div class="mp-list" role="listbox" aria-multiselectable="true">
      <div v-if="loading" class="mp-empty">{{ t('common.loading') }}</div>
      <div v-else-if="!candidates.length" class="mp-empty">{{ keyword ? t('members.noMatch') : t('members.noUsers') }}</div>
      <label
        v-for="u in candidates"
        :key="u.id"
        class="mp-item"
        :class="{ on: selected.has(u.id) }"
        role="option"
        :aria-selected="selected.has(u.id)"
      >
        <input type="checkbox" :checked="selected.has(u.id)" @change="toggle(u.id)" />
        <span class="mp-avatar">{{ initial(u) }}</span>
        <span class="mp-text">
          <span class="mp-name truncate">{{ u.display_name }}</span>
          <span class="mp-username truncate">{{ u.username }}</span>
        </span>
        <span v-if="u.role !== 'user'" class="tag mp-role" :class="u.role === 'super_admin' ? 'tag-accent' : 'tag-info'">{{ t(`auth.role.${u.role}`) }}</span>
      </label>
    </div>
    <div class="mp-foot">{{ t('members.selectedCount', { n: modelValue.length }) }}</div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { userAPI, type AuthUser } from '~/composables/useApi'
import { toastError } from '~/composables/useToast'

/**
 * 项目成员多选：列出所有可用账号（排除 excludeIds，一般是创建人自己）
 * v-model 为选中的用户 id 数组
 */
const props = withDefaults(defineProps<{ modelValue: number[]; excludeIds?: number[] }>(), { excludeIds: () => [] })
const emit = defineEmits<{ 'update:modelValue': [ids: number[]] }>()

const { t } = useI18n()
const users = ref<AuthUser[]>([])
const loading = ref(true)
const keyword = ref('')

const selected = computed(() => new Set(props.modelValue))
const candidates = computed(() => {
  const kw = keyword.value.toLowerCase()
  return users.value
    .filter(u => !props.excludeIds.includes(u.id))
    .filter(u => !kw || u.username.toLowerCase().includes(kw) || u.display_name.toLowerCase().includes(kw))
})

function initial(u: AuthUser) {
  return String(u.display_name || u.username || '?').trim().slice(0, 1).toUpperCase()
}

function toggle(id: number) {
  const next = new Set(props.modelValue)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  emit('update:modelValue', [...next])
}

onMounted(async () => {
  try {
    users.value = await userAPI.options()
  } catch (e) {
    toastError(e)
  } finally {
    loading.value = false
  }
})
</script>

<style scoped>
.member-picker { display: flex; flex-direction: column; gap: 8px; }
.mp-list {
  max-height: 220px; overflow-y: auto;
  border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--surface-input);
  padding: 4px;
}
.mp-empty { padding: 16px; text-align: center; font-size: 12.5px; color: var(--text-3); }
.mp-item {
  display: flex; align-items: center; gap: 9px;
  padding: 6px 8px; border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background 0.15s var(--ease-out);
}
.mp-item:hover { background: var(--bg-hover); }
.mp-item.on { background: var(--accent-bg); }
.mp-item input { accent-color: var(--accent); margin: 0; flex-shrink: 0; }
.mp-avatar {
  width: 24px; height: 24px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  border-radius: 50%;
  background: var(--surface-muted); color: var(--text-1);
  font-size: 11px; font-weight: 700;
}
.mp-text { display: flex; flex-direction: column; min-width: 0; flex: 1; line-height: 1.25; }
.mp-name { font-size: 13px; font-weight: 600; color: var(--text-0); }
.mp-username { font-size: 11px; color: var(--text-3); }
.mp-role { flex-shrink: 0; }
.mp-foot { font-size: 12px; color: var(--text-3); }
</style>
