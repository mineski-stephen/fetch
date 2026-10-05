/*
 * The brief model: one JSON shape (schema v1) shared by the proxy, the page,
 * the PDF, the chat text and the Lark row. Everything here is pure functions.
 */
(function (BX) {
  "use strict";

  const NS = "Not specified";
  const BUDGET_TYPES = ["ALL-IN", "BASELINE / BALLPARK", "TO BE CONFIRMED", "NOT SPECIFIED"];
  const SUBMISSION_TYPES = ["PAPER PASS ONLY", "PITCH / PRESENTATION", "NOT SPECIFIED"];
  const LABELS = {
    "ALL-IN": "All-in", "BASELINE / BALLPARK": "Baseline / Ballpark", "TO BE CONFIRMED": "To be confirmed",
    "NOT SPECIFIED": "Not specified", "PAPER PASS ONLY": "Paper pass only",
    "PITCH / PRESENTATION": "Pitch / Presentation",
  };
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  const isMissing = (v) => v == null || !String(v).trim() || String(v).trim().toLowerCase() === "not specified";
  const str = (v, fb = NS) => (isMissing(v) ? fb : String(v).trim());
  const list = (v) => (Array.isArray(v) ? v : v ? [v] : []).map((x) => String(x ?? "").trim()).filter((x) => x && !isMissing(x));
  const pairs = (v, a, b) => (Array.isArray(v) ? v : [])
    .map((x) => (x && typeof x === "object" ? { [a]: str(x[a], ""), [b]: str(x[b], "") } : { [a]: "", [b]: str(x, "") }))
    .filter((x) => x[a] || x[b]);
  const pick = (v, allowed) => (allowed.includes(String(v || "").toUpperCase()) ? String(v).toUpperCase() : allowed[allowed.length - 1]);

  function todayISO(d = new Date()) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function validISO(v) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || "").slice(0, 10));
    if (!m) return "";
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    return d.getMonth() === +m[2] - 1 ? m[0] : "";
  }

  /** Coerce anything (proxy output, a Lark row, an older version) into schema v1. */
  function normalize(raw) {
    raw = raw && typeof raw === "object" ? raw : {};
    const budget = raw.budget || {}, sub = raw.proposal_submission || {}, due = raw.due_date || {};
    const dueDate = validISO(due.date);
    return {
      schema_version: 1,
      date_filed: validISO(raw.date_filed) || todayISO(),
      due_date: { date: dueDate, note: str(due.note, dueDate ? "" : NS) },
      client_name: str(raw.client_name),
      project_title: str(raw.project_title, "Untitled Project"),
      project_title_is_placeholder: !!raw.project_title_is_placeholder,
      event_period: str(raw.event_period),
      key_dates: pairs(raw.key_dates, "date", "label"),
      venue: str(raw.venue),
      objectives: list(raw.objectives),
      target_audience: list(raw.target_audience),
      kpis: list(raw.kpis),
      scope_of_work: pairs(raw.scope_of_work, "item", "detail"),
      budget: { amount: str(budget.amount), type: pick(budget.type, BUDGET_TYPES) },
      proposal_submission: { type: pick(sub.type, SUBMISSION_TYPES), details: str(sub.details) },
      notes: list(raw.notes),
      clarifications: list(raw.clarifications),
      summary: str(raw.summary, ""),
      extraction_warnings: list(raw.extraction_warnings),
    };
  }

  // ---- dates -------------------------------------------------------------
  function parseISO(iso) {
    const v = validISO(iso);
    if (!v) return null;
    const [y, m, d] = v.split("-").map(Number);
    return new Date(y, m - 1, d);
  }

  function fmtDate(iso, weekday = false) {
    const d = parseISO(iso);
    if (!d) return "";
    const s = `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
    return weekday ? `${s} (${DAYS[d.getDay()]})` : s;
  }

  function daysUntil(iso) {
    const d = parseISO(iso);
    if (!d) return null;
    const t = new Date();
    return Math.round((d - new Date(t.getFullYear(), t.getMonth(), t.getDate())) / 86400000);
  }

  /** Relative due label and urgency tone for chips. */
  function dueBadge(iso) {
    const n = daysUntil(iso);
    if (n == null) return null;
    if (n < 0) return { text: n === -1 ? "was due yesterday" : `was due ${-n} days ago`, tone: "past" };
    if (n === 0) return { text: "due today", tone: "urgent" };
    if (n === 1) return { text: "due tomorrow", tone: "urgent" };
    if (n <= 3) return { text: `in ${n} days`, tone: "urgent" };
    if (n <= 7) return { text: `in ${n} days`, tone: "soon" };
    return { text: `in ${n} days`, tone: "ok" };
  }

  /** "16 Oct 2026 (Fri) — 5:00 PM via email" or "Not specified". */
  function dueText(m, withNote = true) {
    const date = fmtDate(m.due_date.date, true);
    const note = isMissing(m.due_date.note) ? "" : m.due_date.note;
    if (!date) return note || NS;
    return withNote && note ? `${date} — ${note}` : date;
  }

  const label = (enumValue) => LABELS[enumValue] || enumValue;

  // ---- Markdown (follows project-brief-template.md) ------------------------
  function toMarkdown(m) {
    const cell = (v) => String(v).replace(/\|/g, "\\|").replace(/\n/g, "<br>");
    const val = (v) => (isMissing(v) ? `*${NS}*` : v);
    const bullets = (arr) => (arr.length ? arr.map((x) => `* ${x}`).join("\n") : `* *${NS}*`);
    const period = [val(m.event_period)]
      .concat(m.key_dates.map((k) => `• ${[k.date, k.label].filter(Boolean).join(" — ")}`)).join("\n");
    const title = m.project_title + (m.project_title_is_placeholder ? " *(suggested title)*" : "");
    const scope = m.scope_of_work.length
      ? m.scope_of_work.map((s) => (s.item ? `* **${s.item}:** ${s.detail}` : `* ${s.detail}`)).join("\n")
      : `* *${NS}*`;

    const notes = (m.notes.length ? m.notes : [`*${NS}*`]).map((n) => `> * ${n}`);
    if (m.clarifications.length) {
      notes.push(">", "> **To clarify with the client:**", ">", ...m.clarifications.map((q, i) => `> ${i + 1}. ${q}`));
    }

    // Blocks are separated by blank lines; lines inside a block are not.
    const blocks = [
      "# Project Brief Summary",
      m.summary ? `> **TL;DR:** ${m.summary}` : null,
      "---",
      "### **Overview**",
      [
        "| Parameter | Details |", "| --- | --- |",
        `| **Date Filed** | ${fmtDate(m.date_filed)} |`,
        `| **Due Date** | ${cell(val(dueText(m)))} |`,
        `| **Client Name** | ${cell(val(m.client_name))} |`,
        `| **Project Title** | ${cell(title)} |`,
        `| **Event Date / Period** | ${cell(period)} |`,
        `| **Venue** | ${cell(val(m.venue))} |`,
      ].join("\n"),
      "---",
      "### **Project Core**",
      "#### **1. Objective**", bullets(m.objectives),
      "#### **2. Target / Primary Audience**", bullets(m.target_audience),
      "#### **3. Key Performance Indicators (KPIs)**", bullets(m.kpis),
      "---",
      "### **Execution & Requirements**",
      "#### **Scope of Work**", scope,
      "#### **Financials & Submissions**",
      [
        `* **Estimated Budget:** ${val(m.budget.amount)} — **${m.budget.type}**`,
        `* **Proposal Submission:** **${m.proposal_submission.type}** — ${val(m.proposal_submission.details)}`,
      ].join("\n"),
      "---",
      "### **Additional Notes**",
      notes.join("\n"),
    ];
    return blocks.filter((b) => b != null).join("\n\n") + "\n";
  }

  // ---- Group-chat text ------------------------------------------------------
  function chatSections(m) {
    const lines = (arr) => (arr.length ? arr : [NS]);
    return [
      ["🎯", "Objective", lines(m.objectives)],
      ["👥", "Target Audience", lines(m.target_audience)],
      ["📊", "KPIs", lines(m.kpis)],
      ["🛠️", "Scope of Work", lines(m.scope_of_work.map((s) => (s.item ? `${s.item}: ${s.detail}` : s.detail)))],
    ];
  }

  function chatHeader(m) {
    const period = isMissing(m.event_period) ? NS : m.event_period;
    return [
      ["🏢", "Client", m.client_name],
      ["⏰", "Due", dueText(m)],
      ["📅", "Event", period],
      ["📍", "Venue", m.venue],
    ];
  }

  function chatFooter(m) {
    return [
      ["💰", "Budget", `${m.budget.amount}${m.budget.type !== "NOT SPECIFIED" ? ` (${label(m.budget.type)})` : ""}`],
      ["📝", "Proposal", `${label(m.proposal_submission.type)}${isMissing(m.proposal_submission.details) ? "" : ` — ${m.proposal_submission.details}`}`],
    ];
  }

  function toChatText(m) {
    const out = [`📋 PROJECT BRIEF: ${m.project_title}`];
    chatHeader(m).forEach(([e, k, v]) => out.push(`${e} ${k}: ${v}`));
    if (m.summary) out.push("", `TL;DR: ${m.summary}`);
    chatSections(m).forEach(([e, k, items]) => out.push("", `${e} ${k}`, ...items.map((x) => `• ${x}`)));
    out.push("");
    chatFooter(m).forEach(([e, k, v]) => out.push(`${e} ${k}: ${v}`));
    if (m.notes.length) out.push("", "🗒️ Notes", ...m.notes.map((x) => `• ${x}`));
    if (m.clarifications.length) out.push("", "❓ To clarify with client", ...m.clarifications.map((x, i) => `${i + 1}. ${x}`));
    out.push("", `Filed ${fmtDate(m.date_filed)}`);
    return out.join("\n");
  }

  function toChatHtml(m) {
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const out = [`<b>📋 PROJECT BRIEF: ${esc(m.project_title)}</b>`];
    chatHeader(m).forEach(([e, k, v]) => out.push(`${e} <b>${k}:</b> ${esc(v)}`));
    if (m.summary) out.push("", `<i>TL;DR: ${esc(m.summary)}</i>`);
    chatSections(m).forEach(([e, k, items]) => out.push("", `<b>${e} ${k}</b>`, ...items.map((x) => `• ${esc(x)}`)));
    out.push("");
    chatFooter(m).forEach(([e, k, v]) => out.push(`${e} <b>${k}:</b> ${esc(v)}`));
    if (m.notes.length) out.push("", "<b>🗒️ Notes</b>", ...m.notes.map((x) => `• ${esc(x)}`));
    if (m.clarifications.length) out.push("", "<b>❓ To clarify with client</b>", ...m.clarifications.map((x, i) => `${i + 1}. ${esc(x)}`));
    out.push("", `<i>Filed ${fmtDate(m.date_filed)}</i>`);
    return `<div>${out.join("<br>")}</div>`;
  }

  /** Safe file name stem, e.g. "Project Brief - NovaFizz - Campus Clash - 2026-10-02". */
  function fileStem(m) {
    const clean = (s) => String(s).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
    const client = isMissing(m.client_name) ? "" : clean(m.client_name.split(/\s[—–-]\s|\(/)[0]);
    return ["Project Brief", client, clean(m.project_title), m.date_filed].filter(Boolean).join(" - ");
  }

  BX.brief = {
    NS, BUDGET_TYPES, SUBMISSION_TYPES, label, isMissing, normalize, todayISO, validISO,
    fmtDate, daysUntil, dueBadge, dueText, toMarkdown, toChatText, toChatHtml, fileStem,
  };
})((window.BX = window.BX || {}));
