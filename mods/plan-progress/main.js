import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, hc, home, appHome, writeTextFile, readTextFile, watchFolder, theme, props, checking, spaces, panes, focused, layout, run as runCommand } from "herdr";
import { ago, deriveProgress, labelKeys, lastCwd, ledgerDir, parseSummaryReply, planFor, SUMMARY_SYSTEM, summaryPrompt, textKey } from "./parse.js";

// Live, read-only view of a subagent-driven-development plan's ledger.
// Reads the plan, the ledger folder and `git log`; never writes anything.
//
// Which plan: the focused agent's worktree. Herdr knows the folder a terminal
// started in; a Claude Code agent often works elsewhere (a worktree it entered),
// so for one its real folder is the last `cwd` in its transcript.
// Then that worktree's Its `.superpowers/sdd/*/progress.md`
// (the most recently changed, when there are several) and the plan named in
// that folder's `plan-path`. A pane opened with `props.plan` stays pinned to it.

const TICK_MS = 30_000; // "updated N ago", the latest commit, a ledger appearing
// A ledger untouched this long is a finished or abandoned plan, not this agent's work.
const STALE_MS = 24 * 3600_000;
const POLL_MS = 5_000;
// Ruling summaries: Haiku through `claude -p`, cached by ruling text in one
// file, so only rulings never seen before cost a call. A failed call waits.
const SUMMARY_RETRY_MS = 10 * 60_000;
const summaryCache = () => `${appHome()}/plan-progress-summaries.json`; // only when the folder watch can't run (remote, or it failed)

const MARK = {
  "not started": "·", implementing: "▶", "in review": "◎", fixing: "✎", blocked: "■", done: "✓",
};

function statusColor(t, status) {
  return {
    "not started": t.dim, implementing: t.working, "in review": t.ansi4,
    fixing: t.ansi3, blocked: t.blocked, done: t.ansi2,
  }[status] ?? t.foreground;
}

// Where the person is looking: the focused pane's folder and machine (as the
// shipped Changes panel reads it), or the pinned plan.
function location() {
  const pinned = props()?.plan;
  if (typeof pinned === "string" && pinned) return { pinned, on: null };
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, terminal: f?.terminal ?? null };
}

// Where a terminal's foreground program really works, read-only: `hc get` for
// its pid, ~/.claude/sessions/<pid>.json for a Claude Code session id, then the
// last cwd in that session's transcript. Undefined when any step is missing.
async function agentCwd(terminal) {
  if (!terminal || terminal.includes("/")) return undefined; // another machine: its folder as Herdr reports it
  try {
    const r = await hc(["get", terminal]);
    if (r.code !== 0) return undefined;
    const info = JSON.parse(r.stdout), fg = info.foreground;
    if (!fg?.pid) return undefined;
    if (info.status?.app !== "claude-code") return fg.cwd || undefined;
    const session = JSON.parse((await readTextFile(`${home()}/.claude/sessions/${fg.pid}.json`)) ?? "{}");
    if (!/^[0-9a-f-]{36}$/.test(session.sessionId ?? "")) return session.cwd || fg.cwd || undefined;
    const transcript = await run("sh", ["-c", 'ls "$1"/.claude/projects/*/"$2".jsonl 2>/dev/null | head -1', "sh", home(), session.sessionId]);
    const tail = transcript ? await run("tail", ["-c", "262144", transcript]) : undefined;
    return lastCwd(tail) || session.cwd || fg.cwd || undefined;
  } catch { return undefined; }
}
const key = () => JSON.stringify(location());

// This copy's own block in the shown layout: a block whose content is this mod
// without a pinned plan. Undefined for a pane copy (pinned or split by hand).
function ownBlock(node = layout()) {
  if (!node || typeof node !== "object") return undefined;
  const c = node.content;
  if (node.type === "block" && c?.mod === "plan-progress" && !c?.props?.plan) return node;
  for (const child of [...(node.children ?? []), ...(node.floating ?? [])]) {
    const found = ownBlock(child);
    if (found) return found;
  }
  return undefined;
}

// The column shows only while the focused agent has a plan. A pinned or pane
// copy is never hidden: someone opened it on purpose.
function setShown(show) {
  if (props()?.plan) return;
  const block = ownBlock();
  if (!block?.id || Boolean(block.hidden) === !show) return;
  runCommand(show ? "layout.show" : "layout.hide", { id: block.id });
}

async function run(cmd, args, on) {
  try {
    const r = await exec(cmd, args, { on, timeout: 10_000 });
    return r.code === 0 ? r.stdout.trim() : undefined;
  } catch { return undefined; }
}

async function mtimeMs(path, on) {
  const s = (await run("stat", ["-f", "%m", path], on)) ?? (await run("stat", ["-c", "%Y", path], on));
  return s ? Number(s) * 1000 : undefined;
}

// The worktree and the ledger folder to show for a location, or why there is none.
async function resolve(loc) {
  const { on } = loc;
  if (loc.pinned) {
    const planDir = loc.pinned.slice(0, loc.pinned.lastIndexOf("/")) || "/";
    const wt = await run("git", ["-C", planDir, "rev-parse", "--show-toplevel"], on);
    if (!wt) return { none: `Not inside a git worktree: ${planDir}` };
    return { wt, plan: loc.pinned, dir: ledgerDir(wt, loc.pinned) };
  }
  const cwd = (await agentCwd(loc.terminal)) || loc.cwd;
  if (!cwd) return { none: "No focused folder" };
  const wt = await run("git", ["-C", cwd, "rev-parse", "--show-toplevel"], on);
  if (!wt) return { none: "Not in a git worktree", folder: cwd };
  // newest progress.md under .superpowers/sdd/*/ (ls -t, no writes)
  const newest = await run("sh", ["-c", 'ls -t "$1"/.superpowers/sdd/*/progress.md 2>/dev/null | head -1', "sh", wt], on);
  if (!newest) return { none: "No SDD plan in this worktree", folder: wt };
  const dir = newest.replace(/\/progress\.md$/, "");
  const changed = await mtimeMs(newest, on);
  if (changed && Date.now() - changed > STALE_MS) {
    return { none: "No active SDD plan in this worktree", folder: `newest: ${dir.split("/").pop()} · ${ago(changed, Date.now())}` };
  }
  const plan = planFor(wt, dir, await readTextFile(`${dir}/plan-path`, { on }).catch(() => null));
  return { wt, plan, dir, from: cwd };
}

export default class PlanProgress extends View {
  init(_props, cx) {
    this.snap = null;
    this.none = null;
    this.open = new Set();
    this.openTasks = new Set();
    this.openItems = new Set();
    this.watching = false;
    this.busy = false;
    if (checking()) return;
    this.refresh(cx, true);
    cx.timer.every(TICK_MS, (cx) => this.refresh(cx));
    cx.timer.every(POLL_MS, (cx) => { if (!this.watching && this.snap) this.refresh(cx, true); });
    // A hidden block may not be redrawn on a focus change, so notice it here:
    // a string comparison, no reads, unless the focus really moved.
    cx.timer.every(1000, (cx) => { if (key() !== this.context) this.refresh(cx, true); });
  }

  watch(dir, on, cx) {
    if (this.dir === dir) return;
    this.stopWatch();
    this.dir = dir;
    if (on) return; // watchFolder is local only: the 5 s poll covers a remote space
    cx.spawn(async (cx) => {
      try {
        while (this.dir === dir) {
          this.watching = true;
          this.watch_ = watchFolder(dir);
          const changed = await this.watch_;
          if (this.dir === dir && changed.length) this.refresh(cx, true);
        }
      } catch {
        if (this.dir === dir) { this.watching = false; cx.notify(); } // the poll takes over
      }
    });
  }

  // Summaries for this ledger's rulings: cached ones at once; one background
  // call for any ruling or overview the cache lacks. Never two calls at once.
  summarize(cx) {
    const s = this.snap;
    if (!s || !s.rulingInfo.length || this.summarizing) return;
    if (this.summaryFailedAt && Date.now() - this.summaryFailedAt < SUMMARY_RETRY_MS) return;
    const items = s.rulingInfo.map((r) => ({
      key: textKey(r.text), text: r.text,
      label: [r.id, ...r.tasks.map((n) => `T${n}`)].filter(Boolean).join(", ") || "pre-flight",
    }));
    const setKey = textKey(items.map((i) => i.key).join(""));
    this.summarizing = true;
    cx.spawn(async (cx) => {
      try {
        const raw = await readTextFile(summaryCache());
        let cache = { rulings: {}, overviews: {} };
        try { cache = { ...cache, ...JSON.parse(raw ?? "{}") }; } catch { /* rebuilt below */ }
        const need = items.filter((i) => !cache.rulings[i.key]).map((i) => i.key);
        const labels = Object.fromEntries(items.map((i) => [i.key, i.label]));
        this.summary = { rulings: cache.rulings, overview: cache.overviews[setKey], labels };
        cx.notify();
        if (!need.length && cache.overviews[setKey]) return;

        this.summary.pending = true;
        cx.notify();
        const r = await exec("claude", [
          "-p", summaryPrompt(items, need), "--model", "haiku", "--tools", "",
          "--no-session-persistence", "--strict-mcp-config", "--disable-slash-commands",
          "--setting-sources", "", "--system-prompt", SUMMARY_SYSTEM, "--output-format", "json",
        ], { cwd: home(), timeout: 180_000 });
        if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || `claude exited ${r.code}`);
        const reply = parseSummaryReply(JSON.parse(r.stdout).result);
        if (!reply.overview.length && !Object.keys(reply.rulings).length) throw new Error("the summary came back empty");

        // re-read before writing: another copy may have written meanwhile
        const latest = await readTextFile(summaryCache());
        let merged = { rulings: {}, overviews: {} };
        try { merged = { ...merged, ...JSON.parse(latest ?? "{}") }; } catch { /* start over */ }
        merged.rulings = { ...merged.rulings, ...reply.rulings };
        if (reply.overview.length) merged.overviews = { ...merged.overviews, [setKey]: reply.overview.map((o) => labelKeys(o, labels)) };
        await writeTextFile(summaryCache(), JSON.stringify(merged), latest);
        this.summary = { rulings: merged.rulings, overview: merged.overviews[setKey], labels };
        this.summaryFailedAt = null;
      } catch (err) {
        this.summaryFailedAt = Date.now();
        this.summary = { ...(this.summary ?? { rulings: {} }), pending: false, error: String(err?.message ?? err).slice(0, 160) };
      } finally {
        this.summarizing = false;
        cx.notify();
      }
    });
  }

  stopWatch() {
    this.dir = null;
    this.watching = false;
    this.watch_?.cancel();
  }

  // `full`: re-read the plan and ledger; otherwise only the commit and the clock.
  refresh(cx, full = false) {
    if (this.busy) { this.again ||= full; return; } // re-run once the current read ends
    this.busy = true;
    const context = key(), loc = location();
    if (context !== this.context) {
      this.context = context;
      full = true;
      this.snap = null; this.none = null;
      this.stopWatch();
    }
    cx.spawn(async (cx) => {
      try {
        const found = await resolve(loc);
        if (key() !== context) return; // focus moved on while reading
        if (found.none) {
          this.snap = null; this.none = found; this.stopWatch();
          setShown(false);
          return;
        }
        const { wt, plan, dir } = found, { on } = loc;
        const ledger = `${dir}/progress.md`;
        const line = await run("git", ["-C", wt, "log", "-1", "--format=%h%x09%s%x09%ct"], on);
        const [sha, subject, ct] = (line ?? "").split("\t");
        const commit = sha ? { sha, subject: subject ?? "", at: Number(ct) * 1000 } : undefined;

        if (full || !this.snap || this.snap.plan !== plan) {
          const names = ((await run("ls", ["-1", dir], on)) ?? "").split("\n").filter(Boolean);
          const planText = (await readTextFile(plan, { on }).catch(() => null)) ?? "";
          const ledgerText = names.includes("progress.md") ? ((await readTextFile(ledger, { on }).catch(() => null)) ?? "") : "";
          const progress = deriveProgress(planText, ledgerText, names);
          const since = progress.lastHead
            ? await run("git", ["-C", wt, "rev-list", "--count", `${progress.lastHead}..HEAD`], on)
            : undefined;
          if (key() !== context) return;
          this.snap = {
            ...progress, plan, ledger, wt, from: found.from, missingPlan: !planText,
            ledgerMtime: names.includes("progress.md") ? await mtimeMs(ledger, on) : undefined,
            sinceHead: since === undefined ? undefined : Number(since),
          };
          if (names.length) this.watch(dir, on, cx);
          this.summarize(cx);
        }
        this.snap.commit = commit;
        this.none = null;
        setShown(true);
      } catch (err) {
        if (key() === context) { this.snap = null; this.none = { none: err?.message ?? String(err) }; }
      } finally {
        this.busy = false;
        cx.notify();
        if (this.again) { this.again = false; this.refresh(cx, true); }
      }
    });
  }

  async close() {
    this.stopWatch();
  }

  // How many rulings / minors of this ledger the person has seen (per mod copy).
  seenGet(ledger) {
    try { return JSON.parse(localStorage.getItem(`seen:${ledger}`) ?? "{}"); } catch { return {}; }
  }
  seenSet(ledger, value) {
    try { localStorage.setItem(`seen:${ledger}`, JSON.stringify(value)); } catch { /* not kept: fine */ }
  }

  // A section of one-line items. Opening it marks its items seen; the ones
  // added since the last opening keep a dot while it stays open.
  itemSection(t, s, key, label, items, renderItem) {
    const isOpen = this.open.has(key);
    const seen = this.seenGet(s.ledger)[key] ?? 0;
    const fresh = Math.max(0, items.length - seen);
    const newFrom = this.newFrom?.[`${s.ledger}:${key}`] ?? items.length;
    return v_flex().gap(3).child(
      h_flex().id(`sec-${key}`).gap(6).cursor_pointer().hover((st) => st.text_color(t.foreground))
        .text_color(t.muted)
        .on_click((_e, cx) => {
          if (isOpen) this.open.delete(key);
          else {
            this.open.add(key);
            this.newFrom = { ...this.newFrom, [`${s.ledger}:${key}`]: seen };
            this.seenSet(s.ledger, { ...this.seenGet(s.ledger), [key]: items.length });
          }
          cx.notify();
        })
        .child(isOpen ? "▾" : "▸").child(label)
        .child(div().text_color(t.dim).child(`(${items.length})`))
        .when(!isOpen && fresh > 0, (el) => el.child(div().text_color(t.accent).child(`${fresh} new`))),
    ).when(isOpen, (el) => el.children(items.map((item, i) => renderItem(item, i, i >= newFrom))));
  }

  chip(t, text, color) {
    return div().px(4).rounded(3).bg(t.raised).text_size(11).text_color(color ?? t.muted).child(text);
  }

  // One ruling: its id and tasks, the decision on one line, "if wrong" under it.
  // A click shows the whole of it.
  riskColor(t, risk) {
    return { high: t.blocked, medium: t.ansi3, low: t.dim }[risk] ?? t.dim;
  }

  rulingRow(t, r, key, isNew) {
    const isOpen = this.openItems.has(key);
    const sum = this.summary?.rulings?.[textKey(r.text)];
    return h_flex().id(key).gap(6).items_start().pl(10).py(2).rounded(4).cursor_pointer()
      .hover((st) => st.bg(t.hover))
      .on_click((_e, cx) => { isOpen ? this.openItems.delete(key) : this.openItems.add(key); cx.notify(); })
      .child(div().w(6).text_color(t.accent).child(isNew ? "•" : ""))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(h_flex().gap(4).min_w(0)
          .when(Boolean(r.id), (el) => el.child(this.chip(t, r.id, t.foreground)))
          .children((r.tasks.length ? r.tasks : ["pre-flight"]).map((n) => this.chip(t, n === "pre-flight" ? n : `T${n}`)))
          .when(Boolean(sum?.risk), (el) => el.child(this.chip(t, sum.risk, this.riskColor(t, sum.risk))))
          .child(div().flex_1().min_w(0).when(!isOpen, (d) => d.truncate()).child(sum?.line ?? r.decision)))
        .when(!isOpen && !sum && Boolean(r.cost), (el) => el.child(div().text_color(t.dim).truncate().child(`if wrong: ${r.cost}`)))
        .when(isOpen && Boolean(sum), (el) => el.child(div().text_color(t.foreground).child(r.decision)))
        .when(isOpen && Boolean(r.why), (el) => el.child(div().text_color(t.muted).child(`why: ${r.why}`)))
        .when(isOpen && Boolean(r.cost), (el) => el.child(div().text_color(t.ansi3).child(`if wrong: ${r.cost}`)))
        .when(isOpen && Boolean(r.scope) && !r.tasks.length, (el) => el.child(div().text_color(t.dim).child(`(${r.scope})`))));
  }

  highRisk(s, n) {
    return s.rulingInfo.filter((r) => r.tasks.includes(n) && this.summary?.rulings?.[textKey(r.text)]?.risk === "high").length;
  }

  // "Rulings in brief": the model's overview of every ruling, and the count by risk.
  overview(t) {
    const sum = this.summary, s = this.snap;
    const risks = { high: 0, medium: 0, low: 0 };
    for (const r of s.rulingInfo) { const k = sum?.rulings?.[textKey(r.text)]?.risk; if (k) risks[k]++; }
    const box = v_flex().gap(3).p(8).rounded(6).bg(t.raised)
      .child(h_flex().gap(8).items_center()
        .child(div().font_semibold().child("Rulings in brief"))
        .when(risks.high > 0, (el) => el.child(div().text_color(t.blocked).child(`${risks.high} high`)))
        .when(risks.medium > 0, (el) => el.child(div().text_color(t.ansi3).child(`${risks.medium} medium`)))
        .when(risks.low > 0, (el) => el.child(div().text_color(t.dim).child(`${risks.low} low`))));
    if (sum?.overview?.length) return box.children(sum.overview.map((line) => div().text_color(t.muted).child(line)))
      .when(Boolean(sum.pending), (el) => el.child(div().text_color(t.dim).child("updating for the new rulings…")));
    if (sum?.error) return box.child(div().text_color(t.dim).child(`No summary yet (${sum.error}). Trying again in 10 min.`));
    return box.child(div().text_color(t.dim).child("Summarizing the rulings…"));
  }

  minorRow(t, m, key, isNew) {
    const isOpen = this.openItems.has(key);
    return h_flex().id(key).gap(6).items_start().pl(10).py(1).rounded(4).cursor_pointer()
      .hover((st) => st.bg(t.hover))
      .on_click((_e, cx) => { isOpen ? this.openItems.delete(key) : this.openItems.add(key); cx.notify(); })
      .child(div().w(6).text_color(t.accent).child(isNew ? "•" : ""))
      .when(Boolean(m.task), (el) => el.child(this.chip(t, `T${m.task}`)))
      .child(div().flex_1().min_w(0).text_color(t.muted).when(!isOpen, (d) => d.truncate()).child(m.text));
  }

  section(t, key, label, lines) {
    const isOpen = this.open.has(key);
    return v_flex().gap(2).child(
      h_flex().id(`sec-${key}`).gap(6).cursor_pointer().hover((s) => s.text_color(t.foreground))
        .text_color(t.muted)
        .on_click((_e, cx) => { isOpen ? this.open.delete(key) : this.open.add(key); cx.notify(); })
        .child(isOpen ? "▾" : "▸").child(label).child(div().text_color(t.dim).child(`(${lines.length})`)),
    ).when(isOpen, (el) => el.children(lines.map((l) => div().pl(14).text_color(t.dim).child(l))));
  }

  render(cx) {
    if (!checking() && key() !== this.context) this.refresh(cx, true);
    const t = theme();
    const root = v_flex().id("plan-progress").size_full().bg(t.surface).p(12).gap(8)
      .text_size(12.5).text_color(t.foreground).overflow_y_scrollbar();

    const s = this.snap;
    if (!s) {
      if (this.none) {
        return root.child(div().text_color(t.muted).child(this.none.none))
          .when(Boolean(this.none.folder), (el) => el.child(div().text_color(t.dim).truncate().child(this.none.folder)));
      }
      return root.child(div().text_color(t.dim).child(checking() ? "Plan progress" : "Reading the ledger…"));
    }

    const now = Date.now();
    const planName = (s.plan.split("/").pop() ?? "").replace(/\.md$/, "");
    const cur = s.tasks.find((x) => x.n === s.current);

    const header = v_flex().gap(2)
      .child(h_flex().gap(8).items_center()
        .child(div().font_semibold().text_size(14).child(`${s.done} of ${s.total} done`))
        .child(div().text_color(t.dim).child(
          `updated ${s.ledgerMtime ? ago(s.ledgerMtime, now) : "never"}${this.watching ? "" : " · polling"}`)))
      .child(div().text_color(t.dim).truncate().child(`${s.wt.split("/").pop()} · ${planName}`))
      .when(Boolean(s.missingPlan), (el) => el.child(div().text_color(t.blocked).truncate().child(`Plan file not found: ${s.plan}`)))
      .when(Boolean(cur), (el) => el.child(h_flex().gap(4)
        .child(div().text_color(t.muted).child("Now"))
        .child(div().font_semibold().child(`Task ${cur.n}`))
        .child(div().text_color(statusColor(t, cur.status)).child(
          cur.status === "fixing" ? `fixing ${cur.round}/5` : cur.status))
        .when(Boolean(s.sinceHead), (el) => el.child(div().text_color(t.dim).child(
          `· ${s.sinceHead} commit${s.sinceHead === 1 ? "" : "s"} since ${s.lastHead}`)))))
      .when(Boolean(s.commit), (el) => el.child(div().text_color(t.dim).truncate().child(
        `${s.commit.sha} ${s.commit.subject} · ${ago(s.commit.at, now)}`)));

    // One row per task: name, what it is for (the planned commit), status.
    // A click opens the files it touches and its ledger lines.
    const rows = v_flex().gap(4).children(s.tasks.map((x) => {
      const color = statusColor(t, x.status), isOpen = this.openTasks.has(x.n);
      const label = (text) => div().text_color(t.muted).text_size(11).child(text);
      return h_flex().id(`task-${x.n}`).gap(6).items_start().px(4).py(2).rounded(4).cursor_pointer()
        .when(x.n === s.current, (el) => el.bg(t.selected))
        .hover((st) => st.bg(t.hover))
        .on_click((_e, cx) => { isOpen ? this.openTasks.delete(x.n) : this.openTasks.add(x.n); cx.notify(); })
        .child(div().w(12).text_color(color).child(MARK[x.status]))
        .child(div().w(22).text_color(t.dim).child(x.n))
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(div().when(!isOpen, (el) => el.truncate()).when(x.n === s.current, (el) => el.font_semibold()).child(x.name))
          .when(Boolean(x.intent), (el) => el.child(div().text_color(t.muted).when(!isOpen, (d) => d.truncate()).child(x.intent)))
          .child(h_flex().gap(6)
            .child(div().text_color(color).child(x.status === "fixing" ? `fixing ${x.round}/5` : x.status))
            .when(Boolean(x.range), (el) => el.child(div().text_color(t.dim).child(x.range)))
            .when(x.rulings > 0, (el) => el.child(div().text_color(t.dim).child(`${x.rulings} ruling${x.rulings === 1 ? "" : "s"}`)))
            .when(this.highRisk(s, x.n) > 0, (el) => el.child(div().text_color(t.blocked).child(`${this.highRisk(s, x.n)} high-risk`)))
            .when(x.minors > 0, (el) => el.child(div().text_color(t.dim).child(`${x.minors} minor${x.minors === 1 ? "" : "s"}`)))
            .when(!isOpen && (x.files.length > 0 || x.history.length > 0), (el) => el.child(div().text_color(t.dim).child("▸"))))
          .when(isOpen && x.rulings > 0, (el) => el.child(v_flex().pt(4).gap(1)
            .child(label(`Rulings (${x.rulings})`))
            .children(s.rulingInfo.map((r, i) => [r, i]).filter(([r]) => r.tasks.includes(x.n))
              .map(([r, i]) => this.rulingRow(t, r, `tr-${x.n}-${i}`, false)))))
          .when(isOpen && x.files.length > 0, (el) => el.child(v_flex().pt(4)
            .child(label(`Files (${x.files.length})`))
            .children(x.files.map((f) => {
              const cut = f.lastIndexOf("/");
              return h_flex().min_w(0).child(div().text_color(t.foreground).child(f.slice(cut + 1)))
                .child(div().pl(6).text_color(t.dim).truncate().child(cut > 0 ? f.slice(0, cut) : ""));
            }))))
          .when(isOpen && x.history.length > 0, (el) => el.child(v_flex().pt(4).gap(1)
            .child(label(`Ledger (${x.history.length})`))
            .children(x.history.map((h) => div().text_color(t.dim).child(h)))))
          .when(isOpen && x.files.length === 0 && x.history.length === 0, (el) => el.child(
            div().pt(4).text_color(t.dim).child("Nothing more in the plan or ledger yet."))));
    }));

    const sections = v_flex().gap(4)
      .when(s.rulingInfo.length > 0, (el) => el.child(this.overview(t)))
      .child(this.itemSection(t, s, "rulings", "Rulings", s.rulingInfo,
        (r, i, isNew) => this.rulingRow(t, r, `r-${i}`, isNew)))
      .child(this.itemSection(t, s, "minors", "Deferred minors", s.minorInfo,
        (m, i, isNew) => this.minorRow(t, m, `m-${i}`, isNew)))
      .when(s.done === s.total || s.finalReview.length > 0, (el) => el.child(this.section(
        t, "final", s.finalReview.length ? "Final review" : "Final review — not started", s.finalReview)))
      .when(s.other.length > 0, (el) => el.child(this.section(t, "other", "Other lines", s.other)));

    return root.child(header).child(div().h(1).bg(t.border)).child(rows)
      .child(div().h(1).bg(t.border)).child(sections);
  }
}
