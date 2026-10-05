"""
Turn any uploaded file into parts Gemini can read.

Gemini reads PDFs, images, plain text, audio and video natively. Office
documents (DOCX/PPTX/XLSX), OpenDocument files, RTF, HTML and e-mails are not
accepted as-is, so they are converted to text here (plus any sizeable embedded
images, which often carry the real content of a deck).

Standard library only. File types are detected from the bytes first and the
file name second; the browser's declared MIME type is only a last resort.
"""
import codecs
import email
import html.parser
import io
import posixpath
import re
import zipfile
import xml.etree.ElementTree as ET
from email import policy

MAX_SOURCE_CHARS = 400_000         # text kept per file
MAX_EMBEDDED_IMAGES = 8            # images pulled out of one Office file / e-mail
MIN_EMBEDDED_IMAGE_BYTES = 20_000  # smaller ones are usually logos and icons
MAX_EMBEDDED_IMAGE_BYTES = 7 * 1024 * 1024
MAX_SHEET_ROWS = 3000
MAX_ZIP_ENTRY_BYTES = 80 * 1024 * 1024  # zip-bomb guard for any single XML part


class UnsupportedFile(Exception):
    """Raised with a user-facing message when a file can't be used."""


class Source:
    """One uploaded file, reduced to an ordered list of Gemini parts."""

    def __init__(self, name, kind, label):
        self.name, self.kind, self.label = name, kind, label
        self.parts = []      # ("text", str) or ("blob", mime, bytes)
        self.chars = 0
        self.images = 0

    def add_text(self, text):
        text = (text or "").strip()
        if not text:
            return
        room = MAX_SOURCE_CHARS - self.chars
        if room <= 0:
            return
        if len(text) > room:
            text = text[:room] + "\n[… truncated: file too long]"
        self.chars += len(text)
        self.parts.append(("text", text))

    def add_blob(self, mime, data):
        self.parts.append(("blob", mime, data))
        if mime.startswith("image/"):
            self.images += 1

    def describe(self):
        return {"name": self.name, "kind": self.kind, "chars": self.chars, "images": self.images}


# ---- type detection ---------------------------------------------------------

IMAGE_MIME = {"png": "image/png", "jpeg": "image/jpeg", "webp": "image/webp",
              "heic": "image/heic", "heif": "image/heif"}
AUDIO_EXT = {".mp3": "audio/mp3", ".wav": "audio/wav", ".aac": "audio/aac", ".ogg": "audio/ogg",
             ".oga": "audio/ogg", ".flac": "audio/flac", ".aif": "audio/aiff", ".aiff": "audio/aiff",
             ".m4a": "audio/mp4", ".opus": "audio/ogg"}
VIDEO_EXT = {".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
             ".mpeg": "video/mpeg", ".mpg": "video/mpeg", ".avi": "video/avi", ".wmv": "video/wmv",
             ".3gp": "video/3gpp", ".flv": "video/x-flv"}
TEXT_EXT = {".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".xml", ".yaml", ".yml", ".log",
            ".srt", ".vtt", ".ini"}
HTML_EXT = {".html", ".htm", ".xhtml", ".mht"}
LEGACY_OFFICE = {".doc": "Word 97-2003 (.doc)", ".xls": "Excel 97-2003 (.xls)",
                 ".ppt": "PowerPoint 97-2003 (.ppt)", ".msg": "Outlook message (.msg)"}

HEIC_BRANDS = {b"heic", b"heix", b"hevc", b"hevx", b"heim", b"heis", b"hevm", b"hevs", b"mif1", b"msf1"}


def _ext(name):
    return posixpath.splitext((name or "").lower())[1]


def sniff(data, name="", declared=""):
    """Return a coarse kind string for the file's bytes."""
    head = data[:64]
    ext = _ext(name)
    if b"%PDF-" in data[:1024]:
        return "pdf"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if head.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    if head[:4] == b"RIFF" and head[8:12] == b"WAVE":
        return "audio"
    if head[:4] == b"RIFF" and head[8:12] == b"AVI ":
        return "video"
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    if head[4:8] == b"ftyp":
        brand = head[8:12]
        if brand in HEIC_BRANDS:
            return "heic"
        if brand in (b"avif", b"avis"):
            return "avif"
        if brand.startswith(b"M4A") or ext in AUDIO_EXT:
            return "audio"
        return "video"
    if head.startswith(b"PK\x03\x04"):
        return "zip"
    if head.startswith(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"):
        return "ole"
    if head.startswith(b"{\\rtf"):
        return "rtf"
    if head.startswith((b"ID3", b"OggS", b"fLaC")) or head[:4] == b"FORM" or ext in AUDIO_EXT:
        return "audio"
    if head.startswith(b"\x1a\x45\xdf\xa3") or ext in VIDEO_EXT:
        return "video"
    if ext in (".eml", ".mht") or declared == "message/rfc822":
        return "eml"
    if ext in HTML_EXT or declared == "text/html":
        return "html"
    if ext in (".bmp", ".tif", ".tiff", ".svg", ".ico") or declared.startswith("image/"):
        return "other-image"
    return "text"  # verified by decode_text() below


def decode_text(data):
    """Decode bytes that should be text, or return None if they look binary."""
    if data.startswith(codecs.BOM_UTF8):
        return data[3:].decode("utf-8", "replace")
    if data.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)):
        return data.decode("utf-16", "replace")
    if b"\x00" in data[:8192]:
        return None
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        text = data.decode("cp1252", "replace")
        sample = text[:8192]
        printable = sum(c.isprintable() or c in "\r\n\t" for c in sample)
        return text if not sample or printable / len(sample) > 0.9 else None


# ---- entry point ------------------------------------------------------------

def process(name, data, declared="", depth=0):
    """Convert one upload into a Source, or raise UnsupportedFile."""
    name = name or "untitled"
    if not data:
        raise UnsupportedFile(f"“{name}” is empty.")
    ext = _ext(name)
    kind = sniff(data, name, declared)

    if kind == "pdf":
        src = Source(name, "pdf", "PDF document")
        src.add_blob("application/pdf", data)
        return src
    if kind in IMAGE_MIME:
        src = Source(name, "image", "image / screenshot")
        src.add_blob(IMAGE_MIME[kind], data)
        return src
    if kind == "audio":
        src = Source(name, "audio", "audio recording")
        src.add_blob(AUDIO_EXT.get(ext, "audio/mp3" if data[:3] == b"ID3" else _audio_mime(data)), data)
        return src
    if kind == "video":
        src = Source(name, "video", "video")
        src.add_blob(VIDEO_EXT.get(ext, "video/mp4"), data)
        return src
    if kind == "zip":
        return _process_zip(name, data)
    if kind == "ole" or ext in LEGACY_OFFICE:
        what = LEGACY_OFFICE.get(ext, "older Office format")
        raise UnsupportedFile(f"“{name}” is an {what} file, which can't be read directly. "
                              "Open it and save it as PDF (or .docx / .pptx / .xlsx), then upload that.")
    if kind in ("gif", "avif", "other-image"):
        raise UnsupportedFile(f"“{name}” is an image format Gemini doesn't accept. "
                              "Please upload it as PNG or JPG.")
    if kind == "rtf":
        src = Source(name, "rtf", "rich-text document")
        src.add_text(rtf_to_text(data.decode("latin-1")))
        return _require_text(src)
    if kind == "eml":
        return _process_eml(name, data, depth)

    text = decode_text(data)
    if text is None:
        raise UnsupportedFile(f"“{name}” isn't a format that can be read. "
                              "Try PDF, Word, PowerPoint, Excel, an image or plain text.")
    if kind == "html" or (ext not in TEXT_EXT and re.match(r"\s*<(!doctype html|html)", text[:200], re.I)):
        src = Source(name, "html", "web page / HTML")
        src.add_text(html_to_text(text))
    else:
        src = Source(name, "text", "text file")
        src.add_text(text)
    return _require_text(src)


def _audio_mime(data):
    if data[:4] == b"OggS":
        return "audio/ogg"
    if data[:4] == b"fLaC":
        return "audio/flac"
    if data[:4] == b"FORM":
        return "audio/aiff"
    if data[:4] == b"RIFF":
        return "audio/wav"
    return "audio/mp3"


def _require_text(src):
    if not src.parts:
        raise UnsupportedFile(f"“{src.name}” doesn't contain any readable text.")
    return src


# ---- Office Open XML / OpenDocument -----------------------------------------

def _read_xml(z, path):
    info = z.getinfo(path)
    if info.file_size > MAX_ZIP_ENTRY_BYTES:
        raise UnsupportedFile("A part of this document is too large to read.")
    return ET.fromstring(z.read(path))


def _process_zip(name, data):
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
        names = set(z.namelist())
    except zipfile.BadZipFile:
        raise UnsupportedFile(f"“{name}” looks damaged and couldn't be opened.")
    try:
        if "word/document.xml" in names:
            src = Source(name, "docx", "Word document")
            src.add_text(_docx_text(z))
            _add_media(src, z, "word/media/")
        elif "ppt/presentation.xml" in names:
            src = Source(name, "pptx", "PowerPoint deck")
            src.add_text(_pptx_text(z, names))
            _add_media(src, z, "ppt/media/")
        elif "xl/workbook.xml" in names:
            src = Source(name, "xlsx", "Excel workbook")
            src.add_text(_xlsx_text(z, names))
        elif "content.xml" in names and "mimetype" in names:
            mimetype = z.read("mimetype").decode("ascii", "ignore")
            label = {"text": "OpenDocument text", "presentation": "OpenDocument slides",
                     "spreadsheet": "OpenDocument spreadsheet"}.get(mimetype.rsplit(".", 1)[-1], "OpenDocument file")
            src = Source(name, "odf", label)
            src.add_text(_odf_text(z))
            _add_media(src, z, "Pictures/")
        else:
            raise UnsupportedFile(f"“{name}” is a ZIP archive. Please unzip it and upload the files inside.")
    except (ET.ParseError, KeyError, zipfile.BadZipFile) as e:
        raise UnsupportedFile(f"“{name}” couldn't be read ({type(e).__name__}). Try saving it as PDF.")
    if not src.parts:
        raise UnsupportedFile(f"“{name}” doesn't contain any readable text or images.")
    return src


def _add_media(src, z, prefix):
    """Attach the larger embedded PNG/JPEG/WEBP images (decks often are images)."""
    found = []
    for info in z.infolist():
        if not info.filename.startswith(prefix):
            continue
        ext = _ext(info.filename)
        mime = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}.get(ext)
        if mime and MIN_EMBEDDED_IMAGE_BYTES <= info.file_size <= MAX_EMBEDDED_IMAGE_BYTES:
            found.append((info.file_size, info.filename, mime))
    largest = sorted(found, reverse=True)[:MAX_EMBEDDED_IMAGES]
    for _, filename, mime in sorted(largest, key=lambda f: _natural_key(f[1])):
        src.add_blob(mime, z.read(filename))


def _natural_key(s):
    return [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", s)]


# DOCX
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
MC_FALLBACK = "{http://schemas.openxmlformats.org/markup-compatibility/2006}Fallback"


def _docx_text(z):
    body = _read_xml(z, "word/document.xml").find(W + "body")
    lines = []
    if body is not None:
        _docx_walk(body, lines)
    return "\n".join(lines)


def _docx_walk(el, out):
    for child in el:
        if child.tag == MC_FALLBACK:  # duplicate of mc:Choice content
            continue
        if child.tag == W + "p":
            out.extend(_docx_para(child))
        elif child.tag == W + "tbl":
            out.extend(_docx_table(child))
        else:
            _docx_walk(child, out)


def _docx_para(p):
    buf, boxes = [], []

    def rec(el):
        for c in el:
            t = c.tag
            if t in (MC_FALLBACK, W + "delText", W + "pPr"):
                continue
            if t == W + "txbxContent":
                _docx_walk(c, boxes)
                continue
            if t == W + "t":
                buf.append(c.text or "")
            elif t == W + "tab":
                buf.append("\t")
            elif t in (W + "br", W + "cr"):
                buf.append("\n")
            rec(c)

    rec(p)
    text = "".join(buf).strip()
    lines = []
    if text:
        ppr = p.find(W + "pPr")
        style = ppr.find(W + "pStyle") if ppr is not None else None
        style = (style.get(W + "val") or "") if style is not None else ""
        if re.match(r"(?i)(heading|title)", style):
            text = "## " + text
        elif ppr is not None and ppr.find(W + "numPr") is not None:
            text = "- " + text
        lines.append(text)
    return lines + boxes


def _docx_table(tbl):
    rows = []
    for tr in tbl.iter(W + "tr"):
        cells = []
        for tc in tr.findall(W + "tc"):
            inner = []
            _docx_walk(tc, inner)
            cells.append(" / ".join(s for s in inner if s))
        if any(cells):
            rows.append("| " + " | ".join(cells) + " |")
    return rows


# PPTX
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
P = "{http://schemas.openxmlformats.org/presentationml/2006/main}"
R_ID = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
REL = "{http://schemas.openxmlformats.org/package/2006/relationships}Relationship"


def _rels(z, path):
    """Map relationship Id -> (absolute target path, type) for an OOXML part."""
    folder, base = posixpath.split(path)
    rels_path = posixpath.join(folder, "_rels", base + ".rels")
    out = {}
    if rels_path in z.namelist():
        for rel in _read_xml(z, rels_path).iter(REL):
            target = rel.get("Target", "")
            target = target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join(folder, target))
            out[rel.get("Id")] = (target, rel.get("Type", ""))
    return out


def _drawing_paragraphs(root):
    lines = []
    for p in root.iter(A + "p"):
        parts = []
        for el in p.iter():
            if el.tag == A + "t":
                parts.append(el.text or "")
            elif el.tag == A + "br":
                parts.append("\n")
        text = "".join(parts).strip()
        if text:
            lines.append(text)
    return lines


def _pptx_text(z, names):
    rels = _rels(z, "ppt/presentation.xml")
    order = []
    for sld in _read_xml(z, "ppt/presentation.xml").iter(P + "sldId"):
        target = rels.get(sld.get(R_ID), (None, ""))[0]
        if target in names:
            order.append(target)
    if not order:
        order = sorted((n for n in names if re.match(r"ppt/slides/slide\d+\.xml$", n)), key=_natural_key)

    out = []
    for i, path in enumerate(order, 1):
        lines = _drawing_paragraphs(_read_xml(z, path))
        notes = []
        for target, rtype in _rels(z, path).values():
            if rtype.endswith("/notesSlide") and target in names:
                notes = [l for l in _drawing_paragraphs(_read_xml(z, target)) if not l.isdigit()]
        block = [f"## Slide {i}"] + lines
        if notes:
            block.append("Speaker notes: " + " ".join(notes))
        out.append("\n".join(block))
    return "\n\n".join(out)


# XLSX
S = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def _xlsx_text(z, names):
    shared = []
    if "xl/sharedStrings.xml" in names:
        for si in _read_xml(z, "xl/sharedStrings.xml").iter(S + "si"):
            shared.append("".join(t.text or "" for t in si.iter(S + "t")))

    rels = _rels(z, "xl/workbook.xml")
    out = []
    for sheet in _read_xml(z, "xl/workbook.xml").iter(S + "sheet"):
        if sheet.get("state") in ("hidden", "veryHidden"):
            continue
        path = rels.get(sheet.get(R_ID), (None, ""))[0]
        if path not in names:
            continue
        rows = []
        for row in _read_xml(z, path).iter(S + "row"):
            cells = []
            for c in row.iter(S + "c"):
                t, v = c.get("t"), c.find(S + "v")
                if t == "inlineStr":
                    val = "".join(x.text or "" for x in c.iter(S + "t"))
                elif v is None or v.text is None:
                    val = ""
                elif t == "s":
                    idx = int(v.text)
                    val = shared[idx] if idx < len(shared) else ""
                elif t == "b":
                    val = "TRUE" if v.text == "1" else "FALSE"
                else:
                    val = v.text
                cells.append(val.strip())
            while cells and not cells[-1]:
                cells.pop()
            if any(cells):
                rows.append(" | ".join(cells))
            if len(rows) >= MAX_SHEET_ROWS:
                rows.append("[… more rows truncated]")
                break
        if rows:
            out.append(f"## Sheet: {sheet.get('name')}\n" + "\n".join(rows))
    return "\n\n".join(out)


# OpenDocument (ODT / ODP / ODS)
ODF_TEXT = "{urn:oasis:names:tc:opendocument:xmlns:text:1.0}"
ODF_TABLE = "{urn:oasis:names:tc:opendocument:xmlns:table:1.0}"
ODF_DRAW = "{urn:oasis:names:tc:opendocument:xmlns:drawing:1.0}"


def _odf_text(z):
    out = []

    def walk(el):
        for c in el:
            if c.tag in (ODF_TEXT + "p", ODF_TEXT + "h"):
                text = "".join(c.itertext()).strip()
                if text:
                    out.append(("## " if c.tag == ODF_TEXT + "h" else "") + text)
            elif c.tag == ODF_TABLE + "table-row":
                cells = [" ".join("".join(cell.itertext()).split())
                         for cell in c if cell.tag == ODF_TABLE + "table-cell"]
                while cells and not cells[-1]:
                    cells.pop()
                if any(cells):
                    out.append(" | ".join(cells))
            elif c.tag == ODF_TABLE + "table":
                out.append(f"## Sheet: {c.get(ODF_TABLE + 'name', '')}")
                walk(c)
            elif c.tag == ODF_DRAW + "page":
                out.append(f"## Slide: {c.get(ODF_DRAW + 'name', '')}")
                walk(c)
            else:
                walk(c)

    walk(_read_xml(z, "content.xml"))
    return "\n".join(out)


# ---- e-mail -----------------------------------------------------------------

def _process_eml(name, data, depth):
    msg = email.message_from_bytes(data, policy=policy.default)
    src = Source(name, "email", "e-mail")
    header = "\n".join(f"{h}: {msg[h]}" for h in ("From", "To", "Cc", "Date", "Subject") if msg[h])
    body = msg.get_body(preferencelist=("plain", "html"))
    text = ""
    if body is not None:
        try:
            text = body.get_content()
        except (LookupError, ValueError):
            text = (body.get_payload(decode=True) or b"").decode("utf-8", "replace")
        if body.get_content_type() == "text/html":
            text = html_to_text(text)
    src.add_text(header + "\n\n" + text)

    if depth < 2:
        for att in msg.iter_attachments():
            payload = att.get_payload(decode=True) or b""
            att_name = att.get_filename() or "attachment"
            ctype = att.get_content_type()
            if ctype.startswith("image/") and len(payload) < MIN_EMBEDDED_IMAGE_BYTES:
                continue  # signature logos and tracking pixels
            try:
                inner = process(att_name, payload, ctype, depth + 1)
            except UnsupportedFile as e:
                src.add_text(f"[Attachment “{att_name}” skipped: {e}]")
                continue
            src.add_text(f"--- Attachment: {att_name} ({inner.label}) ---")
            for part in inner.parts:
                if part[0] == "text":
                    src.add_text(part[1])
                elif src.images < MAX_EMBEDDED_IMAGES or not part[1].startswith("image/"):
                    src.add_blob(part[1], part[2])
    return _require_text(src)


# ---- markup to text ---------------------------------------------------------

class _HTMLText(html.parser.HTMLParser):
    BLOCK = {"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "section",
             "article", "header", "footer", "table", "ul", "ol", "blockquote", "pre", "hr"}
    SKIP = {"script", "style", "noscript", "template", "head", "svg"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out, self.skip = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.skip += 1
        elif tag in self.BLOCK:
            self.out.append("\n- " if tag == "li" else "\n")
        elif tag in ("td", "th"):
            self.out.append(" | ")

    def handle_endtag(self, tag):
        if tag in self.SKIP:
            self.skip = max(0, self.skip - 1)
        elif tag in self.BLOCK:
            self.out.append("\n")

    def handle_data(self, data):
        if not self.skip:
            self.out.append(data)


def html_to_text(markup):
    p = _HTMLText()
    p.feed(markup)
    p.close()
    text = re.sub(r"[ \t\u00a0]+", " ", "".join(p.out))
    return re.sub(r"\n\s*\n+", "\n\n", text).strip()


_RTF_DEST = {"aftncn", "aftnsep", "aftnsepc", "annotation", "atnauthor", "atndate", "atnicn", "atnid",
             "atnparent", "atnref", "atntime", "atrfend", "atrfstart", "author", "background", "bkmkend",
             "bkmkstart", "buptim", "colortbl", "comment", "creatim", "do", "doccomm", "docvar",
             "dptxbxtext", "falt", "fchars", "ffdeftext", "ffentrymcr", "ffexitmcr", "ffformat", "ffhelptext",
             "ffl", "ffname", "ffstattext", "field", "file", "filetbl", "fldinst", "fldtype", "fname",
             "fontemb", "fontfile", "fonttbl", "footer", "footerf", "footerl", "footerr", "footnote",
             "ftncn", "ftnsep", "ftnsepc", "header", "headerf", "headerl", "headerr", "info", "keywords",
             "listtable", "listoverridetable", "operator", "pict", "pn", "pnseclvl", "printim", "private",
             "revtim", "rxe", "stylesheet", "subject", "tc", "template", "themedata", "colorschememapping",
             "title", "txe", "xe", "datastore", "latentstyles", "rsidtbl", "generator", "xmlnstbl", "mmathPr"}
_RTF_SPECIAL = {"par": "\n", "sect": "\n\n", "page": "\n\n", "line": "\n", "tab": "\t", "emdash": "\u2014",
                "endash": "\u2013", "emspace": "\u2003", "enspace": "\u2002", "qmspace": "\u2005",
                "bullet": "\u2022", "lquote": "\u2018", "rquote": "\u2019", "ldblquote": "\u201C",
                "rdblquote": "\u201D", "cell": " | ", "row": "\n"}
_RTF_TOKEN = re.compile(r"\\([a-z]{1,32})(-?\d{1,10})?[ ]?|\\'([0-9a-f]{2})|\\([^a-z])|([{}])|[\r\n]+|(.)", re.I)


def rtf_to_text(text):
    """Small RTF-to-text converter (after the well-known 'striprtf' approach)."""
    stack, ignorable, ucskip, curskip, out = [], False, 1, 0, []
    for m in _RTF_TOKEN.finditer(text):
        word, arg, hexcode, char, brace, tchar = m.groups()
        if brace:
            curskip = 0
            if brace == "{":
                stack.append((ucskip, ignorable))
            elif stack:
                ucskip, ignorable = stack.pop()
        elif char:
            curskip = 0
            if char == "~":
                if not ignorable:
                    out.append("\u00a0")
            elif char in "{}\\":
                if not ignorable:
                    out.append(char)
            elif char == "*":
                ignorable = True
        elif word:
            curskip = 0
            if word in _RTF_DEST:
                ignorable = True
            elif ignorable:
                pass
            elif word in _RTF_SPECIAL:
                out.append(_RTF_SPECIAL[word])
            elif word == "uc":
                ucskip = int(arg)
            elif word == "u":
                c = int(arg)
                out.append(chr(c + 0x10000 if c < 0 else c))
                curskip = ucskip
        elif hexcode:
            if curskip > 0:
                curskip -= 1
            elif not ignorable:
                out.append(bytes([int(hexcode, 16)]).decode("cp1252", "replace"))
        elif tchar:
            if curskip > 0:
                curskip -= 1
            elif not ignorable:
                out.append(tchar)
    return re.sub(r"\n{3,}", "\n\n", "".join(out)).strip()
