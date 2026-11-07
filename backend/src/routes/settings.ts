/**
 * 应用设置路由 — 全局配置的读写入口（AI 内容语言、引导记录、品牌主题）
 */
import { Hono } from 'hono'
import { getContentLanguage, setContentLanguage, getToursSeen, setToursSeen, CONTENT_LANGUAGES, type ContentLanguage } from '../services/app-settings.js'
import { getBranding, setBranding, resetBranding, BrandingError } from '../services/branding.js'
import { success, badRequest } from '../utils/response.js'

const app = new Hono()

// GET /content-language — 当前 AI 内容语言
app.get('/content-language', async (c) => {
  return success(c, { language: await getContentLanguage() })
})

// PUT /content-language — 设置 AI 内容语言（body: { language: 'zh'|'en'|'ja'|'ko' }）
app.put('/content-language', async (c) => {
  const body = await c.req.json().catch(() => null)
  const language = body?.language
  if (!(CONTENT_LANGUAGES as readonly string[]).includes(language)) {
    return badRequest(c, `language 必须是 ${CONTENT_LANGUAGES.join(' / ')} 之一`)
  }
  const saved = await setContentLanguage(language as ContentLanguage)
  return success(c, { language: saved })
})

// GET /tours-seen — 已看过的引导漫游 id 列表
app.get('/tours-seen', async (c) => {
  return success(c, { seen: await getToursSeen() })
})

// PUT /tours-seen — 写入已看过的引导漫游 id 列表（body: { seen: string[] }）
app.put('/tours-seen', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!Array.isArray(body?.seen) || !body.seen.every((v: unknown) => typeof v === 'string')) {
    return badRequest(c, 'seen 必须是字符串数组')
  }
  return success(c, { seen: await setToursSeen(body.seen) })
})

// GET /branding — 品牌主题（公开：登录页也要用）
app.get('/branding', async (c) => {
  return success(c, getBranding())
})

// PUT /branding — 保存品牌主题（仅超级管理员，见 middleware/auth.ts）
app.put('/branding', async (c) => {
  const body = await c.req.json().catch(() => null)
  try {
    return success(c, setBranding(body))
  } catch (e) {
    if (e instanceof BrandingError) return badRequest(c, e.message)
    throw e
  }
})

// DELETE /branding — 恢复默认品牌主题（仅超级管理员）
app.delete('/branding', async (c) => {
  return success(c, resetBranding())
})

export default app
