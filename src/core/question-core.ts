/**
 * question-core — the question contract + pure grading logic.
 * Single source of truth for Prober (probe, recall), Teacher (quiz, explain),
 * and shared ask_user_question schemas, option shuffling, and grading.
 */

import { Type } from "./schema";
import { stripModelValueDebris } from "./value-debris";

export interface QuizOption {
    label: string;
    value: string;
    description?: string;
}

const quizOptionProps = {
    label: Type.String({ description: "Display label for the answer option — a bare claim, no reasoning" }),
    value: Type.Optional(
        Type.String({
            description: "Optional machine-readable value returned for the option. Defaults to the label.",
        }),
    ),
};

const askOptionProps = {
    ...quizOptionProps,
    description: Type.Optional(
        Type.String({ description: "Optional extra detail shown below the option" }),
    ),
};

export function parseOptionsIfString<T>(options: string | T[] | undefined): unknown {
    if (typeof options !== "string") return options;
    try {
        const parsed: unknown = JSON.parse(options);
        if (Array.isArray(parsed)) return parsed;
    } catch {
        /* not JSON */
    }
    return options;
}

function optionProblems(
    options: Array<{ label: string; value?: string }>,
): { problems: string[]; keys: string[] } {
    const problems: string[] = [];
    const keys: string[] = [];
    options.forEach((option, i) => {
        const label = (option.label ?? "").trim();
        if (label.length === 0) {
            problems.push(`options[${i}].label is empty — every option needs a label.`);
            return;
        }
        const key = option.value?.trim() || label;
        if (keys.includes(key)) {
            problems.push(`Two options resolve to the same value "${key}" — options must be distinct.`);
        }
        keys.push(key);
    });
    return { problems, keys };
}

export function askOptionProblems(options: Array<{ label: string; value?: string }>): string[] {
    return optionProblems(options).problems;
}

export function quizInputProblems(input: {
    options: Array<{ label: string; value?: string }>;
    correctAnswer: string | string[];
    multiSelect?: boolean;
}): string[] {
    const { problems, keys } = optionProblems(input.options);
    const entries = coerceCorrectAnswer(input.correctAnswer, keys);
    const unique = [...new Set(entries)];
    if (unique.length === 0 || unique.some((v) => v.length === 0)) {
        problems.push("correctAnswer is required — provide the value (or label) of the correct option(s).");
        return problems;
    }
    for (const v of unique) {
        if (!keys.includes(v)) {
            problems.push(
                `correctAnswer "${v}" does not match any option value. Valid values: ${keys.map((k) => `"${k}"`).join(", ")}. ` +
                    "Copy the exact value (or label) of the intended option — never a paraphrase or slug.",
            );
        }
    }
    if (unique.length > 1 && input.multiSelect !== true) {
        problems.push(
            `correctAnswer lists ${unique.length} values but multiSelect is not true — a single-select question with several ` +
                "correct answers can never be answered correctly. Set multiSelect: true, or make exactly one option correct.",
        );
    }
    return problems;
}

export const quizInputBase = Type.Object({
    question: Type.String({
        description:
            "The single quiz question to ask. ONE question per turn: ask, then end your turn — the answer determines the next question.",
    }),
    options: Type.Array(Type.Object(quizOptionProps), {
        minItems: 2,
        description:
            "REQUIRED. The answer options (2 or more) as a JSON ARRAY of option objects — never a " +
            "JSON-encoded string. Options only — there is no free-text mode. " +
            "Give each option a stable `value`; you reference the correct one by that value in correctAnswer. " +
            "Never add your own 'I don't know' option — that choice is added for you.",
    }),
    multiSelect: Type.Optional(
        Type.Boolean({
            description: "Set to true when more than one option is correct and the learner must select all of them.",
        }),
    ),
    explanation: Type.String({
        description:
            "REQUIRED. Explanation revealed AFTER the learner answers (shown whether they got it right or wrong). " +
            "Use it to reinforce why the correct answer is correct. It is written BEFORE correctAnswer by design: " +
            "reason it out first, then commit the answer the reasoning supports.",
    }),
    correctAnswer: Type.Union([Type.String(), Type.Array(Type.String())], {
        description:
            "REQUIRED. The correct answer as the option value(s) — the `value` field of the option you intend. " +
            'Single-select: a single string (e.g. "mercury"). Multi-select: an array of strings (e.g. ["belize", "niue"]); ' +
            "the learner is only correct if their selection matches this set exactly.",
    }),
    details: Type.Optional(
        Type.String({ description: "Optional extra context or instructions shown under the question." }),
    ),
});

export const QUIZ_QUESTION_TYPES = ["predict", "check"] as const;
export type QuizQuestionType = (typeof QUIZ_QUESTION_TYPES)[number];

export function normalizeQuizType(raw: unknown): QuizQuestionType | undefined {
    if (typeof raw !== "string") return undefined;
    const v = stripModelValueDebris(raw);
    return v === "predict" ? "predict" : v === "check" ? "check" : undefined;
}

export function questionNeedsReveal(tool: string, rawInput: unknown, phase: string): boolean {
    if ((tool !== "quiz" && tool !== "explain") || phase !== "teach") return false;
    return normalizeQuizType((rawInput as { type?: unknown } | null)?.type) !== "predict";
}

const predictCheckType = Type.Union([Type.Literal("predict"), Type.Literal("check")], {
    description:
        "REQUIRED — the question's role in the teaching cycle, as a bare word (no quotes): predict = posed BEFORE " +
        "you teach the step (its own turn; the learner answers, then your teaching resolves it — arrives open, never " +
        "collapsed); check = posed AFTER the step's teaching is complete (arrives collapsed behind the Check your " +
        "understanding reveal). ONE question per turn either way.",
});

export const quizInputObject = Type.Object({
    type: predictCheckType,
    nodeId: Type.String({
        description:
            "REQUIRED plan-tree node id this question is about — must EXACTLY match one of this session's " +
            "plan_init node slugs (validated at call time; a mismatched id is rejected back to you). " +
            "The lesson's position on the map derives from these tags.",
    }),
    ...(quizInputBase.properties ?? {}),
});

export const probeQuizInputSchema = quizInputBase;

export const explainInputBase = Type.Object({
    question: Type.String({
        description:
            "The single question to ask. ONE question per turn: ask, then end your turn — the answer determines the next.",
    }),
    correctAnswer: Type.String({
        description:
            "REQUIRED. The full correct answer in your own words, reasoning included — COMMITTED before the learner " +
            "ever sees the question. The commitment is immutable: when his answer returns, grade it strictly against this text.",
    }),
    details: Type.Optional(
        Type.String({ description: "Optional extra context or instructions shown under the question." }),
    ),
});

export const explainInputObject = Type.Object({
    type: predictCheckType,
    nodeId: Type.String({
        description:
            "REQUIRED plan-tree node id this question is about — must EXACTLY match one of this session's " +
            "plan_init node slugs (validated at call time; a mismatched id is rejected back to you).",
    }),
    ...(explainInputBase.properties ?? {}),
});

export function explainInputProblems(input: { correctAnswer: string }): string[] {
    if ((input.correctAnswer ?? "").trim().length === 0) {
        return ["correctAnswer is required — commit to the full correct answer BEFORE posing the question."];
    }
    return [];
}

export const QUIZ_TOOL_NAMES = ["quiz", "explain"] as const;
export const QUESTION_TOOLS = ["ask_user_question", "probe", "recall", "quiz", "explain"] as const;

export const askInputSchema = Type.Object({
    question: Type.String({
        description:
            "The single question to ask the learner. ONE question per turn: ask, then end your turn — the answer determines the next question.",
    }),
    details: Type.Optional(
        Type.String({ description: "Optional extra context or instructions shown under the question." }),
    ),
    options: Type.Optional(
        Type.Array(Type.Object(askOptionProps), {
            minItems: 2,
            description:
                "Optional multiple-choice options. Omit for free-form text input. " +
                "The learner can always choose 'Other' and type a custom answer when options are provided.",
        }),
    ),
    multiSelect: Type.Optional(
        Type.Boolean({ description: "Set to true to allow multiple answers to the same question." }),
    ),
});

export interface OptionAnswer {
    label: string;
    value: string;
    index: number;
}

export type QuestionKind = "quiz" | "ask" | "explain";
export type SelectMode = "single-select" | "multi-select";
export type QuestionMode = SelectMode | "text";

export interface QuestionData {
    id: string;
    kind: QuestionKind;
    questionType?: QuizQuestionType;
    question: string;
    context?: string;
    mode: QuestionMode;
    options: QuizOption[];
    correctIndices?: number[];
    committedAnswer?: string;
    explanation?: string;
    createdAt: string;
}

export interface QuestionAnswerData {
    kind: QuestionKind;
    tool?: string;
    questionType?: QuizQuestionType;
    questionText: string;
    options?: { index: number; label: string }[];
    dontKnow: boolean;
    answers: OptionAnswer[];
    other?: string;
    text?: string;
    thinking?: string;
    readingThinking?: string;
    confidence?: number;
    correct?: boolean;
    correctIndices?: number[];
    committed?: string;
    explanation?: string;
    dismissed?: boolean;
    answeredAt: string;
}

export interface AnswerRequest {
    dontKnow?: boolean;
    values?: string[];
    other?: string;
    text?: string;
    thinking?: string;
    readingThinking?: string;
    confidence?: number;
}

export const CONFIDENCE_STOPS: readonly number[] = [0, 30, 50, 70, 90, 100];
export const DEFAULT_CONFIDENCE_INDEX = 2;

export function normalizeOptions(
    options: string | Array<{ label: string; value?: string; description?: string }> | undefined,
): QuizOption[] {
    const seen = new Set<string>();
    const coerced = parseOptionsIfString(options);
    const list = Array.isArray(coerced)
        ? (coerced as Array<{ label: string; value?: string; description?: string }>)
        : [];
    return list
        .map((option) => ({
            label: (option.label ?? "").trim(),
            value: option.value?.trim() || (option.label ?? "").trim(),
            description: option.description?.trim() || undefined,
        }))
        .filter((option) => {
            if (option.label.length === 0) return false;
            if (seen.has(option.value)) return false;
            seen.add(option.value);
            return true;
        });
}

export function seededRandom(seed: string): () => number {
    let h = 2166136261;
    for (let i = 0; i < seed.length; i++) {
        h ^= seed.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    let a = h >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function shuffleOptions(options: QuizOption[], rand: () => number = Math.random): QuizOption[] {
    const out = [...options];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        const a = out[i]!;
        const b = out[j]!;
        out[i] = b;
        out[j] = a;
    }
    return out;
}

export function coerceCorrectAnswer(
    correctAnswer: string | string[],
    optionValues: readonly string[],
): string[] {
    const clean = (value: string): string => {
        const trimmed = value.trim();
        return optionValues.includes(trimmed) ? trimmed : stripModelValueDebris(value);
    };
    if (Array.isArray(correctAnswer)) return correctAnswer.map(clean);
    const trimmed = String(correctAnswer ?? "").trim();
    if (optionValues.includes(trimmed)) return [trimmed];
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) return parsed.map((v) => clean(String(v)));
        } catch {
            /* literal */
        }
    }
    return [clean(String(correctAnswer ?? ""))];
}

export function resolveCorrect(
    correctAnswer: string | string[] | undefined,
    options: QuizOption[],
): { indices: number[]; error?: string } {
    if (correctAnswer === undefined) return { indices: [], error: "correctAnswer is required" };
    const arr = coerceCorrectAnswer(correctAnswer, options.map((o) => o.value));
    if (arr.length === 0) return { indices: [], error: "correctAnswer is required" };
    const byValue = new Map(options.map((o, i) => [o.value, i + 1]));
    const indices: number[] = [];
    for (const raw of arr) {
        const v = typeof raw === "string" ? raw.trim() : raw;
        const idx = byValue.get(v);
        if (idx === undefined) {
            const known = options.map((o) => `"${o.value}"`).join(", ");
            return { indices: [], error: `correctAnswer "${v}" does not match any option value (${known})` };
        }
        indices.push(idx);
    }
    return { indices: Array.from(new Set(indices)).sort((a, b) => a - b) };
}

export function isCorrect(selectedIndices: number[], correctIndices: number[]): boolean {
    if (selectedIndices.length !== correctIndices.length) return false;
    const a = [...selectedIndices].sort((x, y) => x - y);
    const b = [...correctIndices].sort((x, y) => x - y);
    return a.every((v, i) => v === b[i]);
}

/** Build QuestionData from a raw tool call (`probe`, `recall`, `quiz`, `explain`, `ask_user_question`). */
export function buildQuestionDataFromToolCall(
    toolCallId: string,
    toolName: string,
    rawArgs: Record<string, unknown>,
): QuestionData {
    const question = String(rawArgs.question ?? "");
    const context = typeof rawArgs.details === "string" ? rawArgs.details : undefined;
    const multiSelect = rawArgs.multiSelect === true;

    if (toolName === "explain" || toolName === "recall") {
        return {
            id: toolCallId,
            kind: "explain",
            questionType: toolName === "explain" ? normalizeQuizType(rawArgs.type) : undefined,
            question,
            context,
            mode: "text",
            options: [],
            committedAnswer: String(rawArgs.correctAnswer ?? ""),
            createdAt: new Date().toISOString(),
        };
    }

    if (toolName === "ask_user_question") {
        const opts = normalizeOptions(rawArgs.options as any);
        return {
            id: toolCallId,
            kind: "ask",
            question,
            context,
            mode: opts.length > 0 ? (multiSelect ? "multi-select" : "single-select") : "text",
            options: opts,
            createdAt: new Date().toISOString(),
        };
    }

    // quiz or probe
    const normalized = normalizeOptions(rawArgs.options as any);
    const shuffled = shuffleOptions(normalized, seededRandom(toolCallId));
    const resolved = resolveCorrect(rawArgs.correctAnswer as string | string[], shuffled);
    return {
        id: toolCallId,
        kind: "quiz",
        questionType: toolName === "quiz" ? normalizeQuizType(rawArgs.type) : undefined,
        question,
        context,
        mode: multiSelect ? "multi-select" : "single-select",
        options: shuffled,
        correctIndices: resolved.indices,
        explanation: typeof rawArgs.explanation === "string" ? rawArgs.explanation : undefined,
        createdAt: new Date().toISOString(),
    };
}

export function buildAnswer(qd: QuestionData, req: AnswerRequest, tool?: string): QuestionAnswerData {
    const base: QuestionAnswerData = {
        kind: qd.kind,
        ...(tool ? { tool } : {}),
        questionType: qd.questionType,
        questionText: qd.question,
        options: qd.options.map((o, i) => ({ index: i + 1, label: o.label })),
        dontKnow: req.dontKnow === true,
        answers: [],
        thinking: req.thinking?.trim() || undefined,
        readingThinking: req.readingThinking?.trim() || undefined,
        answeredAt: new Date().toISOString(),
    };
    if (req.values && req.values.length > 0) {
        const byValue = new Map(qd.options.map((o, i) => [o.value, { ...o, index: i + 1 }]));
        for (const v of req.values) {
            const opt = byValue.get(v);
            if (!opt) continue;
            base.answers.push({ label: opt.label, value: opt.value, index: opt.index });
        }
        base.answers.sort((a, b) => a.index - b.index);
    }
    if (req.other?.trim()) base.other = req.other.trim();
    if (req.text?.trim()) base.text = req.text.trim();

    if (qd.kind === "quiz") {
        base.correctIndices = qd.correctIndices ?? [];
        base.explanation = qd.explanation;
        base.correct = base.dontKnow ? false : isCorrect(base.answers.map((a) => a.index), qd.correctIndices ?? []);
        if (!base.dontKnow && req.confidence !== undefined) {
            base.confidence = Math.max(0, Math.min(100, Math.round(req.confidence)));
        }
    }
    if (qd.kind === "explain") {
        base.committed = qd.committedAnswer;
    }
    return base;
}

export function dismissedAnswer(kind: QuestionKind, questionText: string): QuestionAnswerData {
    return {
        kind,
        questionText,
        dontKnow: false,
        answers: [],
        dismissed: true,
        answeredAt: new Date().toISOString(),
    };
}

export function compactAnswerForModel(ad: QuestionAnswerData): Record<string, unknown> {
    if (ad.dismissed) return { kind: ad.kind, dismissed: true };
    const out: Record<string, unknown> = { kind: ad.kind };
    if (ad.dontKnow) out.dontKnow = true;
    if (Array.isArray(ad.answers) && ad.answers.length > 0) {
        out.answers = ad.answers.map((a) => ({ index: a.index, label: a.label }));
    }
    if (ad.text) out.text = ad.text;
    if (ad.other) out.other = ad.other;
    if (ad.correct !== undefined && !ad.dontKnow) out.correct = ad.correct;
    if (ad.confidence !== undefined) out.confidence = ad.confidence;
    if (ad.thinking) out.thinking = ad.thinking;
    if (ad.readingThinking) out.thinkingWhileReading = ad.readingThinking;
    return out;
}
