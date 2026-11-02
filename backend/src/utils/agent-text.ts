import type Database from 'better-sqlite3'

/**
 * 模型常把换行双重转义，工具参数里收到的是字面的反斜杠 + n（显示为 "\n"），
 * 原样入库后既污染界面，又会原样发给视频/图片模型。保存前统一转成真正的换行。
 * 只转 \r\n、\n、\r；前面还有反斜杠（"\\n"，即有意写出的反斜杠）的不转。
 */
const LITERAL_NEWLINE = /(?<!\\)\\r\\n|(?<!\\)\\[nr]/g

export function fixLiteralNewlines(text: string): string {
  return text.includes('\\') ? text.replace(LITERAL_NEWLINE, '\n') : text
}

/** 深度处理对象 / 数组里的所有字符串（Agent 工具入参用），其它类型原样返回。 */
export function fixAgentText<T>(value: T): T {
  if (typeof value === 'string') return fixLiteralNewlines(value) as T
  if (Array.isArray(value)) return value.map(v => fixAgentText(v)) as T
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fixAgentText(v)])) as T
  }
  return value
}

/** 存量清理覆盖的列：Agent 会写入的文本字段（不含用户原始小说 episodes.content）。 */
export const AGENT_TEXT_COLUMNS: Record<string, string[]> = {
  storyboards: ['title', 'shot_type', 'angle', 'movement', 'location', 'time', 'description', 'result',
    'atmosphere', 'image_prompt', 'video_prompt', 'bgm_prompt', 'sound_effect'],
  episodes: ['script_content'],
  characters: ['role', 'description', 'appearance', 'styling', 'final_prompt'],
  scenes: ['location', 'time', 'prompt', 'description', 'lighting', 'final_prompt'],
  props: ['type', 'description', 'final_prompt'],
}

/**
 * 启动时清理存量数据里的字面 \n（幂等：清理过的行不再匹配 LIKE，之后每次启动只是一次空扫描）。
 * 不改 updated_at：这不是用户编辑，不应让分镜显示为「刚修改」。
 */
export function cleanLiteralNewlines(sqlite: Database.Database): number {
  let changed = 0
  const run = sqlite.transaction(() => {
    for (const [table, wanted] of Object.entries(AGENT_TEXT_COLUMNS)) {
      const existing = new Set((sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name))
      for (const column of wanted.filter(c => existing.has(c))) {
        const rows = sqlite.prepare(`SELECT id, ${column} AS v FROM ${table} WHERE ${column} LIKE '%\\n%' OR ${column} LIKE '%\\r%'`)
          .all() as { id: number; v: string }[]
        const update = sqlite.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`)
        for (const row of rows) {
          const next = fixLiteralNewlines(row.v)
          if (next !== row.v) { update.run(next, row.id); changed++ }
        }
      }
    }
  })
  run()
  return changed
}
