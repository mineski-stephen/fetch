"""
Offline tests for the Gemini brief proxy. Gemini itself is mocked.

    cd render/gemini-pdf
    python -m unittest discover -s tests -v
"""
import datetime as dt
import io
import json
import os
import sys
import threading
import unittest
import urllib.error
import urllib.request
import zipfile
from http.server import ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("GEMINI_API_KEY", "test-key")

import brief_spec  # noqa: E402
import extractors  # noqa: E402
import gemini_client  # noqa: E402
import gemini_proxy  # noqa: E402
from gemini_client import Client, GeminiError  # noqa: E402

TODAY = dt.date(2026, 10, 2)


def multipart(fields=(), files=()):
    boundary = "----TestBoundary7MA4YWxkTrZu0gW"
    out = io.BytesIO()
    for name, value in fields:
        out.write(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    for name, filename, ctype, data in files:
        out.write(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; '
                  f'filename="{filename}"\r\nContent-Type: {ctype}\r\n\r\n'.encode("utf-8"))
        out.write(data + b"\r\n")
    out.write(f"--{boundary}--\r\n".encode())
    return f"multipart/form-data; boundary={boundary}", out.getvalue()


def make_zip(entries):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, data in entries.items():
            z.writestr(name, data)
    return buf.getvalue()


W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'


class MultipartTests(unittest.TestCase):
    def test_binary_roundtrip_and_unicode_filename(self):
        blob = bytes(range(256)) * 50 + b"\r\n--not-a-boundary\r\n" + os.urandom(4096)
        ctype, body = multipart([("text", "Hello — brief"), ("today", "2026-10-02")],
                                [("files", "Brief Ñoño 2026.pdf", "application/pdf", blob)])
        fields, files = gemini_proxy.parse_multipart(ctype, body)
        self.assertEqual(fields["text"], "Hello — brief")
        self.assertEqual(files[0].filename, "Brief Ñoño 2026.pdf")
        self.assertEqual(files[0].data, blob)

    def test_missing_boundary(self):
        with self.assertRaises(gemini_proxy.ApiError):
            gemini_proxy.parse_multipart("multipart/form-data", b"")


class ExtractorTests(unittest.TestCase):
    def test_sniff_by_bytes(self):
        self.assertEqual(extractors.sniff(b"%PDF-1.7 ...", "x.bin"), "pdf")
        self.assertEqual(extractors.sniff(b"\x89PNG\r\n\x1a\n....", "x"), "png")
        self.assertEqual(extractors.sniff(b"\x00\x00\x00\x18ftypheic....", "IMG.HEIC"), "heic")
        self.assertEqual(extractors.sniff(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1", "old.doc"), "ole")

    def test_docx_text_tables_and_lists(self):
        doc = (f'<w:document {W_NS}><w:body>'
               '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Campus Tour</w:t></w:r></w:p>'
               '<w:p><w:pPr><w:numPr/></w:pPr><w:r><w:t>Reach 50 schools</w:t></w:r></w:p>'
               '<w:p><w:r><w:t xml:space="preserve">Budget: </w:t></w:r><w:del><w:r><w:delText>PHP 1M</w:delText></w:r></w:del>'
               '<w:ins><w:r><w:t>PHP 2M</w:t></w:r></w:ins></w:p>'
               '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Venue</w:t></w:r></w:p></w:tc>'
               '<w:tc><w:p><w:r><w:t>SMX Manila</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
               '</w:body></w:document>')
        src = extractors.process("brief.docx", make_zip({"word/document.xml": doc}))
        text = src.parts[0][1]
        self.assertEqual(src.kind, "docx")
        self.assertIn("## Campus Tour", text)
        self.assertIn("- Reach 50 schools", text)
        self.assertIn("Budget: PHP 2M", text)
        self.assertNotIn("PHP 1M", text)
        self.assertIn("| Venue | SMX Manila |", text)

    def test_pptx_slide_order_and_notes(self):
        a = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
        p = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
        r = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
        rel = "http://schemas.openxmlformats.org/package/2006/relationships"
        slide = lambda t: f'<p:sld {a} {p}><a:p><a:r><a:t>{t}</a:t></a:r></a:p></p:sld>'
        entries = {
            "ppt/presentation.xml": f'<p:presentation {p} {r}><p:sldIdLst><p:sldId r:id="rId2"/>'
                                    f'<p:sldId r:id="rId1"/></p:sldIdLst></p:presentation>',
            "ppt/_rels/presentation.xml.rels": f'<Relationships xmlns="{rel}">'
                                               '<Relationship Id="rId1" Target="slides/slide1.xml" Type="x/slide"/>'
                                               '<Relationship Id="rId2" Target="slides/slide2.xml" Type="x/slide"/>'
                                               '</Relationships>',
            "ppt/slides/slide1.xml": slide("Second in order"),
            "ppt/slides/slide2.xml": slide("First in order"),
            "ppt/slides/_rels/slide1.xml.rels": f'<Relationships xmlns="{rel}"><Relationship Id="n" '
                                                'Target="../notesSlides/notesSlide1.xml" Type="x/notesSlide"/></Relationships>',
            "ppt/notesSlides/notesSlide1.xml": slide("Mention the finals"),
        }
        text = extractors.process("deck.pptx", make_zip(entries)).parts[0][1]
        self.assertLess(text.index("First in order"), text.index("Second in order"))
        self.assertIn("Speaker notes: Mention the finals", text)

    def test_xlsx_shared_strings(self):
        s = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
        r = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
        rel = "http://schemas.openxmlformats.org/package/2006/relationships"
        entries = {
            "xl/workbook.xml": f'<workbook {s} {r}><sheets><sheet name="Budget" r:id="rId1"/></sheets></workbook>',
            "xl/_rels/workbook.xml.rels": f'<Relationships xmlns="{rel}"><Relationship Id="rId1" '
                                          'Target="worksheets/sheet1.xml" Type="x"/></Relationships>',
            "xl/sharedStrings.xml": f'<sst {s}><si><t>Item</t></si><si><t>Production</t></si></sst>',
            "xl/worksheets/sheet1.xml": f'<worksheet {s}><sheetData><row><c t="s"><v>0</v></c><c><v>2500000</v></c></row>'
                                        '<row><c t="s"><v>1</v></c><c t="inlineStr"><is><t>TBC</t></is></c></row>'
                                        '</sheetData></worksheet>',
        }
        text = extractors.process("budget.xlsx", make_zip(entries)).parts[0][1]
        self.assertIn("## Sheet: Budget", text)
        self.assertIn("Item | 2500000", text)
        self.assertIn("Production | TBC", text)

    def test_rtf_html_and_text(self):
        rtf = rb"{\rtf1\ansi{\fonttbl{\f0 Arial;}}\f0 Client: Acme\par Budget: \'80 5,000\par}"
        self.assertEqual(extractors.process("b.rtf", rtf).parts[0][1], "Client: Acme\nBudget: € 5,000")
        page = b"<html><head><style>x{}</style></head><body><h1>Brief</h1><ul><li>One</li></ul></body></html>"
        text = extractors.process("b.html", page).parts[0][1]
        self.assertIn("Brief", text)
        self.assertIn("- One", text)
        self.assertNotIn("x{}", text)
        self.assertEqual(extractors.process("notes.txt", "Café brief".encode("cp1252")).parts[0][1], "Café brief")

    def test_eml_with_attachment(self):
        from email.message import EmailMessage
        msg = EmailMessage()
        msg["From"], msg["Subject"] = "client@brand.com", "RFP: Esports Cup"
        msg.set_content("Please see the attached brief.")
        msg.add_attachment(b"%PDF-1.4 fake", maintype="application", subtype="pdf", filename="rfp.pdf")
        src = extractors.process("mail.eml", msg.as_bytes())
        self.assertIn("Subject: RFP: Esports Cup", src.parts[0][1])
        self.assertTrue(any(p[0] == "blob" and p[1] == "application/pdf" for p in src.parts))

    def test_unsupported_formats_have_friendly_messages(self):
        with self.assertRaisesRegex(extractors.UnsupportedFile, "save it as PDF"):
            extractors.process("old.doc", b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\x00" * 100)
        with self.assertRaisesRegex(extractors.UnsupportedFile, "unzip"):
            extractors.process("bundle.zip", make_zip({"a.txt": "x"}))
        with self.assertRaisesRegex(extractors.UnsupportedFile, "empty"):
            extractors.process("empty.pdf", b"")


class NormalizeTests(unittest.TestCase):
    def test_fills_missing_fields_and_enforces_enums(self):
        out = brief_spec.normalize({"client_name": "Acme", "budget": {"amount": "PHP 2M", "type": "unclear"},
                                    "objectives": ["- Grow awareness", "grow awareness", ""],
                                    "due_date": {"date": "2026-10-10T17:00", "note": "5 PM"},
                                    "proposal_submission": {"type": "pitch deck"}}, TODAY)
        self.assertEqual(out["date_filed"], "2026-10-02")
        self.assertEqual(out["project_title"], "Acme Project")
        self.assertTrue(out["project_title_is_placeholder"])
        self.assertEqual(out["objectives"], ["Grow awareness"])
        self.assertEqual(out["budget"]["type"], "TO BE CONFIRMED")
        self.assertEqual(out["proposal_submission"]["type"], "PITCH / PRESENTATION")
        self.assertEqual(out["due_date"], {"date": "2026-10-10", "note": "5 PM"})
        self.assertEqual(out["venue"], brief_spec.NOT_SPECIFIED)

    def test_no_budget_means_not_specified(self):
        out = brief_spec.normalize({"budget": {"amount": "n/a", "type": "ALL-IN"}}, TODAY)
        self.assertEqual(out["budget"], {"amount": "Not specified", "type": "NOT SPECIFIED"})
        self.assertEqual(out["due_date"], {"date": "", "note": "Not specified"})

    def test_parse_model_json_tolerates_fences(self):
        self.assertEqual(brief_spec.parse_model_json('```json\n{"a": 1}\n```'), {"a": 1})
        self.assertEqual(brief_spec.parse_model_json('Here you go: {"a": 2}'), {"a": 2})

    def test_prompt_has_date(self):
        self.assertIn("2 Oct 2026 (Friday)", brief_spec.system_prompt(TODAY))


class SharedKeyTests(unittest.TestCase):
    def test_env_names_case_insensitive_and_quotes_stripped(self):
        key, source = gemini_proxy.load_shared_key({"gemini_api_key": ' "AIzaSyShared_1234567890" '}, files=())
        self.assertEqual(key, "AIzaSyShared_1234567890")
        self.assertIn("gemini_api_key", source)
        self.assertNotIn("AIza", source)

    def test_alternate_names_in_priority_order(self):
        env = {"API_KEY": "generic-fallback", "GOOGLE_API_KEY": "google-key"}
        self.assertEqual(gemini_proxy.load_shared_key(env, files=())[0], "google-key")

    def test_secret_file_and_nothing_found(self):
        import tempfile
        with tempfile.NamedTemporaryFile("w", suffix="_GEMINI_API_KEY", delete=False) as f:
            f.write("AIzaSyFromSecretFile_123\n")
        try:
            key, source = gemini_proxy.load_shared_key({"GEMINI_API_KEY": "  "}, files=("/no/such/file", f.name))
            self.assertEqual(key, "AIzaSyFromSecretFile_123")
            self.assertIn("secret file", source)
        finally:
            os.unlink(f.name)
        self.assertEqual(gemini_proxy.load_shared_key({}, files=()), ("", ""))


class ClientTests(unittest.TestCase):
    def setUp(self):
        gemini_client._cooldown.clear()
        gemini_client._model_cache.clear()

    def test_discovers_only_flash_lite_models_newest_first(self):
        c = Client("key-a", "auto", "auto")
        listing = {"models": [
            {"name": f"models/{n}", "supportedGenerationMethods": ["generateContent"]}
            for n in ("gemini-3.8-flash", "gemini-3.1-flash-lite", "gemini-3.5-flash-lite",
                      "gemini-3.1-flash-lite-preview", "gemini-3.8-flash-lite-tts", "gemini-flash-lite-latest")]}
        c._request = lambda *a, **k: (200, {}, json.dumps(listing).encode())
        self.assertEqual(c.candidate_models(), ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"])
        explicit = Client("key-a", "gemini-3.1-flash-lite", "auto")
        self.assertEqual(explicit.candidate_models(), ["gemini-3.1-flash-lite", "gemini-3.5-flash-lite"])

    def test_discovery_failure_uses_alias(self):
        c = Client("key-b", "auto", "auto")
        c._request = lambda *a, **k: (500, {}, b"{}")
        self.assertEqual(c.candidate_models(), [gemini_client.FALLBACK_ALIAS])

    def test_quota_on_every_model_is_reported_as_quota(self):
        c = Client("k", "m1", "m2")

        def gen(model, body, timeout):
            raise GeminiError("Quota exceeded for metric generate_content_free_tier_requests", "model", 429)
        c.generate = gen
        with self.assertRaises(GeminiError) as ctx:
            c.generate_with_fallback({}, json.loads, gemini_client.time.time() + 100)
        self.assertEqual(ctx.exception.kind, "quota")

    def test_overloaded_model_falls_back_and_cools_down(self):
        c = Client("k", "m1", "m2,m3")
        calls = []

        def gen(model, body, timeout):
            calls.append(model)
            if model == "m1":
                raise GeminiError("high demand", "retryable", 503)
            return '{"ok": 1}', {}, model
        c.generate = gen
        delays, gemini_client.RETRY_DELAYS = gemini_client.RETRY_DELAYS, (0,)
        try:
            result, info = c.generate_with_fallback({}, json.loads, gemini_client.time.time() + 100)
            c.generate_with_fallback({}, json.loads, gemini_client.time.time() + 100)
        finally:
            gemini_client.RETRY_DELAYS = delays
        self.assertEqual(result, {"ok": 1})
        self.assertEqual(info["model"], "m2")
        self.assertEqual(calls, ["m1", "m1", "m2", "m2"])  # 2nd request skips the cooling model
        self.assertEqual(c.candidate_models(), ["m2", "m3", "m1"])

    def test_config_errors_do_not_fall_back(self):
        c = Client("k", "m1", "m2")
        calls = []

        def gen(model, body, timeout):
            calls.append(model)
            raise GeminiError("API key not valid", "config", 400)
        c.generate = gen
        with self.assertRaises(GeminiError):
            c.generate_with_fallback({}, json.loads, gemini_client.time.time() + 100)
        self.assertEqual(calls, ["m1"])


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), gemini_proxy.Handler)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.calls, cls.keys = [], []
        cls.generate = staticmethod(lambda model, body, timeout: (
            json.dumps({"client_name": "Acme Corp", "project_title": "Acme Cup", "objectives": ["Grow awareness"]}),
            {"promptTokenCount": 10}, model))

        def fake_make_client(key):
            cls.keys.append(key)
            c = Client(key, "gemini-test", "none-needed")
            c.candidate_models = lambda: ["gemini-test"]

            def gen(model, body, timeout):
                cls.calls.append(body)
                return cls.generate(model, body, timeout)
            c.generate = gen
            return c
        gemini_proxy.make_client = fake_make_client

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def post(self, ctype, body, origin=None, key=None):
        req = urllib.request.Request(self.base + "/extract", data=body, method="POST")
        req.add_header("Content-Type", ctype)
        if origin:
            req.add_header("Origin", origin)
        if key:
            req.add_header("X-Gemini-Api-Key", key)
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, dict(r.headers), json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), json.loads(e.read())

    def test_health(self):
        with urllib.request.urlopen(self.base + "/health") as r:
            self.assertEqual(json.loads(r.read())["status"], "ok")
            self.assertEqual(r.headers["Access-Control-Allow-Origin"], "*")

    def test_extract_happy_path(self):
        ctype, body = multipart([("text", "Acme wants an esports cup"), ("today", "2026-10-02")],
                                [("files", "brief.pdf", "application/pdf", b"%PDF-1.4 tiny")])
        status, _, data = self.post(ctype, body)
        self.assertEqual(status, 200, data)
        self.assertEqual(data["brief"]["client_name"], "Acme Corp")
        self.assertEqual(data["brief"]["schema_version"], 1)
        self.assertEqual(data["meta"]["sources"][0]["kind"], "pdf")
        sent = self.calls[-1]
        parts = sent["contents"][0]["parts"]
        self.assertEqual(parts[1]["inlineData"]["mimeType"], "application/pdf")
        self.assertIn("Acme wants an esports cup", parts[2]["text"])
        self.assertEqual(sent["generationConfig"]["responseMimeType"], "application/json")

    def test_no_input(self):
        ctype, body = multipart([("text", "   ")])
        self.assertEqual(self.post(ctype, body)[2]["error"]["code"], "no_input")

    def test_unsupported_file_is_422(self):
        ctype, body = multipart(files=[("files", "old.ppt", "application/vnd.ms-powerpoint",
                                        b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\x00" * 64)])
        status, _, data = self.post(ctype, body)
        self.assertEqual(status, 422)
        self.assertIn("PowerPoint 97-2003", data["error"]["message"])

    def test_user_key_is_used_and_cors_allows_header(self):
        status, _, data = self.post(*multipart([("text", "brief")]), key="AIzaSyUserProvidedKey_1234567890abc")
        self.assertEqual(status, 200, data)
        self.assertEqual(self.keys[-1], "AIzaSyUserProvidedKey_1234567890abc")
        req = urllib.request.Request(self.base + "/extract", method="OPTIONS")
        with urllib.request.urlopen(req) as r:
            self.assertIn("X-Gemini-Api-Key", r.headers["Access-Control-Allow-Headers"])

    def test_malformed_user_key_is_400(self):
        status, _, data = self.post(*multipart([("text", "brief")]), key="not a key!")
        self.assertEqual((status, data["error"]["code"]), (400, "invalid_api_key"))

    def test_no_key_anywhere_is_not_configured(self):
        shared, gemini_proxy.API_KEY = gemini_proxy.API_KEY, ""
        try:
            status, _, data = self.post(*multipart([("text", "brief")]))
        finally:
            gemini_proxy.API_KEY = shared
        self.assertEqual((status, data["error"]["code"]), (503, "not_configured"))
        self.assertIn("Settings", data["error"]["message"])

    def test_rejected_user_key_is_401(self):
        original = ServerTests.generate

        def rejected(*_):
            raise GeminiError("API key not valid. Please pass a valid API key.", "config", 400)
        ServerTests.generate = staticmethod(rejected)
        try:
            status, _, data = self.post(*multipart([("text", "brief")]), key="AIzaSyUserProvidedKey_1234567890abc")
        finally:
            ServerTests.generate = original
        self.assertEqual((status, data["error"]["code"]), (401, "invalid_api_key"))

    def test_gemini_overload_maps_to_503(self):
        original = ServerTests.generate

        def overloaded(*_):
            raise GeminiError("overloaded", "retryable", 503)
        ServerTests.generate = staticmethod(overloaded)
        delays, gemini_client.RETRY_DELAYS = gemini_client.RETRY_DELAYS, (0,)
        try:
            status, headers, data = self.post(*multipart([("text", "brief")]))
        finally:
            ServerTests.generate = original
            gemini_client.RETRY_DELAYS = delays
        self.assertEqual(status, 503)
        self.assertEqual(data["error"]["code"], "upstream_unavailable")
        self.assertIn("Retry-After", headers)


if __name__ == "__main__":
    unittest.main()
