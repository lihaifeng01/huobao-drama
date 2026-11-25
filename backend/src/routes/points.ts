import { Hono } from 'hono'
import { success, badRequest, notFound } from '../utils/response.js'
import { isAdmin } from '../services/auth.js'
import { getBalance, grantPoints, isPointLimited, listAccounts, listLedger, PointsError } from '../services/points.js'

/**
 * 积分账户
 * - GET /points/me、GET /points/ledger：所有登录用户；普通用户只能看自己的
 * - GET /points/accounts、POST /points/grant：仅管理员（middleware/auth.ts 的 settingsGuard）
 */
const app = new Hono()

// GET /points/me — 当前账号的积分；管理员 unlimited=true，不设上限
app.get('/me', async (c) => {
  const user = c.get('user')
  const limited = await isPointLimited(user.id)
  return success(c, limited ? { unlimited: false, ...(await getBalance(user.id)) } : { unlimited: true })
})

// GET /points/accounts — 全部普通用户的积分账户
app.get('/accounts', async (c) => success(c, await listAccounts()))

// POST /points/grant — { user_id, amount, note? }，amount 为负数表示扣减
app.post('/grant', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  try {
    return success(c, await grantPoints({
      userId: Number(body.user_id), amount: body.amount, note: body.note, operatorId: c.get('user').id,
    }))
  } catch (err) {
    if (err instanceof PointsError) return err.message === '账号不存在' ? notFound(c, err.message) : badRequest(c, err.message)
    throw err
  }
})

// GET /points/ledger — 分配流水；管理员可按 user_id 筛选，普通用户固定为自己
app.get('/ledger', async (c) => {
  const user = c.get('user')
  const q = c.req.query()
  const userId = isAdmin(user) ? (q.user_id ? Number(q.user_id) : undefined) : user.id
  const page = Math.max(1, Number(q.page) || 1)
  const pageSize = Math.min(100, Math.max(1, Number(q.page_size) || 20))
  return success(c, await listLedger(userId, page, pageSize))
})

export default app
