import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { cursorDistribution, cursorDistributionClosure, materializePinnedCursorDistribution, verifyCursorDistribution } from "./materialize-cursor-distribution.mjs";

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() { const path = await mkdtemp(join(tmpdir(), "cursor-distribution-test-")); roots.push(path); return path; }

test("pins complete archives and closures for every supported platform", async () => {
  for (const [platform, architecture] of [["darwin", "arm64"], ["darwin", "x64"], ["linux", "x64"]]) {
    const distribution = await cursorDistribution(platform, architecture);
    assert.equal(distribution.version, "2026.09.26-dd393fe");
    assert.match(distribution.archiveSha256, /^[a-f0-9]{64}$/);
    assert.match(distribution.closureSha256, /^[a-f0-9]{64}$/);
    assert.equal(distribution.url, `https://downloads.cursor.com/lab/${distribution.version}/${platform}/${architecture}/agent-cli-package.tar.gz`);
  }
  await assert.rejects(cursorDistribution("linux", "arm64"), /no pinned distribution/);
});

test("full closure verification catches changes outside the main entrypoint", async () => {
  const root = await fixture();
  await writeFile(join(root, "node"), "node", { mode: 0o700 });
  await writeFile(join(root, "index.js"), "entry");
  await mkdir(join(root, "chunks")); await writeFile(join(root, "chunks", "worker.js"), "worker");
  const closure = await cursorDistributionClosure(root);
  assert.deepEqual(closure.entries.map(entry => entry.path), ["chunks/worker.js", "index.js", "node"]);
  const expected = { executable: "node", entrypoint: "index.js", closureSha256: closure.sha256 };
  await verifyCursorDistribution(root, expected);
  await writeFile(join(root, "chunks", "worker.js"), "tampered");
  await assert.rejects(verifyCursorDistribution(root, expected), /closure digest mismatch/);
});

test("closure never accepts linked files or linked directories", async () => {
  const root = await fixture(); const outside = await fixture();
  await writeFile(join(outside, "secret"), "secret");
  await symlink(join(outside, "secret"), join(root, "link"));
  await assert.rejects(cursorDistributionClosure(root), /links or special files/);
  await rm(join(root, "link")); await symlink(outside, join(root, "directory"));
  await assert.rejects(cursorDistributionClosure(root), /links or special files/);
});

test("rejects altered archives before invoking tar and leaves no destination", async () => {
  const root = await fixture(); const archivePath = join(root, "bad.tar.gz");
  await writeFile(archivePath, "not a pinned archive");
  await assert.rejects(materializePinnedCursorDistribution({ archivePath, destination: join(root, "out"), platform: "darwin", architecture: "arm64" }), /archive digest mismatch/);
});

test("refuses to overwrite any existing destination", async () => {
  const root = await fixture(); await writeFile(join(root, "existing"), "keep");
  await assert.rejects(materializePinnedCursorDistribution({ destination: join(root, "existing") }), /already exists/);
});
