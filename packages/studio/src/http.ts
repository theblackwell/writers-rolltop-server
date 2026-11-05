// SPDX-License-Identifier: AGPL-3.0-only
import { worlds, editWorld, bookMembership } from "./worlds.ts";
import { editDefinition } from "./template-editor.ts";
import {
  relationshipCatalog,
  editRelationshipType,
  editRelationship,
} from "./relationships.ts";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { StudioStore, StudioError } from "./store.ts";
import { DocumentError } from "../../document-adapter/src/canonical.ts";
import { tokenHash, verify, validPasswordHash } from "./auth.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};
async function body(
  request: IncomingMessage,
  limit = 4 * 1024 * 1024,
): Promise<any> {
  if (!request.headers["content-type"]?.startsWith("application/json"))
    throw new StudioError(415, "JSON_REQUIRED", "Send JSON content.");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of request) {
    size += c.length;
    if (size > limit)
      throw new StudioError(413, "TOO_LARGE", "This request is too large.");
    chunks.push(c);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error();
    return parsed;
  } catch {
    throw new StudioError(
      400,
      "INVALID_JSON",
      "The request must contain a JSON object.",
    );
  }
}
const respond = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
};
export function studioServer(
  store: StudioStore,
  config: { origin: string; passwordHash: string; staticDir?: string },
) {
  const origin = new URL(config.origin);
  if (origin.origin !== config.origin)
    throw new Error(
      "STUDIO_ORIGIN must be an origin without a path or trailing slash.",
    );
  if (
    origin.protocol !== "https:" &&
    !(
      origin.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
    )
  )
    throw new Error(
      "Use HTTPS outside loopback. Put the studio behind a TLS reverse proxy.",
    );
  if (!validPasswordHash(config.passwordHash))
    throw new Error("Set STUDIO_PASSWORD_HASH using npm run password.");
  const secure = origin.protocol === "https:";
  const failures = new Map<string, { count: number; until: number }>();
  const cookie = (token: string, age: number) =>
    `rolltop_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? "; Secure" : ""}`;
  return createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    try {
      const url = new URL(req.url ?? "/", config.origin);
      if (!url.pathname.startsWith("/api/")) {
        if (!["GET", "HEAD"].includes(req.method ?? ""))
          throw new StudioError(405, "METHOD_NOT_ALLOWED", "Use GET.");
        const base = resolve(config.staticDir ?? "dist/web");
        const decoded = decodeURIComponent(url.pathname);
        const file = resolve(base, "." + decoded);
        if (file !== base && !file.startsWith(base + sep))
          throw new StudioError(404, "NOT_FOUND", "Page not found.");
        let data: Buffer;
        let path = file;
        try {
          data = await readFile(path);
        } catch {
          if (extname(decoded) && decoded !== "/index.html")
            throw new StudioError(404, "NOT_FOUND", "File not found.");
          path = resolve(base, "index.html");
          data = await readFile(path);
        }
        res.writeHead(200, {
          "Content-Type":
            contentTypes[extname(path)] ?? "application/octet-stream",
          "Cache-Control": "no-cache",
        });
        res.end(req.method === "HEAD" ? undefined : data);
        return;
      }
      if (!["GET", "POST", "PUT"].includes(req.method ?? ""))
        throw new StudioError(405, "METHOD_NOT_ALLOWED", "Unsupported method.");
      if (req.method !== "GET" && req.headers.origin !== config.origin)
        throw new StudioError(
          403,
          "ORIGIN_REJECTED",
          "Open the studio at its configured address before making changes.",
        );
      if (url.pathname === "/api/health" && req.method === "GET") {
        await store.db.query("SELECT 1");
        return respond(res, 200, { status: "ok" });
      }
      if (url.pathname === "/api/login" && req.method === "POST") {
        const key = req.socket.remoteAddress ?? "unknown";
        const now = Date.now();
        for (const [ip, attempt] of failures)
          if (attempt.until < now) failures.delete(ip);
        const attempts = failures.get(key) ?? {
          count: 0,
          until: now + 15 * 60 * 1000,
        };
        if (
          attempts.count >= 10 ||
          (failures.size >= 1000 && !failures.has(key))
        )
          throw new StudioError(
            429,
            "TRY_LATER",
            "Too many attempts. Try again in 15 minutes.",
          );
        attempts.count++;
        failures.set(key, attempts);
        if (!(await verify((await body(req)).password, config.passwordHash)))
          throw new StudioError(
            401,
            "LOGIN_FAILED",
            "That password did not match.",
          );
        failures.delete(key);
        const token = randomBytes(32).toString("hex");
        await store.db.query(
          "DELETE FROM studio_sessions WHERE expires_at < now()",
        );
        await store.db.query(
          "INSERT INTO studio_sessions VALUES($1,now() + interval '12 hours')",
          [tokenHash(token)],
        );
        res.setHeader("Set-Cookie", cookie(token, 43200));
        return respond(res, 200, { authenticated: true });
      }
      const token = req.headers.cookie
        ?.split(";")
        .map((s) => s.trim())
        .find((s) => s.startsWith("rolltop_session="))
        ?.slice(16);
      if (
        !token ||
        !/^[a-f0-9]{64}$/.test(token) ||
        !(
          await store.db.query(
            "SELECT 1 FROM studio_sessions WHERE token_hash=$1 AND expires_at > now()",
            [tokenHash(token)],
          )
        ).rows.length
      )
        throw new StudioError(401, "LOGIN_REQUIRED", "Sign in to your studio.");
      if (url.pathname === "/api/session" && req.method === "GET")
        return respond(res, 200, { authenticated: true });
      if (url.pathname === "/api/logout" && req.method === "POST") {
        await store.db.query(
          "DELETE FROM studio_sessions WHERE token_hash=$1",
          [tokenHash(token)],
        );
        res.setHeader("Set-Cookie", cookie("", 0));
        return respond(res, 200, { authenticated: false });
      }
      const parts = url.pathname.split("/").filter(Boolean).slice(1);
      for (const id of [parts[1]])
        if (id && !uuid.test(id))
          throw new StudioError(
            400,
            "INVALID_ID",
            "Use a valid item identifier.",
          );
      const method = req.method;
      if (
        parts[0] === "books" &&
        parts[2] === "relationships" &&
        parts.length === 3 &&
        method === "GET"
      )
        return respond(res, 200, await relationshipCatalog(store.db, parts[1]));
      if (
        ((parts[0] === "books" && parts[2] === "relationships") ||
          (parts[0] === "libraries" && parts[2] === "relationship-types")) &&
        ((parts.length === 3 && method === "POST") ||
          (parts.length === 4 && method === "PUT"))
      ) {
        if (parts[3] && !uuid.test(parts[3]))
          throw new StudioError(
            400,
            "INVALID_ID",
            "Choose a valid relationship or type.",
          );
        return respond(
          res,
          parts[3] ? 200 : 201,
          await (
            parts[0] === "books" ? editRelationship : editRelationshipType
          )(store.db, parts[1], await body(req), parts[3]),
        );
      }
      if (
        parts[0] === "libraries" &&
        parts.length === 3 &&
        parts[2] === "worlds" &&
        method === "GET"
      )
        return respond(res, 200, await worlds(store.db, parts[1]));
      if (
        parts[0] === "libraries" &&
        ["universes", "series"].includes(parts[2]) &&
        ((parts.length === 3 && method === "POST") ||
          (parts.length === 4 && method === "PUT"))
      ) {
        if (parts[3] && !uuid.test(parts[3]))
          throw new StudioError(
            400,
            "INVALID_ID",
            "Choose a valid world or series.",
          );
        return respond(
          res,
          parts[3] ? 200 : 201,
          await editWorld(
            store.db,
            parts[1],
            parts[2] as "universes" | "series",
            await body(req),
            parts[3],
          ),
        );
      }
      if (
        parts[0] === "books" &&
        parts.length === 3 &&
        parts[2] === "membership" &&
        method === "PUT"
      )
        return respond(
          res,
          200,
          await bookMembership(store.db, parts[1], await body(req)),
        );
      if (
        parts[0] === "libraries" &&
        parts.length === 3 &&
        parts[2] === "templates" &&
        method === "GET"
      )
        return respond(res, 200, await store.templates(parts[1]));

      if (
        parts[0] === "libraries" &&
        ["templates", "fields"].includes(parts[2]) &&
        ((parts.length === 3 && method === "POST") ||
          (parts.length === 4 && method === "PUT"))
      ) {
        if (parts[3] && !uuid.test(parts[3]))
          throw new StudioError(
            400,
            "INVALID_ID",
            "Choose a valid definition.",
          );
        return respond(
          res,
          parts[3] ? 200 : 201,
          await editDefinition(
            store.db,
            parts[1],
            parts[2] === "templates" ? "template" : "field",
            await body(req),
            parts[3],
          ),
        );
      }
      if (
        parts[0] === "books" &&
        parts[2] === "entries" &&
        parts.length === 3
      ) {
        if (method === "GET")
          return respond(res, 200, await store.entries(parts[1]));
        if (method === "POST")
          return respond(
            res,
            201,
            await store.createEntry(parts[1], await body(req)),
          );
      }
      if (
        parts[0] === "books" &&
        parts[2] === "entries" &&
        parts.length === 4 &&
        method === "PUT"
      ) {
        if (!uuid.test(parts[3]))
          throw new StudioError(400, "INVALID_ID", "Choose a valid entry.");
        return respond(
          res,
          200,
          await store.updateEntry(parts[1], parts[3], await body(req)),
        );
      }
      if (
        parts[0] === "books" &&
        parts[2] === "entries" &&
        method === "PUT" &&
        ((parts.length === 5 && parts[4] === "template") ||
          (parts.length === 6 && parts[4] === "values"))
      ) {
        if (!uuid.test(parts[3]) || (parts[5] && !uuid.test(parts[5])))
          throw new StudioError(
            400,
            "INVALID_ID",
            "Choose a valid entry and field.",
          );
        return respond(
          res,
          200,
          await store.editEntryField(
            parts[1],
            parts[3],
            await body(req, parts[5] ? 64 * 1024 * 1024 : undefined),
            parts[5],
          ),
        );
      }
      if (
        parts[0] === "nodes" &&
        parts[2] === "references" &&
        (parts.length === 3 || parts.length === 4)
      ) {
        if (parts[3] && !uuid.test(parts[3]))
          throw new StudioError(400, "INVALID_ID", "Choose a valid reference.");
        if (parts.length === 3 && method === "GET")
          return respond(res, 200, await store.references(parts[1]));
        if (
          (parts.length === 3 && method === "POST") ||
          (parts.length === 4 && method === "PUT")
        )
          return respond(
            res,
            method === "POST" ? 201 : 200,
            await store.saveReference(parts[1], await body(req), parts[3]),
          );
      }
      if (
        parts[0] === "books" &&
        parts[2] === "progress" &&
        parts.length === 3 &&
        method === "GET"
      )
        return respond(res, 200, await store.progress(parts[1]));
      if (parts[0] === "libraries" && parts.length === 1) {
        if (method === "GET") return respond(res, 200, await store.libraries());
        if (method === "POST")
          return respond(
            res,
            201,
            await store.createLibrary((await body(req)).title),
          );
      }
      if (parts[0] === "libraries" && parts.length === 2 && method === "GET")
        return respond(res, 200, await store.library(parts[1]));
      if (
        parts[0] === "libraries" &&
        parts.length === 3 &&
        parts[2] === "books" &&
        method === "POST"
      )
        return respond(
          res,
          201,
          await store.createBook(parts[1], (await body(req)).title),
        );
      if (
        parts[0] === "books" &&
        parts.length === 3 &&
        parts[2] === "search" &&
        method === "GET"
      )
        return respond(
          res,
          200,
          await store.search(parts[1], url.searchParams.get("q")),
        );
      if (
        parts[0] === "books" &&
        parts[2] === "notes" &&
        (parts.length === 3 || parts.length === 4)
      ) {
        if (parts[3] && !uuid.test(parts[3]))
          throw new StudioError(400, "INVALID_ID", "Choose a valid note.");
        if (parts.length === 3 && method === "GET")
          return respond(res, 200, await store.notes(parts[1]));
        if (
          (parts.length === 3 && method === "POST") ||
          (parts.length === 4 && method === "PUT")
        )
          return respond(
            res,
            method === "POST" ? 201 : 200,
            await store.saveNote(parts[1], await body(req), parts[3]),
          );
      }
      if (parts[0] === "books" && parts.length === 2 && method === "GET")
        return respond(res, 200, await store.book(parts[1]));
      if (
        parts[0] === "books" &&
        parts.length === 3 &&
        parts[2] === "nodes" &&
        method === "POST"
      ) {
        const input = await body(req);
        if (
          input.parentId !== undefined &&
          (typeof input.parentId !== "string" || !uuid.test(input.parentId))
        )
          throw new StudioError(400, "INVALID_ID", "Choose a valid parent.");
        return respond(
          res,
          201,
          await store.createNode(
            parts[1],
            input.title,
            input.kind,
            input.parentId,
          ),
        );
      }
      if (
        parts[0] === "books" &&
        parts.length === 3 &&
        parts[2] === "details" &&
        method === "PUT"
      )
        return respond(
          res,
          200,
          await store.updateBookDetails(parts[1], await body(req)),
        );
      if (parts[0] === "books" && parts.length === 2 && method === "PUT")
        return respond(
          res,
          200,
          await store.renameBook(parts[1], (await body(req)).title),
        );
      if (
        (parts[0] === "books" || parts[0] === "nodes") &&
        parts.length === 3 &&
        parts[2] === "purge" &&
        method === "POST"
      )
        return respond(
          res,
          200,
          await store.purge(
            parts[0] === "books" ? "book" : "node",
            parts[1],
            await body(req),
          ),
        );
      if (
        (parts[0] === "books" || parts[0] === "nodes") &&
        parts.length === 3 &&
        method === "POST" &&
        ["trash", "restore"].includes(parts[2])
      ) {
        // All mutation requests require JSON, including otherwise empty commands.
        await body(req);
        const result =
          parts[0] === "books"
            ? parts[2] === "trash"
              ? await store.trashBook(parts[1])
              : await store.restoreBook(parts[1])
            : parts[2] === "trash"
              ? await store.trashNode(parts[1])
              : await store.restoreNode(parts[1]);
        return respond(res, 200, result);
      }
      if (parts[0] === "nodes" && parts.length === 2 && method === "PUT")
        return respond(
          res,
          200,
          await store.renameNode(parts[1], (await body(req)).title),
        );
      if (
        parts[0] === "nodes" &&
        parts.length === 3 &&
        parts[2] === "move" &&
        method === "POST"
      ) {
        const input = await body(req);
        for (const value of [input.parentId, input.beforeId])
          if (
            value !== null &&
            (typeof value !== "string" || !uuid.test(value))
          )
            throw new StudioError(
              400,
              "INVALID_ID",
              "Choose a valid parent and position, or null for the book/end.",
            );
        return respond(
          res,
          200,
          await store.moveNode(parts[1], input.parentId, input.beforeId),
        );
      }
      if (parts[0] === "documents" && parts.length === 2) {
        if (method === "GET")
          return respond(res, 200, await store.document(parts[1]));
        if (method === "PUT") {
          const input = await body(req);
          return respond(
            res,
            200,
            await store.save(parts[1], input.document, input.expectedRevision),
          );
        }
      }
      if (
        parts[0] === "documents" &&
        parts[2] === "revisions" &&
        method === "GET"
      ) {
        if (parts.length === 3)
          return respond(res, 200, await store.revisions(parts[1]));
        if (parts.length === 4 && /^[1-9][0-9]{0,8}$/.test(parts[3]))
          return respond(
            res,
            200,
            await store.revision(parts[1], Number(parts[3])),
          );
      }
      throw new StudioError(404, "NOT_FOUND", "That action is not available.");
    } catch (e) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (e instanceof StudioError)
        return respond(res, e.status, {
          error: { code: e.code, message: e.message, detail: e.detail },
        });
      if (e instanceof DocumentError)
        return respond(res, 400, {
          error: { code: e.code, message: e.message },
        });
      // No SQL, connection strings, content, passwords or session tokens in logs/responses.
      respond(res, 500, {
        error: {
          code: "SERVER_ERROR",
          message:
            "The server could not finish. Your changes were not confirmed; keep your draft and try again.",
        },
      });
    }
  });
}
