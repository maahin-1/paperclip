/**
 * Candidate closure pins from the isolated npm lock and official Node 24.19.0.
 * The non-Node graph is identical across targets, including platform resources.
 * macOS arm64 executed admission tests; x64 target execution remains pending.
 * Changing any package, helper, extension or bootstrap requires regenerating all
 * three pins. Never accept a digest supplied only by an installed manifest.
 */
export const PI_DISTRIBUTION_CLOSURE_SHA256 = Object.freeze({
  "darwin-arm64": "a26e98fe3f4d3d93c13beffdb4e8b778d438dd1b3bca8a9b1610154342382681",
  "darwin-x64": "9423812469c8aedba369c581b23a4302e4d86aac06e98e3d14d95d5e875597f0",
  "linux-x64": "892085f1f22c0813e4d722c37ddaa343a01aecfeff360d8ca6d5b201dd3f01f5",
});
