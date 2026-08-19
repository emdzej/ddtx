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
  import DatabasePicker from "./components/DatabasePicker.svelte";
  import Plugins from "./components/Plugins.svelte";
  import Popover from "./components/Popover.svelte";
  import Settings from "./components/Settings.svelte";
  import Trace from "./components/Trace.svelte";
  import {
    loadPlugins,
    setPluginsOpen,
    VIEW_DEFAULTS,
    setSettingsOpen,
    app,
    benchLink,
    connect,
    disconnect,
    openDatabase,
    reconfigureDemo,
    refresh,
    setAutoRefresh,
    setLocale,
  } from "./lib/state.svelte.js";

  onMount(() => {
    void openDatabase();
    // Independent of the database: a plugin bundle can be present with no tree, and the
    // VIN calculator works either way.
    void loadPlugins();
  });

  /**
   * The mode indicator is read off reactive state, never set by hand.
   *
   * It was the literal string "Demo" first, which would have gone on claiming no
   * vehicle was connected while writing to one. Then it was `$derived(isLive())`,
   * which reads the driver from module scope — invisible to the compiler, so it
   * stayed on "Demo" with a vehicle attached. `linkKind` is the fact the screens
   * themselves use, so the two cannot disagree.
   */
  const live = $derived(app.linkKind === "elm");

  /** What each fill mode actually does, in the user's terms. */
  const FILL_HELP: Record<string, string> = {
    canned: "Only the replies stored in the database. Many fields stay empty.",
    pad: "Stored replies, extended so every field has something to decode.",
    synthetic: "All values generated. Useful for checking layout and text length.",
  };
</script>

<div class="app">
  <div class="strip" class:live role="status">
    <!--
      Wordmark, version, repository — the arrangement inpax uses, and the version is a
      build-time literal from package.json rather than a runtime read, so it cannot
      disagree with the tag `release.yml` checks.
    -->
    <span class="wordmark">DDT<span class="accent">X</span></span>

    <a
      class="version"
      href={`${__REPO_URL__}/releases/tag/v${__APP_VERSION__}`}
      target="_blank"
      rel="noopener noreferrer"
      title="Release notes for this version"
    >
      {__APP_VERSION__}
    </a>

    <a
      class="repo"
      href={__REPO_URL__}
      target="_blank"
      rel="noopener noreferrer"
      title="ddtx on GitHub"
      aria-label="ddtx on GitHub"
    >
      <!-- GitHub's own mark, inlined so it takes `currentColor` and needs no fetch. -->
      <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
        <path
          d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"
        />
      </svg>
    </a>

    <span class="rule" aria-hidden="true"></span>

    {#if live}
      <span class="badge">Live</span>
    {:else}
      <!--
        The badge doubles as the trigger for what "demo" means: which replies are used
        and whether they move. Those two controls define the mode, so they belong on the
        thing that names it — and they were 242px of a strip that had run out of room.
      -->
      <Popover
        label="Demo"
        variant="badge"
        title="How demo values are produced"
        marked={app.fill !== VIEW_DEFAULTS.fill || app.drift !== VIEW_DEFAULTS.drift}
      >
        <label class="field">
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
        <p class="note">{FILL_HELP[app.fill]}</p>

        <label class="field check">
          <input type="checkbox" bind:checked={app.drift} onchange={() => void reconfigureDemo()} />
          <span>Vary values between reads</span>
        </label>
      </Popover>
    {/if}

    <!--
      No standing "no vehicle is connected" text. The Connect button says that already —
      it reads "Connect vehicle" when there is none, "Connecting…" mid-attempt, and
      "Disconnect" once there is one — so a sentence repeating it was 300–600px of the
      strip spent on something the reader can already see.

      Two things the buttons cannot say keep a slot: a failure, which must not be
      swallowed, and what the adapter is actually attached to, which is the one fact a
      connected user wants and no button conveys.
    -->
    {#if app.connection === "error"}
      <span class="claim bad">{app.connectionMessage}</span>
    {:else if live && app.attachment !== null}
      <span class="claim">{app.attachment}</span>
    {/if}

    <div class="spacer"></div>

    {#if live}
      <!--
        Stays inline rather than going in a panel. It is the one control whose *state*
        matters more than its convenience: whether writing is armed should be readable
        without opening anything. Off by default and never remembered — docs/plan.md §6.3.
      -->
      <label class="control check danger" title="Allow buttons to send to the vehicle">
        <input type="checkbox" bind:checked={app.writesEnabled} />
        <span>Allow writing</span>
      </label>
    {/if}

    <!--
      Language, zoom and the layout overlay: set once, changed rarely, and together they
      were 471px of permanent strip.
    -->
    <Popover
      label="View"
      title="Language, zoom, and layout inspection"
      marked={app.locale !== VIEW_DEFAULTS.locale ||
        app.zoom !== VIEW_DEFAULTS.zoom ||
        app.inspect !== VIEW_DEFAULTS.inspect ||
        app.showUntranslated !== VIEW_DEFAULTS.showUntranslated}
    >
      <label class="field">
        <span class="eyebrow">Language</span>
        <select
          value={app.locale}
          onchange={(event) => void setLocale(event.currentTarget.value)}
          title="Original shows the database exactly as authored — mostly French, but a third of it is already English"
        >
          <option value="fr">Original — as authored</option>
          <option value="en">English</option>
        </select>
      </label>

      {#if app.locale !== "fr"}
        <label class="field check">
          <input type="checkbox" bind:checked={app.showUntranslated} />
          <span>Mark untranslated gaps</span>
        </label>
      {/if}

      <label class="field">
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

      <label class="field check">
        <input type="checkbox" bind:checked={app.inspect} />
        <span>Inspect layout</span>
      </label>
      <p class="note">
        Outlines every widget and its caption, so a screen's geometry can be read
        directly. Works on live data too.
      </p>
    </Popover>

    <label class="control check">
      <input
        type="checkbox"
        checked={app.autoRefresh}
        onchange={(event) => setAutoRefresh(event.currentTarget.checked)}
        disabled={app.screen === null}
      />
      <span>Keep reading</span>
    </label>

    {#if app.serialSupported}
      {#if live}
        <button
          class="link-button"
          onclick={() => void benchLink()}
          disabled={app.benching}
          title="Time 200 AT exchanges to find this link's round-trip floor. Needs no vehicle."
        >
          {app.benching ? "Measuring…" : "Measure link"}
        </button>
        <button class="link-button live-link" onclick={() => void disconnect()}>
          Disconnect
        </button>
      {:else}
        <button
          class="link-button"
          onclick={() => void connect()}
          disabled={app.connection === "connecting"}
        >
          {app.connection === "connecting" ? "Connecting…" : "Connect vehicle"}
        </button>
      {/if}
    {:else}
      <span class="unsupported" title="Web Serial is available in Chrome and Edge on desktop">
        No Web Serial
      </span>
    {/if}

    {#if app.plugins.length > 0}
      <button
        class="settings"
        onclick={() => setPluginsOpen(true)}
        title="Ported DDT4All procedures"
      >
        Procedures
      </button>
    {/if}

    <button
      class="settings"
      onclick={() => setSettingsOpen(true)}
      title={app.dbSource === null ? "Database settings" : `Database: ${app.dbSource.label}`}
    >
      Database
    </button>

    <button class="read" onclick={() => void refresh()} disabled={app.screen === null || app.refreshing}>
      {app.refreshing ? "Reading…" : "Read now"}
    </button>
  </div>

  {#if app.phase === "needs-database"}
    <DatabasePicker />
  {:else}
  <main class:narrow={!app.catalogueOpen}>
    <Catalogue />
    <Contents />

    <div class="stage" class:trace-open={app.traceOpen}>
      {#if app.phase === "loading"}
        <p class="notice">Loading the catalogue…</p>
      {:else if app.phase === "error"}
        <div class="notice error">
          <h2>The database could not be read</h2>
          <p>{app.error}</p>
          <button onclick={() => setSettingsOpen(true)}>Change the source</button>
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
  {/if}

  {#if app.settingsOpen}
    <Settings />
  {/if}

  {#if app.pluginsOpen}
    <Plugins />
  {/if}

  <!-- Always rendered, empty when there is nothing to say: the grid assigns rows
       by child order, so a conditional element here would shift `main` into the
       auto row and hand the remaining space to the tricolour. -->
  <div class="notice-row">
    {#if app.linkBench !== null}
      <p class="bench">
        <span class="eyebrow">Link</span>
        <span class="hex">{app.linkBench}</span>
        <button onclick={() => (app.linkBench = null)} aria-label="Dismiss">×</button>
      </p>
    {/if}
    {#if app.lastRefusal !== null}
      <p class="refusal" role="alert">
        {app.lastRefusal}
        <button onclick={() => (app.lastRefusal = null)} aria-label="Dismiss">×</button>
      </p>
    {/if}
  </div>

  <div class="tricolour" aria-hidden="true"></div>
</div>

<style>
  .app {
    display: grid;
    /* Explicit rows, and every child names its own, so an empty notice row cannot
       shift the layout. */
    grid-template-rows: var(--strip-height) auto minmax(0, 1fr) 4px;
    height: 100%;
  }

  .strip {
    grid-row: 1;
  }

  .notice-row {
    grid-row: 2;
  }

  main {
    grid-row: 3;
  }

  /*
   * Takes the row `main` would have had. Without this the install screen lands in the
   * auto-sized row and the tricolour footer gets pushed off-screen — the same class of
   * bug as the conditional notice row.
   *
   * Named `.install`, not `.picker`, and that matters: `.picker` is also
   * `VehiclePicker`'s root class, so this `:global` rule was reaching into the catalogue
   * and pinning the vehicle dropdown to grid row 3 — which put it *below* the group and
   * bus selects, in a grid whose DOM order had it first. A `:global` rule keyed on a
   * generic class name is a trap; the name is specific now.
   */
  :global(.install) {
    grid-row: 3;
    min-height: 0;
  }

  .tricolour {
    grid-row: 4;
  }

  /*
   * The one decorative element, at the foot of the app.
   *
   * It was under the status strip first, which didn't work: the blue third
   * disappeared into the blue strip above it and the white third into the white
   * panels below, so only red showed. Down here it sits against the trace panel
   * and all three bands read.
   */
  .tricolour {
    background: linear-gradient(
      to right,
      var(--blue) 0 33.333%,
      #fff 33.333% 66.666%,
      var(--red) 66.666% 100%
    );
    border-top: 1px solid var(--rule);
  }

  /* Blue France, with a white badge while the data is inert. The badge turns Red
     Marianne when a real vehicle is on the other end — the one place the mode
     change has to be impossible to miss. */
  .strip {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 0 12px;
    background: var(--blue);
    color: #d9dcf2;
    font-size: 11.5px;
  }

  /* Red Marianne only when a vehicle is really attached — the one mode change
     that must be impossible to miss. */
  .strip.live .claim {
    color: #ffd9d9;
  }

  /* A connection failure. White on the blue strip, because the red used elsewhere is
     invisible against it. */
  .claim.bad {
    color: #fff;
    font-weight: 600;
    padding-left: 7px;
    border-left: 2px solid var(--red);
  }


  .wordmark {
    flex-shrink: 0;
    color: #fff;
    font-size: 12.5px;
    font-weight: 800;
    letter-spacing: 0.04em;
  }

  /*
   * Marianne red, lightened for this ground.
   *
   * `--red` itself is 2.99:1 on Blue France — legible as a block, muddy as a glyph. This
   * tint is 6.1:1 and still unmistakably the same red. The strip no longer repaints
   * itself when live, so one value serves both modes.
   */
  .wordmark .accent {
    color: #ff8080;
  }

  .version {
    flex-shrink: 0;
    color: #9095cf;
    font-size: 10.5px;
    font-variant-numeric: tabular-nums;
    text-decoration: none;
  }

  .version:hover,
  .repo:hover {
    color: #fff;
  }

  .repo {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    color: #9095cf;
  }

  /* Separates the brand from the controls without a heavy divider. */
  .rule {
    flex-shrink: 0;
    width: 1px;
    height: 15px;
    background: rgba(255, 255, 255, 0.28);
  }

  .badge {
    padding: 2px 7px;
    background: #fff;
    color: var(--blue);
    font-size: 9.5px;
    font-weight: 800;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  /*
   * The live signal.
   *
   * It used to be the whole strip turning red, which was loud enough to fight the rest
   * of the UI and forced every other colour choice around it. A red plate on the badge
   * and a red Disconnect button say the same thing in the two places the eye already
   * checks — and white on Marianne red is 4.99:1, so the badge reads as a block.
   */
  .strip.live .badge {
    background: var(--red);
    color: #fff;
  }

  /*
   * The strip is a single flex row with fixed-width controls, so the only flexible
   * item is this one — and a flex item's default `min-width: auto` means it refuses
   * to shrink below its longest word and pushes its text out of the strip instead.
   * Clipping to one line keeps the connection state legible and the strip one row
   * tall at any width.
   */
  /* Only rendered when there is a failure or a live attachment to name. */
  .claim {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #a7abd8;
  }

  .control {
    display: flex;
    align-items: center;
    gap: 5px;
    white-space: nowrap;
  }


  .control.check {
    gap: 4px;
    cursor: pointer;
  }

  /*
   * Selects on the blue strip: light on dark.
   *
   * A popover panel is a light card, so this rule would make its selects near-white on
   * white — unreadable, and it was. The `.strip :global(.panel select)` rule below
   * overrides it; the scoping class gives that the higher specificity.
   */
  .strip select {
    background: rgba(255, 255, 255, 0.1);
    color: #eef1f7;
    border: 1px solid rgba(255, 255, 255, 0.22);
    border-radius: 0;
    padding: 2px 4px;
    font-size: 11.5px;
  }

  .strip input[type="checkbox"] {
    accent-color: #fff;
    margin: 0;
  }

  .spacer {
    flex: 1;
  }

  .link-button {
    white-space: nowrap;
    padding: 3px 11px;
    background: rgba(255, 255, 255, 0.14);
    color: #fff;
    border: 1px solid rgba(255, 255, 255, 0.4);
    font-size: 11px;
  }

  .link-button:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.24);
  }

  .link-button:disabled {
    color: rgba(255, 255, 255, 0.5);
    cursor: not-allowed;
  }

  /*
   * The second half of the live signal, in the place the strip's actions cluster. Filled
   * rather than outlined, so "there is a vehicle attached" is legible from the shape
   * alone without reading the word.
   */
  .live-link {
    background: var(--red);
    border-color: var(--red);
    font-weight: 600;
  }

  .live-link:hover {
    background: #f2323f;
    border-color: #f2323f;
  }

  /* Same treatment as the connection controls: this is a mode switch, not the
     primary action, and it must not read as disabled the way an unstyled button
     against the blue strip does. */
  .settings {
    padding: 3px 11px;
    background: rgba(255, 255, 255, 0.14);
    color: #fff;
    border: 1px solid rgba(255, 255, 255, 0.4);
    font-size: 11px;
  }

  .settings:hover {
    background: rgba(255, 255, 255, 0.24);
  }

  /*
   * Fields inside a popover panel. `:global` because they are rendered into
   * `Popover`'s slot, so Svelte's scoping attributes them to that component — the
   * markup is here, the element is there.
   */
  .strip :global(.field) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    font-size: 11.5px;
    color: var(--ink);
  }

  .strip :global(.field + .field),
  .strip :global(.note + .field) {
    margin-top: 8px;
  }

  .strip :global(.field .eyebrow) {
    color: var(--ink-soft);
  }

  /* Inside a panel the ground is white, so these are dark on light. */
  .strip :global(.panel select) {
    flex: 0 1 auto;
    min-width: 0;
    max-width: 168px;
    padding: 2px 4px;
    border: 1px solid var(--rule);
    border-radius: 0;
    background: var(--card);
    color: var(--ink);
    font-family: inherit;
    font-size: 11.5px;
  }

  .strip :global(.panel input[type="checkbox"]) {
    accent-color: var(--blue);
  }

  /* Checkbox rows read left-to-right; the select rows are label-then-value. */
  .strip :global(.field.check) {
    justify-content: flex-start;
    gap: 6px;
  }

  /* One line explaining the setting above it, rather than a tooltip nobody hovers. */
  .strip :global(.panel .note) {
    margin: 5px 0 0;
    font-size: 10.5px;
    line-height: 1.4;
    color: var(--ink-faint);
  }

  .unsupported {
    color: #9095cf;
    font-size: 11px;
  }

  /* Writing is the one destructive control, so it is the one marked. */
  .control.danger span {
    font-weight: 700;
  }

  /* A real grid child, so row assignment is stable whether or not it has
     content; it simply has no height when empty. */
  .notice-row:empty {
    display: none;
  }

  .bench {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 0;
    padding: 7px 14px;
    background: #fff;
    border-bottom: 1px solid var(--rule);
    box-shadow: inset 3px 0 0 var(--blue);
  }

  .bench button {
    margin-left: auto;
    background: none;
    border: 0;
    color: var(--ink-faint);
    font-size: 15px;
    line-height: 1;
  }

  .refusal {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 0;
    padding: 7px 14px;
    background: #fff;
    border-bottom: 1px solid var(--rule);
    box-shadow: inset 3px 0 0 var(--red);
    font-size: 12px;
  }

  .refusal button {
    margin-left: auto;
    background: none;
    border: 0;
    color: var(--ink-faint);
    font-size: 15px;
    line-height: 1;
  }

  .read {
    white-space: nowrap;
    padding: 3px 11px;
    background: #fff;
    color: var(--blue);
    border: 0;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.04em;
  }

  .read:disabled {
    background: rgba(255, 255, 255, 0.16);
    color: #8f93cc;
    cursor: not-allowed;
  }

  main {
    display: grid;
    grid-template-columns: 288px 244px minmax(0, 1fr);
    min-height: 0;
  }

  /* Collapsed, the catalogue keeps just enough width to hold the reopen control
     and the address of what's selected. */
  main.narrow {
    grid-template-columns: 40px 244px minmax(0, 1fr);
  }

  .stage {
    display: grid;
    /* Closed, the trace is just its own header — so the canvas gets the rest. */
    grid-template-rows: minmax(0, 1fr) auto;
    min-width: 0;
    min-height: 0;
  }

  .stage.trace-open {
    grid-template-rows: minmax(0, 1fr) minmax(120px, 34%);
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
    border-left: 3px solid var(--red);
    max-width: 62ch;
  }

  .notice.error h2 {
    margin: 0 0 6px;
    font-size: 14px;
    color: var(--ink);
  }


  /* Below a laptop, the two index columns stack above the stage rather than
     squeezing the canvas, which is the one thing that must stay legible. */
  @media (max-width: 1100px) {
    main,
    main.narrow {
      grid-template-columns: 1fr 1fr;
      grid-template-rows: 240px minmax(0, 1fr);
    }
    .stage {
      grid-column: 1 / -1;
    }
  }
</style>
