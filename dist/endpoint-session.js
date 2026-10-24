/** Shared by authoring helpers, generated helpers, startup and raw runtime dispatch. */
export function validateEndpointSessionDeclaration(definition) {
    const options = definition?.options;
    if (!options || typeof options !== "object" || !("session" in options))
        return;
    if (options.session !== "none" || options.body !== undefined || options.response !== undefined
        || options.mcp !== undefined || definition.runtimeOwnedEmailEvent || definition.runtimeOwnedStripeCallback
        || definition.handler?.[Symbol.for("sporades.auth.requirements")]) {
        const error = new Error("Invalid endpoint Session declaration.");
        error.code = "INVALID_ENDPOINT_SESSION_DECLARATION";
        error.hint = 'Use session: "none" only with an unguarded ordinary endpoint without multipart ingress, File attachment responses, MCP exposure or provider callbacks.';
        throw error;
    }
}
//# sourceMappingURL=endpoint-session.js.map