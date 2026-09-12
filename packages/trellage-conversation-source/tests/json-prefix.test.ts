import assert from "node:assert/strict"
import { test } from "node:test"
import { isIncompleteJson } from "../src/json-prefix.ts"

test("JSON prefixes identify truncated values without relying on engine error text", () => {
  for (const source of [
    "", " \t\n", "{", "[", '{"key"', '{"key":', '{"key":1', '{"key":1,',
    '{"key":"text', '{"key":"text\\', '{"key":"\\u', '{"key":"\\u123',
    '{"key":tru', '{"key":fals', '{"key":nu', '{"key":-', '{"key":1.',
    '{"key":1e', '{"key":1e+', '{"key":[1,', '{"key":{"nested":true}',
  ]) assert.equal(isIncompleteJson(source), true, source)
})

test("malformed tails are not mistaken for incomplete JSON", () => {
  for (const source of [
    '{"key":}', '{"key":1 garbage', '{"key":01', '{"key":1.e', '{"key":trueX',
    '{"key":"\\x', '{"key":"\\uQ', '{"key":"line\nbreak', '{"key",', '{"key":1,}',
    "[1,]", "[}", "{]", "{}{}", '{"key":/*comment*/', "{unquoted", '{"key":NaN',
  ]) assert.equal(isIncompleteJson(source), false, source)
})

test("complete JSON never adds an incomplete-record notice", () => {
  for (const source of [
    "{}", "[]", "null", "false", "0", "-0", "123", "-1.2e-3", '"text"',
    '{"key":[1,2,true,false,null,{},[],"escaped\\ntext","\\u1234"]} \r\n',
  ]) assert.equal(isIncompleteJson(source), false, source)
})

test("every unfinished prefix of nested JSON is recognized without recursive parsing", () => {
  const source = '{"a":[1,-2.5e+3,true,false,null,"a\\u1234\\"b"],"empty":{}}'
  for (let length = 0; length < source.length; length += 1) {
    assert.equal(isIncompleteJson(source.slice(0, length)), true, `prefix ${length}`)
  }
  assert.equal(isIncompleteJson("[".repeat(10_000) + "0" + "]".repeat(9_999)), true)
})
