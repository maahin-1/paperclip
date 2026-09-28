import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyNativeAcpxInstallation, type VerifiedAcpxInstallation } from "./installation-integrity.js";
import { COPILOT_LAUNCH_ARGUMENTS, COPILOT_VERSION } from "./copilot-profile.js";
import { QUALIFIED_ACPX_PROFILES, type QualifiedAcpxProfile } from "./qualified-profiles.js";

export const COPILOT_CLOSURE_SHA256 = Object.freeze({
  "darwin-arm64": "fb3b367a45cd76122fe931521fa2a18adf234ba944fc302db9e10e005e57037e",
  "darwin-x64": "05f3497b336b3efdec347beb2e3b80b02cfa95f811fafddc25d0b029ab95d711",
  "linux-x64": "1a675c5b54ae4d94f08718a318451e0499708ded388b4cfd98acec6b4311ccbd",
});

/** Admission primitive only. Pending candidates remain gated by qualification. */
export async function verifyCopilotInstallation(profile: QualifiedAcpxProfile): Promise<VerifiedAcpxInstallation> {
  const expected = QUALIFIED_ACPX_PROFILES.copilot;
  if (profile.agent !== "copilot" || profile.agentProfileVersion !== 2
    || profile.acpxVersion !== expected.acpxVersion || profile.agentServerPackage !== "@github/copilot"
    || profile.agentServerVersion !== COPILOT_VERSION || profile.commandDigest !== expected.commandDigest
    || profile.agentRuntimePackage !== null || profile.agentRuntimeVersion !== null) {
    throw new Error("Copilot installation requires the exact pinned candidate profile");
  }
  const platform = `${process.platform}-${process.arch}`;
  if (!Object.prototype.hasOwnProperty.call(COPILOT_CLOSURE_SHA256, platform)) {
    throw new Error(`Copilot native distribution is not pinned for ${platform}`);
  }
  const distributionRoot = join(ownedPackageRoot(), "provider-assets", "copilot", platform);
  const native = await verifyNativeAcpxInstallation({
    distributionRoot,
    manifestPath: join(distributionRoot, ".paperclip-copilot-closure.json"),
    expectedClosureSha256: COPILOT_CLOSURE_SHA256[platform as keyof typeof COPILOT_CLOSURE_SHA256],
    executable: "copilot", fixedArguments: COPILOT_LAUNCH_ARGUMENTS,
    isolatedCacheEnvironmentName: "COPILOT_PKG_CACHE_HOME",
  });
  // The host identity binds the versioned profile. Native admission independently
  // binds the complete platform closure before creating each single-use lease.
  return Object.freeze({ ...native, commandDigest: expected.commandDigest });
}

function ownedPackageRoot(): string {
  const modulePath = fileURLToPath(import.meta.url);
  const directory = dirname(modulePath);
  if (basename(directory) === "acpx" && basename(dirname(directory)) === "drivers"
    && ["src", "dist"].includes(basename(dirname(dirname(directory))))
    && /^copilot-installation\.(?:ts|js)$/.test(basename(modulePath))) {
    return resolve(directory, "../../..");
  }
  // The verified CommonJS entrypoint replaces import.meta.url with its own URL;
  // the bundled ESM entrypoint has the same runtime layout.
  if (basename(directory) === "cli" && basename(dirname(directory)) === "dist"
    && /^acpx-runtime-sidecar\.(?:cjs|js)$/.test(basename(modulePath))) {
    return resolve(directory, "../..");
  }
  throw new Error("Copilot assets require the runner's build-owned module layout");
}
