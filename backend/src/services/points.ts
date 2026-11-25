/**
 * 积分账户（积分二期）—— 管理员给普通用户分配积分，积分用完不能再调用付费功能
 *
 * - 余额 = point_ledger 流水合计（管理员分配 / 扣减）− usage_records 里已计入的积分（成功 + 进行中 + 待恢复）。
 *   失败退还的记录不计入，所以退还是自动的，不需要再写流水。
 * - 管理员（super_admin / admin）不设上限，不检查；免登模式（桌面版）的本机用户是超级管理员，同样不受限。
 * - 普通用户新建时没有流水，余额为 0，需要管理员分配后才能使用。
 */
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { currentActorId } from './actor.js'
import { findUser } from './auth.js'
import { COUNTED_STATUSES, computePoints, resolveUnitPoints, type UsageServiceType } from './usage.js'

/** 单次分配 / 扣减的绝对值上限 */
export const MAX_GRANT_POINTS = 10_000_000

/** 积分不足：路由 catch 后以 400 + message 返回；没人 catch 时由全局错误处理按 status 返回 402 */
export class InsufficientPointsError extends Error {
  status = 402
  code = 'insufficient_points'
  constructor(message: string) {
    super(message)
    this.name = 'InsufficientPointsError'
  }
}

export interface PointBalance {
  granted: number
  used: number
  balance: number
}

/** 某个用户的积分：累计分配、已用（含进行中预估）、余额 */
export async function getBalance(userId: number): Promise<PointBalance> {
  const [g] = await db.select({ v: sql<number>`coalesce(sum(${schema.pointLedger.delta}), 0)` })
    .from(schema.pointLedger).where(eq(schema.pointLedger.userId, userId))
  const [u] = await db.select({ v: sql<number>`coalesce(sum(${schema.usageRecords.points}), 0)` })
    .from(schema.usageRecords)
    .where(and(eq(schema.usageRecords.userId, userId), inArray(schema.usageRecords.status, COUNTED_STATUSES)))
  const granted = Number(g?.v) || 0
  const used = Number(u?.v) || 0
  return { granted, used, balance: granted - used }
}

/** 是否受积分限制：只有普通用户受限；找不到用户（已删除等）不拦截 */
export async function isPointLimited(userId: number | null | undefined): Promise<boolean> {
  if (userId == null) return false
  const user = await findUser(userId)
  return user?.role === 'user'
}

export interface PointCheckInput {
  serviceType: UsageServiceType
  provider?: string | null
  model?: string | null
  /** 本次用量（图片张数 / 视频秒数 / 字幕音频秒数），用来估算本次需要多少积分；缺省按最小量 */
  quantity?: number
  /** 缺省取当前请求的操作人 */
  userId?: number | null
}

/**
 * 发起付费调用前检查：普通用户余额为 0 不能用；余额不够本次预估的积分也不能用。
 * 文本 / 音频单价为 0，只要求余额大于 0。
 */
export async function assertPointsAvailable(input: PointCheckInput): Promise<void> {
  const userId = input.userId !== undefined ? input.userId : currentActorId()
  if (!await isPointLimited(userId)) return
  const { balance } = await getBalance(userId!)
  if (balance <= 0) {
    throw new InsufficientPointsError('积分已用完，请联系管理员分配积分后再使用')
  }
  const unit = await resolveUnitPoints(input.serviceType, input.provider, input.model)
  const cost = computePoints(input.serviceType, unit, input.quantity ?? 1)
  if (cost > balance) {
    throw new InsufficientPointsError(`积分不足：本次需要 ${cost} 积分，当前剩余 ${balance} 积分，请联系管理员分配积分`)
  }
}

// ---------- 管理员：分配 / 流水 ----------

export class PointsError extends Error {}

function parseAmount(raw: unknown): number {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw
  if (typeof n !== 'number' || !Number.isInteger(n) || n === 0 || Math.abs(n) > MAX_GRANT_POINTS) {
    throw new PointsError(`积分必须是非零整数，且绝对值不超过 ${MAX_GRANT_POINTS}`)
  }
  return n
}

/**
 * 给普通用户分配积分（amount > 0）或扣减（amount < 0，扣减后余额不能为负）。
 * 管理员积分不设上限，不能分配。
 */
export async function grantPoints(input: { userId: number; amount: unknown; note?: unknown; operatorId: number }) {
  const amount = parseAmount(input.amount)
  const target = await findUser(input.userId)
  if (!target) throw new PointsError('账号不存在')
  if (target.role !== 'user') throw new PointsError('管理员积分不设上限，无需分配')
  if (amount < 0) {
    const { balance } = await getBalance(target.id)
    if (balance + amount < 0) throw new PointsError(`扣减后余额不能为负（当前余额 ${balance}）`)
  }
  const note = typeof input.note === 'string' ? input.note.trim().slice(0, 200) : ''
  await db.insert(schema.pointLedger).values({
    userId: target.id,
    delta: amount,
    operatorId: input.operatorId,
    note: note || null,
    createdAt: now(),
  })
  return { user_id: target.id, ...(await getBalance(target.id)) }
}

/** 全部普通用户的积分账户（含已禁用，不含已删除） */
export async function listAccounts() {
  const users = await db.select().from(schema.users)
    .where(and(isNull(schema.users.deletedAt), eq(schema.users.role, 'user')))
    .orderBy(schema.users.id)
  return Promise.all(users.map(async u => ({
    user_id: u.id,
    username: u.username,
    display_name: u.displayName || u.username,
    status: u.status,
    ...(await getBalance(u.id)),
  })))
}

/** 分配流水（新的在前，分页）；userId 缺省看全部 */
export async function listLedger(userId: number | undefined, page: number, pageSize: number) {
  const t = schema.pointLedger
  const where = userId !== undefined ? eq(t.userId, userId) : undefined
  const [{ total }] = await db.select({ total: sql<number>`count(*)` }).from(t).where(where)
  const rows = await db.select({ row: t, username: schema.users.username, displayName: schema.users.displayName })
    .from(t)
    .leftJoin(schema.users, eq(schema.users.id, t.userId))
    .where(where)
    .orderBy(desc(t.id))
    .limit(pageSize).offset((page - 1) * pageSize)
  const operatorIds = [...new Set(rows.map(r => r.row.operatorId).filter((id): id is number => id != null))]
  const operators = operatorIds.length
    ? await db.select({ id: schema.users.id, username: schema.users.username, displayName: schema.users.displayName })
      .from(schema.users).where(inArray(schema.users.id, operatorIds))
    : []
  const operatorName = (id: number | null) => {
    const o = operators.find(x => x.id === id)
    return o ? o.displayName || o.username : null
  }
  return {
    total: Number(total),
    items: rows.map(({ row, username, displayName }) => ({
      id: row.id,
      user_id: row.userId,
      user_name: displayName || username || null,
      delta: row.delta,
      note: row.note,
      operator_name: operatorName(row.operatorId),
      created_at: row.createdAt,
    })),
  }
}
