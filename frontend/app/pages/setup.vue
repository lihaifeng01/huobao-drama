<template>
  <!-- 首次使用：创建超级管理员（后端只在没有任何账号时接受） -->
  <AuthCard mode="setup" />
</template>

<script setup lang="ts">
definePageMeta({ layout: false })
</script>
