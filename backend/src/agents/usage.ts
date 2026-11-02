/**
 * 文本模型用量：getModel 解析出实际模型后记在请求上下文里，generateWithUsage 在 agent.generate 结束后
 * 按 result.totalUsage（工具循环多步合计）写一条用量记录。文本只统计 token，不计积分。
 */
import type { RequestContext } from '@mastra/core/request-context'
import { getDramaId } from './context.js'
import { recordTextUsage } from '../services/usage.js'
import { logTaskWarn } from '../utils/task-logger.js'

const USAGE_MODEL_KEY = 'usageModel'

export interface UsageModelInfo {
  configId: number | null
  provider: string
  model: string
}

/** getModel 调用：记下本次请求实际使用的文本配置与模型 */
export function rememberUsageModel(requestContext: RequestContext<any> | undefined, info: UsageModelInfo) {
  requestContext?.set(USAGE_MODEL_KEY as never, info as never)
}

function tokensOf(result: any) {
  const u = result?.totalUsage ?? result?.usage ?? {}
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  return { inputTokens: num(u.inputTokens), outputTokens: num(u.outputTokens), totalTokens: num(u.totalTokens) }
}

/** 包住一次 agent.generate：成功按 token 记录，失败记一条失败（不影响原有的抛错） */
export async function generateWithUsage<T>(source: string, requestContext: RequestContext<any> | undefined, run: () => Promise<T>): Promise<T> {
  const record = (ok: boolean, result?: unknown, errorCode?: string) => {
    const info = requestContext?.get(USAGE_MODEL_KEY as never) as UsageModelInfo | undefined
    return recordTextUsage({
      provider: info?.provider ?? null,
      model: info?.model ?? null,
      configId: info?.configId ?? null,
      source,
      dramaId: getDramaId(requestContext),
      ...(ok ? tokensOf(result) : {}),
      ok,
      errorCode,
    }).catch((err: Error) => logTaskWarn('Usage', 'record-text', { source, error: err.message }))
  }
  let result: T
  try {
    result = await run()
  } catch (err) {
    await record(false, undefined, 'agent_failed')
    throw err
  }
  await record(true, result)
  return result
}
