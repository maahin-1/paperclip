import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { AcpxRuntimeHost, type AcpxRuntimeHostDependencies, type AcpxRuntimePortOpenOptions } from "./runtime-host.js";

it("reports missing Copilot authentication before spawn and releases admission ownership for retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "paperclip-copilot-auth-admission-"));
  const runtimeDirectory = join(root, "runtime");
  const workingDirectory = join(root, "workspace");
  await Promise.all([mkdir(runtimeDirectory), mkdir(workingDirectory), mkdir(join(root, "provider"))]);
  const openRuntime = vi.fn(async (_options: AcpxRuntimePortOpenOptions): Promise<never> => {
    throw new Error("fixture stopped before provider spawn");
  });
  const close = vi.fn(async () => {});
  const openCommand = vi.fn(async () => ({ spawn: () => { throw new Error("must not spawn"); }, close }));
  const dependencies: AcpxRuntimeHostDependencies = {
    verifyInstallation: async profile => ({ commandDigest: profile.commandDigest,
      agentServerPackageJsonPath: join(root, "provider/package.json"), agentRuntimePackageJsonPath: null, openCommand }),
    openRuntime, reportRetainedCleanupFailure: () => {},
  };
  const options = { agent: "copilot" as const, model: "explicit-model", normalizedSessionId: "copilot-auth-test",
    runtimeDirectory, workingDirectory, providerPolicy: { readOnly: false } };
  try {
    await expect(AcpxRuntimeHost.open({ ...options, environment: { GH_TOKEN: "ambient-forbidden", GITHUB_TOKEN: "ambient-forbidden" } }, dependencies))
      .rejects.toMatchObject({ code: "COPILOT_AUTH_REQUIRED", retryable: false });
    expect(openCommand).not.toHaveBeenCalled();
    expect(openRuntime).not.toHaveBeenCalled();
    await expect(AcpxRuntimeHost.open({ ...options, environment: { COPILOT_GITHUB_TOKEN: "explicit-fixture-only", GH_TOKEN: "ambient-forbidden" } }, dependencies))
      .rejects.toThrow("fixture stopped before provider spawn");
    expect(openRuntime).toHaveBeenCalledOnce();
    const environment = openRuntime.mock.calls[0]![0].launchEnvironment;
    expect(environment.COPILOT_GITHUB_TOKEN).toBe("explicit-fixture-only");
    expect(environment.GH_TOKEN).toBeUndefined();
    expect(environment.GITHUB_TOKEN).toBeUndefined();
    expect(close).toHaveBeenCalled();
  } finally { await rm(root, { recursive: true, force: true }); }
});
