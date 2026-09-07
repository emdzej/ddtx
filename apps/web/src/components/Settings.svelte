<!--
  Everything that is a setting, in two sections behind one cog.

  It used to be a `View` popover in the strip and a `Database` button next to it. They
  answered the same *kind* of question — how the app looks, what it reads — and neither
  is touched during a job, so they cost 158px of a strip with a measured width budget
  for no working benefit.

  Both bodies stay mounted and one is hidden, rather than being swapped with `{#if}`.
  Switching tabs then keeps a half-typed URL and the scroll position, which a remount
  would throw away.

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
    setLocale,
    setSettingsOpen,
    verifyDatabase,
    VIEW_DEFAULTS,
    type SettingsTab,
  } from "../lib/state.svelte.js";
  import { DEV_DB_URL, folderPickerSupported, opfsSupported } from "../lib/dbSource.js";
  import { UI_LOCALES, setUiPreference, ui, uiLocale, uiPreference } from "../lib/ui.svelte.js";
  import X from "@lucide/svelte/icons/x";

  let remoteUrl = $state(DEV_DB_URL);
  let confirmingRemoval = $state(false);
  let fileInput: HTMLInputElement | undefined = $state();

  const tab = $derived(app.settingsTab);
  const source = $derived(app.dbSource);

  /** Endonym, so a Polish reader looks for "Polski" rather than "Polish". */
  const systemLabel = $derived(
    UI_LOCALES.find((locale) => locale.tag === uiLocale())?.label ?? uiLocale(),
  );

  function show(next: SettingsTab): void {
    app.settingsTab = next;
  }
  const importing = $derived(app.installing);
  /** Nothing to replace or remove until something is actually installed. */
  const haveTree = $derived(app.installed !== null);

  const SOURCE_LABEL = $derived<Record<string, string>>({
    archive: ui("settings.sourceOpfs"),
    folder: ui("settings.sourceFolder"),
    url: ui("settings.sourceRemote"),
  });

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
  <div class="dialog" role="dialog" aria-modal="true" tabindex="-1" aria-label={ui("settings.headline")} onclick={(e) => e.stopPropagation()}>
    <header>
      <span class="eyebrow">{ui("settings.headline")}</span>
      <button class="close" onclick={close} aria-label={ui("settings.close")}>
        <X size={16} strokeWidth={1.9} />
      </button>
    </header>

    <div class="tabs" role="tablist" aria-label={ui("settings.sections")}>
      <button
        type="button"
        role="tab"
        aria-selected={tab === "database"}
        class:on={tab === "database"}
        onclick={() => show("database")}
      >
        {ui("settings.tabDatabase")}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={tab === "view"}
        class:on={tab === "view"}
        onclick={() => show("view")}
      >
        {ui("settings.tabView")}
      </button>
    </div>

    <div class="body" class:hidden={tab !== "view"}>
      <!--
        Two languages, because they are two things. The interface is fully translated;
        the database overlay is French as authored and partly English, and will never be
        Polish — 541,061 requests is not a translation anyone finishes. Polish buttons
        over a French database is the normal case, not a broken one.
      -->
      <label class="field">
        <span class="eyebrow">{ui("view.interface")}</span>
        <select
          value={uiPreference()}
          onchange={(event) => setUiPreference(event.currentTarget.value)}
          title={ui("view.interfaceTitle")}
        >
          <option value="system">
            {ui("view.interfaceSystemResolved", { language: systemLabel })}
          </option>
          {#each UI_LOCALES as locale (locale.tag)}
            <option value={locale.tag}>{locale.label}</option>
          {/each}
        </select>
      </label>

      <label class="field">
        <span class="eyebrow">{ui("view.database")}</span>
        <select
          value={app.locale}
          onchange={(event) => void setLocale(event.currentTarget.value)}
          title={ui("view.databaseTitle")}
        >
          <option value="fr">{ui("view.databaseOriginal")}</option>
          <option value="en">{ui("view.databaseEnglish")}</option>
        </select>
      </label>
      <p class="note">{ui("view.databaseNote")}</p>

      {#if app.locale !== VIEW_DEFAULTS.locale}
        <label class="field check">
          <input type="checkbox" bind:checked={app.showUntranslated} />
          <span>{ui("view.markGaps")}</span>
        </label>
      {/if}

      <label class="field">
        <span class="eyebrow">{ui("view.zoom")}</span>
        <select bind:value={app.zoom}>
          <option value={"fit"}>{ui("view.zoomFit")}</option>
          <option value={200}>200%</option>
          <option value={150}>150%</option>
          <option value={100}>{ui("view.zoomNative")}</option>
          <option value={75}>75%</option>
          <option value={50}>50%</option>
        </select>
      </label>

      <label class="field check">
        <input type="checkbox" bind:checked={app.inspect} />
        <span>{ui("view.inspect")}</span>
      </label>
      <p class="note">{ui("view.inspectNote")}</p>
    </div>

    <div class="body" class:hidden={tab !== "database"}>

    <dl class="facts">
      <div>
        <dt>{ui("settings.source")}</dt>
        <dd>{source === null ? ui("settings.sourceNone") : SOURCE_LABEL[source.kind]}</dd>
      </div>
      <div>
        <dt>{ui("settings.location")}</dt>
        <dd class="mono">{source?.label ?? "—"}</dd>
      </div>
      <div>
        <dt>{ui("settings.ecus")}</dt>
        <dd class="hex">{app.ecuCount}</dd>
      </div>
      {#if app.installed !== null}
        <div>
          <dt>{ui("settings.archiveSize")}</dt>
          <dd>{fmtBytes(app.archiveBytes)}</dd>
        </div>
        <div>
          <!-- What the archive turned out to hold. There is no snapshot hash any more:
               nothing is unpacked, so there is no derived copy to compare against. -->
          <dt>{ui("settings.archive")}</dt>
          <dd>
            {ui("settings.ecusFound", {
              ecus: app.installed.ecus,
              entries: app.installed.entries,
            })}
          </dd>
        </div>
      {/if}
      {#if app.storage !== null && app.storage.quota > 0}
        <div>
          <dt>{ui("settings.storage")}</dt>
          <dd>
            {ui("settings.storageUsed", {
              used: fmtBytes(app.storage.usage),
              total: fmtBytes(app.storage.quota),
            })}
          </dd>
        </div>
      {/if}
    </dl>

    {#if importing}
      <p class="hint unpacking">{ui("settings.copying")}</p>
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
            <span class="tag">
              {finding.severity === "warning"
                ? ui("settings.findingWarn")
                : ui("settings.findingError")}
            </span>
            {finding.message}
          </li>
        {/each}
      </ul>
    {/if}

    <div class="actions">
      <div class="row">
        <div>
          <h2>{haveTree ? ui("settings.replaceHead") : ui("settings.installHead")}</h2>
          <p>{ui("settings.installBody")}</p>
        </div>
        <button onclick={() => fileInput?.click()} disabled={importing}>{ui("settings.chooseZip")}</button>
        <input bind:this={fileInput} type="file" accept=".zip,application/zip" onchange={onPick} hidden />
      </div>

      <div class="row">
        <div>
          <h2>{ui("settings.verifyHead")}</h2>
          <p>{ui("settings.verifyBody")}</p>
        </div>
        <button onclick={() => void verifyDatabase()} disabled={app.verifying || importing}>
          {app.verifying ? ui("settings.verifying") : ui("settings.verify")}
        </button>
      </div>

      <div class="row">
        <div>
          <h2>{ui("settings.folderHead")}</h2>
          <p>{ui("settings.folderBody")}</p>
        </div>
        <button onclick={() => void chooseFolder()} disabled={!folderPickerSupported() || importing}>
          {ui("settings.chooseFolder")}
        </button>
      </div>

      <div class="row">
        <div>
          <h2>{ui("settings.urlHead")}</h2>
          <input class="url" bind:value={remoteUrl} spellcheck="false" />
        </div>
        <button onclick={() => void chooseRemote(remoteUrl)} disabled={importing}>{ui("settings.useUrl")}</button>
      </div>
    </div>

    {#if haveTree}
    <div class="danger">
      {#if confirmingRemoval}
        <p>{ui("settings.removeConfirm")}</p>
        <div class="confirm">
          <button class="destructive" onclick={() => void forgetDatabase()}>
            {ui("settings.delete")}
          </button>
          <button onclick={() => (confirmingRemoval = false)}>{ui("settings.keep")}</button>
        </div>
      {:else}
        <button class="destructive" onclick={() => (confirmingRemoval = true)}>
          {ui("settings.remove")}
        </button>
      {/if}
    </div>
    {/if}
    </div>
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
    display: grid;
    place-items: center;
    margin-left: auto;
    padding: 2px;
    border: 0;
    background: none;
    color: var(--ink-faint);
  }

  .tabs {
    display: flex;
    gap: 4px;
    padding: 0 16px;
    border-bottom: 1px solid var(--rule);
  }

  /*
    Sitting on the border with a negative margin, so the selected tab's white ground
    joins the panel below it rather than floating above a line.
  */
  .tabs button {
    margin-bottom: -1px;
    padding: 5px 11px;
    border: 1px solid transparent;
    border-bottom: 0;
    background: none;
    font-family: inherit;
    font-size: 11.5px;
    color: var(--ink-soft);
  }

  .tabs button:hover {
    color: var(--ink);
  }

  .tabs button.on {
    background: var(--card);
    border-color: var(--rule);
    color: var(--ink);
    font-weight: 600;
  }

  .body {
    padding: 14px 16px 16px;
  }

  /* Hidden rather than unmounted, so a half-typed URL survives a tab switch. */
  .body.hidden {
    display: none;
  }

  /* The view controls, moved out of the strip's popover onto a white ground. */
  .field {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    font-size: 12px;
    color: var(--ink);
  }

  .field + .field,
  .note + .field {
    margin-top: 9px;
  }

  .field .eyebrow {
    color: var(--ink-soft);
  }

  .field select {
    flex: 0 1 auto;
    min-width: 0;
    max-width: 200px;
    padding: 3px 5px;
    border: 1px solid var(--rule);
    border-radius: 0;
    background: var(--card);
    color: var(--ink);
    font-family: inherit;
    font-size: 11.5px;
  }

  .field input[type="checkbox"] {
    accent-color: var(--blue);
  }

  /* Checkbox rows read left-to-right; select rows are label-then-value. */
  .field.check {
    justify-content: flex-start;
    gap: 6px;
  }

  .note {
    margin: 6px 0 0;
    font-size: 11px;
    line-height: 1.45;
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

  /*
    The destructive corner, kept visually apart from the ordinary swaps above. Negative
    horizontal margins because it sits inside the tab body's padding now and this band
    is meant to reach both edges — an inset one reads as another row rather than as the
    floor of the panel.
  */
  .danger {
    margin: 16px -16px -16px;
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
