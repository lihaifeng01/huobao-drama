/**
 * 视频提示词统一约束 — 提交视频生成前在开头加上「不要带字幕」
 *
 * 提示词里带「角色名说：「台词」」时，视频模型常把台词烧成画面字幕；字幕由「字幕制作」步骤统一压制，
 * 模型自带的字幕会与之重叠且无法去除。放在提交环节而不是只改 SKILL.md：
 * 已安装用户的 workspace 技能不会被模板覆盖，镜头上已保存的提示词也不会重新生成。
 * 只禁止字幕，场景里本来就有的文字（招牌、屏幕等）不受影响。
 * 放在最前面：实测放在末尾时模型常忽略，放在开头的短句「注意：不要带字幕。」有效。
 */
import { getContentLanguage, type ContentLanguage } from './app-settings.js'

const NO_SUBTITLE_DIRECTIVE: Record<ContentLanguage, string> = {
  zh: '注意：不要带字幕。',
  en: 'Note: no subtitles.',
  ja: '注意：字幕を入れないこと。',
  ko: '주의: 자막을 넣지 마세요.',
}

export function withNoSubtitleDirective(prompt: string | undefined, lang: ContentLanguage = getContentLanguage()): string {
  const text = (prompt || '').trimEnd()
  const directive = NO_SUBTITLE_DIRECTIVE[lang] || NO_SUBTITLE_DIRECTIVE.zh
  if (!text) return text
  if (Object.values(NO_SUBTITLE_DIRECTIVE).some(d => text.includes(d))) return text
  return `${directive}\n${text}`
}
