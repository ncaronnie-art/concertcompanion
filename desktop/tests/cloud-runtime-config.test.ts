import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_STORAGE_NAMESPACE, resolveRuntimeConfig } from "../netlify/server/runtime-config.ts";

const token = "ab".repeat(32);
const origin = "https://vibe-test.example";
const valid = { VIBE_ACCESS_KEY: token, VIBE_PUBLIC_ORIGIN: origin };

test("runtime setup reports each missing or malformed setting without disclosing values", () => {
  assert.deepEqual(resolveRuntimeConfig({}), { ok: false, issues: ["VIBE_KEY_MISSING", "VIBE_ORIGIN_MISSING"] });
  assert.deepEqual(resolveRuntimeConfig({ VIBE_ACCESS_KEY: " \n", VIBE_PUBLIC_ORIGIN: "\t" }), { ok: false, issues: ["VIBE_KEY_MISSING", "VIBE_ORIGIN_MISSING"] });
  for (const key of ["invalid-private-value", "a".repeat(63), "a".repeat(65), "AB".repeat(32), `${token.slice(0, 32)} ${token.slice(32)}`]) {
    const result = resolveRuntimeConfig({ ...valid, VIBE_ACCESS_KEY: key });
    assert.deepEqual(result, { ok: false, issues: ["VIBE_KEY_INVALID"] });
    assert.ok(!JSON.stringify(result).includes(key));
  }
  assert.deepEqual(resolveRuntimeConfig({ VIBE_ACCESS_KEY: token }), { ok: false, issues: ["VIBE_ORIGIN_MISSING"] });
});

test("valid runtime settings trim outer whitespace and preserve exact key content", () => {
  assert.deepEqual(resolveRuntimeConfig({ VIBE_ACCESS_KEY: ` \n${token}\r\n `, VIBE_PUBLIC_ORIGIN: `\t${origin} ` }), {
    ok: true, token, origin, storageNamespace: DEFAULT_STORAGE_NAMESPACE,
  });
  const environment = { ...valid };
  assert.equal(resolveRuntimeConfig(environment).ok, true);
  environment.VIBE_ACCESS_KEY = "changed-invalid-setting";
  assert.deepEqual(resolveRuntimeConfig(environment), { ok: false, issues: ["VIBE_KEY_INVALID"] }, "settings are read at call time, not cached or bundled");
});

test("runtime origin validation remains exact HTTPS with no extra URL components", () => {
  for (const value of ["http://vibe-test.example", `${origin}/`, `${origin}/path`, `${origin}?key=private`, `${origin}#private`, "https://user:private@vibe-test.example", "https://*.example", "not-an-origin"]) {
    assert.deepEqual(resolveRuntimeConfig({ ...valid, VIBE_PUBLIC_ORIGIN: value }), { ok: false, issues: ["VIBE_ORIGIN_INVALID"] });
  }
});

test("optional private storage namespace defaults safely and rejects unsafe names", () => {
  assert.deepEqual(resolveRuntimeConfig({ ...valid, VIBE_STORAGE_NAMESPACE: " ronnie-phone-2026 " }), { ok: true, token, origin, storageNamespace: "ronnie-phone-2026" });
  for (const value of ["", " ", "../other", "a/b", "name?key=private", "name with spaces", "-prefix", "a".repeat(64)]) {
    assert.deepEqual(resolveRuntimeConfig({ ...valid, VIBE_STORAGE_NAMESPACE: value }), { ok: false, issues: ["VIBE_STORAGE_NAMESPACE_INVALID"] });
  }
  assert.deepEqual(resolveRuntimeConfig({ VIBE_ACCESS_KEY: "bad", VIBE_PUBLIC_ORIGIN: "bad", VIBE_STORAGE_NAMESPACE: "bad/name" }), {
    ok: false, issues: ["VIBE_KEY_INVALID", "VIBE_ORIGIN_INVALID", "VIBE_STORAGE_NAMESPACE_INVALID"],
  });
});
