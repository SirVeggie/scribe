import assert from "node:assert/strict";
import { test } from "node:test";
import { locationLabel, matchRecord, qualityLabel, searchPages, type PageSearchHit } from "./pageSearch.js";
import type { Tab } from "./types.js";
import { pageText } from "./pageText.js";
import { searchLibrary } from "./librarySearch.js";

function tab(over: Partial<Tab> & Pick<Tab, "title">): Tab {
  const id = over.id ?? over.title.toLowerCase().replace(/\s+/g, "-");
  return {
    id,
    key: over.key ?? id,
    html: over.html ?? "",
    pinned: false,
    createdAt: 1,
    updatedAt: over.updatedAt ?? 1,
    stripSeq: 1,
    revision: 1,
    state: over.state ?? {},
    stateRevision: 0,
    stateUpdatedAt: 0,
    eventSeq: 0,
    events: [],
    libPos: 0,
    assets: [],
    ...over,
  };
}

function titles(result: ReturnType<typeof searchPages>): string[] {
  return result.hits.map((item) => item.tab.title);
}

function hit(result: ReturnType<typeof searchPages>, title: string): PageSearchHit {
  const found = result.hits.find((item) => item.tab.title === title);
  assert.ok(found, `missing hit: ${title}`);
  return found;
}

test("phrase match is a case-insensitive contains of the full query", () => {
  const result = searchPages(
    [tab({ title: "Alpha Category Notes", html: "<p>unrelated</p>" })],
    [],
    "cat"
  );
  const match = hit(result, "Alpha Category Notes");
  assert.equal(match.location, "title");
  assert.equal(match.quality, "phrase");
});

test("ordered parts beat unordered, and comma/period split like spaces", () => {
  const pages = [
    tab({ title: "Gap", html: "<p>alpha then later omega</p>" }),
    tab({ title: "Scrambled", html: "<p>omega first and then alpha</p>" }),
  ];
  const result = searchPages(pages, [], "alpha, omega");
  assert.deepEqual(titles(result), ["Gap", "Scrambled"]);
  assert.equal(hit(result, "Gap").quality, "ordered");
  assert.equal(hit(result, "Scrambled").quality, "all");
});

test("period-separated parts match in order without needing exact words", () => {
  const result = searchPages(
    [tab({ title: "Report", html: "<p>deployment checklist notes</p>" })],
    [],
    "deploy.check"
  );
  const match = hit(result, "Report");
  assert.equal(match.location, "content");
  assert.equal(match.quality, "ordered");
});

test("partial requires at least half the parts", () => {
  const pages = [
    tab({ title: "Two of four", html: "<p>red blue</p>" }),
    tab({ title: "One of three", html: "<p>red</p>" }),
    tab({ title: "Two of three", html: "<p>red green</p>" }),
  ];
  const half = searchPages(pages, [], "red blue yellow purple");
  assert.deepEqual(titles(half), ["Two of four"]);
  assert.equal(hit(half, "Two of four").quality, "partial");
  assert.equal(hit(half, "Two of four").matchedParts, 2);

  const third = searchPages(pages, [], "red green yellow");
  assert.deepEqual(titles(third), ["Two of three"]);
  assert.equal(hit(third, "Two of three").quality, "partial");
  assert.equal(searchPages([pages[1]], [], "red blue yellow").hits.length, 0);
});

test("title wins over a stronger content match", () => {
  const pages = [
    tab({ title: "red blue notes", html: "<p>red blue yellow purple extra</p>" }),
    tab({ title: "elsewhere", html: "<p>red blue yellow purple extra</p>" }),
  ];
  const result = searchPages(pages, [], "red blue yellow purple");
  const weakTitle = hit(result, "red blue notes");
  assert.equal(weakTitle.location, "title");
  assert.equal(weakTitle.quality, "partial");
  assert.equal(hit(result, "elsewhere").location, "content");
  assert.equal(hit(result, "elsewhere").quality, "phrase");
  assert.equal(result.hits[0].tab.title, "red blue notes");
});

test("content ranks above data, and open ranks above closed on ties", () => {
  const open = [
    tab({ title: "State page", html: "<p>nope</p>", state: { note: "unique-token" }, updatedAt: 10 }),
    tab({ title: "Body page", html: "<p>unique-token lives here</p>", updatedAt: 5 }),
  ];
  const closed = [tab({ title: "Old body", html: "<p>unique-token lives here</p>", closedAt: 1, updatedAt: 20 })];
  const result = searchPages(open, closed, "unique-token");
  assert.deepEqual(titles(result), ["Body page", "Old body", "State page"]);
  assert.equal(hit(result, "Body page").location, "content");
  assert.equal(hit(result, "State page").location, "data");
  assert.equal(hit(result, "Old body").open, false);
});

test("empty query lists open tabs then closed", () => {
  const result = searchPages(
    [tab({ title: "Open A" }), tab({ title: "Open B" })],
    [tab({ title: "Closed", closedAt: 2 })],
    "  "
  );
  assert.deepEqual(titles(result), ["Open A", "Open B", "Closed"]);
  assert.equal(result.hits[0].location, null);
  assert.equal(result.hits[2].open, false);
});

test("key match is not reported as a title match", () => {
  const result = searchPages(
    [tab({ title: "Bot message rewrites", key: "valheim-wake-messages", html: "<p>unrelated</p>" })],
    [],
    "valheim"
  );
  const match = hit(result, "Bot message rewrites");
  assert.equal(match.location, "key");
  assert.equal(match.quality, "phrase");
  assert.equal(match.snippet, "valheim-wake-messages");
});

test("title still beats a key match", () => {
  const result = searchPages(
    [
      tab({ title: "Valheim idle spin", key: "other-key", html: "<p>nope</p>" }),
      tab({ title: "Bot rewrites", key: "valheim-wake-messages", html: "<p>nope</p>" }),
    ],
    [],
    "valheim"
  );
  assert.deepEqual(titles(result), ["Valheim idle spin", "Bot rewrites"]);
  assert.equal(hit(result, "Valheim idle spin").location, "title");
  assert.equal(hit(result, "Bot rewrites").location, "key");
});

test("labels cover every location and quality", () => {
  assert.equal(locationLabel("title"), "Title");
  assert.equal(locationLabel("key"), "Key");
  assert.equal(locationLabel("content"), "Content");
  assert.equal(locationLabel("data"), "Data");
  assert.equal(qualityLabel("phrase", 2, 2), "Phrase");
  assert.equal(qualityLabel("ordered", 2, 2), "In order");
  assert.equal(qualityLabel("all", 2, 2), "All terms");
  assert.equal(qualityLabel("partial", 2, 4), "Partial 2/4");
});

test("a data match names the record it sits in", () => {
  const records = [
    { anchor: "3", label: "#3 Fix the tab strip", text: "Tabs jump when one closes" },
    { anchor: "7", label: "#7 Search by meaning", text: "Open a card from a search hit" },
    { anchor: null, label: "Board", text: "search hit" },
  ];
  assert.deepEqual(matchRecord(records, "search hit"), { anchor: "7", label: "#7 Search by meaning" });
  assert.deepEqual(matchRecord(records, "strip fix"), { anchor: "3", label: "#3 Fix the tab strip" });
  // Words spread over two cards, or half of them missing, name no card.
  assert.equal(matchRecord(records, "tabs meaning"), null);
  assert.equal(matchRecord(records, "nothing here"), null);
});

test("searches share extraction and invalidate content and in-place state edits by revision", () => {
  const page = tab({ title: "Résumé", html: "<p>Old content</p>", state: { note: "Old data" } });
  const first = pageText(page);
  searchPages([page], [], "old");
  searchLibrary([page], "old", 0, 20);
  assert.equal(pageText(page), first);
  assert.equal(first.normalizedTitle, "resume");
  page.html = "<p>New content</p>";
  page.revision++;
  assert.notEqual(pageText(page), first);
  assert.equal(pageText(page).content, "New content");
  assert.equal(searchPages([page], [], "new content").hits[0]?.quality, "phrase");
  assert.equal(searchLibrary([page], "new content", 0, 20).matchCount, 1);
  const second = pageText(page);
  (page.state as { note: string }).note = "Changed data";
  page.stateRevision++;
  assert.notEqual(pageText(page), second);
  assert.equal(searchLibrary([page], "old data", 0, 20).matchCount, 0);
  assert.equal(searchPages([page], [], "changed data").hits[0]?.snippet, "Changed data");
  page.title = "Renamed";
  page.key = "scribe:new-key";
  assert.equal(searchPages([page], [], "renamed").hits[0]?.location, "title");
  assert.equal(searchLibrary([page], "new-key", 0, 20).matchCount, 1);
  // Different stores/pages can have identical ids and revisions.
  assert.equal(searchPages([tab({ id: page.id, title: "Other", state: { note: "Separate data" } })], [], "separate").matchCount, 1);
});

test("both searches use readable state content and exclude machine fields", () => {
  const page = tab({ title: "Tasks", state: {
    cards: [{ id: "arbitrary-machine-id", title: "Fix login", color: "magenta", comments: [{ text: "Useful comment" }], checklist: [{ text: "Check session" }] }],
    settings: { instructions: "secretsetting", workerLog: [{ text: "workertrace" }] },
    workerLog: [{ text: "othertrace" }], images: [{ name: "assetname" }],
  } });
  for (const query of ["arbitrary-machine-id", "magenta", "secretsetting", "workertrace", "othertrace", "assetname"]) {
    assert.equal(searchPages([page], [], query).matchCount, 0, query);
    assert.equal(searchLibrary([page], query, 0, 20).matchCount, 0, query);
  }
  for (const query of ["fix login", "useful comment", "check session"]) {
    assert.equal(searchPages([page], [], query).hits[0]?.location, "data");
    const snippet = searchLibrary([page], query, 0, 20).hits[0]?.snippet;
    assert.equal(snippet, "Fix login Useful comment Check session");
  }
});
