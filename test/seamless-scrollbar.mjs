import assert from "node:assert/strict";
import { ScrollView, Text } from "@earendil-works/pi-tui";
import { installSeamlessScrollbar } from "../lib/seamless-scrollbar.ts";

const view = new ScrollView(new Text("content", 0, 0));
const original = view.scrollbarThumbStyle;
const theme = { fg: (color, text) => `[${color}]${text}` };
const restore = installSeamlessScrollbar({ mode: "fullscreen", layoutRoot: { children: [view] } }, theme);
assert.equal(view.scrollbarThumbStyle("┃"), "[scrollbarThumb]\x1b[7m \x1b[27m");
assert.equal(view.scrollbarThumbStyle("█"), view.scrollbarThumbStyle("┃"));
restore();
assert.equal(view.scrollbarThumbStyle, original);
assert.equal(installSeamlessScrollbar({ mode: "regular", layoutRoot: { children: [view] } }, theme), undefined);
