/**
 * System Prompt Assembler for Prober, Teacher, and Practitioner agents,
 * incorporating LearnHarness's core pedagogical doctrine AND proactive
 * read-only SiYuan note personalization.
 */

import voiceMd from "../../learnharness/src/agent/prompts/shared/10-voice.md";
import accuracyMd from "../../learnharness/src/agent/prompts/shared/15-accuracy.md";
import mentalModelMd from "../../learnharness/src/agent/prompts/shared/16-mental-model.md";
import questionToolsMd from "../../learnharness/src/agent/prompts/shared/20-question-tools.md";
import confidenceMd from "../../learnharness/src/agent/prompts/shared/25-confidence.md";
import formattingMd from "../../learnharness/src/agent/prompts/shared/40-formatting.md";
import probeDoctrineMd from "../../learnharness/src/agent/prompts/prober/10-probe-doctrine.md";
import teacherMethodMd from "../../learnharness/src/agent/prompts/teacher/05-method.md";
import teacherPlanningMd from "../../learnharness/src/agent/prompts/teacher/10-planning.md";
import teacherTeachingMd from "../../learnharness/src/agent/prompts/teacher/20-teaching.md";
import teacherPredictionsMd from "../../learnharness/src/agent/prompts/teacher/28-predictions.md";
import teacherQuestionsMd from "../../learnharness/src/agent/prompts/teacher/30-question-principles.md";
import practiceBaseMd from "../../learnharness/src/agent/prompts/practice/00-base.md";
import practiceDoctrineMd from "../../learnharness/src/agent/prompts/practice/10-doctrine.md";

const SIYUAN_NOTES_DOCTRINE_PROACTIVE = `## The learner's SiYuan Notes — read-only personalization

You are running directly inside the learner's **SiYuan Note** workspace with four strict read-only tools over their personal knowledge base:
- \`siyuan_find_notes\`: search notes by title, path (\`hPath\`), tag, or alias.
- \`siyuan_grep_notes\`: full-text search across blocks inside their notes to see definitions, equations, arguments, or examples they have already written.
- \`siyuan_read_note\`: read the clean Markdown content of any SiYuan note (\`docId\` or \`blockId\`).
- \`siyuan_list_notebooks\`: browse their notebooks and document hierarchy.

### How to use their SiYuan notes (Proactive Personalization)
1. **Before your first diagnostic probe on a topic**: Once the target topic is clear, **proactively search their SiYuan notes** (\`siyuan_find_notes\` and/or \`siyuan_grep_notes\`) alongside \`list_sessions\` in the knowledge graph to discover what they have already studied or written down on the topic and its prerequisite strands.
2. **Reading their notes is prior-knowledge telemetry, NOT proof of mastery**: Having a note on a concept tells you they encountered it and shows you their terminology, notation, and framing — set your binary-search probe entry point accordingly, and use \`probe\`/\`recall\` to verify whether they truly hold the concept or if their notes contain gaps or misconceptions.
3. **During teaching**: Connect new derivations to examples, notation, or notes they already have in SiYuan when natural. Do not announce raw tool mechanics ("I ran siyuan_grep_notes") — simply use the knowledge of their notes seamlessly.`;

const SIYUAN_NOTES_DOCTRINE_ON_DEMAND = `## The learner's SiYuan Notes — read-only tools

You have read-only access to the learner's SiYuan Note workspace via \`siyuan_find_notes\`, \`siyuan_grep_notes\`, \`siyuan_read_note\`, and \`siyuan_list_notebooks\`. Reach for them when the learner references their notes or when checking their existing notes would clarify their background.`;

export function buildProberSystemPrompt(opts: {
    proactiveNotes: boolean;
    mechanic: "quiz" | "explain";
}): string {
    const notesSection = opts.proactiveNotes ? SIYUAN_NOTES_DOCTRINE_PROACTIVE : SIYUAN_NOTES_DOCTRINE_ON_DEMAND;
    const toolNote =
        opts.mechanic === "explain"
            ? "NOTE: In this session the learner chose free-recall probing (`recall` tool instead of `probe`)."
            : "NOTE: In this session the learner chose multiple-choice probing (`probe` tool).";

    return [
        voiceMd,
        accuracyMd,
        mentalModelMd,
        questionToolsMd,
        confidenceMd,
        notesSection,
        formattingMd,
        probeDoctrineMd,
        toolNote,
    ].join("\n\n");
}

export function buildTeacherSystemPrompt(opts: {
    proactiveNotes: boolean;
    mechanic: "quiz" | "explain";
}): string {
    const notesSection = opts.proactiveNotes ? SIYUAN_NOTES_DOCTRINE_PROACTIVE : SIYUAN_NOTES_DOCTRINE_ON_DEMAND;
    const toolNote =
        opts.mechanic === "explain"
            ? "NOTE: In this session the learner chose free-recall checks (`explain` tool with `type` and `nodeId`)."
            : "NOTE: In this session the learner chose multiple-choice checks (`quiz` tool with `type` and `nodeId`).";

    return [
        voiceMd,
        accuracyMd,
        mentalModelMd,
        questionToolsMd,
        confidenceMd,
        notesSection,
        formattingMd,
        teacherMethodMd,
        teacherPlanningMd,
        teacherTeachingMd,
        teacherPredictionsMd,
        teacherQuestionsMd,
        toolNote,
    ].join("\n\n");
}

export function buildPracticeSystemPrompt(opts: { proactiveNotes: boolean }): string {
    const notesSection = opts.proactiveNotes ? SIYUAN_NOTES_DOCTRINE_PROACTIVE : SIYUAN_NOTES_DOCTRINE_ON_DEMAND;
    return [
        practiceBaseMd,
        voiceMd,
        accuracyMd,
        mentalModelMd,
        notesSection,
        formattingMd,
        practiceDoctrineMd,
    ].join("\n\n");
}
