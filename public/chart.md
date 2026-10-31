# chart: `<s-chart>`

Charts in Scribe's dark theme that follow the dataviz rules for you: the reference palette's dark steps in fixed order, thin bars with 4px rounded ends, 2px lines with end dots, a hairline grid, one y-axis, a legend from two series, hover tooltips, and a Table button that shows the numbers.

```html
<script src="/c/chart.js"></script>
<s-chart type="line" label="Cards closed per week" x="week" y="opened,closed" names="Opened,Closed"
  data='[{"week":"W40","opened":12,"closed":9},{"week":"W41","opened":8,"closed":11},{"week":"W42","opened":10,"closed":10}]'></s-chart>
```

| Attribute | Meaning |
|---|---|
| `type` | `column` (default), `bar` (horizontal), `line`, `area`, or `spark` (an inline sparkline: one series, no axes) |
| `data` | A JSON array of row objects. Or put the JSON in a `<script type="application/json">` child, or set `el.data = rows` from code (it redraws). |
| `x` | The key that names each row (the category or date). Default: the first key that isn't a number. |
| `y` | Comma-separated keys of the series to draw. Default: every numeric key but `x`. At most 8; fold the rest into "Other". |
| `names` | Comma-separated display names for the `y` series. Default: the keys. |
| `label` | The chart's title, also its accessible name. A single series needs no legend: the title names it. |
| `unit` | A suffix for values (`%`, ` ms`). Values are shortened from 1,000 up (1.2K); tooltips and the table show them in full. |
| `height` | Plot height in px (default 220; a sparkline 28). `width` is for sparklines only (default 120); other charts fill their container. |
| `colors` | Comma-separated colors to replace slots in order. Leave it out unless the colors carry meaning elsewhere on the page. |

Choose the form by the data's job: `column` for comparing a few categories or periods, `bar` for ranked or long category names, `line` for change over time, `area` for one or two series over time where the amount matters, `spark` beside a number in text or a table. Never put two measures with different scales on one chart: draw two.

Live data: keep the rows in page state and redraw on change.

```js
const chart = document.querySelector("s-chart");
chart.data = scribe.state.weeks;
scribe.onChange((state) => { chart.data = state.weeks; });
```

Restyle with CSS: everything sits in `:where()` (`s-chart .chart-title`, `s-chart .chart-tip`).
