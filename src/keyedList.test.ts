import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { launchChromium } from "./chromium.js";

test("scribeKeyedList keeps elements by key, moves only what is out of order, and leaves other classes alone", async () => {
  const browser = await launchChromium({ headless: true, args: [], purpose: "Keyed list test" });
  try {
    const page = await browser.newPage();
    await page.setContent('<ul id="list"><li class="stray">left over</li></ul>');
    await page.addScriptTag({ content: fs.readFileSync(new URL("../public/dom-sync.js", import.meta.url), "utf8") });
    // A plain script: helpers declared inside evaluate() do not survive the test runner's transform.
    await page.addScriptTag({ content: `
      window.check = () => {
        const list = document.querySelector("#list");
        let created = 0;
        const items = (rows) => rows.map(([key, status]) => ({
          key,
          create: () => { created++; const li = document.createElement("li"); li.dataset.key = key; return li; },
          update: (li) => {
            scribeClasses(li, { running: status === "running" });
            scribeAttr(li, "data-status", status);
            scribeFill(li, key + status, () => [document.createTextNode(key + " " + status)]);
          },
        }));
        scribeKeyedList(list, items([["a", "idle"], ["b", "idle"], ["c", "idle"], ["d", "idle"], ["e", "idle"]]));
        const before = [...list.children];
        before[1].classList.add("menu-on");
        const observer = new MutationObserver(() => {});
        observer.observe(list, { childList: true });
        // a moves to the end, c starts running, d goes, f is new.
        scribeKeyedList(list, items([["b", "idle"], ["c", "running"], ["e", "idle"], ["f", "idle"], ["a", "idle"]]));
        const records = observer.takeRecords();
        const moved = records.flatMap((r) => [...r.addedNodes]).map((n) => n.dataset.key);
        const after = [...list.children];
        return {
          order: after.map((li) => li.textContent),
          kept: [after[0] === before[1], after[1] === before[2], after[2] === before[4], after[4] === before[0]],
          created,
          moved,
          classes: [after[0].className, after[1].className, after[1].dataset.status],
          duplicate: (scribeKeyedList(list, items([["a", "idle"], ["a", "idle"]])), list.children.length),
        };
      };
    ` });
    assert.deepEqual(await page.evaluate(() => (window as any).check()), {
      order: ["b idle", "c running", "e idle", "f idle", "a idle"],
      kept: [true, true, true, true],
      created: 6,
      moved: ["a", "f"],
      classes: ["menu-on", "running", "running"],
      duplicate: 2,
    });
  } finally {
    await browser.close();
  }
});
