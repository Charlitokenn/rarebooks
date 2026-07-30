<script setup lang="ts">
import { SignIn, OrganizationSwitcher, useAuth } from '@clerk/vue';
import { ref, watch } from 'vue';
import { setClerkTokenGetter } from 'fyo/demux/dbWeb';
import AppWeb from 'src/AppWeb.vue';

const { isSignedIn, isLoaded, orgId, getToken } = useAuth();

const showOrgSwitcher = ref(false);
const error = ref<string | null>(null);

watch(
  [isLoaded, isSignedIn, orgId],
  ([loaded, signedIn, activeOrgId]) => {
    if (!loaded || !signedIn) {
      return;
    }
    if (!activeOrgId) {
      showOrgSwitcher.value = true;
      return;
    }

    // Must happen before any fyo.db.* call runs inside AppWeb - see dbWeb.ts's comment on
    // why this can't be wired at Fyo-construction time instead. Re-set on every org change
    // too, in case the user switches organizations later - getToken.value() always reads
    // whichever org is currently active in the Clerk session, so this doesn't need to be
    // re-called per switch, just needs to have run once before AppWeb mounts.
    setClerkTokenGetter(() => getToken.value());
    showOrgSwitcher.value = false;
    error.value = null;
  },
  { immediate: true },
);

function handleSwitchOrganization() {
  // AppWeb emits this when the user wants to change companies (the web equivalent of the
  // Electron app's "change db file" / DatabaseSelector flow). Unmounting AppWeb (by
  // flipping this back to true) and showing OrganizationSwitcher again is enough - Clerk
  // itself handles the actual org switch, and the watch above picks up the new orgId.
  showOrgSwitcher.value = true;
}
</script>

<template>
  <div v-if="!isLoaded" style="padding: 2rem; font-family: sans-serif">
    Loading...
  </div>

  <div v-else-if="!isSignedIn" style="padding: 2rem">
    <SignIn />
  </div>

  <div v-else-if="showOrgSwitcher || !orgId" style="padding: 2rem; font-family: sans-serif">
    <p>Pick or create a company to continue.</p>
    <OrganizationSwitcher hide-personal />
  </div>

  <div v-else-if="error" style="padding: 2rem; color: red">
    {{ error }}
  </div>

  <AppWeb v-else @switch-organization="handleSwitchOrganization" />
</template>
