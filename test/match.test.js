/* Run from the repo root with either:
 *   node test/match.test.js
 *   /System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc test/match.test.js   (macOS)
 */
var M = typeof require !== "undefined" ? require("../src/content/match.js")
  : (load("src/content/match.js"), PaperLinkMatch);
var out = typeof console !== "undefined" ? (s) => console.log(s) : print;

var failures = 0, count = 0;
function check(name, cond, detail) {
  count++;
  if (!cond) { failures++; out("FAIL " + name + (detail !== undefined ? "  -> " + JSON.stringify(detail) : "")); }
}
function score(itemFields, file) {
  return M.scoreFile(M.itemInfo(itemFields), Object.assign({ dois: [], titles: [] }, file));
}

// --- identifiers
check("cleanDOI url", M.cleanDOI("https://doi.org/10.1038/S41586-020-2649-2") === "10.1038/s41586-020-2649-2");
check("cleanDOI trailing paren", M.cleanDOI("(doi:10.1000/abc).") === "10.1000/abc", M.cleanDOI("(doi:10.1000/abc)."));
check("cleanDOI keeps inner parens", M.cleanDOI("10.1016/0021-9991(81)90145-5") === "10.1016/0021-9991(81)90145-5");
var info = M.itemInfo({ title: "X", url: "https://arxiv.org/abs/2301.12345v3", extra: "DOI: 10.1000/abc" });
check("itemInfo arxiv", info.arxiv[0] === "2301.12345", info);
check("itemInfo extra DOI", info.dois[0] === "10.1000/abc", info);
check("arxiv DOI", M.itemInfo({ DOI: "10.48550/arXiv.1706.03762" }).arxiv[0] === "1706.03762");
check("arxiv filename", M.arxivFromFilename("1706.03762v7.pdf")[0] === "1706.03762");
check("no arxiv in year-ish name", M.arxivFromFilename("Smith 2020.1234.pdf").length === 0, M.arxivFromFilename("Smith 2020.1234.pdf"));

// --- filename matching
var T = "Array programming with NumPy";
check("zotero style filename", score({ title: T }, { name: "Harris et al. - 2020 - Array programming with NumPy.pdf" }).score >= M.LIKELY);
check("plain title filename", score({ title: T }, { name: "Array_programming_with_NumPy.pdf" }).score >= M.LIKELY);
check("browser duplicate suffix", score({ title: T }, { name: "Array programming with NumPy (1).pdf" }).score >= M.LIKELY);
check("unrelated file", score({ title: T }, { name: "invoice-2024.pdf" }).score === 0);
var long = "Attention is all you need: a comprehensive study of transformer architectures for sequence transduction tasks";
check("truncated long title", score({ title: long }, { name: "Vaswani - 2017 - Attention is all you need a comprehensive study of transformer arch.pdf" }).score >= M.LIKELY);
check("short title needs exact", score({ title: "Deep learning" }, { name: "Deep learning for cats and dogs.pdf" }).score < M.LIKELY);
check("different topic, same words", score({ title: "Attention is all you need" },
  { name: "Attention is all you need for graph neural networks in chemistry biology physics medicine survey review.pdf" }).score < M.LIKELY);
check("chinese title", score({ title: "基于深度学习的图像识别方法研究" }, { name: "张三 - 2021 - 基于深度学习的图像识别方法研究.pdf" }).score >= M.LIKELY);
check("chinese different", score({ title: "基于深度学习的图像识别方法研究" }, { name: "量子计算导论.pdf" }).score === 0);

// --- identifiers in files
check("doi in filename", score({ title: T, DOI: "10.1038/s41586-020-2649-2" }, { name: "10.1038_s41586-020-2649-2.pdf" }).score >= M.CERTAIN);
check("doi suffix filename", score({ title: T, DOI: "10.1038/s41586-020-2649-2" }, { name: "s41586-020-2649-2.pdf" }).score >= M.CERTAIN);
check("arxiv filename match", score({ title: "Attention is all you need", url: "https://arxiv.org/abs/1706.03762" }, { name: "1706.03762v7.pdf" }).score >= M.CERTAIN);
check("arxiv conflict", score({ title: "Attention is all you need", url: "https://arxiv.org/abs/1706.03762" }, { name: "1810.04805 Attention is all you need.pdf" }).score === 0);
check("metadata doi", score({ title: T, DOI: "10.1038/s41586-020-2649-2" }, { name: "download.pdf", dois: ["10.1038/s41586-020-2649-2"] }).score >= M.CERTAIN);
check("doi conflict veto", score({ title: T, DOI: "10.1038/s41586-020-2649-2" }, { name: "Array programming with NumPy.pdf", dois: ["10.9999/other"] }).score === 0);
check("pdf title", score({ title: T }, { name: "main.pdf", titles: ["Array Programming with NumPy"] }).score >= M.LIKELY);
check("identical bytes", score({ title: T }, { name: "x.pdf", identical: true }).score === 100);

// --- PDF metadata extraction
var pdf = "%PDF-1.7\n1 0 obj<</Title (Array programming with \\(NumPy\\))/Subject (Nature 585, doi:10.1038/s41586-020-2649-2)>>endobj\n" +
  "<x:xmpmeta xmlns:x='adobe:ns:meta/'><rdf:RDF><rdf:Description><dc:title><rdf:Alt><rdf:li xml:lang='x-default'>Array programming with NumPy</rdf:li></rdf:Alt></dc:title>" +
  "<prism:doi>10.1038/s41586-020-2649-2</prism:doi></rdf:Description></rdf:RDF></x:xmpmeta>\n" +
  "stream BT (see also 10.1000/reference-doi) ET endstream";
var meta = M.pdfMetadata(pdf);
check("meta doi", meta.dois.length === 1 && meta.dois[0] === "10.1038/s41586-020-2649-2", meta);
check("meta title", meta.titles.indexOf("Array programming with NumPy") >= 0 && meta.titles.indexOf("Array programming with (NumPy)") >= 0, meta);
var utf16 = "/Title <FEFF0041007200720061007900>";
check("utf16 hex title", M.pdfMetadata(utf16).titles[0] === "Array", M.pdfMetadata(utf16));
check("utf16 literal", M.decodePdfLiteral("\\376\\377\\000A\\000B") === "AB");

// --- choosing
var c = M.choose([{ path: "a", score: 95, mtime: 1 }, { path: "b", score: 72, mtime: 2 }], M.LIKELY);
check("choose clear winner", c.pick && c.pick.path === "a");
c = M.choose([{ path: "a", score: 85, mtime: 1 }, { path: "b", score: 85, mtime: 2 }], M.LIKELY);
check("choose ambiguous", !c.pick && c.ambiguous.length === 2);
c = M.choose([{ path: "a", score: 85, mtime: 1, md5: "x" }, { path: "b", score: 85, mtime: 2, md5: "x" }], M.LIKELY);
check("choose identical copies", c.pick && c.pick.path === "b");
c = M.choose([{ path: "a", score: 60, mtime: 1 }], M.LIKELY);
check("choose below threshold", !c.pick && !c.ambiguous.length);

out((failures ? failures + " of " : "all ") + count + (failures ? " tests failed" : " tests passed"));
if (failures && typeof process !== "undefined") process.exit(1);
