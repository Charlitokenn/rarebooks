<!--
  Web-only sign-in page (AC-1: a user can sign up and sign in via Clerk).

  Mounts clerk.mountSignIn() directly (bundled @clerk/clerk-js, see
  src/web/clerk.ts) rather than @clerk/vue's <SignIn /> component — same
  underlying UI, different loading mechanism.

  Spec: docs/specs/0001-web-platform-foundation-control-plane.md
-->
<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { clerk } from 'src/web/clerk';

const el = ref<HTMLDivElement>();

onMounted(() => {
  if (!el.value) return;
  clerk.mountSignIn(el.value, {
    fallbackRedirectUrl: '/dashboard',
    signUpUrl: '/sign-up',
  });
});

onUnmounted(() => {
  if (el.value) clerk.unmountSignIn(el.value);
});
</script>

<template>
  <div class="flex items-center justify-center h-screen">
    <div ref="el"></div>
  </div>
</template>
