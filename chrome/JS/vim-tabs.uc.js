// ==UserScript==
// @name           vim-tabs
// @description    Vim-style keyboard navigation for Firefox's vertical tabs
// ==/UserScript==

// Ctrl+Z enters nav mode: the vertical tab strip expands and a cursor appears on
// the current tab. j/k move the cursor, gg/G jump to the first/last tab, dd
// closes the tab under the cursor, Enter switches to it, Esc or Ctrl+Z again
// cancels. Moving the cursor never switches tabs by itself.

(function () {
  const CURSOR_ATTR = "vimtabs-cursor";
  const ACTIVE_ATTR = "vimtabs-active";
  // Max gap between the two keys of gg / dd.
  const PREFIX_TIMEOUT_MS = 500;

  const CSS = `
    .tabbrowser-tab[${CURSOR_ATTR}] > .tab-stack > .tab-background {
      outline: 2px solid var(--focus-outline-color, AccentColor) !important;
      outline-offset: -2px !important;
    }
    .tabbrowser-tab[${CURSOR_ATTR}]:not([selected]) > .tab-stack > .tab-background {
      background-color: color-mix(in srgb, currentColor 12%, transparent) !important;
    }
  `;

  let active = false;
  let cursor = null;
  let pendingKey = null;
  let pendingAt = 0;
  let expandedByUs = false;
  let focusBefore = null;
  // True while Firefox switches away from an active tab we're closing.
  let switchingAfterClose = false;

  function navigableTabs() {
    // Pinned tabs first, then unpinned in visual order; skips hidden tabs and
    // tabs inside collapsed groups.
    return gBrowser.tabContainer.ariaFocusableItems.filter(
      el => el.classList.contains("tabbrowser-tab") && !el.closing
    );
  }

  function setCursor(tab) {
    if (!tab) {
      return;
    }
    cursor?.removeAttribute(CURSOR_ATTR);
    cursor = tab;
    tab.setAttribute(CURSOR_ATTR, "");
    if (!tab.pinned) {
      gBrowser.tabContainer.arrowScrollbox.ensureElementIsVisible(tab, true);
    }
  }

  function closeCursorTab() {
    // Stays in nav mode; onTabClose moves the cursor to the tab below.
    if (!cursor) {
      return;
    }
    if (cursor.selected) {
      // Firefox switches to another tab (moving focus into its page) before
      // TabClose fires, so flag it up front.
      switchingAfterClose = true;
      // Fallback in case TabSwitchDone never arrives.
      setTimeout(onTabSwitchDone, 1000);
    }
    gBrowser.removeTab(cursor, { animate: true });
  }

  function moveCursor(delta) {
    const tabs = navigableTabs();
    const i = tabs.indexOf(cursor);
    const next = i < 0 ? 0 : Math.max(0, Math.min(tabs.length - 1, i + delta));
    setCursor(tabs[next]);
  }

  async function expandLauncher() {
    expandedByUs = false;
    const sc = window.SidebarController;
    if (!sc?.sidebarVerticalTabsEnabled) {
      return;
    }
    const state = sc.getUIState();
    if (!state || (state.launcherVisible && state.launcherExpanded)) {
      return;
    }
    // Same as clicking the sidebar toolbar button, so it respects whichever
    // sidebar.visibility mode is configured.
    expandedByUs = true;
    await sc.handleToolbarButtonClick();
  }

  function restoreLauncher() {
    if (expandedByUs) {
      expandedByUs = false;
      window.SidebarController.handleToolbarButtonClick();
    }
  }

  async function enter() {
    if (active) {
      return;
    }
    active = true;
    pendingKey = null;
    switchingAfterClose = false;
    focusBefore = Services.focus.focusedElement;
    // Pull focus out of the page so our keys never reach content.
    Services.focus.clearFocus(window);
    document.documentElement.setAttribute(ACTIVE_ATTR, "");
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keypress", swallow, true);
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("deactivate", onDeactivate);
    window.addEventListener("focusin", onFocusIn, true);
    window.addEventListener("TabSwitchDone", onTabSwitchDone);
    gBrowser.tabContainer.addEventListener("TabSelect", onTabSelect);
    gBrowser.tabContainer.addEventListener("TabClose", onTabClose);
    setCursor(gBrowser.selectedTab);
    await expandLauncher();
  }

  function exit({ select = false, restoreFocus = true } = {}) {
    if (!active) {
      return;
    }
    active = false;
    switchingAfterClose = false;
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("keypress", swallow, true);
    window.removeEventListener("mousedown", onMouseDown, true);
    window.removeEventListener("deactivate", onDeactivate);
    window.removeEventListener("focusin", onFocusIn, true);
    window.removeEventListener("TabSwitchDone", onTabSwitchDone);
    gBrowser.tabContainer.removeEventListener("TabSelect", onTabSelect);
    gBrowser.tabContainer.removeEventListener("TabClose", onTabClose);
    document.documentElement.removeAttribute(ACTIVE_ATTR);

    const target = cursor;
    cursor?.removeAttribute(CURSOR_ATTR);
    cursor = null;
    restoreLauncher();

    if (select && target && target !== gBrowser.selectedTab) {
      gBrowser.selectedTab = target;
    } else if (restoreFocus && focusBefore?.isConnected) {
      focusBefore.focus();
    }
    focusBefore = null;
    if (restoreFocus && !Services.focus.focusedElement) {
      gBrowser.selectedBrowser.focus();
    }
  }

  function toggle() {
    if (active) {
      exit();
    } else {
      enter();
    }
  }

  function swallow(e) {
    if (!(e.ctrlKey || e.metaKey || e.altKey)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }

  function onKeyDown(e) {
    // Let modified keys through: Ctrl+Z reaches our <key> and toggles off, and
    // Cmd shortcuts keep working.
    if (e.ctrlKey || e.metaKey || e.altKey) {
      return;
    }
    swallow(e);

    if (e.key === "g" || e.key === "d") {
      if (pendingKey === e.key && e.timeStamp - pendingAt < PREFIX_TIMEOUT_MS) {
        pendingKey = null;
        if (e.key === "g") {
          setCursor(navigableTabs()[0]);
        } else {
          closeCursorTab();
        }
      } else {
        pendingKey = e.key;
        pendingAt = e.timeStamp;
      }
      return;
    }
    pendingKey = null;

    switch (e.key) {
      case "j":
      case "ArrowDown":
        moveCursor(1);
        break;
      case "k":
      case "ArrowUp":
        moveCursor(-1);
        break;
      case "G":
        setCursor(navigableTabs().at(-1));
        break;
      case "Enter":
        exit({ select: true });
        break;
      case "Escape":
        exit();
        break;
    }
  }

  function onMouseDown() {
    // Any click (including on a tab) ends nav mode and proceeds normally.
    exit();
  }

  function onDeactivate() {
    exit();
  }

  function onFocusIn() {
    if (switchingAfterClose) {
      return;
    }
    // Focus moved somewhere on purpose, e.g. Cmd+L to the URL bar. Leave it
    // there; otherwise we'd keep swallowing the keys meant for it.
    exit({ restoreFocus: false });
  }

  function onTabSelect() {
    // dd on the active tab makes Firefox switch to another one; that shouldn't
    // end nav mode.
    if (switchingAfterClose) {
      return;
    }
    // Something other than Enter switched tabs, e.g. Cmd+T.
    exit();
  }

  function onTabSwitchDone() {
    if (!active || !switchingAfterClose) {
      return;
    }
    switchingAfterClose = false;
    // The switch focused the new tab's page; take focus back so keys stay ours.
    Services.focus.clearFocus(window);
  }

  function onTabClose(e) {
    if (e.target !== cursor) {
      return;
    }
    // Move to the next navigable tab below, else the last one. gBrowser.tabs
    // still includes the closing tab; navigableTabs() already doesn't.
    const tabs = Array.from(gBrowser.tabs);
    const nav = navigableTabs();
    const below = tabs.slice(tabs.indexOf(cursor) + 1).find(t => nav.includes(t));
    setCursor(below ?? nav.at(-1));
  }

  function init() {
    window.windowUtils.loadSheetUsingURIString(
      "data:text/css," + encodeURIComponent(CSS),
      window.windowUtils.AUTHOR_SHEET
    );

    const command = document.createXULElement("command");
    command.id = "cmd_vimTabsToggle";
    command.addEventListener("command", toggle);
    document.getElementById("mainCommandSet").append(command);

    // Firefox binds Ctrl+Z to "toggle sidebar" on macOS, and the built-in key
    // wins over ours, so switch it off. Nav mode expands the sidebar anyway.
    document.getElementById("toggleSidebarKb")?.setAttribute("disabled", "true");

    // A fresh keyset so the key is registered; keys appended to an existing
    // keyset after startup are not always picked up. reserved="true" keeps web
    // pages from swallowing the shortcut. On macOS "control" is the real Ctrl
    // key ("accel" would be Cmd).
    const keyset = document.createXULElement("keyset");
    keyset.id = "vimTabsKeyset";
    const key = document.createXULElement("key");
    key.id = "key_vimTabsToggle";
    key.setAttribute("key", "z");
    key.setAttribute("modifiers", "control");
    key.setAttribute("command", command.id);
    key.setAttribute("reserved", "true");
    keyset.append(key);
    document.documentElement.append(keyset);

    window.VimTabs = { enter, exit, toggle, get active() { return active; } };
  }

  if (window.gBrowserInit?.delayedStartupFinished) {
    init();
  } else {
    const topic = "browser-delayed-startup-finished";
    const observer = subject => {
      if (subject === window) {
        Services.obs.removeObserver(observer, topic);
        init();
      }
    };
    Services.obs.addObserver(observer, topic);
  }
})();
