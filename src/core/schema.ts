/**
 * Lightweight, zero-dependency TypeBox-compatible JSON Schema builder and
 * validator for tool parameters, plus browser-safe hex/hash helpers.
 */

export interface TSchema {
    type?: string;
    description?: string;
    properties?: Record<string, TSchema>;
    required?: string[];
    items?: TSchema;
    minItems?: number;
    minLength?: number;
    anyOf?: TSchema[];
    const?: unknown;
    optional?: boolean;
    additionalProperties?: boolean;
}

export const Type = {
    String(opts: { description?: string; minLength?: number } = {}): TSchema {
        return { type: "string", ...opts };
    },
    Number(opts: { description?: string } = {}): TSchema {
        return { type: "number", ...opts };
    },
    Boolean(opts: { description?: string } = {}): TSchema {
        return { type: "boolean", ...opts };
    },
    Null(opts: { description?: string } = {}): TSchema {
        return { type: "null", ...opts };
    },
    Literal<T extends string | number | boolean>(val: T, opts: { description?: string } = {}): TSchema {
        return { type: typeof val, const: val, ...opts };
    },
    Optional(schema: TSchema): TSchema {
        return { ...schema, optional: true };
    },
    Array(items: TSchema, opts: { description?: string; minItems?: number } = {}): TSchema {
        return { type: "array", items, ...opts };
    },
    Union(schemas: TSchema[], opts: { description?: string } = {}): TSchema {
        return { anyOf: schemas, ...opts };
    },
    Object(properties: Record<string, TSchema>, opts: { description?: string } = {}): TSchema {
        const required: string[] = [];
        const cleanProps: Record<string, TSchema> = {};
        for (const [k, v] of Object.entries(properties)) {
            const { optional, ...rest } = v;
            cleanProps[k] = rest;
            if (!optional) {
                required.push(k);
            }
        }
        return {
            type: "object",
            properties: cleanProps,
            required,
            additionalProperties: false,
            ...opts,
        };
    },
};

/** Validate an input against a TSchema and return human/model-readable errors. */
export function validateSchema(schema: TSchema, value: unknown, path = ""): string[] {
    const errors: string[] = [];
    const label = path || "input";

    if (schema.anyOf) {
        const matches = schema.anyOf.some((sub) => validateSchema(sub, value, path).length === 0);
        if (!matches) {
            const literals = schema.anyOf.filter((s) => "const" in s).map((s) => JSON.stringify(s.const));
            if (literals.length > 0) {
                errors.push(`${label}: expected one of ${literals.join(", ")}, got ${JSON.stringify(value)}`);
            } else {
                errors.push(`${label}: value does not match expected union type`);
            }
        }
        return errors;
    }

    if ("const" in schema) {
        if (value !== schema.const) {
            errors.push(`${label}: expected ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
        }
        return errors;
    }

    if (schema.type === "null") {
        if (value !== null) errors.push(`${label}: expected null`);
        return errors;
    }

    if (schema.type === "string") {
        if (typeof value !== "string") {
            errors.push(`${label}: expected string, got ${typeof value}`);
        } else if (schema.minLength !== undefined && value.length < schema.minLength) {
            errors.push(`${label}: string must have at least ${schema.minLength} character(s)`);
        }
        return errors;
    }

    if (schema.type === "number") {
        if (typeof value !== "number" || Number.isNaN(value)) {
            errors.push(`${label}: expected number, got ${typeof value}`);
        }
        return errors;
    }

    if (schema.type === "boolean") {
        if (typeof value !== "boolean") {
            errors.push(`${label}: expected boolean, got ${typeof value}`);
        }
        return errors;
    }

    if (schema.type === "array") {
        if (!Array.isArray(value)) {
            errors.push(`${label}: expected array, got ${typeof value}`);
            return errors;
        }
        if (schema.minItems !== undefined && value.length < schema.minItems) {
            errors.push(`${label}: array must have at least ${schema.minItems} item(s)`);
        }
        if (schema.items) {
            value.forEach((item, idx) => {
                errors.push(...validateSchema(schema.items!, item, `${label}[${idx}]`));
            });
        }
        return errors;
    }

    if (schema.type === "object") {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
            errors.push(`${label}: expected object`);
            return errors;
        }
        const obj = value as Record<string, unknown>;
        for (const reqKey of schema.required ?? []) {
            if (obj[reqKey] === undefined) {
                errors.push(`${path ? `${path}.${reqKey}` : reqKey}: required field is missing`);
            }
        }
        for (const [k, propSchema] of Object.entries(schema.properties ?? {})) {
            if (obj[k] !== undefined) {
                errors.push(...validateSchema(propSchema, obj[k], path ? `${path}.${k}` : k));
            }
        }
        return errors;
    }

    return errors;
}

/** Generate N random bytes as a lowercase hex string (browser-safe). */
export function randomHex(bytesCount: number): string {
    const arr = new Uint8Array(bytesCount);
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
        crypto.getRandomValues(arr);
    } else {
        for (let i = 0; i < bytesCount; i++) {
            arr[i] = Math.floor(Math.random() * 256);
        }
    }
    return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Fast, deterministic synchronous 64-bit FNV-1a / dual-32-bit fingerprint in hex (browser-safe replacement for sync sha256 in coverage). */
export function syncHashHex(input: string): string {
    let h1 = 0xdeadbeef ^ input.length;
    let h2 = 0x41c6ce57 ^ input.length;
    for (let i = 0, ch: number; i < input.length; i++) {
        ch = input.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}
