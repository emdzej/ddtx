<!--
  First run: there is no database yet.

  Not an error screen. A user arriving here has done nothing wrong — the app simply
  ships without 1.19 GB of ECU definitions in it — so the tone is instructional and
  the primary path is one control.

  Three ways in, deliberately unequal. Unpacking `ecu.zip` is the recommended one
  because it is the only one that never asks for permission again; the folder and URL
  routes are for people who already have a split tree and know why they want it.
-->
<script lang="ts">
  import {
    app,
    chooseFolder,
    chooseRemote,
    continueWithFolder,
    installArchive,
  } from "../lib/state.svelte.js";
  import { DEV_DB_URL, opfsSupported } from "../lib/dbInstall.js";
  import { folderPickerSupported } from "../lib/installStorage.js";

  let remoteUrl = $state(DEV_DB_URL);
  let showAdvanced = $state(false);
  let fileInput: HTMLInputElement | undefined = $state();

  const importing = $derived(app.importProgress !== null);
  const pct = $derived(
    app.importProgress === null
      ? 0
      : Math.min(100, Math.round((app.importProgress.done / app.importProgress.total) * 100)),
  );

  function onPick(event: Event): void {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (file !== undefined) void installArchive(file);
  }

  function onDrop(event: DragEvent): void {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (file !== undefined) void installArchive(file);
  }

  function fmtBytes(n: number): string {
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(0)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
</script>

<section class="install">
  <div class="sheet">
    <span class="eyebrow">Database</span>
    <h1>Point ddtx at the ECU definitions</h1>
    <p class="lede">
      The catalogue is 1,580 ECUs and 1.19&nbsp;GB unpacked, so it is not part of the
      app. Give it <code>ecu.zip</code> once and it is unpacked into this browser's own
      storage — after that it opens with no prompt.
    </p>

    {#if app.folderNeedsPermission}
      <!--
        The handle survived the reload; the permission did not. Re-requesting only
        works inside a user gesture, which is why this is a button and not automatic.
      -->
      <div class="resume">
        <p>
          A folder was remembered from last time, but browsers drop file access on
          reload. Granting it again takes one click.
        </p>
        <button class="primary" onclick={() => void continueWithFolder()}>
          Continue with last folder
        </button>
      </div>
    {/if}

    {#if importing}
      <div class="progress" role="status">
        {#if app.importProgress?.phase === "hashing"}
          <p class="count">Checking the archive…</p>
          <p class="hint">
            If it is the one already installed, nothing is rewritten.
          </p>
        {:else}
          <div class="bar"><div class="fill" style:width={`${pct}%`}></div></div>
          <p class="count">
            <span class="hex">{app.importProgress?.done ?? 0}</span> of
            <span class="hex">{app.importProgress?.total ?? 0}</span> entries ·
            {fmtBytes(app.importProgress?.bytesOut ?? 0)} written
          </p>
          <p class="hint">
            Unpacking runs off the main thread, so this stays responsive. It takes about
            fifteen seconds.
          </p>
        {/if}
      </div>
    {:else}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="drop"
        ondragover={(e) => e.preventDefault()}
        ondrop={onDrop}
      >
        <button class="primary" onclick={() => fileInput?.click()} disabled={!opfsSupported()}>
          Choose ecu.zip
        </button>
        <span class="or">or drop it here</span>
        <input
          bind:this={fileInput}
          type="file"
          accept=".zip,application/zip"
          onchange={onPick}
          hidden
        />
      </div>

      {#if !opfsSupported()}
        <p class="notice">
          This browser has no private filesystem, so the archive cannot be unpacked
          here. Use a folder or a URL below.
        </p>
      {/if}
    {/if}

    {#if app.importError !== null}
      <p class="notice">{app.importError}</p>
    {/if}

    <button class="disclose" onclick={() => (showAdvanced = !showAdvanced)}>
      {showAdvanced ? "Hide" : "I already have a split tree"}
    </button>

    {#if showAdvanced}
      <div class="advanced">
        <div class="row">
          <div>
            <h2>A folder on disk</h2>
            <p>
              A tree produced by <code>db-split</code>. Read directly, nothing is
              copied — but the browser asks for permission again on every reload.
            </p>
          </div>
          <button onclick={() => void chooseFolder()} disabled={!folderPickerSupported()}>
            Choose folder
          </button>
        </div>
        {#if !folderPickerSupported()}
          <p class="hint">Folder picking needs a Chromium-based browser.</p>
        {/if}

        <div class="row">
          <div>
            <h2>A URL</h2>
            <p>A static host serving the tree, or this project's dev server.</p>
            <input class="url" bind:value={remoteUrl} spellcheck="false" />
          </div>
          <button onclick={() => void chooseRemote(remoteUrl)}>Use URL</button>
        </div>
      </div>
    {/if}
  </div>
</section>

<style>
  .install {
    display: grid;
    place-items: center;
    padding: 32px 20px;
    overflow-y: auto;
  }

  .sheet {
    max-width: 620px;
    width: 100%;
    padding: 26px 28px 22px;
    background: var(--card);
    border: 1px solid var(--rule);
    /* The one tricolour flourish on this screen: a blue edge, as the strip uses. */
    border-left: 3px solid var(--blue);
  }

  h1 {
    margin: 4px 0 10px;
    font-size: 21px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }

  h2 {
    margin: 0 0 3px;
    font-size: 12px;
    font-weight: 600;
  }

  .lede {
    margin: 0 0 20px;
    font-size: 13px;
    line-height: 1.55;
    color: var(--ink-soft);
  }

  code {
    padding: 1px 4px;
    background: var(--paper);
    font-size: 0.92em;
  }

  .drop {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 18px;
    border: 1px dashed var(--rule);
    background: var(--paper);
  }

  .or {
    font-size: 12px;
    color: var(--ink-faint);
  }

  button {
    padding: 6px 13px;
    border: 1px solid var(--rule);
    background: var(--card);
    font-size: 12px;
  }

  button:hover:not(:disabled) {
    border-color: var(--blue);
    color: var(--blue);
  }

  button:disabled {
    color: var(--ink-faint);
    cursor: default;
  }

  .primary {
    background: var(--blue);
    border-color: var(--blue);
    color: #fff;
    font-weight: 600;
  }

  .primary:hover:not(:disabled) {
    background: var(--blue-soft);
    color: #fff;
  }

  .primary:disabled {
    background: var(--rule);
    border-color: var(--rule);
    color: var(--card);
  }

  .resume {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-bottom: 18px;
    padding: 12px 14px;
    background: var(--paper);
    border-left: 2px solid var(--blue);
  }

  .resume p {
    margin: 0;
    font-size: 12px;
    line-height: 1.45;
    color: var(--ink-soft);
  }

  .resume button {
    flex-shrink: 0;
  }

  .progress .bar {
    height: 6px;
    background: var(--rule-soft);
    overflow: hidden;
  }

  /* Fills blue, because this is progress and not a warning. */
  .progress .fill {
    height: 100%;
    background: var(--blue);
    transition: width 120ms linear;
  }

  .count {
    margin: 8px 0 2px;
    font-size: 12px;
  }

  .hint {
    margin: 0;
    font-size: 11px;
    line-height: 1.45;
    color: var(--ink-faint);
  }

  .notice {
    margin: 12px 0 0;
    padding-left: 8px;
    border-left: 2px solid var(--red);
    font-size: 12px;
    line-height: 1.45;
    color: var(--ink);
  }

  .disclose {
    margin-top: 18px;
    padding: 0;
    border: 0;
    background: none;
    font-size: 11.5px;
    color: var(--ink-soft);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .disclose:hover {
    color: var(--blue);
  }

  .advanced {
    margin-top: 14px;
    border-top: 1px solid var(--rule-soft);
  }

  .row {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    padding: 14px 0;
  }

  .row + .row {
    border-top: 1px solid var(--rule-soft);
  }

  .row p {
    margin: 0;
    font-size: 11.5px;
    line-height: 1.45;
    color: var(--ink-soft);
  }

  .row button {
    flex-shrink: 0;
    margin-left: auto;
  }

  .url {
    width: 100%;
    margin-top: 7px;
    padding: 4px 6px;
    border: 1px solid var(--rule);
    background: var(--card);
    font-family: inherit;
    font-size: 11.5px;
  }
</style>
