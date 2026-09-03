<!--
  Searchable vehicle picker.

  139 vehicles is past the point where a plain `<select>` works — you can't scan
  it, and native type-ahead only matches from the first character, so "megane"
  finds nothing under "Renault Megane II". A combobox lets the list be filtered
  by any part of the name.

  It matches the **code** as well as the model name, because both audiences are
  real: someone reading a repair manual knows "Megane II", and someone reading the
  database knows "x84". Typing either finds it.

  Built rather than borrowed: a `<datalist>` can only round-trip its visible text,
  and the value here has to stay the project code the index matches on.
-->
<script lang="ts">
  import type { Facet } from "../lib/state.svelte.js";
  import { ui } from "../lib/ui.svelte.js";

  interface Props {
    vehicles: Facet[];
    /** The selected project code, or "" for no vehicle filter. */
    value: string;
    onselect: (code: string) => void;
  }

  const { vehicles, value, onselect }: Props = $props();

  const ANY = $derived({ value: "", label: ui("vehicle.any"), count: 0 });

  let open = $state(false);
  let query = $state("");
  let highlighted = $state(0);
  let input = $state<HTMLInputElement | null>(null);

  const selected = $derived(vehicles.find((v) => v.value === value) ?? ANY);

  const matches = $derived.by(() => {
    const needle = query.trim().toLowerCase();
    if (needle === "") return [ANY, ...vehicles];
    const hits = vehicles.filter(
      (v) => v.label.toLowerCase().includes(needle) || v.value.toLowerCase().includes(needle),
    );
    return hits;
  });

  function show(): void {
    open = true;
    query = "";
    highlighted = 0;
  }

  function hide(): void {
    open = false;
    query = "";
  }

  function choose(code: string): void {
    onselect(code);
    hide();
    input?.blur();
  }

  function onkeydown(event: KeyboardEvent): void {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        show();
        return;
      }
      const step = event.key === "ArrowDown" ? 1 : -1;
      const last = matches.length - 1;
      if (last < 0) return;
      highlighted = Math.min(last, Math.max(0, highlighted + step));
      return;
    }
    if (event.key === "Enter") {
      if (!open) return;
      event.preventDefault();
      const pick = matches[highlighted];
      if (pick !== undefined) choose(pick.value);
      return;
    }
    if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        hide();
      }
    }
  }
</script>

<div class="picker">
  <span class="eyebrow" id="vehicle-label">{ui("vehicle.label")}</span>
  <div class="field">
    <input
      bind:this={input}
      type="text"
      role="combobox"
      aria-expanded={open}
      aria-controls="vehicle-list"
      aria-labelledby="vehicle-label"
      aria-autocomplete="list"
      autocomplete="off"
      placeholder={selected.label}
      value={open ? query : selected.label}
      oninput={(event) => {
        query = event.currentTarget.value;
        open = true;
        highlighted = 0;
      }}
      onfocus={show}
      onblur={hide}
      {onkeydown}
    />
    {#if value !== ""}
      <!-- Clearing is one click, not "scroll back to the top of the list". -->
      <button
        class="clear"
        title={ui("vehicle.showAll")}
        onpointerdown={(event) => {
          event.preventDefault();
          choose("");
        }}
      >
        <span aria-hidden="true">×</span>
        <span class="sr">{ui("vehicle.showAll")}</span>
      </button>
    {/if}
  </div>

  {#if open}
    <ul class="list" id="vehicle-list" role="listbox" aria-labelledby="vehicle-label">
      {#if matches.length === 0}
        <li class="none">{ui("vehicle.noMatch", { query })}</li>
      {/if}
      {#each matches as match, i (match.value)}
        <li>
          <!-- `onpointerdown` rather than `onclick`: the input's blur would close
               the list before a click landed. -->
          <button
            role="option"
            aria-selected={match.value === value}
            class:highlighted={i === highlighted}
            onpointerdown={(event) => {
              event.preventDefault();
              choose(match.value);
            }}
            onpointerenter={() => (highlighted = i)}
          >
            <span class="label">{match.label}</span>
            {#if match.value !== ""}
              <span class="code hex">{match.value}</span>
              <span class="count">{match.count}</span>
            {/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .picker {
    position: relative;
    display: grid;
    gap: 3px;
  }

  .field {
    position: relative;
    display: flex;
  }

  input {
    width: 100%;
    padding: 6px 8px;
    background: #fff;
    border: 1px solid var(--rule);
    border-radius: 0;
  }

  input:focus {
    border-color: var(--blue);
  }

  .clear {
    position: absolute;
    top: 1px;
    right: 1px;
    bottom: 1px;
    width: 24px;
    background: none;
    border: 0;
    color: var(--ink-faint);
    font-size: 15px;
    line-height: 1;
  }

  .clear:hover {
    color: var(--red);
  }

  .list {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    z-index: 20;
    max-height: 300px;
    overflow-y: auto;
    margin: 2px 0 0;
    padding: 0;
    list-style: none;
    background: #fff;
    border: 1px solid var(--blue);
    box-shadow: 0 8px 20px rgba(16, 21, 28, 0.18);
  }

  .list button {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    gap: 8px;
    align-items: baseline;
    width: 100%;
    padding: 5px 8px;
    background: none;
    border: 0;
    text-align: left;
    font-size: 12px;
  }

  .list button.highlighted {
    background: var(--blue);
    color: #fff;
  }

  .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .code {
    color: var(--ink-faint);
  }

  .list button.highlighted .code,
  .list button.highlighted .count {
    color: #c9cbee;
  }

  .count {
    color: var(--ink-faint);
    font-variant-numeric: tabular-nums;
  }

  .none {
    padding: 8px;
    color: var(--ink-soft);
    font-size: 12px;
  }

  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
</style>
