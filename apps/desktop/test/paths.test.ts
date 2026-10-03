import assert from "node:assert/strict";
import { test } from "node:test";
import { DesktopError } from "../src/errors.js";
import { assertWritable, normalizePath, repoRelative, resolveInRepo } from "../src/paths.js";

const root = "/Users/ada/openmuse";

test("paths inside the repository resolve to absolute paths", () => {
  assert.equal(resolveInRepo(root, ".env"), `${root}/.env`);
  assert.equal(resolveInRepo(root, "infra/compose.yaml"), `${root}/infra/compose.yaml`);
  assert.equal(resolveInRepo(root, `${root}/infra/compose.yaml`), `${root}/infra/compose.yaml`);
});

test("a traversal outside the repository is rejected", () => {
  for (const attempt of [
    "../.env",
    "../../etc/passwd",
    "infra/../../secrets",
    "./nested/../../../elsewhere",
    "..\\..\\windows",
    "/etc/passwd",
    "/Users/ada/other-repo/.env",
  ])
    assert.throws(
      () => resolveInRepo(root, attempt),
      DesktopError,
      `expected ${attempt} to be rejected`,
    );
});

test("a sibling directory sharing a prefix is not inside the repository", () => {
  // /Users/ada/openmuse-backup must not pass a naive startsWith check.
  assert.throws(() => resolveInRepo(root, "/Users/ada/openmuse-backup/.env"), {
    name: "DesktopError",
    code: "PATH_OUTSIDE_REPO",
  });
});

test("normalization collapses dot segments without touching the disk", () => {
  assert.equal(normalizePath("/a/b/../c"), "/a/c");
  assert.equal(normalizePath("/a/./b//c/"), "/a/b/c");
  assert.equal(normalizePath("a/b/../../c"), "c");
  assert.equal(normalizePath("C:\\Users\\ada\\openmuse"), "C:/Users/ada/openmuse");
});

test("only the canonical state files may be written", () => {
  assert.equal(assertWritable(root, ".env"), `${root}/.env`);
  assert.equal(assertWritable(root, ".env.example"), `${root}/.env.example`);
  assert.equal(assertWritable(root, "infra/compose.yaml"), `${root}/infra/compose.yaml`);
  for (const attempt of [".git/config", "apps/server/src/config.ts", "infra/other.yaml"])
    assert.throws(() => assertWritable(root, attempt), { code: "PATH_OUTSIDE_REPO" });
});

test("repoRelative reports a path relative to the root", () => {
  assert.equal(repoRelative(root, `${root}/infra/compose.yaml`), "infra/compose.yaml");
  assert.equal(repoRelative(root, root), ".");
});
