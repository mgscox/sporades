import { runDatabaseAdapterConformance } from "./support/database-adapter-conformance.js";
import { CONFORMANCE_SURFACE } from "./support/conformance-surfaces/file-ingress-audit-outbox.js";

runDatabaseAdapterConformance(CONFORMANCE_SURFACE);
