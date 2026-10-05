/*
 * PDF export with pdfmake: a fixed, vector (selectable-text) layout built from
 * the brief model, mirroring the on-screen document. pdfmake (~1.9 MB with
 * fonts) is lazy-loaded the first time it's needed and prefetched when idle.
 */
(function (BX) {
  "use strict";
  const B = BX.brief;

  const LIB = [
    ["https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.3.3/pdfmake.min.js",
      "sha512-EkS5jkn3vXRWIdphIy51xskMZggNip3Or8kpe/FlM5XaQeiK2GZJ9OwrIEbXl6txKWsHNtm4OXtxzkkz41Mspw=="],
    ["https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.3.3/vfs_fonts.min.js",
      "sha512-rpvsrDF7BNgiFOXqkKyyoJ46jZ8nwQ3NJJAmpYnYKuZHfzwR2wpz5cAaPX09RCj9un5E+ErATIqy4CZBcuNogA=="],
  ];
  const C = { yellow: "#FFC800", ink: "#16150F", muted: "#6B6A63", line: "#E8E6DF", soft: "#FFF8D6",
    label: "#F6F5F0", amber: "#8A6100", marker: "#E0A800" };
  const PAGE_W = 595.28, MARGIN_X = 50, CONTENT_W = PAGE_W - MARGIN_X * 2;

  let loading = null;

  function loadScript([src, integrity]) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.integrity = integrity;
      s.crossOrigin = "anonymous";
      s.onload = resolve;
      s.onerror = () => reject(new Error("Couldn't load the PDF library. Check your connection and try again."));
      document.head.append(s);
    });
  }

  function load() {
    loading ??= loadScript(LIB[0]).then(() => loadScript(LIB[1])).catch((e) => { loading = null; throw e; });
    return loading;
  }

  function prefetch() {
    const run = () => load().catch(() => {});
    "requestIdleCallback" in window ? requestIdleCallback(run, { timeout: 4000 }) : setTimeout(run, 1500);
  }

  // ---- document definition ------------------------------------------------
  const missing = (t = B.NS) => ({ text: t, italics: true, color: C.muted });
  const val = (v) => (B.isMissing(v) ? missing() : { text: v });

  function bullets(items, ordered = false, empty = B.NS) {
    if (!items.length) return { ...missing(empty), margin: [0, 0, 0, 8] };
    return { [ordered ? "ol" : "ul"]: items, markerColor: C.marker, margin: [0, 0, 0, 8] };
  }

  function heading(text) {
    return {
      stack: [
        { text, style: "h2" },
        { canvas: [
          { type: "line", x1: 0, y1: 0, x2: CONTENT_W, y2: 0, lineWidth: 0.75, lineColor: C.line },
          { type: "line", x1: 0, y1: 0, x2: 36, y2: 0, lineWidth: 2.5, lineColor: C.yellow },
        ] },
      ],
      margin: [0, 18, 0, 10],
    };
  }

  function chip(text) {
    return { text: ` ${text} `, background: C.yellow, bold: true, fontSize: 7.5, color: C.ink, characterSpacing: 0.4 };
  }

  function table(rows) {
    return {
      table: { widths: [118, "*"], body: rows.map(([k, v]) => [{ text: k, style: "th" }, v]) },
      layout: {
        hLineWidth: (i, node) => (i === 0 || i === node.table.body.length ? 0.75 : 0.5),
        vLineWidth: () => 0,
        hLineColor: () => C.line,
        fillColor: (r, node, c) => (c === 0 ? C.label : null),
        paddingLeft: () => 9, paddingRight: () => 9, paddingTop: () => 6, paddingBottom: () => 6,
      },
    };
  }

  function boxed(content, fill) {
    return {
      table: { widths: ["*"], body: [[content]] },
      layout: {
        hLineWidth: () => 0, vLineWidth: (i) => (i === 0 ? 3 : 0), vLineColor: () => C.yellow,
        fillColor: () => fill, paddingLeft: () => 12, paddingRight: () => 12, paddingTop: () => 9, paddingBottom: () => 9,
      },
    };
  }

  function build(model) {
    const m = B.normalize(model);
    const due = m.due_date.date
      ? { stack: [{ text: B.fmtDate(m.due_date.date, true), bold: true },
        !B.isMissing(m.due_date.note) && m.due_date.note ? { text: m.due_date.note, fontSize: 8.5, color: C.muted } : ""] }
      : val(m.due_date.note);
    const period = { stack: [val(m.event_period)].concat(m.key_dates.length ? [{
      ul: m.key_dates.map((k) => ({ text: [{ text: k.date ? `${k.date} — ` : "", bold: true }, k.label] })),
      fontSize: 8.5, markerColor: C.marker, margin: [0, 4, 0, 0],
    }] : []) };
    const scope = m.scope_of_work.map((s) => ({ text: s.item ? [{ text: `${s.item}: `, bold: true }, s.detail] : s.detail }));

    const notes = [bullets(m.notes)];
    if (m.clarifications.length) {
      notes.push({ text: "To clarify with the client", bold: true, margin: [0, 4, 0, 4] }, bullets(m.clarifications, true));
    }

    return {
      pageSize: "A4",
      pageMargins: [MARGIN_X, 58, MARGIN_X, 54],
      info: { title: `Project Brief — ${m.project_title}`, author: "Mineski Global", subject: "Project Brief Summary",
        creator: "Fetch" },
      background: () => ({ canvas: [{ type: "rect", x: 0, y: 0, w: PAGE_W, h: 9, color: C.yellow }] }),
      footer: (page, count) => ({
        columns: [
          { text: `${m.project_title}`, fontSize: 7.5, color: C.muted },
          { text: `Page ${page} of ${count}`, alignment: "right", fontSize: 7.5, color: C.muted, width: 70 },
        ],
        margin: [MARGIN_X, 22, MARGIN_X, 0],
      }),
      content: [
        { text: "PROJECT BRIEF SUMMARY", style: "kicker" },
        { text: m.project_title, style: "title" },
        m.project_title_is_placeholder ? { text: "Suggested title — the brief did not name the project", fontSize: 7.5, color: C.amber, margin: [0, 0, 0, 2] } : "",
        { text: [B.isMissing(m.client_name) ? "" : m.client_name, B.isMissing(m.client_name) ? "" : "   •   ",
          `Filed ${B.fmtDate(m.date_filed)}`], style: "meta" },
        m.summary ? boxed({ text: [{ text: "TL;DR  ", bold: true, color: C.amber }, m.summary] }, C.soft) : "",

        heading("Overview"),
        table([
          ["Date Filed", { text: B.fmtDate(m.date_filed) }],
          ["Due Date", due],
          ["Client Name", val(m.client_name)],
          ["Project Title", { text: m.project_title }],
          ["Event Date / Period", period],
          ["Venue", val(m.venue)],
        ]),

        heading("Project Core"),
        { text: "1. Objective", style: "h3" }, bullets(m.objectives),
        { text: "2. Target / Primary Audience", style: "h3" }, bullets(m.target_audience),
        { text: "3. Key Performance Indicators (KPIs)", style: "h3" }, bullets(m.kpis),

        heading("Execution & Requirements"),
        { text: "Scope of Work", style: "h3" }, bullets(scope),
        { text: "Financials & Submissions", style: "h3" },
        table([
          ["Estimated Budget", { text: [B.isMissing(m.budget.amount) ? missing() : m.budget.amount, "   ", chip(m.budget.type)] }],
          ["Proposal Submission", { stack: [{ text: [chip(m.proposal_submission.type)] },
            { ...val(m.proposal_submission.details), margin: [0, 3, 0, 0] }] }],
        ]),

        heading("Additional Notes"),
        boxed({ stack: notes }, "#FAFAF7"),
      ],
      styles: {
        kicker: { fontSize: 8, bold: true, color: C.amber, characterSpacing: 1.6, margin: [0, 0, 0, 6] },
        title: { fontSize: 21, bold: true, lineHeight: 1.15, margin: [0, 0, 0, 4] },
        meta: { fontSize: 9.5, color: C.muted, margin: [0, 0, 0, 12] },
        h2: { fontSize: 12.5, bold: true, margin: [0, 0, 0, 5] },
        h3: { fontSize: 10, bold: true, margin: [0, 4, 0, 5] },
        th: { bold: true, fontSize: 9, color: C.ink },
      },
      defaultStyle: { font: "Roboto", fontSize: 9.5, lineHeight: 1.3, color: C.ink },
    };
  }

  async function download(model) {
    await load();
    const name = `${B.fileStem(B.normalize(model))}.pdf`;
    await Promise.resolve(window.pdfMake.createPdf(build(model)).download(name));
    return name;
  }

  BX.pdf = { load, prefetch, download, build };
})((window.BX = window.BX || {}));
