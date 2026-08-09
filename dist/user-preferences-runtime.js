// The Capsule runtime's user-preferences domain: the preference table's schema, the read and update
// path behind `preferences.read()` and `preferences.update()`, and the anonymous-to-account merge
// that runs whenever a guest session becomes an authenticated one. Batch 5 of the migration ADR-0041
// records. Every body here is byte-identical to the one that stood in `server-runtime-source.ts`.
//
// **The domain is exactly six declarations, and that was established by inspection rather than by
// the name.** A sweep for `preference` across the monolith returns nine more identifiers, and none
// of them is this domain's to move:
//
//   - `ensureUserPreferencesStorage`, `readUserPreferences` and `saveUserPreferences` are methods of
//     `createSharedDatabaseAdapterMethods`, not top-level declarations. They are the one shared
//     adapter method set every engine reaches the table through, and they travel with the adapters
//     in batch 9. This module calls them through the `tx`/`adapter` object it is handed, which is
//     the same seam they were behind before the move.
//   - `notifyPreferencesUpdated` is nested inside `createWebSocketHub` — the WebSocket fan-out that
//     tells a user's other clients a preference changed. It is the HTTP layer's, batch 8's.
//   - `INVALID_PREFERENCES_PATCH` and `PREFERENCES_UPDATE_FAILED` read like constants and are
//     string literals inside the two functions below. There is no preamble constant in this domain,
//     so nothing had to leave the bundle preamble in this commit.
//
// So the six named in the ticket are the six, which is the one time in this sequence the count in
// the ticket has matched what inspection found.
//
// **What is exported and what is not.** Five of the six are exported and one is private.
// `createUserPreferencesTables` is called by the shared adapter method set, `readCurrentUserPreferences`
// and `updateCurrentUserPreferences` by the WebSocket hub — both still in the monolith — and
// `updateCurrentUserPreferences` again by `test/database-adapter.test.js` through the re-export
// bridge. `migrateAnonymousPreferences` is exported for `auth-runtime.js`, which is the whole reason
// this batch runs where it does: it is what kept seven auth functions in the monolith after batch 3.
//
// `normalizePreferencesPatch` was a fifth export until ticket 05, and the one export that was not
// there because something resolved it: it was exported so the two-bundle skew probe could call it, a
// deliberate widening rather than an accident, because that probe was synchronous and the other
// three exports are `async` — so without it the only limb this domain could offer was the DDL, and
// the validation path would have been carried into every deployed Capsule uncompared. The probe went
// with the emitted-list builder, and the function is private again.
//
// `createPreferencesError` is private, and it is this module's census sentinel in
// `test/database-adapter-engine-seam.test.js` for that reason. Under the emitted list it had to be
// registered in `SERVER_RUNTIME_SOURCE_FUNCTIONS` or become a `ReferenceError` in a deployed
// Capsule, so "private" was not a thing this domain could be; finding it in the census now is the
// evidence that it did not leave the census by becoming private.
//
// **This module imports nothing but `runtime-errors.js`, and reaches no Node builtin.** There is no
// `process.getBuiltinModule` accessor here because there is nothing to reach for — the domain's only
// non-local call is `assertJsonCompatible`, which is where every JSON-compatibility refusal in the
// runtime lives. That also keeps this module below `auth-runtime.js` in the dependency direction
// rather than beside it, so the import `auth-runtime.js` gains in this batch introduces no cycle.
import { assertJsonCompatible } from "./runtime-errors.js";
export function createUserPreferencesTables(sqlite) {
    return sqlite.exec(sqlite.dialect.sql("CREATE TABLE IF NOT EXISTS [sporades_user_preferences] (" +
        "[userId] TEXT PRIMARY KEY, " +
        "[value] TEXT NOT NULL, " +
        "[updatedAt] TEXT NOT NULL" +
        ")"));
}
export async function migrateAnonymousPreferences(database, auth, targetUserId, sqlite = null) {
    if (!auth?.isGuest || auth.userId === targetUserId) {
        return;
    }
    const migrate = async (tx) => {
        const sourceRow = await tx.readUserPreferences(auth.userId);
        if (!sourceRow) {
            return;
        }
        const targetRow = await tx.readUserPreferences(targetUserId);
        const source = JSON.parse(sourceRow.value);
        const target = targetRow ? JSON.parse(targetRow.value) : {};
        const next = { ...target, ...source };
        assertJsonCompatible(next);
        await tx.saveUserPreferences({
            userId: targetUserId,
            value: JSON.stringify(next),
            updatedAt: new Date().toISOString(),
        });
    };
    if (sqlite) {
        await migrate(sqlite);
        return;
    }
    await database.adapter.withTransaction(migrate);
}
export async function readCurrentUserPreferences(database, auth) {
    const row = await database.adapter.readUserPreferences(auth.userId);
    return {
        ok: true,
        data: {
            preferences: row ? JSON.parse(row.value) : {},
        },
        error: null,
    };
}
export async function updateCurrentUserPreferences(database, auth, patch) {
    try {
        const normalizedPatch = normalizePreferencesPatch(patch);
        const preferences = await database.adapter.withTransaction(async (tx) => {
            const row = await tx.readUserPreferences(auth.userId);
            const current = row ? JSON.parse(row.value) : {};
            const next = { ...current, ...normalizedPatch };
            assertJsonCompatible(next);
            await tx.saveUserPreferences({
                userId: auth.userId,
                value: JSON.stringify(next),
                updatedAt: new Date().toISOString(),
            });
            return next;
        });
        return {
            ok: true,
            data: { preferences },
            changes: normalizedPatch,
            error: null,
        };
    }
    catch (error) {
        if (error?.code === "INVALID_PREFERENCES_PATCH") {
            return { ok: false, data: null, error };
        }
        return {
            ok: false,
            data: null,
            error: createPreferencesError("Preferences update failed.", "Retry the preferences update. If this keeps happening, restart the Sporades session.", "PREFERENCES_UPDATE_FAILED"),
        };
    }
}
function normalizePreferencesPatch(patch) {
    if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
        throw createPreferencesError("Preferences updates must be JSON objects.", "Pass a plain JSON object to preferences.update().", "INVALID_PREFERENCES_PATCH");
    }
    assertJsonCompatible(patch);
    return patch;
}
function createPreferencesError(message, hint, code) {
    return { code, message, hint };
}
//# sourceMappingURL=user-preferences-runtime.js.map