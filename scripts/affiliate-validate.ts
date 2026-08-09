import { resolve } from "node:path";

import { readAffiliateProgramRecords } from "../apps/studio/src/modules/affiliate-operations/programs.ts";
import {
  formatAffiliateValidationReport,
  validateAffiliateOperations,
} from "../apps/studio/src/modules/affiliate-operations/validation.ts";
import { REPOSITORY_ROOT, readPublicContent } from "../apps/studio/src/repository.ts";

try {
  const report = validateAffiliateOperations(readPublicContent(), readAffiliateProgramRecords(), {
    siteDistRoot: resolve(REPOSITORY_ROOT, "apps/site/dist"),
  });
  console.log(formatAffiliateValidationReport(report));
  if (report.errors.length > 0) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
