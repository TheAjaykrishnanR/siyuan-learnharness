/**
 * Browser-native Streaming & Non-Streaming LLM Client for:
 *  - DeepSeek API (deepseek-chat, deepseek-reasoner with reasoning_content support)
 *  - Google Gemini API (OpenAI-compatible endpoint & native Gemini API support)
 *  - Custom OpenAI-compatible endpoints & SiYuan's built-in AI settings fallback
 */

import type {
    AssistantContentBlock,
    LhAssistantMessage,
    LhMessage,
} from "../core/contracts";
import { INTERRUPTED_TEXT, newMessageId, resultIdsFrom } from "../core/messages";
import type { PluginSettings, ProviderId } from "../core/ports";
import { randomHex } from "../core/schema";
import type { AgentToolDefinition } from "./tools";

export interface ResolvedModelConfig {
    provider: ProviderId;
    apiKey: string;
    model: string;
    baseUrl: string;
}

export interface AvailableModelItem {
    id: string;
    name?: string;
    description?: string;
}

/**
 * Fetch available models dynamically from the provider API key and endpoint.
 */
export async function fetchAvailableModels(
    provider: ProviderId,
    apiKey: string,
    baseUrl?: string,
): Promise<AvailableModelItem[]> {
    const key = apiKey.trim();
    if (!key && provider !== "custom") {
        throw new Error(`API key is required to fetch available ${provider} models.`);
    }

    if (provider === "deepseek") {
        let ep = (baseUrl || "https://api.deepseek.com/v1").replace(/\/+$/, "");
        if (!ep.endsWith("/models")) {
            ep = `${ep}/models`;
        }

        const res = await fetch(ep, {
            method: "GET",
            headers: {
                Authorization: `Bearer ${key}`,
            },
        });

        if (!res.ok) {
            const err = await res.text().catch(() => "");
            throw new Error(`DeepSeek API error (${res.status}): ${err || res.statusText}`);
        }

        const json = await res.json();
        const list = Array.isArray(json?.data) ? json.data : [];
        const models: AvailableModelItem[] = list
            .map((m: any) => {
                const id = String(m?.id || "").trim();
                let name = id;
                if (id === "deepseek-chat") name = "deepseek-chat (V3)";
                else if (id === "deepseek-reasoner") name = "deepseek-reasoner (R1 Thinking)";
                return { id, name };
            })
            .filter((m: AvailableModelItem) => Boolean(m.id));

        if (models.length === 0) {
            return [
                { id: "deepseek-chat", name: "deepseek-chat (V3)" },
                { id: "deepseek-reasoner", name: "deepseek-reasoner (R1 Thinking)" },
            ];
        }
        return models;
    }

    if (provider === "gemini") {
        const isCustomBase = baseUrl && !baseUrl.includes("generativelanguage.googleapis.com");
        if (isCustomBase) {
            let ep = baseUrl.replace(/\/+$/, "");
            if (!ep.endsWith("/models")) ep = `${ep}/models`;
            const res = await fetch(ep, {
                headers: { Authorization: `Bearer ${key}` },
            });
            if (!res.ok) {
                const err = await res.text().catch(() => "");
                throw new Error(`Gemini custom endpoint error (${res.status}): ${err || res.statusText}`);
            }
            const json = await res.json();
            const list = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
            return list
                .map((m: any) => {
                    const id = String(m?.id || m?.name || "").replace(/^models\//, "");
                    return { id, name: m?.displayName || id };
                })
                .filter((m: AvailableModelItem) => Boolean(m.id));
        }

        // Native Google Gemini API endpoint
        let models: AvailableModelItem[] = [];
        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`;
            const res = await fetch(url);
            if (res.ok) {
                const json = await res.json();
                if (Array.isArray(json?.models)) {
                    models = json.models
                        .filter((m: any) => {
                            const name = String(m?.name || "").replace(/^models\//, "");
                            if (name.includes("embedding") || name.includes("aqa") || name.includes("imagen")) return false;
                            const methods = Array.isArray(m?.supportedGenerationMethods) ? m.supportedGenerationMethods : [];
                            return methods.includes("generateContent") || name.startsWith("gemini");
                        })
                        .map((m: any) => {
                            const id = String(m?.name || "").replace(/^models\//, "");
                            const displayName = m?.displayName ? `${id} (${m.displayName})` : id;
                            return { id, name: displayName };
                        });
                }
            } else {
                const err = await res.text().catch(() => "");
                throw new Error(`Google API error (${res.status}): ${err || res.statusText}`);
            }
        } catch (nativeErr: any) {
            // Fallback to OpenAI-compatible Gemini endpoint
            const ep = "https://generativelanguage.googleapis.com/v1beta/openai/models";
            const res = await fetch(ep, {
                headers: { Authorization: `Bearer ${key}` },
            });
            if (res.ok) {
                const json = await res.json();
                const list = Array.isArray(json?.data) ? json.data : [];
                models = list
                    .map((m: any) => {
                        const id = String(m?.id || "").replace(/^models\//, "");
                        return { id, name: id };
                    })
                    .filter((m: AvailableModelItem) => Boolean(m.id) && m.id.startsWith("gemini"));
            } else {
                throw nativeErr || new Error("Failed to fetch Gemini models.");
            }
        }

        // Sort models so newer / primary models come first
        const priority = [
            "gemini-2.5-flash",
            "gemini-2.5-pro",
            "gemini-2.0-flash",
            "gemini-2.0-flash-lite",
            "gemini-1.5-flash",
            "gemini-1.5-pro",
        ];
        models.sort((a, b) => {
            const aIdx = priority.findIndex((p) => a.id.startsWith(p));
            const bIdx = priority.findIndex((p) => b.id.startsWith(p));
            if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
            if (aIdx !== -1) return -1;
            if (bIdx !== -1) return 1;
            return a.id.localeCompare(b.id);
        });

        return models;
    }

    // Custom / OpenAI
    let ep = (baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
    if (!ep.endsWith("/models")) ep = `${ep}/models`;
    const res = await fetch(ep, {
        headers: key ? { Authorization: `Bearer ${key}` } : {},
    });
    if (!res.ok) {
        const err = await res.text().catch(() => "");
        throw new Error(`Custom endpoint error (${res.status}): ${err || res.statusText}`);
    }
    const json = await res.json();
    const list = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
    const models = list
        .map((m: any) => {
            const id = typeof m === "string" ? m : String(m?.id || "");
            return { id, name: id };
        })
        .filter((m: AvailableModelItem) => Boolean(m.id));
    models.sort((a: AvailableModelItem, b: AvailableModelItem) => a.id.localeCompare(b.id));
    return models;
}

/** Resolve the active provider credentials from PluginSettings, with optional fallback to SiYuan's built-in AI settings. */
export function resolveModelConfig(
    settings: PluginSettings,
    override?: { provider?: ProviderId; modelId?: string },
): ResolvedModelConfig {
    const provider = override?.provider ?? settings.activeProvider;

    if (provider === "deepseek") {
        let apiKey = settings.deepseekApiKey.trim();
        let baseUrl = (settings.deepseekBaseUrl || "https://api.deepseek.com/v1").replace(/\/+$/, "");
        let model = override?.modelId || settings.deepseekModel || "deepseek-chat";
        if (!apiKey && settings.useSiyuanAiFallback) {
            const syOpenAI = (window as any)?.siyuan?.config?.ai?.openAI;
            if (syOpenAI?.apiKey) {
                apiKey = String(syOpenAI.apiKey).trim();
                if (syOpenAI.apiBaseURL && String(syOpenAI.apiBaseURL).includes("deepseek")) {
                    baseUrl = String(syOpenAI.apiBaseURL).replace(/\/+$/, "");
                }
            }
        }
        return { provider, apiKey, model, baseUrl };
    }

    if (provider === "gemini") {
        const apiKey = settings.geminiApiKey.trim();
        const baseUrl = (
            settings.geminiBaseUrl || "https://generativelanguage.googleapis.com/v1beta/openai"
        ).replace(/\/+$/, "");
        const model = override?.modelId || settings.geminiModel || "gemini-2.5-flash";
        return { provider, apiKey, model, baseUrl };
    }

    // custom or SiYuan AI fallback
    let apiKey = settings.customApiKey.trim();
    let baseUrl = (settings.customBaseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
    let model = override?.modelId || settings.customModel || "gpt-4o";
    if (!apiKey && settings.useSiyuanAiFallback) {
        const syOpenAI = (window as any)?.siyuan?.config?.ai?.openAI;
        if (syOpenAI?.apiKey) {
            apiKey = String(syOpenAI.apiKey).trim();
            if (syOpenAI.apiBaseURL) baseUrl = String(syOpenAI.apiBaseURL).replace(/\/+$/, "");
            if (syOpenAI.apiModel && !override?.modelId && !settings.customModel) {
                model = String(syOpenAI.apiModel).trim();
            }
        }
    }
    return { provider: "custom", apiKey, model, baseUrl };
}

interface WireToolCall {
    id: string;
    type: "function";
    function: {
        name: string;
        arguments: string;
    };
}

interface WireMessage {
    role: "system" | "user" | "assistant" | "tool";
    content?: string | null;
    reasoning_content?: string;
    tool_calls?: WireToolCall[];
    tool_call_id?: string;
}

/** Convert LhMessage[] history + systemPrompt into OpenAI-compatible wire messages. */
export function buildWireMessages(
    systemPrompt: string,
    messages: readonly LhMessage[],
    includeReasoningContent: boolean,
): WireMessage[] {
    const out: WireMessage[] = [{ role: "system", content: systemPrompt }];

    for (let i = 0; i < messages.length; i++) {
        const m = messages[i]!;
        if (m.role === "custom") {
            if (m.customType === "plan-block" || m.customType === "problem-dismissed") continue;
            if (m.content.trim().length > 0) {
                out.push({ role: "user", content: m.content });
            }
            continue;
        }
        if (m.role === "user") {
            out.push({ role: "user", content: m.content });
            continue;
        }
        if (m.role === "toolResult") {
            const text = m.content.map((c) => c.text).join("\n");
            out.push({
                role: "tool",
                tool_call_id: m.toolCallId,
                content: text || "{}",
            });
            continue;
        }
        if (m.role === "assistant") {
            if (m.stopReason === "error" || m.stopReason === "aborted") continue;
            const textParts: string[] = [];
            const thinkingParts: string[] = [];
            const toolCalls: WireToolCall[] = [];

            for (const block of m.content) {
                if (block.type === "text" && block.text) textParts.push(block.text);
                else if (block.type === "thinking" && block.thinking) thinkingParts.push(block.thinking);
                else if (block.type === "toolCall") {
                    toolCalls.push({
                        id: block.id,
                        type: "function",
                        function: {
                            name: block.name,
                            arguments: JSON.stringify(block.arguments ?? {}),
                        },
                    });
                }
            }

            const assistantMsg: WireMessage = {
                role: "assistant",
                content: textParts.length > 0 ? textParts.join("\n\n") : toolCalls.length > 0 ? "" : "",
            };
            if (includeReasoningContent) {
                assistantMsg.reasoning_content = thinkingParts.join("\n") || "";
            }
            if (toolCalls.length > 0) {
                assistantMsg.tool_calls = toolCalls;
            }
            out.push(assistantMsg);

            // Synthesize interrupted tool results if any toolCall has no matching toolResult in the tail
            if (toolCalls.length > 0) {
                const answered = resultIdsFrom(messages.slice(i + 1));
                for (const tc of toolCalls) {
                    if (!answered.has(tc.id)) {
                        out.push({
                            role: "tool",
                            tool_call_id: tc.id,
                            content: INTERRUPTED_TEXT,
                        });
                    }
                }
            }
        }
    }

    return out;
}

/** Recursively strip unsupported JSON Schema keys if needed by strict OpenAI/Gemini endpoints. */
function toWireParameters(schema: unknown): Record<string, unknown> {
    if (!schema || typeof schema !== "object") return { type: "object", properties: {} };
    const clone = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
    delete clone.optional;
    return clone;
}

export interface StreamStepCallbacks {
    onPartialUpdate?: (partialMessage: LhAssistantMessage) => void;
    signal?: AbortSignal;
}

/**
 * Stream a single model step (text + optional thinking + optional tool calls)
 * from DeepSeek, Gemini, or Custom OpenAI-compatible API.
 */
export async function streamModelStep(opts: {
    config: ResolvedModelConfig;
    systemPrompt: string;
    messages: readonly LhMessage[];
    tools: Record<string, AgentToolDefinition>;
    callbacks?: StreamStepCallbacks;
}): Promise<LhAssistantMessage> {
    const { config, systemPrompt, messages, tools, callbacks } = opts;
    if (!config.apiKey) {
        throw new Error(
            `Missing API key for provider "${config.provider}". Open LearnHarness Settings (gear icon) to configure your DeepSeek or Gemini API key.`,
        );
    }

    const isReasoner = config.model.includes("reasoner");
    const wireMessages = buildWireMessages(systemPrompt, messages, isReasoner);

    const toolList = Object.values(tools).map((t) => ({
        type: "function" as const,
        function: {
            name: t.name,
            description: t.description,
            parameters: toWireParameters(t.parameters),
        },
    }));

    const endpoint = config.baseUrl.endsWith("/chat/completions")
        ? config.baseUrl
        : `${config.baseUrl}/chat/completions`;

    const body: Record<string, unknown> = {
        model: config.model,
        messages: wireMessages,
        stream: true,
    };
    if (toolList.length > 0) {
        body.tools = toolList;
    }

    const response = await fetch(endpoint, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: callbacks?.signal,
    });

    if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new Error(`LLM API Error (${response.status} ${response.statusText}): ${errText.slice(0, 400)}`);
    }

    const messageId = newMessageId();
    let textAcc = "";
    let thinkingAcc = "";
    const toolCallAccumulators = new Map<
        number,
        { id: string; name: string; argsText: string }
    >();

    const buildCurrentMessage = (stopReason?: LhAssistantMessage["stopReason"]): LhAssistantMessage => {
        const content: AssistantContentBlock[] = [];
        if (thinkingAcc.trim().length > 0) {
            content.push({ type: "thinking", thinking: thinkingAcc });
        }
        if (textAcc.length > 0) {
            content.push({ type: "text", text: textAcc });
        }
        for (const tc of toolCallAccumulators.values()) {
            if (!tc.name) continue;
            let parsedArgs: Record<string, unknown> = {};
            if (tc.argsText.trim()) {
                try {
                    parsedArgs = JSON.parse(tc.argsText);
                } catch {
                    // Partial JSON while streaming
                }
            }
            content.push({
                type: "toolCall",
                id: tc.id || `call_${randomHex(6)}`,
                name: tc.name,
                arguments: parsedArgs,
            });
        }
        return {
            id: messageId,
            role: "assistant",
            content,
            stopReason,
            model: config.model,
            provider: config.provider,
            timestamp: Date.now(),
        };
    };

    const reader = response.body?.getReader();
    if (!reader) {
        throw new Error("Response body is not readable.");
    }

    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";

        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line || !line.startsWith("data:")) continue;
            const dataStr = line.slice(5).trim();
            if (dataStr === "[DONE]") continue;

            let chunk: any;
            try {
                chunk = JSON.parse(dataStr);
            } catch {
                continue;
            }

            const delta = chunk?.choices?.[0]?.delta;
            if (!delta) continue;

            if (typeof delta.reasoning_content === "string") {
                thinkingAcc += delta.reasoning_content;
            }
            if (typeof delta.content === "string") {
                textAcc += delta.content;
            }
            if (Array.isArray(delta.tool_calls)) {
                for (const tcDelta of delta.tool_calls) {
                    const idx = typeof tcDelta.index === "number" ? tcDelta.index : 0;
                    let entry = toolCallAccumulators.get(idx);
                    if (!entry) {
                        entry = {
                            id: tcDelta.id || `call_${randomHex(6)}`,
                            name: tcDelta.function?.name || "",
                            argsText: "",
                        };
                        toolCallAccumulators.set(idx, entry);
                    } else {
                        if (tcDelta.id) entry.id = tcDelta.id;
                        if (tcDelta.function?.name) entry.name += tcDelta.function.name;
                    }
                    if (typeof tcDelta.function?.arguments === "string") {
                        entry.argsText += tcDelta.function.arguments;
                    }
                }
            }

            callbacks?.onPartialUpdate?.(buildCurrentMessage());
        }
    }

    const hasToolCalls = Array.from(toolCallAccumulators.values()).some((tc) => Boolean(tc.name));
    return buildCurrentMessage(hasToolCalls ? "toolUse" : "stop");
}
