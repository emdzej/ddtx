<!--
  The screen, mounted as a specimen.

  A database screen is a fixed VB canvas in twips — 16380 × 10020 and a long tail
  of others — with every widget absolutely positioned. Nothing reflows: a Renault
  engineer placed those boxes to line up with each other, so reflowing would
  destroy the grouping that carries the meaning.

  So the canvas is presented at its true aspect ratio inside a measured frame,
  with its real dimensions as the caption and corner ticks on the plate. Fitting
  is a single computed divisor (`fitScale`), which keeps every widget consistent
  with the canvas at any width.

  `Inspect` overlays widget bounds and marks the caption/value split. The tool's
  whole job here is to reproduce a 2003 canvas faithfully, so being able to see
  the measurement is the point rather than a debug afterthought.
-->
<script lang="ts">
  import type { PreparedScreen } from "@ddtx/db";
  import {
    DEFAULT_UI_SCALE,
    fitScale,
    fontCss,
    labelAlignment,
    labelRect,
    scaleRect,
    widgetParts,
  } from "@ddtx/screens";
  import type { ScreenSnapshot } from "@ddtx/screens";
  import {
    app,
    buttonGate,
    currentEcu,
    inputValue,
    isEdited,
    pressButton,
    refusalMessage,
    revertInput,
    setInputValue,
    t,
    untranslated,
  } from "../lib/state.svelte.js";
  import { ui } from "../lib/ui.svelte.js";

  interface Props {
    screen: PreparedScreen;
    snapshot: ScreenSnapshot | null;
    inspect: boolean;
    /** Percentage of native size, or "fit" to shrink to the available width. */
    zoom: number | "fit";
  }

  const { screen, snapshot, inspect, zoom }: Props = $props();

  let plateWidth = $state(900);

  /**
   * Native (100%) is `uiscale = 8`, the Qt app's own default. Rendering at native
   * and scrolling is both more faithful and more legible than fitting to width:
   * fitting a 12000-twip canvas into a 980px column lands at `uiscale ≈ 12`,
   * two-thirds of native, and captions the database sized to just fit start
   * wrapping into vertical stacks.
   */
  const scale = $derived(
    zoom === "fit" ? fitScale(screen, plateWidth) : (DEFAULT_UI_SCALE * 100) / zoom,
  );
  const size = $derived({ width: screen.width / scale, height: screen.height / scale });

  function css(rect: { left: number; top: number; width: number; height: number }): string {
    return `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px`;
  }

  function fontStyle(font: Parameters<typeof fontCss>[0]): string {
    const f = fontCss(font, scale);
    return `font-family:${f.fontFamily};font-size:${f.fontSize};font-weight:${f.fontWeight};font-style:${f.fontStyle}`;
  }

  /** Unit suffix, appended as the Qt app does (`qlabel.setText(value + ' ' + unit)`). */
  function unitFor(dataName: string | null): string {
    if (dataName === null) return "";
    const unit = currentEcu()?.data.get(dataName)?.unit ?? "";
    return unit === "" ? "" : ` ${t("unit", unit)}`;
  }

  /**
   * A decoded value, translated if it is an enum label.
   *
   * `getDisplayValue` returns the label straight out of `data.lists`, so the
   * translation happens here rather than in the codec — which must keep returning
   * the raw label, because the write path looks it back up to recover the integer.
   */
  function valueText(dataName: string | null, value: string): string {
    if (dataName === null) return value;
    const data = currentEcu()?.data.get(dataName);
    if (data === undefined || data.items.get(value) === undefined) return value;
    return t("list", value);
  }

  /**
   * The enum a field accepts, or `null` for a free-text field.
   *
   * The database decides: a `lists` map means a fixed set of choices, and the Qt
   * app renders exactly that distinction — `QComboBox` when `data.items` is
   * non-empty, `QLineEdit` otherwise (`input_widget.py:170`).
   */
  function choicesFor(dataName: string | null): Array<{ raw: number; label: string }> | null {
    if (dataName === null) return null;
    const data = currentEcu()?.data.get(dataName);
    if (data === undefined || data.lists.size === 0) return null;
    return [...data.lists.entries()]
      .map(([raw, label]) => ({ raw, label }))
      .sort((a, b) => a.raw - b.raw);
  }

  /** What a free-text field expects, so the placeholder is not a guess. */
  function hintFor(dataName: string | null): string {
    if (dataName === null) return "";
    const data = currentEcu()?.data.get(dataName);
    if (data === undefined) return "";
    if (data.bytesascii) return `text, ${data.bytescount} chars`;
    if (data.scaled) return data.unit === "" ? "decimal" : `decimal ${data.unit}`;
    return `hex, ${data.bytescount} byte${data.bytescount === 1 ? "" : "s"}`;
  }

  function tooltip(dataName: string | null, request: string): string {
    if (dataName === null) return `${request} — no value bound`;
    const data = currentEcu()?.data.get(dataName);
    // The tooltip shows the original alongside the translation: it is the place
    // to check what the database actually calls something.
    const parts = app.locale === "fr" ? [dataName, request] : [t("data", dataName), dataName, request];
    if (data?.comment) parts.push(t("comment", data.comment));
    if (data) parts.push(`${data.bitscount} bits${data.unit ? ` · ${data.unit}` : ""}`);
    return parts.join("\n");
  }
</script>

<figure class="plate">
  <div class="frame" bind:clientWidth={plateWidth}>
    <span class="tick tl"></span><span class="tick tr"></span>
    <span class="tick bl"></span><span class="tick br"></span>

    <div
      class="canvas"
      class:inspect
      style="width:{size.width}px;height:{size.height}px;background:{screen.color}"
    >
      {#each screen.labels as label, i (i)}
        {@const rect = labelRect(label, scale)}
        <div
          class="label"
          style="{css(rect)};background:{label.color};color:{label.fontcolor};text-align:{labelAlignment(
            label.alignment,
          )};{fontStyle(label.font)}"
        >
          {t("label", label.text)}
        </div>
      {/each}

      {#each screen.widgets as widget (widget.id)}
        {@const parts = widgetParts(widget, scale)}
        {@const value = snapshot?.values.get(widget.id)}
        <div
          class="widget"
          data-kind={widget.kind}
          style="{css(parts.box)};background:{widget.color};color:{widget.fontcolor};{fontStyle(
            widget.font,
          )}"
          title={tooltip(widget.dataName, widget.request)}
        >
          <span
            class="caption"
            class:gap={untranslated("data", widget.label)}
            style={css(parts.caption)}>{t("data", widget.label)}</span
          >
          {#if widget.kind === "input"}
            {@const choices = choicesFor(widget.dataName)}
            <!--
              Always editable, even with writing off. Typing is local state and
              sends nothing; the gate that matters is on the button, where bytes
              actually leave. Disabling these would stop you inspecting what a
              field expects without first arming the write path, which is friction
              for no safety.
            -->
            {#if choices !== null}
              <select
                class="value input"
                class:edited={isEdited(widget)}
                class:bad={app.badField === widget.dataName}
                style={css(parts.value)}
                title={tooltip(widget.dataName, widget.request)}
                value={inputValue(widget)}
                onchange={(event) => setInputValue(widget, event.currentTarget.value)}
              >
                <!-- The option's value is the raw label, never the translation:
                     the write path looks it back up to recover the integer. -->
                {#each choices as choice (choice.raw)}
                  <option value={choice.label}>{t("list", choice.label)}</option>
                {/each}
              </select>
            {:else}
              <input
                class="value input"
                class:edited={isEdited(widget)}
                class:bad={app.badField === widget.dataName}
                style={css(parts.value)}
                placeholder={hintFor(widget.dataName)}
                title={`${tooltip(widget.dataName, widget.request)}\n\nDouble-click to go back to the value read from the ECU.`}
                value={inputValue(widget)}
                oninput={(event) => setInputValue(widget, event.currentTarget.value)}
                ondblclick={() => revertInput(widget)}
              />
            {/if}
          {:else}
            <span
              class="value"
              class:nodata={value?.status === "no-data"}
              class:rejected={value?.status === "rejected"}
              class:failed={value?.status === "error"}
              style={css(parts.value)}
            >
              {#if value?.value !== null && value?.value !== undefined}
                {valueText(widget.dataName, value.value)}{unitFor(widget.dataName)}
              {/if}
            </span>
          {/if}
        </div>
      {/each}

      {#each screen.buttons as button (button.uniquename)}
        {@const rect = scaleRect(button.rect, scale)}
        {@const gate = buttonGate()}
        <button
          class="ecu-button"
          class:blocked={!gate.allowed}
          style="{css(rect)};{fontStyle(button.font)}"
          disabled={button.send.length === 0 || !gate.allowed}
          title={button.send.length === 0
            ? "No request attached"
            : !gate.allowed
              ? refusalMessage(gate)
              : button.send.map((s) => s.RequestName).join("\n")}
          onclick={() => void pressButton(button.uniquename)}
        >
          {t("button", button.text)}
        </button>
      {/each}
    </div>
  </div>

  <figcaption>
    <span class="eyebrow">{ui("canvas.label")}</span>
    <span class="hex">{ui("canvas.twips", { width: screen.width, height: screen.height })}</span>
    <span class="sep">·</span>
    <span class="hex">{Math.round((DEFAULT_UI_SCALE / scale) * 100)}% · 1 : {scale.toFixed(2)}</span>
    <span class="sep">·</span>
    <span>
      {ui("canvas.parts", {
        widgets: screen.widgets.length,
        labels: screen.labels.length,
        buttons: screen.buttons.length,
      })}
    </span>
  </figcaption>
</figure>

<style>
  .plate {
    margin: 0;
    padding: 22px 24px 18px;
    /*
      Sized to content like the frame it holds, so its own padding is inside its box.
      Left as a plain block it would be the scroller's width, and the trailing padding
      would fall outside the scroll extent — the plate's right edge then sits flush
      against the end of the scroll with no margin at all.
    */
    width: max-content;
    min-width: 100%;
  }

  /* The mount: a hairline plate with corner ticks, as a technical figure. */
  .frame {
    position: relative;
    padding: 14px;
    background: var(--card);
    border: 1px solid var(--rule);
    /* At native scale the canvas is usually wider than the column, so the plate
       sizes to its content and the stage scrolls. */
    width: max-content;
    min-width: 100%;
  }

  .tick {
    position: absolute;
    width: 7px;
    height: 7px;
    border: 1px solid var(--ink);
    border-radius: 0;
  }
  .tl {
    top: 4px;
    left: 4px;
    border-right: 0;
    border-bottom: 0;
  }
  .tr {
    top: 4px;
    right: 4px;
    border-left: 0;
    border-bottom: 0;
  }
  .bl {
    bottom: 4px;
    left: 4px;
    border-right: 0;
    border-top: 0;
  }
  .br {
    bottom: 4px;
    right: 4px;
    border-left: 0;
    border-top: 0;
  }

  .canvas {
    position: relative;
    overflow: hidden;
    /* The canvas is the brightest, most present thing on the page. */
    box-shadow: 0 1px 0 rgba(255, 255, 255, 0.5) inset, 0 6px 18px rgba(16, 21, 28, 0.16);
  }

  .label,
  .widget,
  .ecu-button {
    position: absolute;
    overflow: hidden;
  }

  .label {
    padding: 0 2px;
    white-space: pre-wrap;
    /* VB group boxes are drawn as a filled rect with the caption inside. */
    line-height: 1.15;
  }

  .widget {
    display: block;
  }

  .caption,
  .value {
    position: absolute;
    padding: 0 2px;
    overflow: hidden;
    line-height: 1.12;
  }

  /* Captions wrap, values don't — Qt sets `setWordWrap(True)` on the caption
     label only (`display_widget.py:126`). Ellipsizing them instead turns
     "P.présente" into "P." and loses the column heading entirely. */
  .caption {
    white-space: normal;
    overflow-wrap: anywhere;
  }

  .value {
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  /* Values are sunken, the way a VB label with a border looks — and it separates
     the reading from its name without needing a colour. */
  .value {
    text-align: right;
    border: 1px solid rgba(16, 21, 28, 0.28);
    border-right-color: rgba(255, 255, 255, 0.5);
    border-bottom-color: rgba(255, 255, 255, 0.5);
    font-variant-numeric: tabular-nums;
  }

  /* Writable fields read as wells rather than readouts, and inherit the widget's
     font so an edited screen still looks like the screen it was drawn as. */
  .value.input {
    background: rgba(255, 255, 255, 0.82);
    text-align: left;
    font: inherit;
    color: inherit;
    border-radius: 0;
    padding: 0 2px;
    min-width: 0;
  }

  /* Typed-in but not yet sent: the value on screen is no longer the ECU's. */
  .value.input.edited {
    background: #fff;
    box-shadow: inset 0 0 0 1px var(--blue);
  }

  /* Refused by the codec, so nothing was sent. */
  .value.input.bad {
    background: #fff;
    box-shadow: inset 0 0 0 2px var(--red);
  }

  /* Three failure shades, all red, distinguished by weight rather than by hue —
     the Qt app paints NO DATA solid red and says nothing about the rest. */
  .value.nodata {
    background: var(--red);
    color: #fff;
  }
  .value.rejected {
    background: #fff;
    color: var(--red);
    border-color: var(--red);
    font-weight: 700;
  }
  .value.failed {
    background: var(--ink);
    color: #fff;
  }

  .ecu-button {
    background: linear-gradient(#fdfdfd, #dfe3e6);
    border: 1px solid rgba(16, 21, 28, 0.35);
    color: var(--ink);
    padding: 0 2px;
    line-height: 1;
  }
  .ecu-button:hover:not(:disabled) {
    background: linear-gradient(#fff, #eef1f3);
  }
  .ecu-button:active:not(:disabled) {
    background: linear-gradient(#d6dade, #e8ebed);
  }
  .ecu-button:disabled {
    color: var(--ink-faint);
    cursor: not-allowed;
  }

  /* Blocked by a write gate rather than by the database: the reason is in the
     tooltip, and the mark says the control exists but is being withheld. */
  .ecu-button.blocked {
    border-style: dashed;
    border-color: var(--red);
  }

  /* Inspect: show the measurement rather than hide it. */
  .canvas.inspect .widget {
    outline: 1px solid rgba(0, 0, 145, 0.55);
    outline-offset: -1px;
  }
  .canvas.inspect .widget[data-kind="input"] {
    outline-color: var(--red);
  }
  .canvas.inspect .label {
    outline: 1px dashed rgba(16, 21, 28, 0.4);
    outline-offset: -1px;
  }
  /* Dev aid: mark captions still falling through to French. */
  .caption.gap {
    box-shadow: inset 0 -1px 0 var(--red);
  }

  .canvas.inspect .caption {
    box-shadow: inset -1px 0 0 var(--red);
  }

  figcaption {
    display: flex;
    gap: 8px;
    align-items: baseline;
    flex-wrap: wrap;
    margin-top: 9px;
    color: var(--ink-soft);
    font-size: 11px;
  }

  .sep {
    color: var(--ink-faint);
  }
</style>
