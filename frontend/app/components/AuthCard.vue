<template>
  <div class="auth-page">
    <div class="auth-tools">
      <ThemeToggle />
      <LocaleSwitcher />
    </div>
    <div class="auth-card card">
      <div class="auth-brand">
        <img :src="brandLogo" alt="" class="auth-logo" />
        <div>
          <div class="auth-brand-name">火宝短剧</div>
          <div class="auth-brand-sub">Huobao Shorts</div>
        </div>
      </div>

      <h1 class="auth-title">{{ t(`auth.${mode}.title`) }}</h1>
      <p class="auth-desc">{{ t(`auth.${mode}.desc`) }}</p>

      <form class="auth-form" @submit.prevent="submit">
        <label class="auth-field">
          <span class="auth-label">{{ t('auth.username') }}</span>
          <input
            v-model.trim="form.username"
            class="input"
            autocomplete="username"
            :placeholder="mode === 'login' ? t('auth.usernamePlaceholder') : t('auth.usernameRule')"
            required
            autofocus
          />
        </label>
        <label v-if="mode !== 'login'" class="auth-field">
          <span class="auth-label">{{ t('auth.displayName') }} <span class="auth-optional">{{ t('auth.optional') }}</span></span>
          <input v-model.trim="form.display_name" class="input" autocomplete="nickname" :placeholder="t('auth.displayNamePlaceholder')" maxlength="32" />
        </label>
        <label class="auth-field">
          <span class="auth-label">{{ t('auth.password') }}</span>
          <input
            v-model="form.password"
            class="input"
            type="password"
            :autocomplete="mode === 'login' ? 'current-password' : 'new-password'"
            :placeholder="mode === 'login' ? t('auth.passwordPlaceholder') : t('auth.passwordRule')"
            required
          />
        </label>
        <label v-if="mode !== 'login'" class="auth-field">
          <span class="auth-label">{{ t('auth.confirmPassword') }}</span>
          <input v-model="form.confirm" class="input" type="password" autocomplete="new-password" required />
        </label>

        <p v-if="error" class="auth-error" role="alert">{{ error }}</p>

        <button type="submit" class="btn btn-primary auth-submit" :disabled="submitting">
          {{ submitting ? t('common.loading') : t(`auth.${mode}.submit`) }}
        </button>
      </form>

      <div v-if="mode !== 'setup'" class="auth-switch">
        <span>{{ mode === 'login' ? t('auth.noAccount') : t('auth.hasAccount') }}</span>
        <button type="button" class="btn btn-ghost btn-sm" @click="emit('switch', mode === 'login' ? 'register' : 'login')">
          {{ mode === 'login' ? t('auth.register.submit') : t('auth.login.submit') }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { authAPI } from '~/composables/useApi'
import { useAuth } from '~/composables/useAuth'
import brandLogo from '~/assets/brand-logo.png'

const props = defineProps<{ mode: 'login' | 'register' | 'setup' }>()
const emit = defineEmits<{ switch: [mode: 'login' | 'register'] }>()

const { t } = useI18n()
const route = useRoute()
const { setUser } = useAuth()

const form = reactive({ username: '', display_name: '', password: '', confirm: '' })
const error = ref('')
const submitting = ref(false)

watch(() => props.mode, () => { error.value = ''; form.confirm = '' })

/** 只接受站内路径，防止 redirect 参数被拿来跳到外站 */
function redirectTarget() {
  const r = String(route.query.redirect || '')
  return r.startsWith('/') && !r.startsWith('//') && r !== '/login' && r !== '/setup' ? r : '/'
}

async function submit() {
  error.value = ''
  if (props.mode !== 'login' && form.password !== form.confirm) {
    error.value = t('auth.passwordMismatch')
    return
  }
  submitting.value = true
  try {
    const payload = { username: form.username, password: form.password }
    const user = props.mode === 'login'
      ? await authAPI.login(payload)
      : props.mode === 'register'
        ? await authAPI.register({ ...payload, display_name: form.display_name || undefined })
        : await authAPI.setup({ ...payload, display_name: form.display_name || undefined })
    setUser(user)
    await navigateTo(redirectTarget(), { replace: true })
  } catch (e: any) {
    error.value = e?.message || t('auth.failed')
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.auth-page {
  min-height: 100vh;
  display: flex; align-items: center; justify-content: center;
  padding: 24px 16px;
  background: var(--bg-base);
  position: relative;
}
.auth-tools {
  position: absolute; top: 14px; right: 16px;
  display: flex; align-items: center; gap: 6px;
}
.auth-card {
  width: 100%; max-width: 380px;
  padding: 28px 28px 22px;
  background: var(--surface-raised);
  box-shadow: var(--shadow-elevated);
}
.auth-card:hover { border-color: var(--border); }
.auth-brand { display: flex; align-items: center; gap: 10px; margin-bottom: 22px; }
.auth-logo { width: 34px; height: 34px; border-radius: 9px; object-fit: cover; }
.auth-brand-name { font-weight: 700; font-size: 14px; color: var(--text-0); }
.auth-brand-sub { font-size: 11px; color: var(--text-3); }
.auth-title { font-size: 20px; font-weight: 700; color: var(--text-0); margin: 0 0 6px; }
.auth-desc { font-size: 13px; color: var(--text-2); margin: 0 0 20px; line-height: 1.6; }
.auth-form { display: flex; flex-direction: column; gap: 14px; }
.auth-field { display: flex; flex-direction: column; gap: 6px; }
.auth-label { font-size: 12.5px; font-weight: 600; color: var(--text-1); }
.auth-optional { font-weight: 400; color: var(--text-3); margin-left: 4px; }
.auth-error {
  margin: 0; padding: 8px 10px;
  font-size: 12.5px; color: var(--error);
  background: var(--error-bg); border-radius: var(--radius-sm);
}
.auth-submit { width: 100%; margin-top: 4px; }
.auth-switch {
  display: flex; align-items: center; justify-content: center; gap: 4px;
  margin-top: 16px; font-size: 12.5px; color: var(--text-2);
}
</style>
