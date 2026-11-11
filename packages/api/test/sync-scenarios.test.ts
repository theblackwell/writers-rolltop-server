// Runs every Spec sync scenario (vendored in packages/document-adapter/test/spec/fixtures/sync) against the real HTTP app
// and a scratch PostgreSQL database. Matcher rules are those of Spec/tools/check-schemas.mjs: "@name" captures a
// conflict id on first use and must repeat, "*" matches any string, objects must have exactly the expected keys.
// Every scenario must pass: there is no todo or skip mechanism. Each scenario gets a fresh database, so a fresh library and, set from the fixture, its epoch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { server, syncFixtures } from "./helpers.ts";

const EXPECTED_FIXTURES = 18;
const FIXED_TIME = new Date("2026-11-11T12:00:00Z"); // the reference model's clock; the spec exempts only `at` values

const CAPTURE = /^@[A-Za-z][A-Za-z0-9]*$/;
const typeOf = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

function matchBody(expected: any, actual: any, captures: Record<string, string>, at: string, errors: string[]): void {
  if (typeof expected === "string" && expected.startsWith("@")) {
    if (!CAPTURE.test(expected)) return void errors.push(`${at}: ${JSON.stringify(expected)} is not a valid capture name; "@" is reserved`);
    if (!Object.hasOwn(captures, expected)) {
      if (typeof actual !== "string" || actual.length < 1 || actual.length > 64) return void errors.push(`${at}: capture ${expected} needs a conflictId string (1 to 64 characters), got ${JSON.stringify(actual)}`);
      captures[expected] = actual;
    } else if (captures[expected] !== actual) errors.push(`${at}: ${expected} was ${JSON.stringify(captures[expected])}, now ${JSON.stringify(actual)}`);
    return;
  }
  if (expected === "*") {
    if (typeof actual !== "string") errors.push(`${at}: expected any string, got ${typeOf(actual)}`);
    return;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return void errors.push(`${at}: expected array of ${expected.length}, got ${JSON.stringify(actual)}`);
    expected.forEach((e, i) => matchBody(e, actual[i], captures, `${at}[${i}]`, errors));
    return;
  }
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) return void errors.push(`${at}: expected object, got ${JSON.stringify(actual)}`);
    const ek = Object.keys(expected).sort(), ak = Object.keys(actual).sort();
    if (JSON.stringify(ek) !== JSON.stringify(ak)) errors.push(`${at}: keys ${ak.join(",")} differ from expected ${ek.join(",")}`);
    for (const k of ek) if (k in actual) matchBody(expected[k], actual[k], captures, `${at}.${k}`, errors);
    return;
  }
  if (expected !== actual) errors.push(`${at}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const substitute = (v: any, captures: Record<string, string>): any =>
  typeof v === "string" && Object.hasOwn(captures, v) ? captures[v]
    : Array.isArray(v) ? v.map((x) => substitute(x, captures))
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substitute(x, captures)]))
    : v;

// The scenarios come from the vendored Spec fixtures. ROLLTOP_SYNC_FIXTURES points the runner at another folder (used to
// check that the runner itself fails on a wrong expectation); the fixture-count guard applies to either.
const fixturesDir = process.env.ROLLTOP_SYNC_FIXTURES ?? syncFixtures;
const files = readdirSync(fixturesDir).filter((f) => f.endsWith(".json")).sort();

test("the vendored sync fixtures are all there", () => {
  assert.equal(files.length, EXPECTED_FIXTURES, `found ${files.length} fixture files in ${fixturesDir}`);
});

for (const file of files) {
  const scenario = JSON.parse(readFileSync(path.join(fixturesDir, file), "utf8"));
  test(`sync scenario ${file}`, async () => {
    const s = await server({ clock: () => FIXED_TIME });
    try {
      await s.query(`UPDATE sync_state SET epoch = '${scenario.epoch}'`);
      const captures: Record<string, string> = Object.create(null);
      assert.ok(scenario.steps.length > 0);
      for (const [i, step] of scenario.steps.entries()) {
        const { method, path: url, body } = step.request;
        const res = await s.inject({ method, url, ...(body === undefined ? {} : { payload: substitute(body, captures) }) });
        const errors: string[] = [];
        if (!step.response) errors.push("step has no expected response");
        else {
          if (res.statusCode !== step.response.status) errors.push(`status ${res.statusCode}, expected ${step.response.status}`);
          matchBody(step.response.body, res.json(), captures, "$", errors);
          if (step.invalid_request && (step.response.status !== 400 || step.response.body?.error?.code !== "INVALID_REQUEST")) {
            errors.push("an invalid_request step must expect 400 INVALID_REQUEST");
          }
          const msg = res.json()?.error?.message;
          if (msg !== undefined) assert.ok(typeof msg === "string" && msg.length <= 200);
        }
        assert.deepEqual(errors, [], `${file} step ${i + 1}: ${method} ${url}\n  ${errors.join("\n  ")}\n  body: ${res.body.slice(0, 600)}`);
      }
    } finally { await s.drop(); }
  });
}
