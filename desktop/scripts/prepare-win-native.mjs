/**
 * Windows 包的原生依赖准备（npm run dist:win 时由 prepare-resources.mjs --win 调用）
 *
 * 在 mac 上交叉打 win 包时，npm 只装宿主机平台的原生依赖，下面三样需要另外准备，
 * 缺什么下载什么，下载结果缓存在 desktop/build/ 下，之后打包直接复用：
 *
 * 1. ffmpeg.exe        → build/win-bin/ffmpeg.exe（ffmpeg-static 对应版本的官方发布产物；
 *                         ffprobe.exe 仍取 ffprobe-static 包内自带的 win32 版本）
 * 2. better_sqlite3.node → build/win-bin/better_sqlite3.node（after-pack.mjs 用它替换包里的 mac 版）
 *                         版本按已安装的 better-sqlite3 与 Electron ABI 推导，升级后自动换新
 * 3. @img/sharp-win32-x64 → node_modules/@img/sharp-win32-x64（npm 因 os 限制在 mac 上会跳过它）
 *
 * 下载用 curl，会读取 https_proxy 环境变量；连不上 GitHub 时按报错提示手动下载放到对应路径即可。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { createGunzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { assertWindowsX64 } from './validate-windows-package.mjs'

const run = promisify(execFile)
const require = createRequire(import.meta.url)

async function download(url, output, hint) {
  try {
    await run('curl', ['--fail', '--location', '--silent', '--show-error', '--retry', '3',
      '--connect-timeout', '15', '--max-time', '600', '--output', output, url])
  } catch (err) {
    fs.rmSync(output, { force: true })
    throw new Error(`下载失败：${url}\n${String(err.stderr || err.message).trim()}\n` +
      `连不上 GitHub 时可以先 export https_proxy=<代理地址> 再重试，或手动下载后${hint}`)
  }
}

/** ffmpeg.exe：已有就复用（兼容以前手动放进去的版本），没有就按 ffmpeg-static 的发布版本下载 */
async function ensureFfmpeg(winBin) {
  const target = path.join(winBin, 'ffmpeg.exe')
  if (fs.existsSync(target)) {
    assertWindowsX64(target)
    return target
  }
  const release = require('ffmpeg-static/package.json')['ffmpeg-static']['binary-release-tag']
  const url = `https://github.com/eugeneware/ffmpeg-static/releases/download/${release}/ffmpeg-win32-x64.gz`
  const archive = `${target}.gz.part`
  const temporary = `${target}.part`
  console.log(`[win-native] downloading ffmpeg.exe (${release})`)
  try {
    await download(url, archive, `解压（gunzip）并改名为 ${target}`)
    await pipeline(fs.createReadStream(archive), createGunzip(), fs.createWriteStream(temporary))
    assertWindowsX64(temporary)
    fs.renameSync(temporary, target)
  } finally {
    fs.rmSync(archive, { force: true })
    fs.rmSync(temporary, { force: true })
  }
  return target
}

/** better-sqlite3 的 Electron win32-x64 预编译：按版本 + ABI 缓存，并校验确实是该 ABI 的 Windows x64 模块 */
async function ensureSqlite(winBin) {
  const { getAbi } = require('node-abi')
  const version = require('better-sqlite3/package.json').version
  const electron = require('electron/package.json').version
  const abi = getAbi(electron, 'electron')
  const name = `better-sqlite3-v${version}-electron-v${abi}-win32-x64`
  const cached = path.join(winBin, `${name}.node`)
  const check = file => {
    const bytes = assertWindowsX64(file)
    if (!bytes.includes(Buffer.from(`node_register_module_v${abi}\0`))) {
      throw new Error(`${file} 不是 Electron ${electron}（ABI ${abi}）的 better-sqlite3 模块`)
    }
  }
  if (!fs.existsSync(cached)) {
    const url = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${version}/${name}.tar.gz`
    const work = fs.mkdtempSync(path.join(winBin, '.sqlite-'))
    console.log(`[win-native] downloading ${name}`)
    try {
      const archive = path.join(work, 'prebuilt.tar.gz')
      await download(url, archive, `解出 build/Release/better_sqlite3.node 放到 ${cached}`)
      await run('tar', ['-xzf', archive, '-C', work, 'build/Release/better_sqlite3.node'])
      const extracted = path.join(work, 'build', 'Release', 'better_sqlite3.node')
      check(extracted)
      fs.renameSync(extracted, cached)
    } finally {
      fs.rmSync(work, { recursive: true, force: true })
    }
  }
  check(cached)
  // after-pack.mjs 读取的固定路径
  fs.copyFileSync(cached, path.join(winBin, 'better_sqlite3.node'))
  console.log(`[win-native] better_sqlite3.node (v${version}, ABI ${abi}) ✓`)
}

/** sharp 的 win32-x64 原生包：版本取 sharp 的 optionalDependencies，与 mac 交叉打包的做法一致 */
async function ensureSharp(desktop) {
  const pkg = '@img/sharp-win32-x64'
  const version = require('sharp/package.json').optionalDependencies[pkg]
  const destination = path.join(desktop, 'node_modules', '@img', 'sharp-win32-x64')
  const installed = path.join(destination, 'package.json')
  if (fs.existsSync(installed) && JSON.parse(fs.readFileSync(installed, 'utf8')).version === version) {
    console.log(`[win-native] ${pkg}@${version} ✓`)
    return
  }
  const cache = path.join(desktop, 'build', 'win-native')
  fs.mkdirSync(cache, { recursive: true })
  console.log(`[win-native] fetching ${pkg}@${version}`)
  const { stdout } = await run('npm', ['pack', `${pkg}@${version}`, '--ignore-scripts', '--json',
    '--registry=https://registry.npmjs.org', '--pack-destination', cache])
  const [{ filename }] = JSON.parse(stdout)
  fs.rmSync(destination, { recursive: true, force: true })
  fs.mkdirSync(destination, { recursive: true })
  await run('tar', ['-xzf', path.join(cache, filename), '--strip-components=1', '-C', destination])
  assertWindowsX64(path.join(destination, 'lib', 'sharp-win32-x64.node'))
  console.log(`[win-native] ${pkg}@${version} ✓`)
}

export async function prepareWinNative(desktop, resources) {
  const winBin = path.join(desktop, 'build', 'win-bin')
  fs.mkdirSync(winBin, { recursive: true })
  const ffmpeg = await ensureFfmpeg(winBin)
  await ensureSqlite(winBin)
  await ensureSharp(desktop)

  const ffprobe = path.join(path.dirname(require.resolve('ffprobe-static/package.json')), 'bin', 'win32', 'x64', 'ffprobe.exe')
  assertWindowsX64(ffprobe)
  const dest = path.join(resources, 'bin-win-x64')
  fs.mkdirSync(dest, { recursive: true })
  fs.copyFileSync(ffmpeg, path.join(dest, 'ffmpeg.exe'))
  fs.copyFileSync(ffprobe, path.join(dest, 'ffprobe.exe'))
  console.log('resources/bin-win-x64 ✓')
}
