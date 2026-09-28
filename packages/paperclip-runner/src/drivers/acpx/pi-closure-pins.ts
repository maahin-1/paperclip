/**
 * Candidate closure pins from the isolated npm lock and official Node 24.19.0.
 * The non-Node graph is identical across targets, including platform resources.
 * macOS arm64 executed admission tests; x64 target execution remains pending.
 * Changing any package, helper, extension or bootstrap requires regenerating all
 * three pins. Never accept a digest supplied only by an installed manifest.
 */
export const PI_DISTRIBUTION_CLOSURE_SHA256 = Object.freeze({
  "darwin-arm64": "f2c95f532e4b56a57e938ceb62b5ea1a86bc721cba29b41de6270afe3fe0041f",
  "darwin-x64": "93f3c06c91fc9e06084dff083f3b43ac100dee3ac2c5f5981e3d281f1e561a20",
  "linux-x64": "99707d2c78656bebdf5df4b85e4674a72d5d30a3a0c730536246251a2889d0a8",
});
