/* PaperLink main module. Loaded by bootstrap.js into the plugin scope,
 * after content/match.js (PaperLinkMatch).
 *
 * Pipeline for every item saved by the Zotero Connector:
 *   1. wait until the Connector has finished adding the item's attachments
 *   2. look for the same paper in the watched folders (Downloads by default)
 *   3a. found  -> link the existing PDF, then ask whether to permanently delete Zotero's fresh download
 *   3b. absent -> move Zotero's download into the target folder and link it there
 *   4. check whether the bibliographic record duplicates an existing one, then ask / merge
 *
 * Safety rules: files outside Zotero storage are never deleted, renamed, or overwritten.
 * Zotero's own downloaded copy is permanently deleted only after the user confirms
 * (or chose "delete" in the settings, which still skips copies that carry annotations).
 * Duplicate entries are merged into the Zotero Trash (recoverable).
 */
var PaperLink = (function () {
  "use strict";

  const PREF = "extensions.paperlink.";
  const M = PaperLinkMatch;
  const HEAD_BYTES = 256 * 1024;
  const TAIL_BYTES = 128 * 1024;
  const MAX_FILES = 20000;
  const QUIET_MS = 4000;          // wait this long after the last attachment event
  const NO_PDF_WAIT_MS = 45000;   // ... or this long if no PDF has arrived yet (arXiv often takes 20 s+)
  const MAX_WAIT_MS = 120000;
  const RECENT_MS = 10 * 60 * 1000;
  const BATCH_LIMIT = 10;         // larger bursts (imports, restores) are not auto-processed

  let rootURI = "";
  let observerID = null;
  let stopped = true;
  const pending = new Map();      // parent item ID -> {timer, first, sawPDF}
  const busy = new Set();
  const mergedInto = new Map();   // item ID merged away -> ID of the entry it was merged into
  let cache = new Map();          // path -> {size, mtime, dois, titles, md5?}
  let cacheDirty = false;

  // ---- utilities -----------------------------------------------------------

  function log(msg) { Zotero.debug("PaperLink: " + msg); }
  function pref(name) { return Zotero.Prefs.get(PREF + name, true); }

  const zh = () => String(Zotero.locale || "").startsWith("zh");
  const STR = {
    en: {
      title: "PaperLink",
      linked: "Linked existing PDF:\n%1",
      reason: "Matched by: %1",
      deleted: "Permanently deleted the copy Zotero downloaded.",
      keptCopy: "Kept the copy Zotero downloaded.",
      keptAnnotated: "Kept the Zotero copy because it has annotations.",
      deleteTitle: "PaperLink: delete Zotero's copy?",
      deleteAsk: "Linked your existing PDF:\n%1\n\nZotero also downloaded this paper:\n%2\n\nPermanently delete Zotero's copy? The attachment and its file in Zotero storage are removed and cannot be restored. Your existing PDF is not touched.",
      deleteAnnotated: "\n\nWARNING: Zotero's copy has annotations. They will be deleted too.",
      deleteYes: "Delete",
      deleteNo: "Keep",
      moved: "No local copy found. Saved the downloaded PDF to:\n%1\nand linked it.",
      noMatch: "No matching PDF found in:\n%1",
      noPDF: "No matching PDF in the watched folders, and Zotero did not download one.",
      alreadyLinked: "This PDF is already linked:\n%1",
      group: "Linked files are not supported in group libraries; skipped PDF linking.",
      chooseTitle: "PaperLink: several possible PDFs",
      chooseText: "Several local PDFs could be this paper:\n%1\n\nWhich one should be linked? (Cancel = link none)",
      confirmTitle: "PaperLink: link this PDF?",
      confirmLink: "Paper:\n%1\n\nLink local PDF:\n%2\n(match: %3)",
      dupTitle: "PaperLink: duplicate entry",
      dupText: "This paper is already in your library:\n\n%1\n\nExisting entry added %2.\n\nMerge the new entry into the existing one? Attachments, notes, tags and collections are kept; the new entry goes to the Zotero Trash.",
      dupMerge: "Merge",
      dupKeep: "Keep both",
      dupShow: "Show duplicates",
      merged: "Merged into the existing entry (added %1).",
      deduped: "Removed %1 duplicate note(s)/attachment(s) left by the merge (to the Zotero Trash).",
      lateMoved: "A PDF arrived after the merge; moved it to the merged entry.",
      fetched: "The Connector sent no PDF; downloaded one with Zotero's \"Find Available PDF\".",
      fetchFailed: "This entry has no usable PDF, and \"Find Available PDF\" found none.",
      brokenLinks: "Moved %1 PDF attachment(s) whose file is unavailable to the Zotero Trash.",
      restored: "Downloaded the missing PDF file through Zotero file sync.",
      unavailTitle: "PaperLink: unavailable PDF attachment",
      unavailAsk: "This entry now has a working PDF, but the file of these attachments is not on this computer:\n%1\n\nThey may have been added on another computer and never synced; there they may still work, and trashing them affects that computer too after syncing.\n\nMove them to the Zotero Trash?",
      unavailKept: "Kept attachment(s) whose file is not on this computer (may exist on another computer):\n%1",
      dupTypes: "\n\nThe entries have different types (%1). The merged entry will be a %2; fields that type has no place for (e.g. arXiv ID) are kept in Extra.",
      batch: "PaperLink skipped automatic processing of %1 items added at once (import or sync). Select items and use the context menu to process them.",
      select: "Select one or more items first.",
      menu: "PaperLink: find local PDF & check duplicates",
      browse: "Choose a folder",
    },
    zh: {
      title: "PaperLink",
      linked: "已链接本地已有 PDF：\n%1",
      reason: "匹配依据：%1",
      deleted: "已彻底删除 Zotero 下载的副本。",
      keptCopy: "已保留 Zotero 下载的副本。",
      keptAnnotated: "Zotero 中的副本含有标注，已保留。",
      deleteTitle: "PaperLink：删除 Zotero 的副本？",
      deleteAsk: "已链接你本地已有的 PDF：\n%1\n\nZotero 也下载了这篇论文：\n%2\n\n要彻底删除 Zotero 下载的副本吗？附件及其在 Zotero 存储中的文件将被删除，无法恢复。你本地的 PDF 不受影响。",
      deleteAnnotated: "\n\n警告：Zotero 的副本中有标注，删除后标注也会丢失。",
      deleteYes: "删除",
      deleteNo: "保留",
      moved: "本地没有找到这篇论文，已将下载的 PDF 保存到：\n%1\n并链接。",
      noMatch: "以下文件夹中没有找到匹配的 PDF：\n%1",
      noPDF: "监视文件夹中没有找到匹配的 PDF，Zotero 也没有下载 PDF。",
      alreadyLinked: "该 PDF 已链接：\n%1",
      group: "群组文库不支持链接文件，已跳过 PDF 链接。",
      chooseTitle: "PaperLink：找到多个可能的 PDF",
      chooseText: "以下本地 PDF 都可能是这篇论文：\n%1\n\n要链接哪一个？（取消 = 不链接）",
      confirmTitle: "PaperLink：链接这个 PDF？",
      confirmLink: "论文：\n%1\n\n链接本地 PDF：\n%2\n（匹配依据：%3）",
      dupTitle: "PaperLink：重复条目",
      dupText: "文库中已有这篇论文：\n\n%1\n\n已有条目添加于 %2。\n\n要把新条目合并到已有条目吗？附件、笔记、标签和分类都会保留；新条目移入 Zotero 回收站。",
      dupMerge: "合并",
      dupKeep: "保留两条",
      dupShow: "查看重复条目",
      merged: "已合并到已有条目（添加于 %1）。",
      deduped: "已移除合并后重复的 %1 个笔记/附件（移入 Zotero 回收站）。",
      lateMoved: "合并后才收到的 PDF 已移到合并后的条目。",
      fetched: "Connector 没有传来 PDF，已用 Zotero 的“查找可用 PDF”下载。",
      fetchFailed: "该条目没有可用的 PDF，“查找可用 PDF”也没有找到。",
      brokenLinks: "已将 %1 个文件不可用的 PDF 附件移入 Zotero 回收站。",
      restored: "已通过 Zotero 文件同步下载缺失的 PDF 文件。",
      unavailTitle: "PaperLink：不可用的 PDF 附件",
      unavailAsk: "该条目已有可用的 PDF，但以下附件的文件不在这台电脑上：\n%1\n\n它们可能是在另一台电脑上添加、且从未同步文件；在那台电脑上可能仍然可用，移入回收站后同步也会影响那台电脑。\n\n要移入 Zotero 回收站吗？",
      unavailKept: "已保留文件不在这台电脑上的附件（可能存在于另一台电脑）：\n%1",
      dupTypes: "\n\n这些条目类型不同（%1）。合并后的条目类型为“%2”；该类型没有的字段（如 arXiv 编号）会保存在“其他”(Extra) 字段中。",
      batch: "PaperLink 跳过了一次性添加的 %1 个条目（导入或同步）。如需处理，请选中条目后使用右键菜单。",
      select: "请先选中一个或多个条目。",
      menu: "PaperLink：查找本地 PDF 并检查重复",
      browse: "选择文件夹",
    },
  };
  function S(key, ...args) {
    let s = (zh() ? STR.zh : STR.en)[key] || STR.en[key] || key;
    args.forEach((a, i) => { s = s.split("%" + (i + 1)).join(String(a)); });
    return s;
  }
  const REASONS = {
    en: { "identical-file": "identical file", "doi": "DOI in PDF metadata", "doi-in-filename": "DOI in filename",
      "doi-suffix-filename": "DOI in filename", "arxiv-id": "arXiv ID", "pdf-title": "title in PDF metadata",
      "filename-title": "title in filename" },
    zh: { "identical-file": "文件内容完全相同", "doi": "PDF 元数据中的 DOI", "doi-in-filename": "文件名中的 DOI",
      "doi-suffix-filename": "文件名中的 DOI", "arxiv-id": "arXiv 编号", "pdf-title": "PDF 元数据中的标题",
      "filename-title": "文件名中的标题" },
  };
  function reasonText(reasons) {
    const table = zh() ? REASONS.zh : REASONS.en;
    return [...new Set(reasons.map(r => table[r] || r))].join(zh() ? "、" : ", ");
  }

  function mainWindow() { return Zotero.getMainWindow(); }

  function notify(lines) {
    if (!lines.length || !pref("notify")) return;
    try {
      const pw = new Zotero.ProgressWindow({ closeOnClick: true });
      pw.changeHeadline(S("title"));
      for (const line of lines) pw.addDescription(line);
      pw.show();
      pw.startCloseTimer(9000);
    }
    catch (e) { log(lines.join(" | ")); }
  }

  function alert(text) { Services.prompt.alert(mainWindow(), S("title"), text); }

  /** Comparable form of a path. PathUtils.normalize() throws for files that no longer exist. */
  function pathKey(p) {
    let s = String(p || "");
    try { s = PathUtils.normalize(s); }
    catch (e) { s = s.replace(/[\\/]+$/, ""); }
    return (Zotero.isWin || Zotero.isMac) ? s.toLowerCase() : s;
  }

  function samePath(a, b) {
    return !!a && !!b && pathKey(a) === pathKey(b);
  }

  function binaryString(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return s;
  }

  function isRecent(item) {
    const d = Zotero.Date.sqlToDate(item.dateAdded, true);
    return !!d && Date.now() - d.getTime() < RECENT_MS;
  }

  function itemFields(item) {
    const get = (f) => { try { return item.getField(f) || ""; } catch (e) { return ""; } };
    return { title: get("title"), DOI: get("DOI"), url: get("url"), extra: get("extra"),
      archiveID: get("archiveID"), number: get("number") };
  }

  // ---- folders -------------------------------------------------------------

  function downloadsDir() {
    try { return Services.dirsvc.get("DfltDwnld", Components.interfaces.nsIFile).path; }
    catch (e) { return PathUtils.join(Services.dirsvc.get("Home", Components.interfaces.nsIFile).path, "Downloads"); }
  }

  function folders() {
    const home = Services.dirsvc.get("Home", Components.interfaces.nsIFile).path;
    const list = String(pref("folders") || "").split(/[;\n]/).map(s => s.trim()).filter(Boolean)
      .map(p => p === "~" ? home : p.replace(/^~[\/\\]/, home + (Zotero.isWin ? "\\" : "/")));
    return list.length ? list : [downloadsDir()];
  }

  async function listPDFs() {
    const storage = PathUtils.join(Zotero.DataDirectory.dir, "storage");
    const depth = Math.max(0, Math.min(5, Number(pref("scanDepth")) || 0));
    const out = [];
    const seen = new Set();
    async function walk(dir, level) {
      let children;
      try { children = await IOUtils.getChildren(dir, { ignoreAbsent: true }); }
      catch (e) { log("cannot read " + dir + ": " + e); return; }
      for (const path of children) {
        if (out.length >= MAX_FILES) return;
        const name = PathUtils.filename(path);
        if (name.startsWith(".") || samePath(path, storage)) continue;
        const isPDF = /\.pdf$/i.test(name);
        if (!isPDF && level >= depth) continue;
        let info;
        try { info = await IOUtils.stat(path); } catch (e) { continue; }
        if (info.type === "directory") {
          if (level < depth && !/\.(app|photoslibrary|bundle)$/i.test(name)) await walk(path, level + 1);
        }
        else if (isPDF && info.type === "regular" && info.size > 0 && !seen.has(path)) {
          seen.add(path);
          out.push({ path, name, size: info.size, mtime: info.lastModified });
        }
      }
    }
    for (const dir of folders()) await walk(dir, 0);
    return out;
  }

  // ---- PDF metadata cache (persisted in the Zotero data directory) ---------

  function cachePath() { return PathUtils.join(Zotero.DataDirectory.dir, "paperlink-cache.json"); }

  async function loadCache() {
    try {
      const data = await IOUtils.readJSON(cachePath());
      if (data && data.version === 1) cache = new Map(Object.entries(data.files));
    }
    catch (e) { cache = new Map(); }
  }

  async function saveCache() {
    if (!cacheDirty) return;
    cacheDirty = false;
    try {
      await IOUtils.writeJSON(cachePath(), { version: 1, files: Object.fromEntries(cache) },
        { tmpPath: cachePath() + ".tmp" });
    }
    catch (e) { log("cache save failed: " + e); }
  }

  async function features(file) {
    let entry = cache.get(file.path);
    if (entry && entry.size === file.size && entry.mtime === file.mtime) return entry;
    entry = { size: file.size, mtime: file.mtime, dois: [], titles: [] };
    try {
      const head = await IOUtils.read(file.path, { maxBytes: HEAD_BYTES });
      let bin = binaryString(head);
      if (file.size > HEAD_BYTES) {
        const tail = await IOUtils.read(file.path, { offset: Math.max(HEAD_BYTES, file.size - TAIL_BYTES) });
        bin += "\n" + binaryString(tail);
      }
      const meta = M.pdfMetadata(bin);
      entry.dois = meta.dois;
      entry.titles = meta.titles.slice(0, 4).map(t => t.slice(0, 500));
    }
    catch (e) { log("cannot read " + file.path + ": " + e); }
    cache.set(file.path, entry);
    cacheDirty = true;
    return entry;
  }

  async function md5Of(file) {
    const entry = cache.get(file.path);
    if (entry && entry.md5 && entry.size === file.size && entry.mtime === file.mtime) return entry.md5;
    const md5 = await Zotero.Utilities.Internal.md5Async(file.path);
    if (entry && md5) { entry.md5 = md5; cacheDirty = true; }
    return md5;
  }

  // ---- step 2: find the paper on disk -------------------------------------

  async function findLocal(item, copies, interactive) {
    const info = M.itemInfo(itemFields(item));
    const copySizes = new Set(copies.map(c => c.size));
    const copyMD5s = new Set(copies.map(c => c.md5).filter(Boolean));
    const copyPaths = copies.map(c => c.path);
    const scored = [];
    for (const file of await listPDFs()) {
      if (copyPaths.some(p => samePath(p, file.path))) continue;
      const feat = await features(file);
      let md5 = null;
      if (copySizes.has(file.size)) md5 = await md5Of(file);
      const { score, reasons } = M.scoreFile(info, {
        name: file.name, dois: feat.dois, titles: feat.titles, identical: !!md5 && copyMD5s.has(md5),
      });
      if (score >= M.SHOWN) scored.push(Object.assign({}, file, { score, reasons, md5 }));
    }
    await saveCache();
    // Identical-content tie breaking needs hashes of all top candidates.
    for (const c of scored) if (!c.md5 && c.score >= M.LIKELY) c.md5 = await md5Of(c);
    await saveCache();
    return M.choose(scored, interactive ? M.SHOWN : M.LIKELY);
  }

  function chooseDialog(item, candidates) {
    const labels = candidates.map(c => `${c.path}   [${reasonText(c.reasons)}]`);
    const sel = { value: 0 };
    const ok = Services.prompt.select(mainWindow(), S("chooseTitle"),
      S("chooseText", item.getField("title")), labels, sel);
    return ok ? candidates[sel.value] : null;
  }

  // ---- step 3: link / trash / move ----------------------------------------

  async function hasAnnotations(att) {
    if (att.getAnnotations().length) return true;
    try { return await att.hasEmbeddedAnnotations(); }
    catch (e) { return true; }
  }

  async function downloadedCopies(item, auto) {
    const out = [];
    for (const att of Zotero.Items.get(item.getAttachments())) {
      if (!att || att.deleted || !att.isPDFAttachment() || !att.isImportedAttachment()) continue;
      // Automatic mode only touches what the Connector just added.
      if (auto && !isRecent(att)) continue;
      const path = await att.getFilePathAsync();
      if (!path) continue;
      let size = 0;
      try { size = (await IOUtils.stat(path)).size; } catch (e) { continue; }
      out.push({ att, path, size, md5: await Zotero.Utilities.Internal.md5Async(path) });
    }
    return out;
  }

  async function linkFile(item, path, title) {
    for (const att of Zotero.Items.get(item.getAttachments())) {
      if (att && !att.deleted && att.isLinkedFileAttachment() && samePath(att.getFilePath(), path)) {
        return { att, existed: true };
      }
    }
    const att = await Zotero.Attachments.linkFromFile({ file: path, parentItemID: item.id, title: title || "PDF" });
    return { att, existed: false };
  }

  async function uniqueDest(dir, name, srcMD5) {
    const dot = name.lastIndexOf(".");
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    for (let i = 1; i < 1000; i++) {
      const dest = PathUtils.join(dir, i === 1 ? name : `${base} (${i})${ext}`);
      if (!(await IOUtils.exists(dest))) return { dest, reuse: false };
      if (await Zotero.Utilities.Internal.md5Async(dest) === srcMD5) return { dest, reuse: true };
    }
    throw new Error("No free filename for " + name);
  }

  /** Store Zotero's download in the watched folder as a linked file (like ZotMoov). */
  async function moveIntoFolder(item, copy) {
    if (item.libraryID !== Zotero.Libraries.userLibraryID) return null;
    if (copy.att.getAnnotations().length) return null; // Zotero annotations belong to the stored item
    const dir = String(pref("moveTarget") || "").trim() || folders()[0];
    await IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true });
    const { dest, reuse } = await uniqueDest(dir, PathUtils.filename(copy.path), copy.md5);
    if (!reuse) {
      await IOUtils.copy(copy.path, dest, { noOverwrite: true });
      if ((await IOUtils.stat(dest)).size !== copy.size) throw new Error("Copy size mismatch: " + dest);
    }
    const { att } = await linkFile(item, dest, copy.att.getField("title"));
    try {
      for (const f of ["url", "accessDate"]) {
        const v = copy.att.getField(f);
        if (v && !att.getField(f)) att.setField(f, v);
      }
      await att.saveTx();
    }
    catch (e) { log("could not copy url/accessDate: " + e); }
    await copy.att.eraseTx(); // only removes Zotero's stored copy; dest stays
    return dest;
  }

  /** Zotero downloaded a second copy of a paper that is already on disk. */
  async function handleCopy(copy, localPath, report) {
    let action = pref("downloadedCopyAction");
    if (action === "keep") return;
    const annotated = await hasAnnotations(copy.att);
    if (action !== "delete") {
      const p = Services.prompt;
      const flags = p.BUTTON_POS_0 * p.BUTTON_TITLE_IS_STRING + p.BUTTON_POS_1 * p.BUTTON_TITLE_IS_STRING
        + p.BUTTON_POS_1_DEFAULT;
      const text = S("deleteAsk", localPath, copy.path) + (annotated ? S("deleteAnnotated") : "");
      // Closing the dialog counts as "Keep".
      action = p.confirmEx(mainWindow(), S("deleteTitle"), text, flags,
        S("deleteYes"), S("deleteNo"), null, null, { value: false }) === 0 ? "delete" : "keep";
    }
    else if (annotated) {
      report.push(S("keptAnnotated"));
      return;
    }
    if (action !== "delete") { report.push(S("keptCopy")); return; }
    // Erase (not trash): removes the attachment item and its file in Zotero storage.
    await copy.att.eraseTx();
    report.push(S("deleted"));
  }

  async function handlePDF(item, { interactive, auto }, report) {
    if (item.libraryID !== Zotero.Libraries.userLibraryID) {
      if (interactive) report.push(S("group"));
      return;
    }
    const copies = await downloadedCopies(item, auto);
    const { pick: found, ambiguous } = await findLocal(item, copies, interactive);
    let pick = found;
    if (!pick && ambiguous.length) pick = chooseDialog(item, ambiguous);

    if (pick) {
      if (interactive || (pick.score < M.CERTAIN && pref("confirmProbable"))) {
        const text = S("confirmLink", item.getField("title"), pick.path, reasonText(pick.reasons));
        if (!Services.prompt.confirm(mainWindow(), S("confirmTitle"), text)) return;
      }
      const { existed } = await linkFile(item, pick.path, copies[0] && copies[0].att.getField("title"));
      report.push(existed ? S("alreadyLinked", pick.path) : S("linked", pick.path));
      if (!existed) report.push(S("reason", reasonText(pick.reasons)));
      for (const copy of copies) await handleCopy(copy, pick.path, report);
      return;
    }

    if (copies.length && pref("noMatchAction") !== "keep") {
      for (const copy of copies) {
        const dest = await moveIntoFolder(item, copy);
        if (dest) report.push(S("moved", dest));
      }
      return;
    }
    // Without any PDF, ensurePDF() runs "Find Available PDF" next and reports on its own.
    if (interactive && (copies.length || !pref("findMissingPDF"))) {
      report.push(copies.length ? S("noMatch", folders().join("\n")) : S("noPDF"));
    }
  }

  // ---- step 4: duplicate records ------------------------------------------

  async function duplicateSet(item) {
    const dup = new Zotero.Duplicates(item.libraryID);
    // _findDuplicates() avoids the temp table that getSearchObject() leaves behind.
    if (typeof dup._findDuplicates === "function") await dup._findDuplicates();
    else await dup.getSearchObject();
    return dup.getSetItemsByItemID(item.id);
  }

  // When entries of different types are merged, the published version wins over a preprint.
  const LOW_RANK_TYPES = new Set(["preprint", "manuscript", "report", "document", "webpage"]);

  function mergedType(all, master) {
    const published = all.filter(i => !LOW_RANK_TYPES.has(Zotero.ItemTypes.getName(i.itemTypeID)));
    if (!published.length || published.includes(master)) return master.itemTypeID;
    return published[0].itemTypeID;
  }

  /** Field of type `typeID` that holds `fieldID` of `source` (same field or same base field). */
  function mapField(source, fieldID, typeID) {
    if (Zotero.ItemFields.isValidForType(fieldID, typeID)) return fieldID;
    const base = Zotero.ItemFields.getBaseIDFromTypeAndField(source.itemTypeID, fieldID);
    return (base && Zotero.ItemFields.getFieldIDFromTypeAndBase(typeID, base)) || null;
  }

  /** Append "field: value" lines to Extra for values an item of `typeID` cannot hold. */
  function keepInExtra(target, source, typeID) {
    const extra = target.getField("extra") || "";
    const have = new Set(extra.split("\n"));
    const lines = [];
    for (const fieldID of source.getUsedFields()) {
      if (mapField(source, fieldID, typeID)) continue;
      const line = `${Zotero.ItemFields.getName(fieldID)}: ${source.getField(fieldID)}`;
      if (!have.has(line)) lines.push(line);
    }
    if (lines.length) target.setField("extra", (extra ? extra + "\n" : "") + lines.join("\n"));
  }

  async function mergeInto(master, others, typeID) {
    if (typeID !== master.itemTypeID) {
      keepInExtra(master, master, typeID);
      master.setType(typeID); // moves base-mapped fields, e.g. preprint repository -> publisher
    }
    // Fill fields the existing entry lacks (e.g. DOI, proceedings title) from the others.
    for (const other of others) {
      keepInExtra(master, other, master.itemTypeID);
      for (const fieldID of other.getUsedFields()) {
        const target = mapField(other, fieldID, master.itemTypeID);
        if (!target || Zotero.ItemFields.getName(target) === "extra" || master.getField(target)) continue;
        try { master.setField(target, other.getField(fieldID)); } catch (e) {}
      }
    }
    if (master.hasChanged()) await master.saveTx();
    let merge;
    try { merge = ChromeUtils.importESModule("chrome://zotero/content/mergeItems.mjs").mergeItems; }
    catch (e) { merge = (a, b) => Zotero.Items.merge(a, b); }
    await merge(master, others);
    for (const other of others) mergedInto.set(other.id, master.id);
    return dedupeChildren(master);
  }

  function noteText(note) {
    return Zotero.Utilities.unescapeHTML(note.getNote() || "").replace(/\s+/g, " ").trim();
  }

  /**
   * Zotero's merge only de-duplicates identical PDFs; notes (e.g. arXiv "Comment: ...") and
   * links to the same file are simply moved over. Trash the later copies; never one with annotations.
   */
  async function dedupeChildren(item) {
    const byAge = (a, b) => (a.dateAdded < b.dateAdded ? -1 : a.dateAdded > b.dateAdded ? 1 : a.id - b.id);
    const seen = new Map();
    const dupes = [];
    for (const note of Zotero.Items.get(item.getNotes()).filter(Boolean).sort(byAge)) {
      const text = noteText(note);
      if (!text) continue;
      if (seen.has("note:" + text)) dupes.push(note.id);
      else seen.set("note:" + text, note);
    }
    for (const att of Zotero.Items.get(item.getAttachments()).filter(Boolean).sort(byAge)) {
      let key = null;
      if (att.isLinkedFileAttachment() && att.getFilePath()) {
        key = "file:" + pathKey(att.getFilePath());
      }
      else if (att.attachmentLinkMode === Zotero.Attachments.LINK_MODE_LINKED_URL && att.getField("url")) {
        key = "url:" + att.getField("url");
      }
      if (!key) continue;
      const first = seen.get(key);
      if (!first) { seen.set(key, att); continue; }
      if (att.getAnnotations().length && !first.getAnnotations().length) {
        dupes.push(first.id);
        seen.set(key, att);
      }
      else if (!att.getAnnotations().length) dupes.push(att.id);
    }
    if (dupes.length) await Zotero.Items.trashTx(dupes);
    return dupes.length;
  }

  // ---- step 5: make sure the paper ends up with a working PDF --------------

  async function workingPDFs(item) {
    const out = [];
    for (const att of Zotero.Items.get(item.getAttachments())) {
      if (att && att.isPDFAttachment() && await att.fileExists()) out.push(att);
    }
    return out;
  }

  /** Stored PDFs whose file never reached this computer (added elsewhere): fetch via Zotero file sync. */
  async function restoreFromSync(item) {
    for (const att of Zotero.Items.get(item.getAttachments())) {
      if (!att || !att.isPDFAttachment() || !att.isStoredFileAttachment() || await att.fileExists()) continue;
      try { await Zotero.Sync.Runner.downloadFile(att); }
      catch (e) { log("file sync download failed: " + e); }
      // Kept as a stored file on purpose: it is synced, and other computers rely on it.
      if (await att.fileExists()) return true;
    }
    return false;
  }

  /** Was this path somewhere PaperLink manages on this computer? */
  function knownLocalPath(path) {
    if (!path) return false;
    if (cache.has(path)) return true;
    return folders().concat(String(pref("moveTarget") || "").trim() || [])
      .some(dir => pathKey(path).startsWith(pathKey(dir) + (Zotero.isWin ? "\\" : "/")));
  }

  async function ensurePDF(item, { interactive }, report) {
    if (item.libraryID !== Zotero.Libraries.userLibraryID) return;
    if (!(await workingPDFs(item)).length) {
      if (await restoreFromSync(item)) report.push(S("restored"));
      else {
        if (!pref("findMissingPDF")) return;
        let att = null;
        try { att = await Zotero.Attachments.addAvailableFile(item); }
        catch (e) { Zotero.logError(e); }
        if (!att) { report.push(S("fetchFailed")); return; }
        report.push(S("fetched"));
        // Treat it like a Connector download: link a local copy, or save it to the folder.
        await handlePDF(item, { interactive: false, auto: true }, report);
      }
    }
    if (!(await workingPDFs(item)).length) return;

    // With a working PDF in place, PDF attachments whose file is unavailable are clutter.
    const removable = [];
    const uncertain = [];
    for (const att of Zotero.Items.get(item.getAttachments())) {
      if (!att || !att.isPDFAttachment() || att.getAnnotations().length || await att.fileExists()) continue;
      // A link into a folder we manage was deleted here; anything else may still work on another
      // computer (synced attachment), and trashing it would sync there too.
      if (att.isLinkedFileAttachment() && knownLocalPath(att.getFilePath())) removable.push(att);
      else uncertain.push(att);
    }
    if (uncertain.length) {
      const names = uncertain.map(a => "• " + (a.getField("title") || a.attachmentFilename)).join("\n");
      if (interactive && Services.prompt.confirm(mainWindow(), S("unavailTitle"), S("unavailAsk", names))) {
        removable.push(...uncertain);
      }
      else report.push(S("unavailKept", names));
    }
    if (removable.length) {
      await Zotero.Items.trashTx(removable.map(a => a.id));
      report.push(S("brokenLinks", removable.length));
    }
  }


  async function handleDuplicates(item, { interactive }, report) {
    const action = pref("duplicateAction");
    if (action === "ignore" && !interactive) return;
    let ids;
    try { ids = await duplicateSet(item); }
    catch (e) { Zotero.logError(e); return; }
    const others = Zotero.Items.get(ids.filter(id => id !== item.id))
      .filter(i => i && !i.deleted && i.isRegularItem());
    if (!others.length) return;

    const all = [item, ...others].sort((a, b) =>
      (a.dateAdded < b.dateAdded ? -1 : a.dateAdded > b.dateAdded ? 1 : a.id - b.id));
    const master = all[0];
    const toMerge = master.id === item.id ? others : [item];
    const win = mainWindow();

    const typeID = mergedType(all, master);
    const typeNames = [...new Set(all.map(i => Zotero.ItemTypes.getLocalizedString(i.itemTypeID)))];
    const typeNote = typeNames.length > 1
      ? S("dupTypes", typeNames.join(" / "), Zotero.ItemTypes.getLocalizedString(typeID)) : "";

    let choice = 1; // keep both
    if (action === "merge" && !interactive) choice = 0;
    else {
      const p = Services.prompt;
      const flags = p.BUTTON_POS_0 * p.BUTTON_TITLE_IS_STRING + p.BUTTON_POS_1 * p.BUTTON_TITLE_IS_STRING
        + p.BUTTON_POS_2 * p.BUTTON_TITLE_IS_STRING + p.BUTTON_POS_1_DEFAULT;
      const added = Zotero.Date.sqlToDate(master.dateAdded, true);
      choice = p.confirmEx(win, S("dupTitle"),
        S("dupText", master.getField("title"), added ? added.toLocaleString() : master.dateAdded) + typeNote,
        flags, S("dupMerge"), S("dupKeep"), S("dupShow"), null, { value: false });
    }

    if (choice === 0) {
      const removed = await mergeInto(master, toMerge, typeID);
      const added = Zotero.Date.sqlToDate(master.dateAdded, true);
      report.push(S("merged", added ? added.toLocaleDateString() : master.dateAdded));
      if (removed) report.push(S("deduped", removed));
      try { await win.ZoteroPane.selectItem(master.id); } catch (e) {}
    }
    else if (choice === 2) {
      try {
        win.ZoteroPane.setVirtual(item.libraryID, "duplicates", true, true);
        await Zotero.Promise.delay(500);
        await win.ZoteroPane.selectItem(item.id);
      }
      catch (e) { Zotero.logError(e); }
    }
  }

  // ---- orchestration -------------------------------------------------------

  async function processItem(itemID, opts) {
    if (busy.has(itemID)) return;
    busy.add(itemID);
    const report = [];
    try {
      const item = await Zotero.Items.getAsync(itemID);
      if (!item || item.deleted || !item.isRegularItem()) return;
      await handlePDF(item, opts, report);
      if (pref("checkDuplicates") && !item.deleted) await handleDuplicates(item, opts, report);
      const target = item.deleted ? Zotero.Items.get(mergedInto.get(item.id)) : item;
      if (target && !target.deleted && opts.interactive) {
        const removed = await dedupeChildren(target);
        if (removed) report.push(S("deduped", removed));
      }
      if (target && !target.deleted) await ensurePDF(target, opts, report);
    }
    catch (e) {
      Zotero.logError(e);
      report.push(String(e && e.message || e));
    }
    finally {
      busy.delete(itemID);
    }
    if (report.length) {
      if (opts.interactive) alert(report.join("\n\n"));
      else notify(report);
    }
  }

  function hasPDFChild(item) {
    return Zotero.Items.get(item.getAttachments()).some(a => a && a.isPDFAttachment());
  }

  async function filesReady(item) {
    for (const att of Zotero.Items.get(item.getAttachments())) {
      if (att && att.isImportedAttachment() && att.isPDFAttachment() && !(await att.fileExists())) return false;
    }
    return true;
  }

  function schedule(parentID) {
    const now = Date.now();
    const entry = pending.get(parentID) || { first: now };
    clearTimeout(entry.timer);
    pending.set(parentID, entry);
    const tick = async () => {
      if (stopped) return;
      const item = Zotero.Items.get(parentID);
      if (!item) { pending.delete(parentID); return; }
      const waited = Date.now() - entry.first;
      // The Connector adds the PDF after the parent; wait for it (bounded).
      const needMore = waited < MAX_WAIT_MS
        && ((!hasPDFChild(item) && waited < NO_PDF_WAIT_MS) || !(await filesReady(item)));
      if (needMore) { entry.timer = setTimeout(tick, 2000); return; }
      pending.delete(parentID);
      await processItem(parentID, { auto: true, interactive: false });
    };
    entry.timer = setTimeout(tick, QUIET_MS);
  }

  /** A PDF arrived for an entry that was merged away meanwhile: move it to the surviving entry. */
  async function adoptOrphan(att, parent) {
    try {
      let masterID = mergedInto.get(parent.id);
      if (!masterID) {
        const rels = await Zotero.Relations.getByPredicateAndObject("item",
          Zotero.Relations.replacedItemPredicate, Zotero.URI.getItemURI(parent));
        masterID = (rels.find(i => !i.deleted) || {}).id;
      }
      const master = masterID && Zotero.Items.get(masterID);
      if (!master || master.deleted) return;
      att.parentItemID = master.id;
      await att.saveTx();
      notify([S("lateMoved")]);
      schedule(master.id);
    }
    catch (e) { Zotero.logError(e); }
  }

  const observer = {
    notify(event, type, ids, extraData) {
      if (stopped || event !== "add" || type !== "item" || !pref("enabled")) return;
      const parents = new Set();
      for (const id of ids) {
        // Items arriving through sync carry skipRenameFile; they were processed on the other machine.
        if (extraData && extraData[id] && extraData[id].skipRenameFile) continue;
        const item = Zotero.Items.get(id);
        if (!item || item.deleted) continue;
        if (item.isRegularItem()) parents.add(item.id);
        else if (item.isAttachment() && item.parentItemID) {
          const parent = Zotero.Items.get(item.parentItemID);
          if (parent && parent.deleted) { adoptOrphan(item, parent); continue; }
          // Only new papers: adding a PDF to an old entry is a deliberate user action.
          if (parent && (pending.has(parent.id) || isRecent(parent))) parents.add(parent.id);
        }
      }
      const fresh = [...parents].filter(id => !pending.has(id));
      if (fresh.length > BATCH_LIMIT) {
        notify([S("batch", fresh.length)]);
        return;
      }
      for (const id of parents) schedule(id);
    },
  };

  async function processSelection() {
    const items = (mainWindow()?.ZoteroPane?.getSelectedItems() || []).filter(i => i.isRegularItem());
    if (!items.length) { alert(S("select")); return; }
    for (const item of items) await processItem(item.id, { auto: false, interactive: true });
  }

  return {
    S,
    folders,
    downloadsDir,
    async start(uri) {
      rootURI = uri;
      stopped = false;
      await loadCache();
      observerID = Zotero.Notifier.registerObserver(observer, ["item"], "PaperLink");
    },
    stop() {
      stopped = true;
      if (observerID) Zotero.Notifier.unregisterObserver(observerID);
      observerID = null;
      for (const entry of pending.values()) clearTimeout(entry.timer);
      pending.clear();
      saveCache();
    },
    processSelection,
    processItem,
  };
})();
