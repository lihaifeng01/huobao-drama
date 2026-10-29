/**
 * 字幕条目 → ASS 字幕（字幕工具的自定义样式压制用）
 *
 * SRT 交给 libass 渲染时以 384x288 为坐标基准，字号与边距不直观。这里按视频实际分辨率设 PlayRes，
 * 字号、距底边距离都以视频像素计，前端预览按同一比例缩放即可与成片一致。
 */
import type { SrtCue } from './srt.js'

export interface SubtitleStyle {
  /** 字号，视频像素 */
  fontSize: number
  /** 字幕底边距离画面底部的高度，占画面高度的百分比（0 = 贴底） */
  bottomPercent: number
}

export function defaultSubtitleStyle(width: number, height: number): SubtitleStyle {
  // 竖屏画面窄，按宽度取字号，避免一行放不下
  const base = height > width ? width * 0.055 : height * 0.06
  return { fontSize: Math.max(12, Math.round(base)), bottomPercent: height > width ? 12 : 6 }
}

export function normalizeSubtitleStyle(input: any, width: number, height: number): SubtitleStyle {
  const def = defaultSubtitleStyle(width, height)
  const fontSize = Math.round(Number(input?.font_size ?? input?.fontSize))
  const bottomPercent = Number(input?.bottom_percent ?? input?.bottomPercent)
  return {
    fontSize: Number.isFinite(fontSize) ? Math.min(Math.max(fontSize, 8), Math.max(16, Math.round(height / 4))) : def.fontSize,
    bottomPercent: Number.isFinite(bottomPercent) ? Math.min(Math.max(bottomPercent, 0), 90) : def.bottomPercent,
  }
}

function assTime(ms: number) {
  const cs = Math.max(0, Math.round(ms / 10))
  const h = Math.floor(cs / 360000)
  const m = Math.floor(cs / 6000) % 60
  const s = Math.floor(cs / 100) % 60
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`
}

/** 花括号在 ASS 里是样式覆盖标记，替换为全角避免被吞掉 */
function assText(text: string) {
  return text.replace(/\{/g, '｛').replace(/\}/g, '｝').replace(/\r?\n/g, '\\N')
}

export function cuesToAss(cues: SrtCue[], opt: { width: number; height: number; fontName: string; style: SubtitleStyle }) {
  const { width, height, fontName, style } = opt
  const outline = Math.max(1, Math.round(style.fontSize * 0.07))
  const marginV = Math.round(height * style.bottomPercent / 100)
  const marginH = Math.round(width * 0.05)
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${fontName},${style.fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,${outline},0,2,${marginH},${marginH},${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...cues.map(c => `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Default,,0,0,0,,${assText(c.text)}`),
    '',
  ].join('\n')
}
