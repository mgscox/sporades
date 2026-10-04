import { runDatabaseAdapterConformance } from "./support/database-adapter-conformance.js";
import { CONFORMANCE_SURFACE } from "./support/conformance-surfaces/live-queries.js";

runDatabaseAdapterConformance(CONFORMANCE_SURFACE);
