/**
 * /api/v1 路由表 + 鉴权中间件（index.ts 挂载；测试直接 import 这个 app 走完整鉴权链）
 */
import { Hono } from 'hono'
import dramas from './routes/dramas.js'
import episodes from './routes/episodes.js'
import storyboards from './routes/storyboards.js'
import scenes from './routes/scenes.js'
import characters from './routes/characters.js'
import characterLooks from './routes/characterLooks.js'
import tasks from './routes/tasks.js'
import upload from './routes/upload.js'
import aiConfigs, { aiProviders } from './routes/aiConfigs.js'
import stylePresets from './routes/stylePresets.js'
import prompts from './routes/prompts.js'
import agent from './routes/agent.js'
import merge from './routes/merge.js'
import skills from './routes/skills.js'
import props from './routes/props.js'
import settings from './routes/settings.js'
import storage from './routes/storage.js'
import serverUpdate from './routes/serverUpdate.js'
import library from './routes/library.js'
import subtitles from './routes/subtitles.js'
import tools from './routes/tools.js'
import auth from './routes/auth.js'
import users from './routes/users.js'
import usage from './routes/usage.js'
import { authGuard, settingsGuard, projectGuard } from './middleware/auth.js'

const api = new Hono()
// 鉴权顺序：登录 → 设置类接口仅管理员 → 项目成员校验
api.use('*', authGuard)
api.use('*', settingsGuard)
api.use('*', projectGuard)
api.route('/auth', auth)
api.route('/users', users)
api.route('/usage', usage)
api.route('/dramas', dramas)
api.route('/episodes', episodes)
api.route('/storyboards', storyboards)
api.route('/scenes', scenes)
api.route('/characters', characters)
api.route('/character-looks', characterLooks)
api.route('/tasks', tasks)
api.route('/upload', upload)
api.route('/ai-configs', aiConfigs)
api.route('/ai-providers', aiProviders)
api.route('/style-presets', stylePresets)
api.route('/prompts', prompts)
api.route('/agent', agent)
api.route('/merge', merge)
api.route('/skills', skills)
api.route('/props', props)
api.route('/storage', storage)
api.route('/settings', settings)
api.route('/server-update', serverUpdate)
api.route('/library', library)
api.route('/subtitles', subtitles)
api.route('/tools', tools)

export default api
