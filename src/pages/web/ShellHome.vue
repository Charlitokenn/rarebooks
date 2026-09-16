<!--
  Shell home (spec 0008 AC-1): the workspace a signed-in user lands on
  inside the chrome. Replaces the standalone /dashboard page; its links
  (Settings, Billing, sign out) and org summary survive here, and the
  provisioning-poller behavior the old page owned now lives in WebShell's
  boot state machine.

  Spec: docs/specs/0008-web-app-shell/index.md
-->
<template>
  <div
    class="flex-1 overflow-y-auto custom-scroll custom-scroll-thumb1 bg-white dark:bg-gray-875"
  >
    <div class="p-6 max-w-3xl w-full mx-auto flex flex-col gap-6">
      <div>
        <h1 class="text-2xl font-semibold text-gray-900 dark:text-gray-25">
          {{ t`Welcome to RareBooks` }}
        </h1>
        <p class="text-sm text-gray-600 dark:text-gray-400 mt-1">
          {{ t`You are signed in to ${orgName}.` }}
        </p>
      </div>

      <!-- Quick links to the tenant data mounted in the shell so far -->
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <RouterLink
          to="/list/Party/Customers"
          class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4 flex items-center gap-3 hover:border-gray-300 dark:hover:border-gray-700 transition-colors group"
        >
          <feather-icon
            name="users"
            class="w-5 h-5 text-gray-500 group-hover:text-gray-700 dark:text-gray-400 dark:group-hover:text-gray-200"
          />
          <div>
            <p class="text-sm font-medium text-gray-900 dark:text-gray-25">
              {{ t`Customers` }}
            </p>
            <p class="text-xs text-gray-500 dark:text-gray-400">
              {{ t`Browse and edit your customer list.` }}
            </p>
          </div>
        </RouterLink>

        <a
          href="/settings"
          class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4 flex items-center gap-3 hover:border-gray-300 dark:hover:border-gray-700 transition-colors group"
        >
          <feather-icon
            name="settings"
            class="w-5 h-5 text-gray-500 group-hover:text-gray-700 dark:text-gray-400 dark:group-hover:text-gray-200"
          />
          <div>
            <p class="text-sm font-medium text-gray-900 dark:text-gray-25">
              {{ t`Settings` }}
            </p>
            <p class="text-xs text-gray-500 dark:text-gray-400">
              {{ t`Notification preferences for this organization.` }}
            </p>
          </div>
        </a>

        <a
          href="/billing"
          class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4 flex items-center gap-3 hover:border-gray-300 dark:hover:border-gray-700 transition-colors group"
        >
          <feather-icon
            name="credit-card"
            class="w-5 h-5 text-gray-500 group-hover:text-gray-700 dark:text-gray-400 dark:group-hover:text-gray-200"
          />
          <div>
            <p class="text-sm font-medium text-gray-900 dark:text-gray-25">
              {{ t`Billing` }}
            </p>
            <p class="text-xs text-gray-500 dark:text-gray-400">
              {{ t`Manage your subscription.` }}
            </p>
          </div>
        </a>
      </div>

      <div class="flex items-center justify-between">
        <div class="text-xs text-gray-500 dark:text-gray-400">
          {{
            t`More of the app (invoices, items, reports) is being mounted into this shell feature by feature.`
          }}
        </div>
        <button
          class="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 underline"
          @click="signOut"
        >
          {{ t`Sign out` }}
        </button>
      </div>
    </div>
  </div>
</template>
<script lang="ts">
import { defineComponent } from 'vue';
import { fyo } from 'src/initFyo';
import { signOutShell } from 'src/web/shell';

export default defineComponent({
  name: 'ShellHome',
  computed: {
    orgName(): string {
      return (
        (fyo.singles.AccountingSettings?.companyName as string) ||
        'your organization'
      );
    },
  },
  methods: {
    signOut: signOutShell,
  },
});
</script>
