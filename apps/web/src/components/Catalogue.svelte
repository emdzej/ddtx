<!--
  The ECU catalogue.

  1,580 entries, and nobody arrives knowing an ECU's name. They arrive knowing the
  car. So the vehicle picker is the only text field here — searching ECU names as
  well was a second way to do the same job, and the weaker one.

  Choosing a vehicle narrows Group to the systems that car actually has: 171
  groups is not a menu, it's a wall.

  Vehicles are labelled with the model name, not the project code the database
  stores: "Renault Megane II", not "x84". The code stays the value, because that
  is what the index matches on.

  Each row leads with the functional address in mono, because that is the thing
  you match against a scan result.
-->
<script lang="ts">
  import { projectLabel } from "@ddtx/core";
  import VehiclePicker from "./VehiclePicker.svelte";
  import {
    app,
    applyFilters,
    selectEcu,
    selectVehicle,
    setCatalogueOpen,
  } from "../lib/state.svelte.js";
  // Lucide (ISC), imported per icon so the rest of the pack is tree-shaken away.
  import PanelLeftClose from "@lucide/svelte/icons/panel-left-close";
  import PanelLeftOpen from "@lucide/svelte/icons/panel-left-open";
  import { ui } from "../lib/ui.svelte.js";
</script>

{#if !app.catalogueOpen}
  <!-- Collapsed: just enough to reopen, and to say what is selected. -->
  <section class="rail">
    <button
      class="toggle"
      onclick={() => setCatalogueOpen(true)}
      title={ui("cat.show")}
      aria-expanded="false"
    >
      <PanelLeftOpen size={16} strokeWidth={1.75} />
      <span class="sr">{ui("cat.show")}</span>
    </button>
    <!--
      No address here. It used to show `app.selected.address`, which in a 40px rail is a
      bare `00` with nothing to say what it counts — and the screen list immediately to
      the right already shows the same value under an `Addr` label. A duplicate stripped
      of the label that gave it meaning is worse than no duplicate.
    -->
    <span class="rail-label">{ui("cat.title")}</span>
  </section>
{:else}
<section class="catalogue">
  <header>
    <span class="eyebrow">{ui("cat.title")}</span>
    <span class="header-right">
      <span class="count hex">{app.resultTotal} / {app.ecuCount}</span>
      <button
        class="toggle"
        onclick={() => setCatalogueOpen(false)}
        title={ui("cat.hide")}
        aria-expanded="true"
      >
        <PanelLeftClose size={16} strokeWidth={1.75} />
        <span class="sr">{ui("cat.hide")}</span>
      </button>
    </span>
  </header>

  <div class="filters">
    <VehiclePicker vehicles={app.vehicles} value={app.project} onselect={selectVehicle} />

    <div class="selects">
      <label>
        <span class="eyebrow">{ui("cat.group")}</span>
        <select bind:value={app.group} onchange={applyFilters}>
          <option value="">{ui("cat.groupAll", { count: app.groups.length })}</option>
          {#each app.groups as group (group.value)}
            <option value={group.value}>{group.label} — {group.count}</option>
          {/each}
        </select>
      </label>
      <label>
        <span class="eyebrow">{ui("cat.bus")}</span>
        <select bind:value={app.protocol} onchange={applyFilters}>
          <option value="">{ui("cat.busAny")}</option>
          {#each app.protocols as protocol (protocol)}
            <option value={protocol}>{protocol || ui("cat.busUnset")}</option>
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
              <span class="projects" title={summary.projects.join(", ")}>
                {summary.projects
                  .filter((code) => !code.startsWith("#"))
                  .map(projectLabel)
                  .join(" · ")}
              </span>
            {/if}
          </span>
        </button>
      </li>
    {/each}
  </ul>

  {#if app.resultTotal > app.results.length}
    <p class="capped">
      {ui("cat.capped", { count: app.results.length })}
    </p>
  {:else if app.resultTotal === 0 && app.phase === "ready"}
    <p class="capped">{ui("cat.none")}</p>
  {/if}
</section>
{/if}

<style>
  /* Screen-reader-only text for the icon-only toggles. */
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .rail {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    padding: 10px 0;
    border-right: 1px solid var(--rule);
    background: var(--card);
  }

  /* Rotated so the rail is identifiable without needing width for it. */
  .rail-label {
    writing-mode: vertical-rl;
    font-size: 9.5px;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--ink-faint);
  }

  /*
    An icon button, so no border: the glyph is the whole control, and a box around it
    reads as a second, empty element sitting beside the count. The hover tint carries
    the affordance instead.
  */
  .toggle {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    padding: 0;
    background: none;
    border: 0;
    color: var(--ink-faint);
  }

  .toggle:hover {
    background: var(--paper);
    color: var(--blue);
  }

  .header-right {
    display: flex;
    align-items: center;
    gap: 8px;
  }

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

  .selects {
    display: grid;
    grid-template-columns: 1fr 84px;
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
    background: var(--paper);
  }

  /* Selection is blue, never red: red in this app means something needs
     attention, and a row you chose does not. */
  button.current {
    background: var(--paper);
    box-shadow: inset 3px 0 0 var(--blue);
  }

  .addr {
    grid-area: addr;
    color: var(--blue);
    font-weight: 600;
  }

  .name {
    grid-area: name;
    font-size: 12.5px;
    line-height: 1.3;
    /*
      Without this the row's min-content width is the longest unbreakable identifier,
      which pushes the grid column wider than the panel and spills the name over the
      divider. Broken, not ellipsed — see the note on the same rule in Contents.
    */
    min-width: 0;
    overflow-wrap: anywhere;
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
