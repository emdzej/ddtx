<!--
  Stored fault codes.

  The first thing anyone asks a vehicle, and the one answer the catalogue cannot
  give. Reading is free of consequence; erasing destroys the record of what went
  wrong, so the two are not styled as a pair of equal buttons.

  Only appears for ECUs whose own file describes a fault-reading request. The rest
  genuinely cannot be asked, so there is no button to press.
-->
<script lang="ts">
  import type { DtcField } from "@ddtx/session";
  import { app, clearFaults, isLive, readFaults, t } from "../lib/state.svelte.js";

  const supported = $derived(app.dtcRequest !== null);
  const live = $derived(app.linkKind === "elm" && isLive());
  const result = $derived(app.dtc);
  const canClear = $derived(!live || app.writesEnabled);

  /** Which records are expanded. Collapsed by default — see the summary note below. */
  let opened = $state(new Set<number>());

  function toggle(index: number): void {
    const next = new Set(opened);
    if (!next.delete(index)) next.add(index);
    opened = next;
  }

  /**
   * The one-line headline for a fault.
   *
   * A UDS record carries a dozen status bits and one identifier, and reading
   * "DTCStatus.testNotCompletedThisMonitoringCycle: Yes" twelve times tells you
   * nothing about which component failed. So the widest field — the identifier, at
   * two bytes or more where the bits are one — becomes the code, any enum-resolved
   * label becomes the description, and the bits collapse into a count you can open.
   */
  function summarise(record: { fields: DtcField[] }) {
    let code: DtcField | undefined;
    for (const field of record.fields) {
      if (code === undefined || field.hex.length > code.hex.length) code = field;
    }
    const labels = record.fields.filter(
      (f) => f.labelled && f.value !== "Yes" && f.value !== "No" && f !== code,
    );
    const active = record.fields.filter((f) => f.value === "Yes").length;
    return { code, labels, active, total: record.fields.length };
  }
</script>

{#if supported}
  <section class="faults">
    <header>
      <span class="eyebrow">Fault codes</span>
      <button class="go" disabled={app.dtcReading} onclick={() => void readFaults()}>
        {app.dtcReading ? "Reading…" : result === null ? "Read faults" : "Re-read"}
      </button>
      {#if result !== null && result.records.length > 0}
        <button
          class="erase"
          disabled={app.dtcClearing || !canClear}
          title={canClear
            ? "Erase every stored code"
            : "Enable writes first — this cannot be undone"}
          onclick={() => void clearFaults()}
        >
          {app.dtcClearing ? "Erasing…" : "Erase"}
        </button>
      {/if}
    </header>

    {#if app.dtcClearNotice !== null}
      <p class="notice erased">{app.dtcClearNotice}</p>
    {/if}
    {#if app.dtcNotice !== null}
      <p class="notice">{app.dtcNotice}</p>
    {/if}

    {#if result === null}
      <p class="hint">
        Asks {app.selected?.ecuname} for the codes it has stored.
        {#if !live}Simulated — no vehicle attached.{/if}
      </p>
    {:else if result.outcome === "none"}
      <p class="hint clean">No stored codes.</p>
    {:else if result.outcome === "rejected"}
      <p class="notice">The ECU refused the request. {result.raw ?? ""}</p>
    {:else if result.outcome === "unreadable"}
      <p class="notice">Answered, but not as a fault response: <code>{result.raw ?? ""}</code></p>
    {:else}
      <p class="hint">
        <strong>{result.declared}</strong> declared,
        <strong>{result.records.length}</strong> read via {result.requestName}
        {#if result.declared !== result.records.length}
          <span class="partial">— the response did not carry them all</span>
        {/if}
      </p>
      <ol>
        {#each result.records as record (record.index)}
          {@const summary = summarise(record)}
          {@const open = opened.has(record.index)}
          <li>
            <button class="row" aria-expanded={open} onclick={() => toggle(record.index)}>
              <span class="n">{record.index + 1}</span>
              <span class="code hex">{summary.code?.hex ?? "?"}</span>
              <span class="desc">
                {#if summary.labels.length > 0}
                  {summary.labels.map((f) => t("list", f.value)).join(" · ")}
                {:else}
                  {t("data", summary.code?.name ?? "")}
                {/if}
              </span>
              <span class="flags">{summary.active}/{summary.total}</span>
            </button>
            {#if open}
              <dl>
                {#each record.fields as field (field.name)}
                  <dt>{t("data", field.name)}</dt>
                  <dd class:labelled={field.labelled} class:bare={!field.labelled}>
                    {#if field.labelled}
                      {t("list", field.value)}
                      {#if field.source === "devices"}
                        <!-- Named from the ECU's DTC catalogue rather than the field's
                             own enum. Same file, different table. -->
                        <span class="from" title="Named from this ECU's DTC catalogue">cat</span>
                      {/if}
                    {:else}
                      <!--
                        No authored name for this value. Saying so beats a naked integer,
                        which reads as a decode failure when it is simply a code this
                        ECU's file does not describe — and in demo mode the values are
                        generated, so almost nothing resolves.
                      -->
                      <span class="unnamed">{field.value}</span>
                      <span class="from muted" title="Neither this field's enum nor the ECU's DTC catalogue names this value">
                        unnamed
                      </span>
                    {/if}
                    <span class="raw hex">{field.hex}</span>
                  </dd>
                {/each}
              </dl>
            {/if}
          </li>
        {/each}
      </ol>
    {/if}
  </section>
{/if}

<style>
  .faults {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-bottom: 1px solid var(--rule);
    background: var(--card);
  }

  header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 14px 6px;
  }

  .go,
  .erase {
    padding: 3px 9px;
    border: 1px solid var(--rule);
    background: none;
    font-size: 11px;
  }

  .go {
    margin-left: auto;
  }

  .go:hover:not(:disabled) {
    border-color: var(--blue);
    color: var(--blue);
  }

  /* Erasing is the destructive one, and it should not look like the read button. */
  .erase {
    border-color: var(--red);
    color: var(--red);
  }

  .erase:disabled {
    border-color: var(--rule);
    color: var(--ink-faint);
  }

  .hint,
  .notice {
    margin: 0;
    padding: 0 14px 10px;
    font-size: 11px;
    line-height: 1.4;
    color: var(--ink-soft);
  }

  .hint.clean {
    color: var(--blue);
  }

  .notice {
    color: var(--red);
  }

  /* The outcome of an erase is a result, not a fault — and it must stay readable
     after the confirming re-read repaints everything below it. */
  .notice.erased {
    color: var(--ink);
    border-left: 2px solid var(--red);
    padding-left: 8px;
    margin: 0 14px 8px;
  }

  .partial {
    color: var(--ink-faint);
  }

  ol {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    max-height: 34vh;
    border-top: 1px solid var(--rule-soft);
  }

  li + li {
    border-top: 1px solid var(--rule-soft);
  }

  /* One line per fault: index, code, what it is, and how many flags are set. */
  .row {
    display: grid;
    grid-template-columns: 14px auto minmax(0, 1fr) auto;
    align-items: baseline;
    gap: 6px;
    width: 100%;
    padding: 6px 14px;
    border: 0;
    background: none;
    text-align: left;
    font-size: 11px;
  }

  .row:hover {
    background: var(--paper);
  }

  .n {
    color: var(--red);
    font-weight: 700;
  }

  .code {
    color: var(--blue);
    font-weight: 600;
  }

  .desc {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* How many of the record's bits are set — the reason to open it. */
  .flags {
    color: var(--ink-faint);
    font-size: 10px;
    font-variant-numeric: tabular-nums;
  }

  /* Expanded, the label gets the full width and wraps: these names run to
     `DTCStatus.testNotCompletedSinceLastClear`, which no 244px column can hold on
     one line beside its value. */
  dl {
    margin: 0;
    padding: 0 14px 8px 34px;
    font-size: 10.5px;
    line-height: 1.35;
  }

  dt {
    color: var(--ink-soft);
    margin-top: 3px;
    /* `DTCStatus.testNotCompletedSinceLastClear` has no space to break at, so
       without this it runs off the edge of the column instead of wrapping. */
    overflow-wrap: anywhere;
  }

  dd {
    margin: 0;
    font-variant-numeric: tabular-nums;
  }

  dd.labelled {
    font-weight: 600;
  }

  /* Where a label came from, or that there is none. Small, and never louder than the
     value it annotates. */
  .from {
    display: inline-block;
    margin-left: 5px;
    padding: 0 3px;
    background: var(--blue);
    color: #fff;
    font-size: 8.5px;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    vertical-align: 1px;
  }

  .from.muted {
    background: var(--ink-faint);
  }

  .unnamed {
    color: var(--ink-soft);
  }

  .raw {
    margin-left: 6px;
    color: var(--ink-faint);
    font-size: 10px;
  }
</style>
