<!--
  Tenant settings surface on Web (spec 0006 AC-2): the two POSSettings
  notification fields (enableMobileNotifications, messageChannel), edited
  per tenant and persisted through the shared doc layer — Doc.sync() goes
  fyo.db → fyo/demux/db.ts's web branch → POST /api/db/call on the worker,
  which writes into that org's own Neon project. No new delivery code and
  no new endpoints: this page only reaches the tenant round trip feature
  0002 already built, via src/web/boot.ts.

  Deliberately NOT the shared src/pages/Settings/Settings.vue: it
  statically imports src/errorHandling.ts and src/utils (both top-level
  import src/initFyo, the Desktop fyo singleton, and Settings.vue's save
  dialog binds the Electron-only ipc global) — mounting it in a browser
  throws at import or at save time; see rendererWeb.ts's docblock for the
  same class of breakage. When more Web features need more settings
  tabs, widening this page is the path; importing Desktop's page is not.

  messageChannel is a password-equivalent topic (AC-4): rendered as a
  masked input that reveals on demand, and never shown anywhere else.
-->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useClerkAuth } from 'src/web/clerk';
import { ensureWebFyoReady } from 'src/web/boot';
import { sendNtfyNotification } from 'src/utils/ntfy';

const router = useRouter();
const { isLoaded, isSignedIn, orgId } = useClerkAuth();

type ViewState =
  | { kind: 'LOADING' }
  | { kind: 'RETRY'; detail: string }
  | { kind: 'EDIT' };

const view = ref<ViewState>({ kind: 'LOADING' });
const enableMobileNotifications = ref(false);
const messageChannel = ref('');
const showTopic = ref(false);
const dirty = ref(false);
const saving = ref(false);
const saveError = ref('');
const testState = ref<'idle' | 'sending' | 'sent' | 'failed'>('idle');
let disposed = false;

async function load() {
  const requestedOrgId = orgId.value;
  if (!requestedOrgId) return;

  view.value = { kind: 'LOADING' };
  const boot = await ensureWebFyoReady(requestedOrgId);
  if (disposed || orgId.value !== requestedOrgId) return;

  if (boot.status === 'NOT_SIGNED_IN') {
    void router.replace('/sign-in');
    return;
  }

  if (boot.status !== 'READY') {
    // PROVISIONING / PROJECT_CREATED / UNKNOWN / FAILED: all retryable
    // from here (a 402 denial during boot is already redirected to
    // /billing by initSubscriptionRedirect, so it never reaches this
    // branch).
    view.value = {
      kind: 'RETRY',
      detail:
        boot.status === 'FAILED'
          ? boot.error ?? 'Unknown error'
          : `Your account is not ready yet (status: ${boot.status}).`,
    };
    return;
  }

  const posSettings = boot.fyo.singles.POSSettings;
  enableMobileNotifications.value = !!posSettings?.enableMobileNotifications;
  messageChannel.value = (posSettings?.messageChannel as string) ?? '';
  dirty.value = false;
  view.value = { kind: 'EDIT' };
}

const canSave = computed(
  () =>
    view.value.kind === 'EDIT' &&
    !saving.value &&
    dirty.value &&
    (!enableMobileNotifications.value ||
      TOPIC_PATTERN.test(messageChannel.value))
);

/**
 * Mirrors src/utils/ntfy.ts's own topic validation (delivery is a no-op
 * with a bad topic) so a typo shows here instead of silently killing
 * notifications.
 */
const TOPIC_PATTERN = /^[A-Za-z0-9_-]+$/;
const topicInvalid = computed(
  () =>
    view.value.kind === 'EDIT' &&
    enableMobileNotifications.value &&
    messageChannel.value !== '' &&
    !TOPIC_PATTERN.test(messageChannel.value)
);

async function save() {
  if (!canSave.value) return;
  saving.value = true;
  saveError.value = '';
  try {
    const activeOrgId = orgId.value;
    if (!activeOrgId) return;
    const { fyo } = await ensureWebFyoReady(activeOrgId);
    const posSettings = fyo.singles.POSSettings!;
    await posSettings.set(
      'enableMobileNotifications',
      enableMobileNotifications.value
    );
    await posSettings.set('messageChannel', messageChannel.value);
    // Shared Doc.sync() path — same call Desktop's Settings page makes.
    await posSettings.sync();
    dirty.value = false;
  } catch (err) {
    saveError.value = err instanceof Error ? err.message : String(err);
  } finally {
    saving.value = false;
  }
}

/**
 * Publishes through the exact function the model triggers use
 * (src/utils/ntfy.ts), not a copy — so this doubles as AC-3's evidence
 * that a browser-origin publish of the real code path arrives.
 * Fail-soft by design upstream: it never throws at us.
 */
async function sendTest() {
  const activeOrgId = orgId.value;
  if (!activeOrgId) return;
  const { fyo } = await ensureWebFyoReady(activeOrgId);
  if (disposed || orgId.value !== activeOrgId) return;
  testState.value = 'sending';
  const sent = await sendNtfyNotification(
    fyo,
    'Test notification from RareBooks Web settings.',
    'RareBooks test',
    'white_check_mark'
  );
  if (disposed || orgId.value !== activeOrgId) return;
  testState.value = sent ? 'sent' : 'failed';
  setTimeout(() => {
    if (!disposed) testState.value = 'idle';
  }, 4000);
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
      void load();
    },
    { immediate: true }
  );
});
onUnmounted(() => {
  disposed = true;
});
</script>

<template>
  <div class="min-h-screen bg-gray-900 text-gray-25">
    <div class="max-w-xl mx-auto px-4 py-8">
      <div class="flex items-center justify-between mb-6">
        <h1 class="text-xl font-semibold">Settings</h1>
        <button
          class="text-sm text-gray-200 hover:text-gray-25"
          @click="router.push('/dashboard')"
        >
          Back to dashboard
        </button>
      </div>

      <div v-if="view.kind === 'LOADING'" class="text-sm text-gray-200">
        Loading settings…
      </div>

      <div v-else-if="view.kind === 'RETRY'" class="space-y-3">
        <p class="text-sm">{{ view.detail }}</p>
        <button
          class="px-3 py-1.5 text-sm bg-gray-800 hover:bg-gray-700 rounded"
          @click="load"
        >
          Retry
        </button>
      </div>

      <div v-else class="space-y-6">
        <section class="bg-gray-890 border border-gray-800 rounded p-4">
          <h2 class="text-sm font-semibold mb-1">Notifications</h2>
          <p class="text-xs text-gray-200 mb-4">
            Restock alerts, new sales, and end-of-day shift summaries are sent
            to an ntfy topic. Enter the topic you subscribe to with your ntfy
            app.
          </p>

          <label class="flex items-center gap-2 text-sm cursor-pointer">
            <input
              v-model="enableMobileNotifications"
              type="checkbox"
              @change="dirty = true"
            />
            Enable mobile notifications
          </label>

          <div v-if="enableMobileNotifications" class="mt-4">
            <label class="block text-xs text-gray-200 mb-1">
              ntfy topic (acts as this organization's password, keep it private)
            </label>
            <div class="flex gap-2">
              <input
                v-model="messageChannel"
                :type="showTopic ? 'text' : 'password'"
                class="flex-1 px-2 py-1.5 text-sm bg-gray-800 border border-gray-800 rounded focus:border-gray-100 outline-none"
                @input="dirty = true"
              />
              <button
                class="px-2 py-1.5 text-xs bg-gray-800 hover:bg-gray-700 rounded"
                @click="showTopic = !showTopic"
              >
                {{ showTopic ? 'Hide' : 'Show' }}
              </button>
            </div>
            <p v-if="topicInvalid" class="mt-1 text-xs text-red-500">
              Topic may only use letters, numbers, dashes and underscores.
            </p>
            <p class="mt-2 text-xs text-gray-200">
              Anyone who knows this topic can publish fake notifications to your
              subscribers, so share it only inside your team.
            </p>
            <button
              class="mt-3 px-3 py-1.5 text-sm bg-gray-800 hover:bg-gray-700 rounded disabled:opacity-50"
              :disabled="
                testState !== 'idle' || messageChannel === '' || topicInvalid
              "
              @click="sendTest"
            >
              {{
                testState === 'sending'
                  ? 'Sending…'
                  : testState === 'sent'
                  ? 'Sent. Check your ntfy app.'
                  : testState === 'failed'
                  ? 'Delivery failed. Try again.'
                  : 'Send test notification'
              }}
            </button>
            <p v-if="testState === 'sent'" class="mt-1 text-xs text-gray-200">
              If it did not arrive, save first: the test uses the settings
              currently loaded, which must match what is saved.
            </p>
            <p
              v-else-if="testState === 'failed'"
              class="mt-1 text-xs text-red-500"
            >
              The notification could not be delivered. Check the saved topic and
              your network connection.
            </p>
          </div>
        </section>

        <div class="flex items-center gap-3">
          <button
            class="px-4 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 rounded font-medium disabled:opacity-50"
            :disabled="!canSave"
            @click="save"
          >
            {{ saving ? 'Saving…' : 'Save' }}
          </button>
          <span v-if="saveError" class="text-xs text-red-500">
            {{ saveError }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
