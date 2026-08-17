/**
 * Where the split database tree is read from.
 *
 * Deliberately one method wide. The equivalent abstraction in the bimmerz
 * packages (`@emdzej/bimmerz-vfs`) is richer — directory listing, FSA, OPFS —
 * but it is licensed PolyForm Noncommercial and this project is GPL-3.0, so it
 * cannot be a dependency (docs/plan.md §5.1). The tree is a flat set of known
 * paths behind an index, so listing is never needed and reimplementing the read
 * is a dozen lines.
 */

export interface DbSource {
  /**
   * Read a path relative to the tree root, e.g. `ecu/BCM95_SW990.json`.
   * Rejects if the path is absent — callers treat that as a hard error, since
   * every path they request came out of the index.
   */
  read(path: string): Promise<Uint8Array>;
}

/**
 * Reads over `fetch`. Works against any static host; expects the server to
 * negotiate the pre-compressed `.gz`/`.br` siblings that `db-split --compress`
 * emits, which is what turns a 352 KB definition file into ~18 KB on the wire.
 */
export class HttpDbSource implements DbSource {
  private readonly fetchImpl: typeof fetch;

  /**
   * `baseUrl` may omit the trailing slash.
   *
   * `fetchImpl` is wrapped rather than stored directly. A bare `fetch` reference
   * held as a class field gets called with the instance as its receiver, which
   * browsers reject with "Illegal invocation" — `fetch` requires `window` (or no
   * receiver at all). Node is more forgiving, so this only shows up in a browser.
   */
  constructor(
    private readonly baseUrl: string,
    fetchImpl?: typeof fetch,
  ) {
    this.fetchImpl = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  async read(path: string): Promise<Uint8Array> {
    const url = `${this.baseUrl.replace(/\/$/, "")}/${path}`;
    const response = await this.fetchImpl(url);
    if (!response.ok) {
      throw new Error(`DbSource: ${response.status} ${response.statusText} for ${url}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }
}

/** In-memory source for tests and fixtures. */
export class MemoryDbSource implements DbSource {
  constructor(private readonly files: Map<string, Uint8Array | string>) {}

  static fromJson(files: Record<string, unknown>): MemoryDbSource {
    const encoder = new TextEncoder();
    return new MemoryDbSource(
      new Map(Object.entries(files).map(([k, v]) => [k, encoder.encode(JSON.stringify(v))])),
    );
  }

  read(path: string): Promise<Uint8Array> {
    const entry = this.files.get(path);
    if (entry === undefined) return Promise.reject(new Error(`DbSource: no such path ${path}`));
    return Promise.resolve(typeof entry === "string" ? new TextEncoder().encode(entry) : entry);
  }
}

/**
 * Wraps a source with a read-through cache.
 *
 * `store` is intentionally a plain async key/value interface so the browser app
 * can back it with OPFS or IndexedDB without this package knowing about either.
 */
export interface BlobStore {
  get(key: string): Promise<Uint8Array | undefined>;
  set(key: string, value: Uint8Array): Promise<void>;
}

export class CachedDbSource implements DbSource {
  constructor(
    private readonly inner: DbSource,
    private readonly store: BlobStore,
  ) {}

  async read(path: string): Promise<Uint8Array> {
    const hit = await this.store.get(path);
    if (hit !== undefined) return hit;
    const bytes = await this.inner.read(path);
    // A failed cache write must not fail the read — the data is already in hand.
    await this.store.set(path, bytes).catch(() => undefined);
    return bytes;
  }
}
