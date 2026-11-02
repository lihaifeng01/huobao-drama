/**
 * 当前操作人（请求上下文）：authGuard 用 runAsActor 包住整个请求，
 * 同一请求里的服务函数、Mastra Agent 的工具调用都能用 currentActor() 拿到发起人，
 * 不用把 userId 一层层传进 generateImage 等函数。
 *
 * 注意：后台任务续跑（服务重启后恢复、轮询）不依赖这里——发起人在创建任务时已写进行里。
 * 进程内队列（如字幕队列）要在入队时取 currentActor() 存下来，不能在出队时取。
 */
import { AsyncLocalStorage } from 'node:async_hooks'

export interface Actor {
  id: number
}

const storage = new AsyncLocalStorage<Actor>()

export function runAsActor<T>(actor: Actor, fn: () => T): T {
  return storage.run(actor, fn)
}

export function currentActor(): Actor | undefined {
  return storage.getStore()
}

export function currentActorId(): number | null {
  return storage.getStore()?.id ?? null
}
