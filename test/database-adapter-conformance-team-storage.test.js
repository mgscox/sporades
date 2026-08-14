import { runDatabaseAdapterConformance } from "./support/database-adapter-conformance.js";
import { CONFORMANCE_SURFACE } from "./support/conformance-surfaces/team-storage.js";

runDatabaseAdapterConformance(CONFORMANCE_SURFACE);
