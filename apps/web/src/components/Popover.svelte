<!--
  A button in the strip that opens a small panel of settings beneath it.

  Exists because the strip had grown to twelve controls needing ~1,666px, which only
  fits above a 1600px viewport. Nearly a third of that was view preferences — language,
  zoom, layout inspection — set once and rarely touched, sitting permanently beside the
  controls used every few seconds.

  Deliberately *not* a menu that closes on selection: these panels hold several related
  settings and you often change two at once. Closing after the first would make the
  second a second trip.

  The panel is light against the blue strip, matching the dialogs, because a dark
  dropdown on a dark bar loses its edge.
-->
<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    /** Button text. */
    label: string;
    /** Read by screen readers and shown on hover. */
    title?: string;
    /** Panel contents. */
    children: Snippet;
    /** Right-aligns the panel, for triggers near the right edge. */
    align?: "left" | "right";
    /** Shown as a dot on the trigger when something in here is not at its default. */
    marked?: boolean;
    /** Style the trigger as the mode badge rather than an ordinary control. */
    variant?: "control" | "badge";
  }

  const {
    label,
    title,
    children,
    align = "left",
    marked = false,
    variant = "control",
  }: Props = $props();

  let open = $state(false);
  let root: HTMLDivElement | undefined = $state();

  /**
   * Close on any click that is not inside this popover.
   *
   * Bound on `window` in the capture phase so it fires before a click on another
   * trigger opens that one — otherwise clicking straight from one popover to another
   * leaves both open.
   */
  function onWindowClick(event: MouseEvent): void {
    if (!open) return;
    if (root !== undefined && event.target instanceof Node && root.contains(event.target)) return;
    open = false;
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === "Escape" && open) {
      open = false;
      // Focus goes back to the trigger, so Escape does not drop the user at the top of
      // the document.
      (root?.querySelector("button") as HTMLButtonElement | undefined)?.focus();
    }
  }
</script>

<svelte:window onclickcapture={onWindowClick} onkeydown={onKey} />

<div class="popover" bind:this={root}>
  <button
    class:badge={variant === "badge"}
    class:trigger={variant === "control"}
    aria-expanded={open}
    aria-haspopup="true"
    {title}
    onclick={() => (open = !open)}
  >
    {label}{#if marked}<span class="dot" aria-hidden="true"></span>{/if}<span
      class="caret"
      aria-hidden="true">▾</span>
  </button>

  {#if open}
    <div class="panel" class:right={align === "right"}>
      {@render children()}
    </div>
  {/if}
</div>

<style>
  .popover {
    position: relative;
    display: flex;
    align-items: center;
  }

  .trigger {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 3px 9px;
    background: rgba(255, 255, 255, 0.14);
    border: 1px solid rgba(255, 255, 255, 0.4);
    color: #fff;
    font-size: 11px;
    white-space: nowrap;
  }

  .trigger:hover,
  .trigger[aria-expanded="true"] {
    background: rgba(255, 255, 255, 0.24);
  }

  /* The mode indicator keeps its badge look and gains a caret. */
  .badge {
    display: flex;
    align-items: center;
    gap: 3px;
    padding: 2px 7px;
    background: #fff;
    border: 0;
    color: var(--blue);
    font-size: 9.5px;
    font-weight: 800;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  .caret {
    font-size: 8px;
    opacity: 0.75;
  }

  /* Something in the panel is off its default, so the panel is worth opening. */
  .dot {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: currentColor;
  }

  .panel {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    z-index: 30;
    min-width: 232px;
    padding: 9px 11px 11px;
    background: var(--card);
    border: 1px solid var(--rule);
    border-top: 2px solid var(--blue);
    color: var(--ink);
    box-shadow: 0 6px 18px rgb(16 21 28 / 0.18);
  }

  .panel.right {
    left: auto;
    right: 0;
  }
</style>
