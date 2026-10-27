---
name: ui-help-text
description: Rules for help text, hints and tooltips in Scribe's own UI (public/*.js, public/*.css). Use before adding or changing a setting, a dialog, a section explanation, a label's hint, or any title= tooltip in the board or agent chat UI.
---

# Help text and tooltips in Scribe's UI

<!-- Same file in .claude/skills (Claude), .cursor/skills (Cursor) and .agents/skills (Native): change all three together. -->

Help text is for the few people who need it, so it must not cost everyone else room. A paragraph under every setting pushes the other settings out of view and makes a dialog harder to scan.

## Where help goes

- **Explains one setting**: put it in the label's hover tip, not a paragraph under the row. In the agent UI, pass `hint` to `settingRow` (public/agent.js): the label gets a dotted underline and the custom tip after a short delay.
- **Explains a whole section** (not tied to one control): a `?` next to the heading that shows the tip at once, since it is a dedicated hint element. In the agent UI, use `helpHeading(text, help)` instead of `el("h3", …)`.
- **Inline text stays only when people need it while they act**: an error, a value's current state, a placeholder example in an empty input, or rule syntax right next to the box you type it in. Keep it to one short line.
- **No closing "about" paragraph** at the bottom of a dialog: move it to the `?` of the section it is about.

## Tooltips

- Prefer the custom tips over the native `title` attribute: they match the theme, show without the OS delay where wanted, and can hold more than one line. Reuse what exists rather than adding a new tooltip:
  - agent UI (public/agent.js): `bindHoverTip(anchor, build, { delay, start })`, `noteTip(text)` for plain text, styles `.ag-usage-tip`;
  - shell (public/app.js, library.js): `hoverCard.bind(el, delay)` with a `{ title, description, note: true }` entry in `describeForCard`.
- Plain text tooltips use the shared `public/tooltip.js` component: set `data-tooltip` (or `element.dataset.tooltip`). Icon-only buttons use it too; keep their `aria-label`. Rendered pages also convert legacy `title` attributes at runtime.
- Rich hover cards mark their anchors with `data-rich-tooltip` to take precedence over plain text tips.
- Give the anchor an accessible description (`aria-description`) so the text is not mouse-only, and make a `?` a real button (focus and click show it too).

## Writing the text

- Say what it does and what changes for the user, in one to three sentences. No marketing, no repeating the label.
- Don't explain the obvious ("Turn this on to enable X").


## Checkboxes and toggles

- Use a plain `<input type="checkbox">` inside `label.check` for choices in dialogs and lists. `app.css` supplies the shared Track style automatically; do not add a custom checkbox drawing. Existing `.ag-check`, `.ag-ws-remember` and `.template-check` labels are layout aliases.
- Use the shared `pill-toggle` for settings that switch something on. Pages and chat forms get the matching checkbox style from `kit.css`.
