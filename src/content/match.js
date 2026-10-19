/* PaperLink matching logic.
 * Pure functions only (no Zotero / Gecko APIs) so they can be unit-tested
 * outside Zotero: `jsc test/match.test.js` or `node test/match.test.js`.
 */
var PaperLinkMatch = (function () {
  "use strict";

  // Score thresholds
  const CERTAIN = 90; // identical bytes, same DOI, same arXiv ID
  const LIKELY = 70;  // strong title evidence; auto-linked unless confirmProbable is set
  const SHOWN = 50;   // only offered to the user in manual mode

  const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/;
  const CJK_RUN = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]+/g;
  const STOP = new Set(["the", "and", "for", "with", "from", "into", "via", "are", "its",
    "der", "die", "das", "und", "les", "des", "pdf"]);

  function stripMarks(text) {
    return String(text || "").normalize("NFKD").replace(/[̀-ͯ]/g, "");
  }

  /** Lowercase, drop punctuation, collapse whitespace. Keeps letters of any script. */
  function norm(text) {
    return stripMarks(text).toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  }

  /** Comparable tokens: Latin-ish words of 3+ chars, CJK as character bigrams. */
  function tokens(text) {
    const out = [];
    for (const word of norm(text).split(" ")) {
      if (!word) continue;
      if (CJK.test(word)) {
        const runs = word.match(CJK_RUN) || [];
        for (const run of runs) {
          if (run.length === 1) out.push(run);
          for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
        }
        const rest = word.replace(CJK_RUN, " ").trim();
        for (const w of rest.split(/\s+/)) if (w.length > 2 && !STOP.has(w)) out.push(w);
      }
      else if (word.length > 2 && !STOP.has(word)) out.push(word);
    }
    return out;
  }

  function alnum(text) {
    return String(text || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  // ---- Identifiers ---------------------------------------------------------

  const DOI_RE = /10\.\d{4,9}\/[^\s"'<>\]\[{}]+/gi;

  function cleanDOI(doi) {
    if (!doi) return "";
    let d = String(doi).trim();
    try { d = decodeURIComponent(d); } catch (e) {}
    d = d.replace(/^(?:https?:\/\/)?(?:dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "");
    const m = d.match(/10\.\d{4,9}\/\S+/);
    if (!m) return "";
    // Trailing punctuation is almost never part of a DOI in running text.
    let out = m[0].replace(/[.,;:\]}>]+$/, "");
    // Drop a trailing ")" only when it is unbalanced, e.g. "(doi:10.1/abc)"
    while (out.endsWith(")") && (out.match(/\(/g) || []).length < (out.match(/\)/g) || []).length) {
      out = out.slice(0, -1).replace(/[.,;:]+$/, "");
    }
    return out.toLowerCase();
  }

  function isArxivDOI(doi) { return /^10\.48550\/arxiv\./i.test(doi); }

  function cleanArxiv(id) {
    return String(id || "").toLowerCase().replace(/^arxiv[:.\s]*/, "").replace(/v\d+$/, "");
  }

  const ARXIV_NEW = /(?:^|[^\d.])(\d{4}\.\d{4,5})(?:v\d+)?(?![\d])/g;
  const ARXIV_OLD = /\b([a-z-]+(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?\b/gi;

  /** arXiv IDs from strings that are known to describe arXiv (URLs, "arXiv:" labels). */
  function arxivFromText(text) {
    const ids = new Set();
    const s = String(text || "");
    const patterns = [
      /arxiv\.org\/(?:abs|pdf)\/([a-z-]+(?:\.[a-z]{2})?\/\d{7}|\d{4}\.\d{4,5})/gi,
      /arxiv[:\s]+([a-z-]+(?:\.[a-z]{2})?\/\d{7}|\d{4}\.\d{4,5})/gi,
      /10\.48550\/arxiv\.(\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?\/\d{7})/gi,
    ];
    for (const re of patterns) {
      for (const m of s.matchAll(re)) ids.add(cleanArxiv(m[1]));
    }
    return [...ids];
  }

  /** arXiv-style IDs inside a filename such as "2301.12345v2.pdf". */
  function arxivFromFilename(name) {
    const stem = String(name || "").replace(/\.pdf$/i, "");
    const ids = new Set(arxivFromText(stem));
    for (const m of stem.matchAll(ARXIV_NEW)) {
      const [yy, mm] = [Number(m[1].slice(0, 2)), Number(m[1].slice(2, 4))];
      if (yy >= 7 && mm >= 1 && mm <= 12) ids.add(m[1]);
    }
    for (const m of stem.replace(/_/g, "/").matchAll(ARXIV_OLD)) ids.add(cleanArxiv(m[1]));
    return [...ids];
  }

  /**
   * Identifiers of a Zotero item, from plain field values:
   * {title, DOI, url, extra, archiveID, number, publisher}
   */
  function itemInfo(fields) {
    const dois = new Set();
    const add = (d) => { const c = cleanDOI(d); if (c) dois.add(c); };
    add(fields.DOI);
    for (const m of String(fields.extra || "").matchAll(/^\s*DOI:\s*(\S+)/gim)) add(m[1]);
    if (/doi\.org\//i.test(fields.url || "")) add(fields.url);

    const arxiv = new Set();
    for (const text of [fields.url, fields.extra, fields.archiveID, fields.number, fields.DOI]) {
      for (const id of arxivFromText(text)) arxiv.add(id);
    }
    for (const d of dois) {
      if (isArxivDOI(d)) for (const id of arxivFromText(d)) arxiv.add(id);
    }
    return { title: fields.title || "", dois: [...dois], arxiv: [...arxiv] };
  }

  // ---- PDF metadata (from raw head/tail bytes) -----------------------------

  function decodeUTF16BE(bin) {
    let out = "";
    for (let i = 0; i + 1 < bin.length; i += 2) {
      out += String.fromCharCode((bin.charCodeAt(i) << 8) | bin.charCodeAt(i + 1));
    }
    return out;
  }

  function decodeUTF8(bin) {
    if (typeof TextDecoder === "undefined") return bin;
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) & 0xff;
    return new TextDecoder("utf-8").decode(bytes);
  }

  /** Decode the body of a PDF literal string "(...)" (escapes, UTF-16BE BOM). */
  function decodePdfLiteral(raw) {
    let s = "";
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (c !== "\\") { s += c; continue; }
      const n = raw[++i];
      if (n === undefined) break;
      if (/[0-7]/.test(n)) {
        let oct = n;
        while (oct.length < 3 && /[0-7]/.test(raw[i + 1])) oct += raw[++i];
        s += String.fromCharCode(parseInt(oct, 8) & 0xff);
      }
      else if (n === "n") s += "\n";
      else if (n === "r") s += "\r";
      else if (n === "t") s += "\t";
      else if (n === "\r" || n === "\n") { if (n === "\r" && raw[i + 1] === "\n") i++; }
      else s += n;
    }
    if (s.startsWith("\xfe\xff")) return decodeUTF16BE(s.slice(2));
    return s;
  }

  function decodePdfHex(hex) {
    const clean = hex.replace(/[^0-9a-f]/gi, "");
    let bin = "";
    for (let i = 0; i + 1 < clean.length; i += 2) bin += String.fromCharCode(parseInt(clean.slice(i, i + 2), 16));
    if (bin.startsWith("\xfe\xff")) return decodeUTF16BE(bin.slice(2));
    return bin;
  }

  function unescapeXML(s) {
    return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"")
      .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&amp;/g, "&");
  }

  /** Read a balanced PDF literal string starting just after "(". */
  function readLiteral(bin, start) {
    let depth = 1;
    for (let i = start; i < bin.length && i < start + 4000; i++) {
      const c = bin[i];
      if (c === "\\") { i++; continue; }
      if (c === "(") depth++;
      else if (c === ")" && --depth === 0) return bin.slice(start, i);
    }
    return null;
  }

  // DOIs only count when they sit in a metadata context, not in references.
  const DOI_CONTEXT = /(prism:doi|dc:identifier|pdfx:doi|crossmark:doi|prism:url|\/doi\b|\/subject\b|\/wps-articledoi|pdfx:wps-articledoi|<doi>)/i;

  /**
   * Extract {dois, title} from raw PDF bytes given as a binary ("latin1") string.
   * Only uncompressed metadata (XMP packet, Info dictionary) is visible; that is
   * where most publisher PDFs put DOI and title.
   */
  function pdfMetadata(bin) {
    const dois = new Set();
    const titles = [];

    // XMP packets are UTF-8
    for (const m of bin.matchAll(/<x:xmpmeta[\s\S]*?<\/x:xmpmeta>/g)) {
      const xmp = decodeUTF8(m[0]);
      const t = xmp.match(/<dc:title>[\s\S]*?<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/);
      if (t) titles.push(unescapeXML(t[1]).trim());
      for (const d of xmp.matchAll(DOI_RE)) {
        const ctx = xmp.slice(Math.max(0, d.index - 120), d.index);
        if (DOI_CONTEXT.test(ctx)) dois.add(cleanDOI(d[0]));
      }
    }

    // Info dictionary: /Title (...) or /Title <FEFF...>
    for (const m of bin.matchAll(/\/Title\s*(\(|<(?!<))/g)) {
      const start = m.index + m[0].length;
      let value = null;
      if (m[1] === "(") {
        const raw = readLiteral(bin, start);
        if (raw !== null) value = decodePdfLiteral(raw);
      }
      else {
        const end = bin.indexOf(">", start);
        if (end > 0 && end - start < 4000) value = decodePdfHex(bin.slice(start, end));
      }
      if (value && value.trim()) titles.push(value.trim());
    }
    for (const m of bin.matchAll(/\/(?:doi|DOI|Subject|WPS-ARTICLEDOI)\s*\(/g)) {
      const raw = readLiteral(bin, m.index + m[0].length);
      if (raw === null) continue;
      for (const d of decodePdfLiteral(raw).matchAll(DOI_RE)) dois.add(cleanDOI(d[0]));
    }

    dois.delete("");
    return { dois: [...dois], titles: [...new Set(titles)] };
  }

  // ---- Scoring -------------------------------------------------------------

  /** How well a filename (without extension) matches a title. 0..85 */
  function filenameTitleScore(filename, title) {
    const stem = String(filename || "").replace(/\.pdf$/i, "").replace(/\s*\(\d+\)$/, "");
    const tTokens = tokens(title);
    const fTokens = tokens(stem);
    if (!tTokens.length || !fTokens.length) return 0;

    const fSet = new Set(fTokens);
    const tSet = new Set(tTokens);
    const covered = tTokens.filter(w => fSet.has(w)).length / tTokens.length;
    const extra = fTokens.filter(w => !tSet.has(w) && !/^\d+$/.test(w)).length;

    const nTitle = norm(title);
    const nFile = norm(stem);
    let score = 0;
    if (nFile === nTitle && tTokens.length >= 2) score = 85;
    else if (tTokens.length >= 3 && nFile.includes(nTitle)) score = 85;
    // Zotero/ZotMoov-style filenames may truncate long titles
    else if (nTitle.length >= 50) {
      for (let cut = nTitle.length - 1; cut >= Math.max(40, nTitle.length * 0.5); cut--) {
        if (nFile.includes(nTitle.slice(0, cut))) { score = 75; break; }
      }
    }
    if (!score && tTokens.length >= 4) {
      if (covered >= 0.9) score = 72;
      else if (covered >= 0.8 && tTokens.length >= 6) score = 60;
      else if (covered >= 0.6 && tTokens.length >= 6) score = SHOWN;
    }
    // Author, year, journal etc. are fine; a filename about a different topic is not.
    if (score && extra > 8) score -= 20;
    return Math.max(0, score);
  }

  /**
   * @param {Object} item  result of itemInfo()
   * @param {Object} file  {name, dois, titles, identical}
   * @return {{score: number, reasons: string[]}}
   */
  function scoreFile(item, file) {
    const reasons = [];
    let score = 0;
    const bump = (s, why) => { if (s > score) score = s; reasons.push(why); };

    if (file.identical) bump(100, "identical-file");

    const itemDOIs = new Set(item.dois);
    const realItemDOIs = item.dois.filter(d => !isArxivDOI(d));
    const fileDOIs = file.dois || [];
    if (fileDOIs.some(d => itemDOIs.has(d))) bump(95, "doi");

    // DOI written into the filename, e.g. 10.1038_s41586-020-2649-2.pdf or s41586-020-2649-2.pdf
    const stemAlnum = alnum(String(file.name || "").replace(/\.pdf$/i, "").replace(/\s*\(\d+\)$/, ""));
    for (const d of realItemDOIs) {
      const full = alnum(d);
      const suffix = alnum(d.slice(d.indexOf("/") + 1));
      if (full.length >= 10 && stemAlnum.includes(full)) bump(92, "doi-in-filename");
      else if (suffix.length >= 10 && stemAlnum === suffix) bump(90, "doi-suffix-filename");
    }

    const fileArxiv = new Set(arxivFromFilename(file.name));
    for (const d of fileDOIs) if (isArxivDOI(d)) for (const id of arxivFromText(d)) fileArxiv.add(id);
    if (item.arxiv.some(id => fileArxiv.has(id))) bump(95, "arxiv-id");

    const nTitle = norm(item.title);
    if (tokens(item.title).length >= 3 && (file.titles || []).some(t => norm(t) === nTitle)) {
      bump(85, "pdf-title");
    }

    const fScore = filenameTitleScore(file.name, item.title);
    if (fScore) bump(fScore, "filename-title");

    // Veto: the PDF declares a different (non-arXiv) DOI than the item.
    const realFileDOIs = fileDOIs.filter(d => !isArxivDOI(d));
    if (!file.identical && realItemDOIs.length && realFileDOIs.length
        && !realFileDOIs.some(d => itemDOIs.has(d))) {
      return { score: 0, reasons: ["doi-conflict"] };
    }
    // Veto: a different arXiv ID in the filename
    if (!file.identical && score < CERTAIN && item.arxiv.length && fileArxiv.size
        && !item.arxiv.some(id => fileArxiv.has(id))) {
      return { score: 0, reasons: ["arxiv-conflict"] };
    }
    return { score, reasons };
  }

  /**
   * Pick the file to link.
   * @param {Array<{path, score, md5?, mtime}>} scored
   * @return {{pick: object|null, ambiguous: object[]}}
   */
  function choose(scored, minScore) {
    const ok = scored.filter(c => c.score >= minScore).sort((a, b) => b.score - a.score || b.mtime - a.mtime);
    if (!ok.length) return { pick: null, ambiguous: [] };
    const top = ok.filter(c => c.score >= ok[0].score - 5);
    if (top.length === 1) return { pick: top[0], ambiguous: [] };
    // Several byte-identical copies: any of them is fine, take the most recently modified.
    if (top.every(c => c.md5 && c.md5 === top[0].md5)) return { pick: top[0], ambiguous: [] };
    return { pick: null, ambiguous: top };
  }

  return {
    CERTAIN, LIKELY, SHOWN,
    norm, tokens, cleanDOI, isArxivDOI, arxivFromText, arxivFromFilename,
    itemInfo, pdfMetadata, decodePdfLiteral, filenameTitleScore, scoreFile, choose,
  };
})();

if (typeof module !== "undefined") module.exports = PaperLinkMatch;
