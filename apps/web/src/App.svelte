<!--
  ddtx shell.

  Three columns: catalogue, contents, canvas. The status strip runs across the top
  and is always present — it is a mode indicator, not a dismissible notice, because
  the difference between generated values and a real vehicle's values is the single
  most important fact on screen.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import Canvas from "./components/Canvas.svelte";
  import Catalogue from "./components/Catalogue.svelte";
  import Contents from "./components/Contents.svelte";
  import Trace from "./components/Trace.svelte";
  import { app, openDatabase, reconfigureDemo, refresh, setAutoRefresh } from "./lib/state.svelte.js";

  onMount(() => void openDatabase());

  /** What each fill mode actually does, in the user's terms. */
  const FILL_HELP: Record<string, string> = {
    canned: "Only the replies stored in the database. Many fields stay empty.",
    pad: "Stored replies, extended so every field has something to decode.",
    synthetic: "All values generated. Useful for checking layout and text length.",
  };
</script>

<div class="app">
  <div class="strip" role="status">
    <span class="badge">Demo</span>
    <span class="claim">
      Values are generated from the database. No vehicle is connected.
    </span>

    <label class="control">
      <span class="eyebrow">Fill</span>
      <select
        bind:value={app.fill}
        onchange={() => void reconfigureDemo()}
        title={FILL_HELP[app.fill]}
      >
        <option value="canned">Stored replies only</option>
        <option value="pad">Stored, padded</option>
        <option value="synthetic">All generated</option>
      </select>
    </label>

    <label class="control check">
      <input type="checkbox" bind:checked={app.drift} onchange={() => void reconfigureDemo()} />
      <span>Vary values</span>
    </label>

    <label class="control check">
      <input type="checkbox" bind:checked={app.inspect} />
      <span>Inspect layout</span>
    </label>

    <label class="control">
      <span class="eyebrow">Zoom</span>
      <select bind:value={app.zoom}>
        <option value={"fit"}>Fit width</option>
        <option value={200}>200%</option>
        <option value={150}>150%</option>
        <option value={100}>100% — native</option>
        <option value={75}>75%</option>
        <option value={50}>50%</option>
      </select>
    </label>

    <div class="spacer"></div>

    <label class="control check">
      <input
        type="checkbox"
        checked={app.autoRefresh}
        onchange={(event) => setAutoRefresh(event.currentTarget.checked)}
        disabled={app.screen === null}
      />
      <span>Keep reading</span>
    </label>

    <button class="read" onclick={() => void refresh()} disabled={app.screen === null || app.refreshing}>
      {app.refreshing ? "Reading…" : "Read now"}
    </button>
  </div>

  <main>
    <Catalogue />
    <Contents />

    <div class="stage">
      {#if app.phase === "loading"}
        <p class="notice">Loading the catalogue…</p>
      {:else if app.phase === "error"}
        <div class="notice error">
          <h2>The database tree isn't there</h2>
          <p>{app.error}</p>
          <pre>node tools/db-split/dist/index.js data/ecu.zip /tmp/ddtx-tree
DDTX_DB_TREE=/tmp/ddtx-tree pnpm --filter @ddtx/web dev</pre>
        </div>
      {:else if app.screen !== null}
        <div class="scroller">
          <Canvas
            screen={app.screen}
            snapshot={app.snapshot}
            inspect={app.inspect}
            zoom={app.zoom}
          />
        </div>
        <Trace snapshot={app.snapshot} />
      {:else}
        <p class="notice">
          {app.selected === null
            ? "Choose an ECU from the catalogue."
            : "Choose one of its screens."}
        </p>
      {/if}
    </div>
  </main>
</div>

<style>
  .app {
    display: grid;
    grid-template-rows: var(--strip-height) minmax(0, 1fr);
    height: 100%;
  }

  /* Navy strip with the marque's yellow badge — the same pairing the database
     uses for its own group captions. Turns vermilion when a vehicle is live. */
  .strip {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 0 12px;
    background: var(--navy);
    color: #dfe4ef;
    font-size: 11.5px;
  }

  .badge {
    padding: 2px 7px;
    background: var(--accent);
    color: var(--navy);
    font-size: 9.5px;
    font-weight: 800;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  .claim {
    color: #aab4c8;
  }

  .control {
    display: flex;
    align-items: center;
    gap: 5px;
    white-space: nowrap;
  }

  .control .eyebrow {
    color: #8b96ad;
  }

  .control.check {
    gap: 4px;
    cursor: pointer;
  }

  .strip select {
    background: rgba(255, 255, 255, 0.1);
    color: #eef1f7;
    border: 1px solid rgba(255, 255, 255, 0.22);
    border-radius: 0;
    padding: 2px 4px;
    font-size: 11.5px;
  }

  .strip input[type="checkbox"] {
    accent-color: var(--accent);
    margin: 0;
  }

  .spacer {
    flex: 1;
  }

  .read {
    padding: 3px 11px;
    background: var(--accent);
    color: var(--navy);
    border: 0;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.04em;
  }

  .read:disabled {
    background: rgba(255, 255, 255, 0.14);
    color: #7d88a0;
    cursor: not-allowed;
  }

  main {
    display: grid;
    grid-template-columns: 288px 244px minmax(0, 1fr);
    min-height: 0;
  }

  .stage {
    display: grid;
    grid-template-rows: minmax(0, 1fr) minmax(120px, 34%);
    min-width: 0;
    min-height: 0;
  }

  .scroller {
    overflow: auto;
    min-height: 0;
  }

  .notice {
    grid-row: 1 / -1;
    align-self: center;
    justify-self: center;
    max-width: 46ch;
    padding: 20px;
    color: var(--ink-soft);
    text-align: center;
  }

  .notice.error {
    text-align: left;
    background: var(--card);
    border: 1px solid var(--rule);
    border-left: 3px solid var(--live);
    max-width: 62ch;
  }

  .notice.error h2 {
    margin: 0 0 6px;
    font-size: 14px;
    color: var(--ink);
  }

  .notice pre {
    margin: 12px 0 0;
    padding: 9px 10px;
    background: var(--paper);
    border: 1px solid var(--rule-soft);
    font-family: var(--mono);
    font-size: 11px;
    white-space: pre-wrap;
    color: var(--ink);
  }

  /* Below a laptop, the two index columns stack above the stage rather than
     squeezing the canvas, which is the one thing that must stay legible. */
  @media (max-width: 1100px) {
    main {
      grid-template-columns: 1fr 1fr;
      grid-template-rows: 240px minmax(0, 1fr);
    }
    .stage {
      grid-column: 1 / -1;
    }
  }
</style>
