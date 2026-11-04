// SPDX-License-Identifier: AGPL-3.0-only
// Creates and destroys only its own disposable Compose project and scratch volume.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { passwordHash } from "../packages/studio/src/auth.ts";
const exec = promisify(execFile);
const runtime = process.env.CONTAINER_RUNTIME ?? "podman";
const project = "rolltop-smoke-" + randomBytes(4).toString("hex");
const directory = await mkdtemp(join(tmpdir(), "rolltop-container-"));
const env = join(directory, ".env");
const password = randomBytes(24).toString("hex");
const port = process.env.SMOKE_PORT ?? "14317";
const origin = `http://localhost:${port}`;
await writeFile(
  env,
  `POSTGRES_PASSWORD=${randomBytes(32).toString("hex")}\nSTUDIO_PASSWORD_HASH='${await passwordHash(password)}'\nSTUDIO_ORIGIN=${origin}\nSTUDIO_PORT=${port}\n`,
  { mode: 0o600 },
);
async function compose(...args: string[]) {
  try {
    const r = await exec(
      runtime,
      ["compose", "--project-name", project, "--env-file", env, ...args],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    return r.stdout;
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    throw new Error(
      (err.stdout ?? "") + (err.stderr ?? "Container command failed"),
    );
  }
}
let cookie = "";
async function api(path: string, method = "GET", value?: unknown) {
  const r = await fetch(origin + "/api" + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      Cookie: cookie,
    },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
  if (!r.ok)
    throw new Error(`API ${method} ${path}: ${r.status} ${await r.text()}`);
  if (r.headers.has("set-cookie"))
    cookie = r.headers.get("set-cookie")!.split(";")[0];
  return r.json();
}
async function health() {
  for (let i = 0; i < 60; i++) {
    try {
      await api("/health");
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error("Studio health check did not become ready.");
}
try {
  console.log(`Building and starting isolated Compose project ${project}…`);
  console.log(await compose("up", "--build", "-d"));
  await health();
  await api("/login", "POST", { password });
  const library = await api("/libraries", "POST", {
    title: "Container smoke scratch",
  });
  const catalog = await api(`/libraries/${library.id}/templates`);
  assert.equal(catalog.templates.length, 9);
  assert.equal(catalog.fields.length, 20);
  const book = await api(`/libraries/${library.id}/books`, "POST", {
    title: "Restart check",
  });
  const world = await api(`/libraries/${library.id}/universes`, "POST", {
    title: "Scratch world",
  });
  const serial = await api(`/libraries/${library.id}/series`, "POST", {
    title: "Scratch series",
    universeId: world.id,
  });
  const worldId = world.id,
    seriesId = serial.id;
  await api(`/books/${book.id}/membership`, "PUT", {
    universeId: worldId,
    seriesId,
    expectedUpdatedAt: book.updatedAt,
  });
  await api(
    `/libraries/${library.id}/universes/${worldId}`,
    "PUT",
    { title: "Renamed scratch world", expectedUpdatedAt: world.updatedAt },
  );
  const unusedWorld = await api(`/libraries/${library.id}/universes`, "POST", {
    title: "Unused world",
  });
  const trashedWorld = await api(
    `/libraries/${library.id}/universes/${unusedWorld.id}`,
    "PUT",
    { deleted: true, expectedUpdatedAt: unusedWorld.updatedAt },
  );
  assert.ok(trashedWorld.deletedAt);
  await api(`/libraries/${library.id}/universes/${unusedWorld.id}`, "PUT", {
    deleted: false,
    expectedUpdatedAt: trashedWorld.updatedAt,
  });
  const chapter = await api(`/books/${book.id}/nodes`, "POST", {
    title: "Chapter 1",
    kind: "chapter",
  });
  const scene = await api(`/books/${book.id}/nodes`, "POST", {
    title: "Scene 1",
    kind: "scene",
    parentId: chapter.id,
  });
  const first = await api(`/documents/${scene.id}`);
  first.document.blocks[0].content = [
    {
      type: "text",
      text: "This scratch manuscript survives a container restart. 雨 e\u0301",
    },
  ];
  await api(`/documents/${scene.id}`, "PUT", {
    document: first.document,
    expectedRevision: first.revision,
  });
  const entry = await api(`/books/${book.id}/entries`, "POST", {
    name: "Corin",
    entryType: "character",
  });
  const editedEntry = await api(
    `/books/${book.id}/entries/${entry.id}`,
    "PUT",
    {
      givenName: "Corin",
      familyName: "Vale",
      aliases: ["The courier"],
      summary: "Carries the letter",
      toBeNamed: true,
      expectedUpdatedAt: entry.updatedAt,
    },
  );
  await assert.rejects(
    () =>
      api(`/books/${book.id}/entries/${entry.id}`, "PUT", {
        name: "Stale",
        expectedUpdatedAt: entry.updatedAt,
      }),
    /409/,
  );
  const trashEntry = await api(`/books/${book.id}/entries/${entry.id}`, "PUT", {
    deleted: true,
    expectedUpdatedAt: editedEntry.updatedAt,
  });
  const restoredEntry = await api(
    `/books/${book.id}/entries/${entry.id}`,
    "PUT",
    {
      deleted: false,
      expectedUpdatedAt: trashEntry.updatedAt,
    },
  );
  const characterTemplate = catalog.templates.find(
    (t: any) => t.entryType === "character",
  );
  const roleField = catalog.fields.find(
    (f: any) => f.templateId === characterTemplate.id && f.key === "role",
  );
  const assigned = await api(
    `/books/${book.id}/entries/${entry.id}/template`,
    "PUT",
    {
      templateId: characterTemplate.id,
      expectedUpdatedAt: restoredEntry.updatedAt,
      expectedTemplateUpdatedAt: characterTemplate.updatedAt,
    },
  );
  await api(
    `/books/${book.id}/entries/${entry.id}/values/${roleField.id}`,
    "PUT",
    {
      value: "Courier",
      expectedUpdatedAt: assigned.updatedAt,
      expectedFieldUpdatedAt: roleField.updatedAt,
    },
  );
  const location = await api(`/books/${book.id}/entries`, "POST", {
    name: "Orchard",
    entryType: "location",
  });
  const owner = (await api(`/books/${book.id}/entries`)).find(
    (e: any) => e.id === entry.id,
  );
  const homeField = catalog.fields.find(
    (f: any) => f.templateId === characterTemplate.id && f.key === "home",
  );
  await api(
    `/books/${book.id}/entries/${entry.id}/values/${homeField.id}`,
    "PUT",
    {
      value: location.id,
      expectedUpdatedAt: owner.updatedAt,
      expectedFieldUpdatedAt: homeField.updatedAt,
    },
  );
  const customTemplate = await api(
    `/libraries/${library.id}/templates`,
    "POST",
    { name: "Container custom", entryType: "term" },
  );
  const customField = await api(`/libraries/${library.id}/fields`, "POST", {
    templateId: customTemplate.id,
    label: "Route",
    fieldType: "selection",
    options: [{ label: "North" }, { label: "South" }],
  });
  const customEntry = await api(`/books/${book.id}/entries`, "POST", {
    name: "A route",
    entryType: "term",
  });
  const assignedCustom = await api(
    `/books/${book.id}/entries/${customEntry.id}/template`,
    "PUT",
    {
      templateId: customTemplate.id,
      expectedUpdatedAt: customEntry.updatedAt,
      expectedTemplateUpdatedAt: customTemplate.updatedAt,
    },
  );
  await api(
    `/books/${book.id}/entries/${customEntry.id}/values/${customField.id}`,
    "PUT",
    {
      value: [customField.options[0].id],
      expectedUpdatedAt: assignedCustom.updatedAt,
      expectedFieldUpdatedAt: customField.updatedAt,
    },
  );
  await assert.rejects(
    () =>
      api(`/libraries/${library.id}/fields/${customField.id}`, "PUT", {
        options: [customField.options[1]],
        expectedUpdatedAt: customField.updatedAt,
      }),
    /400/,
  );
  await api(`/libraries/${library.id}/fields/${customField.id}`, "PUT", {
    label: "Travel route",
    expectedUpdatedAt: customField.updatedAt,
  });
  const eventTemplate = catalog.templates.find(
    (t: any) => t.entryType === "event",
  );
  const whenField = catalog.fields.find(
    (f: any) => f.templateId === eventTemplate.id && f.key === "when",
  );
  const eventEntry = await api(`/books/${book.id}/entries`, "POST", {
    name: "Storm",
    entryType: "event",
  });
  const assignedEvent = await api(
    `/books/${book.id}/entries/${eventEntry.id}/template`,
    "PUT",
    {
      templateId: eventTemplate.id,
      expectedUpdatedAt: eventEntry.updatedAt,
      expectedTemplateUpdatedAt: eventTemplate.updatedAt,
    },
  );
  const storyDate = { label: "Third moon", calendar: "Lantern", ordinal: -2 };
  await api(
    `/books/${book.id}/entries/${eventEntry.id}/values/${whenField.id}`,
    "PUT",
    {
      value: storyDate,
      expectedUpdatedAt: assignedEvent.updatedAt,
      expectedFieldUpdatedAt: whenField.updatedAt,
    },
  );
  const stale = await fetch(origin + `/api/documents/${scene.id}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      Cookie: cookie,
    },
    body: JSON.stringify({ document: first.document, expectedRevision: 1 }),
  });
  if (stale.status !== 409) throw new Error("A stale save was not refused.");
  await api(`/books/${book.id}`, "PUT", { title: "Renamed container book" });
  await api(`/nodes/${scene.id}`, "PUT", { title: "Renamed scene" });
  const destination = await api(`/books/${book.id}/nodes`, "POST", {
    title: "Chapter 2",
    kind: "chapter",
  });
  await api(`/nodes/${scene.id}/move`, "POST", {
    parentId: destination.id,
    beforeId: null,
  });
  await api(`/nodes/${destination.id}/trash`, "POST", {});
  assert.ok(
    (await api(`/books/${book.id}`)).nodes.find((n: any) => n.id === scene.id)
      .deletedAt,
  );
  await api(`/nodes/${destination.id}/restore`, "POST", {});
  await api(`/books/${book.id}/trash`, "POST", {});
  await api(`/books/${book.id}/restore`, "POST", {});
  const structure = await api(`/books/${book.id}`);
  assert.equal(structure.book.title, "Renamed container book");
  assert.equal(
    structure.nodes.find((n: any) => n.id === scene.id).parentId,
    destination.id,
  );
  assert.ok(!structure.nodes.find((n: any) => n.id === scene.id).deletedAt);
  assert.equal((await api(`/documents/${scene.id}/revisions`)).length, 2);
  const finalCatalog = await api(`/libraries/${library.id}/templates`);
  const worldCatalog = await api(`/libraries/${library.id}/worlds`);
  await compose("restart");
  await health();
  assert.deepEqual(
    await api(`/libraries/${library.id}/templates`),
    finalCatalog,
  );
  assert.deepEqual(await api(`/libraries/${library.id}/worlds`), worldCatalog);
  const persistedEntry = (await api(`/books/${book.id}/entries`)).find(
    (e: any) => e.id === entry.id,
  );
  assert.equal(persistedEntry.name, "Corin Vale");
  assert.deepEqual(persistedEntry.aliases, ["The courier"]);
  assert.equal(persistedEntry.toBeNamed, true);
  assert.ok(!persistedEntry.deletedAt);
  assert.equal(persistedEntry.values[roleField.id], "Courier");
  assert.equal(persistedEntry.values[homeField.id], location.id);
  assert.deepEqual(
    (await api(`/books/${book.id}/entries`)).find(
      (e: any) => e.id === eventEntry.id,
    ).values[whenField.id],
    storyDate,
  );
  const restored = await api(`/documents/${scene.id}`);
  assert.equal(restored.revision, 2);
  assert.deepEqual(restored.document, first.document);
  await api(`/nodes/${destination.id}/trash`, "POST", {});
  const trashed = (await api(`/books/${book.id}`)).nodes.find(
    (n: any) => n.id === destination.id,
  );
  const confirmation = {
    confirmTitle: trashed.title,
    expectedDeletedAt: trashed.deletedAt,
  };
  await compose(
    "exec",
    "-T",
    "studio",
    "node",
    "-e",
    "require('node:fs').chmodSync('/studio/backups',0o500)",
  );
  try {
    await assert.rejects(
      () => api(`/nodes/${destination.id}/purge`, "POST", confirmation),
      /503/,
    );
    assert.equal((await api(`/documents/${scene.id}`)).revision, 2);
  } finally {
    await compose(
      "exec",
      "-T",
      "studio",
      "node",
      "-e",
      "require('node:fs').chmodSync('/studio/backups',0o700)",
    );
  }
  const receipt = await api(
    `/nodes/${destination.id}/purge`,
    "POST",
    confirmation,
  );
  await assert.rejects(() => api(`/documents/${scene.id}`), /404/);
  await compose("restart", "studio");
  await health();
  await compose(
    "exec",
    "-T",
    "postgres",
    "createdb",
    "-U",
    "rolltop",
    "recovery_scratch",
  );
  // Reuse the container's existing DB credentials without exposing them in output.
  console.log(
    await compose(
      "exec",
      "-T",
      "studio",
      "node",
      "--input-type=module",
      "-e",
      `
    const url = new URL(process.env.DATABASE_URL); url.pathname = '/recovery_scratch';
    process.env.RECOVERY_DATABASE_URL = url.href;
    process.argv = ['node','restore-cli.ts', '/studio/backups/${receipt.backup}', '--empty-scratch'];
    await import('./packages/studio/src/restore-cli.ts');
    const { postgres } = await import('./packages/studio/src/postgres.ts');
    const { StudioStore } = await import('./packages/studio/src/store.ts');
    const db = postgres(url.href);
    try {
      const store = new StudioStore(db);
      const restoredBook = (await store.book('${book.id}')).book;
      if (restoredBook.universeId !== '${worldId}' || restoredBook.seriesId !== '${seriesId}') throw Error('World membership recovery mismatch');
      if ((await db.query('SELECT id FROM universes WHERE id=$1', ['${worldId}'])).rows.length !== 1) throw Error('World recovery mismatch');
      if ((await db.query('SELECT universe_id FROM series WHERE id=$1', ['${seriesId}'])).rows[0]?.universe_id !== '${worldId}') throw Error('Series recovery mismatch');
      const recoveredCatalog = await store.templates('${library.id}');
      if (recoveredCatalog.templates.length !== ${finalCatalog.templates.length} || recoveredCatalog.fields.length !== ${finalCatalog.fields.length}) throw Error('Template recovery mismatch');
      const recoveredEntry = (await store.entries('${book.id}')).find(e => e.id === '${entry.id}');
      if (recoveredEntry?.name !== 'Corin Vale' || !recoveredEntry.toBeNamed) throw Error('Entry recovery mismatch');
      if (recoveredEntry.values['${roleField.id}'] !== 'Courier') throw Error('Scalar value recovery mismatch');
      if (recoveredEntry.values['${homeField.id}'] !== '${location.id}') throw Error('Entry link recovery mismatch');
      const recoveredCustom = (await store.entries('${book.id}')).find(e=>e.id==='${customEntry.id}');
      if (recoveredCustom.values['${customField.id}'][0] !== '${customField.options[0].id}') throw Error('Custom choice recovery mismatch');
      const doc = await store.document('${scene.id}');
      const { default: assert } = await import('node:assert/strict');
      const recoveredEvent = (await store.entries('${book.id}')).find(e => e.id === '${eventEntry.id}');
      assert.deepEqual(recoveredEvent.values['${whenField.id}'], ${JSON.stringify(storyDate)});
      assert.equal(doc.revision, 2);
      assert.deepEqual(doc.document, ${JSON.stringify(first.document)});
      if ((await store.revisions('${scene.id}')).length !== 2) throw Error('Revision loss');
    } finally { await db.close(); }
  `,
    ),
  );
  const page = await fetch(origin);
  if (!page.ok || !(await page.text()).includes("Writers Rolltop"))
    throw new Error("Built web app is not served.");
  console.log(
    "PASS: OCI build, Compose startup, login, manuscript save, stale-save rejection, rename/move/trash/restore, PostgreSQL persistence across restart, template catalog initialization/restart/recovery, bible entry edit/conflict/Trash/restore and scalar/structured/reference/custom-definition persistence/recovery, verified deletion backup/failure/restore into separate PostgreSQL database, and web assets.",
  );
} finally {
  try {
    await compose("down", "--volumes", "--remove-orphans");
    console.log("Removed disposable containers and scratch database volume.");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
