import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { commitment, dumps, dumpsBytes, formatNumber, isCanonical, keccakHex } from "../canonical.js";
import { REPO_ROOT } from "../config.js";

test("number formatting follows tb-cjson-1", () => {
  assert.equal(formatNumber(2.0), "2");
  assert.equal(formatNumber(-0), "0");
  assert.equal(formatNumber(1e-7), "0.0000001");
  assert.equal(formatNumber(1.5e-5), "0.000015");
  assert.equal(formatNumber(1e21), "1000000000000000000000");
  assert.equal(formatNumber(0.1 + 0.2), "0.30000000000000004");
  assert.equal(formatNumber(-3.25), "-3.25");
  assert.throws(() => formatNumber(NaN));
  assert.throws(() => formatNumber(Infinity));
});

test("objects are sorted recursively with no whitespace", () => {
  assert.equal(dumps({ b: [1, { z: null, a: true }], a: "x\ny\"", c: 0.5 }), '{"a":"x\\ny\\"","b":[1,{"a":true,"z":null}],"c":0.5}');
  assert.throws(() => dumps({ "é": 1 }));
});

test("reproduces the bytes and trajectory hash the Python simulator wrote", () => {
  for (const name of ["failure", "baseline"]) {
    const file = path.join(REPO_ROOT, "evidence", "milestone", "runs", `${name}.json`);
    const raw = new Uint8Array(fs.readFileSync(file));
    assert.ok(isCanonical(raw), `${name}.json is canonical`);
    const doc = JSON.parse(Buffer.from(raw).toString("utf8"));
    const again = dumpsBytes(doc);
    assert.equal(again.length, raw.length);
    assert.equal(Buffer.compare(Buffer.from(again), Buffer.from(raw)), 0, "byte-identical re-serialization");
    assert.equal(commitment(doc.frames), doc.trajectory_hash, "trajectory hash = keccak256(canonical(frames))");
  }
});

test("keccak matches the Python implementation on a known vector", () => {
  // keccak256("") is the well-known empty-input digest
  assert.equal(keccakHex(new Uint8Array()), "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
});
