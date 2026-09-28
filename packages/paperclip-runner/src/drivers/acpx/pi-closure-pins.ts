/**
 * Candidate closure pins from the isolated npm lock and official Node 24.19.0.
 * The non-Node graph is identical across targets, including platform resources.
 * macOS arm64 executed admission tests; x64 target execution remains pending.
 * Changing any package, helper, extension or bootstrap requires regenerating all
 * three pins. Never accept a digest supplied only by an installed manifest.
 */
export const PI_DISTRIBUTION_CLOSURE_SHA256 = Object.freeze({
  "darwin-arm64": "c79fa33fd134e860fd777cd467873438b17b80b0b462a89e95cc63fbaa46bada",
  "darwin-x64": "73624d1f59d55f7654bbe014ca30b55f5d0b3fbb3343467e71105414743a5c1c",
  "linux-x64": "2f8ae83b42b12e6d4a99e347c245c274f67a2b180ab411441e8fe747fa84d72d",
});
