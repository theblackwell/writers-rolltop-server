// SPDX-License-Identifier: AGPL-3.0-only
import { passwordHash } from "./auth.ts";
// Read a line from stdin rather than accepting secrets in process arguments.
let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 2048) throw new Error("Password input is too long.");
}
console.log(await passwordHash(input.replace(/\r?\n$/, "")));
