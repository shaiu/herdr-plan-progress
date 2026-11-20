// Pure parsing for the plan-progress mod: no herdr, no I/O. Everything the
// panel shows is derived here from the plan text, the ledger text and the
// names of the files in the ledger folder, so node:test can feed it strings.

/** @typedef {'not started'|'implementing'|'in review'|'fixing'|'blocked'|'done'} Status */
/** @typedef {{ n: string, name: string, status: Status, round?: number, range?: string, last?: string,
 *   intent?: string, files: string[], history: string[], rulings: number, minors: number }} TaskRow */
/**
 * @typedef {{
 *   tasks: TaskRow[], done: number, total: number, current?: string,
 *   rulings: string[], minors: string[], finalReview: string[], other: string[],
 *   lastHead?: string,
 *   rulingInfo: (ReturnType<typeof parseRuling> & { during?: string })[],
 *   minorInfo: { task?: string, text: string }[],
 * }} Progress
 */

// A task id: `12`, `A1`, `N3`, `4b`. Kept as written (a string).
const ID = "([A-Za-z]{0,3}\\d+[a-z]?)";

/**
 * `### Task <id>: <name>` headings (any level from ## down), in plan order,
 * each with its body: the lines up to the next heading.
 */
export function parsePlan(plan) {
  const tasks = [], seen = new Set();
  let cur = null;
  for (const line of plan.split("\n")) {
    const m = new RegExp(`^#{2,4}\\s+Task\\s+${ID}\\s*:\\s*(.+?)\\s*$`).exec(line);
    if (m) {
      cur = seen.has(m[1]) ? null : { n: m[1], name: m[2] ?? "", body: [] };
      if (cur) { seen.add(m[1]); tasks.push(cur); }
    } else if (/^#{1,4}\s/.test(line)) cur = null;
    else if (cur) cur.body.push(line);
  }
  return tasks.map(({ n, name, body }) => ({ n, name, body: body.join("\n") }));
}

/**
 * What a task section says it is for, in one line, and the files it names.
 * `intent`: the planned commit message (`**Step 5: Commit** \`feat(x): does y\``),
 * its `type(scope):` prefix dropped; else the section's first sentence of prose.
 * `files`: the backticked paths in its `**Files:**` block, `:line` ranges dropped.
 */
export function taskDetails(body) {
  const text = body ?? "";
  const commits = [...text.matchAll(/Commit\*\*:?\s*`([^`]+)`/g)];
  let intent = commits.at(-1)?.[1]?.replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, "");
  if (!intent) {
    const prose = text.split("\n").map((l) => l.trim())
      .find((l) => l && !/^(\*\*Files|[-*] |[|>`]|\d+\.|---)/.test(l));
    intent = prose?.replace(/^\*\*[^*]+\*\*\s*(?=\S)/, "").replace(/\*\*/g, "").replace(/`/g, "").split(/(?<=\.)\s/)[0];
  }
  const files = [];
  const block = /\*\*Files:?\*\*:?([\s\S]*?)(?=\n\s*\n|\n\*\*(?!Files)|\n- \[ \]|$)/.exec(text)?.[1] ?? "";
  for (const m of block.matchAll(/`([^`\s]+\.[A-Za-z0-9]+)(?::[\d,-]+)?`/g)) {
    if (!files.includes(m[1])) files.push(m[1]);
  }
  return { intent: intent || undefined, files };
}

/** Classify the text after `Task N:`. */
export function classifyTaskLine(rest) {
  const t = rest.trim();
  let m;
  if (/^complete\b/i.test(t)) {
    const r = /commits\s+([0-9a-f]{4,40}\.\.[0-9a-f]{4,40})/i.exec(t);
    return { kind: "status", status: "done", range: r?.[1] };
  }
  if ((m = /^fix round\s+(\d+)/i.exec(t))) return { kind: "status", status: "fixing", round: Number(m[1]) };
  if (/^implementer\b/i.test(t)) {
    if (/\b(NEEDS_CONTEXT|BLOCKED)\b/.test(t)) return { kind: "status", status: "blocked" };
    if (/\bDONE(_WITH_CONCERNS)?\b/.test(t)) return { kind: "status", status: "in review" };
    return { kind: "unknown" };
  }
  if (/^BLOCKED\b|^NEEDS_CONTEXT\b/.test(t)) return { kind: "status", status: "blocked" };
  if (/^(re-)?dispatched\b/i.test(t)) return { kind: "status", status: "implementing" };
  if (/^review\b/i.test(t)) return { kind: "status", status: "in review" };
  if (/^minor\s*\(deferred\)/i.test(t)) return { kind: "minor" };
  // carried minors and notes: no status change, and not "other" either
  if (/^(minor|note)\b/i.test(t)) return { kind: "neutral" };
  return { kind: "unknown" };
}

/** Markdown structure and blank lines carry no progress. */
const isStructure = (line) => line === "" || line.startsWith("#") || line.startsWith("|");

/**
 * @param {string} planText
 * @param {string} ledgerText
 * @param {readonly string[]} files names in the ledger folder
 * @returns {Progress}
 */
export function deriveProgress(planText, ledgerText, files) {
  const plan = parsePlan(planText);
  const byTask = new Map(), history = new Map(), rulingAt = [];
  const rulings = [], minors = [], finalReview = [], other = [];
  let lastActive, lastHead;

  for (const raw of ledgerText.split("\n")) {
    const line = raw.trim().replace(/^[-*]\s+/, ""); // a bulleted ledger reads the same
    if (isStructure(line)) continue;
    try {
      // `Task 7: …`, or the short form `T7 …` / `T7: …`
      const task = new RegExp(`^Task\\s+${ID}\\s*:\\s*(.*)$`, "i").exec(line)
        ?? /^T(\d+[a-z]?)(?::\s*|\s+)(.*)$/.exec(line);
      if (task) {
        const n = task[1];
        const ev = classifyTaskLine(task[2] ?? "");
        history.set(n, [...(history.get(n) ?? []), (task[2] ?? "").trim()]);
        if (ev.kind === "status") {
          byTask.set(n, { ...ev, line });
          lastActive = n;
          if (ev.range) lastHead = ev.range.split("..")[1];
        } else if (ev.kind === "minor") minors.push(line);
        else if (ev.kind === "unknown") other.push(line);
        continue;
      }
      if (/^Ruling\b[^:]{0,40}:/i.test(line)) { rulings.push(line); rulingAt.push(lastActive); }
      else if (/final review/i.test(line)) finalReview.push(line);
      else other.push(line);
    } catch {
      other.push(line);
    }
  }

  const fileSet = new Set(files);
  // A ruling belongs to the tasks it names; else to the task that was active
  // when it was written (none: before any task, the pre-flight).
  const ids = plan.map((t) => t.n);
  const rulingInfo = rulings.map((line, i) => {
    const r = parseRuling(line, ids);
    return { ...r, during: rulingAt[i], tasks: r.tasks.length ? r.tasks : rulingAt[i] ? [rulingAt[i]] : [] };
  });
  const minorInfo = minors.map(parseMinor);

  const tasks = plan.map(({ n, name, body }) => {
    const ev = byTask.get(n);
    const base = {
      n, name, ...taskDetails(body), history: history.get(n) ?? [],
      rulings: rulingInfo.filter((r) => r.tasks.includes(n)).length,
      minors: minorInfo.filter((m) => m.task === n).length,
    };
    if (ev) return { ...base, status: ev.status, round: ev.round, range: ev.range, last: ev.line };
    if (fileSet.has(`task-${n}-report.md`)) return { ...base, status: "in review" };
    if (fileSet.has(`task-${n}-brief.md`)) return { ...base, status: "implementing" };
    return { ...base, status: "not started" };
  });

  const done = tasks.filter((t) => t.status === "done").length;
  const open = tasks.filter((t) => t.status !== "done" && t.status !== "not started");
  const current =
    lastActive !== undefined && byTask.get(lastActive)?.status !== "done"
      ? lastActive
      : (open[0]?.n ?? tasks.find((t) => t.status !== "done")?.n);

  return {
    tasks, done, total: tasks.length,
    current: done === tasks.length ? undefined : current,
    rulings, minors, finalReview, other, lastHead, rulingInfo, minorInfo,
  };
}

/** "just now", "2 min ago", "3 h ago", "2 d ago". */
export function ago(fromMs, nowMs) {
  const s = Math.max(0, Math.round((nowMs - fromMs) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** `<worktree>/.superpowers/sdd/<plan basename without .md>` */
export function ledgerDir(worktree, planPath) {
  const base = (planPath.split("/").pop() ?? "").replace(/\.md$/, "");
  return `${worktree.replace(/\/$/, "")}/.superpowers/sdd/${base}`;
}

/**
 * The plan a ledger folder belongs to: its `plan-path` file (relative to the
 * worktree, or absolute), else `docs/superpowers/plans/<folder name>.md`.
 */
export function planFor(worktree, ledgerFolder, planPathText) {
  const wt = worktree.replace(/\/$/, "");
  const given = (planPathText ?? "").trim().split("\n")[0]?.trim();
  if (given) return given.startsWith("/") ? given : `${wt}/${given}`;
  const name = ledgerFolder.replace(/\/$/, "").split("/").pop();
  return `${wt}/docs/superpowers/plans/${name}.md`;
}

/** The last `"cwd":"…"` in a piece of a Claude Code transcript (JSON lines), or undefined. */
export function lastCwd(text) {
  let last;
  for (const m of (text ?? "").matchAll(/"cwd":"((?:[^"\\]|\\.)*)"/g)) last = m[1];
  if (last === undefined) return undefined;
  try { return JSON.parse(`"${last}"`); } catch { return undefined; }
}

/**
 * A ruling line split for reading at a glance:
 * `Ruling R5 (for T2/T3): <decision> — why: <why> — cost if wrong: <cost>`.
 * `tasks`: the task ids it names (in its scope, or "carried to Task N"),
 * kept only when the plan has that id, so "Important 1" is not Task 1.
 * @param {string} line
 * @param {readonly string[]} ids the plan's task ids
 */
export function parseRuling(line, ids = []) {
  const m = /^Ruling\b\s*(R\d+[a-z]*)?\s*(?:\(([^)]*)\))?\s*:\s*([\s\S]*)$/i.exec(line.trim());
  if (!m) return { decision: line.trim(), tasks: [], text: line.trim() };
  const [, id, scope = "", body = ""] = m;
  const known = new Set(ids), tasks = [];
  const add = (t) => { if (known.has(t) && !tasks.includes(t)) tasks.push(t); };
  for (const c of scope.matchAll(/\b(?:T|Task\s+)(\d+[a-z]?)\b/g)) add(c[1]);
  for (const c of scope.matchAll(/\b([A-Z]\d+[a-z]?)\b/g)) add(c[1]);
  for (const c of body.matchAll(/[Cc]arried to Tasks?\s+([\dA-Z][\w]*(?:\s*(?:,|and|\/)\s*[\dA-Z][\w]*)*)/g)) {
    for (const t of c[1].split(/\s*(?:,|and|\/)\s*/)) add(t);
  }
  let decision = "", why, cost;
  for (const part of body.split(/\s+[—–]\s+|\s+--\s+/)) {
    const p = part.trim();
    if (!p) continue;
    if (/^why:/i.test(p)) why = p.replace(/^why:\s*/i, "");
    else if (/^(cost|risk) if wrong:|^risk:/i.test(p)) cost = p.replace(/^(cost|risk) if wrong:\s*|^risk:\s*/i, "");
    else if (!decision) decision = p;
    else if (why === undefined && cost === undefined) why = p; // an unlabelled reason right after the decision
    else decision += ` — ${p}`;
  }
  return { id, scope: scope || undefined, tasks, decision: decision || body.trim(), why, cost, text: line.trim() };
}

/** `Task N: minor (deferred): <text>` → `{ task, text }`; anything else → `{ text }`. */
export function parseMinor(line) {
  const m = /^(?:Task\s+|T)([A-Za-z]{0,3}\d+[a-z]?)\s*:?\s*minor\s*\(deferred\)\s*:?\s*([\s\S]*)$/i.exec(line.trim());
  return m ? { task: m[1], text: m[2].trim() } : { text: line.trim() };
}

// ---- Ruling summaries (written by a small model, cached by ruling text) ----

/** A short stable key for a text: FNV-1a, 32 bits, hex. */
export function textKey(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export const SUMMARY_SYSTEM =
  "You summarize decisions ('rulings') that an AI coding agent made on its own while executing an " +
  "implementation plan, for the human who must check them. Plain English, short sentences, common words. " +
  "Reply with one JSON object and nothing else.";

/**
 * The prompt for one call: every ruling (for the overview), and which of them
 * still need their own line.
 * @param {{ key: string, label: string, text: string }[]} rulings
 * @param {readonly string[]} need keys that have no cached line yet
 */
export function summaryPrompt(rulings, need) {
  const list = rulings.map((r) => `[${r.key}] (${r.label}) ${r.text}`).join("\n");
  return [
    "Rulings, oldest first. Each is: decision — why — cost if wrong.",
    list,
    "",
    `NEED: ${need.length ? need.join(", ") : "(none)"}`,
    "",
    "For each key in NEED, write:",
    '- "line": what the agent decided and what it changes, at most 14 words, no code names unless essential.',
    '- "risk": "high", "medium" or "low", judged from its cost if wrong. high: a security hole, data loss,',
    "  a production outage, or a failure nobody would notice. medium: a visible failure or an extra manual step.",
    "  low: little or no harm.",
    'Then "overview": 2 to 4 short sentences for the whole list: what kinds of decisions the agent made,',
    "and which ones the human should check first. Name rulings only by their label (like R5 or T6), never by the bracketed key.",
    "",
    'JSON shape: {"rulings":{"<key>":{"line":"...","risk":"high|medium|low"}},"overview":["..."]}',
  ].join("\n");
}

/** Reads the model's reply; anything malformed is dropped, never thrown. */
export function parseSummaryReply(text) {
  const out = { rulings: {}, overview: [] };
  const start = (text ?? "").indexOf("{"), end = (text ?? "").lastIndexOf("}");
  if (start < 0 || end <= start) return out;
  let data;
  try { data = JSON.parse(text.slice(start, end + 1)); } catch { return out; }
  for (const [key, v] of Object.entries(data?.rulings ?? {})) {
    if (!/^[0-9a-f]{8}$/.test(key) || typeof v?.line !== "string" || !v.line.trim()) continue;
    const risk = ["high", "medium", "low"].includes(v.risk) ? v.risk : undefined;
    out.rulings[key] = { line: v.line.trim(), risk };
  }
  if (Array.isArray(data?.overview)) out.overview = data.overview.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim());
  return out;
}

/** Puts labels in place of any bracketed-or-bare cache key the model named. */
export function labelKeys(text, labels) {
  return text.replace(/\[?\b([0-9a-f]{8})\b\]?/g, (m, key) => labels[key] ?? m);
}
