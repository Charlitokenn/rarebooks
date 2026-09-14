<!--
  The billing prompt surface (spec 0003, AC-4, AC-8): shown when the
  subscription gate has just denied a tenant data call with 402, or opened
  directly. Authoritative state comes from GET /api/subscription/status on
  every load or refresh (a cold load must render the same page a denial
  produced); the last denial from sessionStorage is only immediate context.

  A control plane outage (503 / UNAVAILABLE) is deliberately NOT rendered as
  a billing problem: it gets honest retry copy instead (AC-4). The subscribe
  CTA is a placeholder until specs 0004 (PayPal) and 0005 (Lipa Namba) give
  it a real flow.

  Spec: docs/specs/0003-subscription-gating-seat-sync.md
-->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useClerkAuth } from 'src/web/clerk';
import { readDenial } from 'src/web/subscription';
import type { SubscriptionWireStatus } from 'custom/web/billing/types';
import Badge from 'src/components/Badge.vue';
import Button from 'src/components/Button.vue';

const router = useRouter();
const { isLoaded, isSignedIn, orgId } = useClerkAuth();

type ViewState =
  | { kind: 'LOADING' }
  | { kind: 'STATUS'; status: SubscriptionWireStatus }
  | { kind: 'RETRY' };

const view = ref<ViewState>({ kind: 'LOADING' });
const denial = ref(readDenial());
let disposed = false;
let activeRequest: AbortController | undefined;

async function loadStatus() {
  view.value = { kind: 'LOADING' };
  const request = new AbortController();
  activeRequest = request;
  try {
    const res = await fetch('/api/subscription/status', {
      credentials: 'include',
      signal: request.signal,
    });
    if (disposed) return;

    if (res.status === 503) {
      // An outage is not a billing problem (AC-4): retry copy, never the
      // "fix your subscription" framing.
      view.value = { kind: 'RETRY' };
      return;
    }

    const body = (await res.json().catch(() => ({}))) as {
      status?: SubscriptionWireStatus;
    };
    if (!res.ok || !body.status) {
      view.value = { kind: 'RETRY' };
      return;
    }
    view.value = { kind: 'STATUS', status: body.status };
  } catch {
    if (!disposed) view.value = { kind: 'RETRY' };
  } finally {
    if (activeRequest === request) activeRequest = undefined;
  }
}

interface Bucket {
  badgeColor: string;
  badgeText: string;
  title: string;
  body: string;
  showCta: boolean;
}

const bucket = computed<Bucket | null>(() => {
  if (view.value.kind !== 'STATUS') return null;
  switch (view.value.status) {
    case 'TRIAL':
      return {
        badgeColor: 'green',
        badgeText: 'Trial',
        title: 'You are on the free trial',
        body: 'The full app is open until your trial ends. Pick a plan any time before it does and billing starts then.',
        showCta: false,
      };
    case 'ACTIVE':
      return {
        badgeColor: 'green',
        badgeText: 'Active',
        title: 'Your subscription is active',
        body: 'Everything is paid up. Return to your dashboard to keep working.',
        showCta: false,
      };
    case 'GRACE':
      return {
        badgeColor: 'yellow',
        badgeText: 'Grace period',
        title: 'Your subscription has ended',
        body: 'Everything still works for now. Choose a plan before the grace period ends to keep your access.',
        showCta: true,
      };
    case 'READ_ONLY':
      return {
        badgeColor: 'yellow',
        badgeText: 'Read only',
        title: 'Your account is read only',
        body: 'You can view and download your books, but nothing can be added or changed until a plan is chosen. Your data is safe.',
        showCta: true,
      };
    case 'CANCELLED':
    case 'MISSING':
      return {
        badgeColor: 'gray',
        badgeText: 'No active plan',
        title: 'Choose a plan to continue',
        body: 'This organization does not have an active subscription, so its data is locked. Pick a plan when checkout opens to restore access.',
        showCta: true,
      };
    default:
      // PAST_DUE and anything unrecognized: payment problem.
      return {
        badgeColor: 'yellow',
        badgeText: view.value.status === 'PAST_DUE' ? 'Past due' : 'Suspended',
        title: 'There is a problem with your payment',
        body: 'Your subscription is not active right now, so this organization’s data is locked. Sorting out the payment restores access immediately.',
        showCta: true,
      };
  }
});

function retry(): void {
  void loadStatus();
}

function goDashboard(): void {
  void router.replace('/dashboard');
}

onMounted(() => {
  watch(
    [isLoaded, isSignedIn, orgId],
    ([loaded, signedIn, activeOrgId]) => {
      if (!loaded) return;
      if (!signedIn) {
        void router.replace('/sign-in');
        return;
      }
      if (!activeOrgId) {
        void router.replace('/create-organization');
        return;
      }
      void loadStatus();
    },
    { immediate: true }
  );
});

onUnmounted(() => {
  disposed = true;
  activeRequest?.abort();
});
</script>

<template>
  <div
    class="flex items-center justify-center min-h-screen bg-gray-25 dark:bg-gray-890 p-4"
  >
    <div
      class="w-full max-w-[26rem] bg-white dark:bg-gray-850 border border-gray-300 dark:border-gray-800 rounded-lg shadow p-6"
    >
      <div class="flex items-center justify-between mb-4">
        <span class="text-lg font-semibold text-gray-900 dark:text-gray-100">
          Billing
        </span>
        <Badge v-if="bucket" :color="bucket.badgeColor">
          <span class="text-xs font-medium">{{ bucket.badgeText }}</span>
        </Badge>
      </div>

      <template v-if="view.kind === 'LOADING'">
        <p class="text-base text-gray-600 dark:text-gray-400">
          Checking your subscription…
        </p>
      </template>

      <template v-else-if="view.kind === 'RETRY'">
        <h1 class="text-base font-medium text-gray-900 dark:text-gray-100 mb-2">
          We could not reach the billing service
        </h1>
        <p class="text-base text-gray-600 dark:text-gray-400 mb-4">
          This is our side blinking, not a problem with your subscription.
          Please try again in a moment.
        </p>
        <Button type="primary" @click="retry">Try again</Button>
      </template>

      <template v-else-if="bucket">
        <h1 class="text-base font-medium text-gray-900 dark:text-gray-100 mb-2">
          {{ bucket.title }}
        </h1>
        <p class="text-base text-gray-600 dark:text-gray-400 mb-4">
          {{ bucket.body }}
        </p>
        <p
          v-if="
            denial && view.kind === 'STATUS' && denial.status !== view.status
          "
          class="text-xs text-gray-500 dark:text-gray-400 mb-4"
        >
          A request was just blocked here (status: {{ denial.status }}). The
          status above is current.
        </p>
        <div class="flex flex-col gap-2">
          <Button
            v-if="bucket.showCta"
            type="primary"
            disabled
            title="Plan checkout opens with PayPal and Lipa Namba billing"
          >
            Choose a plan (coming soon)
          </Button>
          <Button v-else type="secondary" @click="goDashboard">
            Back to dashboard
          </Button>
        </div>
      </template>
    </div>
  </div>
</template>
