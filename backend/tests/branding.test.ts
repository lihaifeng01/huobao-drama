import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// Isolated DB/storage; never read or modify user data.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-branding-'))
process.env.SQLITE_PATH = path.join(root, 'branding.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
process.env.HUOBAO_AUTH_MODE = 'login'
await import('../src/db/index.ts')
const { Hono } = await import('hono')
const api = new Hono().route('/api/v1', (await import('../src/api.ts')).default)

function client() {
  let cookie = ''
  return async (method: string, url: string, body?: any) => {
    const headers: Record<string, string> = {}
    if (cookie) headers.Cookie = cookie
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const res = await api.request(`/api/v1${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    const set = res.headers.get('set-cookie')
    if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0]
    return { status: res.status, json: await res.json() as any }
  }
}

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

test('branding: public read, super-admin-only write, validation and reset', async () => {
  const anon = client()
  const sa = client()
  const admin = client()
  const user = client()

  assert.equal((await sa('POST', '/auth/setup', { username: 'root', password: 'rootpass' })).status, 201)
  await admin('POST', '/auth/register', { username: 'adm', password: 'secret1' })
  await user('POST', '/auth/register', { username: 'usr', password: 'secret1' })
  const admId = (await admin('GET', '/auth/me')).json.data.id
  assert.equal((await sa('PUT', `/users/${admId}`, { role: 'admin' })).status, 200)

  // 未登录也能读默认值
  const initial = await anon('GET', '/settings/branding')
  assert.equal(initial.status, 200)
  assert.equal(initial.json.data.app_name, '')
  assert.equal(initial.json.data.corner_style, 'round')
  assert.equal(initial.json.data.show_github, true)

  const next = { app_name: '我的短剧', primary_color: '#2563EB', corner_style: 'soft', show_github: false, logo: PNG }
  // 未登录 401；普通用户、普通管理员 403
  assert.equal((await anon('PUT', '/settings/branding', next)).status, 401)
  assert.equal((await user('PUT', '/settings/branding', next)).status, 403)
  assert.equal((await admin('PUT', '/settings/branding', next)).status, 403)
  assert.equal((await admin('DELETE', '/settings/branding')).status, 403)

  // 超级管理员保存；颜色统一小写，未传字段取默认
  const saved = await sa('PUT', '/settings/branding', next)
  assert.equal(saved.status, 200)
  assert.equal(saved.json.data.primary_color, '#2563eb')
  assert.equal(saved.json.data.primary_color_dark, '')
  assert.equal(saved.json.data.logo, PNG)
  const read = (await user('GET', '/settings/branding')).json.data
  assert.equal(read.app_name, '我的短剧')
  assert.equal(read.show_github, false)

  // 非法值
  for (const bad of [
    { primary_color: 'red' },
    { primary_color_dark: '#12345' },
    { corner_style: 'circle' },
    { logo: 'https://example.com/a.png' },
    { favicon: 'data:text/html;base64,PHNjcmlwdD4=' },
    { logo: 'data:image/png;base64,' + 'A'.repeat(800_000) },
    { app_name: 'x'.repeat(41) },
  ]) {
    assert.equal((await sa('PUT', '/settings/branding', bad)).status, 400, JSON.stringify(bad).slice(0, 60))
  }

  // 恢复默认
  const reset = await sa('DELETE', '/settings/branding')
  assert.equal(reset.status, 200)
  assert.equal((await anon('GET', '/settings/branding')).json.data.app_name, '')
})
