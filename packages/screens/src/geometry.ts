/**
 * Twips to pixels, and the rest of the arithmetic the renderer needs.
 *
 * Screens are fixed-size VB canvases — `16380 × 10020`, `9000 × 6000`, and a long
 * tail — with every widget absolutely positioned. The Qt app divides every
 * coordinate by `uiscale`, an integer zoom that starts at 8 and clamps at 4
 * (`param_widget.py:48`). Keeping the same single-divisor model means a screen
 * can be reproduced exactly, and it makes fit-to-width a matter of *computing*
 * the divisor rather than reflowing anything.
 *
 * Nothing here reflows. The absolute positions are the design: a Renault
 * engineer placed those boxes to line up with each other, and a responsive
 * layout would destroy the meaning of the grouping.
 */

import type { FontDef, LabelWidget, Rect } from "@ddtx/core";
import type { PreparedScreen, PreparedWidget } from "@ddtx/db";

/** The Qt app's starting zoom (`param_widget.py:48`). */
export const DEFAULT_UI_SCALE = 8;

/** Its lower clamp — below this, text stops fitting its boxes. */
export const MIN_UI_SCALE = 4;

/** Pixel rectangle, ready for `position: absolute`. */
export interface PixelRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function scaleRect(rect: Rect, uiScale: number): PixelRect {
  return {
    left: rect.left / uiScale,
    top: rect.top / uiScale,
    width: rect.width / uiScale,
    height: rect.height / uiScale,
  };
}

export function screenSize(
  screen: PreparedScreen,
  uiScale: number,
): { width: number; height: number } {
  return { width: screen.width / uiScale, height: screen.height / uiScale };
}

/**
 * The `uiScale` that makes a screen exactly `availablePx` wide.
 *
 * Because pixels are `twips / uiScale`, fitting is just division — no separate
 * transform, and every widget stays pixel-consistent with the canvas. Clamped at
 * {@link MIN_UI_SCALE} so a very wide viewport doesn't blow the text up past
 * what the boxes were drawn for.
 */
export function fitScale(screen: PreparedScreen, availablePx: number): number {
  if (availablePx <= 0) return DEFAULT_UI_SCALE;
  return Math.max(MIN_UI_SCALE, screen.width / availablePx);
}

/**
 * `int(size / uiScale * 14)` — the Qt app's font sizing
 * (`utils.py:jsonFont`), which is a pixel size, not a point size.
 *
 * The factor of 14 is unexplained in the original and is presumably an empirical
 * fit against the VB original's rendering. Kept as-is: changing it would make
 * every screen's text disagree with the box it was drawn to fit.
 */
export function fontPixelSize(font: FontDef, uiScale: number): number {
  return Math.trunc((font.size / uiScale) * 14);
}

export interface FontCss {
  fontFamily: string;
  fontSize: string;
  fontWeight: "bold" | "normal";
  fontStyle: "italic" | "normal";
}

/**
 * CSS for a database font.
 *
 * `bold` and `italic` are the strings `"0"` / `"1"`, not booleans. The named
 * families are Windows-era — "MS Sans Serif", "Small Fonts", "Arial" — so each
 * gets a generic fallback rather than being trusted to resolve.
 */
export function fontCss(font: FontDef, uiScale: number): FontCss {
  return {
    fontFamily: `${JSON.stringify(font.name)}, "Helvetica Neue", Arial, sans-serif`,
    fontSize: `${fontPixelSize(font, uiScale)}px`,
    fontWeight: font.bold === "1" ? "bold" : "normal",
    fontStyle: font.italic === "1" ? "italic" : "normal",
  };
}

/**
 * A display/input splits into a caption half and a value half, side by side and
 * sharing the widget's background.
 *
 * `captionWidth` comes straight from the database's `width`; the value takes the
 * remainder. Both are clamped to zero, because a handful of widgets have a
 * caption wider than the widget itself.
 */
export interface WidgetParts {
  box: PixelRect;
  caption: PixelRect;
  value: PixelRect;
}

export function widgetParts(widget: PreparedWidget, uiScale: number): WidgetParts {
  const box = scaleRect(widget.rect, uiScale);
  const captionWidth = Math.max(0, Math.min(widget.captionWidth / uiScale, box.width));
  return {
    box,
    caption: { left: 0, top: 0, width: captionWidth, height: box.height },
    value: {
      left: captionWidth,
      top: 0,
      width: Math.max(0, box.width - captionWidth),
      height: box.height,
    },
  };
}

/** Labels use `bbox`, not `rect`. */
export function labelRect(label: LabelWidget, uiScale: number): PixelRect {
  return scaleRect(label.bbox, uiScale);
}

/**
 * `"0"` left, `"1"` right, `"2"` centre, `""` unset.
 *
 * Distribution across the database: 42,808 left, 2,066 right, 21,406 centre,
 * 2,619 unset — so all four cases occur and unset must have a defined result.
 */
export function labelAlignment(alignment: string): "left" | "right" | "center" {
  switch (alignment) {
    case "1":
      return "right";
    case "2":
      return "center";
    default:
      return "left";
  }
}

/**
 * Is a colour dark enough to need light text on it?
 *
 * The database supplies a background and a font colour per widget and they are
 * usually a sane pair, but not always — some screens set both to near-black.
 * Callers can use this to force contrast rather than render invisible text.
 * Uses the standard relative-luminance threshold.
 */
export function isDark(cssColor: string): boolean {
  const match = /rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/.exec(cssColor);
  if (match === null) return false;
  const [r, g, b] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
}
