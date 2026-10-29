<template>
  <div class="page">
    <div class="tools-head">
      <h1 class="tools-title">{{ t('tools.title') }}</h1>
      <span class="tools-sub">{{ t('tools.sub') }}</span>
    </div>

    <div class="tools-body">
      <aside class="tool-nav">
        <button
          v-for="tool in toolDefs"
          :key="tool.id"
          type="button"
          :class="['tool-nav-item', { on: activeTool === tool.id }]"
          @click="activeTool = tool.id"
        >
          <component :is="tool.icon" :size="16" :stroke-width="1.8" />
          <span class="tool-nav-text">
            <span class="tool-nav-name">{{ tool.name }}</span>
            <span class="tool-nav-desc">{{ tool.desc }}</span>
          </span>
        </button>
      </aside>

      <SubtitleTool v-if="activeTool === 'subtitle'" />
      <VideoMergeTool v-else-if="activeTool === 'merge'" />
    </div>
  </div>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { Captions, Combine } from 'lucide-vue-next'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()

const toolDefs = computed(() => [
  { id: 'subtitle', icon: Captions, name: t('tools.subtitle.name'), desc: t('tools.subtitle.desc') },
  { id: 'merge', icon: Combine, name: t('tools.merge.name'), desc: t('tools.merge.desc') },
])
// 当前工具记在 ?tool= 上，刷新和返回时保持
const activeTool = computed({
  get: () => (toolDefs.value.some(x => x.id === route.query.tool) ? route.query.tool : 'subtitle'),
  set: v => router.replace({ query: { ...route.query, tool: v } }),
})
</script>

<style scoped>
.page {
  position: relative;
  padding: 20px 28px 28px;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: fadeUp 0.35s var(--ease-out) both;
  background: var(--surface-base);
}
.tools-head { display: flex; align-items: baseline; gap: 12px; padding-bottom: var(--sp-4); }
.tools-title { font-size: 20px; font-weight: 650; letter-spacing: -0.02em; color: var(--text-0); }
.tools-sub { color: var(--text-3); font-size: 12.5px; }
.tools-body { flex: 1; min-height: 0; display: flex; gap: 16px; }

.tool-nav { width: 200px; flex-shrink: 0; display: flex; flex-direction: column; gap: 4px; }
.tool-nav-item {
  display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px;
  border: 1px solid transparent; border-radius: var(--radius); background: transparent;
  color: var(--text-1); text-align: left; cursor: pointer;
}
.tool-nav-item:hover { background: var(--bg-hover); }
.tool-nav-item.on { background: var(--accent-bg); border-color: var(--accent); color: var(--accent-text); }
.tool-nav-text { display: flex; flex-direction: column; gap: 2px; }
.tool-nav-name { font-size: 13px; font-weight: 650; }
.tool-nav-desc { font-size: 11.5px; color: var(--text-3); line-height: 1.4; }

@media (max-width: 1100px) {
  .tools-body { flex-direction: column; }
  .tool-nav { width: auto; flex-direction: row; }
}
</style>
