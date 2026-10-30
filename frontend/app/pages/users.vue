<template>
  <div class="page users-page">
    <div class="users-head">
      <div>
        <h1 class="users-title">{{ t('users.title') }}</h1>
        <p class="users-sub">{{ t('users.sub') }}</p>
      </div>
      <button class="btn btn-primary" @click="openCreate">
        <Plus :size="14" :stroke-width="2.2" />
        {{ t('users.create') }}
      </button>
    </div>

    <div class="card users-card">
      <table class="users-table">
        <thead>
          <tr>
            <th>{{ t('users.col.user') }}</th>
            <th>{{ t('users.col.role') }}</th>
            <th>{{ t('users.col.status') }}</th>
            <th class="hide-sm">{{ t('users.col.lastLogin') }}</th>
            <th class="col-actions">{{ t('users.col.actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="loading"><td colspan="5" class="users-empty">{{ t('common.loading') }}</td></tr>
          <tr v-for="u in users" :key="u.id" :class="{ disabled: u.status === 'disabled' }">
            <td>
              <div class="user-cell">
                <span class="u-avatar">{{ initial(u) }}</span>
                <div class="u-text">
                  <span class="u-name truncate">{{ u.display_name }}<span v-if="u.id === me?.id" class="u-me">{{ t('users.me') }}</span></span>
                  <span class="u-username truncate">{{ u.username }}</span>
                </div>
              </div>
            </td>
            <td>
              <span v-if="u.role === 'super_admin'" class="tag tag-accent">{{ t('auth.role.super_admin') }}</span>
              <div v-else class="role-select">
                <BaseSelect :model-value="u.role" :options="roleOptions" :searchable="false" @update:model-value="(v) => setRole(u, v)" />
              </div>
            </td>
            <td>
              <span class="tag" :class="u.status === 'active' ? 'tag-success' : 'tag-error'">{{ t(`users.status.${u.status}`) }}</span>
            </td>
            <td class="hide-sm dim">{{ fmtTime(u.last_login_at) }}</td>
            <td class="col-actions">
              <template v-if="u.role !== 'super_admin'">
                <button class="btn btn-sm" @click="toggleStatus(u)">{{ u.status === 'active' ? t('users.disable') : t('users.enable') }}</button>
                <button class="btn btn-sm" @click="openReset(u)">{{ t('users.resetPassword') }}</button>
                <button class="btn btn-sm btn-danger" @click="userToDelete = u">{{ t('common.delete') }}</button>
              </template>
              <button v-else class="btn btn-sm" @click="openReset(u)">{{ t('users.resetPassword') }}</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <p class="users-note">{{ t('users.roleNote') }}</p>

    <!-- 新建账号 -->
    <div v-if="createDialog.open" class="overlay" @click.self="createDialog.open = false">
      <div class="dialog users-dialog">
        <div class="dialog-head"><h2 class="dialog-title">{{ t('users.create') }}</h2></div>
        <form @submit.prevent="submitCreate">
          <div class="dialog-body users-form">
            <label class="u-field">
              <span>{{ t('auth.username') }}</span>
              <input v-model.trim="createDialog.username" class="input" :placeholder="t('auth.usernameRule')" required autofocus />
            </label>
            <label class="u-field">
              <span>{{ t('auth.displayName') }} <em>{{ t('auth.optional') }}</em></span>
              <input v-model.trim="createDialog.display_name" class="input" maxlength="32" />
            </label>
            <label class="u-field">
              <span>{{ t('auth.password') }}</span>
              <input v-model="createDialog.password" class="input" type="password" autocomplete="new-password" :placeholder="t('auth.passwordRule')" required />
            </label>
            <div class="u-field">
              <span>{{ t('users.col.role') }}</span>
              <BaseSelect v-model="createDialog.role" :options="roleOptions" :searchable="false" />
            </div>
          </div>
          <div class="dialog-foot">
            <button type="button" class="btn" @click="createDialog.open = false">{{ t('common.cancel') }}</button>
            <button type="submit" class="btn btn-primary" :disabled="createDialog.saving">{{ t('users.create') }}</button>
          </div>
        </form>
      </div>
    </div>

    <!-- 重置密码 -->
    <div v-if="resetDialog.user" class="overlay" @click.self="resetDialog.user = null">
      <div class="dialog users-dialog">
        <div class="dialog-head"><h2 class="dialog-title">{{ t('users.resetTitle', { name: resetDialog.user.display_name }) }}</h2></div>
        <form @submit.prevent="submitReset">
          <div class="dialog-body users-form">
            <label class="u-field">
              <span>{{ t('auth.changePassword.new') }}</span>
              <input v-model="resetDialog.password" class="input" type="password" autocomplete="new-password" :placeholder="t('auth.passwordRule')" required autofocus />
            </label>
            <p class="users-hint">{{ t('users.resetHint') }}</p>
          </div>
          <div class="dialog-foot">
            <button type="button" class="btn" @click="resetDialog.user = null">{{ t('common.cancel') }}</button>
            <button type="submit" class="btn btn-primary" :disabled="resetDialog.saving">{{ t('common.save') }}</button>
          </div>
        </form>
      </div>
    </div>

    <ConfirmDialog
      :open="!!userToDelete"
      :title="t('users.deleteTitle')"
      :message="t('users.deleteMessage', { name: userToDelete?.display_name })"
      :loading="deleting"
      @confirm="confirmDelete"
      @cancel="userToDelete = null"
    />
  </div>
</template>

<script setup lang="ts">
import { toast } from 'vue-sonner'
import { useI18n } from 'vue-i18n'
import { Plus } from 'lucide-vue-next'
import { userAPI, type AuthUser, type UserRole } from '~/composables/useApi'
import { useAuth } from '~/composables/useAuth'
import { toastError } from '~/composables/useToast'
import BaseSelect from '~/components/BaseSelect.vue'

const { t, locale } = useI18n()
const me = computed(() => useAuth().state.user)

const users = ref<AuthUser[]>([])
const loading = ref(true)
const roleOptions = computed(() => [
  { label: t('auth.role.admin'), value: 'admin' },
  { label: t('auth.role.user'), value: 'user' },
])

const createDialog = reactive({ open: false, username: '', display_name: '', password: '', role: 'user' as UserRole, saving: false })
const resetDialog = reactive({ user: null as AuthUser | null, password: '', saving: false })
const userToDelete = ref<AuthUser | null>(null)
const deleting = ref(false)

function initial(u: AuthUser) {
  return String(u.display_name || u.username || '?').trim().slice(0, 1).toUpperCase()
}

function fmtTime(iso?: string | null) {
  if (!iso) return t('users.neverLoggedIn')
  return new Date(iso).toLocaleString(locale.value, { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

async function load() {
  loading.value = true
  try {
    users.value = await userAPI.list()
  } catch (e) {
    toastError(e)
  } finally {
    loading.value = false
  }
}

function replace(updated: AuthUser) {
  const i = users.value.findIndex(u => u.id === updated.id)
  if (i >= 0) users.value[i] = updated
}

async function setRole(u: AuthUser, role: UserRole) {
  if (u.role === role) return
  try {
    replace(await userAPI.update(u.id, { role }))
    toast.success(t('users.roleChanged'))
  } catch (e) {
    toastError(e)
  }
}

async function toggleStatus(u: AuthUser) {
  try {
    replace(await userAPI.update(u.id, { status: u.status === 'active' ? 'disabled' : 'active' }))
  } catch (e) {
    toastError(e)
  }
}

function openCreate() {
  Object.assign(createDialog, { open: true, username: '', display_name: '', password: '', role: 'user', saving: false })
}

async function submitCreate() {
  createDialog.saving = true
  try {
    await userAPI.create({
      username: createDialog.username,
      password: createDialog.password,
      display_name: createDialog.display_name || undefined,
      role: createDialog.role,
    })
    createDialog.open = false
    toast.success(t('users.created'))
    load()
  } catch (e) {
    toastError(e)
  } finally {
    createDialog.saving = false
  }
}

function openReset(u: AuthUser) {
  Object.assign(resetDialog, { user: u, password: '', saving: false })
}

async function submitReset() {
  if (!resetDialog.user) return
  resetDialog.saving = true
  try {
    await userAPI.resetPassword(resetDialog.user.id, resetDialog.password)
    // 重置自己的密码会让当前会话失效
    if (resetDialog.user.id === me.value?.id) {
      window.location.href = '/login'
      return
    }
    resetDialog.user = null
    toast.success(t('users.passwordReset'))
  } catch (e) {
    toastError(e)
  } finally {
    resetDialog.saving = false
  }
}

async function confirmDelete() {
  const u = userToDelete.value
  if (!u) return
  deleting.value = true
  try {
    await userAPI.del(u.id)
    userToDelete.value = null
    toast.success(t('users.deleted'))
    load()
  } catch (e) {
    toastError(e)
  } finally {
    deleting.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.users-page { padding: 24px; overflow-y: auto; height: 100%; max-width: 1080px; width: 100%; margin: 0 auto; }
.users-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }
.users-title { font-size: 20px; font-weight: 700; color: var(--text-0); margin: 0; }
.users-sub { margin: 4px 0 0; font-size: 13px; color: var(--text-3); }
.users-card { padding: 0; overflow-x: auto; }
.users-card:hover { border-color: var(--border); }
.users-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.users-table th {
  text-align: left; font-weight: 600; font-size: 12px; color: var(--text-3);
  padding: 10px 14px; border-bottom: 1px solid var(--border); white-space: nowrap;
}
.users-table td { padding: 10px 14px; border-bottom: 1px solid var(--border); vertical-align: middle; }
.users-table tr:last-child td { border-bottom: none; }
.users-table tr.disabled .user-cell { opacity: 0.55; }
.users-empty { text-align: center; color: var(--text-3); }
.users-table .col-actions { text-align: right; white-space: nowrap; }
.col-actions .btn + .btn { margin-left: 6px; }
.user-cell { display: flex; align-items: center; gap: 10px; min-width: 0; }
.u-avatar {
  width: 30px; height: 30px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  border-radius: 50%;
  background: var(--accent-gradient); color: var(--on-accent);
  font-size: 12.5px; font-weight: 700;
}
.u-text { display: flex; flex-direction: column; min-width: 0; line-height: 1.3; }
.u-name { font-weight: 600; color: var(--text-0); }
.u-me { margin-left: 6px; font-size: 11px; font-weight: 500; color: var(--text-3); }
.u-username { font-size: 11.5px; color: var(--text-3); }
.role-select { width: 140px; }
.dim { color: var(--text-3); font-size: 12px; white-space: nowrap; }
.users-note { margin: 12px 2px 0; font-size: 12px; color: var(--text-3); line-height: 1.6; }
.users-dialog { width: 420px; max-width: calc(100vw - 32px); }
.users-form { display: flex; flex-direction: column; gap: 12px; }
.u-field { display: flex; flex-direction: column; gap: 6px; font-size: 12.5px; font-weight: 600; color: var(--text-1); }
.u-field em { font-style: normal; font-weight: 400; color: var(--text-3); margin-left: 4px; }
.users-hint { margin: 0; font-size: 12px; color: var(--text-3); }
@media (max-width: 640px) {
  .users-page { padding: 16px; }
  .hide-sm { display: none; }
}
</style>
