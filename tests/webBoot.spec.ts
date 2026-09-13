import sinon from 'sinon';
import test from 'tape';
import { Fyo } from '../fyo';
import { DatabaseHandler } from '../fyo/core/dbHandler';
import { DocHandler } from '../fyo/core/docHandler';
import { ensureWebFyoReady } from '../src/web/boot';

test('web boot cache is scoped to the active organization', async (t) => {
  let tenantStatus = 'READY';
  const fetchStub = sinon.stub(globalThis, 'fetch').callsFake(
    async () =>
      ({
        status: 200,
        json: async () => ({ status: tenantStatus }),
      } as Response)
  );
  const connectStub = sinon
    .stub(DatabaseHandler.prototype, 'connectToDatabase')
    .callsFake(async function (this: DatabaseHandler) {
      this.dbPath = 'web';
      return 'READY';
    });
  const initializeStub = sinon
    .stub(Fyo.prototype, 'initializeAndRegister')
    .resolves();
  const getDocStub = sinon.stub(DocHandler.prototype, 'getDoc').resolves();

  try {
    const firstOrgBoot = ensureWebFyoReady('org-a');
    t.equal(
      ensureWebFyoReady('org-a'),
      firstOrgBoot,
      'same-org callers share the in-flight boot'
    );
    const firstOrgResult = await firstOrgBoot;
    t.equal(firstOrgResult.status, 'READY');
    t.equal(
      ensureWebFyoReady('org-a'),
      firstOrgBoot,
      'same-org callers reuse the READY boot'
    );

    const secondOrgBoot = ensureWebFyoReady('org-b');
    const secondOrgResult = await secondOrgBoot;
    t.notEqual(secondOrgBoot, firstOrgBoot, 'an org switch starts a new boot');
    t.notEqual(
      secondOrgResult.fyo,
      firstOrgResult.fyo,
      'an org switch recreates the shared Fyo'
    );

    tenantStatus = 'PROJECT_CREATED';
    const retryableResult = await ensureWebFyoReady('org-c');
    tenantStatus = 'READY';
    const retriedResult = await ensureWebFyoReady('org-c');
    t.equal(retryableResult.status, 'PROJECT_CREATED');
    t.equal(retriedResult.status, 'READY');
    t.equal(
      retriedResult.fyo,
      retryableResult.fyo,
      'same-org retries keep the fresh tenant-scoped Fyo'
    );
    t.equal(
      fetchStub.callCount,
      4,
      'only new and retryable boots fetch status'
    );
  } finally {
    fetchStub.restore();
    connectStub.restore();
    initializeStub.restore();
    getDocStub.restore();
  }
});
