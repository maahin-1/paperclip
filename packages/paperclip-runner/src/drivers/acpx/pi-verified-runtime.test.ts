import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inventoryPiRuntimeFiles, PI_RUNTIME_MANIFEST_SCHEMA, verifyPiRuntimeManifest, type PiRuntimeManifest } from "./pi-verified-runtime.js";

const temporary: string[] = [];
afterEach(async () => { for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "paperclip-pi-verified-")); temporary.push(root);
  await mkdir(join(root, "assets"));
  for (const name of ["node", "pi.js", "extension.js", "wrapper.js", "assets/native.node", "assets/image.wasm"]) await writeFile(join(root, name), `pinned:${name}`);
  const manifest: PiRuntimeManifest = { schema: PI_RUNTIME_MANIFEST_SCHEMA, node: "node", piEntrypoint: "pi.js", extension: "extension.js", wrapperEntrypoint: "wrapper.js", files: await inventoryPiRuntimeFiles(root) };
  return { root, manifest };
}

describe("Pi complete runtime manifest", () => {
  it("binds interpreter, Pi, extension, wrapper, native modules and resources", async () => {
    const { root, manifest } = await fixture();
    const result = await verifyPiRuntimeManifest(root, manifest);
    expect(result.environment.PAPERCLIP_PI_EXTENSION_PATH).toBe(await realpath(join(root, "extension.js")));
    expect(result.manifestDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    await writeFile(join(root, "assets/image.wasm"), "replacement");
    await expect(verifyPiRuntimeManifest(root, manifest)).rejects.toThrow("package graph");
  });

  it("refuses unrecorded resources and duplicate manifest entries", async () => {
    const { root, manifest } = await fixture();
    await writeFile(join(root, "extra.js"), "untrusted");
    await expect(verifyPiRuntimeManifest(root, manifest)).rejects.toThrow("package graph");
    manifest.files.push(manifest.files[0]!);
    await expect(verifyPiRuntimeManifest(root, manifest)).rejects.toThrow("entry");
  });

  it("allows only in-pack relative links and rejects hardlinked mutable files", async () => {
    const { root, manifest } = await fixture();
    await symlink("assets", join(root, "resources"));
    manifest.files = await inventoryPiRuntimeFiles(root);
    await expect(verifyPiRuntimeManifest(root, manifest)).resolves.toHaveProperty("manifestDigest");
    await symlink(tmpdir(), join(root, "escape"));
    await expect(inventoryPiRuntimeFiles(root)).rejects.toThrow("escapes");
    await rm(join(root, "escape"));
    await link(join(root, "pi.js"), join(root, "hardlink.js"));
    await expect(inventoryPiRuntimeFiles(root)).rejects.toThrow("writable name");
  });
});
