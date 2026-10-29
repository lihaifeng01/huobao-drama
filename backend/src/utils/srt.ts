/**
 * 识别结果 → SRT 字幕
 *
 * 识别返回的是句级时间戳，一句可能很长；按显示宽度把长句切成多条字幕，
 * 有字级时间戳时按字切（时间准确），没有时按标点切并按字数分配时长。
 */
import type { AsrSentence, AsrWord } from '../services/adapters/aliyun-asr.js'

export interface SrtCue {
  start: number
  end: number
  text: string
}

const BREAK_PUNCT = /[，。！？；、,.!?;…]/
// 字幕习惯：句末的逗号、句号等去掉，问号叹号保留
const TRAILING_PUNCT = /[，。、；,.;：:\s]+$/

/** 显示宽度：中日韩等全角字符算 1，ASCII 算 0.5 */
export function displayWidth(text: string) {
  let w = 0
  for (const ch of text) w += ch.charCodeAt(0) < 0x2e80 ? 0.5 : 1
  return w
}

function cleanText(text: string) {
  return text.replace(TRAILING_PUNCT, '').trim()
}

function splitByWords(words: AsrWord[], maxWidth: number): SrtCue[] {
  const cues: SrtCue[] = []
  let cur: AsrWord[] = []
  const flush = () => {
    if (!cur.length) return
    const text = cleanText(cur.map(w => `${w.text}${w.punctuation || ''}`).join(''))
    if (text) cues.push({ start: cur[0].begin_time, end: cur[cur.length - 1].end_time, text })
    cur = []
  }
  for (const w of words) {
    cur.push(w)
    const width = displayWidth(cur.map(x => `${x.text}${x.punctuation || ''}`).join(''))
    const atPunct = BREAK_PUNCT.test(w.punctuation || '') || BREAK_PUNCT.test(w.text.slice(-1))
    if (width >= maxWidth || (atPunct && width >= maxWidth * 0.4)) flush()
  }
  flush()
  // 末尾只剩一两个字时并回上一条（允许略超上限），不单独闪一下
  const last = cues[cues.length - 1]
  const prev = cues[cues.length - 2]
  if (last && prev && displayWidth(last.text) < maxWidth * 0.3 && displayWidth(prev.text + last.text) <= maxWidth * 1.3) {
    cues.splice(-2, 2, { start: prev.start, end: last.end, text: prev.text + last.text })
  }
  return cues
}

function splitByText(s: AsrSentence, maxWidth: number): SrtCue[] {
  // 先按标点断开，再把超长片段硬切
  const pieces: string[] = []
  for (const part of s.text.split(/(?<=[，。！？；、,.!?;…])/)) {
    // 超长片段均分成几行，避免按上限硬切后剩下一两个字的尾巴
    const lines = Math.ceil(displayWidth(part) / maxWidth)
    const target = displayWidth(part) / lines
    let rest = part
    for (let n = lines; n > 1; n--) {
      let cut = 0
      let w = 0
      for (const ch of rest) {
        if (w + displayWidth(ch) > target + 0.25) break
        w += displayWidth(ch)
        cut += ch.length
      }
      pieces.push(rest.slice(0, cut))
      rest = rest.slice(cut)
    }
    if (rest) pieces.push(rest)
  }
  // 太短的碎片并入前一条
  const merged: string[] = []
  for (const p of pieces) {
    const last = merged[merged.length - 1]
    if (last && displayWidth(last + p) <= maxWidth && displayWidth(p) < maxWidth * 0.4) merged[merged.length - 1] = last + p
    else merged.push(p)
  }
  const total = merged.reduce((n, p) => n + Math.max(displayWidth(p), 0.5), 0)
  const span = Math.max(s.end_time - s.begin_time, 0)
  const cues: SrtCue[] = []
  let t = s.begin_time
  for (const p of merged) {
    const d = span * Math.max(displayWidth(p), 0.5) / total
    const text = cleanText(p)
    if (text) cues.push({ start: Math.round(t), end: Math.round(t + d), text })
    t += d
  }
  return cues
}

export function sentencesToCues(sentences: AsrSentence[], maxWidth = 16): SrtCue[] {
  const cues: SrtCue[] = []
  for (const s of sentences) {
    if (displayWidth(s.text) <= maxWidth) {
      const text = cleanText(s.text)
      if (text) cues.push({ start: s.begin_time, end: s.end_time, text })
    } else if (s.words?.length) {
      cues.push(...splitByWords(s.words, maxWidth))
    } else {
      cues.push(...splitByText(s, maxWidth))
    }
  }
  return cues.filter(c => c.end > c.start)
}

function pad(n: number, len = 2) {
  return String(n).padStart(len, '0')
}

export function formatSrtTime(ms: number) {
  const v = Math.max(0, Math.round(ms))
  const h = Math.floor(v / 3_600_000)
  const m = Math.floor(v / 60_000) % 60
  const s = Math.floor(v / 1000) % 60
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(v % 1000, 3)}`
}

export function cuesToSrt(cues: SrtCue[]) {
  return cues.map((c, i) => `${i + 1}\n${formatSrtTime(c.start)} --> ${formatSrtTime(c.end)}\n${c.text}\n`).join('\n')
}

export function parseSrt(content: string): SrtCue[] {
  const cues: SrtCue[] = []
  const toMs = (t: string) => {
    const m = t.trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/)
    return m ? ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + +m[4] : 0
  }
  for (const block of content.replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.trim().split('\n')
    const timeIdx = lines.findIndex(l => l.includes('-->'))
    if (timeIdx < 0) continue
    const [a, b] = lines[timeIdx].split('-->')
    const text = lines.slice(timeIdx + 1).join('\n').trim()
    if (text) cues.push({ start: toMs(a), end: toMs(b), text })
  }
  return cues
}
