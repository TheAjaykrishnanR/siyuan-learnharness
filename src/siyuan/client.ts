/**
 * STRICT READ-ONLY SiYuan Kernel Client.
 *
 * SECURITY & DESIGN INVARIANT:
 * This module ONLY calls read/search/export endpoints on the SiYuan Kernel API:
 *   - /api/notebook/lsNotebooks
 *   - /api/filetree/listDocsByPath
 *   - /api/filetree/searchDocs
 *   - /api/search/fullTextSearchBlock
 *   - /api/export/exportMdContent
 *   - /api/query/sql (strictly validated to allow SELECT queries ONLY)
 *
 * No create, update, append, rename, or delete endpoints are ever called or exposed.
 */

import { fetchSyncPost, type IWebSocketData } from "siyuan";

export interface SiyuanNotebook {
    id: string;
    name: string;
    icon: string;
    closed: boolean;
}

export interface SiyuanDocEntry {
    id: string;
    name: string;
    path: string;
    hPath?: string;
    box?: string;
    subFileCount?: number;
    updated?: string;
}

export interface SiyuanBlockMatch {
    id: string;
    rootId: string;
    box: string;
    hPath: string;
    type: string;
    content: string;
    markdown: string;
    updated: string;
}

export interface SiyuanExportedMd {
    id: string;
    hPath: string;
    content: string;
}

/** Validate that a SQL query is strictly read-only (SELECT only, no mutation keywords). */
export function assertReadOnlySql(sql: string): void {
    const trimmed = sql.trim();
    if (!/^SELECT\b/i.test(trimmed)) {
        throw new Error("Security Violation: Only read-only SELECT SQL queries are permitted.");
    }
    if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|REPLACE|CREATE|PRAGMA|ATTACH|DETACH|VACUUM)\b/i.test(trimmed)) {
        throw new Error("Security Violation: SQL query contains forbidden non-read-only keywords.");
    }
}

async function postReadOnly<T = any>(url: string, payload: Record<string, unknown> = {}): Promise<T> {
    const allowedEndpoints = new Set([
        "/api/notebook/lsNotebooks",
        "/api/filetree/listDocsByPath",
        "/api/filetree/searchDocs",
        "/api/search/fullTextSearchBlock",
        "/api/export/exportMdContent",
        "/api/query/sql",
    ]);
    if (!allowedEndpoints.has(url)) {
        throw new Error(`Security Violation: Endpoint ${url} is not on the read-only allowlist.`);
    }
    const res: IWebSocketData = await fetchSyncPost(url, payload);
    if (res.code !== 0) {
        throw new Error(`SiYuan API error (${url}): ${res.msg || `code ${res.code}`}`);
    }
    return res.data as T;
}

/** Run a strictly validated read-only SELECT query against SiYuan's SQLite database. */
export async function queryReadOnlySql<T = Record<string, any>>(sql: string): Promise<T[]> {
    assertReadOnlySql(sql);
    const data = await postReadOnly<T[] | null>("/api/query/sql", { stmt: sql });
    return Array.isArray(data) ? data : [];
}

/** Escape a string literal for safe embedding in a SQLite LIKE / equality clause. */
function escapeSqlString(val: string): string {
    return val.replace(/'/g, "''");
}

/** List all open (and optionally closed) SiYuan notebooks. */
export async function listNotebooks(includeClosed = false): Promise<SiyuanNotebook[]> {
    const data = await postReadOnly<{ notebooks?: SiyuanNotebook[] }>("/api/notebook/lsNotebooks");
    const list = data?.notebooks ?? [];
    return includeClosed ? list : list.filter((nb) => !nb.closed);
}

/** List documents inside a notebook at a given tree path (default "/"). */
export async function listDocsByPath(notebookId: string, path = "/"): Promise<SiyuanDocEntry[]> {
    const data = await postReadOnly<{ files?: any[] }>("/api/filetree/listDocsByPath", {
        notebook: notebookId,
        path: path || "/",
    });
    const files = data?.files ?? [];
    return files.map((f) => ({
        id: String(f.id ?? ""),
        name: String(f.name ?? "").replace(/\.sy$/i, ""),
        path: String(f.path ?? ""),
        box: notebookId,
        subFileCount: typeof f.subFileCount === "number" ? f.subFileCount : 0,
        updated: String(f.updated ?? ""),
    }));
}

/** Find SiYuan documents by title, human-readable path (hPath), tag, or alias. */
export async function findNotes(query: string, limit = 25): Promise<SiyuanDocEntry[]> {
    const q = escapeSqlString(query.trim());
    const safeLimit = Math.max(1, Math.min(100, limit));
    const whereClause = q
        ? `WHERE type = 'd' AND (content LIKE '%${q}%' OR hpath LIKE '%${q}%' OR tag LIKE '%${q}%' OR alias LIKE '%${q}%')`
        : `WHERE type = 'd'`;
    const rows = await queryReadOnlySql<{
        id: string;
        box: string;
        path: string;
        hpath: string;
        content: string;
        updated: string;
    }>(`SELECT id, box, path, hpath, content, updated FROM blocks ${whereClause} ORDER BY updated DESC LIMIT ${safeLimit}`);

    return rows.map((r) => ({
        id: r.id,
        name: r.content || r.hpath,
        path: r.path,
        hPath: r.hpath,
        box: r.box,
        updated: r.updated,
    }));
}

/** Full-text search across blocks inside SiYuan notes. Returns block matches with document hPath and markdown. */
export async function grepNotes(
    query: string,
    opts: { notebookId?: string; limit?: number } = {},
): Promise<SiyuanBlockMatch[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const safeLimit = Math.max(1, Math.min(60, opts.limit ?? 20));

    try {
        const res = await postReadOnly<{ blocks?: any[] }>("/api/search/fullTextSearchBlock", {
            query: trimmed,
            method: 0,
            types: {
                document: true,
                heading: true,
                paragraph: true,
                list: true,
                listItem: true,
                codeBlock: true,
                mathBlock: true,
                table: true,
                blockquote: true,
                superBlock: false,
            },
            paths: opts.notebookId ? [opts.notebookId] : [],
            groupBy: 0,
            orderBy: 0,
            page: 1,
            pageSize: safeLimit,
        });
        if (Array.isArray(res?.blocks) && res.blocks.length > 0) {
            return res.blocks.slice(0, safeLimit).map((b) => ({
                id: String(b.id ?? ""),
                rootId: String(b.rootID ?? b.root_id ?? b.id ?? ""),
                box: String(b.box ?? ""),
                hPath: String(b.hPath ?? b.hpath ?? ""),
                type: String(b.type ?? ""),
                content: String(b.content ?? "").replace(/<\/?(mark|em)>/g, ""),
                markdown: String(b.markdown ?? b.content ?? "").replace(/<\/?(mark|em)>/g, ""),
                updated: String(b.updated ?? ""),
            }));
        }
    } catch {
        // Fallback to SQL search if fullTextSearchBlock fails
    }

    const q = escapeSqlString(trimmed);
    const boxFilter = opts.notebookId ? `AND box = '${escapeSqlString(opts.notebookId)}'` : "";
    const rows = await queryReadOnlySql<{
        id: string;
        root_id: string;
        box: string;
        hpath: string;
        type: string;
        content: string;
        markdown: string;
        updated: string;
    }>(
        `SELECT id, root_id, box, hpath, type, content, markdown, updated FROM blocks WHERE (markdown LIKE '%${q}%' OR content LIKE '%${q}%') ${boxFilter} ORDER BY updated DESC LIMIT ${safeLimit}`,
    );

    return rows.map((r) => ({
        id: r.id,
        rootId: r.root_id || r.id,
        box: r.box,
        hPath: r.hpath,
        type: r.type,
        content: r.content,
        markdown: r.markdown || r.content,
        updated: r.updated,
    }));
}

/** Export clean Markdown content of a SiYuan document or block by its ID, plus backlinks/metadata. */
export async function readNoteMarkdown(docOrBlockId: string): Promise<SiyuanExportedMd> {
    const cleanId = docOrBlockId.trim();
    if (!cleanId) {
        throw new Error("A non-empty SiYuan document or block ID is required.");
    }
    const exported = await postReadOnly<{ hPath?: string; content?: string }>("/api/export/exportMdContent", {
        id: cleanId,
    });
    return {
        id: cleanId,
        hPath: String(exported?.hPath ?? ""),
        content: String(exported?.content ?? ""),
    };
}

/** Fetch a single SiYuan block by its ID (read-only). */
export async function getBlockById(blockId: string): Promise<SiyuanBlockMatch | null> {
    const cleanId = escapeSqlString(blockId.trim());
    if (!cleanId) return null;
    const rows = await queryReadOnlySql<{
        id: string;
        root_id: string;
        box: string;
        hpath: string;
        type: string;
        content: string;
        markdown: string;
        updated: string;
    }>(`SELECT id, root_id, box, hpath, type, content, markdown, updated FROM blocks WHERE id = '${cleanId}' LIMIT 1`);
    const r = rows[0];
    if (!r) return null;
    return {
        id: r.id,
        rootId: r.root_id || r.id,
        box: r.box,
        hPath: r.hpath,
        type: r.type,
        content: r.content,
        markdown: r.markdown || r.content,
        updated: r.updated,
    };
}

/** Search SiYuan blocks (docs, headings, paragraphs, code, math) for the chat input block picker. */
export async function searchBlocksForRef(query: string, limit = 15): Promise<SiyuanBlockMatch[]> {
    const trimmed = query.trim();
    const safeLimit = Math.max(1, Math.min(40, limit));
    if (!trimmed) {
        const rows = await queryReadOnlySql<{
            id: string;
            root_id: string;
            box: string;
            hpath: string;
            type: string;
            content: string;
            markdown: string;
            updated: string;
        }>(
            `SELECT id, root_id, box, hpath, type, content, markdown, updated FROM blocks WHERE type IN ('d', 'h', 'p') AND content != '' ORDER BY updated DESC LIMIT ${safeLimit}`,
        );
        return rows.map((r) => ({
            id: r.id,
            rootId: r.root_id || r.id,
            box: r.box,
            hPath: r.hpath,
            type: r.type,
            content: r.content,
            markdown: r.markdown || r.content,
            updated: r.updated,
        }));
    }
    return grepNotes(trimmed, { limit: safeLimit });
}

const IMAGE_EXT_MIME: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
};

/** Extract unique SiYuan `assets/...` image paths from Markdown, HTML, or SiYuan annotation refs. */
export function extractAssetImagePaths(markdownOrHtml: string): string[] {
    if (!markdownOrHtml) return [];
    const seen = new Set<string>();
    const addIfImage = (raw: string) => {
        const noQuery = raw.trim().split(/[?#]/)[0] ?? "";
        const clean = noQuery.replace(/^\.?\//, "").replace(/^data\//i, "");
        if (!/^assets\//i.test(clean)) return;
        const ext = clean.split(".").pop()?.toLowerCase() ?? "";
        if (!(ext in IMAGE_EXT_MIME)) return;
        seen.add(clean);
    };

    // Match any `assets/...(.png|.jpg|.jpeg|.webp|.gif)` reference across Markdown, HTML, and SiYuan annotations
    for (const m of markdownOrHtml.matchAll(/(?:\/?data\/|\.?\/)?(assets\/[^\s)"'<>`]+\.(?:png|jpe?g|webp|gif))/gi)) {
        if (m[1]) addIfImage(m[1]);
    }
    return Array.from(seen);
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
    const bytes = new Uint8Array(buf);
    const chunkSize = 0x8000;
    let binary = "";
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
}

/** Read a SiYuan asset image via `/api/file/getFile` (with `/assets/...` fallback) and return a base64 `data:` URL. */
export async function readSiyuanImageDataUrl(assetPath: string): Promise<string | null> {
    const trimmed = assetPath.trim();
    if (!trimmed) return null;
    if (/^data:image\//i.test(trimmed)) return trimmed;

    const clean = trimmed.replace(/^\.?\//, "").replace(/^data\//i, "");
    if (!clean) return null;
    const ext = clean.split(".").pop()?.toLowerCase() ?? "png";
    const mime = IMAGE_EXT_MIME[ext] ?? "image/png";
    const workspacePath = `/data/${clean}`;

    // 1. Try SiYuan Kernel /api/file/getFile
    try {
        const res = await fetch("/api/file/getFile", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: workspacePath }),
        });
        if (res.ok) {
            const contentType = res.headers.get("content-type") || "";
            if (!contentType.includes("application/json")) {
                const buf = await res.arrayBuffer();
                if (buf.byteLength > 0 && buf.byteLength <= 5 * 1024 * 1024) {
                    return `data:${mime};base64,${arrayBufferToBase64(buf)}`;
                }
            }
        }
    } catch {
        // fall through to direct /assets/ fetch
    }

    // 2. Fallback: SiYuan's root-relative static asset route (/assets/...)
    try {
        const res = await fetch(`/${clean}`);
        if (res.ok) {
            const contentType = res.headers.get("content-type") || "";
            if (!contentType.includes("text/html") && !contentType.includes("application/json")) {
                const buf = await res.arrayBuffer();
                if (buf.byteLength > 0 && buf.byteLength <= 5 * 1024 * 1024) {
                    return `data:${mime};base64,${arrayBufferToBase64(buf)}`;
                }
            }
        }
    } catch (err) {
        console.warn("[LearnHarness Vision] Failed to read asset image:", clean, err);
    }

    console.warn("[LearnHarness Vision] Could not load image bytes for:", clean);
    return null;
}

/** Resolve up to `maxImages` SiYuan asset paths into `{ path, dataUrl }` entries. */
export async function readSiyuanImages(
    assetPaths: readonly string[],
    maxImages = 12,
): Promise<Array<{ path: string; dataUrl: string }>> {
    const out: Array<{ path: string; dataUrl: string }> = [];
    for (const p of assetPaths.slice(0, maxImages)) {
        const dataUrl = await readSiyuanImageDataUrl(p);
        if (dataUrl) out.push({ path: p, dataUrl });
    }
    return out;
}

