<template>
  <section class="card accounts-card">
    <div class="accounts-head">
      <div>
        <h2 class="accounts-title">{{ t('quota.accounts.title') }}</h2>
        <p class="accounts-sub">{{ t('quota.accounts.sub') }}</p>
      </div>
    </div>

    <div class="table-wrap">
      <table class="accounts-table">
        <thead>
          <tr>
            <th>{{ t('quota.accounts.col.user') }}</th>
            <th class="num">{{ t('quota.granted') }}</th>
            <th class="num">{{ t('quota.used') }}</th>
            <th class="num">{{ t('quota.remaining') }}</th>
            <th class="num"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="loading"><td colspan="5" class="empty">{{ t('common.loading') }}</td></tr>
          <tr v-else-if="!accounts.length"><td colspan="5" class="empty">{{ t('quota.accounts.empty') }}</td></tr>
          <tr v-for="a in accounts" v-else :key="a.user_id">
            <td>
              <div class="user-cell">
                <span class="truncate">{{ a.display_name }}</span>
                <span class="dim truncate">{{ a.username }}</span>
                <span v-if="a.status === 'disabled'" class="tag">{{ t('users.status.disabled') }}</span>
              </div>
            </td>
            <td class="num">{{ fmt(a.granted) }}</td>
            <td class="num">{{ fmt(a.used) }}</td>
            <td class="num strong" :class="{ zero: a.balance <= 0 }">
              {{ fmt(a.balance) }}
              <span v-if="a.balance <= 0" class="tag tag-warning">{{ t('quota.exhausted') }}</span>
            </td>
            <td class="num">
              <button class="btn btn-sm" @click="openGrant(a)">{{ t('quota.accounts.grant') }}</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="accounts-head ledger-head">
      <h2 class="accounts-title">{{ t('quota.ledger.title') }}</h2>
      <span class="dim">{{ t('usage.total', { n: fmt(ledger.total) }) }}</span>
    </div>
    <div class="table-wrap">
      <table class="accounts-table">
        <thead>
          <tr>
            <th>{{ t('usage.col.time') }}</th>
            <th>{{ t('quota.accounts.col.user') }}</th>
            <th class="num">{{ t('quota.ledger.delta') }}</th>
            <th class="hide-sm">{{ t('quota.ledger.operator') }}</th>
            <th class="hide-sm">{{ t('quota.ledger.note') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="!ledger.items.length"><td colspan="5" class="empty">{{ t('usage.empty') }}</td></tr>
          <tr v-for="r in ledger.items" v-else :key="r.id">
            <td class="dim nowrap">{{ fmtTime(r.created_at) }}</td>
            <td class="truncate">{{ r.user_name || '—' }}</td>
            <td class="num strong" :class="r.delta < 0 ? 'neg' : 'pos'">{{ r.delta > 0 ? '+' : '' }}{{ fmt(r.delta) }}</td>
            <td class="hide-sm truncate">{{ r.operator_name || '—' }}</td>
            <td class="hide-sm truncate">{{ r.note || '—' }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-if="ledger.total > PAGE_SIZE" class="pager">
      <button class="btn btn-sm btn-icon" :disabled="page <= 1" :title="t('usage.prev')" @click="page--"><ChevronLeft :size="14" /></button>
      <span class="dim">{{ page }} / {{ pageCount }}</span>
      <button class="btn btn-sm btn-icon" :disabled="page >= pageCount" :title="t('usage.next')" @click="page++"><ChevronRight :size="14" /></button>
    </div>

    <div v-if="dialog.account" class="overlay" @click.self="dialog.account = null">
      <div class="dialog grant-dialog">
        <div class="dialog-head">
          <h2 class="dialog-title">{{ t('quota.accounts.grantTitle', { name: dialog.account.display_name }) }}</h2>
        </div>
        <form @submit.prevent="submitGrant">
          <div class="dialog-body grant-form">
            <p class="grant-balance">{{ t('quota.accounts.current', { n: fmt(dialog.account.balance) }) }}</p>
            <label class="g-field">
              <span>{{ t('quota.accounts.amount') }}</span>
              <input v-model="dialog.amount" class="input" type="number" step="1" inputmode="numeric" required autofocus />
              <em>{{ t('quota.accounts.amountHint') }}</em>
            </label>
            <label class="g-field">
              <span>{{ t('quota.ledger.note') }} <em>{{ t('auth.optional') }}</em></span>
              <input v-model.trim="dialog.note" class="input" maxlength="200" />
            </label>
          </div>
          <div class="dialog-foot">
            <button type="button" class="btn" @click="dialog.account = null">{{ t('common.cancel') }}</button>
            <button type="submit" class="btn btn-primary" :disabled="dialog.saving">{{ t('common.confirm') }}</button>
          </div>
        </form>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { toast } from 'vue-sonner'
import { useI18n } from 'vue-i18n'
import { ChevronLeft, ChevronRight } from 'lucide-vue-next'
import { pointsAPI, type PointAccount } from '~/composables/useApi'
import { toastError } from '~/composables/useToast'

/** 管理员：普通用户的积分账户列表、分配 / 扣减积分、分配记录 */
const emit = defineEmits<{ (e: 'changed'): void }>()
const PAGE_SIZE = 10

const { t, locale } = useI18n()
const loading = ref(true)
const accounts = ref<PointAccount[]>([])
const ledger = ref<{ total: number; items: any[] }>({ total: 0, items: [] })
const page = ref(1)
const pageCount = computed(() => Math.max(1, Math.ceil(ledger.value.total / PAGE_SIZE)))
const dialog = reactive({ account: null as PointAccount | null, amount: '' as string | number, note: '', saving: false })

const fmt = (n: number) => Number(n || 0).toLocaleString(locale.value)
function fmtTime(iso: string) {
  return new Date(iso).toLocaleString(locale.value, { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

async function loadAccounts() {
  loading.value = true
  try {
    accounts.value = await pointsAPI.accounts()
  } catch (e) {
    toastError(e)
  } finally {
    loading.value = false
  }
}

async function loadLedger() {
  try {
    ledger.value = await pointsAPI.ledger({ page: page.value, page_size: PAGE_SIZE })
  } catch (e) {
    toastError(e)
  }
}

function openGrant(a: PointAccount) {
  Object.assign(dialog, { account: a, amount: '', note: '', saving: false })
}

async function submitGrant() {
  const amount = Number(dialog.amount)
  if (!Number.isInteger(amount) || amount === 0) {
    toast.error(t('quota.accounts.invalid'))
    return
  }
  dialog.saving = true
  try {
    await pointsAPI.grant({ user_id: dialog.account!.user_id, amount, note: dialog.note || undefined })
    toast.success(t('quota.accounts.granted'))
    dialog.account = null
    page.value = 1
    await Promise.all([loadAccounts(), loadLedger()])
    emit('changed')
  } catch (e) {
    toastError(e)
  } finally {
    dialog.saving = false
  }
}

watch(page, loadLedger)
onMounted(() => { loadAccounts(); loadLedger() })
</script>

<style scoped>
.accounts-card { padding: 0; overflow: hidden; margin-bottom: 14px; }
.accounts-card:hover { border-color: var(--border); }
.accounts-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--border); }
.ledger-head { border-top: 1px solid var(--border); }
.accounts-title { margin: 0; font-size: 14px; font-weight: 700; color: var(--text-0); }
.accounts-sub { margin: 4px 0 0; font-size: 12px; color: var(--text-3); line-height: 1.5; }
.table-wrap { overflow-x: auto; }
.accounts-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.accounts-table th { text-align: left; font-weight: 600; font-size: 11.5px; color: var(--text-3); padding: 9px 16px; border-bottom: 1px solid var(--border); white-space: nowrap; }
.accounts-table td { padding: 9px 16px; border-bottom: 1px solid var(--border); color: var(--text-1); max-width: 240px; }
.accounts-table tr:last-child td { border-bottom: none; }
.accounts-table .num { text-align: right; font-variant-numeric: tabular-nums; }
.accounts-table .strong { font-weight: 700; color: var(--text-0); }
.accounts-table .zero { color: var(--error); }
.accounts-table .pos { color: var(--success); }
.accounts-table .neg { color: var(--error); }
.accounts-table .empty { text-align: center; color: var(--text-3); padding: 20px; }
.user-cell { display: flex; align-items: center; gap: 8px; min-width: 0; }
.nowrap { white-space: nowrap; }
.dim { color: var(--text-3); font-size: 12px; }
.pager { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 10px; border-top: 1px solid var(--border); }
.grant-dialog { max-width: 420px; }
.grant-form { display: flex; flex-direction: column; gap: 14px; }
.grant-balance { margin: 0; font-size: 13px; color: var(--text-2); }
.g-field { display: flex; flex-direction: column; gap: 6px; font-size: 12.5px; font-weight: 600; color: var(--text-1); }
.g-field em { font-style: normal; font-weight: 400; color: var(--text-3); font-size: 11.5px; }
@media (max-width: 640px) { .hide-sm { display: none; } }
</style>
