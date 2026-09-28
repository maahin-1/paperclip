/**
 * Candidate closure pins from the isolated npm lock and official Node 24.19.0.
 * The non-Node graph is identical across targets, including platform resources.
 * macOS arm64 executed admission tests; x64 target execution remains pending.
 * Changing any package, helper, extension or bootstrap requires regenerating all
 * three pins. Never accept a digest supplied only by an installed manifest.
 */
export const PI_DISTRIBUTION_CLOSURE_SHA256 = Object.freeze({
  "darwin-arm64": "277568e3adb63faefafb1aedd8e8d33441608e94d9b764fbfd980e390ff07c8c",
  "darwin-x64": "f8f271ce09284ef0bf52a99adaa280798f2135b8f8a6ee628394324b923b5d7f",
  "linux-x64": "b0d71abf0cfe464c147fcc5bfd875e349f94773d84e46a1bdcbadfc0184f8690",
});
