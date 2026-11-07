/**
 * 品牌主题（白标）：应用名称、Logo、网站图标、主题色、圆角风格、顶栏 GitHub 链接
 * - 存 app_settings 表 key='branding'（JSON），只存覆盖项；空字符串 = 使用内置默认
 * - Logo / 图标以 data URL 内联存储：不依赖存储目录，桌面版迁移数据目录也不丢
 * - 读接口公开（登录页也要显示品牌），写接口仅超级管理员（middleware/auth.ts）
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'

const BRANDING_KEY = 'branding'

export const CORNER_STYLES = ['round', 'soft', 'sharp'] as const
export type CornerStyle = typeof CORNER_STYLES[number]

export interface Branding {
  /** 应用名称（顶栏、登录页、浏览器标题）；空 = 默认「火宝短剧」 */
  app_name: string
  /** 名称下方的副标题；空 = 默认「Huobao Shorts」 */
  app_subtitle: string
  /** 隐藏副标题 */
  hide_subtitle: boolean
  /** Logo（data URL）；空 = 内置 Logo */
  logo: string
  /** 浏览器标签页图标（data URL）；空 = 内置图标 */
  favicon: string
  /** 浅色主题主色 #rrggbb；空 = 内置火焰橙 */
  primary_color: string
  /** 深色主题主色 #rrggbb；空 = 由浅色主色自动提亮 */
  primary_color_dark: string
  /** 圆角风格：round 胶囊（默认）/ soft 柔和圆角 / sharp 小圆角 */
  corner_style: CornerStyle
  /** 顶栏显示 GitHub 链接 */
  show_github: boolean
}

export const DEFAULT_BRANDING: Branding = {
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

/** data URL 上限（字符数）：约 512KB 的二进制图片 base64 后的长度 */
export const MAX_IMAGE_DATA_URL = 700_000
const IMAGE_DATA_URL = /^data:image\/(png|jpeg|webp|gif|svg\+xml|x-icon|vnd\.microsoft\.icon);base64,[A-Za-z0-9+/]+=*$/
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

export class BrandingError extends Error {}

function cleanText(v: unknown, field: string, max: number): string {
  if (v === undefined || v === null) return ''
  if (typeof v !== 'string') throw new BrandingError(`${field} 必须是字符串`)
  const s = v.trim()
  if (s.length > max) throw new BrandingError(`${field} 不能超过 ${max} 个字符`)
  return s
}

function cleanColor(v: unknown, field: string): string {
  const s = cleanText(v, field, 7)
  if (s && !HEX_COLOR.test(s)) throw new BrandingError(`${field} 必须是 #RRGGBB 格式的颜色`)
  return s.toLowerCase()
}

function cleanImage(v: unknown, field: string): string {
  if (v === undefined || v === null || v === '') return ''
  if (typeof v !== 'string') throw new BrandingError(`${field} 必须是图片 data URL`)
  if (v.length > MAX_IMAGE_DATA_URL) throw new BrandingError(`${field} 图片过大（上限约 512KB）`)
  if (!IMAGE_DATA_URL.test(v)) throw new BrandingError(`${field} 仅支持 PNG / JPG / WebP / GIF / SVG / ICO 图片`)
  return v
}

/** 校验并补全：未传的字段取默认值，非法值抛 BrandingError */
export function sanitizeBranding(input: unknown): Branding {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BrandingError('请求体必须是对象')
  const b = input as Record<string, unknown>
  const corner = b.corner_style ?? DEFAULT_BRANDING.corner_style
  if (!(CORNER_STYLES as readonly unknown[]).includes(corner)) {
    throw new BrandingError(`corner_style 必须是 ${CORNER_STYLES.join(' / ')} 之一`)
  }
  return {
    app_name: cleanText(b.app_name, 'app_name', 40),
    app_subtitle: cleanText(b.app_subtitle, 'app_subtitle', 60),
    hide_subtitle: b.hide_subtitle === true,
    logo: cleanImage(b.logo, 'logo'),
    favicon: cleanImage(b.favicon, 'favicon'),
    primary_color: cleanColor(b.primary_color, 'primary_color'),
    primary_color_dark: cleanColor(b.primary_color_dark, 'primary_color_dark'),
    corner_style: corner as CornerStyle,
    show_github: b.show_github !== false,
  }
}

export function getBranding(): Branding {
  const row = db.select().from(schema.appSettings)
    .where(eq(schema.appSettings.key, BRANDING_KEY))
    .get()
  if (!row?.value) return { ...DEFAULT_BRANDING }
  try {
    return sanitizeBranding(JSON.parse(row.value))
  } catch {
    // 库里的值损坏时回退默认，不让整个界面挂掉
    return { ...DEFAULT_BRANDING }
  }
}

export function setBranding(input: unknown): Branding {
  const clean = sanitizeBranding(input)
  const value = JSON.stringify(clean)
  db.insert(schema.appSettings)
    .values({ key: BRANDING_KEY, value, updatedAt: now() })
    .onConflictDoUpdate({
      target: schema.appSettings.key,
      set: { value, updatedAt: now() },
    })
    .run()
  return clean
}

/** 恢复默认：写回默认值（不删行，与项目「不物理删除」约定一致） */
export function resetBranding(): Branding {
  return setBranding(DEFAULT_BRANDING)
}
