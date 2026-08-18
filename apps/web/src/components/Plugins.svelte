<!--
  Procedures, grouped the way the original's menu grouped them.

  These are the sharpest things in the app — an airbag reset destroys the record of an
  accident, a UCH erase stops the car starting until keys are re-learned — so the design
  puts the consequence in front of the operator rather than behind a tooltip. Each row
  states its warning before it can be run, not after.

  Two badges carry real information and neither is decoration: "unverified" means nobody
  has run this against a vehicle, and "no vehicle needed" means it cannot touch a bus at
  all because it declares no read or write capability.
-->
<script lang="ts">
  import { app, runPluginByName, setPluginsOpen } from "../lib/state.svelte.js";

  const running = $derived(app.pluginRunning);
  const outcome = $derived(app.pluginOutcome);

  /** Grouped by the manifest's category, in the order the categories first appear. */
  const groups = $derived.by(() => {
    const byCategory = new Map<string, typeof app.plugins>();
    for (const plugin of app.plugins) {
      const existing = byCategory.get(plugin.category);
      if (existing === undefined) byCategory.set(plugin.category, [plugin]);
      else existing.push(plugin);
    }
    return [...byCategory];
  });

  function close(): void {
    // Refuses while one is running: abandoning a procedure part-way through is how a
    // module ends up in a state nobody intended.
    if (running === null) setPluginsOpen(false);
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === "Escape") close();
  }
</script>

<svelte:window onkeydown={onKey} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="scrim" role="presentation" onclick={close}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="dialog"
    role="dialog"
    aria-modal="true"
    tabindex="-1"
    aria-label="Procedures"
    onclick={(event) => event.stopPropagation()}
  >
    <header>
      <span class="eyebrow">Procedures</span>
      <button class="close" onclick={close} disabled={running !== null} aria-label="Close">×</button>
    </header>

    {#if app.plugins.length === 0}
      <p class="hint">
        No procedures are bundled. Run <code>pnpm plugins:build</code> to compile them.
      </p>
    {:else}
      <p class="hint">
        Ported from DDT4All's plugins. Each names the ECU it was written for and is
        attached to that module for the duration, whatever the catalogue has selected.
      </p>

      {#each groups as [category, members] (category)}
        <section>
          <h2>{category}</h2>
          {#each members as plugin (plugin.name)}
            {@const busless = !plugin.capabilities.includes("read") && !plugin.capabilities.includes("write")}
            <div class="row" class:busy={running === plugin.name}>
              <div class="what">
                <span class="label">
                  {plugin.label}
                  {#if busless}<span class="tag calm">no vehicle needed</span>{/if}
                  {#if !busless}<span class="tag">unverified</span>{/if}
                </span>
                <p class="desc">{plugin.description}</p>
                {#if plugin.warning}
                  <p class="warn">{plugin.warning}</p>
                {/if}
              </div>
              <button
                class:destructive={plugin.capabilities.includes("write")}
                disabled={running !== null}
                onclick={() => void runPluginByName(plugin.name)}
              >
                {running === plugin.name ? "Running…" : "Run"}
              </button>
            </div>
          {/each}
        </section>
      {/each}
    {/if}

    {#if app.pluginLog.length > 0 || outcome !== null}
      <div class="output">
        <span class="eyebrow">Output</span>
        <ol>
          {#each app.pluginLog as line, i (i)}
            <li>{line}</li>
          {/each}
        </ol>
        {#if outcome !== null}
          <p class="outcome" class:bad={outcome.status !== "ok"}>
            <strong>{outcome.status}</strong> — {outcome.text}
          </p>
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
    max-width: 640px;
    max-height: 100%;
    overflow-y: auto;
    background: var(--card);
    border: 1px solid var(--rule);
    /* Red rather than the blue the settings dialog uses: what lives in here writes. */
    border-left: 3px solid var(--red);
  }

  header {
    display: flex;
    align-items: center;
    padding: 12px 16px 6px;
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

  .close:hover:not(:disabled) {
    color: var(--red);
  }

  .close:disabled {
    color: var(--rule);
    cursor: default;
  }

  .hint {
    margin: 0;
    padding: 0 16px 12px;
    font-size: 11.5px;
    line-height: 1.45;
    color: var(--ink-soft);
  }

  code {
    padding: 1px 4px;
    background: var(--paper);
  }

  section {
    border-top: 1px solid var(--rule);
  }

  h2 {
    margin: 0;
    padding: 8px 16px 4px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ink-faint);
  }

  .row {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 8px 16px 11px;
  }

  .row + .row {
    border-top: 1px solid var(--rule-soft);
  }

  .row.busy {
    background: var(--paper);
  }

  .what {
    min-width: 0;
  }

  .label {
    font-size: 12.5px;
    font-weight: 600;
  }

  .desc {
    margin: 2px 0 0;
    font-size: 11px;
    line-height: 1.4;
    color: var(--ink-soft);
  }

  /* The consequence, stated before the button is pressed rather than in a confirm. */
  .warn {
    margin: 4px 0 0;
    padding-left: 7px;
    border-left: 2px solid var(--red);
    font-size: 11px;
    line-height: 1.4;
  }

  .row button {
    flex-shrink: 0;
    margin-left: auto;
    padding: 4px 12px;
    border: 1px solid var(--rule);
    background: var(--card);
    font-size: 11.5px;
  }

  .row button:hover:not(:disabled) {
    border-color: var(--blue);
    color: var(--blue);
  }

  .row button.destructive {
    border-color: var(--red);
    color: var(--red);
  }

  .row button.destructive:hover:not(:disabled) {
    background: var(--red);
    color: #fff;
  }

  .row button:disabled {
    border-color: var(--rule);
    color: var(--ink-faint);
    cursor: default;
  }

  .tag {
    display: inline-block;
    margin-left: 5px;
    padding: 0 4px;
    background: var(--red);
    color: #fff;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    vertical-align: 1px;
  }

  /* Not a caveat — a reassurance. It cannot touch a bus. */
  .tag.calm {
    background: var(--blue);
  }

  .output {
    border-top: 1px solid var(--rule);
    background: var(--paper);
    padding: 10px 16px 12px;
  }

  .output ol {
    list-style: none;
    margin: 4px 0 0;
    padding: 0;
    max-height: 30vh;
    overflow-y: auto;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 10.5px;
    line-height: 1.5;
  }

  .output li {
    overflow-wrap: anywhere;
  }

  .outcome {
    margin: 8px 0 0;
    font-size: 11.5px;
  }

  .outcome strong {
    color: var(--blue);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .outcome.bad strong {
    color: var(--red);
  }
</style>
