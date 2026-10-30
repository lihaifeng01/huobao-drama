<template>
  <div class="shell">
    <!-- Header -->
    <header class="header">
      <div class="header-left">
        <button class="brand" @click="navigateTo('/')">
          <div class="brand-mark">
            <img v-if="showBrandImage" :src="brandLogo" alt="火宝短剧" class="brand-logo" @error="showBrandImage = false" />
            <span v-else class="brand-fallback">火</span>
          </div>
          <div class="brand-text">
            <span class="brand-name">火宝短剧</span>
            <span class="brand-sub">Huobao Shorts</span>
          </div>
        </button>
      </div>

      <nav class="header-nav">
        <NuxtLink to="/" class="nav-link" :class="{ active: route.path === '/' }">
          <LayoutGrid :size="15" :stroke-width="1.8" />
          <span>{{ t('layout.nav.projects') }}</span>
        </NuxtLink>
        <NuxtLink to="/library" class="nav-link" :class="{ active: route.path === '/library' }">
          <Images :size="15" :stroke-width="1.8" />
          <span>{{ t('layout.nav.library') }}</span>
        </NuxtLink>
        <NuxtLink to="/tools" class="nav-link" :class="{ active: route.path === '/tools' }">
          <Wrench :size="15" :stroke-width="1.8" />
          <span>{{ t('layout.nav.tools') }}</span>
        </NuxtLink>
        <!-- 设置仅管理员可见（普通用户后端也会拒绝设置类接口） -->
        <NuxtLink v-if="isAdmin" to="/settings" class="nav-link" :class="{ active: route.path === '/settings' }">
          <Settings :size="15" :stroke-width="1.8" />
          <span>{{ t('layout.nav.settings') }}</span>
        </NuxtLink>
        <NuxtLink v-if="isSuperAdmin && isMultiUser" to="/users" class="nav-link" :class="{ active: route.path === '/users' }">
          <Users :size="15" :stroke-width="1.8" />
          <span>{{ t('layout.nav.users') }}</span>
        </NuxtLink>
      </nav>

      <div class="header-right">
        <a
          class="github-link"
          href="https://github.com/lihaifeng01/huobao-drama"
          target="_blank"
          rel="noopener"
          aria-label="GitHub"
          title="GitHub"
        >
          <Github :size="15" :stroke-width="1.8" />
        </a>
        <ThemeToggle />
        <LocaleSwitcher />
        <AppMenu v-if="auth.state.user && isMultiUser" v-model:open="userMenuOpen" placement="bottom-end" :min-width="180">
          <template #trigger>
            <button type="button" class="user-trigger" :title="auth.state.user.username">
              <span class="user-avatar">{{ userInitial }}</span>
              <span class="user-name truncate">{{ auth.state.user.display_name }}</span>
            </button>
          </template>
          <div class="user-menu-head">
            <div class="user-menu-name truncate">{{ auth.state.user.display_name }}</div>
            <div class="user-menu-meta">
              <span class="truncate">{{ auth.state.user.username }}</span>
              <span class="tag" :class="roleTagClass(auth.state.user.role)">{{ t(`auth.role.${auth.state.user.role}`) }}</span>
            </div>
          </div>
          <AppMenuItem @click="userMenuOpen = false; openPasswordDialog()">{{ t('auth.changePassword.title') }}</AppMenuItem>
          <AppMenuItem danger @click="userMenuOpen = false; auth.logout()">{{ t('auth.logout') }}</AppMenuItem>
        </AppMenu>
      </div>
    </header>

    <!-- AI 服务未配置引导横幅(缺任一类型即提示) -->
    <div v-if="missingConfigLabels.length" class="config-banner">
      <TriangleAlert :size="14" :stroke-width="1.8" />
      <span>{{ t('layout.banner.missing', { types: missingConfigLabels.join(t('common.listJoin')) }) }}</span>
      <NuxtLink v-if="isAdmin" to="/settings" class="config-banner-link">{{ t('layout.banner.goSettings') }}</NuxtLink>
      <span v-else class="config-banner-hint">{{ t('layout.banner.askAdmin') }}</span>
    </div>

    <main class="content">
      <slot />
    </main>

    <!-- 修改密码 -->
    <div v-if="pwdDialog.open" class="overlay" @click.self="pwdDialog.open = false">
      <div class="dialog pwd-dialog">
        <div class="dialog-head">
          <h2 class="dialog-title">{{ t('auth.changePassword.title') }}</h2>
        </div>
        <form @submit.prevent="submitPassword">
          <div class="dialog-body pwd-body">
            <label class="pwd-field">
              <span>{{ t('auth.changePassword.old') }}</span>
              <input v-model="pwdDialog.old" class="input" type="password" autocomplete="current-password" required autofocus />
            </label>
            <label class="pwd-field">
              <span>{{ t('auth.changePassword.new') }}</span>
              <input v-model="pwdDialog.next" class="input" type="password" autocomplete="new-password" :placeholder="t('auth.passwordRule')" required />
            </label>
            <label class="pwd-field">
              <span>{{ t('auth.confirmPassword') }}</span>
              <input v-model="pwdDialog.confirm" class="input" type="password" autocomplete="new-password" required />
            </label>
            <p class="pwd-hint">{{ t('auth.changePassword.hint') }}</p>
          </div>
          <div class="dialog-foot">
            <button type="button" class="btn" @click="pwdDialog.open = false">{{ t('common.cancel') }}</button>
            <button type="submit" class="btn btn-primary" :disabled="pwdDialog.saving">{{ t('common.save') }}</button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<script setup>
import { LayoutGrid, Images, Wrench, Settings, TriangleAlert, Github, Users } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { aiConfigAPI, authAPI } from '~/composables/useApi'
import { useAuth } from '~/composables/useAuth'
import { toastError } from '~/composables/useToast'
import brandLogo from '~/assets/brand-logo.png'

const { t, locale } = useI18n()
const route = useRoute()
const showBrandImage = ref(true)

const auth = useAuth()
const { isAdmin, isSuperAdmin, isMultiUser } = auth
const userMenuOpen = ref(false)
const userInitial = computed(() => String(auth.state.user?.display_name || '?').trim().slice(0, 1).toUpperCase())
function roleTagClass(role) {
  return role === 'super_admin' ? 'tag-accent' : role === 'admin' ? 'tag-info' : ''
}

const pwdDialog = reactive({ open: false, old: '', next: '', confirm: '', saving: false })
function openPasswordDialog() {
  Object.assign(pwdDialog, { open: true, old: '', next: '', confirm: '', saving: false })
}
async function submitPassword() {
  if (pwdDialog.next !== pwdDialog.confirm) {
    toast.error(t('auth.passwordMismatch'))
    return
  }
  pwdDialog.saving = true
  try {
    await authAPI.changePassword(pwdDialog.old, pwdDialog.next)
    pwdDialog.open = false
    toast.success(t('auth.changePassword.done'))
  } catch (e) {
    toastError(e)
  } finally {
    pwdDialog.saving = false
  }
}

// 渲染时求值，语言切换即时生效（不能模块级常量固化）
const SERVICE_TYPE_LABELS = computed(() => ({
  text: t('common.serviceType.text'),
  image: t('common.serviceType.image'),
  video: t('common.serviceType.video'),
}))
const missingConfigLabels = ref([])

async function checkAiConfigs() {
  try {
    const configs = await aiConfigAPI.list()
    const labels = SERVICE_TYPE_LABELS.value
    missingConfigLabels.value = Object.entries(labels)
      .filter(([type]) => !configs.some(c => c.service_type === type && c.is_active))
      .map(([, label]) => label)
  } catch { /* 配置检查失败不阻塞页面 */ }
}

onMounted(checkAiConfigs)
// 设置页保存配置后返回时重新检查(布局跨页面复用,onMounted 只触发一次)
watch(() => route.path, checkAiConfigs)
// 切换界面语言时横幅中已拼接的类型文案需要重算
watch(locale, checkAiConfigs)
</script>

<style scoped>
.shell {
  display: flex; flex-direction: column;
  height: 100vh; overflow: hidden;
  background: var(--bg-base);
}

/* === Header === */
.header {
  display: flex; align-items: center;
  height: 60px; flex-shrink: 0;
  padding: 0 24px;
  gap: 32px;
  background: var(--header-bg);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  border-bottom: 1px solid var(--border);
  position: relative; z-index: 10;
}

.header-left { display: flex; align-items: center; }

.brand {
  display: flex; align-items: center; gap: 11px;
  background: transparent; border: none; cursor: pointer; padding: 4px 8px 4px 4px;
  text-decoration: none; border-radius: var(--radius);
  transition: background 0.18s var(--ease-out);
}
.brand:hover { background: var(--bg-hover); }
.brand:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3.5px var(--button-focus);
}
.brand-mark {
  width: 32px; height: 32px;
  display: flex; align-items: center; justify-content: center;
  border-radius: 9px;
  overflow: hidden;
}
.brand-logo {
  width: 28px;
  height: 28px;
  object-fit: contain;
  display: block;
}
.brand-fallback {
  font-size: 15px;
  font-weight: 700;
  color: var(--text-0);
  line-height: 1;
}
.brand-text { display: flex; flex-direction: column; align-items: flex-start; line-height: 1.15; }
.brand-name {
  font-size: 15px; font-weight: 700;
  /* ChatFire 签名：品牌字标火焰橙渐变 */
  background: var(--accent-gradient);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  letter-spacing: -0.01em;
}
.brand-sub {
  font-size: 10px; font-weight: 400;
  color: var(--text-3); margin-top: 1px;
  letter-spacing: 0.04em;
}

/* Nav — pill segmented group */
.header-nav {
  display: flex; gap: 2px;
  padding: 3px;
  border-radius: var(--radius-pill);
  background: var(--overlay-track);
}

/* Header 右侧 — 语言切换器 */
.header-right {
  margin-left: auto;
  display: flex; align-items: center;
}
/* GitHub 入口 — 与 ThemeToggle 同款圆形图标按钮 */
.github-link {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: var(--radius-pill);
  color: var(--text-2);
  transition: all 0.18s var(--ease-out);
  line-height: 1;
}
.github-link:hover { color: var(--text-0); background: var(--bg-hover); }
.github-link:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3.5px var(--button-focus);
}
.nav-link {
  display: flex; align-items: center; gap: 6px;
  min-height: 32px;
  padding: 0 16px; border-radius: var(--radius-pill);
  font-size: 13px; font-weight: 600;
  color: var(--text-2); text-decoration: none;
  transition: all 0.18s var(--ease-out);
  border: none;
  line-height: 1;
}
.nav-link:hover { color: var(--text-0); }
.nav-link.active {
  background: var(--seg-active-bg);
  color: var(--text-0);
  box-shadow: 0 1px 4px rgba(0,0,0,0.1);
}
.nav-link:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3.5px var(--button-focus);
}

/* Config banner — AI 服务未配置引导 */
.config-banner {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 24px; flex-shrink: 0;
  font-size: 12.5px; color: var(--warn-text);
  background: var(--warn-bg);
  border-bottom: 1px solid var(--warn-border);
  position: relative; z-index: 9;
}
.config-banner-link {
  margin-left: auto;
  font-size: 12.5px; font-weight: 600;
  color: var(--warn-link); text-decoration: none;
  padding: 2px 10px; border-radius: var(--radius-pill);
  border: 1px solid var(--warn-border);
  transition: all 0.18s var(--ease-out);
  line-height: 1.6;
}
.config-banner-link:hover { background: var(--warn-link-hover-bg); color: var(--warn-text); }
.config-banner-hint { margin-left: auto; font-size: 12px; opacity: 0.85; }

/* 用户菜单 */
.user-trigger {
  display: flex; align-items: center; gap: 7px;
  max-width: 160px; height: 32px;
  margin-left: 6px; padding: 0 10px 0 3px;
  border: none; border-radius: var(--radius-pill);
  background: transparent; color: var(--text-1);
  font: 600 12.5px var(--font-body);
  cursor: pointer;
  transition: background 0.18s var(--ease-out);
}
.user-trigger:hover { background: var(--bg-hover); }
.user-trigger:focus-visible { outline: none; box-shadow: 0 0 0 3.5px var(--button-focus); }
.user-avatar {
  width: 26px; height: 26px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  border-radius: 50%;
  background: var(--accent-gradient); color: var(--on-accent);
  font-size: 12px; font-weight: 700;
}
.user-name { min-width: 0; }
.user-menu-head {
  padding: 8px 10px 10px; margin-bottom: 4px;
  border-bottom: 1px solid var(--border);
}
.user-menu-name { font-size: 13px; font-weight: 700; color: var(--text-0); }
.user-menu-meta {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  margin-top: 4px; font-size: 11.5px; color: var(--text-3);
}
.pwd-dialog { width: min(400px, calc(100vw - 32px)); }
.pwd-body { display: flex; flex-direction: column; gap: 12px; }
.pwd-field { display: flex; flex-direction: column; gap: 6px; font-size: 12.5px; font-weight: 600; color: var(--text-1); }
.pwd-hint { margin: 0; font-size: 12px; color: var(--text-3); }

/* Content */
.content { flex: 1; overflow: hidden; display: flex; flex-direction: column; }
</style>
