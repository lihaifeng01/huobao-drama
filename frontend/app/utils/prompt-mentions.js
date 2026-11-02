export const mentionToken = option => `${option.trigger || '@'}${option.value}`

export function mentionEntries(options) {
  const seen = new Map()
  for (const option of options) {
    const token = mentionToken(option)
    if (option.value && !seen.has(token)) {
      seen.set(token, option.kind === 'voice' ? 'voice' : option.kind === 'scene' ? 'scene' : 'role')
    }
  }
  // Legacy saved voice tokens remain highlighted/deletable; new insertions use #Name.
  for (const option of options) {
    for (const alias of option.aliases || []) {
      const token = `${option.trigger || '@'}${alias}`
      if (!seen.has(token)) seen.set(token, option.kind === 'voice' ? 'voice' : 'role')
    }
  }
  return [...seen.entries()].sort((a, b) => b[0].length - a[0].length)
}

export function activeMentionAt(text, position, options) {
  const match = text.slice(0, position).match(/([@#])([^\s@#]{0,100})$/)
  // Chinese dialogue follows a token without spaces: #林小雨轻声说. Do not reopen
  // the dropdown while typing the dialogue, but allow searching for a longer name.
  if (match && options && mentionEntries(options).some(([token]) => match[0].startsWith(token)) &&
      !options.some(option => (option.trigger || '@') === match[1] && String(option.value).toLowerCase().includes(match[2].toLowerCase()))) return null
  return match ? { start: position - match[0].length, trigger: match[1], query: match[2] } : null
}

const escapeHtml = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// 与后端 character-voice-references.ts 的 voiceToken 保持一致：#后面直到空白或标点
const VOICE_TOKEN = /#[^\s#@，。！？；、：,.!?;:「」“”"'（）()[\]{}<>]{1,100}/gu

/**
 * 找出生成时后端会拒绝的 #音色引用，写的时候就提示，不必等到生成报错。
 * - no_voice：当前分镜绑定了这个角色，但角色没上传音色（没上传的角色不在 # 候选里，原本显示成普通文字）
 * - unknown：#后面不是当前分镜绑定的角色
 * #01 这类纯数字镜头编号不算音色引用（与后端一致）。
 */
export function findInvalidVoiceMentions(text, options) {
  const valid = mentionEntries(options).filter(([token]) => token.startsWith('#')).map(([token]) => token)
  const characters = [...new Set(options.filter(o => o.kind === 'character' && o.value).map(o => String(o.value)))]
    .sort((a, b) => b.length - a.length)
  const result = []
  for (let pos = text.indexOf('#'); pos >= 0; pos = text.indexOf('#', pos + 1)) {
    const tail = text.slice(pos)
    const ok = valid.find(token => tail.startsWith(token))
    if (ok) { pos += ok.length - 1; continue }
    const name = characters.find(n => tail.startsWith(`#${n}`))
    if (name) {
      result.push({ start: pos, end: pos + name.length + 1, token: `#${name}`, name, reason: 'no_voice' })
      pos += name.length
      continue
    }
    VOICE_TOKEN.lastIndex = 0
    const m = VOICE_TOKEN.exec(tail)
    if (m && m.index === 0 && !/^#\d+$/.test(m[0])) {
      result.push({ start: pos, end: pos + m[0].length, token: m[0], name: m[0].slice(1), reason: 'unknown' })
      pos += m[0].length - 1
    }
  }
  return result
}

export function highlightMentions(text, options, { checkVoices = false } = {}) {
  const entries = mentionEntries(options)
  const ranges = []
  if (entries.length) {
    const pattern = new RegExp(entries.map(([token]) => escapeRegExp(token)).join('|'), 'g')
    const styles = new Map(entries)
    for (const match of text.matchAll(pattern)) {
      ranges.push({ start: match.index, end: match.index + match[0].length, cls: styles.get(match[0]) })
    }
  }
  if (checkVoices) {
    for (const bad of findInvalidVoiceMentions(text, options)) {
      // 有效引用优先；与已着色区间重叠的不再标红
      if (!ranges.some(r => r.start < bad.end && bad.start < r.end)) ranges.push({ start: bad.start, end: bad.end, cls: 'invalid' })
    }
    ranges.sort((a, b) => a.start - b.start)
  }
  let html = '', start = 0
  for (const r of ranges) {
    html += escapeHtml(text.slice(start, r.start))
    html += `<span class="mention-token mention-token-${r.cls}">${escapeHtml(text.slice(r.start, r.end))}</span>`
    start = r.end
  }
  return html + escapeHtml(text.slice(start)) + (text.endsWith('\n') ? '\u200b' : '')
}

export function mentionDeletionRange(text, position, options, backwards) {
  for (const [token] of mentionEntries(options)) {
    if (backwards && text.slice(0, position).endsWith(token)) return { start: position - token.length, end: position }
    if (!backwards && text.slice(position).startsWith(token)) return { start: position, end: position + token.length }
  }
  return null
}
