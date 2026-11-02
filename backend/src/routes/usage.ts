import { Hono } from 'hono'
import type { Context } from 'hono'
import { db, schema } from '../db/index.js'
import { success, badRequest } from '../utils/response.js'
import { isAdmin } from '../services/auth.js'
import {
  POINT_SERVICE_TYPES, USAGE_SERVICE_TYPES, listRules, listUsage, saveRules, summaryByModel, summaryByType,
  type UsageFilter, type UsageServiceType, type UsageStatus,
} from '../services/usage.js'

/**
 * 用量统计与积分规则（积分一期：只统计，不扣余额）
 * - 普通用户只能看自己的用量；管理员可看全部或按成员筛选
 * - 规则：读放开，改仅管理员（middleware/auth.ts 的 settingsGuard）
 */
const app = new Hono()

const STATUSES: UsageStatus[] = ['pending', 'succeeded', 'refunded', 'held']

/** 解析筛选条件；非管理员强制只看自己 */
function filterOf(c: Context): UsageFilter {
  const q = c.req.query()
  const user = c.get('user')
  const f: UsageFilter = {}
  if (!isAdmin(user)) f.userId = user.id
  else if (q.user_id) f.userId = Number(q.user_id)
  if (q.drama_id) f.dramaId = Number(q.drama_id)
  if (q.from) f.from = q.from
  if (q.to) f.to = q.to
  if (q.service_type && USAGE_SERVICE_TYPES.includes(q.service_type as UsageServiceType)) f.serviceType = q.service_type as UsageServiceType
  // provider / model 允许空串（老数据或未知模型），所以用 !== undefined 判断
  if (q.provider !== undefined) f.provider = q.provider
  if (q.model !== undefined) f.model = q.model
  if (q.status && STATUSES.includes(q.status as UsageStatus)) f.status = q.status as UsageStatus
  return f
}

// GET /usage/summary — 四个分类的汇总
app.get('/summary', async (c) => success(c, await summaryByType(filterOf(c))))

// GET /usage/summary/:type/models — 某个分类下每个模型的用量
app.get('/summary/:type/models', async (c) => {
  const type = c.req.param('type') as UsageServiceType
  if (!USAGE_SERVICE_TYPES.includes(type)) return badRequest(c, '用量类型无效')
  return success(c, await summaryByModel(type, filterOf(c)))
})

// GET /usage/records — 使用记录明细（可按分类 / 模型 / 状态筛选，分页）
app.get('/records', async (c) => {
  const page = Math.max(1, Number(c.req.query('page')) || 1)
  const pageSize = Math.min(100, Math.max(1, Number(c.req.query('page_size')) || 20))
  return success(c, await listUsage(filterOf(c), page, pageSize))
})

// GET /usage/rules — 各类型默认积分 + 单个模型覆盖 + 可设置的模型（来自 AI 服务配置）
app.get('/rules', async (c) => {
  const rules = await listRules()
  const defaults = Object.fromEntries(POINT_SERVICE_TYPES.map(type => [
    type, rules.find(r => r.serviceType === type && !r.provider && !r.model)?.points ?? 0,
  ]))
  const models = rules
    .filter(r => r.model && POINT_SERVICE_TYPES.includes(r.serviceType as UsageServiceType))
    .map(r => ({ service_type: r.serviceType, provider: r.provider, model: r.model, points: r.points }))
  // 候选模型：各配置里登记的模型（去重，带配置名方便辨认）
  const configs = await db.select().from(schema.aiServiceConfigs)
  const seen = new Set<string>()
  const candidates: { service_type: string; provider: string; model: string; config_name: string; is_active: boolean }[] = []
  for (const cfg of configs) {
    if (!POINT_SERVICE_TYPES.includes(cfg.serviceType as UsageServiceType)) continue
    let list: string[] = []
    try { list = cfg.model ? JSON.parse(cfg.model) : [] } catch { list = [] }
    for (const model of Array.isArray(list) ? list : []) {
      const key = `${cfg.serviceType}|${cfg.provider || ''}|${model}`
      if (!model || seen.has(key)) continue
      seen.add(key)
      candidates.push({ service_type: cfg.serviceType, provider: cfg.provider || '', model, config_name: cfg.name, is_active: !!cfg.isActive })
    }
  }
  return success(c, { defaults, models, candidates })
})

// PUT /usage/rules — { defaults: { image, video, subtitle }, models: [{ service_type, provider, model, points|null }] }
app.put('/rules', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  try {
    await saveRules({ defaults: body.defaults, models: Array.isArray(body.models) ? body.models : [] })
  } catch (err: any) {
    return badRequest(c, err.message)
  }
  return success(c)
})

export default app
