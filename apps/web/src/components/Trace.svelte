<!--
  What went on the bus, and what came back.

  This is the panel that makes the difference between "the screen looks plausible"
  and "I know the screen is right", so frames are shown verbatim in mono, with the
  request name that produced them. It is also the panel that will matter most once
  a real vehicle is on the other end.
-->
<script lang="ts">
  import type { ScreenSnapshot } from "@ddtx/screens";
  import { t } from "../lib/state.svelte.js";

  interface Props {
    snapshot: ScreenSnapshot | null;
  }

  const { snapshot }: Props = $props();
</script>

<section class="trace">
  <header>
    <span class="eyebrow">Bus trace</span>
    {#if snapshot !== null}
      <span class="hex">{snapshot.exchanges.length} exchanges · {snapshot.elapsedMs} ms</span>
    {/if}
  </header>

  {#if snapshot === null}
    <p class="empty">Open a screen to see its requests.</p>
  {:else}
    <ol>
      {#each snapshot.exchanges as exchange, i (i)}
        <li class:rejected={exchange.rejected !== undefined} class:failed={exchange.error !== undefined}>
          <span class="name" title={exchange.requestName}>{t("request", exchange.requestName)}</span>
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

  header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding: 8px 14px;
    border-bottom: 1px solid var(--rule-soft);
  }

  header .hex {
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

  .empty {
    margin: 0;
    padding: 12px 14px;
    color: var(--ink-soft);
    font-size: 12px;
  }
</style>
