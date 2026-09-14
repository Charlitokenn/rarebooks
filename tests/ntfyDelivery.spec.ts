import test from 'tape';
import sinon from 'sinon';
import type { Fyo } from '../fyo';
import { sendNtfyNotification } from '../src/utils/ntfy';

function getFyo(topic = 'test-topic'): Fyo {
  return {
    singles: {
      POSSettings: {
        enableMobileNotifications: true,
        messageChannel: topic,
      },
    },
  } as unknown as Fyo;
}

function setFetch(fetch: typeof globalThis.fetch): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

test('sendNtfyNotification reports successful delivery', async (t) => {
  const restoreFetch = setFetch((async () => ({
    ok: true,
  })) as unknown as typeof globalThis.fetch);

  try {
    t.equal(await sendNtfyNotification(getFyo(), 'message'), true);
  } finally {
    restoreFetch();
  }
});

test('sendNtfyNotification reports invalid topics', async (t) => {
  t.equal(await sendNtfyNotification(getFyo('bad topic'), 'message'), false);
});

test('sendNtfyNotification reports non-ok responses', async (t) => {
  const restoreFetch = setFetch((async () => ({
    ok: false,
    text: async () => 'rejected',
  })) as unknown as typeof globalThis.fetch);

  try {
    t.equal(await sendNtfyNotification(getFyo(), 'message'), false);
  } finally {
    restoreFetch();
  }
});

test('sendNtfyNotification reports network errors', async (t) => {
  const restoreFetch = setFetch((async () => {
    throw new Error('offline');
  }) as typeof globalThis.fetch);

  try {
    t.equal(await sendNtfyNotification(getFyo(), 'message'), false);
  } finally {
    restoreFetch();
  }
});

test('sendNtfyNotification reports timeouts', async (t) => {
  const clock = sinon.useFakeTimers();
  const restoreFetch = setFetch(
    ((_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      })) as typeof globalThis.fetch
  );

  try {
    const delivery = sendNtfyNotification(getFyo(), 'message');
    await clock.tickAsync(8000);
    t.equal(await delivery, false);
  } finally {
    restoreFetch();
    clock.restore();
  }
});
