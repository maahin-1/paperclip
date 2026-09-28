/**
 * Candidate closure pins from the isolated npm lock and official Node 24.19.0.
 * The non-Node graph is identical across targets, including platform resources.
 * macOS arm64 executed admission tests; x64 target execution remains pending.
 * Changing any package, helper, extension or bootstrap requires regenerating all
 * three pins. Never accept a digest supplied only by an installed manifest.
 */
export const PI_DISTRIBUTION_CLOSURE_SHA256 = Object.freeze({
  "darwin-arm64": "2fde022b3714c497f352e628789c4dd47b6446351dc69779293b3a0eafcbc17f",
  "darwin-x64": "049fe566c4844db05187cc7e3e94b813f9a3fa8600d37c344f3b425b8776f743",
  "linux-x64": "12ff126d91bc296f39bd6c82b52b95dbf8075076e6257bb73256b043f614f391",
});
