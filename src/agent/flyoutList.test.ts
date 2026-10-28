import assert from "node:assert/strict";
import { test } from "node:test";
import { FLYOUT_RECENT_CAP, FLYOUT_RECENT_MS, flyoutSections, type FlyoutThread } from "./flyoutList.js";

const now = 1_700_000_000_000;

function t(id: string, over: Partial<FlyoutThread> = {}): FlyoutThread {
  return { id, status: "idle", activityAt: now, ...over };
}

function ids(list: FlyoutThread[]): string[] {
  return list.map((x) => x.id);
}

test("running, waiting and finished threads go to their own sections", () => {
  const s = flyoutSections([t("a", { status: "running" }), t("b", { status: "waiting" }), t("c")], { now });
  assert.deepEqual(ids(s.active), ["a"]);
  assert.deepEqual(ids(s.waiting), ["b"]);
  assert.deepEqual(ids(s.recent), ["c"]);
});

test("Recent keeps only the last hour, plus unseen replies of any age", () => {
  const old = now - FLYOUT_RECENT_MS - 1;
  const s = flyoutSections([t("old", { activityAt: old }), t("unseen", { activityAt: old, unread: true }), t("new", { activityAt: now - 1000 })], { now });
  assert.deepEqual(ids(s.recent), ["unseen", "new"]);
});

test("a recently edited draft counts for Recent", () => {
  const old = now - FLYOUT_RECENT_MS - 1;
  const s = flyoutSections([t("draft", { activityAt: old, draftAt: now - 1000 }), t("stale", { activityAt: old, draftAt: old })], { now });
  assert.deepEqual(ids(s.recent), ["draft"]);
});

test("page chats count for Recent only through a draft", () => {
  const s = flyoutSections([t("page", { fromPage: true, unread: true }), t("pageDraft", { fromPage: true, draftAt: now })], { now });
  assert.deepEqual(ids(s.recent), ["pageDraft"]);
});

test("Recent is capped, newest first; Active and Waiting are not", () => {
  const many = Array.from({ length: 8 }, (_, i) => t(`r${i}`, { activityAt: now - i * 1000 }));
  const running = Array.from({ length: 12 }, (_, i) => t(`a${i}`, { status: "running" }));
  const s = flyoutSections([...many, ...running], { now });
  assert.equal(s.recent.length, FLYOUT_RECENT_CAP);
  assert.deepEqual(ids(s.recent), ["r0", "r1", "r2", "r3", "r4"]);
  assert.equal(s.active.length, 12);
});

test("archived threads are left out", () => {
  const s = flyoutSections([t("a", { archived: true, status: "running" }), t("b", { archived: true })], { now });
  assert.deepEqual([s.active.length, s.waiting.length, s.recent.length], [0, 0, 0]);
});

test("an idle thread with an unanswered usage limit card waits instead of sitting in Recent", () => {
  const s = flyoutSections([t("limit", { limit: true }), t("done")], { now });
  assert.deepEqual(ids(s.waiting), ["limit"]);
  assert.deepEqual(ids(s.recent), ["done"]);
});
