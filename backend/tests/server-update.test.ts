import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkServerUpdate, getServerUpdateState } from '../src/services/server-update.js'

test('update check compares the running version against the release feed', async () => {
  const originalVersion = process.env.HUOBAO_VERSION
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ version: '4.1.5' }), {
      headers: { 'content-type': 'application/json' },
    })

    process.env.HUOBAO_VERSION = 'v4.1.5'
    assert.equal(getServerUpdateState().currentVersion, '4.1.5')
    assert.equal((await checkServerUpdate()).status, 'up-to-date')

    process.env.HUOBAO_VERSION = '4.1.0'
    const update = await checkServerUpdate()
    assert.equal(update.currentVersion, '4.1.0')
    assert.equal(update.latestVersion, '4.1.5')
    assert.equal(update.status, 'available')
  } finally {
    if (originalVersion === undefined) delete process.env.HUOBAO_VERSION
    else process.env.HUOBAO_VERSION = originalVersion
    globalThis.fetch = originalFetch
  }
})
