<!--
  The selected ECU's screens, grouped by category as the database groups them.

  Category order is the database's own, and it is meaningful — "Lecture" before
  "Configuration", diagnostics before end-of-line tests — so it is preserved
  rather than sorted alphabetically.
-->
<script lang="ts">
  import { projectLabel } from "@ddtx/core";
  import { app, openScreen } from "../lib/state.svelte.js";

  /** Models this ECU is fitted to, named rather than coded. */
  const vehicles = $derived(
    (app.selected?.projects ?? [])
      .filter((code) => code !== "" && !code.startsWith("#"))
      .map(projectLabel)
      .join(" · "),
  );
</script>

<section class="contents">
  {#if app.selected === null}
    <p class="empty">Pick an ECU to see its screens.</p>
  {:else}
    <header>
      <span class="eyebrow">{app.selected.group}</span>
      <h2>{app.selected.ecuname}</h2>
      <dl>
        <div><dt class="eyebrow">Addr</dt><dd class="hex">{app.selected.address}</dd></div>
        <div><dt class="eyebrow">Bus</dt><dd>{app.selected.protocol || "unset"}</dd></div>
        {#if app.ecuPhase === "ready"}
          <div><dt class="eyebrow">Requests</dt><dd class="hex">{app.requestCount}</dd></div>
          <div><dt class="eyebrow">Values</dt><dd class="hex">{app.dataCount}</dd></div>
          {#if app.testerPresent !== null}
            <div>
              <dt class="eyebrow">Keepalive</dt>
              <dd class="hex">{app.testerPresent}</dd>
            </div>
          {/if}
        {:else}
          <!-- A count of 0 would be a claim, not a placeholder. -->
          <div><dt class="eyebrow">Requests</dt><dd class="pending">—</dd></div>
          <div><dt class="eyebrow">Values</dt><dd class="pending">—</dd></div>
        {/if}
      </dl>
      {#if vehicles !== ""}
        <p class="vehicles">{vehicles}</p>
      {/if}

      {#if app.layoutWarnings > 0}
        <p class="warn">
          {app.layoutWarnings} reference{app.layoutWarnings === 1 ? "" : "s"} in this ECU's screens
          don't resolve and were left out.
        </p>
      {/if}
    </header>

    {#if app.ecuPhase === "loading"}
      <p class="empty">Loading definitions…</p>
    {:else}
      <nav>
        {#each app.categories as category (category.name)}
          <div class="category">
            <h3>{category.name}</h3>
            <ul>
              {#each category.screens as name (name)}
                <li>
                  <button class:current={app.screen?.name === name} onclick={() => void openScreen(name)}>
                    {name}
                  </button>
                </li>
              {/each}
            </ul>
          </div>
        {/each}
      </nav>
    {/if}
  {/if}
</section>

<style>
  .contents {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-right: 1px solid var(--rule);
    background: var(--card);
  }

  header {
    padding: 12px 14px;
    border-bottom: 1px solid var(--rule);
  }

  .vehicles {
    margin: 9px 0 0;
    font-size: 11px;
    color: var(--ink-soft);
    line-height: 1.35;
  }

  h2 {
    margin: 2px 0 9px;
    font-size: 15px;
    font-weight: 600;
    line-height: 1.25;
  }

  dl {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
    margin: 0;
  }

  dl div {
    display: grid;
    gap: 0;
  }

  dt {
    margin: 0;
  }

  dd {
    margin: 0;
    font-size: 12px;
  }

  .pending {
    color: var(--ink-faint);
  }

  .warn {
    margin: 10px 0 0;
    padding: 6px 8px;
    background: var(--paper);
    border-left: 3px solid var(--red);
    font-size: 11px;
    color: var(--ink-soft);
  }

  nav {
    overflow-y: auto;
    flex: 1;
    min-height: 0;
    padding-bottom: 16px;
  }

  .category {
    padding-top: 10px;
  }

  h3 {
    margin: 0;
    padding: 0 14px 4px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--ink);
    border-bottom: 1px solid var(--rule-soft);
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  button {
    display: block;
    width: 100%;
    padding: 5px 14px 5px 20px;
    background: none;
    border: 0;
    text-align: left;
    font-size: 12px;
    line-height: 1.3;
  }

  button:hover {
    background: var(--paper);
  }

  button.current {
    background: var(--blue);
    color: #fff;
  }

  .empty {
    margin: 0;
    padding: 16px 14px;
    color: var(--ink-soft);
    font-size: 12px;
  }
</style>
