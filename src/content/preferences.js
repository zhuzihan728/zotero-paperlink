/* Preference pane script. Runs in a sandbox whose prototype is the
 * preferences window; handlers in the markup are evaluated on the window,
 * so the API is exported there. */
var { FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");

window.PaperLinkPrefs = {
  init() {
    const desc = document.getElementById("paperlink-default-folder");
    if (!desc) return;
    let dl = "";
    try { dl = Services.dirsvc.get("DfltDwnld", Components.interfaces.nsIFile).path; } catch (e) {}
    const zh = String(Zotero.locale || "").startsWith("zh");
    desc.textContent = (zh ? "留空 = 系统下载文件夹：" : "Empty = system Downloads folder: ") + dl
      + (zh ? "。多个文件夹用 ; 分隔。" : ". Separate several folders with ;");
  },

  async browse(inputID, append) {
    const input = document.getElementById(inputID);
    const fp = new FilePicker();
    fp.init(window, "PaperLink", fp.modeGetFolder);
    if (await fp.show() !== fp.returnOK) return;
    const current = input.value.trim();
    input.value = append && current ? current + ";" + fp.file : fp.file;
    // Write through to the preference, as typing would.
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  },
};
