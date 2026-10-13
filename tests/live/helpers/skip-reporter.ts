import type { Reporter, TestModule } from "vitest/node";

/**
 * Prints one final line with the number of skipped live tests, so a run that
 * quietly skipped something cannot read like a clean one. Added alongside the
 * default reporter, not instead of it.
 */
export default class SkipCountReporter implements Reporter {
  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    let skipped = 0;
    const files = new Set<string>();
    for (const testModule of testModules) {
      for (const test of testModule.children.allTests()) {
        if (test.result().state === "skipped") {
          skipped += 1;
          files.add(testModule.moduleId.replace(/\\/g, "/").replace(/^.*\/tests\/live\//, ""));
        }
      }
    }
    const where = skipped > 0 ? ` (${[...files].sort().join(", ")})` : "";
    console.log(`\n[live] skipped tests: ${skipped}${where}`);
  }
}
