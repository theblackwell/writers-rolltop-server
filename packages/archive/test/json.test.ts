import { test } from "node:test";
import assert from "node:assert/strict";
import { JsonSyntaxError, JsonValueError, parseJson, stableStringify } from "../src/json.ts";

test("parseJson accepts ordinary JSON and keeps integers exact", () => {
  assert.deepEqual(parseJson('{"a":[1,-2,0,9007199254740991,1.5,"x",true,false,{}],"b":{"c":"\\u00e9\\ud83d\\ude00\\n"}}'), { a: [1, -2, 0, 9007199254740991, 1.5, "x", true, false, {}], b: { c: "é😀\n" } });
});
test("parseJson refuses duplicate keys, trailing commas, leading zeros, comments and lone surrogates", () => {
  for (const bad of ['{"a":1,"a":2}', "[1,]", "[01]", "[1] // c", '["\\ud800"]', '["\\udc00"]', "[", '{"a"}', "[\"a\tb\"]", "{'a':1}", "-", "[.5]", "[1e]"]) {
    assert.throws(() => parseJson(bad), JsonSyntaxError, bad);
  }
});
test("parseJson refuses null, unsafe integers, -0 and whole numbers written as fractions", () => {
  for (const bad of ["null", "[null]", '{"a":null}', "9007199254740992", "-9007199254740992", "[-0]", "1.0", "1e2", "[3.00]"]) {
    assert.throws(() => parseJson(bad), JsonValueError, bad);
  }
});
test("nesting deeper than 128 is refused, 100 is fine", () => {
  assert.throws(() => parseJson("[".repeat(129) + "]".repeat(129)), JsonSyntaxError);
  parseJson("[".repeat(100) + "]".repeat(100));
});
test("stableStringify sorts keys by code point, drops undefined, and is deterministic", () => {
  assert.equal(stableStringify({ b: 1, a: { d: [3, { z: 1, y: undefined }], c: "x" } }), '{"a":{"c":"x","d":[3,{"z":1}]},"b":1}');
  // U+FF5E (BMP) sorts before U+1F600 (supplementary) in UTF-8 byte order, though not in UTF-16 code unit order.
  assert.equal(stableStringify({ "\u{1F600}": 1, "～": 2 }), '{"～":2,"\u{1F600}":1}');
  const proto: any = parseJson('{"__proto__":{"x":1}}');
  assert.equal(Object.hasOwn(proto, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(proto), Object.prototype);
  assert.equal(stableStringify(proto), '{"__proto__":{"x":1}}');
});
