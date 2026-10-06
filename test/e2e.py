#!/usr/bin/env python3
"""End-to-end test: drives a Firefox started with --marionette and the vim-tabs
script installed. Keys are dispatched with nsITextInputProcessor in the parent
process, so they travel the same path as real keystrokes (XUL <key> handling,
forwarding to content, etc).

    firefox --headless --marionette -no-remote -profile <test-profile>
    python3 test/e2e.py [port] [screenshot.png]
"""
import base64
import json
import socket
import sys

class Marionette:
    def __init__(self, port):
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=30)
        self.buf = b""
        self.msg_id = 0
        self._read()  # server hello

    def _read(self):
        while b":" not in self.buf:
            self.buf += self.sock.recv(65536)
        length, rest = self.buf.split(b":", 1)
        length = int(length)
        while len(rest) < length:
            rest += self.sock.recv(65536)
        self.buf = rest[length:]
        return json.loads(rest[:length])

    def send(self, command, params=None):
        self.msg_id += 1
        data = json.dumps([0, self.msg_id, command, params or {}]).encode()
        self.sock.sendall(str(len(data)).encode() + b":" + data)
        _, _, error, result = self._read()
        if error:
            raise RuntimeError(f"{command}: {error}")
        return result

    def js(self, script, *args):
        return self.send("WebDriver:ExecuteAsyncScript" if "resolve" in script else
                         "WebDriver:ExecuteScript",
                         {"script": script, "args": list(args)})["value"]


KEY_HELPERS = """
  const tip = Cc["@mozilla.org/text-input-processor;1"]
    .createInstance(Ci.nsITextInputProcessor);
  tip.beginInputTransactionForTests(window);
  const named = { Control: ["ControlLeft", 17], Shift: ["ShiftLeft", 16],
                  Meta: ["MetaLeft", 224],
                  Enter: ["Enter", 13], Escape: ["Escape", 27] };
  function ev(key) {
    const [code, keyCode] = named[key] ||
      ["Key" + key.toUpperCase(), key.toUpperCase().charCodeAt(0)];
    return new KeyboardEvent("", { key, code, keyCode });
  }
  function press(keys) {
    for (const k of keys) tip.keydown(ev(k));
    for (const k of [...keys].reverse()) tip.keyup(ev(k));
  }
"""


def keys(m, *chords):
    """Each chord is a list like ["Control", "z"] or ["j"]."""
    m.js(KEY_HELPERS + "for (const c of arguments[0]) press(c);", [list(c) for c in chords])


STATE = """
  const tabs = gBrowser.tabContainer.ariaFocusableItems
    .filter(el => el.classList.contains("tabbrowser-tab"));
  const ui = SidebarController.getUIState();
  return {
    loaded: !!window.VimTabs,
    active: !!window.VimTabs?.active,
    cursor: tabs.findIndex(t => t.hasAttribute("vimtabs-cursor")),
    selected: tabs.indexOf(gBrowser.selectedTab),
    expanded: ui.launcherExpanded,
    count: tabs.length,
    names: tabs.map(t => t.linkedBrowser.contentTitle.split(":")[0]).join(" "),
  };
"""

failures = 0


def check(label, state, **expected):
    global failures
    bad = {k: (state[k], v) for k, v in expected.items() if state[k] != v}
    print(("FAIL " if bad else "ok   ") + label + (f"  {bad}" if bad else ""))
    failures += bool(bad)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 2828
    shot = sys.argv[2] if len(sys.argv) > 2 else None
    m = Marionette(port)
    m.send("WebDriver:NewSession", {"capabilities": {}})
    m.send("Marionette:SetContext", {"value": "chrome"})

    # Five tabs whose pages count the (non-modifier) keydowns they receive in
    # their title.
    m.js("""
      const page = i => "data:text/html,<title>t" + i + ":0</title><script>" +
        "let n=0;addEventListener('keydown',e=>{if(!['Control','Shift','Meta','Alt']" +
        ".includes(e.key))document.title='t" + i + ":'+(++n)})" +
        "</script>";
      const principal = Services.scriptSecurityManager.getSystemPrincipal();
      gBrowser.selectedBrowser.loadURI(Services.io.newURI(page(0)),
        { triggeringPrincipal: principal });
      for (let i = 1; i < 5; i++) {
        gBrowser.addTab(page(i), { triggeringPrincipal: principal });
      }
    """)
    m.js("const resolve = arguments[0]; setTimeout(resolve, 1500);")
    m.js("""
      if (SidebarController.getUIState().launcherExpanded) {
        SidebarController.handleToolbarButtonClick();
      }
      gBrowser.selectedTab = gBrowser.tabs[1];
      gBrowser.selectedBrowser.focus();
    """)
    m.js("const resolve = arguments[0]; setTimeout(resolve, 500);")

    s = m.js(STATE)
    check("script loaded, 5 tabs, launcher collapsed", s, loaded=True, count=5,
          active=False, expanded=False)

    keys(m, ["Control", "z"])
    m.js("const resolve = arguments[0]; setTimeout(resolve, 500);")
    s = m.js(STATE)
    check("ctrl+z: nav mode, cursor on current tab, launcher expanded", s,
          active=True, cursor=1, selected=1, expanded=True)

    keys(m, ["j"], ["j"])
    check("jj: cursor moves down, tab not switched", m.js(STATE), cursor=3, selected=1)

    keys(m, ["k"])
    check("k: cursor moves up", m.js(STATE), cursor=2, selected=1)

    keys(m, ["Shift", "G"])
    check("G: last tab", m.js(STATE), cursor=4, selected=1)

    keys(m, ["j"])
    check("j at bottom: stays", m.js(STATE), cursor=4)

    keys(m, ["g"], ["g"])
    check("gg: first tab", m.js(STATE), cursor=0, selected=1)

    keys(m, ["j"], ["j"], ["j"])
    if shot:
        png = m.send("WebDriver:TakeScreenshot", {"full": False})["value"]
        open(shot, "wb").write(base64.b64decode(png))
        print(f"     screenshot (cursor on tab 3, tab 1 selected) -> {shot}")

    titles = m.js("return gBrowser.tabs.map(t => t.linkedBrowser.contentTitle)")
    check("pages received no keys", {"titles": titles},
          titles=["t0:0", "t1:0", "t2:0", "t3:0", "t4:0"])

    keys(m, ["Enter"])
    m.js("const resolve = arguments[0]; setTimeout(resolve, 500);")
    s = m.js(STATE)
    check("enter: switches to cursor tab, exits, launcher restored", s,
          active=False, cursor=-1, selected=3, expanded=False)
    focused = m.js("return Services.focus.focusedElement === gBrowser.selectedBrowser")
    check("enter: focus back in page", {"focused": focused}, focused=True)

    keys(m, ["Control", "z"], ["k"], ["Escape"])
    m.js("const resolve = arguments[0]; setTimeout(resolve, 500);")
    check("esc: exits without switching", m.js(STATE), active=False, selected=3,
          expanded=False)

    keys(m, ["Control", "z"])
    m.js("const resolve = arguments[0]; setTimeout(resolve, 300);")
    keys(m, ["Control", "z"])
    m.js("const resolve = arguments[0]; setTimeout(resolve, 500);")
    check("ctrl+z twice: toggles off", m.js(STATE), active=False, selected=3,
          expanded=False)

    # Typing in a page still works after all that.
    keys(m, ["x"])
    m.js("const resolve = arguments[0]; setTimeout(resolve, 300);")
    title = m.js("return gBrowser.selectedBrowser.contentTitle")
    check("keys reach the page again after exit", {"t": title}, t="t3:1")

    # Cmd+L from nav mode hands the keyboard to the URL bar.
    keys(m, ["Control", "z"])
    m.js("const resolve = arguments[0]; setTimeout(resolve, 500);")
    check("ctrl+z again: nav mode", m.js(STATE), active=True)
    keys(m, ["Meta", "l"], ["a"], ["b"], ["c"])
    m.js("const resolve = arguments[0]; setTimeout(resolve, 300);")
    s = m.js(STATE)
    urlbar = m.js("return [gURLBar.value, gURLBar.focused]")
    check("cmd+l: exits nav mode, URL bar takes typing", {**s, "urlbar": urlbar},
          active=False, cursor=-1, expanded=False, urlbar=["abc", True])

    # dd closes the tab under the cursor and stays in nav mode.
    keys(m, ["Control", "z"])
    m.js("const resolve = arguments[0]; setTimeout(resolve, 500);")
    keys(m, ["k"], ["d"], ["d"])
    m.js("const resolve = arguments[0]; setTimeout(resolve, 800);")
    check("dd: closes cursor tab, cursor on the tab below, still in nav mode",
          m.js(STATE), active=True, count=4, cursor=2, selected=2,
          names="t0 t1 t3 t4")

    keys(m, ["d"], ["d"])
    m.js("const resolve = arguments[0]; setTimeout(resolve, 800);")
    check("dd on the active tab: closes it, still in nav mode", m.js(STATE),
          active=True, count=3, cursor=2, names="t0 t1 t4")

    keys(m, ["d"])
    m.js("const resolve = arguments[0]; setTimeout(resolve, 700);")
    keys(m, ["d"])
    m.js("const resolve = arguments[0]; setTimeout(resolve, 500);")
    check("d ... d too slow: nothing closed", m.js(STATE), active=True, count=3)

    keys(m, ["Escape"])
    m.js("const resolve = arguments[0]; setTimeout(resolve, 300);")
    check("esc after dd: exits", m.js(STATE), active=False, count=3)

    print("\nPASS" if not failures else f"\n{failures} FAILED")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
