/**
 * 启动时拉取服务端品牌主题（缓存已在 useBranding 模块加载时同步应用，这里只做刷新）
 */
import { loadBranding } from '~/composables/useBranding'

export default defineNuxtPlugin(() => {
  loadBranding()
})
