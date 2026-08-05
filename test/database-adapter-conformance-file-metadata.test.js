import { runDatabaseAdapterConformance } from "./support/database-adapter-conformance.js";
import { CONFORMANCE_SURFACE } from "./support/conformance-surfaces/file-metadata.js";

// Test entry point for one surface of the Database adapter conformance specification (ADR-0035).
// The cases live in the surface module so the coverage check can replay them; this file exists to
// give the surface its own test process and its own adapter.
runDatabaseAdapterConformance(CONFORMANCE_SURFACE);
