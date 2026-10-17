<!--
  Web-only sign-up page (AC-1). After sign-up, routed to /create-organization
  rather than straight to /dashboard, since AC-5 requires an org (and its
  provisioned tenant project) before the dashboard is reachable.

  Mounts clerk.mountSignUp() directly (bundled @clerk/clerk-js, see
  src/web/clerk.ts) rather than @clerk/vue's <SignUp /> component — same
  underlying UI, different loading mechanism.

  Spec: docs/specs/0001-web-platform-foundation-control-plane.md
-->
<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { clerk } from 'src/web/clerk';

const el = ref<HTMLDivElement>();

onMounted(() => {
  if (!el.value) return;
  clerk.mountSignUp(el.value, {
    fallbackRedirectUrl: '/create-organization',
    signInUrl: '/sign-in',
  });
});

onUnmounted(() => {
  if (el.value) clerk.unmountSignUp(el.value);
});
</script>

<template>
  <div class="flex items-center justify-center h-screen">
    <div ref="el"></div>
  </div>
</template>
