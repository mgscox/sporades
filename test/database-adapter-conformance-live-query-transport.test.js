import { runDatabaseAdapterConformance } from "./support/database-adapter-conformance.js";
import { CONFORMANCE_SURFACE } from "./support/conformance-surfaces/live-query-transport.js";

runDatabaseAdapterConformance(CONFORMANCE_SURFACE);
