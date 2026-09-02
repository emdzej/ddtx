<!--
  Where the database comes from, and how to change it.

  Deliberately narrow: this is not a preferences panel for everything the app can do.
  It answers "what am I reading, and how do I swap it", because that is the question a
  user has after the first run and there is nowhere else to ask it.

  Removing the database is the one destructive control here, so it is separated,
  coloured, and states its consequence rather than being a bare "Reset".
-->
<script lang="ts">
  import {
    app,
    chooseFolder,
    chooseRemote,
    forgetDatabase,
    installArchive,
    setSettingsOpen,
    verifyDatabase,
  } from "../lib/state.svelte.js";
  import { DEV_DB_URL } from "../lib/dbInstall.js";
  import { folderPickerSupported } from "../lib/installStorage.js";

  let remoteUrl = $state(DEV_DB_URL);
  let confirmingRemoval = $state(false);
  let fileInput: HTMLInputElement | undefined = $state();

  const source = $derived(app.dbSource);
  const importing = $derived(app.importProgress !== null);
  /** Nothing to replace or remove until something is actually installed. */
  const haveTree = $derived(app.installed !== null);

  const SOURCE_LABEL: Record<string, string> = {
    opfs: "Unpacked in this browser",
    folder: "A folder on this machine",
    remote: "Served over HTTP",
  };

  function fmtBytes(n: number): string {
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(0)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  function onPick(event: Event): void {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (file !== undefined) void installArchive(file);
  }

  function close(): void {
    confirmingRemoval = false;
    setSettingsOpen(false);
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === "Escape") close();
  }
</script>

<svelte:window onkeydown={onKey} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="scrim" role="presentation" onclick={close}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="dialog" role="dialog" aria-modal="true" tabindex="-1" aria-label="Database settings" onclick={(e) => e.stopPropagation()}>
    <header>
      <span class="eyebrow">Database</span>
      <button class="close" onclick={close} aria-label="Close">×</button>
    </header>

    <dl class="facts">
      <div>
        <dt>Source</dt>
        <dd>{source === null ? "none" : SOURCE_LABEL[source.kind]}</dd>
      </div>
      <div>
        <dt>Location</dt>
        <dd class="mono">{source?.label ?? "—"}</dd>
      </div>
      <div>
        <dt>ECUs</dt>
        <dd class="hex">{app.ecuCount}</dd>
      </div>
      {#if app.installed !== null}
        <div>
          <dt>Archive</dt>
          <dd class="mono">{app.installed.source.name}</dd>
        </div>
        <div>
          <dt>Unpacked</dt>
          <dd>
            {fmtBytes(Object.values(app.installed.bytes).reduce((a, b) => a + b, 0))}
          </dd>
        </div>
        <div>
          <dt title="SHA-256 of the archive. Re-importing the same one is skipped.">
            Snapshot
          </dt>
          <dd class="mono">{app.installed.source.sha256.slice(0, 12)}</dd>
        </div>
      {/if}
      {#if app.storage !== null && app.storage.quota > 0}
        <div>
          <dt>Browser storage</dt>
          <dd>
            {fmtBytes(app.storage.usage)} of {fmtBytes(app.storage.quota)} used
          </dd>
        </div>
      {/if}
    </dl>

    {#if app.importProgress?.phase === "hashing"}
      <p class="hint">Checking the archive against what is already installed…</p>
    {:else if app.importProgress !== null}
      <p class="hint unpacking">
        Unpacking — <span class="hex">{app.importProgress.done}</span> of
        <span class="hex">{app.importProgress.total}</span> entries.
      </p>
    {/if}
    {#if app.importError !== null}
      <p class="notice">{app.importError}</p>
    {/if}

    {#if app.dbVerified !== null}
      <p class="hint ok">{app.dbVerified}</p>
    {/if}

    {#if app.dbFindings.length > 0}
      <ul class="findings">
        {#each app.dbFindings as finding, i (i)}
          <li class:warn={finding.severity === "warning"}>
            <span class="tag">{finding.severity === "warning" ? "check" : "problem"}</span>
            {finding.message}
          </li>
        {/each}
      </ul>
    {/if}

    <div class="actions">
      <div class="row">
        <div>
          <h2>{haveTree ? "Replace with another archive" : "Install from an archive"}</h2>
          <p>
            Unpacks into this browser. The same archive is recognised and skipped rather
            than rewritten.
          </p>
        </div>
        <button onclick={() => fileInput?.click()} disabled={importing}>Choose ecu.zip</button>
        <input bind:this={fileInput} type="file" accept=".zip,application/zip" onchange={onPick} hidden />
      </div>

      <div class="row">
        <div>
          <h2>Check the installed database</h2>
          <p>
            Reads the index and samples a dozen ECUs, reporting anything missing or
            malformed. The same check runs when a database is installed.
          </p>
        </div>
        <button onclick={() => void verifyDatabase()} disabled={app.verifying || importing}>
          {app.verifying ? "Checking…" : "Verify"}
        </button>
      </div>

      <div class="row">
        <div>
          <h2>Read a folder instead</h2>
          <p>An already-split tree. Asks for permission again on every reload.</p>
        </div>
        <button onclick={() => void chooseFolder()} disabled={!folderPickerSupported() || importing}>
          Choose folder
        </button>
      </div>

      <div class="row">
        <div>
          <h2>Read a URL instead</h2>
          <input class="url" bind:value={remoteUrl} spellcheck="false" />
        </div>
        <button onclick={() => void chooseRemote(remoteUrl)} disabled={importing}>Use URL</button>
      </div>
    </div>

    {#if haveTree}
    <div class="danger">
      {#if confirmingRemoval}
        <p>
          This deletes the unpacked tree from this browser and forgets the remembered
          folder. You will need the archive again to get back.
        </p>
        <div class="confirm">
          <button class="destructive" onclick={() => void forgetDatabase()}>
            Delete the database
          </button>
          <button onclick={() => (confirmingRemoval = false)}>Keep it</button>
        </div>
      {:else}
        <button class="destructive" onclick={() => (confirmingRemoval = true)}>
          Remove the database
        </button>
      {/if}
    </div>
    {/if}
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 40;
    display: grid;
    place-items: center;
    padding: 24px;
    background: rgb(16 21 28 / 0.45);
  }

  .dialog {
    width: 100%;
    max-width: 560px;
    max-height: 100%;
    overflow-y: auto;
    background: var(--card);
    border: 1px solid var(--rule);
    border-left: 3px solid var(--blue);
  }

  header {
    display: flex;
    align-items: center;
    padding: 12px 16px 8px;
  }

  .close {
    margin-left: auto;
    padding: 0 6px;
    border: 0;
    background: none;
    font-size: 20px;
    line-height: 1;
    color: var(--ink-faint);
  }

  .close:hover {
    color: var(--red);
  }

  .facts {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1px 16px;
    margin: 0;
    padding: 0 16px 14px;
  }

  .facts div {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    padding: 4px 0;
    border-bottom: 1px solid var(--rule-soft);
    font-size: 11.5px;
  }

  dt {
    color: var(--ink-soft);
    white-space: nowrap;
  }

  dd {
    margin: 0;
    text-align: right;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 10.5px;
  }

  h2 {
    margin: 0 0 2px;
    font-size: 12px;
    font-weight: 600;
  }

  .actions {
    border-top: 1px solid var(--rule);
  }

  .row {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 12px 16px;
  }

  .row + .row {
    border-top: 1px solid var(--rule-soft);
  }

  .row p {
    margin: 0;
    font-size: 11px;
    line-height: 1.45;
    color: var(--ink-soft);
  }

  .row button {
    flex-shrink: 0;
    margin-left: auto;
  }

  button {
    padding: 5px 11px;
    border: 1px solid var(--rule);
    background: var(--card);
    font-size: 11.5px;
  }

  /*
    `:where()` so this contributes no specificity beyond the element and `:hover`
    (0,1,1). Written as `:not(:disabled)` it scored 0,2,1 and outranked every
    single-class hover in the file — which is how the destructive button's white
    label lost to this blue one and rendered blue on red.
  */
  button:hover:where(:not(:disabled)) {
    border-color: var(--blue);
    color: var(--blue);
  }

  button:disabled {
    color: var(--ink-faint);
    cursor: default;
  }

  .url {
    width: 100%;
    margin-top: 5px;
    padding: 4px 6px;
    border: 1px solid var(--rule);
    background: var(--card);
    font-family: inherit;
    font-size: 11px;
  }

  /* The destructive corner, kept visually apart from the ordinary swaps above. */
  .danger {
    padding: 12px 16px 14px;
    border-top: 1px solid var(--rule);
    background: var(--paper);
  }

  .danger p {
    margin: 0 0 9px;
    font-size: 11.5px;
    line-height: 1.45;
    color: var(--ink);
  }

  .confirm {
    display: flex;
    gap: 8px;
  }

  .destructive {
    border-color: var(--red);
    color: var(--red);
  }

  .destructive:hover {
    background: var(--red);
    border-color: var(--red);
    color: #fff;
  }

  .hint {
    margin: 0;
    padding: 0 16px 10px;
    font-size: 11.5px;
    color: var(--ink-soft);
  }

  .hint.ok {
    color: var(--blue);
  }

  .findings {
    list-style: none;
    margin: 0 16px 12px;
    padding: 0;
    font-size: 11px;
    line-height: 1.45;
  }

  .findings li {
    padding: 5px 0 5px 8px;
    border-left: 2px solid var(--red);
  }

  .findings li + li {
    margin-top: 4px;
  }

  .findings li.warn {
    border-left-color: var(--ink-faint);
    color: var(--ink-soft);
  }

  .findings .tag {
    display: inline-block;
    margin-right: 5px;
    padding: 0 4px;
    background: var(--red);
    color: #fff;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    vertical-align: 1px;
  }

  .findings li.warn .tag {
    background: var(--ink-faint);
  }

  .notice {
    margin: 0 16px 12px;
    padding-left: 8px;
    border-left: 2px solid var(--red);
    font-size: 11.5px;
    line-height: 1.45;
  }

  @media (max-width: 560px) {
    .facts {
      grid-template-columns: 1fr;
    }
  }
</style>
