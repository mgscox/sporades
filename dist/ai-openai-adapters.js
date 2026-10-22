import { isPlainObject, tokenCount } from "./ai-provider.js";
// The only modules that know OpenAI-compatible wire formats. Everything they return is neutral.
const modelName = (value) => typeof value === "string" && value.length <= 256 ? value : null;
function chatFinishReason(value) {
    if (typeof value !== "string")
        return null;
    return value === "stop" || value === "length" || value === "content_filter" ? value : "other";
}
/** Chat Completions (`POST {base}/chat/completions`): OpenAI, Ollama, vLLM and most hosted providers. */
export const chatCompletionsAdapter = Object.freeze({
    path: "/chat/completions",
    encode(request, model) {
        const body = {
            model,
            messages: [...(request.system !== null ? [{ role: "system", content: request.system }] : []), ...request.messages.map(({ role, content }) => ({ role, content }))],
            stream: false,
        };
        if (request.maxTokens !== null)
            body.max_tokens = request.maxTokens;
        if (request.temperature !== null)
            body.temperature = request.temperature;
        if (request.jsonSchema) {
            body.response_format = { type: "json_schema", json_schema: { name: request.jsonSchema.name, schema: request.jsonSchema.schema, strict: request.jsonSchema.strict } };
        }
        return body;
    },
    decode(body) {
        if (!isPlainObject(body))
            return null;
        const choice = Array.isArray(body.choices) ? body.choices[0] : undefined;
        const text = choice?.message?.content;
        if (typeof text !== "string")
            return null;
        const usage = isPlainObject(body.usage) ? body.usage : {};
        return {
            text,
            model: modelName(body.model),
            finishReason: chatFinishReason(choice.finish_reason),
            usage: { prompt: tokenCount(usage.prompt_tokens), completion: tokenCount(usage.completion_tokens), total: tokenCount(usage.total_tokens) },
        };
    },
});
/**
 * Responses (`POST {base}/responses`). Sends `store: false` so the provider does not retain the
 * response object for later retrieval.
 */
export const responsesAdapter = Object.freeze({
    path: "/responses",
    encode(request, model) {
        const body = {
            model,
            input: request.messages.map(({ role, content }) => ({ role, content })),
            store: false,
            stream: false,
        };
        if (request.system !== null)
            body.instructions = request.system;
        if (request.maxTokens !== null)
            body.max_output_tokens = request.maxTokens;
        if (request.temperature !== null)
            body.temperature = request.temperature;
        if (request.jsonSchema) {
            body.text = { format: { type: "json_schema", name: request.jsonSchema.name, schema: request.jsonSchema.schema, strict: request.jsonSchema.strict } };
        }
        return body;
    },
    decode(body) {
        if (!isPlainObject(body) || !Array.isArray(body.output))
            return null;
        if (body.status !== "completed" && body.status !== "incomplete")
            return null;
        const parts = [];
        for (const item of body.output) {
            if (!isPlainObject(item) || item.type !== "message" || !Array.isArray(item.content))
                continue;
            for (const part of item.content)
                if (isPlainObject(part) && part.type === "output_text" && typeof part.text === "string")
                    parts.push(part.text);
        }
        if (!parts.length)
            return null;
        const reason = isPlainObject(body.incomplete_details) ? body.incomplete_details.reason : undefined;
        const usage = isPlainObject(body.usage) ? body.usage : {};
        return {
            text: parts.join(""),
            model: modelName(body.model),
            finishReason: body.status === "completed" ? "stop" : reason === "max_output_tokens" ? "length" : reason === "content_filter" ? "content_filter" : "other",
            usage: { prompt: tokenCount(usage.input_tokens), completion: tokenCount(usage.output_tokens), total: tokenCount(usage.total_tokens) },
        };
    },
});
export const AI_PROTOCOL_ADAPTERS = Object.freeze({ "chat-completions": chatCompletionsAdapter, responses: responsesAdapter });
//# sourceMappingURL=ai-openai-adapters.js.map