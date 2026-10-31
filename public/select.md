# select: Scribe's dropdown

Load it once; every `<select>` on the page, including ones added later, becomes Scribe's own themed dropdown (the one the app uses), instead of the browser's native list.

```html
<script src="/c/select.js"></script>
<label for="sort">Sort</label>
<select id="sort" name="sort">
  <option value="new">Newest</option>
  <option value="old">Oldest</option>
</select>
```

- The `<select>` stays the source of truth and stays in the page, hidden: read `select.value`, listen for `change` and `input`, and forms (including `<form data-reply>`) submit its `name` as before.
- Setting `select.value` or `selectedIndex` from code, or replacing its options, updates the dropdown. No sync call is needed.
- `multiple` works: the list stays open and toggles options.
- `<option data-tooltip="…">` shows a tip on that row.
- Opt one out with `<select data-native>`. A select with `size` above 1 (a list box) is left alone.
- `window.createSelect(select)` upgrades one by hand (for a select inside a shadow root, for example).
- The styles sit in `:where()`, so the page's own CSS wins: `.select-wrap { min-width: 220px }`, `.select-button`, `.select-menu`.
