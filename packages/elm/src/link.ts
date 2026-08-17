/**
 * `EcuLink` over a real adapter.
 *
 * The point of this file is that it is short: `SimulatedLink` and `ElmLink` are
 * interchangeable behind the same interface, so the screen runtime and the whole
 * UI need no changes when a vehicle is attached. Demo mode stays the offline
 * development path rather than becoming dead code.
 */

import type { EcuLink, RequestHint } from "@ddtx/link";
import type { ElmDriver } from "./driver.js";

export class ElmLink implements EcuLink {
  readonly kind = "elm" as const;

  constructor(private readonly driver: ElmDriver) {}

  /** The hint is ignored: a real adapter only ever sees bytes. */
  async request(frame: string, _hint?: RequestHint): Promise<string> {
    return this.driver.request(frame);
  }

  clearCache(): void {
    this.driver.clearCache();
  }
}
