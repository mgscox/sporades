import { runDatabaseAdapterConformance } from "./support/database-adapter-conformance.js";
import { CONFORMANCE_SURFACE } from "./support/conformance-surfaces/chained-where.js";

runDatabaseAdapterConformance(CONFORMANCE_SURFACE);
