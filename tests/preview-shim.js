/* Preview mode, for checking Fetch's screens without a Lark login.
   Loaded by index.html only on a local page with ?preview (see its <head>).

   Fetch runs unchanged, but every call to the connection service and the extraction service is
   answered here from tests/preview-fixture.json: made-up briefs and a canned extraction (make it with
   `npm run preview:fixture`; there is no real data in it). Saves, Done and Delete are simulated in this
   tab's memory: NOTHING is sent anywhere. A badge says so on screen.
   Use a separate tab: this puts a fake login in the tab's sessionStorage. */
(function () {
  "use strict";
  var realFetch = window.fetch.bind(window);
  var fx = null;
  var fixture = function () {
    return fx || (fx = realFetch("tests/preview-fixture.json?v=" + Date.now()).then(function (r) { return r.json(); }).then(prepare));
  };
  sessionStorage.setItem("fetch.auth.token", JSON.stringify({
    access_token: "preview-only", scope: "bitable:app", expires_at: Date.now() + 95 * 60000,
  }));
  sessionStorage.setItem("fetch.auth.user", JSON.stringify({ name: "Preview Mode", avatar: "", email: "" }));

  var TZ_MIN = 480;   // the Base's zone, UTC+8
  var dayMs = function (daysFromToday) {
    var d = new Date(); d.setDate(d.getDate() + daysFromToday);
    var iso = d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);
    return { iso: iso, ms: Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - TZ_MIN * 60000 };
  };
  var seg = function (text) { return [{ type: "text", text: text }]; };

  // The fixture keeps dates as offsets from today, so the cards always look current.
  function prepare(f) {
    f.records.forEach(function (r) {
      var due = r.dueInDays == null ? null : dayMs(r.dueInDays), filed = dayMs(-(r.filedDaysAgo || 0));
      var json = JSON.parse(r.fields["Brief JSON"][0].text);
      json.date_filed = filed.iso;
      json.due_date = { date: due ? due.iso : "", note: json.due_date ? json.due_date.note : "" };
      r.fields["Brief JSON"] = seg(JSON.stringify(json));
      r.fields["Date Filed"] = filed.ms;
      if (due) r.fields["Due Date"] = due.ms; else delete r.fields["Due Date"];
      r.fields["Last Modified"] = Date.now() - 3600000;
      delete r.dueInDays; delete r.filedDaysAgo;
    });
    return f;
  }

  var seq = 0;
  var tokens = {};
  var reply = function (obj, ms) {
    return new Promise(function (res) {
      setTimeout(function () {
        res(new Response(JSON.stringify(obj), { status: 200, headers: { "Content-Type": "application/json" } }));
      }, ms === undefined ? 250 : ms);
    });
  };
  var typeOf = function (f, name) {
    var def = f.fields.find(function (x) { return x.field_name === name; });
    return def ? def.type : 0;
  };
  // Lark stores what's written in its read format: text as segments, attachments with names.
  var toRead = function (f, fields) {
    var out = {};
    for (var name in fields) {
      var v = fields[name], type = typeOf(f, name);
      if (v === null || (Array.isArray(v) && !v.length) || v === "") out[name] = undefined;
      else if (type === 1 && typeof v === "string") out[name] = seg(v);
      else if (type === 17) out[name] = v.map(function (a) { return { file_token: a.file_token, name: a.file_token + ".pdf", size: 1000 }; });
      else out[name] = v;
    }
    return out;
  };
  var apply = function (f, rec, cells) {
    var read = toRead(f, cells);
    for (var k in read) { if (read[k] === undefined) delete rec.fields[k]; else rec.fields[k] = read[k]; }
    rec.fields["Last Modified"] = Date.now();
  };

  function service(url) {
    var host = new URL(url).host;
    if (/gemini|:8000$/.test(host)) {
      return fixture().then(function (f) { return reply(f.services.gemini, 120); });
    }
    return reply({ service: "lark-cors-proxy", version: "1.0.0", endpoints: ["/health", "/proxy?url=<lark_url>"] }, 120);
  }

  async function lark(url, init) {
    var target = decodeURIComponent(url.match(/\/proxy\?url=([^&]+)/)[1]);
    var method = (init && init.method) || "GET";
    var f = await fixture();
    if (/\/authen\/v1\/authorize/.test(target)) return new Response("<html>preview</html>", { status: 200 });
    if (/\/authen\/v1\/user_info/.test(target)) return reply({ code: 0, data: { name: "Preview Mode" } });
    if (/\/drive\/v1\/medias\/upload_all/.test(target)) return reply({ code: 0, data: { file_token: "preview-file-" + (++seq) } }, 600);
    var t = target.match(/\/tables\/(tbl[A-Za-z0-9]+)\/(fields|records)(\/[a-z_]+)?/);
    if (!t) return reply({ code: 99999, msg: "preview mode: no answer for " + target });
    var body = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
    var recs = f.records;
    if (t[2] === "fields") return reply({ code: 0, data: { items: f.fields, has_more: false } });
    var op = t[3] || "";
    var pick = function (r, names) {
      var fl = {};
      for (var n in r.fields) if (!names || names.indexOf(n) >= 0) fl[n] = r.fields[n];
      return { record_id: r.record_id, fields: fl };
    };
    if (op === "/search") return reply({ code: 0, data: { items: recs.map(function (r) { return pick(r, body.field_names); }), has_more: false, total: recs.length } }, 350);
    if (op === "/batch_get") return reply({ code: 0, data: { records: recs.filter(function (r) { return body.record_ids.indexOf(r.record_id) >= 0; }).map(function (r) { return pick(r); }) } });
    if (op === "/batch_update") {
      var changed = body.records.map(function (u) {
        var r = recs.find(function (x) { return x.record_id === u.record_id; });
        if (!r) return null;
        apply(f, r, u.fields);
        return pick(r);
      }).filter(Boolean);
      return reply({ code: 0, data: { records: changed } }, 400);
    }
    if (op === "/batch_delete") {
      f.records = recs.filter(function (r) { return body.records.indexOf(r.record_id) < 0; });
      return reply({ code: 0, data: { records: body.records.map(function (id) { return { deleted: true, record_id: id }; }) } }, 400);
    }
    if (op === "" && method === "POST") {
      var token = new URL(target).searchParams.get("client_token");
      if (token && tokens[token]) return reply({ code: 0, data: { record: pick(tokens[token]) } });
      var rec = { record_id: "recPreview" + (++seq) + Date.now().toString(36), fields: {} };
      apply(f, rec, body.fields);
      recs.push(rec);
      if (token) tokens[token] = rec;
      return reply({ code: 0, data: { record: pick(rec) } }, 500);
    }
    return reply({ code: 99999, msg: "preview mode: unsupported " + method + " " + target });
  }

  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : input.url;
    if (/\/proxy\?url=/.test(url)) return lark(url, init);
    // GET / of a service: not this page's own address, and nothing after the host.
    if (/^https?:\/\/[^/]+\/?$/.test(url) && new URL(url).origin !== location.origin) return service(url);
    return realFetch(input, init);
  };

  // The extraction service: POST /extract is an XHR (upload progress), so it's answered here too.
  var proto = XMLHttpRequest.prototype;
  var realOpen = proto.open, realSend = proto.send, realAbort = proto.abort;
  proto.open = function (method, url) {
    this._preview = /\/extract$/.test(url);
    if (!this._preview) return realOpen.apply(this, arguments);
    this._timers = [];
  };
  proto.setRequestHeader = (function (real) { return function () { if (!this._preview) return real.apply(this, arguments); }; })(proto.setRequestHeader);
  proto.send = function (body) {
    if (!this._preview) return realSend.apply(this, arguments);
    var xhr = this, size = 0;
    if (body && body.getAll) body.getAll("files").forEach(function (file) { size += file.size || 0; });
    var set = function (ms, fn) { xhr._timers.push(setTimeout(fn, ms)); };
    var progress = function (p) { if (xhr.upload.onprogress) xhr.upload.onprogress({ lengthComputable: true, loaded: p * 100, total: 100 }); };
    set(150, function () { progress(0.3); });
    set(400, function () { progress(0.7); });
    set(700, function () { progress(1); if (xhr.upload.onload) xhr.upload.onload(); });
    // Like the real service: one entry per uploaded file, and the text of plain-text files
    // ("Check sources" shows it). The fixture's evidence quotes tests/preview-sample.pdf as source 1.
    var files = body && body.getAll ? body.getAll("files") : [];
    var kindOf = function (f) {
      var n = (f.name || "").toLowerCase();
      return /\.pdf$/.test(n) ? "pdf" : /^image\//.test(f.type) ? "image" : /\.(txt|md|csv)$/.test(n) ? "text" : "docx";
    };
    var texts = Promise.all(files.map(function (f) { return kindOf(f) === "text" ? f.text() : null; }));
    set(3200, function () {
      Promise.all([fixture(), texts]).then(function (got) {
        var f = got[0];
        var brief = JSON.parse(JSON.stringify(f.extract.brief));
        brief.date_filed = dayMs(0).iso;
        brief.due_date = { date: dayMs(f.extract.dueInDays).iso, note: (brief.due_date && brief.due_date.note) || "" };
        var meta = JSON.parse(JSON.stringify(f.extract.meta));
        meta.sources = files.map(function (file) {
          var kind = kindOf(file);
          return { name: file.name, kind: kind, chars: 0, images: 0, has_blobs: kind === "pdf" || kind === "image", handling: "inline" };
        });
        meta.typed_text_chars = (body && body.get && body.get("text") || "").length;
        Object.defineProperty(xhr, "status", { value: 200, configurable: true });
        Object.defineProperty(xhr, "response", { value: { brief: brief, meta: meta, evidence: f.extract.evidence || [], texts: got[1] },
          configurable: true });
        xhr.getResponseHeader = function () { return null; };
        if (xhr.onload) xhr.onload();
      });
    });
  };
  proto.abort = function () {
    if (!this._preview) return realAbort.apply(this, arguments);
    this._timers.forEach(clearTimeout);
    if (this.onabort) this.onabort();
  };

  document.addEventListener("DOMContentLoaded", function () {
    var b = document.createElement("div");
    b.className = "override-badge";   // the top bar's red badge (theme tokens), pinned bottom-left
    b.textContent = "Preview mode: sample data, nothing is sent anywhere";
    b.style.cssText = "position:fixed;left:12px;bottom:12px;z-index:200;box-shadow:var(--shadow-md);pointer-events:none";
    document.body.appendChild(b);
  });
})();
