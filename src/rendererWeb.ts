import { clerkPlugin } from '@clerk/vue';
import { createApp } from 'vue';
import AuthGate from './AuthGate.vue';
import './styles/index.css';

// The web counterpart to src/renderer.ts. Deliberately does NOT reuse renderer.ts as-is:
// that file calls `await ipc.getEnv()` unconditionally as one of its first lines, and
// `registerIpcRendererListeners()` right before it - both hard Electron dependencies that
// would throw immediately on load here, since window.ipc doesn't exist in a browser tab.
// No router, no App.vue mount yet either - see the chat response this file shipped with
// for exactly what's still open before this becomes the real app shell.

const app = createApp(AuthGate);

app.use(clerkPlugin, {
  publishableKey: import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string,
});

app.mount('body');
