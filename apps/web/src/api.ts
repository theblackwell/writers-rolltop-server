// SPDX-License-Identifier: AGPL-3.0-only
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
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
  const value = await result.json();
  if (!result.ok)
    throw new ApiError(
      result.status,
      value.error?.message ?? "The server could not finish.",
    );
  return value;
}
export type Item = {
  id: string;
  title: string;
  kind?: string;
  bookId?: string;
  parentId?: string;
  orderKey?: string;
  deletedAt?: string;
};
