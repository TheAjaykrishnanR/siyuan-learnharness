/**
 * THE WEAK-MODEL ARGUMENT HEAL — pure core.
 * Heals JSON-stringified enums, booleans, numbers, nulls, or arrays before schema validation.
 */

type PropSchema = {
    type?: string;
    const?: unknown;
    anyOf?: PropSchema[];
};

function literalsOf(prop: PropSchema): unknown[] {
    if (prop.anyOf) return prop.anyOf.flatMap((m) => literalsOf(m));
    return "const" in prop ? [prop.const] : [];
}

function acceptsNull(prop: PropSchema): boolean {
    if (prop.type === "null") return true;
    return (prop.anyOf ?? []).some((m) => m.type === "null");
}

function tryParse(raw: string): unknown {
    try {
        return JSON.parse(raw) as unknown;
    } catch {
        return undefined;
    }
}

export function healEncodedArguments(
    args: unknown,
    schema: { properties?: Record<string, PropSchema> },
): unknown {
    if (typeof args !== "object" || args === null || Array.isArray(args)) return args;
    const properties = schema.properties;
    if (!properties) return args;
    let healed: Record<string, unknown> | null = null;
    for (const [key, prop] of Object.entries(properties)) {
        const raw = (args as Record<string, unknown>)[key];
        if (typeof raw !== "string") continue;
        const parsed = tryParse(raw);
        let fixed: unknown;
        const literals = literalsOf(prop);
        if (literals.length > 0) {
            if (literals.includes(raw)) continue;
            if (literals.includes(parsed)) fixed = parsed;
        }
        if (fixed === undefined && acceptsNull(prop) && parsed === null) fixed = null;
        if (fixed === undefined && prop.type === "boolean" && typeof parsed === "boolean") {
            fixed = parsed;
        }
        if (
            fixed === undefined &&
            (prop.type === "number" || prop.type === "integer") &&
            typeof parsed === "number"
        ) {
            fixed = parsed;
        }
        if (fixed === undefined && prop.type === "array" && Array.isArray(parsed)) fixed = parsed;
        if (fixed !== undefined) {
            healed ??= { ...(args as Record<string, unknown>) };
            healed[key] = fixed;
        }
    }
    return healed ?? args;
}
