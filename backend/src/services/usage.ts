/**
 * 用量统计（积分一期：只记录，不扣余额、不拦截）—— 设计见 docs/design/usage-quota.md
 *
 * 每次付费调用写一行 usage_records：
 * - 图片 / 视频：createTask 时 startUsage（pending，按请求量预估），完成时 completeUsage 按实际量重算，失败时 failUsage
 * - 字幕（语音识别）：transcribeVideoCues 内部记录
 * - 文本模型：generateWithUsage 包住 agent.generate，事后按 token 记录；文本只统计不计积分
 *
 * 失败的计分规则（refund = 不计积分）：
 * - 上游没接单（没有上游任务编号）、上游明确失败（generation_failed，含审核拦截）→ refunded
 * - 有上游任务编号但超时 / 结果转存失败 / 提交结果未知 → held（上游可能已收费，仍可恢复，计积分）
 */
import { and, desc, eq, gte, lt, sql, type SQL } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { currentActorId } from './actor.js'

export type UsageServiceType = 'image' | 'video' | 'subtitle' | 'text'
export type UsageStatus = 'pending' | 'succeeded' | 'refunded' | 'held'

export const USAGE_SERVICE_TYPES: UsageServiceType[] = ['image', 'video', 'subtitle', 'text']
/** 可设置积分的类型（文本只统计 token，不计积分） */
export const POINT_SERVICE_TYPES: UsageServiceType[] = ['image', 'video', 'subtitle']
/** 计入积分的状态：成功、进行中（预估）、待恢复 */
const COUNTED_STATUSES: UsageStatus[] = ['succeeded', 'pending', 'held']

type UsageRow = typeof schema.usageRecords.$inferSelect

// ---------- 规则 ----------

/**
 * 单价：provider + model 精确 → 只按 model → 类型默认 → 0
 * 文本固定为 0（只统计不扣）
 */
export async function resolveUnitPoints(serviceType: UsageServiceType, provider?: string | null, model?: string | null): Promise<number> {
  if (serviceType === 'text') return 0
  const rules = await db.select().from(schema.pointRules).where(eq(schema.pointRules.serviceType, serviceType))
  const p = provider || ''
  const m = model || ''
  const hit = (m && rules.find(r => r.provider === p && r.model === m))
    || (m && rules.find(r => r.provider === '' && r.model === m))
    || rules.find(r => r.provider === '' && r.model === '')
  return hit?.points ?? 0
}

/** 图片：单价 × 张数；视频：单价 × 秒数（向上取整）；字幕：单价 × 分钟数（音频秒数向上取整到分钟，至少 1 分钟）；文本：0 */
export function computePoints(serviceType: UsageServiceType, unitPoints: number, quantity: number): number {
  const q = Math.max(0, Number(quantity) || 0)
  switch (serviceType) {
    case 'image': return Math.ceil(unitPoints * q)
    case 'video': return Math.ceil(unitPoints * q)
    case 'subtitle': return unitPoints * Math.max(1, Math.ceil(q / 60))
    default: return 0
  }
}

// ---------- 记录 ----------

export interface StartUsageInput {
  serviceType: UsageServiceType
  provider?: string | null
  model?: string | null
  configId?: number | null
  source?: string | null
  refType: string
  refId: number
  quantity: number
  dramaId?: number | null
  /** 缺省取当前请求的操作人 */
  userId?: number | null
}

/** 付费调用发起时记一行（pending，积分按请求量预估） */
export async function startUsage(input: StartUsageInput): Promise<number> {
  const unitPoints = await resolveUnitPoints(input.serviceType, input.provider, input.model)
  const ts = now()
  const res = await db.insert(schema.usageRecords).values({
    userId: input.userId !== undefined ? input.userId : currentActorId(),
    dramaId: input.dramaId ?? null,
    serviceType: input.serviceType,
    provider: input.provider ?? null,
    model: input.model ?? null,
    configId: input.configId ?? null,
    source: input.source ?? null,
    refType: input.refType,
    refId: input.refId,
    quantity: input.quantity,
    unitPoints,
    points: computePoints(input.serviceType, unitPoints, input.quantity),
    status: 'pending',
    createdAt: ts,
    updatedAt: ts,
  })
  return getInsertId(res)
}

async function findByRef(refType: string, refId: number): Promise<UsageRow | undefined> {
  const [row] = await db.select().from(schema.usageRecords)
    .where(and(eq(schema.usageRecords.refType, refType), eq(schema.usageRecords.refId, refId)))
    .orderBy(desc(schema.usageRecords.id)).limit(1)
  return row
}

/** 成功：按实际量重算积分（单价用发起时的快照）。held 的任务恢复成功也走这里 */
export async function completeUsage(refType: string, refId: number, opts: { quantity?: number | null } = {}) {
  const row = await findByRef(refType, refId)
  if (!row || row.status === 'succeeded') return
  const quantity = opts.quantity != null && opts.quantity > 0 ? opts.quantity : row.quantity
  const ts = now()
  await db.update(schema.usageRecords).set({
    status: 'succeeded',
    quantity,
    points: computePoints(row.serviceType as UsageServiceType, row.unitPoints, quantity),
    errorCode: null,
    completedAt: ts,
    updatedAt: ts,
  }).where(eq(schema.usageRecords.id, row.id))
}

/** 失败：refund=true 不计积分（refunded），否则保留积分等待恢复（held） */
export async function failUsage(refType: string, refId: number, opts: { refund: boolean; errorCode?: string | null }) {
  const row = await findByRef(refType, refId)
  if (!row || row.status === 'succeeded' || row.status === 'refunded') return
  await db.update(schema.usageRecords).set({
    status: opts.refund ? 'refunded' : 'held',
    errorCode: opts.errorCode ?? null,
    updatedAt: now(),
  }).where(eq(schema.usageRecords.id, row.id))
}

/**
 * 生成任务失败时是否退还：
 * - 没有上游任务编号也没有结果地址 → 上游没接单，退还（提交结果未知 submission_unknown 除外）
 * - 上游明确失败 generation_failed → 退还
 * - 其余（超时、转存失败、恢复失败等，上游可能已收费且可恢复）→ 保留
 */
export function isRefundableTaskFailure(task: { taskId: string | null; resultUrl: string | null; errorCode: string | null }) {
  if (task.errorCode === 'generation_failed') return true
  if (task.errorCode === 'submission_unknown') return false
  return !task.taskId && !task.resultUrl
}

/** 文本模型：同步调用结束后直接记一行（只统计 token，不计积分） */
export async function recordTextUsage(input: {
  provider?: string | null
  model?: string | null
  configId?: number | null
  source: string
  dramaId?: number | null
  inputTokens?: number | null
  outputTokens?: number | null
  totalTokens?: number | null
  ok: boolean
  errorCode?: string | null
}) {
  const total = input.totalTokens ?? ((input.inputTokens ?? 0) + (input.outputTokens ?? 0))
  const ts = now()
  await db.insert(schema.usageRecords).values({
    userId: currentActorId(),
    dramaId: input.dramaId ?? null,
    serviceType: 'text',
    provider: input.provider ?? null,
    model: input.model ?? null,
    configId: input.configId ?? null,
    source: input.source,
    refType: 'agent',
    refId: null,
    quantity: total || 0,
    unitPoints: 0,
    points: 0,
    status: input.ok ? 'succeeded' : 'refunded',
    errorCode: input.errorCode ?? null,
    // 中转站可能不返回用量：记下来，报表里能区分「0 token」和「未返回」
    detail: JSON.stringify({
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
      usageMissing: input.ok && !total,
    }),
    createdAt: ts,
    updatedAt: ts,
    completedAt: ts,
  })
}

/** 服务重启：字幕等进程内任务不会续跑（业务侧已标失败），对应的进行中记录退还。生成任务由 resumeInterruptedTasks 处理 */
export async function resetInterruptedUsage() {
  await db.update(schema.usageRecords)
    .set({ status: 'refunded', errorCode: 'interrupted', updatedAt: now() })
    .where(and(eq(schema.usageRecords.status, 'pending'), sql`${schema.usageRecords.refType} != 'sys_task'`))
}

// ---------- 查询 ----------

export interface UsageFilter {
  userId?: number
  dramaId?: number
  from?: string
  to?: string
  serviceType?: UsageServiceType
  model?: string
  provider?: string
  status?: UsageStatus
}

function whereOf(f: UsageFilter): SQL | undefined {
  const t = schema.usageRecords
  const conds: (SQL | undefined)[] = [
    f.userId !== undefined ? eq(t.userId, f.userId) : undefined,
    f.dramaId !== undefined ? eq(t.dramaId, f.dramaId) : undefined,
    f.from ? gte(t.createdAt, f.from) : undefined,
    f.to ? lt(t.createdAt, f.to) : undefined,
    f.serviceType ? eq(t.serviceType, f.serviceType) : undefined,
    f.provider !== undefined ? eq(t.provider, f.provider) : undefined,
    f.model !== undefined ? eq(t.model, f.model) : undefined,
    f.status ? eq(t.status, f.status) : undefined,
  ]
  return and(...conds)
}

/** 汇总列：次数、各状态次数、用量（不含已退还）、积分（成功 + 进行中 + 待恢复） */
function aggregateColumns() {
  const t = schema.usageRecords
  const counted = sql.join(COUNTED_STATUSES.map(s => sql`${s}`), sql`, `)
  return {
    count: sql<number>`count(*)`,
    succeeded: sql<number>`sum(case when ${t.status} = 'succeeded' then 1 else 0 end)`,
    pending: sql<number>`sum(case when ${t.status} = 'pending' then 1 else 0 end)`,
    held: sql<number>`sum(case when ${t.status} = 'held' then 1 else 0 end)`,
    refunded: sql<number>`sum(case when ${t.status} = 'refunded' then 1 else 0 end)`,
    quantity: sql<number>`coalesce(sum(case when ${t.status} in (${counted}) then ${t.quantity} else 0 end), 0)`,
    points: sql<number>`coalesce(sum(case when ${t.status} in (${counted}) then ${t.points} else 0 end), 0)`,
  }
}

function numbers<T extends Record<string, unknown>>(row: T) {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : (v ?? 0)])) as T
}

/** 按类型汇总；没有记录的类型也返回一行 0，前端固定显示四个分类 */
export async function summaryByType(f: UsageFilter) {
  const t = schema.usageRecords
  const rows = await db.select({ serviceType: t.serviceType, ...aggregateColumns() })
    .from(t).where(whereOf(f)).groupBy(t.serviceType)
  return USAGE_SERVICE_TYPES.map((type) => {
    const r = rows.find(x => x.serviceType === type)
    return numbers({
      service_type: type,
      count: r?.count ?? 0,
      succeeded: r?.succeeded ?? 0,
      pending: r?.pending ?? 0,
      held: r?.held ?? 0,
      refunded: r?.refunded ?? 0,
      quantity: r?.quantity ?? 0,
      points: r?.points ?? 0,
    })
  })
}

/** 某个类型下按模型汇总（积分降序） */
export async function summaryByModel(serviceType: UsageServiceType, f: UsageFilter) {
  const t = schema.usageRecords
  const rows = await db.select({ provider: t.provider, model: t.model, ...aggregateColumns() })
    .from(t).where(whereOf({ ...f, serviceType })).groupBy(t.provider, t.model)
  return rows
    .map(r => numbers({
      provider: r.provider ?? '', model: r.model ?? '',
      count: r.count, succeeded: r.succeeded, pending: r.pending, held: r.held, refunded: r.refunded,
      quantity: r.quantity, points: r.points,
    }))
    .sort((a, b) => (b.points - a.points) || (b.count - a.count))
}

/** 使用记录明细（新的在前，分页） */
export async function listUsage(f: UsageFilter, page: number, pageSize: number) {
  const t = schema.usageRecords
  const where = whereOf(f)
  const [{ total }] = await db.select({ total: sql<number>`count(*)` }).from(t).where(where)
  const rows = await db.select({
    record: t,
    username: schema.users.username,
    displayName: schema.users.displayName,
    dramaTitle: schema.dramas.title,
  }).from(t)
    .leftJoin(schema.users, eq(schema.users.id, t.userId))
    .leftJoin(schema.dramas, eq(schema.dramas.id, t.dramaId))
    .where(where)
    .orderBy(desc(t.id))
    .limit(pageSize).offset((page - 1) * pageSize)
  return {
    total: Number(total),
    items: rows.map(({ record: r, username, displayName, dramaTitle }) => ({
      id: r.id,
      service_type: r.serviceType,
      provider: r.provider,
      model: r.model,
      source: r.source,
      quantity: r.quantity,
      unit_points: r.unitPoints,
      points: r.points,
      status: r.status,
      error_code: r.errorCode,
      detail: r.detail ? JSON.parse(r.detail) : null,
      drama_id: r.dramaId,
      drama_title: dramaTitle,
      user_id: r.userId,
      user_name: displayName || username || null,
      created_at: r.createdAt,
      completed_at: r.completedAt,
    })),
  }
}

/** 有使用记录的用户（报表的成员筛选用） */
export async function usageUserIds(): Promise<number[]> {
  const rows = await db.selectDistinct({ id: schema.usageRecords.userId }).from(schema.usageRecords)
  return rows.map(r => r.id).filter((id): id is number => id != null)
}

// ---------- 规则管理 ----------

export async function listRules() {
  return db.select().from(schema.pointRules)
}

/**
 * 整体保存规则：defaults 为各类型默认值；models 为单个模型覆盖（points 为 null = 删除覆盖、跟随默认）
 */
export async function saveRules(input: {
  defaults?: Partial<Record<UsageServiceType, unknown>>
  models?: { service_type: unknown; provider?: unknown; model: unknown; points: unknown }[]
}) {
  const ts = now()
  const parsePoints = (v: unknown) => {
    const n = Number(v)
    if (!Number.isInteger(n) || n < 0 || n > 1_000_000) throw new Error('积分必须是 0 到 1000000 之间的整数')
    return n
  }
  type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
  const upsert = (tx: Tx, serviceType: string, provider: string, model: string, points: number) => {
    tx.insert(schema.pointRules).values({ serviceType, provider, model, points, createdAt: ts, updatedAt: ts })
      .onConflictDoUpdate({
        target: [schema.pointRules.serviceType, schema.pointRules.provider, schema.pointRules.model],
        set: { points, updatedAt: ts },
      }).run()
  }
  // 先全部校验，再在一个事务里写，避免保存一半
  const defaults = Object.entries(input.defaults || {}).map(([type, v]) => {
    if (!POINT_SERVICE_TYPES.includes(type as UsageServiceType)) throw new Error(`不支持的类型：${type}`)
    return { type, points: parsePoints(v) }
  })
  const models = (input.models || []).map((m) => {
    const type = String(m.service_type)
    if (!POINT_SERVICE_TYPES.includes(type as UsageServiceType)) throw new Error(`不支持的类型：${type}`)
    const model = String(m.model ?? '').trim()
    if (!model) throw new Error('模型名不能为空')
    return { type, provider: String(m.provider ?? '').trim(), model, points: m.points === null || m.points === '' ? null : parsePoints(m.points) }
  })
  db.transaction((tx) => {
    for (const d of defaults) upsert(tx, d.type, '', '', d.points)
    for (const m of models) {
      if (m.points === null) {
        tx.delete(schema.pointRules).where(and(
          eq(schema.pointRules.serviceType, m.type), eq(schema.pointRules.provider, m.provider), eq(schema.pointRules.model, m.model),
        )).run()
      } else {
        upsert(tx, m.type, m.provider, m.model, m.points)
      }
    }
  })
}

