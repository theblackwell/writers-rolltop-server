// Limits, message sanitising, issue caps and the cost of validation on hostile input.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ArchiveError, DEFAULT_LIMITS, parseJson, readArchive, resolveLimits, validateArchiveData, writeArchive } from "../src/index.ts";
import type { ArchiveData, Rec } from "../src/index.ts";
import os from "node:os";
import path from "node:path";
import { MAX_ISSUES } from "../src/errors.ts";
import { printable } from "../src/paths.ts";
import { archiveFromFiles, loadSample, unpackedFiles } from "./helpers.ts";

// The offset keeps generated ids clear of the fixtures' own (small) ones.
const id = (prefix: string, n: number): string => `${prefix}${(n + 0x800000).toString(16).padStart(7, "0")}-0000-4000-8000-${(n + 0x800000).toString(16).padStart(12, "0")}`;
const NASTY = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const T = "2026-11-02T12:00:00Z";

test("limits can be tightened but never raised", () => {
  const huge = resolveLimits({ maxEntries: Number.MAX_SAFE_INTEGER, maxTotalBytes: 1e18, maxCompressionRatio: 1e9, ratioThresholdBytes: 1e12 });
  assert.deepEqual(huge, { ...DEFAULT_LIMITS });
  assert.equal(resolveLimits({ maxEntries: 50 }).maxEntries, 50);
  assert.equal(resolveLimits({ maxEntries: 0 }).maxEntries, 0);
  assert.equal(resolveLimits({ maxEntries: -1 }).maxEntries, DEFAULT_LIMITS.maxEntries);
  assert.equal(resolveLimits({ maxEntries: Number.NaN }).maxEntries, DEFAULT_LIMITS.maxEntries);
});

test("printable removes control, bidi and invisible characters and keeps messages short", () => {
  const nasty = "a\u0000b\u0085c‮d‪e⁦f⁩g‎h‏i​j﻿k l\ud800m\u007fn";
  const shown = printable(nasty);
  assert.doesNotMatch(shown, NASTY);
  assert.doesNotMatch(shown, /[\ud800-\udfff]/);
  assert.equal(shown, "a?b?c?d?e?f?g?h?i?j?k?l?m?n");
  assert.equal(printable("x".repeat(5000)).length, 64 + 3);
  assert.equal(printable("ab"), "ab");
  assert.equal(printable("\u{1F600}".repeat(100)), `${"\u{1F600}".repeat(64)}...`); // cut by character, never inside a pair
});

test("untrusted text in messages: duplicate JSON keys, validator ids and keys", async () => {
  const key = `k‮‏${"x".repeat(500)}`;
  assert.throws(() => parseJson(`{"${key}":1,"${key}":2}`), (e: Error) => {
    assert.doesNotMatch(e.message, NASTY);
    assert.ok(e.message.length < 200, e.message);
    return true;
  });
  const { data } = await loadSample();
  const field = data.fields[0]!;
  field.key = `A‮⁦${"y".repeat(400)}`;
  const report = validateArchiveData(data);
  const bad = report.errors.filter((e) => e.message.includes("does not match"));
  assert.ok(bad.length > 0);
  for (const e of bad) {
    assert.doesNotMatch(e.message, NASTY);
    assert.ok(e.message.length < 200, e.message);
  }
});

test("schema problems are capped, and the cap is recorded", async () => {
  const files = new Map(await unpackedFiles("sample-library"));
  files.set("notes.json", Buffer.from(JSON.stringify(Array.from({ length: 1000 }, (_, i) => i)))); // 1000 notes that are numbers
  await assert.rejects(readArchive(archiveFromFiles(files)), (e: unknown) => {
    assert.ok(e instanceof ArchiveError);
    assert.equal(e.code, "SCHEMA_VIOLATION");
    assert.equal(e.issues.length, MAX_ISSUES);
    assert.equal(e.issuesTruncated, true);
    assert.match(e.message, /^SCHEMA_VIOLATION: 100\+ shape problem/);
    return true;
  });
  // A few problems are listed in full and not marked as cut.
  files.set("notes.json", Buffer.from("[1,2,3]"));
  await assert.rejects(readArchive(archiveFromFiles(files)), (e: unknown) => {
    assert.ok(e instanceof ArchiveError);
    assert.equal(e.issues.length, 3);
    assert.equal(e.issuesTruncated, false);
    return true;
  });
});

test("validator errors and warnings are capped, and the cap is recorded", async () => {
  const { data } = await loadSample();
  const orphans: Rec[] = Array.from({ length: 500 }, (_, i) => ({ id: id("f", i + 1), bookId: id("e", i + 1), text: "x", orderKey: "h", createdAt: T, updatedAt: T }));
  const withErrors: ArchiveData = { ...data, notes: orphans };
  const r = validateArchiveData(withErrors);
  assert.equal(r.errors.length, MAX_ISSUES);
  assert.equal(r.errorsTruncated, true);
  assert.equal(r.warningsTruncated, false);

  // 300 live notes in a deleted book: 300 warnings, 100 kept.
  const deleted = structuredClone(data);
  const book = deleted.library.books[0]!;
  book.deletedAt = T;
  deleted.notes = Array.from({ length: 300 }, (_, i) => ({ id: id("f", i + 1), bookId: book.id, text: "x", orderKey: "h", createdAt: T, updatedAt: T }));
  const w = validateArchiveData(deleted);
  assert.deepEqual(w.errors, []);
  assert.equal(w.warnings.length, MAX_ISSUES);
  assert.equal(w.warningsTruncated, true);
});

test("the advisory passes are skipped when the archive already has errors", async () => {
  const { data } = await loadSample();
  const clean = validateArchiveData(structuredClone(data));
  assert.deepEqual(clean.errors, []);
  // Break one anchor so that W_REFERENCE_ANCHOR_MISSING would fire.
  const broken = structuredClone(data);
  broken.references[0]!.anchorId = id("7", 99999);
  assert.ok(validateArchiveData(broken).warnings.some((x) => x.code === "W_REFERENCE_ANCHOR_MISSING"));
  broken.notes.push({ id: id("f", 1), bookId: id("e", 1), text: "x", orderKey: "h", createdAt: T, updatedAt: T });
  const r = validateArchiveData(broken);
  assert.ok(r.errors.length > 0);
  assert.equal(r.warnings.some((x) => x.code === "W_REFERENCE_ANCHOR_MISSING"), false);
});

test("validation stays fast on a large, pathological archive", async () => {
  const { data } = await loadSample("record-overrides");
  const lib = data.library;
  const universeId = lib.universes[0]!.id;
  const seriesId = lib.series[0]!.id;
  const template = data.templates.find((t) => t.entryType === "character")!;

  // 200 more books, and 3000 events that each override every book (600,000 overrides).
  const BOOKS = 200, EVENTS = 3000;
  const bookIds: string[] = lib.books.filter((b: Rec) => b.universeId === universeId).map((b: Rec) => b.id); // only books inside the universe may be overridden
  for (let i = 0; i < BOOKS; i++) {
    const bid = id("4", 1000 + i);
    bookIds.push(bid);
    lib.books.push({ id: bid, title: `B${i}`, orderKey: "9", seriesId, universeId, createdAt: T, updatedAt: T });
  }
  for (let i = 0; i < EVENTS; i++) {
    data.events.push({
      id: id("d", 1000 + i), title: `E${i}`, orderKey: `k${String(i).padStart(6, "0")}`, scope: { kind: "universe", id: universeId },
      participants: [], sceneIds: [], createdAt: T, updatedAt: T,
      when: { calendar: "C", label: "x", ordinal: i },
      overrides: bookIds.map((bookId, b) => ({ bookId, when: { calendar: "C", label: "y", ordinal: (i * 7 + b) % 1000 } })),
    });
  }

  // One scene document with 20,000 anchors, and 20,000 references to it (only 50 anchors missing, so the 100-warning cap stays open and the chronology pass really runs).
  const scene = lib.manuscriptNodes.find((n: Rec) => n.kind === "scene" && data.documents.has(n.id))!;
  const doc: any = data.documents.get(scene.id)!;
  const ANCHORS = 20000;
  doc.blocks = [{ id: id("6", 1), type: "paragraph", content: Array.from({ length: ANCHORS }, (_, i) => ({ type: "text", text: "x", marks: [{ type: "anchor", id: id("7", i + 1) }] })) }];
  const entry0 = data.entries[0]!;
  for (let i = 0; i < ANCHORS; i++) {
    data.references.push({ id: id("c", i + 1), nodeId: scene.id, entryId: entry0.id, anchorId: i % 2 === 1 && i < 100 ? id("7", 500000 + i) : id("7", i + 1), createdAt: T, updatedAt: T });
  }

  // A selection field with 5,000 options and 300 entries that each pick 1,000 of them.
  const fieldId = id("9", 777000);
  const options = Array.from({ length: 5000 }, (_, i) => ({ id: id("a", i + 1), label: `o${i}` }));
  data.fields.push({ id: fieldId, templateId: template.id, key: "pick", label: "Pick", fieldType: "selection", multiple: true, options, orderKey: "z", required: false, createdAt: T, updatedAt: T });
  const picked = options.slice(0, 1000).map((o) => o.id);
  for (let i = 0; i < 300; i++) {
    data.entries.push({ id: id("b", 100000 + i), entryType: "character", name: `P${i}`, aliases: [], attachments: [], overrides: [], values: { [fieldId]: picked }, scope: { kind: "universe", id: universeId }, templateId: template.id, createdAt: T, updatedAt: T });
  }

  const started = performance.now();
  const report = validateArchiveData(data);
  const ms = performance.now() - started;
  console.log(`# pathological validation: ${EVENTS} events x ${bookIds.length} overrides, ${ANCHORS} references to one document, 300 selections of 1000 of 5000 options: ${ms.toFixed(0)} ms`);
  assert.deepEqual(report.errors, [], "the input must be valid, so every advisory pass runs");
  assert.ok(report.warnings.some((w) => w.code === "W_REFERENCE_ANCHOR_MISSING"));
  const syntheticEvents = new Set(Array.from({ length: EVENTS }, (_, i) => id("d", 1000 + i)));
  assert.ok(report.warnings.some((w) => w.code === "W_CHRONOLOGY_ORDINAL" && w.recordId !== undefined && syntheticEvents.has(w.recordId)), "the chronology pass must have run on a generated event");
  assert.ok(ms < 15_000, `validation took ${ms} ms`);
});

test("printable on a huge key is bounded in time and size", () => {
  const key = "k".repeat(5_000_000);
  const started = performance.now();
  const shown = printable(key);
  assert.ok(performance.now() - started < 500);
  assert.equal(shown, `${"k".repeat(64)}...`);
  const parsed = performance.now();
  assert.throws(() => parseJson(`{"${key}":null}`), (e: Error) => e.message.length < 200);
  assert.throws(() => parseJson(`{"${key}":1,"${key}":2}`), (e: Error) => e.message.length < 200);
  assert.ok(performance.now() - parsed < 2000);
  // A cut at the edge must not split a surrogate pair.
  assert.doesNotMatch(printable("a".repeat(129) + "\u{1F600}".repeat(10)), /[\ud800-\udfff]/);
  assert.doesNotMatch(printable("a".repeat(129) + "\u{1F600}".repeat(10), 64), /\?\?\?\?/);
});

test("printable also removes private-use and unassigned characters and caps runs of combining marks", () => {
  assert.equal(printable("a\ue000b\u{F0000}c\u0378d"), "a?b?c?d");
  assert.equal(printable(`e${"\u0301".repeat(100)}x`), `e${"\u0301".repeat(3)}x`);
  assert.equal(printable("e\u0301\u0302x"), "e\u0301\u0302x");
  assert.equal(printable("x".repeat(500), 300), `${"x".repeat(300)}...`);
});

test("document-adapter messages are sanitised and capped before they reach an ArchiveError", async () => {
  const evil = `k\u202e${"y".repeat(5000)}`;
  const check = (e: unknown): boolean => {
    assert.ok(e instanceof ArchiveError);
    assert.doesNotMatch(e.message, /\u202e/);
    assert.ok(e.message.length <= 300 + 200, `${e.message.length}`);
    return true;
  };
  // Writing: a document whose block carries the hostile key and type.
  const { data, attachments } = await loadSample();
  const nodeId = [...data.documents.keys()][0]!;
  const doc: any = structuredClone(data.documents.get(nodeId)!);
  doc.blocks[0][evil] = 1;
  doc.blocks[0].type = evil;
  data.documents.set(nodeId, doc);
  await assert.rejects(writeArchive(data, async (sha) => attachments.get(sha)!, path.join(os.tmpdir(), `never-${Date.now()}.rolltop`)), check);
  // Reading: the same document inside an archive file.
  const files = await unpackedFiles("sample-library");
  const docPath = [...files.keys()].find((f) => f.startsWith("manuscript/"))!;
  const raw: any = JSON.parse(files.get(docPath)!.toString("utf8"));
  raw.blocks[0][evil] = 1;
  files.set(docPath, Buffer.from(JSON.stringify(raw)));
  await assert.rejects(readArchive(archiveFromFiles(files)), check);
});
