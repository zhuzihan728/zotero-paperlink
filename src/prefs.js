pref("extensions.paperlink.enabled", true);
// Folders to search, separated by ";". Empty = the system Downloads folder.
pref("extensions.paperlink.folders", "");
// How many levels of subfolders to search (0 = only the folder itself).
pref("extensions.paperlink.scanDepth", 2);
// When a local copy is found, Zotero's own download is: "ask" (then delete permanently or keep),
// "delete" permanently without asking (annotated copies are kept), or "keep".
pref("extensions.paperlink.downloadedCopyAction", "ask");
// When no local copy is found: "move" Zotero's download into moveTarget and link it, or "keep" it in Zotero storage.
pref("extensions.paperlink.noMatchAction", "move");
// Where new PDFs are saved. Empty = first search folder (system Downloads by default).
pref("extensions.paperlink.moveTarget", "");
// Ask before linking a match based only on the title (not DOI / arXiv ID / identical file).
pref("extensions.paperlink.confirmProbable", false);
// If a paper ends up without a usable PDF (Connector sent none, or the linked file was deleted),
// download one with Zotero's "Find Available PDF".
pref("extensions.paperlink.findMissingPDF", true);
pref("extensions.paperlink.checkDuplicates", true);
// Duplicate entries: "ask", "merge" into the older entry, or "ignore".
pref("extensions.paperlink.duplicateAction", "ask");
pref("extensions.paperlink.notify", true);
