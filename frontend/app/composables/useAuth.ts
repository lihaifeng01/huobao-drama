/**
 * 登录态：全局单例，路由守卫（middleware/auth.global.ts）首次进入时拉一次 /auth/status
 * - initialized=false：还没有超级管理员，只能去 /setup
 * - 普通用户（role=user）不能进入设置页
 * - mode=none（免登，桌面版默认）：始终是本机超级管理员，不显示登录 / 账号 / 项目成员相关界面
 */
import { computed, reactive } from 'vue'
import { authAPI, type AuthUser } from '~/composables/useApi'

const state = reactive({
  loaded: false,
  mode: 'login' as 'none' | 'login',
  initialized: true,
  user: null as AuthUser | null,
})

let pending: Promise<void> | null = null

async function refresh() {
  const s = await authAPI.status()
  state.mode = s.mode
  state.initialized = s.initialized
  state.user = s.user
  state.loaded = true
}

/** 只在第一次调用时请求；之后直接用缓存（登录 / 退出时会主动更新） */
function ensureLoaded() {
  if (state.loaded) return Promise.resolve()
  pending ||= refresh().finally(() => { pending = null })
  return pending
}

function setUser(user: AuthUser | null) {
  state.user = user
  state.initialized = true
  state.loaded = true
}

async function logout() {
  try { await authAPI.logout() } catch { /* 会话可能已失效，照样回登录页 */ }
  state.user = null
  window.location.href = '/login'
}

const isSuperAdmin = computed(() => state.user?.role === 'super_admin')
/** 需要登录的模式才有账号管理、项目成员这些多人功能 */
const isMultiUser = computed(() => state.mode === 'login')
const isAdmin = computed(() => state.user?.role === 'super_admin' || state.user?.role === 'admin')

export function useAuth() {
  return { state, ensureLoaded, refresh, setUser, logout, isAdmin, isSuperAdmin, isMultiUser }
}

export const PUBLIC_ROUTES = ['/login', '/setup']
