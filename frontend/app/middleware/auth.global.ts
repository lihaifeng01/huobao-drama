/**
 * 全局路由守卫：未初始化 → /setup；未登录 → /login；普通用户不能进设置页、账号管理页
 * 免登模式：登录 / 初始化 / 账号管理页都没有意义，送回首页
 */
import { PUBLIC_ROUTES, useAuth } from '~/composables/useAuth'

export default defineNuxtRouteMiddleware(async (to) => {
  const { state, ensureLoaded, isAdmin, isSuperAdmin } = useAuth()
  try {
    await ensureLoaded()
  } catch {
    // 后端不可达时不拦截，页面自身会报错
    return
  }

  if (state.mode === 'none') {
    return ['/login', '/setup', '/users'].includes(to.path) ? navigateTo('/') : undefined
  }
  if (!state.initialized) return to.path === '/setup' ? undefined : navigateTo('/setup')
  if (to.path === '/setup') return navigateTo(state.user ? '/' : '/login')

  if (!state.user) {
    if (PUBLIC_ROUTES.includes(to.path)) return
    return navigateTo({ path: '/login', query: to.fullPath !== '/' ? { redirect: to.fullPath } : {} })
  }
  if (to.path === '/login') return navigateTo('/')
  if (to.path === '/settings' && !isAdmin.value) return navigateTo('/')
  if (to.path === '/users' && !isSuperAdmin.value) return navigateTo('/')
})
