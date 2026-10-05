/*
 * Lark Base client. All calls go through the Lark CORS proxy:
 *   GET  {proxy}/token                  -> tenant access token (proxy holds the app secret)
 *   POST {proxy}/proxy?url=<lark api>   -> forwarded with our Bearer token
 * The proxy forwards POST only, so updates use records/batch_update.
 *
 * Column names must match tools/setup_lark_table.py.
 */
(function (BX) {
  "use strict";
  const B = BX.brief;
  const cfg = () => BX.config;

  const FIELD = {
    title: "Project Title", client: "Client", filed: "Date Filed", due: "Due Date", status: "Status",
    period: "Event Date / Period", venue: "Venue", objective: "Objective", audience: "Target Audience",
    kpis: "KPIs", scope: "Scope of Work", budget: "Estimated Budget", budgetType: "Budget Type",
    submission: "Proposal Submission", submissionDetails: "Submission Details", notes: "Notes",
    questions: "Questions for Client", summary: "Summary", filedBy: "Filed By", sources: "Source Files",
    json: "Brief JSON", modified: "Last Modified", nextSteps: "Next Steps", attachments: "Attachments",
    requirement: "Requirement Type", vat: "VAT",
  };
  const AUTH_CODES = new Set([99991661, 99991663, 99991668, 99991677]);
  const FRIENDLY = {
    1254302: "The app doesn't have permission to this Lark table. Ask the Base admin to check its Advanced Permissions.",
    91403: "The app doesn't have access to this Lark Base. Ask the Base admin to add it as a collaborator.",
    1254045: "The Lark table is missing a column. Run tools/setup_lark_table.py --apply to repair it.",
    1254290: "Lark is rate-limiting requests. Wait a few seconds and try again.",
    1254291: "Someone else is editing this row right now. Try again in a moment.",
  };

  let tokenCache = null;

  class LarkError extends Error {
    constructor(message, code) { super(message); this.code = code; }
  }

  async function fetchJSON(url, options = {}, timeoutMs = 75000) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: ctl.signal });
      return await res.json().catch(() => ({ code: res.status, msg: `HTTP ${res.status}` }));
    } catch (e) {
      throw new LarkError(e.name === "AbortError"
        ? "Lark took too long to respond. The connection may be waking up — try again."
        : "Couldn't reach the Lark service. Check your connection and try again.", "network");
    } finally {
      clearTimeout(timer);
    }
  }

  function fail(data) {
    const code = data?.code;
    throw new LarkError(FRIENDLY[code] || `Lark error ${code}: ${data?.msg || "unknown"}`, code);
  }

  async function token(force = false) {
    if (!force && tokenCache && tokenCache.exp > Date.now()) return tokenCache.value;
    const data = await fetchJSON(`${cfg().LARK_PROXY_URL}/token`);
    const value = data.tenant_access_token || data.app_access_token;
    if (data.code !== 0 || !value) fail(data);
    tokenCache = { value, exp: Date.now() + Math.max(60, (data.expire || 7200) - 300) * 1000 };
    return value;
  }

  async function api(path, body, retried = false) {
    const target = `${cfg().LARK_API_BASE}/bitable/v1/apps/${cfg().LARK_APP_TOKEN}/tables/${cfg().LARK_TABLE_ID}${path}`;
    const data = await fetchJSON(`${cfg().LARK_PROXY_URL}/proxy?url=${encodeURIComponent(target)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${await token()}` },
      body: JSON.stringify(body || {}),
    });
    if (AUTH_CODES.has(data.code) && !retried) {
      tokenCache = null;
      return api(path, body, true);
    }
    if (data.code !== 0) fail(data);
    return data.data || {};
  }

  function warmup() {
    return fetch(`${cfg().LARK_PROXY_URL}/health`, { cache: "no-store" }).then(() => true, () => false);
  }

  // ---- model <-> row ----------------------------------------------------------
  const tz = () => (cfg().LARK_TZ_OFFSET_MINUTES || 0) * 60000;
  const toMs = (iso) => {
    if (!B.validISO(iso)) return null;
    const [y, m, d] = iso.split("-").map(Number);
    return Date.UTC(y, m - 1, d) - tz();
  };
  const fromMs = (ms) => (typeof ms === "number" ? new Date(ms + tz()).toISOString().slice(0, 10) : "");
  const lines = (arr) => (arr.length ? arr.map((x) => `• ${x}`).join("\n") : B.NS);

  /** Flatten a brief into the table's columns (readable in Lark) plus the full JSON. */
  function toFields(model, extra = {}) {
    const m = B.normalize(model);
    const fields = {
      [FIELD.title]: m.project_title,
      [FIELD.client]: m.client_name,
      [FIELD.filed]: toMs(m.date_filed),
      [FIELD.due]: toMs(m.due_date.date),
      [FIELD.period]: [m.event_period].concat(m.key_dates.map((k) => `• ${[k.date, k.label].filter(Boolean).join(" — ")}`)).join("\n"),
      [FIELD.venue]: m.venue,
      [FIELD.objective]: lines(m.objectives),
      [FIELD.audience]: lines(m.target_audience),
      [FIELD.kpis]: lines(m.kpis),
      [FIELD.scope]: lines(m.scope_of_work.map((s) => (s.item ? `${s.item}: ${s.detail}` : s.detail))),
      [FIELD.budget]: m.budget.amount,
      [FIELD.budgetType]: B.label(m.budget.type),
      [FIELD.submission]: B.label(m.proposal_submission.type),
      [FIELD.submissionDetails]: [m.due_date.date ? `Due ${B.dueText(m)}` : "", B.isMissing(m.proposal_submission.details) ? "" : m.proposal_submission.details].filter(Boolean).join("\n") || B.NS,
      [FIELD.notes]: lines(m.notes),
      [FIELD.questions]: m.clarifications.length ? m.clarifications.map((q, i) => `${i + 1}. ${q}`).join("\n") : "",
      [FIELD.summary]: m.summary,
      [FIELD.json]: JSON.stringify(m),
    };
    if ("filedBy" in extra) fields[FIELD.filedBy] = extra.filedBy || "";
    if ("sources" in extra) fields[FIELD.sources] = extra.sources || "";
    if ("status" in extra) fields[FIELD.status] = extra.status;
    if ("nextSteps" in extra) fields[FIELD.nextSteps] = extra.nextSteps;   // Lark-only, never in the document
    if ("requirement" in extra) {   // single select: "RFP (Request for Proposal)" etc.
      fields[FIELD.requirement] = cfg().REQUIREMENT_TYPES[extra.requirement]?.label || null;
    }
    if ("vat" in extra) {           // multi-select in Lark, but only ever one value
      const label = cfg().VAT_CHOICES[extra.vat]?.label;
      fields[FIELD.vat] = label ? [label] : [];
    }
    if ("attachments" in extra) fields[FIELD.attachments] = extra.attachments.map((t) => ({ file_token: t }));
    if (fields[FIELD.due] == null) fields[FIELD.due] = null;   // clears the cell on update
    if (fields[FIELD.filed] == null) delete fields[FIELD.filed];
    return fields;
  }

  /** Read any Bitable cell as plain text (text cells arrive as segment arrays). */
  function cellText(v) {
    if (v == null) return "";
    if (typeof v === "string" || typeof v === "number") return String(v);
    if (Array.isArray(v)) return v.map((s) => (typeof s === "object" ? s.text ?? s.name ?? s.link ?? "" : String(s))).join("");
    if (typeof v === "object") return cellText(v.value ?? v.text ?? v.name ?? "");
    return String(v);
  }

  const splitLines = (s) => cellText(s).split("\n").map((l) => l.replace(/^\s*(?:•|\d+\.)\s*/, "").trim())
    .filter((l) => l && !B.isMissing(l));

  /** Map a Lark option name ("RFQ (Request for Quotation)", "No ") back to its key. */
  function matchChoice(choices, value) {
    const v = String(value || "").trim().toLowerCase();
    if (!v) return "";
    return Object.keys(choices).find((k) => choices[k].label.trim().toLowerCase() === v || v.startsWith(k.toLowerCase())) || "";
  }

  /** Rebuild a brief from a row: the JSON column first, the readable columns as a fallback. */
  function fromRecord(rec) {
    const f = rec.fields || {};
    let model = null;
    try { model = JSON.parse(cellText(f[FIELD.json])); } catch (_) { /* fall back below */ }
    if (!model || typeof model !== "object") {
      const [period, ...keyDates] = cellText(f[FIELD.period]).split("\n");
      model = {
        project_title: cellText(f[FIELD.title]), client_name: cellText(f[FIELD.client]),
        date_filed: fromMs(f[FIELD.filed]), due_date: { date: fromMs(f[FIELD.due]), note: "" },
        event_period: period, key_dates: keyDates.map((l) => {
          const [date, ...rest] = l.replace(/^•\s*/, "").split(" — ");
          return { date, label: rest.join(" — ") };
        }),
        venue: cellText(f[FIELD.venue]), objectives: splitLines(f[FIELD.objective]),
        target_audience: splitLines(f[FIELD.audience]), kpis: splitLines(f[FIELD.kpis]),
        scope_of_work: splitLines(f[FIELD.scope]).map((l) => {
          const i = l.indexOf(": ");
          return i > 0 ? { item: l.slice(0, i), detail: l.slice(i + 2) } : { item: "", detail: l };
        }),
        budget: { amount: cellText(f[FIELD.budget]), type: cellText(f[FIELD.budgetType]).toUpperCase() },
        proposal_submission: { type: cellText(f[FIELD.submission]).toUpperCase(), details: cellText(f[FIELD.submissionDetails]) },
        notes: splitLines(f[FIELD.notes]), clarifications: splitLines(f[FIELD.questions]),
        summary: cellText(f[FIELD.summary]),
      };
    }
    // If someone changes the Due Date column in Lark, that wins over the JSON.
    if (typeof f[FIELD.due] === "number") model.due_date = { ...(model.due_date || {}), date: fromMs(f[FIELD.due]) };
    return {
      id: rec.record_id,
      model: B.normalize(model),
      status: cellText(f[FIELD.status]) || "New",
      filedBy: cellText(f[FIELD.filedBy]),
      sources: cellText(f[FIELD.sources]),
      nextSteps: (Array.isArray(f[FIELD.nextSteps]) ? f[FIELD.nextSteps] : f[FIELD.nextSteps] ? [f[FIELD.nextSteps]] : [])
        .map(cellText).filter(Boolean),
      requirement: matchChoice(cfg().REQUIREMENT_TYPES, cellText(f[FIELD.requirement])),
      vat: matchChoice(cfg().VAT_CHOICES, [].concat(f[FIELD.vat] || []).map(cellText)[0] || ""),
      attachments: (Array.isArray(f[FIELD.attachments]) ? f[FIELD.attachments] : [])
        .filter((a) => a && a.file_token)
        .map((a) => ({ token: a.file_token, name: a.name || "file", size: a.size || 0, url: a.url || a.tmp_url || "" })),
      modified: typeof f[FIELD.modified] === "number" ? f[FIELD.modified] : null,
    };
  }

  // ---- operations ---------------------------------------------------------------
  async function listAll(onProgress) {
    const out = [];
    let page = "";
    for (let i = 0; i < 40; i++) {   // 40 × 500 rows is plenty; guards against loops
      const data = await api(`/records/search?page_size=500${page ? `&page_token=${encodeURIComponent(page)}` : ""}`,
        { automatic_fields: false });
      out.push(...(data.items || []).map(fromRecord));
      onProgress?.(out.length);
      if (!data.has_more || !data.page_token) break;
      page = data.page_token;
    }
    return out;
  }

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  /** Create a row. clientToken makes retries idempotent (no duplicate rows). */
  async function create(model, extra, clientToken = uuid()) {
    const fields = toFields(model, { status: "New", ...extra });
    if (fields[FIELD.due] == null) delete fields[FIELD.due];
    const data = await api(`/records?client_token=${clientToken}`, { fields });
    return fromRecord(data.record || { record_id: data.record_id, fields });
  }

  async function update(id, model, extra) {
    const data = await api("/records/batch_update", { records: [{ record_id: id, fields: toFields(model, extra) }] });
    const rec = (data.records || [])[0];
    return rec ? fromRecord(rec) : null;
  }

  /** Upload one file into the Base (Drive "media" API) and return its file_token. */
  async function uploadFile(file, retried = false) {
    const form = new FormData();
    form.append("file_name", file.name);
    form.append("parent_type", "bitable_file");
    form.append("parent_node", cfg().LARK_APP_TOKEN);
    form.append("size", String(file.size));
    form.append("extra", JSON.stringify({ bitablePerm: { tableId: cfg().LARK_TABLE_ID } }));  // advanced-permission Bases
    form.append("file", file, file.name);
    const target = `${cfg().LARK_API_BASE}/drive/v1/medias/upload_all`;
    const data = await fetchJSON(`${cfg().LARK_PROXY_URL}/proxy?url=${encodeURIComponent(target)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await token()}` },   // the browser sets the multipart boundary
      body: form,
    }, 180000);
    if (AUTH_CODES.has(data.code) && !retried) {
      tokenCache = null;
      return uploadFile(file, true);
    }
    if (data.code === 413 || /too large/i.test(data.error || data.msg || "")) {
      throw new LarkError(`“${file.name}” is too large for the Lark connection.`, 413);
    }
    if (data.code !== 0 || !data.data?.file_token) fail(data);
    return data.data.file_token;
  }

  /** Forget the cached token (e.g. after the proxy address changes in Settings). */
  const resetToken = () => { tokenCache = null; };

  BX.lark = { FIELD, LarkError, token, resetToken, uploadFile, warmup, listAll, create, update, toFields, fromRecord, uuid };
})((window.BX = window.BX || {}));
