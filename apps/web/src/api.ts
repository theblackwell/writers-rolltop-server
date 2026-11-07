// SPDX-License-Identifier: AGPL-3.0-only
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
let unauthorized: (() => void) | undefined;
/** The app registers a handler that returns to the login screen on session expiry. */
export function onUnauthorized(handler: (() => void) | undefined) {
  unauthorized = handler;
}
/** Read a response defensively: proxies and crashes can return non-JSON bodies. */
export async function readResponse<T = any>(
  result: Response,
  fallback = "The server could not finish.",
  login = false,
): Promise<T> {
  const text = await result.text().catch(() => "");
  let value: any;
  let parsed = false;
  try {
    value = text ? JSON.parse(text) : undefined;
    parsed = true;
  } catch {
    /* Not JSON; fall back to the HTTP status text. */
  }
  if (result.status === 401 && !login) unauthorized?.();
  if (!result.ok)
    throw new ApiError(
      result.status,
      (typeof value?.error?.message === "string" && value.error.message) ||
        result.statusText ||
        fallback,
    );
  if (!parsed && text)
    throw new ApiError(
      result.status,
      "The server sent an unreadable response.",
    );
  return value as T;
}
export async function api<T = any>(
  path: string,
  method = "GET",
  data?: unknown,
): Promise<T> {
  const result = await fetch("/api" + path, {
    method,
    credentials: "same-origin",
    headers: data === undefined ? {} : { "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  return readResponse<T>(
    result,
    "The server could not finish.",
    path === "/login" || path === "/session",
  );
}
export type Item = {
  coverAttachment?: string;
  id: string;
  title: string;
  kind?: string;
  bookId?: string;
  parentId?: string;
  orderKey?: string;
  deletedAt?: string;
  updatedAt?: string;
  universeId?: string;
  seriesId?: string;
  subtitle?: string;
  authorName?: string;
  description?: string;
  language?: string;
  targetWordCount?: number;
  targetDate?: string;
  logline?: string;
  premise?: string;
  themes?: string;
  arcs?: string;
  principles?: string;
  plan?: string;
  synopsis?: string;
  status?: string;
  povEntryId?: string;
  settingEntryId?: string;
};
