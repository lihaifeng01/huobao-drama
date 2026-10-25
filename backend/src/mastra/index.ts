/**
 * Mastra 中央实例 — Agent 注册表挂载点
 * 不用 Mastra logger（项目已有 pino + task-logger）
 */
import { Mastra } from '@mastra/core/mastra'
import { agentRegistry, auxiliaryAgents } from '../agents/index.js'

export const mastra = new Mastra({
  // auxiliaryAgents：内部辅助 Agent（如前情摘要），不对外暴露为可配置的 Agent 类型
  agents: { ...agentRegistry, ...auxiliaryAgents },
  logger: false,
})
