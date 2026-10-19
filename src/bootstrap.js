/* PaperLink — Zotero plugin bootstrap (Zotero 7 and later, Windows / macOS / Linux). */
var menuID = null;
var paneID = null;
var pluginID = null;

function install() {}
function uninstall() {}

async function startup({ id, version, rootURI }) {
  pluginID = id;
  Services.scriptloader.loadSubScript(rootURI + "content/match.js");
  Services.scriptloader.loadSubScript(rootURI + "content/paperlink.js");
  await PaperLink.start(rootURI);

  paneID = await Zotero.PreferencePanes.register({
    pluginID: id,
    src: rootURI + "content/preferences.xhtml",
    scripts: [rootURI + "content/preferences.js"],
    label: "PaperLink",
  });

  if (Zotero.MenuManager?.registerMenu) {
    menuID = Zotero.MenuManager.registerMenu({
      menuID: "paperlink-process",
      pluginID: id,
      target: "main/library/item",
      menus: [{
        menuType: "menuitem",
        l10nID: "paperlink-menu-process",
        onCommand: () => { PaperLink.processSelection().catch(e => Zotero.logError(e)); },
      }],
    });
  }
  for (const win of Zotero.getMainWindows()) onMainWindowLoad({ window: win });
  Zotero.debug(`PaperLink ${version}: started`);
}

function onMainWindowLoad({ window }) {
  window.MozXULElement?.insertFTLIfNeeded("paperlink.ftl");
  // Zotero 7 has no MenuManager: add the context menu item to the DOM instead.
  if (menuID || window.document.getElementById("paperlink-menu-process")) return;
  const menu = window.document.getElementById("zotero-itemmenu");
  if (!menu) return;
  const item = window.document.createXULElement("menuitem");
  item.id = "paperlink-menu-process";
  item.setAttribute("data-l10n-id", "paperlink-menu-process");
  item.addEventListener("command", () => { PaperLink.processSelection().catch(e => Zotero.logError(e)); });
  menu.appendChild(item);
}

function onMainWindowUnload({ window }) {
  window.document.getElementById("paperlink-menu-process")?.remove();
  window.document.querySelector('[href="paperlink.ftl"]')?.remove();
}

function shutdown() {
  for (const win of Zotero.getMainWindows()) onMainWindowUnload({ window: win });
  if (menuID && Zotero.MenuManager?.unregisterMenu) Zotero.MenuManager.unregisterMenu(menuID);
  if (paneID) Zotero.PreferencePanes.unregister(paneID);
  if (typeof PaperLink !== "undefined") PaperLink.stop();
  menuID = paneID = null;
  PaperLink = undefined;
  PaperLinkMatch = undefined;
}
