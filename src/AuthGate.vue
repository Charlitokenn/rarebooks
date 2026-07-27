<script setup lang="ts">
import { SignIn, OrganizationSwitcher, useAuth } from '@clerk/vue';
import { ref, watch } from 'vue';
import { fyo } from 'src/initFyoWeb';
import { setClerkTokenGetter } from 'fyo/demux/dbWeb';
import { initializeInstance } from 'src/utils/initialization';

const { isSignedIn, isLoaded, orgId, getToken } = useAuth();

const status = ref('Waiting for Clerk...');
const ready = ref(false);
const error = ref<string | null>(null);
const tableCount = ref(0);

let initStarted = false;

watch(
  [isLoaded, isSignedIn, orgId],
  async ([loaded, signedIn, activeOrgId]) => {
    if (!loaded) {
      status.value = 'Waiting for Clerk...';
      return;
    }
    if (!signedIn) {
      status.value = 'Signed out';
      return;
    }
    if (!activeOrgId) {
      status.value = 'Signed in - pick or create an organization below';
      return;
    }
    if (initStarted) {
      return;
    }
    initStarted = true;

    try {
      // Must happen before any fyo.db.* call - see dbWeb.ts's comment on why this can't be
      // wired at Fyo-construction time instead.
      setClerkTokenGetter(() => getToken.value());

      status.value = `Connecting to your organization's database...`;
      const dbPath = 'web'; // ignored by DatabaseDemuxWeb - the org IS the database
      const countryCode = await fyo.db.createNewDatabase(dbPath, 'TZ');

      status.value = 'Loading schema and registering models...';
      await initializeInstance(dbPath, true, countryCode, fyo);

      tableCount.value = Object.keys(fyo.schemaMap).length;
      status.value = `Connected. Country: ${countryCode}. ${tableCount.value} schemas loaded.`;
      ready.value = true;
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      status.value = 'Failed to initialize';
    }
  },
  { immediate: true },
);
</script>

<template>
  <div style="padding: 2rem; font-family: sans-serif">
    <div v-if="!isLoaded">Loading Clerk...</div>

    <div v-else-if="!isSignedIn">
      <SignIn />
    </div>

    <div v-else-if="!orgId">
      <p>{{ status }}</p>
      <OrganizationSwitcher hide-personal />
    </div>

    <div v-else>
      <p>{{ status }}</p>
      <p v-if="error" style="color: red">{{ error }}</p>

      <!--
        This is a smoke-test shell proving auth -> org -> DatabaseDemuxWeb -> schema fetch
        all work end to end - not the real app UI. The actual Desk/DatabaseSelector/
        SetupWizard screen flow from App.vue still needs adapting on top of this (see the
        chat response this file was delivered with for exactly what's still open).
      -->
      <div v-if="ready">
        <p>Plumbing verified. {{ tableCount }} tables in schema map.</p>
        <OrganizationSwitcher hide-personal />
      </div>
    </div>
  </div>
</template>
