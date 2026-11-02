import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activeMentionAt, mentionToken, highlightMentions, mentionDeletionRange, findInvalidVoiceMentions } from '../app/utils/prompt-mentions.js'

const options = [
  { value: '小雨', kind: 'character' },
  { value: '小雨', aliases: ['小雨音色'], trigger: '#', kind: 'voice' },
  { value: '小雨姐姐', aliases: ['小雨姐姐音色'], trigger: '#', kind: 'voice' },
  { value: 'A&B<', trigger: '#', kind: 'voice' },
]

test('image and voice triggers stay independent, including adjacent references', () => {
  assert.deepEqual(activeMentionAt('@小雨#小', 5), { start: 3, trigger: '#', query: '小' })
  assert.deepEqual(activeMentionAt('场景 @', 4), { start: 3, trigger: '@', query: '' })
  assert.equal(activeMentionAt('#小雨音色 台词', 8), null)
  assert.equal(mentionToken(options[0]), '@小雨')
  assert.equal(mentionToken(options[1]), '#小雨')
})

test('highlighting preserves literal text, safely escapes HTML, and prefers complete names', () => {
  const html = highlightMentions('@小雨抬头，#小雨姐姐轻声说，#A&B<回应 <script>\n', options)
  assert.match(html, /mention-token-role">@小雨<\/span>/)
  assert.match(html, /mention-token-voice">#小雨姐姐<\/span>轻声说/)
  assert.match(html, /mention-token-voice">#A&amp;B&lt;<\/span>回应/)
  assert.match(html, /&lt;script&gt;\n\u200b$/)
  assert.equal(highlightMentions('#未知音色', options), '#未知音色')
})

test('Backspace and Delete remove whole voice tokens without consuming surrounding text', () => {
  const text = '@小雨#小雨轻声说话'
  assert.deepEqual(mentionDeletionRange(text, 6, options, true), { start: 3, end: 6 })
  assert.deepEqual(mentionDeletionRange(text, 3, options, false), { start: 3, end: 6 })
  assert.equal(mentionDeletionRange(text, 5, options, true), null)
  assert.deepEqual(mentionDeletionRange(text, 3, options, true), { start: 0, end: 3 })
})

test('typing dialogue immediately after a voice name keeps the menu closed; longer names can still be searched', () => {
  const speech = '#小雨轻声说'
  assert.equal(activeMentionAt(speech, speech.length, options), null)
  assert.deepEqual(activeMentionAt('#小雨姐', 4, options), { start: 0, trigger: '#', query: '小雨姐' })
})

test('previously saved suffix tokens are highlighted and deleted as one mention', () => {
  assert.match(highlightMentions('#小雨音色说话', options), /mention-token-voice">#小雨音色<\/span>说话/)
  assert.deepEqual(mentionDeletionRange('#小雨音色说话', 5, options, true), { start: 0, end: 5 })
})

test('voice check flags #references the backend would reject, without touching valid ones', () => {
  const shot = [
    { value: '林晚', kind: 'character' },
    { value: '小林晚', kind: 'character' },
    { value: '林晚', aliases: ['林晚音色'], trigger: '#', kind: 'voice' },
  ]
  const text = '@小林晚急切说；#林晚说：“你是谁？”\n#小林晚说：“我是来救你的。”#路人甲喊 #01 镜头 #小林晚说'
  const found = findInvalidVoiceMentions(text, shot)
  assert.deepEqual(found.map(f => [f.token, f.reason]), [['#小林晚', 'no_voice'], ['#路人甲喊', 'unknown'], ['#小林晚', 'no_voice']])
  assert.equal(text.slice(found[0].start, found[0].end), '#小林晚')

  const html = highlightMentions(text, shot, { checkVoices: true })
  assert.match(html, /mention-token-voice">#林晚<\/span>说/)
  assert.match(html, /mention-token-invalid">#小林晚<\/span>说/)
  assert.match(html, /mention-token-invalid">#路人甲喊<\/span>/)
  assert.doesNotMatch(html, /#01<\/span>/)
  // 默认不检查，保持原行为
  assert.doesNotMatch(highlightMentions(text, shot), /invalid/)
})

test('voice-check i18n messages exist in every locale and avoid raw @', async () => {
  const { readFileSync } = await import('node:fs')
  for (const lang of ['zh', 'en', 'ja', 'ko']) {
    const cv = JSON.parse(readFileSync(new URL(`../app/locales/${lang}.json`, import.meta.url), 'utf8')).characterVoice
    for (const key of ['invalidNoVoice', 'invalidUnknown']) {
      assert.ok(cv[key], `${lang}.${key}`)
      assert.doesNotMatch(cv[key].replaceAll("{'@'}", ''), /@/)
    }
  }
})
