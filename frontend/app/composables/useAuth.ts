/**
 * 登录态：全局单例，路由守卫（middleware/auth.global.ts）首次进入时拉一次 /auth/status
 * - initialized=false：还没有超级管理员，只能去 /setup
 * - 普通用户（role=user）不能进入设置页
 */
import { computed, reactive } from 'vue'
import { authAPI, type AuthUser } from '~/composables/useApi'

const state = reactive({
  loaded: false,
  initialized: true,
  user: null as AuthUser | null,
})

let pending: Promise<void> | null = null

async function refresh() {
  const s = await authAPI.status()
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
const isAdmin = computed(() => state.user?.role === 'super_admin' || state.user?.role === 'admin')

export function useAuth() {
  return { state, ensureLoaded, refresh, setUser, logout, isAdmin, isSuperAdmin }
}

export const PUBLIC_ROUTES = ['/login', '/setup']
