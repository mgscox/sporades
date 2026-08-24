import { runDatabaseAdapterConformance } from "./support/database-adapter-conformance.js";
import { CONFORMANCE_SURFACE } from "./support/conformance-surfaces/team-billing-import.js";

runDatabaseAdapterConformance(CONFORMANCE_SURFACE);
