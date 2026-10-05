/*
 * The on-screen document: renders a brief model as an editable "paper".
 *
 * Every editable element carries data-path="field.path" and writes straight
 * back into the model on input, so the model stays the single source of truth
 * for the PDF, chat text, Markdown and Lark row. Lists behave like a word
 * processor: Enter adds a point, Backspace on an empty point removes it, and
 * pasting several lines creates several points.
 *
 * Lists may hold empty strings while editing; consumers should pass the model
 * through BX.brief.normalize() before exporting.
 */
(function (BX) {
  "use strict";
  const B = BX.brief;

  // List fields: null = list of strings, [a, b] = list of {a, b} objects.
  const LISTS = {
    objectives: null, target_audience: null, kpis: null, notes: null, clarifications: null,
    key_dates: ["date", "label"], scope_of_work: ["item", "detail"],
  };
  const BLANK_WHEN_EMPTY = { summary: "", "due_date.note": "", project_title: "Untitled Project" };
  const ENUM_OPTIONS = { "budget.type": B.BUDGET_TYPES, "proposal_submission.type": B.SUBMISSION_TYPES };
  const PLAINTEXT = (() => {
    const d = document.createElement("div");
    d.contentEditable = "plaintext-only";
    return d.contentEditable === "plaintext-only";
  })();

  let root = null, model = null, onChange = () => {}, pop = null;

  // ---- tiny DOM helpers ---------------------------------------------------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "html") el.innerHTML = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const icon = (name) => h("span", { class: "i", "aria-hidden": "true", html: BX.icons?.[name] || "" });
  const get = (path) => path.split(".").reduce((o, k) => (o == null ? o : o[k]), model);

  function set(path, value) {
    const keys = path.split(".");
    const last = keys.pop();
    let target = model;
    keys.forEach((k, i) => {
      if (target[k] == null) target[k] = /^\d+$/.test(keys[i + 1] ?? last) ? [] : {};
      target = target[k];
    });
    target[last] = value;
  }

  // ---- building blocks ----------------------------------------------------
  function ed(path, opts = {}) {
    const value = get(path);
    const missing = B.isMissing(value) || (path === "project_title" && value === "Untitled Project");
    const el = h(opts.tag || "span", {
      class: `ed${missing ? " is-missing" : ""}${opts.cls ? " " + opts.cls : ""}`,
      "data-path": path,
      "data-placeholder": opts.placeholder || B.NS,
      contenteditable: PLAINTEXT ? "plaintext-only" : "true",
      spellcheck: "true",
      role: "textbox",
      "aria-label": opts.label || null,
    });
    el.textContent = missing ? "" : value;
    return el;
  }

  function listBlock(name, opts = {}) {
    const fields = LISTS[name];
    const items = model[name];
    const empty = items.length === 0;
    const rows = empty ? [fields ? {} : ""] : items;
    const list = h(opts.ordered ? "ol" : "ul", { class: `doc-list${fields ? " is-pairs" : ""}`, "data-list": name });
    rows.forEach((_, i) => {
      const ph = empty ? opts.emptyText || `${B.NS} — click to add` : "New point";
      const content = fields
        ? [ed(`${name}.${i}.${fields[0]}`, { tag: "strong", cls: "pair-a", placeholder: opts.aPlaceholder || "Label" }),
          h("span", { class: "pair-sep", "aria-hidden": "true" }, opts.sep || ": "),
          ed(`${name}.${i}.${fields[1]}`, { cls: "pair-b", placeholder: empty ? ph : opts.bPlaceholder || "Details" })]
        : [ed(`${name}.${i}`, { placeholder: ph, label: opts.label })];
      list.append(h("li", { "data-index": i }, content, !empty && h("button", {
        type: "button", class: "item-del", "data-del": `${name}.${i}`, contenteditable: "false",
        "aria-label": "Remove this point", title: "Remove",
      }, "×")));
    });
    return [list, h("button", { type: "button", class: "item-add", "data-add": name, contenteditable: "false" },
      "+ ", opts.addText || "Add point")];
  }

  function enumChip(path) {
    const v = get(path);
    const tone = v === "NOT SPECIFIED" ? "muted" : v === "TO BE CONFIRMED" ? "warn" : "brand";
    return h("button", {
      type: "button", class: `chip chip-${tone}`, "data-enum": path, "aria-haspopup": "listbox",
      title: "Click to change",
    }, B.label(v), icon("caret"));
  }

  function dueCell() {
    const iso = model.due_date.date;
    const badge = B.dueBadge(iso);
    return h("div", { class: "due" },
      h("div", { class: "due-line" },
        h("button", {
          type: "button", class: `chip chip-date${iso ? "" : " is-missing"}`, "data-date": "due_date.date",
          title: "Click to pick a date",
        }, icon("calendar"), iso ? B.fmtDate(iso, true) : "Set due date"),
        badge && h("span", { class: `due-rel tone-${badge.tone}` }, badge.text)),
      ed("due_date.note", { cls: "due-note", placeholder: iso ? "Add time or how to submit" : B.NS }));
  }

  function row(label, ...value) {
    return h("tr", {}, h("th", { scope: "row" }, label), h("td", {}, value));
  }

  function section(title, ...kids) {
    return h("section", { class: "doc-sec" }, h("h2", {}, title), kids);
  }

  function build() {
    const m = model;
    return h("div", { class: "doc" },
      h("div", { class: "doc-band", "aria-hidden": "true" }),
      h("header", { class: "doc-head" },
        h("div", { class: "doc-kicker" }, "Project Brief Summary"),
        h("h1", { class: "doc-title" },
          ed("project_title", { label: "Project title", placeholder: "Untitled Project" }),
          m.project_title_is_placeholder && h("span", {
            class: "badge-suggest", title: "The brief didn't name the project, so this title was suggested. Click it to rename.",
          }, "Suggested title")),
        h("div", { class: "doc-meta" },
          ed("client_name", { label: "Client name" }),
          h("span", { class: "dot", "aria-hidden": "true" }, "•"),
          h("span", {}, `Filed ${B.fmtDate(m.date_filed)}`)),
        h("div", { class: "doc-tldr" },
          h("span", { class: "tldr-label" }, "TL;DR"),
          ed("summary", { placeholder: "Add a one-line summary", label: "Summary" }))),

      section("Overview", h("table", { class: "doc-table" }, h("tbody", {},
        row("Date Filed", B.fmtDate(m.date_filed)),
        row("Due Date", dueCell()),
        row("Client Name", ed("client_name", { label: "Client name" })),
        row("Project Title", ed("project_title", { label: "Project title", placeholder: "Untitled Project" })),
        row("Event Date / Period",
          ed("event_period", { tag: "div", label: "Event date or period" }),
          h("div", { class: "kd" }, listBlock("key_dates", {
            sep: " — ", aPlaceholder: "Date", bPlaceholder: "What happens", addText: "Add key date",
            emptyText: "No key dates",
          }))),
        row("Venue", ed("venue", { label: "Venue" }))))),

      section("Project Core",
        h("h3", {}, "1. Objective"), listBlock("objectives", { label: "Objective" }),
        h("h3", {}, "2. Target / Primary Audience"), listBlock("target_audience", { label: "Audience" }),
        h("h3", {}, "3. Key Performance Indicators (KPIs)"), listBlock("kpis", { label: "KPI" })),

      section("Execution & Requirements",
        h("h3", {}, "Scope of Work"),
        listBlock("scope_of_work", { aPlaceholder: "Responsibility", bPlaceholder: "Key deliverable / expectation" }),
        h("h3", {}, "Financials & Submissions"),
        h("table", { class: "doc-table doc-fin" }, h("tbody", {},
          row("Estimated Budget", h("div", { class: "fin-line" },
            ed("budget.amount", { label: "Estimated budget" }), enumChip("budget.type"))),
          row("Proposal Submission", h("div", { class: "fin-line" },
            enumChip("proposal_submission.type"), ed("proposal_submission.details", { label: "Submission details" })))))),

      section("Additional Notes", h("div", { class: "doc-quote" },
        listBlock("notes", { label: "Note" }),
        h("h4", {}, "To clarify with the client"),
        listBlock("clarifications", { ordered: true, emptyText: "No open questions", addText: "Add question" }))),

      h("footer", { class: "doc-foot" }, "Mineski Global • Project Brief Summary"));
  }

  // ---- rendering & focus --------------------------------------------------
  function render(nextModel, opts = {}) {
    model = nextModel;
    closePopover();
    root.replaceChildren(build());
    if (opts.focus) focusPath(opts.focus.path, opts.focus.at);
  }

  function focusPath(path, at = "end") {
    const el = root.querySelector(`[data-path="${CSS.escape(path)}"]`);
    if (!el) return;
    el.focus({ preventScroll: false });
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(at === "start");
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function caretAtStart(el) {
    const sel = getSelection();
    if (!sel.rangeCount || !sel.isCollapsed) return false;
    const pre = sel.getRangeAt(0).cloneRange();
    pre.selectNodeContents(el);
    pre.setEnd(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset);
    return pre.toString().length === 0;
  }

  const changed = () => onChange(model);

  // ---- editing ------------------------------------------------------------
  function commit(el) {
    const path = el.dataset.path;
    const text = (el.innerText || "").replace(/ /g, " ").replace(/\r/g, "").trim();
    const [head, idx] = path.split(".");
    if (head in LISTS && /^\d+$/.test(idx || "")) {
      const arr = model[head], fields = LISTS[head];
      while (arr.length <= +idx) arr.push(fields ? { [fields[0]]: "", [fields[1]]: "" } : "");
    }
    set(path, text || (path in BLANK_WHEN_EMPTY ? BLANK_WHEN_EMPTY[path] : head in LISTS ? "" : B.NS));
    if (path === "project_title") {
      model.project_title_is_placeholder = false;
      root.querySelector(".badge-suggest")?.remove();
    }
    el.classList.toggle("is-missing", !text);
    if (!text && el.childNodes.length) el.textContent = "";   // drop stray <br> so the placeholder shows
    root.querySelectorAll(`[data-path="${CSS.escape(path)}"]`).forEach((other) => {
      if (other !== el) {
        other.textContent = text;
        other.classList.toggle("is-missing", !text);
      }
    });
    changed();
  }

  function addItem(name, at) {
    const fields = LISTS[name];
    model[name].splice(at, 0, fields ? { [fields[0]]: "", [fields[1]]: "" } : "");
    render(model, { focus: { path: fields ? `${name}.${at}.${fields[0]}` : `${name}.${at}`, at: "start" } });
    changed();
  }

  function removeItem(name, i, focusPrev = true) {
    model[name].splice(i, 1);
    const fields = LISTS[name];
    const target = Math.max(0, focusPrev ? i - 1 : i);
    const path = fields ? `${name}.${target}.${fields[1]}` : `${name}.${target}`;
    render(model, { focus: model[name].length ? { path, at: "end" } : null });
    changed();
  }

  function onKeydown(e) {
    const el = e.target.closest?.(".ed");
    if (!el || e.isComposing) return;
    const parts = el.dataset.path.split(".");
    const name = parts[0], i = +parts[1], fields = LISTS[name];
    const inList = name in LISTS && parts.length >= 2;

    if (e.key === "Escape") return el.blur();
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (inList) addItem(name, i + 1);
      else el.blur();
      return;
    }
    if (e.key === "Backspace" && inList && caretAtStart(el)) {
      if (fields && parts[2] === fields[1]) {          // jump from detail back to label
        e.preventDefault();
        return focusPath(`${name}.${i}.${fields[0]}`, "end");
      }
      const li = el.closest("li");
      const empty = [...li.querySelectorAll(".ed")].every((x) => !x.textContent.trim());
      if (empty && model[name].length > 0) {
        e.preventDefault();
        removeItem(name, i);
      }
    }
  }

  function onPaste(e) {
    const el = e.target.closest?.(".ed");
    if (!el) return;
    const text = e.clipboardData?.getData("text/plain") ?? "";
    const parts = el.dataset.path.split(".");
    const name = parts[0];
    const lines = text.split(/\r?\n/)
      .map((l) => l.replace(/^\s*(?:[-–•*▪●◦]|\d{1,2}[.)])\s+/, "").trim()).filter(Boolean);

    if (name in LISTS && !LISTS[name] && lines.length > 1) {   // one point per pasted line
      e.preventDefault();
      const arr = model[name], i = +parts[1];
      while (arr.length <= i) arr.push("");
      if (arr[i].trim()) arr.splice(i + 1, 0, ...lines);
      else arr.splice(i, 1, ...lines);
      const last = arr[i].trim() && arr[i] !== lines[0] ? i + lines.length : i + lines.length - 1;
      render(model, { focus: { path: `${name}.${last}`, at: "end" } });
      changed();
    } else if (!PLAINTEXT) {                                   // keep formatting out
      e.preventDefault();
      document.execCommand("insertText", false, text);
    }
  }

  function onClick(e) {
    const btn = e.target.closest("button");
    if (!btn || !root.contains(btn)) return;
    if (btn.dataset.add) {
      addItem(btn.dataset.add, model[btn.dataset.add].length);
    } else if (btn.dataset.del) {
      const [name, i] = btn.dataset.del.split(".");
      removeItem(name, +i);
    } else if (btn.dataset.enum) {
      openEnum(btn);
    } else if (btn.dataset.date) {
      openDate(btn);
    }
  }

  // ---- popovers -----------------------------------------------------------
  function openPopover(anchor, content) {
    closePopover();
    pop = h("div", { class: "popover", role: "dialog" }, content);
    document.body.append(pop);
    const r = anchor.getBoundingClientRect();
    const maxLeft = document.documentElement.clientWidth - pop.offsetWidth - 12;
    pop.style.top = `${r.bottom + window.scrollY + 8}px`;
    pop.style.left = `${Math.max(12, Math.min(r.left, maxLeft)) + window.scrollX}px`;
    anchor.setAttribute("aria-expanded", "true");
    pop._anchor = anchor;
    requestAnimationFrame(() => pop?.classList.add("open"));
    setTimeout(() => {
      document.addEventListener("pointerdown", onOutside, true);
      document.addEventListener("keydown", onPopKey, true);
    });
    return pop;
  }

  function closePopover() {
    if (!pop) return;
    pop._anchor?.setAttribute("aria-expanded", "false");
    pop.remove();
    pop = null;
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onPopKey, true);
  }

  function onOutside(e) {
    if (pop && !pop.contains(e.target) && e.target !== pop._anchor) closePopover();
  }

  function onPopKey(e) {
    if (e.key === "Escape") {
      const anchor = pop?._anchor;
      closePopover();
      anchor?.focus();
    }
  }

  function openEnum(anchor) {
    const path = anchor.dataset.enum;
    const current = get(path);
    const list = h("div", { class: "pop-list", role: "listbox" },
      ENUM_OPTIONS[path].map((opt) => h("button", {
        type: "button", role: "option", class: "pop-opt", "aria-selected": String(opt === current), "data-value": opt,
      }, B.label(opt))));
    list.addEventListener("click", (e) => {
      const opt = e.target.closest(".pop-opt");
      if (!opt) return;
      set(path, opt.dataset.value);
      render(model);
      changed();
      root.querySelector(`[data-enum="${CSS.escape(path)}"]`)?.focus();
    });
    openPopover(anchor, list);
    list.querySelector('[aria-selected="true"]')?.focus();
  }

  function openDate(anchor) {
    const input = h("input", { type: "date", class: "pop-date", value: model.due_date.date || "", "aria-label": "Due date" });
    const apply = (value) => {
      model.due_date.date = B.validISO(value);
      if (!model.due_date.date && !model.due_date.note) model.due_date.note = B.NS;
      if (model.due_date.date && model.due_date.note === B.NS) model.due_date.note = "";
      render(model);
      changed();
      root.querySelector("[data-date]")?.focus();
    };
    input.addEventListener("change", () => input.value && apply(input.value));
    const box = h("div", { class: "pop-datebox" },
      h("label", { class: "pop-label" }, "Proposal due date"), input,
      h("div", { class: "pop-actions" },
        h("button", { type: "button", class: "btn btn-ghost btn-sm", "data-clear": "" }, "Clear"),
        h("button", { type: "button", class: "btn btn-dark btn-sm", "data-done": "" }, "Done")));
    box.addEventListener("click", (e) => {
      if (e.target.closest("[data-clear]")) apply("");
      if (e.target.closest("[data-done]")) (input.value ? apply(input.value) : closePopover());
    });
    openPopover(anchor, box);
    input.focus();
    try { input.showPicker?.(); } catch (_) { /* needs a user gesture in some browsers */ }
  }

  // ---- public API -----------------------------------------------------------
  function mount(el, changeHandler) {
    root = el;
    onChange = changeHandler || (() => {});
    root.addEventListener("input", (e) => e.target.closest?.(".ed") && commit(e.target.closest(".ed")));
    root.addEventListener("keydown", onKeydown);
    root.addEventListener("paste", onPaste);
    root.addEventListener("click", onClick);
  }

  BX.doc = { mount, render, close: closePopover, h };
})((window.BX = window.BX || {}));
