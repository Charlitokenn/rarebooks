<!--
  Web-only org creation page. Creating the org here is what triggers Clerk's
  organization.created webhook (worker/routes/webhooks/organization-created.ts),
  which provisions the tenant Neon project. That provisioning is async, so
  this always routes to /dashboard next — Dashboard.vue itself polls until
  the tenant project is READY (AC-5), it doesn't assume it's ready already.

  Mounts clerk.mountCreateOrganization() directly (bundled @clerk/clerk-js,
  see src/web/clerk.ts) rather than @clerk/vue's <CreateOrganization />
  component — same underlying UI, different loading mechanism.

  Spec: docs/specs/0001-web-platform-foundation-control-plane.md
-->
<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { clerk, useClerkAuth } from 'src/web/clerk';

const router = useRouter();
const { isLoaded, isSignedIn } = useClerkAuth();
const el = ref<HTMLDivElement>();

onMounted(() => {
  watch(
    isLoaded,
    (loaded) => {
      if (!loaded) return;
      if (!isSignedIn.value) {
        void router.replace('/sign-in');
        return;
      }
      if (el.value) {
        clerk.mountCreateOrganization(el.value, {
          afterCreateOrganizationUrl: '/dashboard',
        });
      }
    },
    { immediate: true }
  );
});

onUnmounted(() => {
  if (el.value) clerk.unmountCreateOrganization(el.value);
});
</script>

<template>
  <div class="flex items-center justify-center h-screen">
    <div ref="el"></div>
  </div>
</template>
