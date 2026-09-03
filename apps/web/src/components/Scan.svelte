<!--
  What the vehicle actually has.

  The catalogue lists 1,580 ECUs and a van has a couple of dozen. A sweep asks each
  functional address who it is, so this panel is the answer to "what am I looking
  at" — which is the first question at a car and the one the catalogue cannot
  answer.

  Only appears with a vehicle attached, because there is nothing to sweep otherwise.
-->
<script lang="ts">
  import { app, openScanResult, startScan, stopScan } from "../lib/state.svelte.js";
  import { ui } from "../lib/ui.svelte.js";

  const vehicle = $derived(app.project === "" ? "every mapped address" : app.project);
</script>

<section class="scan">
  <header>
    <span class="eyebrow">{ui("scan.title")}</span>
    {#if app.scanning}
      <button class="stop" onclick={stopScan}>{ui("scan.stop")}</button>
    {:else}
      <button class="go" onclick={() => void startScan()}>
        {ui("scan.sweep", { vehicle })}
      </button>
    {/if}
  </header>

  {#if app.scanning && app.scanProgress !== null}
    <p class="progress">
      {ui("scan.probed", {
        done: app.scanProgress.done,
        count: app.scanProgress.total,
      })}
    </p>
  {:else if app.scanSummary !== null}
    <p class="progress">{app.scanSummary}</p>
  {:else}
    <p class="progress hint">
      {ui("scan.hint")}
    </p>
  {/if}

  {#if app.scanFound.length > 0}
    <ul>
      {#each app.scanFound as result (result.bus + result.address)}
        {@const named = result.matches[0]}
        <li>
          <button
            disabled={named === undefined}
            title={named === undefined
              ? ui("scan.unrecognisedTitle")
              : ui("scan.openTitle", { name: named.ecuname })}
            onclick={() => void openScanResult(result)}
          >
            <span class="addr hex">{result.address}</span>
            <span class="what">
              {named?.ecuname ?? result.name ?? ui("scan.unknown")}
              {#if named === undefined}<span class="tag">{ui("scan.unrecognised")}</span>{/if}
              {#if named?.quality === "approximate"}<span class="tag soft">{ui("scan.approximate")}</span>{/if}
            </span>
            <span class="meta">
              {result.bus}
              {#if result.identity !== undefined}
                {ui("scan.identity", {
                  supplier: result.identity.supplier || "?",
                  soft: result.identity.soft || "?",
                })}
              {/if}
            </span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .scan {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-bottom: 1px solid var(--rule);
    background: var(--card);
  }

  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px 6px;
  }

  .go,
  .stop {
    margin-left: auto;
    padding: 3px 9px;
    border: 1px solid var(--rule);
    background: none;
    font-size: 11px;
  }

  .go:hover {
    border-color: var(--blue);
    color: var(--blue);
  }

  /* Stopping a sweep is the one urgent control here. */
  .stop {
    border-color: var(--red);
    color: var(--red);
  }

  .progress {
    margin: 0;
    padding: 0 14px 10px;
    font-size: 11px;
    color: var(--ink-soft);
  }

  .progress.hint {
    line-height: 1.35;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    max-height: 40vh;
    border-top: 1px solid var(--rule-soft);
  }

  li + li button {
    border-top: 1px solid var(--rule-soft);
  }

  button {
    display: grid;
    grid-template-columns: 30px 1fr;
    grid-template-areas: "addr what" ". meta";
    gap: 1px 9px;
    width: 100%;
    padding: 6px 14px;
    background: none;
    border: 0;
    text-align: left;
  }

  /* See the note in Settings.svelte: `:where()` keeps this below class hovers. */
  button:hover:where(:not(:disabled)) {
    background: var(--paper);
  }

  button:disabled {
    cursor: default;
  }

  .addr {
    grid-area: addr;
    color: var(--blue);
    font-weight: 600;
  }

  .what {
    grid-area: what;
    font-size: 12px;
    line-height: 1.3;
  }

  .meta {
    grid-area: meta;
    font-size: 10.5px;
    color: var(--ink-faint);
  }

  .tag {
    display: inline-block;
    margin-left: 5px;
    padding: 0 4px;
    background: var(--red);
    color: #fff;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    vertical-align: 1px;
  }

  /* An approximate match is a caveat, not a fault. */
  .tag.soft {
    background: var(--ink-faint);
  }
</style>
