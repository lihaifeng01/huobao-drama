/**
 * 前情摘要
 *
 * 每集剧本单独上传、各集 Agent 互不知道前面发生了什么。这里为每集生成一份结构化摘要
 * （剧情 / 人物状态 / 未解悬念 / 结尾），并在运行后续集的 Agent 时把前几集的摘要
 * 作为「前情提要」拼进 instructions（见 agents/index.ts buildInstructions）。
 *
 * - 摘要依据：scriptContent（改写后的剧本）优先，没有则用原始 content
 * - 过期判断：生成时记录依据文本的哈希（summary_source_hash），剧本改动后哈希不一致即过期
 * - 用户手动编辑过的摘要（summary_edited）不会被自动重新生成覆盖，只在界面提示过期
 * - 懒生成：拼前情提要时，缺失/过期的前几集摘要会先补生成（同一集并发请求只生成一次）
 */
import crypto from 'crypto'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { buildAgentRequestContext } from '../agents/context.js'
import type { ContentLanguage } from './app-settings.js'
import { now } from '../utils/response.js'
import { logTaskError, logTaskProgress, logTaskSuccess } from '../utils/task-logger.js'

type EpisodeRow = typeof schema.episodes.$inferSelect

/** 前情提要最多回看的集数（取紧邻的前 N 集） */
export const RECAP_MAX_EPISODES = 8
/** 前情提要总字数预算：从最近一集往前放，超出预算的更早集省略 */
const RECAP_CHAR_BUDGET = 6000
/** 单集摘要在前情提要里的长度上限（手动编辑的长摘要也会截断） */
const SUMMARY_CHAR_MAX = 800
/** 送给摘要模型的单集剧本长度上限 */
const SOURCE_CHAR_MAX = 20000
const GENERATE_CONCURRENCY = 3

export interface SummaryOptions { model?: string; configId?: number; language?: ContentLanguage }

export function summarySource(ep: Pick<EpisodeRow, 'scriptContent' | 'content'>): string {
  return (ep.scriptContent || ep.content || '').trim()
}

export function sourceHash(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex')
}

/** 摘要状态：none 无剧本可摘要；missing 未生成；stale 剧本已改动；fresh 最新 */
export function summaryState(ep: EpisodeRow): 'none' | 'missing' | 'stale' | 'fresh' {
  const source = summarySource(ep)
  if (!source) return 'none'
  if (!ep.summary) return 'missing'
  return ep.summarySourceHash === sourceHash(source) ? 'fresh' : 'stale'
}

function cleanSummary(text: string): string {
  return text.replace(/^```[a-z]*\n?/i, '').replace(/```\s*$/, '').trim()
}

const inflight = new Map<number, Promise<string>>()

/** 生成并保存某集摘要（覆盖手动编辑标记）。失败抛错 */
export function generateEpisodeSummary(episodeId: number, opts: SummaryOptions = {}): Promise<string> {
  const running = inflight.get(episodeId)
  if (running) return running
  const task = (async () => {
    const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
    if (!ep) throw new Error('剧集不存在')
    const source = summarySource(ep)
    if (!source) throw new Error('本集还没有剧本内容，无法生成摘要')

    // 动态导入：mastra → agents → 本模块，静态导入会形成循环依赖
    const { mastra } = await import('../mastra/index.js')
    const agent = mastra.getAgent('episode_summarizer')
    const requestContext = buildAgentRequestContext({
      episodeId: ep.id,
      dramaId: ep.dramaId,
      modelOverride: opts.model,
      textConfigId: opts.configId,
      language: opts.language,
    })
    logTaskProgress('EpisodeSummary', 'generate', { episodeId, episodeNumber: ep.episodeNumber, sourceChars: source.length })
    const clipped = source.length > SOURCE_CHAR_MAX ? `${source.slice(0, SOURCE_CHAR_MAX)}\n……（后文省略）` : source
    const result = await agent.generate(
      [{ role: 'user', content: `第 ${ep.episodeNumber} 集《${ep.title}》内容如下：\n\n${clipped}` }],
      { maxSteps: 1, requestContext },
    )
    const summary = cleanSummary(result.text || '')
    if (!summary) throw new Error('摘要生成失败：模型未返回内容')
    const ts = now()
    await db.update(schema.episodes).set({
      summary,
      summarySourceHash: sourceHash(source),
      summaryEdited: false,
      summaryUpdatedAt: ts,
    }).where(eq(schema.episodes.id, ep.id))
    logTaskSuccess('EpisodeSummary', 'generate', { episodeId, chars: summary.length })
    return summary
  })()
  inflight.set(episodeId, task)
  task.finally(() => inflight.delete(episodeId)).catch(() => {})
  return task
}

/** 保存用户手动编辑的摘要：标记为已编辑，并以当前剧本哈希为准（之后剧本再改才算过期） */
export async function saveEditedSummary(episodeId: number, summary: string) {
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!ep) throw new Error('剧集不存在')
  const text = summary.trim()
  const source = summarySource(ep)
  await db.update(schema.episodes).set({
    summary: text || null,
    summarySourceHash: text && source ? sourceHash(source) : null,
    summaryEdited: !!text,
    summaryUpdatedAt: now(),
  }).where(eq(schema.episodes.id, ep.id))
}

/** 当前集之前的剧集（同项目、未删除，按集号升序），最多取紧邻的 limit 集 */
export async function previousEpisodes(episodeId: number, limit = RECAP_MAX_EPISODES): Promise<EpisodeRow[]> {
  const [current] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!current) return []
  const all = await db.select().from(schema.episodes)
    .where(and(eq(schema.episodes.dramaId, current.dramaId), isNull(schema.episodes.deletedAt)))
    .orderBy(asc(schema.episodes.episodeNumber))
  return all.filter(e => e.episodeNumber < current.episodeNumber).slice(-limit)
}

/** 补齐缺失/过期（且未手动编辑）的摘要；单集失败只记日志，不阻断 */
export async function ensureSummaries(episodes: EpisodeRow[], opts: SummaryOptions = {}) {
  const todo = episodes.filter((ep) => {
    const state = summaryState(ep)
    return state === 'missing' || (state === 'stale' && !ep.summaryEdited)
  })
  for (let i = 0; i < todo.length; i += GENERATE_CONCURRENCY) {
    await Promise.all(todo.slice(i, i + GENERATE_CONCURRENCY).map(ep =>
      generateEpisodeSummary(ep.id, opts).catch((err) => {
        logTaskError('EpisodeSummary', 'auto-generate', { episodeId: ep.id, error: err.message })
      }),
    ))
  }
}

const RECAP_HEADINGS: Record<string, { title: string; note: string; omitted: string; episode: (n: number, title: string) => string }> = {
  zh: {
    title: '前情提要',
    episode: (n, title) => `第 ${n} 集《${title}》`,
    note: '以下是本集之前各集的剧情摘要（按集号顺序），用于保持人物身份、关系、状态与情节的连续性：人物称呼、伤势、服装造型变化、已揭露的秘密等要与前情一致。不要把前情内容当作本集剧本去改写、提取或拆分镜，除非本集内容本身涉及。',
    omitted: '（更早的剧集已省略）',
  },
  en: {
    title: 'Previously on',
    episode: (n, title) => `Episode ${n}: ${title}`,
    note: 'Summaries of the preceding episodes (in order), provided only for continuity: character identities, relationships, injuries, outfit changes and revealed secrets must stay consistent with them. Do not rewrite, extract or storyboard the recap itself unless the current episode involves it.',
    omitted: '(Earlier episodes omitted)',
  },
  ja: {
    title: '前回までのあらすじ',
    episode: (n, title) => `第${n}話「${title}」`,
    note: '以下はこの話より前の各話のあらすじ（話数順）で、人物の呼び名・関係・怪我・衣装の変化・明かされた秘密などの連続性を保つためだけのものです。この話の内容が関係しない限り、あらすじ自体を書き直し・抽出・分割しないでください。',
    omitted: '（それ以前の話は省略）',
  },
  ko: {
    title: '지난 줄거리',
    episode: (n, title) => `${n}화 「${title}」`,
    note: '아래는 이번 화 이전 각 화의 줄거리 요약(화 순서)으로, 인물의 호칭·관계·부상·의상 변화·드러난 비밀 등의 연속성을 유지하기 위한 것입니다. 이번 화 내용과 관련되지 않는 한 요약 자체를 각색·추출·콘티 분할하지 마세요.',
    omitted: '(더 이전 화는 생략)',
  },
}

/**
 * 为某集拼「前情提要」instructions 块：补齐前几集摘要 → 从最近一集往前按预算放入。
 * 没有前集或都没有摘要时返回空串（第 1 集零开销）
 */
export async function buildRecapBlock(episodeId: number, opts: SummaryOptions = {}): Promise<string> {
  const allPrev = await previousEpisodes(episodeId, Infinity)
  const prev = allPrev.slice(-RECAP_MAX_EPISODES)
  if (!prev.length) return ''
  await ensureSummaries(prev, opts)
  const ids = new Set(prev.map(e => e.id))
  const fresh = (await db.select().from(schema.episodes).where(isNull(schema.episodes.deletedAt)))
    .filter(e => ids.has(e.id) && e.summary)
    .sort((a, b) => a.episodeNumber - b.episodeNumber)
  if (!fresh.length) return ''

  const h = RECAP_HEADINGS[opts.language || 'zh'] || RECAP_HEADINGS.zh
  const parts: string[] = []
  let used = 0
  for (let i = fresh.length - 1; i >= 0; i--) {
    const ep = fresh[i]
    const body = ep.summary!.length > SUMMARY_CHAR_MAX ? `${ep.summary!.slice(0, SUMMARY_CHAR_MAX)}…` : ep.summary!
    const part = `### ${h.episode(ep.episodeNumber, ep.title)}\n${body}`
    if (parts.length && used + part.length > RECAP_CHAR_BUDGET) break
    parts.unshift(part)
    used += part.length
  }
  const omitted = parts.length < allPrev.length ? h.omitted : ''
  return [`## ${h.title}`, h.note, omitted, ...parts].filter(Boolean).join('\n\n')
}
