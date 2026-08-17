<!--
  The ECU catalogue.

  1,580 entries, and the useful way in is rarely by name — it's "what's at address
  26 on an X90", or "show me everything in the Injection group". So the filters are
  the primary control and the search box is one of four peers, not a hero.

  Each row leads with the functional address in mono, because that is the thing
  you match against a scan result.
-->
<script lang="ts">
  import { app, applyFilters, selectEcu } from "../lib/state.svelte.js";
</script>

<section class="catalogue">
  <header>
    <span class="eyebrow">Catalogue</span>
    <span class="count hex">{app.resultTotal} / {app.ecuCount}</span>
  </header>

  <div class="filters">
    <input
      type="search"
      placeholder="Name contains…"
      bind:value={app.search}
      oninput={applyFilters}
    />
    <div class="selects">
      <label>
        <span class="eyebrow">Group</span>
        <select bind:value={app.group} onchange={applyFilters}>
          <option value="">All {app.groups.length}</option>
          {#each app.groups as group (group)}
            <option value={group}>{group}</option>
          {/each}
        </select>
      </label>
      <label>
        <span class="eyebrow">Vehicle</span>
        <select bind:value={app.project} onchange={applyFilters}>
          <option value="">All {app.projects.length}</option>
          {#each app.projects as project (project)}
            <option value={project}>{project}</option>
          {/each}
        </select>
      </label>
      <label>
        <span class="eyebrow">Bus</span>
        <select bind:value={app.protocol} onchange={applyFilters}>
          <option value="">Any</option>
          {#each app.protocols as protocol (protocol)}
            <option value={protocol}>{protocol || "unset"}</option>
          {/each}
        </select>
      </label>
    </div>
  </div>

  <ul>
    {#each app.results as summary (summary.slug)}
      <li>
        <button
          class:current={app.selected?.slug === summary.slug}
          onclick={() => void selectEcu(summary)}
        >
          <span class="addr hex">{summary.address}</span>
          <span class="name">{summary.ecuname}</span>
          <span class="meta">
            <span class="group">{summary.group}</span>
            {#if summary.projects.length > 0}
              <span class="projects">{summary.projects.slice(0, 6).join(" ")}</span>
            {/if}
          </span>
        </button>
      </li>
    {/each}
  </ul>

  {#if app.resultTotal > app.results.length}
    <p class="capped">
      Showing the first {app.results.length}. Narrow the filters to see the rest.
    </p>
  {:else if app.resultTotal === 0 && app.phase === "ready"}
    <p class="capped">Nothing matches. Clear a filter to widen the search.</p>
  {/if}
</section>

<style>
  .catalogue {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-right: 1px solid var(--rule);
    background: var(--card);
  }

  header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding: 12px 14px 8px;
  }

  .count {
    color: var(--ink-faint);
  }

  .filters {
    padding: 0 14px 12px;
    border-bottom: 1px solid var(--rule);
    display: grid;
    gap: 8px;
  }

  input[type="search"] {
    width: 100%;
    padding: 6px 8px;
    background: #fff;
    border: 1px solid var(--rule);
    border-radius: 0;
  }

  .selects {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 6px;
  }

  label {
    display: grid;
    gap: 3px;
    min-width: 0;
  }

  select {
    width: 100%;
    padding: 4px 2px;
    background: #fff;
    border: 1px solid var(--rule);
    border-radius: 0;
    font-size: 12px;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    flex: 1;
    min-height: 0;
  }

  li + li button {
    border-top: 1px solid var(--rule-soft);
  }

  button {
    display: grid;
    grid-template-columns: 34px 1fr;
    grid-template-areas: "addr name" ". meta";
    gap: 1px 9px;
    width: 100%;
    padding: 7px 14px;
    background: none;
    border: 0;
    text-align: left;
  }

  button:hover {
    background: #fff;
  }

  /* The current row is marked with the marque's yellow on the leading edge —
     one accent, used once. */
  button.current {
    background: #fff;
    box-shadow: inset 3px 0 0 var(--accent);
  }

  .addr {
    grid-area: addr;
    color: var(--navy);
    font-weight: 600;
  }

  .name {
    grid-area: name;
    font-size: 12.5px;
    line-height: 1.3;
  }

  .meta {
    grid-area: meta;
    display: flex;
    gap: 8px;
    font-size: 10.5px;
    color: var(--ink-faint);
    min-width: 0;
  }

  .group {
    white-space: nowrap;
  }

  .projects {
    font-family: var(--mono);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .capped {
    margin: 0;
    padding: 10px 14px;
    border-top: 1px solid var(--rule);
    font-size: 11px;
    color: var(--ink-soft);
  }
</style>
