import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../..', import.meta.url))
const entrypoint = readFileSync(path.join(repo, 'docker/entrypoint.sh'), 'utf8')
const releaseVersion = JSON.parse(readFileSync(path.join(repo, 'desktop/package.json'), 'utf8')).version

test('Docker entrypoint defaults to the packaged release version and honors overrides', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'huobao-docker-version-'))
  try {
    mkdirSync(path.join(root, 'backend/node_modules/.bin'), { recursive: true })
    mkdirSync(path.join(root, 'workspace-template'), { recursive: true })
    writeFileSync(path.join(root, 'workspace-template/template.txt'), 'template')
    writeFileSync(path.join(root, 'version.json'), JSON.stringify({ version: releaseVersion }))
    writeFileSync(path.join(root, 'backend/node_modules/.bin/tsx'), '#!/bin/sh\nprintf "%s" "$HUOBAO_VERSION"\n', { mode: 0o755 })

    const script = entrypoint.replaceAll('/app/', `${root}/`)
    const run = (version) => {
      const env = { ...process.env }
      if (version === undefined) delete env.HUOBAO_VERSION
      else env.HUOBAO_VERSION = version
      return spawnSync('sh', [], { input: script, env, encoding: 'utf8' })
    }

    for (const version of [undefined, '']) {
      const result = run(version)
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stdout, releaseVersion)
    }
    assert.equal(readFileSync(path.join(root, 'data/workspace/template.txt'), 'utf8'), 'template')
    const explicit = run('4.1.0')
    assert.equal(explicit.status, 0, explicit.stderr)
    assert.equal(explicit.stdout, '4.1.0')

    writeFileSync(path.join(root, 'version.json'), '{}')
    const invalid = run(undefined)
    assert.notEqual(invalid.status, 0)
    assert.match(invalid.stderr, /Invalid application version/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
