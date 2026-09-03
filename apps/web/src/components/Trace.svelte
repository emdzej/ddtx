<!--
  What went on the bus, and what came back.

  This is the panel that makes the difference between "the screen looks plausible"
  and "I know the screen is right", so frames are shown verbatim in mono, with the
  request name that produced them. It is also the panel that will matter most once
  a real vehicle is on the other end.
-->
<script lang="ts">
  import type { ScreenSnapshot } from "@ddtx/screens";
  import { app, setTraceOpen, t } from "../lib/state.svelte.js";
  import { ui } from "../lib/ui.svelte.js";
  import type { Exchange } from "@ddtx/screens";

  interface Props {
    snapshot: ScreenSnapshot | null;
  }

  const { snapshot }: Props = $props();

  /**
   * A button's exchanges first, then the refresh's.
   *
   * The press happens before the refresh that follows it, so this is chronological
   * — and it means a write is visible rather than buried under the reads that came
   * after it.
   */
  const rows = $derived<Array<{ exchange: Exchange; fromAction: boolean }>>([
    ...app.actionExchanges.map((exchange) => ({ exchange, fromAction: true })),
    ...(snapshot?.exchanges ?? []).map((exchange) => ({ exchange, fromAction: false })),
  ]);
</script>

<section class="trace" class:open={app.traceOpen}>
  <!-- The whole header is the toggle: it is the only control in this strip, so
       making just a caret clickable would be a smaller target for no reason. -->
  <button
    class="header"
    onclick={() => setTraceOpen(!app.traceOpen)}
    aria-expanded={app.traceOpen}
  >
    <span class="caret" aria-hidden="true">{app.traceOpen ? "▾" : "▸"}</span>
    <span class="eyebrow">{ui("trace.title")}</span>
    {#if snapshot !== null}
      <span class="hex">
        {ui("trace.exchanges", { count: rows.length, ms: snapshot.elapsedMs })}
        {#if app.actionExchanges.length > 0 && app.actionLabel !== null}{ui(
            "trace.including",
            { label: app.actionLabel },
          )}{/if}
      </span>
    {/if}
  </button>

  {#if !app.traceOpen}
    <!-- nothing: the header alone is the closed state -->
  {:else if snapshot === null}
    <p class="empty">{ui("trace.empty")}</p>
  {:else}
    <ol>
      {#each rows as row, i (i)}
        {@const exchange = row.exchange}
        <li
          class:rejected={exchange.rejected !== undefined}
          class:failed={exchange.error !== undefined}
          class:action={row.fromAction}
        >
          <span class="name" title={exchange.requestName}>
            {#if row.fromAction}<span class="tag">{ui("trace.sent")}</span>{/if}{t(
              "request",
              exchange.requestName,
            )}
          </span>
          <span class="frames">
            <span class="dir">→</span><span class="hex">{exchange.sent}</span>
            <span class="dir">←</span><span class="hex">{exchange.received || "—"}</span>
          </span>
          {#if exchange.rejected !== undefined}
            <span class="note">{exchange.rejected.code} {exchange.rejected.message}</span>
          {:else if exchange.error !== undefined}
            <span class="note">{exchange.error}</span>
          {/if}
        </li>
      {/each}
    </ol>
  {/if}
</section>

<style>
  .trace {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-top: 1px solid var(--rule);
    background: var(--card);
  }

  .header {
    display: flex;
    align-items: baseline;
    gap: 8px;
    width: 100%;
    padding: 7px 14px;
    background: none;
    border: 0;
    text-align: left;
  }

  .header:hover {
    background: var(--paper);
  }

  .trace.open .header {
    border-bottom: 1px solid var(--rule-soft);
  }

  .caret {
    color: var(--ink-faint);
    font-size: 9px;
  }

  .header .hex {
    margin-left: auto;
    color: var(--ink-faint);
  }

  ol {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    flex: 1;
    min-height: 0;
  }

  li {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 2px 12px;
    padding: 5px 14px;
    align-items: baseline;
  }

  li + li {
    border-top: 1px solid var(--rule-soft);
  }

  .name {
    font-size: 11.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .frames {
    display: flex;
    gap: 5px;
    align-items: baseline;
    white-space: nowrap;
  }

  .dir {
    color: var(--ink-faint);
    font-size: 10px;
  }

  .note {
    grid-column: 1 / -1;
    font-size: 10.5px;
    color: var(--ink-soft);
  }

  /* Both are attention, so both are red; the depth of the mark distinguishes a
     refusal the ECU gave from a link that fell over. */
  li.rejected {
    box-shadow: inset 3px 0 0 var(--red);
  }

  li.failed {
    box-shadow: inset 3px 0 0 var(--red);
    background: color-mix(in srgb, var(--red) 7%, transparent);
  }

  /* A button's own exchanges, distinguished from the refresh's reads. */
  li.action {
    box-shadow: inset 3px 0 0 var(--blue);
  }

  .tag {
    display: inline-block;
    margin-right: 5px;
    padding: 0 4px;
    background: var(--blue);
    color: #fff;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    vertical-align: 1px;
  }

  .empty {
    margin: 0;
    padding: 12px 14px;
    color: var(--ink-soft);
    font-size: 12px;
  }
</style>
