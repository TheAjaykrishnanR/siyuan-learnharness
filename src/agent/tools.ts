/**
 * Agent Tools Registry for LearnHarness in SiYuan:
 * 1. Read-Only SiYuan Note Tools (siyuan_list_notebooks, siyuan_find_notes, siyuan_grep_notes, siyuan_read_note)
 * 2. Knowledge Graph Tools (list_sessions, list_propositions)
 * 3. Question & Assessment Tools (ask_user_question, probe, recall, probe_done, quiz, explain)
 * 4. Plan Tree Tool (plan_init)
 * 5. Practice Tools (problem, conclude)
 */

import {
    CONCLUDE_ACK_TEXT,
    PROBE_DONE_ACK_TEXT,
    probeDoneInputSchema,
    type GraphNode,
} from "../core/contracts";
import { healEncodedArguments } from "../core/argument-heal";
import { graphSessionIndex, graphSessionPropositions, resolveTargetId, type GraphDeps } from "../core/graph";
import { parseMermaidPlan } from "../core/mermaid-plan";
import { activeProblemOf, danglingQuestionOf, hasProbeDone } from "../core/messages";
import { createTree, PlanTreeError } from "../core/plan-tree";
import type { ChatStore } from "../core/ports";
import {
    askInputSchema,
    askOptionProblems,
    explainInputBase,
    explainInputObject,
    explainInputProblems,
    parseOptionsIfString,
    probeQuizInputSchema,
    quizInputObject,
    quizInputProblems,
} from "../core/question-core";
import { Type, validateSchema, type TSchema } from "../core/schema";
import { findNotes, grepNotes, listDocsByPath, listNotebooks, readNoteMarkdown } from "../siyuan/client";

export interface AgentToolResult {
    text: string;
    details?: unknown;
    isError?: boolean;
    /** If true, this tool call pauses the agent loop and waits for learner interaction (e.g., quiz, probe, ask, problem). */
    terminal?: boolean;
}

export interface AgentToolDefinition {
    name: string;
    description: string;
    parameters: TSchema;
    prepareArguments?: (args: unknown) => unknown;
    execute: (toolCallId: string, args: Record<string, unknown>) => Promise<AgentToolResult>;
}

function invalidInputResult(toolName: string, problems: string[]): AgentToolResult {
    return {
        text: JSON.stringify({
            ok: false,
            tool: toolName,
            error: `Invalid arguments for ${toolName}:\n${problems.map((p) => `- ${p}`).join("\n")}`,
        }),
        details: { ok: false, problems },
        isError: true,
    };
}

export function withArgumentHeal(tool: AgentToolDefinition): AgentToolDefinition {
    const inner = tool.prepareArguments;
    return {
        ...tool,
        prepareArguments: (args: unknown) =>
            healEncodedArguments(inner ? inner(args) : args, tool.parameters as any),
    };
}

export function healToolRecord(tools: Record<string, AgentToolDefinition>): Record<string, AgentToolDefinition> {
    return Object.fromEntries(Object.entries(tools).map(([k, v]) => [k, withArgumentHeal(v)]));
}

// ─── 1. Strict Read-Only SiYuan Note Tools ──────────────────────────────────

const listNotebooksSchema = Type.Object({
    notebookId: Type.Optional(
        Type.String({
            description:
                "Optional notebook (box) ID. Omit to list all open notebooks; provide a notebook ID to list its top-level documents.",
        }),
    ),
    path: Type.Optional(
        Type.String({
            description: "Optional tree path inside the notebook (default '/').",
        }),
    ),
});

const findNotesSchema = Type.Object({
    query: Type.String({
        description:
            "Keyword or concept to search across the learner's SiYuan note titles, human-readable paths (hPath), tags, and aliases. Pass '' to list the most recently updated notes.",
    }),
    limit: Type.Optional(
        Type.Number({
            description: "Maximum number of matching notes to return (default 20, max 60).",
        }),
    ),
});

const grepNotesSchema = Type.Object({
    query: Type.String({
        minLength: 1,
        description:
            "Search phrase or keyword to full-text search across all blocks inside the learner's SiYuan notes.",
    }),
    notebookId: Type.Optional(
        Type.String({
            description: "Optional notebook ID to restrict the search to a single notebook.",
        }),
    ),
    limit: Type.Optional(
        Type.Number({
            description: "Maximum number of matching blocks to return (default 15, max 40).",
        }),
    ),
});

const readNoteSchema = Type.Object({
    id: Type.String({
        minLength: 1,
        description:
            "The SiYuan document ID (rootId) or block ID to read as clean Markdown (returned by siyuan_find_notes or siyuan_grep_notes).",
    }),
    offset: Type.Optional(
        Type.Number({
            description: "1-based line number to start reading from (default 1).",
        }),
    ),
    limit: Type.Optional(
        Type.Number({
            description: "Maximum number of lines to read (default 200).",
        }),
    ),
});

export function siyuanNoteTools(): Record<string, AgentToolDefinition> {
    return {
        siyuan_list_notebooks: {
            name: "siyuan_list_notebooks",
            description:
                "Read-only tool to list the learner's SiYuan notebooks, or list documents inside a specific notebook path. Use this to see how the learner organizes their knowledge base.",
            parameters: listNotebooksSchema,
            execute: async (_id, args) => {
                try {
                    const notebookId = typeof args.notebookId === "string" ? args.notebookId.trim() : "";
                    if (!notebookId) {
                        const notebooks = await listNotebooks(false);
                        if (notebooks.length === 0) {
                            return { text: "(no open SiYuan notebooks found)" };
                        }
                        const lines = notebooks.map((nb) => `[${nb.id}] ${nb.name}`);
                        return { text: lines.join("\n"), details: { notebooks } };
                    }
                    const path = typeof args.path === "string" && args.path.trim() ? args.path.trim() : "/";
                    const docs = await listDocsByPath(notebookId, path);
                    if (docs.length === 0) {
                        return { text: `(no documents at path ${path} in notebook ${notebookId})` };
                    }
                    const lines = docs.map(
                        (d) => `[docId: ${d.id}] ${d.name} (path: ${d.path}, subDocs: ${d.subFileCount ?? 0})`,
                    );
                    return { text: lines.join("\n"), details: { docs } };
                } catch (err: any) {
                    return { text: `Error listing SiYuan notebooks: ${err?.message ?? String(err)}`, isError: true };
                }
            },
        },

        siyuan_find_notes: {
            name: "siyuan_find_notes",
            description:
                "Read-only tool to find existing SiYuan notes by title, folder path (hPath), tag, or alias. Use this proactively to discover what notes the learner already has on the target topic or its prerequisites.",
            parameters: findNotesSchema,
            execute: async (_id, args) => {
                try {
                    const query = String(args.query ?? "");
                    const limit = typeof args.limit === "number" ? args.limit : 20;
                    const docs = await findNotes(query, limit);
                    if (docs.length === 0) {
                        return {
                            text: query
                                ? `No SiYuan notes found matching "${query}". Try a broader term or use siyuan_grep_notes for full-text search.`
                                : "(no SiYuan notes found)",
                        };
                    }
                    const lines = docs.map(
                        (d) => `[docId: ${d.id}] "${d.name}" — hPath: ${d.hPath || d.path}`,
                    );
                    return { text: lines.join("\n"), details: { query, count: docs.length, docs } };
                } catch (err: any) {
                    return { text: `Error finding SiYuan notes: ${err?.message ?? String(err)}`, isError: true };
                }
            },
        },

        siyuan_grep_notes: {
            name: "siyuan_grep_notes",
            description:
                "Read-only full-text search across all blocks inside the learner's SiYuan notes. Returns matching blocks with their parent document ID (rootId), human-readable path (hPath), and Markdown snippet. Use this to check what definitions, formulas, or explanations the learner has already written in their notes.",
            parameters: grepNotesSchema,
            execute: async (_id, args) => {
                try {
                    const query = String(args.query ?? "").trim();
                    if (!query) return invalidInputResult("siyuan_grep_notes", ["query must not be empty"]);
                    const matches = await grepNotes(query, {
                        notebookId: typeof args.notebookId === "string" ? args.notebookId : undefined,
                        limit: typeof args.limit === "number" ? args.limit : 15,
                    });
                    if (matches.length === 0) {
                        return { text: `No blocks found matching "${query}" in SiYuan notes.` };
                    }
                    const lines = matches.map((m) => {
                        const snippet = (m.markdown || m.content).replace(/\s+/g, " ").trim().slice(0, 260);
                        return `[docId: ${m.rootId} | blockId: ${m.id}] (${m.hPath})\n  ${snippet}`;
                    });
                    return { text: lines.join("\n\n"), details: { query, count: matches.length, matches } };
                } catch (err: any) {
                    return { text: `Error searching SiYuan notes: ${err?.message ?? String(err)}`, isError: true };
                }
            },
        },

        siyuan_read_note: {
            name: "siyuan_read_note",
            description:
                "Read-only tool to export and read the clean Markdown content of a SiYuan note (by docId or blockId). Supports line-based pagination via offset and limit.",
            parameters: readNoteSchema,
            execute: async (_id, args) => {
                try {
                    const id = String(args.id ?? "").trim();
                    if (!id) return invalidInputResult("siyuan_read_note", ["id is required"]);
                    const exported = await readNoteMarkdown(id);
                    const allLines = exported.content.split(/\r?\n/);
                    const total = allLines.length;
                    const startLine = Math.max(1, typeof args.offset === "number" ? Math.floor(args.offset) : 1);
                    const maxLines = Math.max(1, Math.min(500, typeof args.limit === "number" ? Math.floor(args.limit) : 200));
                    const slice = allLines.slice(startLine - 1, startLine - 1 + maxLines);
                    const numbered = slice.map((line, i) => `${startLine + i}: ${line}`).join("\n");
                    const endLine = startLine + slice.length - 1;
                    const footer =
                        endLine < total
                            ? `\n\n[Showing lines ${startLine}-${endLine} of ${total} from "${exported.hPath}". Pass offset=${endLine + 1} to read more.]`
                            : `\n\n[End of note "${exported.hPath}" (${total} lines total).]`;
                    return {
                        text: `# SiYuan Note: ${exported.hPath} (id: ${exported.id})\n\n${numbered}${footer}`,
                        details: { id: exported.id, hPath: exported.hPath, totalLines: total },
                    };
                } catch (err: any) {
                    return { text: `Error reading SiYuan note: ${err?.message ?? String(err)}`, isError: true };
                }
            },
        },
    };
}

// ─── 2. Knowledge Graph Tools (list_sessions, list_propositions) ────────────

const listSessionsSchema = Type.Object({});
const listPropositionsSchema = Type.Object({
    sessionId: Type.String({
        minLength: 1,
        description: "The session ID (chatId or src_... note ID) returned by list_sessions.",
    }),
});

export function proberGraphTools(deps: GraphDeps): Record<string, AgentToolDefinition> {
    return {
        list_sessions: {
            name: "list_sessions",
            description:
                "List every learning session and imported note in the learner's LearnHarness knowledge graph, most-recently-active first, with proposition counts.",
            parameters: listSessionsSchema,
            execute: async () => {
                const entries = graphSessionIndex(deps);
                if (entries.length === 0) return { text: "(no prior sessions in the knowledge graph)" };
                const lines = entries.map((e) => {
                    const date = (e.updatedAt ?? e.createdAt)?.slice(0, 10) ?? "undated";
                    return `[${e.id}] "${e.name}" (${e.kind}, ${date}, ${e.propositions} propositions)`;
                });
                return { text: lines.join("\n"), details: { count: entries.length } };
            },
        },
        list_propositions: {
            name: "list_propositions",
            description:
                "List the propositions born in a specific session from the learner's knowledge graph.",
            parameters: listPropositionsSchema,
            execute: async (_id, args) => {
                const sessionId = String(args.sessionId ?? "").trim();
                const props = graphSessionPropositions(deps, sessionId);
                if (props.length === 0) return { text: `(no propositions found for session ${sessionId})` };
                const lines = props.map((p) => `[${p.nodeId}] ${p.name}: ${p.statement}`);
                return { text: lines.join("\n"), details: { sessionId, count: props.length } };
            },
        },
    };
}

// ─── 3. Plan Tree Tool (plan_init) ──────────────────────────────────────────

const PLAN_NODE_IDS_REMINDER =
    "These are the plan's node ids — the only valid nodeId values for every quiz and explain call from here on. Reference them exactly.";

const planInitSchema = Type.Object({
    mermaid: Type.String({
        minLength: 1,
        description:
            "A mermaid graph block (any direction), e.g.:\ngraph TD\n  primitives[Number primitives] --> operators[Arithmetic operators] --> expressions[Evaluating expressions]\n" +
            "The only strict rule: ids are permanent lowercase slugs (a-z, 0-9, hyphens/underscores) — checks reference them via nodeId.",
    }),
});

export function planTools(ctx: { chatId: string; chatStore: ChatStore }): Record<string, AgentToolDefinition> {
    return {
        plan_init: {
            name: "plan_init",
            description:
                "Write or REWRITE this session's plan map — the dependency graph the learner follows live in the plan panel. " +
                "Call once right after the probe concludes, to present the map; re-call whenever the map needs restructuring. " +
                "A mermaid graph block: one node per line (`slug[Short Title]`), `-->` edges meaning 'from must be understood before to'.",
            parameters: planInitSchema,
            execute: async (_id, args) => {
                const record = ctx.chatStore.getChat(ctx.chatId);
                if (!record) return invalidInputResult("plan_init", [`Chat not found: ${ctx.chatId}`]);

                const mermaid = String(args.mermaid ?? "");
                const parsed = parseMermaidPlan(mermaid);
                if (!parsed.ok || !parsed.plan) {
                    return invalidInputResult("plan_init", parsed.problems);
                }
                try {
                    const next = createTree(parsed.plan.nodes, parsed.plan.edges);
                    ctx.chatStore.saveTree(ctx.chatId, next);
                    return {
                        text: JSON.stringify({
                            ok: true,
                            nodeIds: next.nodes.map((n) => n.id),
                            reminder: PLAN_NODE_IDS_REMINDER,
                        }),
                        details: { ok: true, tree: next },
                    };
                } catch (err) {
                    if (err instanceof PlanTreeError) {
                        return invalidInputResult("plan_init", [err.message]);
                    }
                    throw err;
                }
            },
        },
    };
}

// ─── 4. Probe Conclude Tool (probe_done) ────────────────────────────────────

export function probeDoneTool(ctx: {
    chatId: string;
    chatStore: ChatStore;
    onProbeConcluded: () => void;
}): Record<string, AgentToolDefinition> {
    return {
        probe_done: {
            name: "probe_done",
            description:
                "Conclude the probing phase and hand off to the teaching phase. Call this ONCE when the probe is complete: " +
                "every strand the lesson depends on is bracketed (floor and ceiling) and the learning goal is concrete. " +
                "The input IS the learner assessment across strands.",
            parameters: probeDoneInputSchema,
            execute: async (_id, args) => {
                const schemaErrors = validateSchema(probeDoneInputSchema, args);
                if (schemaErrors.length > 0) {
                    return invalidInputResult("probe_done", schemaErrors);
                }
                const record = ctx.chatStore.getChat(ctx.chatId);
                if (!record) return invalidInputResult("probe_done", [`Chat not found: ${ctx.chatId}`]);

                if (danglingQuestionOf(record.messages) !== null) {
                    return invalidInputResult("probe_done", [
                        "A question is still open — resolve it (or let the learner answer) before concluding the probe.",
                    ]);
                }
                if (hasProbeDone(record.messages)) {
                    return invalidInputResult("probe_done", [
                        "The probe is already concluded — probe_done fires exactly once.",
                    ]);
                }
                ctx.onProbeConcluded();
                return {
                    text: PROBE_DONE_ACK_TEXT,
                    details: { ok: true, assessment: args.assessment },
                };
            },
        },
    };
}

// ─── 5. Question Tools (ask_user_question, probe, recall, quiz, explain) ────

export function createQuestionTools(ctx: {
    chatId: string;
    chatStore: ChatStore;
    phase: "probe" | "teach";
    mechanic: "quiz" | "explain";
}): Record<string, AgentToolDefinition> {
    const validateNodeId = (nodeIdRaw: unknown): string | null => {
        const record = ctx.chatStore.getChat(ctx.chatId);
        const tree = record?.tree;
        if (!tree || tree.nodes.length === 0) {
            return "No plan tree exists yet — call `plan_init` to author the dependency map before posing a teaching question.";
        }
        const nodeId = typeof nodeIdRaw === "string" ? nodeIdRaw.trim() : "";
        const validIds = tree.nodes.map((n) => n.id);
        if (!validIds.includes(nodeId)) {
            return `Unknown plan nodeId "${nodeId}". Valid nodeIds from plan_init: ${validIds.map((id) => `"${id}"`).join(", ")}.`;
        }
        return null;
    };

    const askTool: AgentToolDefinition = {
        name: "ask_user_question",
        description:
            "Ask the learner a single ungraded question (goal clarification, preferences, or off-map discussion) and wait for their response. Ends your turn.",
        parameters: askInputSchema,
        prepareArguments: (raw) => {
            if (!raw || typeof raw !== "object") return raw;
            const obj = raw as Record<string, unknown>;
            if ("options" in obj) {
                return { ...obj, options: parseOptionsIfString(obj.options as any) };
            }
            return raw;
        },
        execute: async (_id, args) => {
            const schemaErrors = validateSchema(askInputSchema, args);
            if (schemaErrors.length > 0) return invalidInputResult("ask_user_question", schemaErrors);
            if (Array.isArray(args.options)) {
                const probs = askOptionProblems(args.options as any);
                if (probs.length > 0) return invalidInputResult("ask_user_question", probs);
            }
            return {
                text: "Question posed to learner; waiting for answer.",
                details: { waitingForAnswer: true },
                terminal: true,
            };
        },
    };

    if (ctx.phase === "probe") {
        if (ctx.mechanic === "explain") {
            return {
                ask_user_question: askTool,
                recall: {
                    name: "recall",
                    description:
                        "Pose a diagnostic free-recall probe question to measure the learner's prior knowledge on a prerequisite strand. Commit to `correctAnswer` before posing. Ends your turn.",
                    parameters: explainInputBase,
                    execute: async (_id, args) => {
                        const errs = [
                            ...validateSchema(explainInputBase, args),
                            ...explainInputProblems({ correctAnswer: String(args.correctAnswer ?? "") }),
                        ];
                        if (errs.length > 0) return invalidInputResult("recall", errs);
                        return {
                            text: "Diagnostic recall question posed; waiting for learner's answer.",
                            details: { waitingForAnswer: true },
                            terminal: true,
                        };
                    },
                },
            };
        }
        return {
            ask_user_question: askTool,
            probe: {
                name: "probe",
                description:
                    "Pose a diagnostic multiple-choice probe question to binary-search the learner's knowledge floor and ceiling on a prerequisite strand. Ends your turn.",
                parameters: probeQuizInputSchema,
                prepareArguments: (raw) => {
                    if (!raw || typeof raw !== "object") return raw;
                    const obj = raw as Record<string, unknown>;
                    return { ...obj, options: parseOptionsIfString(obj.options as any) };
                },
                execute: async (_id, args) => {
                    const schemaErrs = validateSchema(probeQuizInputSchema, args);
                    if (schemaErrs.length > 0) return invalidInputResult("probe", schemaErrs);
                    const probs = quizInputProblems({
                        options: (args.options as any) ?? [],
                        correctAnswer: args.correctAnswer as any,
                        multiSelect: args.multiSelect as boolean | undefined,
                    });
                    if (probs.length > 0) return invalidInputResult("probe", probs);
                    return {
                        text: "Diagnostic probe question posed; waiting for learner's answer.",
                        details: { waitingForAnswer: true },
                        terminal: true,
                    };
                },
            },
        };
    }

    // Teacher phase ("teach")
    if (ctx.mechanic === "explain") {
        return {
            ask_user_question: askTool,
            explain: {
                name: "explain",
                description:
                    "Pose a free-recall question (`type: 'predict'` before teaching a step, or `type: 'check'` after teaching it) tagged with the current plan `nodeId`. Ends your turn.",
                parameters: explainInputObject,
                execute: async (_id, args) => {
                    const schemaErrs = validateSchema(explainInputObject, args);
                    if (schemaErrs.length > 0) return invalidInputResult("explain", schemaErrs);
                    const nodeErr = validateNodeId(args.nodeId);
                    if (nodeErr) return invalidInputResult("explain", [nodeErr]);
                    const probs = explainInputProblems({ correctAnswer: String(args.correctAnswer ?? "") });
                    if (probs.length > 0) return invalidInputResult("explain", probs);
                    return {
                        text: "Question posed; waiting for learner's answer.",
                        details: { waitingForAnswer: true },
                        terminal: true,
                    };
                },
            },
        };
    }

    return {
        ask_user_question: askTool,
        quiz: {
            name: "quiz",
            description:
                "Pose a multiple-choice question (`type: 'predict'` before teaching a step, or `type: 'check'` after teaching it) tagged with the current plan `nodeId`. Ends your turn.",
            parameters: quizInputObject,
            prepareArguments: (raw) => {
                if (!raw || typeof raw !== "object") return raw;
                const obj = raw as Record<string, unknown>;
                return { ...obj, options: parseOptionsIfString(obj.options as any) };
            },
            execute: async (_id, args) => {
                const schemaErrs = validateSchema(quizInputObject, args);
                if (schemaErrs.length > 0) return invalidInputResult("quiz", schemaErrs);
                const nodeErr = validateNodeId(args.nodeId);
                if (nodeErr) return invalidInputResult("quiz", [nodeErr]);
                const probs = quizInputProblems({
                    options: (args.options as any) ?? [],
                    correctAnswer: args.correctAnswer as any,
                    multiSelect: args.multiSelect as boolean | undefined,
                });
                if (probs.length > 0) return invalidInputResult("quiz", probs);
                return {
                    text: "Quiz posed; waiting for learner's answer.",
                    details: { waitingForAnswer: true },
                    terminal: true,
                };
            },
        },
    };
}

// ─── 6. Practice Tools (problem, conclude) ──────────────────────────────────

const problemInputObject = Type.Object({
    statement: Type.String({
        description:
            "REQUIRED — the problem as the learner sees it (markdown + LaTeX). Must be self-contained and solvable from the session's material.",
    }),
    mode: Type.Union([Type.Literal("recall"), Type.Literal("discrimination"), Type.Literal("composition")], {
        description: "REQUIRED — the demand mode: recall, discrimination, or composition (bare words, no quotes).",
    }),
    target: Type.Optional(
        Type.Array(Type.String(), {
            minItems: 1,
            description:
                "The proposition id(s) this problem exercises, from the session context's [id] list — include when the material is in the map; omit when untagged.",
        }),
    ),
    modelSolution: Type.String({
        description:
            "REQUIRED — the full solution, moves in order, committed BEFORE the learner sees the problem. Conclude shows it verbatim.",
    }),
});

const concludeInputObject = Type.Object({
    outcome: Type.Union(
        [
            Type.Literal("solved"),
            Type.Literal("solvedWithHints"),
            Type.Literal("movedOn"),
            Type.Literal("surrendered"),
            Type.Literal("dismissed"),
        ],
        { description: "REQUIRED — the outcome: solved, solvedWithHints, movedOn, or surrendered." },
    ),
    verdict: Type.String({
        description: "REQUIRED — plain-language verdict: what was credited, where it broke.",
    }),
    rung: Type.Union(
        [
            Type.Literal("R0"),
            Type.Literal("R1"),
            Type.Literal("R2"),
            Type.Literal("R3"),
            Type.Literal("R4"),
            Type.Literal("R5"),
            Type.Null(),
        ],
        { description: "REQUIRED — the hint-ladder rung the problem needed: R0 through R5, or null." },
    ),
    missClass: Type.Union(
        [
            Type.Literal("cue"),
            Type.Literal("discrimination"),
            Type.Literal("execution"),
            Type.Literal("careless"),
            Type.Literal("structural"),
            Type.Null(),
        ],
        { description: "REQUIRED — the miss classification, or null = no miss." },
    ),
    retest: Type.Boolean({
        description: "REQUIRED — true marks the problem for a fresh-surface retest before the session ends.",
    }),
});

export function createPracticeToolSet(ctx: {
    chatId: string;
    chatStore: ChatStore;
    graphDeps: GraphDeps;
    graphNodes: () => ReadonlyArray<Pick<GraphNode, "id" | "name">>;
}): Record<string, AgentToolDefinition> {
    const record = ctx.chatStore.getChat(ctx.chatId);
    const gate = {
        problemActive: record ? activeProblemOf(record.messages) !== null : false,
    };

    return healToolRecord({
        problem: {
            name: "problem",
            description:
                "Pose one practice problem. Ends the turn — the learner works in the thinking field; their thinking traces and answer commits arrive back as labeled messages.",
            parameters: problemInputObject,
            prepareArguments: (args) => {
                const healed = healEncodedArguments(args, problemInputObject as any) as Record<string, unknown>;
                const target = healed?.target;
                if (!Array.isArray(target) || target.length === 0) {
                    return { ...healed, target: undefined };
                }
                const list = ctx.graphNodes();
                const normalized = target.map((t) => (typeof t === "string" ? (resolveTargetId(t, list) ?? t) : t));
                return { ...healed, target: normalized };
            },
            execute: async (_id, args) => {
                if (gate.problemActive) {
                    return invalidInputResult("problem", [
                        "a problem is already active — call conclude on it before posing the next one",
                    ]);
                }
                const schemaErrs = validateSchema(problemInputObject, args);
                if (schemaErrs.length > 0) return invalidInputResult("problem", schemaErrs);
                const target = args.target as string[] | undefined;
                if (Array.isArray(target) && target.length > 0) {
                    const list = ctx.graphNodes();
                    const unknown = target.filter((t) => resolveTargetId(t, list) === null);
                    if (unknown.length > 0) {
                        return invalidInputResult("problem", [
                            `target ${JSON.stringify(unknown)} is not a known proposition — targets must be proposition ids from the session context; if the material is not in the map, omit target entirely`,
                        ]);
                    }
                }
                gate.problemActive = true;
                return {
                    text: "Problem posed to learner; waiting for learner's thinking/solution.",
                    details: { ok: true, waitingForProblem: true },
                    terminal: true,
                };
            },
        },
        conclude: {
            name: "conclude",
            description:
                "Conclude the active problem: records the outcome + verdict, reveals the committed solution, and frees the learner's composer. After the result, say your closing words if useful, then END YOUR TURN.",
            parameters: concludeInputObject,
            execute: async (_id, args) => {
                if (!gate.problemActive) {
                    return invalidInputResult("conclude", ["no active problem to conclude — pose one first"]);
                }
                const schemaErrs = validateSchema(concludeInputObject, args);
                if (schemaErrs.length > 0) return invalidInputResult("conclude", schemaErrs);
                gate.problemActive = false;
                return {
                    text: CONCLUDE_ACK_TEXT,
                    details: { ok: true },
                };
            },
        },
        ...siyuanNoteTools(),
        ...proberGraphTools(ctx.graphDeps),
    });
}
