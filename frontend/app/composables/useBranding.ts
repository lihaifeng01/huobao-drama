/**
 * 品牌主题（模块级单例，与 useTheme.ts 同构）
 * - 后端 GET /settings/branding（公开），超级管理员在设置页「品牌主题」修改
 * - 模块顶层先用 localStorage 缓存同步应用一次，避免首帧闪出默认橙色 / 默认 Logo；
 *   plugins/branding.client.ts 再拉一次服务端最新值
 * - 颜色与圆角通过注入 <style id="huobao-branding"> 覆写 studio.css 的 token；
 *   选择器用 html:root（比 studio.css 的 :root 高一级），无论样式插入顺序都能生效
 */
import { computed, reactive, readonly } from 'vue'
import { settingsAPI } from '~/composables/useApi'
import { accentTokens, autoDarkColor, cornerTokens, isHexColor } from '~/utils/brand-color'
import defaultLogo from '~/assets/brand-logo.png'

export const BRANDING_STORAGE_KEY = 'huobao:branding'
export const DEFAULT_APP_NAME = '火宝短剧'
export const DEFAULT_APP_SUBTITLE = 'Huobao Shorts'
export const DEFAULT_PRIMARY_COLOR = '#f97316'
export const DEFAULT_FAVICON = '/favicon.png?v=20261002'
/** 前端上传前的大小限制（后端 data URL 上限约 512KB） */
export const MAX_BRAND_IMAGE_BYTES = 512 * 1024

export type CornerStyle = 'round' | 'soft' | 'sharp'

export interface Branding {
  app_name: string
  app_subtitle: string
  hide_subtitle: boolean
  logo: string
  favicon: string
  primary_color: string
  primary_color_dark: string
  corner_style: CornerStyle
  show_github: boolean
}

export function defaultBranding(): Branding {
  return {
    app_name: '',
    app_subtitle: '',
    hide_subtitle: false,
    logo: '',
    favicon: '',
    primary_color: '',
    primary_color_dark: '',
    corner_style: 'round',
    show_github: true,
  }
}

function normalize(raw: any): Branding {
  const b = { ...defaultBranding(), ...(raw && typeof raw === 'object' ? raw : {}) }
  if (!['round', 'soft', 'sharp'].includes(b.corner_style)) b.corner_style = 'round'
  return b
}

function readCache(): Branding {
  try {
    const v = localStorage.getItem(BRANDING_STORAGE_KEY)
    if (v) return normalize(JSON.parse(v))
  } catch { /* 缓存不可用时用默认 */ }
  return defaultBranding()
}

function writeCache(b: Branding) {
  try {
    localStorage.setItem(BRANDING_STORAGE_KEY, JSON.stringify(b))
  } catch {
    // 图片太大存不下时去掉图片再存，至少颜色不闪
    try { localStorage.setItem(BRANDING_STORAGE_KEY, JSON.stringify({ ...b, logo: '', favicon: '' })) } catch { /* 忽略 */ }
  }
}

/** 已保存的品牌（服务端值） */
const saved = reactive<Branding>(readCache())
/** 当前生效的品牌：设置页编辑时临时预览，离开 / 撤销时还原为 saved */
const active = reactive<Branding>({ ...saved })

function cssBlock(selector: string, tokens: Record<string, string>) {
  const body = Object.entries(tokens).map(([k, v]) => `  ${k}: ${v};`).join('\n')
  return body ? `${selector} {\n${body}\n}\n` : ''
}

export function brandingCss(b: Branding): string {
  let css = ''
  const corner = cornerTokens(b.corner_style)
  const light = isHexColor(b.primary_color) ? b.primary_color : ''
  const dark = isHexColor(b.primary_color_dark) ? b.primary_color_dark : (light ? autoDarkColor(light) : '')
  css += cssBlock('html:root', { ...(light ? accentTokens(light, 'light') : {}), ...corner })
  if (dark) css += cssBlock('html:root[data-theme="dark"]', accentTokens(dark, 'dark'))
  return css
}

function applyToDocument(b: Branding) {
  if (typeof document === 'undefined') return
  let el = document.getElementById('huobao-branding') as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = 'huobao-branding'
    document.head.appendChild(el)
  }
  el.textContent = brandingCss(b)

  const href = b.favicon || DEFAULT_FAVICON
  const links = document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')
  if (links.length) {
    links.forEach((l) => {
      if (l.getAttribute('href') !== href) l.href = href
      // 自定义图标可能不是 PNG，去掉固定的 type / sizes
      if (b.favicon) { l.removeAttribute('type'); l.removeAttribute('sizes') }
    })
  } else {
    const l = document.createElement('link')
    l.rel = 'icon'
    l.href = href
    document.head.appendChild(l)
  }
}

if (typeof window !== 'undefined') applyToDocument(active)

/** 临时预览（设置页编辑中），不保存 */
export function previewBranding(b: Partial<Branding>) {
  Object.assign(active, normalize({ ...active, ...b }))
  applyToDocument(active)
}

/** 放弃预览，恢复为已保存的值 */
export function revertBrandingPreview() {
  Object.assign(active, saved)
  applyToDocument(active)
}

function commit(b: Branding) {
  Object.assign(saved, normalize(b))
  Object.assign(active, saved)
  writeCache(saved)
  applyToDocument(active)
}

let loading: Promise<void> | null = null
/** 拉取服务端品牌主题（启动时调用一次；失败沿用缓存） */
export function loadBranding() {
  loading ||= settingsAPI.branding()
    .then(commit)
    .catch(() => { /* 后端不可达时沿用缓存 */ })
    .finally(() => { loading = null })
  return loading
}

export async function saveBranding(b: Branding) {
  commit(await settingsAPI.setBranding(b))
}

export async function resetBranding() {
  commit(await settingsAPI.resetBranding())
}

const appName = computed(() => active.app_name || DEFAULT_APP_NAME)
const appSubtitle = computed(() => (active.hide_subtitle ? '' : (active.app_subtitle || DEFAULT_APP_SUBTITLE)))
const logoUrl = computed(() => active.logo || defaultLogo)
const hasCustomName = computed(() => !!active.app_name)

export function useBranding() {
  return {
    branding: readonly(active),
    savedBranding: readonly(saved),
    appName,
    appSubtitle,
    logoUrl,
    hasCustomName,
    showGithub: computed(() => active.show_github),
  }
}
