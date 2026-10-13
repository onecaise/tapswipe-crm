// The Storage half of scripts/purge-legacy-documents.mjs, against the real
// local Storage API -- on keys this file creates and removes itself, never on
// anything else in the bucket. The script's own entry point only targets dev
// and is not run by any suite.
//
// Run with:  npm run test:live
//
// What a fake bucket cannot prove: that Storage's list() really reports
// folders the way listAllObjects() expects (a null id), and that remove()
// really deletes the BYTES -- an object deleted through the API cannot be
// downloaded afterwards, which deleting storage.objects rows in SQL would not
// achieve.

import { afterAll, describe, expect, it } from "vitest";

import { BUCKET, adminClient } from "./helpers/stack";
import {
  listAllObjects,
  removeInBatches,
} from "../../scripts/purge-legacy-documents.mjs";

const PREFIX = `live-purge-${Date.now()}`;
const KEYS = [
  `${PREFIX}/merchant/1/aaaa`,
  `${PREFIX}/lead/2/bbbb`,
  // An orphan at an odd depth: no row would ever name it.
  `${PREFIX}/stray`,
];

afterAll(async () => {
  await adminClient().storage.from(BUCKET).remove(KEYS);
});

describe("purge helpers against the real legacy bucket", () => {
  it("lists nested and orphaned objects, then removes their bytes", async () => {
    const admin = adminClient();
    for (const key of KEYS) {
      const { error } = await admin.storage
        .from(BUCKET)
        .upload(key, new Blob([`bytes of ${key}`]), { upsert: true });
      expect(error, key).toBeNull();
    }

    const listed: string[] = await listAllObjects(admin.storage, BUCKET);
    for (const key of KEYS) expect(listed, key).toContain(key);

    const { removed, failed } = await removeInBatches(admin.storage, BUCKET, KEYS, 2);
    expect(failed).toEqual([]);
    expect([...removed].sort()).toEqual([...KEYS].sort());

    // The bytes are gone, not just the listing.
    for (const key of KEYS) {
      const { data, error } = await admin.storage.from(BUCKET).download(key);
      expect(data, key).toBeNull();
      expect(error, key).not.toBeNull();
    }
    const after: string[] = await listAllObjects(admin.storage, BUCKET);
    for (const key of KEYS) expect(after, key).not.toContain(key);
  });
});
