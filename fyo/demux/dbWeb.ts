import { DatabaseError } from 'fyo/utils/errors';
import { SchemaMap } from 'schemas/types';
import { DatabaseDemuxBase, DatabaseMethod } from 'utils/db/types';

// The web counterpart to fyo/demux/db.ts's Electron-only DatabaseDemux. Passed into Fyo's
// constructor via conf.DatabaseDemux (see fyo/core/dbHandler.ts's `new Demux(fyo.isElectron)`
// branch) instead of the default. Talks to the rarebooks-api Worker over fetch() instead of
// ipc.db.*.
//
// dbHandler.ts always instantiates this as `new Demux(fyo.isElectron)` - a single argument,
// no room to also pass a Clerk token getter through that call site. So the getter is wired
// via a module-level setter instead (setClerkTokenGetter, called once from rendererWeb.ts
// right after the Clerk plugin is installed, before the app mounts) rather than through the
// constructor.
let clerkGetToken: (() => Promise<string | null>) | null = null;

export function setClerkTokenGetter(getToken: () => Promise<string | null>) {
  clerkGetToken = getToken;
}

export class DatabaseDemuxWeb extends DatabaseDemuxBase {
  constructor(_isElectron: boolean) {
    super();
  }

  async #request(path: string, body?: unknown): Promise<unknown> {
    if (!clerkGetToken) {
      throw new DatabaseError(
        'setClerkTokenGetter() has not been called yet - see rendererWeb.ts',
      );
    }

    const token = await clerkGetToken();
    if (!token) {
      throw new DatabaseError('Not signed in - no Clerk session token available');
    }

    const apiBase = import.meta.env.VITE_API_BASE_URL as string;
    const res = await fetch(`${apiBase}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const json = (await res.json()) as {
      data?: unknown;
      error?: { name: string; message: string };
    };

    if (json.error) {
      throw new DatabaseError(`${json.error.name}: ${json.error.message}`);
    }
    return json.data;
  }

  async getSchemaMap(): Promise<SchemaMap> {
    return (await this.#request('/api/db/schema')) as SchemaMap;
  }

  // Both branches hit the same idempotent endpoint - see rarebooks-api's /api/db/connect,
  // which ensures the org's SystemSettings row exists and returns its countryCode either
  // way. There's no "create vs reconnect" distinction worth making here the way there was
  // for "pick a file vs it already exists" on the desktop app - the org IS the database,
  // and it either already has a SystemSettings row or this call gives it one.
  async createNewDatabase(_dbPath: string, _countryCode: string): Promise<string> {
    return (await this.#request('/api/db/connect')) as string;
  }

  async connectToDatabase(_dbPath: string): Promise<string> {
    return (await this.#request('/api/db/connect')) as string;
  }

  async call(method: DatabaseMethod, ...args: unknown[]): Promise<unknown> {
    return await this.#request('/api/db/call', { method, args });
  }

  async callBespoke(method: string, ...args: unknown[]): Promise<unknown> {
    return await this.#request('/api/db/bespoke', { method, args });
  }
}

