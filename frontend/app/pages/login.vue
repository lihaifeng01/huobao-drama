<template>
  <AuthCard :mode="mode" @switch="mode = $event" />
</template>

<script setup lang="ts">
definePageMeta({ layout: false })

const route = useRoute()
// 登录 / 注册同一页切换；?mode=register 直接打开注册
const mode = ref<'login' | 'register'>(route.query.mode === 'register' ? 'register' : 'login')
</script>
