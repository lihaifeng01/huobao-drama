const BASE = '/api/v1'

async function req<T = any>(method: string, path: string, body?: any): Promise<T> {
  const opts: RequestInit = { method, headers: { 'Content-Type': 'application/json' } }
  if (body) opts.body = JSON.stringify(body)

  const start = performance.now()
  console.log(`%c[API] %c${method} %c${path}`, 'color:#888', 'color:#4fc3f7;font-weight:bold', 'color:#ccc', body || '')

  try {
    const resp = await fetch(`${BASE}${path}`, opts)
    const json = await resp.json()
    const ms = Math.round(performance.now() - start)

    if (!resp.ok || (json.code && json.code >= 400)) {
      console.log(`%c[API] %c${method} ${path} %c${resp.status} %c${ms}ms`, 'color:#888', 'color:#ef5350', 'color:#ef5350;font-weight:bold', 'color:#888', json.message || '')
      throw new Error(json.message || `${resp.status}`)
    }

    console.log(`%c[API] %c${method} ${path} %c${resp.status} %c${ms}ms`, 'color:#888', 'color:#66bb6a', 'color:#66bb6a;font-weight:bold', 'color:#888')
    return json.data ?? json
  } catch (err: any) {
    if (!err.message?.match(/^\d{3}$/)) {
      const ms = Math.round(performance.now() - start)
      console.log(`%c[API] %c${method} ${path} %cERROR %c${ms}ms`, 'color:#888', 'color:#ef5350', 'color:#ef5350;font-weight:bold', 'color:#888', err.message)
    }
    throw err
  }
}

export const api = {
  get: <T = any>(p: string) => req<T>('GET', p),
  post: <T = any>(p: string, b?: any) => req<T>('POST', p, b),
  put: <T = any>(p: string, b?: any) => req<T>('PUT', p, b),
  del: <T = any>(p: string) => req<T>('DELETE', p),
}

export const dramaAPI = {
  list: () => api.get<{ items: any[] }>('/dramas'),
  get: (id: number) => api.get(`/dramas/${id}`),
  create: (data: any) => api.post('/dramas', data),
  update: (id: number, data: any) => api.put(`/dramas/${id}`, data),
  del: (id: number) => api.del(`/dramas/${id}`),
}

export const episodeAPI = {
  create: (data: any) => api.post('/episodes', data),
  update: (id: number, data: any) => api.put(`/episodes/${id}`, data),
  del: (id: number) => api.del(`/episodes/${id}`),
  characters: (id: number) => api.get(`/episodes/${id}/characters`),
  scenes: (id: number) => api.get(`/episodes/${id}/scenes`),
  props: (id: number) => api.get(`/episodes/${id}/props`),
  storyboards: (id: number) => api.get(`/episodes/${id}/storyboards`),
  pipelineStatus: (id: number) => api.get(`/episodes/${id}/pipeline-status`),
  extract: (id: number, target: string, model?: string, configId?: number) => api.post(`/episodes/${id}/extract`, { target, model: model || undefined, config_id: configId || undefined }),
  extractStatus: (id: number) => api.get(`/episodes/${id}/extract-status`),
  generateVideoPrompts: (id: number, model?: string, configId?: number, storyboardIds?: number[]) => api.post(`/episodes/${id}/generate-video-prompts`, { model: model || undefined, config_id: configId || undefined, storyboard_ids: storyboardIds?.length ? storyboardIds : undefined }),
  videoPromptsStatus: (id: number) => api.get(`/episodes/${id}/video-prompts-status`),
  // 前情提要：前几集摘要 + 本集摘要状态；生成（同步，覆盖手写）/ 手动编辑（空串清除）
  recap: (id: number) => api.get(`/episodes/${id}/recap`),
  generateSummary: (id: number, model?: string, configId?: number) => api.post(`/episodes/${id}/summary`, { model: model || undefined, config_id: configId || undefined }),
  saveSummary: (id: number, summary: string) => api.put(`/episodes/${id}/summary`, { summary }),
  // 本集使用的角色造型（lookId 为空 = 默认造型）
  setCharacterLook: (id: number, characterId: number, lookId: number | null) => api.put(`/episodes/${id}/characters/${characterId}/look`, { look_id: lookId }),
}

export const storyboardAPI = {
  create: (data: any) => api.post('/storyboards', data),
  update: (id: number, data: any) => api.put(`/storyboards/${id}`, data),
  del: (id: number) => api.del(`/storyboards/${id}`),
  // 镜头级造型覆盖（lookId 为空 = 跟随本集）
  setCharacterLook: (id: number, characterId: number, lookId: number | null) => api.put(`/storyboards/${id}/character-look`, { character_id: characterId, look_id: lookId }),
}

export const characterAPI = {
  create: (data: any) => api.post('/characters', data),
  update: (id: number, data: any) => api.put(`/characters/${id}`, data),
  del: (id: number) => api.del(`/characters/${id}`),
  generatePrompt: (id: number, episodeId: number, force = false, textModel?: string, textConfigId?: number) => api.post(`/characters/${id}/generate-prompt`, { episode_id: episodeId, force, text_model: textModel || undefined, text_config_id: textConfigId || undefined }),
  generateImage: (id: number, episodeId: number, model?: string, configId?: number, textModel?: string, textConfigId?: number) => api.post(`/characters/${id}/generate-image`, { episode_id: episodeId, model: model || undefined, config_id: configId || undefined, text_model: textModel || undefined, text_config_id: textConfigId || undefined }),
  batchImages: (ids: number[], episodeId: number, model?: string, configId?: number, textModel?: string, textConfigId?: number) => api.post('/characters/batch-generate-images', { character_ids: ids, episode_id: episodeId, model: model || undefined, config_id: configId || undefined, text_model: textModel || undefined, text_config_id: textConfigId || undefined }),
  // 把 sourceIds 合并进 id（源角色名并入别名，关联/造型/生成记录迁移后软删除）
  merge: (id: number, sourceIds: number[]) => api.post(`/characters/${id}/merge`, { source_ids: sourceIds }),
}

// 角色造型：默认造型即角色自身形象图，这里管理额外造型
export const lookAPI = {
  list: (characterId: number) => api.get<any[]>(`/character-looks?character_id=${characterId}`),
  create: (characterId: number, data: { name: string; description?: string }) => api.post('/character-looks', { character_id: characterId, ...data }),
  update: (id: number, data: { name?: string; description?: string; image_url?: string | null }) => api.put(`/character-looks/${id}`, data),
  del: (id: number) => api.del(`/character-looks/${id}`),
  generateImage: (id: number, configId?: number, model?: string) => api.post(`/character-looks/${id}/generate-image`, { config_id: configId || undefined, model: model || undefined }),
}

export const sceneAPI = {
  create: (data: any) => api.post('/scenes', data),
  update: (id: number, data: any) => api.put(`/scenes/${id}`, data),
  del: (id: number) => api.del(`/scenes/${id}`),
  generatePrompt: (id: number, episodeId: number, force = false, textModel?: string, textConfigId?: number) => api.post(`/scenes/${id}/generate-prompt`, { episode_id: episodeId, force, text_model: textModel || undefined, text_config_id: textConfigId || undefined }),
  generateImage: (id: number, episodeId: number, model?: string, configId?: number, textModel?: string, textConfigId?: number) => api.post(`/scenes/${id}/generate-image`, { episode_id: episodeId, model: model || undefined, config_id: configId || undefined, text_model: textModel || undefined, text_config_id: textConfigId || undefined }),
}

export const propAPI = {
  create: (data: any) => api.post('/props', data),
  update: (id: number, data: any) => api.put(`/props/${id}`, data),
  del: (id: number) => api.del(`/props/${id}`),
  generatePrompt: (id: number, episodeId: number, force = false, textModel?: string, textConfigId?: number) => api.post(`/props/${id}/generate-prompt`, { episode_id: episodeId, force, text_model: textModel || undefined, text_config_id: textConfigId || undefined }),
  generateImage: (id: number, episodeId: number, model?: string, configId?: number, textModel?: string, textConfigId?: number) => api.post(`/props/${id}/generate-image`, { episode_id: episodeId, model: model || undefined, config_id: configId || undefined, text_model: textModel || undefined, text_config_id: textConfigId || undefined }),
}

// 统一生成任务（图片/视频）：POST 带 type 字段，列表按 type 过滤
export const taskAPI = {
  generate: (d: any) => api.post('/tasks', d),
  recover: (id: number) => api.post(`/tasks/${id}/recover`),
  diagnostics: (id: number) => api.get(`/tasks/${id}/diagnostics`),
  get: (id: number) => api.get(`/tasks/${id}`),
  del: (id: number) => api.del(`/tasks/${id}`),
  list: (params?: { type?: 'image' | 'video'; drama_id?: number; storyboard_id?: number }) => {
    const query = new URLSearchParams()
    if (params?.type) query.set('type', params.type)
    if (params?.drama_id) query.set('drama_id', String(params.drama_id))
    if (params?.storyboard_id) query.set('storyboard_id', String(params.storyboard_id))
    return api.get(`/tasks${query.size ? `?${query.toString()}` : ''}`)
  },
  // 按集聚合生成任务（sys_task + video_merges）
  listByEpisode: (episodeId: number) => api.get<{ tasks: any[]; merges: any[] }>(`/episodes/${episodeId}/generation-tasks`),
}

async function uploadReq<T = any>(path: string, file: File, fields?: Record<string, string | number | null | undefined>): Promise<T> {
  const fd = new FormData()
  fd.append('file', file)
  for (const [k, v] of Object.entries(fields || {})) {
    if (v !== undefined && v !== null && v !== '') fd.append(k, String(v))
  }
  console.log(`%c[API] %cPOST %c${path} %c${file.name}`, 'color:#888', 'color:#4fc3f7;font-weight:bold', 'color:#ccc', 'color:#888')
  const resp = await fetch(`${BASE}${path}`, { method: 'POST', body: fd })
  const json = await resp.json()
  if (!resp.ok || (json.code && json.code >= 400)) {
    console.log(`%c[API] %cPOST ${path} %c${resp.status}`, 'color:#888', 'color:#ef5350', 'color:#ef5350;font-weight:bold')
    throw new Error(json.message || `${resp.status}`)
  }
  return json.data ?? json
}

export const uploadAPI = {
  image: (f: File) => uploadReq<{ url: string; path: string }>('/upload/image', f),
  video: (f: File) => uploadReq<{ url: string; path: string }>('/upload/video', f),
  audio: (f: File) => uploadReq<{ url: string; path: string }>('/upload/audio', f),
}
// 全局素材库：category = character | scene；项目文件夹只读，我的文件夹（可嵌套）/文件可增删改
export type LibraryCategory = 'character' | 'scene'
export const libraryAPI = {
  overview: (category: LibraryCategory) => api.get(`/library/${category}`),
  folder: (category: LibraryCategory, id: number) => api.get(`/library/${category}/folders/${id}`),
  project: (category: LibraryCategory, dramaId: number) => api.get(`/library/${category}/projects/${dramaId}`),
  folderTree: (category: LibraryCategory) => api.get<{ id: number; parent_id: number | null; name: string }[]>(`/library/${category}/folders`),
  createFolder: (category: LibraryCategory, name: string, parentId?: number | null) => api.post(`/library/${category}/folders`, { name, parent_id: parentId || undefined }),
  renameFolder: (id: number, name: string) => api.put(`/library/folders/${id}`, { name }),
  moveFolder: (id: number, parentId: number | null) => api.put(`/library/folders/${id}`, { parent_id: parentId }),
  delFolder: (id: number) => api.del(`/library/folders/${id}`),
  upload: (category: LibraryCategory, f: File, folderId?: number | null) => uploadReq(`/library/${category}/files`, f, { folder_id: folderId }),
  updateFile: (id: number, data: { name?: string; description?: string; folder_id?: number | null }) => api.put(`/library/files/${id}`, data),
  delFile: (id: number) => api.del(`/library/files/${id}`),
}

export const mergeAPI = {
  merge: (epId: number, storyboardIds?: number[]) => api.post(`/merge/episodes/${epId}/merge`, storyboardIds?.length ? { storyboard_ids: storyboardIds } : {}),
  status: (epId: number) => api.get(`/merge/episodes/${epId}/merge`),
  list: (epId: number) => api.get<any[]>(`/merge/episodes/${epId}/merges`),
}
export const aiConfigAPI = {
  list: (t?: string) => api.get(`/ai-configs${t ? `?service_type=${t}` : ''}`),
  create: (d: any) => api.post('/ai-configs', d),
  update: (id: number, d: any) => api.put(`/ai-configs/${id}`, d),
  del: (id: number) => api.del(`/ai-configs/${id}`),
  test: (d: any) => api.post('/ai-configs/test', d),
}

// lang 缺省/为 zh 时读写基础版（不带 query，保持原请求形态）
const langQ = (lang?: string) => (lang && lang !== 'zh' ? `?lang=${lang}` : '')

export const promptAPI = {
  list: () => api.get('/prompts'),
  get: (type: string, lang?: string) => api.get(`/prompts/${type}${langQ(lang)}`),
  update: (type: string, d: any, lang?: string) => api.put(`/prompts/${type}${langQ(lang)}`, d),
  reset: (type: string, lang?: string) => api.post(`/prompts/${type}/reset${langQ(lang)}`),
}

export const skillsAPI = {
  list: (lang?: string) => api.get(`/skills${langQ(lang)}`),
  get: (id: string, lang?: string) => api.get(`/skills/${id}${langQ(lang)}`),
  create: (data: { id: string; name: string; description?: string }) => api.post('/skills', data),
  update: (id: string, content: string, lang?: string) => api.put(`/skills/${id}${langQ(lang)}`, { content }),
  del: (id: string) => api.del(`/skills/${id}`),
}

export const stylePresetAPI = {
  list: (all = false) => api.get(`/style-presets${all ? '?all=1' : ''}`),
  create: (d: any) => api.post('/style-presets', d),
  update: (id: number, d: any) => api.put(`/style-presets/${id}`, d),
  del: (id: number) => api.del(`/style-presets/${id}`),
}

export const storageAPI = {
  info: () => api.get('/storage'),
}

export const settingsAPI = {
  contentLanguage: () => api.get<{ language: string }>('/settings/content-language'),
  setContentLanguage: (language: string) => api.put('/settings/content-language', { language }),
}

// 服务器/Docker 部署的版本检查与更新（桌面版走 useDesktopBridge，不用此 API）
export const serverUpdateAPI = {
  state: () => api.get('/server-update/state'),
  check: () => api.post('/server-update/check'),
  apply: () => api.post('/server-update/apply'),
}
