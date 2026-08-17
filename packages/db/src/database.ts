/**
 * The database façade: load the index once, then ECUs and screens on demand.
 *
 * Replaces `ecu_database.py` + `ecu_file.py`'s loading half. The original walks
 * the whole archive at startup and holds every target in memory; here the 118 KB
 * index is the only eager load and a 352 KB definition file is fetched when its
 * ECU is actually opened.
 */

import type {
  DataDef,
  DbTreeIndex,
  EcuFileDef,
  Endianness,
  IndexEntry,
  LayoutFileDef,
  RequestDef,
} from "@ddtx/core";
import { resolveDataDictionary, type BoundRequest, type ResolvedData } from "@ddtx/codec";
import { prepareLayout, type PreparedLayout } from "./layout.js";
import type { DbSource } from "./source.js";

/** An ECU's definitions, resolved and ready for the codec. */
export interface LoadedEcu {
  slug: string;
  def: EcuFileDef;
  endianness: Endianness | undefined;
  /** Data name → resolved definition, defaults applied. */
  data: ReadonlyMap<string, ResolvedData>;
  /** Request name → definition bound to this ECU's data dictionary. */
  requests: ReadonlyMap<string, BoundRequest>;
}

export interface EcuSummary extends IndexEntry {
  slug: string;
}

export interface EcuFilter {
  group?: string;
  project?: string;
  /** Functional address, hex; compared case-insensitively. */
  address?: string;
  protocol?: string;
  /** Substring match against `ecuname`, case-insensitive. */
  search?: string;
}

export class EcuDatabase {
  private readonly ecuCache = new Map<string, Promise<LoadedEcu>>();
  private readonly layoutCache = new Map<string, Promise<PreparedLayout>>();

  private constructor(
    readonly index: DbTreeIndex,
    private readonly source: DbSource,
  ) {}

  /** Fetch and parse `index.json`. */
  static async open(source: DbSource): Promise<EcuDatabase> {
    const index = await readJson<DbTreeIndex>(source, "index.json");
    if (index.format !== 1) {
      throw new Error(`EcuDatabase: unsupported index format ${String(index.format)}`);
    }
    return new EcuDatabase(index, source);
  }

  get groups(): readonly string[] {
    return this.index.groups;
  }

  get projects(): readonly string[] {
    return this.index.projects;
  }

  get protocols(): readonly string[] {
    return this.index.protocols;
  }

  get size(): number {
    return Object.keys(this.index.ecus).length;
  }

  summary(slug: string): EcuSummary | undefined {
    const entry = this.index.ecus[slug];
    return entry === undefined ? undefined : { slug, ...entry };
  }

  /** Filter the index. All criteria are ANDed; omitted ones don't constrain. */
  list(filter: EcuFilter = {}): EcuSummary[] {
    const address = filter.address?.trim().toUpperCase();
    const protocol = filter.protocol?.toUpperCase();
    const project = filter.project?.toUpperCase();
    const search = filter.search?.toLowerCase();

    const out: EcuSummary[] = [];
    for (const [slug, entry] of Object.entries(this.index.ecus)) {
      if (filter.group !== undefined && entry.group !== filter.group) continue;
      if (address !== undefined && entry.address.trim().toUpperCase() !== address) continue;
      if (protocol !== undefined && entry.protocol.toUpperCase() !== protocol) continue;
      if (project !== undefined && !entry.projects.some((p) => p.toUpperCase() === project)) {
        continue;
      }
      if (search !== undefined && !entry.ecuname.toLowerCase().includes(search)) continue;
      out.push({ slug, ...entry });
    }
    out.sort((a, b) => a.ecuname.localeCompare(b.ecuname));
    return out;
  }

  /**
   * Load an ECU's definitions. Cached by slug, including the in-flight promise,
   * so concurrent screen opens share one fetch.
   */
  loadEcu(slug: string): Promise<LoadedEcu> {
    const cached = this.ecuCache.get(slug);
    if (cached !== undefined) return cached;

    const pending = (async (): Promise<LoadedEcu> => {
      const def = await readJson<EcuFileDef>(this.source, `ecu/${slug}.json`);
      // `endian` is absent on some files; the codec treats undefined as Big.
      const endianness = def.endian;
      const data = resolveDataDictionary(def.data ?? {});

      const requests = new Map<string, BoundRequest>();
      for (const requestDef of def.requests ?? []) {
        requests.set(requestDef.name, { def: requestDef, endianness, data });
      }

      return { slug, def, endianness, data, requests };
    })();

    this.ecuCache.set(slug, pending);
    // Don't cache a rejection: a transient fetch failure should be retryable.
    pending.catch(() => this.ecuCache.delete(slug));
    return pending;
  }

  /**
   * Load an ECU's screens, with every cross-reference checked against its
   * definitions. Loads the ECU first if it isn't already cached, because
   * validation needs its request and data names.
   */
  loadLayout(slug: string): Promise<PreparedLayout> {
    const cached = this.layoutCache.get(slug);
    if (cached !== undefined) return cached;

    const pending = (async (): Promise<PreparedLayout> => {
      const [ecu, raw] = await Promise.all([
        this.loadEcu(slug),
        readJson<LayoutFileDef>(this.source, `layout/${slug}.json`),
      ]);
      const defs = new Map<string, RequestDef>();
      for (const [name, bound] of ecu.requests) defs.set(name, bound.def);
      return prepareLayout(raw, defs, new Set(ecu.data.keys()));
    })();

    this.layoutCache.set(slug, pending);
    pending.catch(() => this.layoutCache.delete(slug));
    return pending;
  }

  /** Drop cached definitions and screens. */
  clearCache(): void {
    this.ecuCache.clear();
    this.layoutCache.clear();
  }
}

/**
 * Look a request up by name, tolerating case differences.
 *
 * `ecu_file.get_request` falls back to a case-insensitive scan, and layouts do
 * rely on it — so a strict `Map.get` would fail to resolve real screens.
 */
export function getRequest(ecu: LoadedEcu, name: string): BoundRequest | undefined {
  const direct = ecu.requests.get(name);
  if (direct !== undefined) return direct;
  const lowered = name.toLowerCase();
  for (const [key, value] of ecu.requests) {
    if (key.toLowerCase() === lowered) return value;
  }
  return undefined;
}

async function readJson<T>(source: DbSource, path: string): Promise<T> {
  const bytes = await source.read(path);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

export type { DataDef };
