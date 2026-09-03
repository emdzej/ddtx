<!--
  What this program is, and what it is not responsible for.

  Reached from the wordmark, which is where people look. Three things, in the order
  someone opening it needs them: what ddtx does, where the guide is, and the
  disclaimer — which is last but styled loudest, because this software drives real
  vehicle systems and a reader who skips everything else should not miss it.

  Not a credits screen. The upstream attribution is here because a GPL port owes it,
  not as decoration.
-->
<script lang="ts">
  import { setAboutOpen } from "../lib/state.svelte.js";
  import { ui } from "../lib/ui.svelte.js";

  const GUIDE_URL = `${__REPO_URL__}/blob/main/docs/user-guide.md`;

  function close(): void {
    setAboutOpen(false);
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
    aria-label={ui("strip.about")}
    onclick={(e) => e.stopPropagation()}
  >
    <header>
      <span class="eyebrow">{ui("about.eyebrow")}</span>
      <button class="close" onclick={close} aria-label={ui("about.close")}>×</button>
    </header>

    <div class="body">
      <p class="lede">
        <span class="mark">DDT<span class="accent">X</span></span>
        <span class="ver hex">{__APP_VERSION__}</span>
      </p>

      <p>{ui("about.what")}</p>

      <p>{ui("about.privacy")}</p>

      <!--
        The link is a value in the sentence rather than markup around a fragment of it,
        because "a TypeScript port of X" does not put X in the same place in every
        language. `@html` is safe here: both halves are ours.
      -->
      <p>
        {@html
          ui("about.port", {
            ddt4all:
              '<a href="https://github.com/cedricp/ddt4all" target="_blank" rel="noopener noreferrer">DDT4All</a>',
          })}
      </p>

      <div class="links">
        <a class="primary" href={GUIDE_URL} target="_blank" rel="noopener noreferrer">
          {ui("about.guide")}
        </a>
        <a href={__REPO_URL__} target="_blank" rel="noopener noreferrer">{ui("about.source")}</a>
        <a href={`${__REPO_URL__}/issues`} target="_blank" rel="noopener noreferrer">
          {ui("about.report")}
        </a>
      </div>

      <div class="disclaimer">
        <h2>{ui("about.warrantyHead")}</h2>
        <!--
          `@html` for these two: the emphasis is inside the sentence, and which phrase
          carries it is a translator's call — Polish does not put "as is" where English
          does. Both the template and the catalogue are ours, so there is no untrusted
          input in the path.
        -->
        <p>{@html ui("about.warrantyBody")}</p>
        <p>{@html ui("about.warrantyWrites")}</p>
      </div>
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

  .body {
    padding: 0 16px 16px;
  }

  /* The wordmark repeated at reading size, so the dialog names itself. */
  .lede {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin: 0 0 12px;
  }

  .mark {
    font-size: 19px;
    font-weight: 800;
    letter-spacing: 0.03em;
  }

  .mark .accent {
    color: var(--red);
  }

  .ver {
    font-size: 11.5px;
    color: var(--ink-faint);
  }

  p {
    margin: 0 0 10px;
    font-size: 12.5px;
    line-height: 1.55;
    color: var(--ink-soft);
  }

  a {
    color: var(--blue);
  }

  .links {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin: 14px 0 0;
  }

  .links a {
    padding: 5px 11px;
    border: 1px solid var(--rule);
    font-size: 11.5px;
    text-decoration: none;
  }

  .links a:hover {
    border-color: var(--blue);
  }

  /* The one thing worth reading if nothing else is, so it gets the red edge the app
     reserves for consequences. */
  .links .primary {
    background: var(--blue);
    border-color: var(--blue);
    color: #fff;
    font-weight: 600;
  }

  .links .primary:hover {
    background: var(--blue-soft);
    border-color: var(--blue-soft);
  }

  .disclaimer {
    margin-top: 18px;
    padding: 12px 0 0 12px;
    border-top: 1px solid var(--rule);
    border-left: 2px solid var(--red);
  }

  .disclaimer h2 {
    margin: 0 0 7px;
    font-size: 12.5px;
    font-weight: 700;
    color: var(--ink);
  }

  .disclaimer p {
    font-size: 11.5px;
    color: var(--ink);
  }

  .disclaimer p:last-child {
    margin-bottom: 0;
  }

  /* `:global`, because the emphasis arrives through `@html` and Svelte's scoping
     never sees those elements to add its hash class to them. */
  .disclaimer :global(strong) {
    font-weight: 700;
  }
</style>
