import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getVideoAdapter } from '../src/services/adapters/registry'
import { normalizeCustomOptions } from '../src/services/adapters/custom'

const custom = normalizeCustomOptions({
  generate_url: 'https://gptrouter.cn/v1/video/generations',
  auth_scheme: 'raw',
  body_template: {
    model: '{{model}}',
    prompt: '{{prompt}}',
    generate_audio: '{{generate_audio|true}}',
    resolution: '{{resolution|480p}}',
    ratio: '{{ratio|16:9}}',
    duration: '{{duration|5}}',
    watermark: false,
    images: '{{reference_images}}',
    image: '{{first_frame}}',
  },
})!

const config = {
  provider: 'aliyun',
  baseUrl: 'https://gptrouter.cn',
  apiKey: 'sk-test',
  model: 'doubao-seedance-1-5-pro-251215',
  custom,
}

test('custom URL is used verbatim and body follows the template', () => {
  const adapter = getVideoAdapter('aliyun', config)
  const req = adapter.buildGenerateRequest(config, {
    id: 1,
    prompt: 'hello',
    duration: 8,
    referenceImageUrls: JSON.stringify(['https://a/1.png']),
  })
  assert.equal(req.url, 'https://gptrouter.cn/v1/video/generations')
  assert.equal(req.headers.Authorization, 'sk-test')
  assert.deepEqual(req.body, {
    model: 'doubao-seedance-1-5-pro-251215',
    prompt: 'hello',
    generate_audio: true,
    resolution: '480p',
    ratio: '16:9',
    duration: 8,
    watermark: false,
    images: ['https://a/1.png'],
  })
})

test('poll URL defaults to generate_url/{task_id} and generic parsing works', () => {
  const adapter = getVideoAdapter('aliyun', config)
  assert.equal(adapter.buildPollRequest(config, 'abc').url, 'https://gptrouter.cn/v1/video/generations/abc')
  assert.deepEqual(adapter.parseGenerateResponse({ task_id: 't1' }), { isAsync: true, taskId: 't1' })
  assert.deepEqual(
    adapter.parsePollResponse({ status: 'succeeded', url: 'https://v/1.mp4' }),
    { status: 'completed', videoUrl: 'https://v/1.mp4' },
  )
  assert.equal(adapter.parsePollResponse({ status: 'failed', error: { message: 'bad' } }).status, 'failed')
  assert.equal(adapter.parsePollResponse({ status: 'running' }).status, 'processing')
})

test('without custom the official adapter is returned unchanged', () => {
  assert.equal(getVideoAdapter('aliyun').provider, 'aliyun')
  assert.equal(getVideoAdapter('aliyun', { custom: null }), getVideoAdapter('aliyun'))
})

test('extra_body merges and null removes fields; invalid input is rejected', () => {
  const c = normalizeCustomOptions({ extra_body: { camera_fixed: true, watermark: null } })!
  const cfg = { ...config, provider: 'volcengine', model: 'doubao-seedance-2-0-260128', custom: c }
  const req = getVideoAdapter('volcengine', cfg).buildGenerateRequest(cfg, { id: 1, prompt: 'x' })
  assert.equal((req.body as any).camera_fixed, true)
  assert.equal('watermark' in (req.body as any), false)
  assert.throws(() => normalizeCustomOptions({ generate_url: 'ftp://x' }))
  assert.throws(() => normalizeCustomOptions({ body_template: { a: 1 } }))
  assert.throws(() => normalizeCustomOptions({ headers: { 'bad name': 'x' } }))
})
