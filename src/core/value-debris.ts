/**
 * Strip the copy-syntax debris a model glues onto a membership value:
 * any run of surrounding whitespace, colons, double/single quotes, and
 * backticks, in any interleaving (`":value"`, `: value`, `` `value` ``).
 * The interior is untouched.
 */
export function stripModelValueDebris(value: string): string {
    return value.replace(/^[\s:."'`]+/, "").replace(/[\s:."'`]+$/, "");
}
