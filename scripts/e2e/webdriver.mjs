// X-06: a small W3C WebDriver client over fetch, for tauri-driver (http://127.0.0.1:4444). No dependencies: the
// end-to-end tests need sessions, finding elements, clicks, typing, keys, scripts and screenshots, nothing more.

const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";
export const KEY = { enter: "", escape: "", control: "", shift: "" };

export class WebDriver {
  /** @param {string} url tauri-driver's address */
  constructor(url = "http://127.0.0.1:4444") {
    this.url = url;
    this.session = null;
  }

  async call(method, path, body) {
    const res = await fetch(`${this.url}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(
        `${method} ${path}: ${json.value?.error ?? res.status} ${json.value?.message ?? ""}`.trim(),
      );
      err.code = json.value?.error;
      throw err;
    }
    return json.value;
  }

  sessionCall(method, path, body) {
    if (!this.session) throw new Error("no WebDriver session");
    return this.call(method, `/session/${this.session}${path}`, body);
  }

  /** Starts the app under test. */
  async start(application) {
    const value = await this.call("POST", "/session", {
      capabilities: {
        alwaysMatch: {
          browserName: "wry",
          // On Windows, msedgedriver attaches to the app's WebView2 only when webviewOptions is there; tauri-driver 2.1
          // passes it on but no longer adds it, and without it the app is launched as if it were Edge.
          "tauri:options": { application, ...(process.platform === "win32" ? { webviewOptions: {} } : {}) },
        },
      },
    });
    this.session = value.sessionId;
  }

  async stop() {
    if (!this.session) return;
    await this.call("DELETE", `/session/${this.session}`).catch(() => undefined);
    this.session = null;
  }

  /** Finds elements now; `query` starting with "/" or "(" is XPath, anything else CSS. */
  async findAll(query) {
    const using = query.startsWith("/") || query.startsWith("(") ? "xpath" : "css selector";
    const found = await this.sessionCall("POST", "/elements", { using, value: query });
    return found.map((e) => new Element(this, e[ELEMENT] ?? Object.values(e)[0]));
  }

  /** Waits until `query` finds a visible element, and returns the first one. */
  async find(query, { timeout = 30_000 } = {}) {
    let last = "";
    const el = await waitFor(
      async () => {
        for (const e of await this.findAll(query)) {
          if (await e.displayed().catch(() => false)) return e;
        }
        last = "found nothing visible";
        return null;
      },
      { timeout, what: `${query} (${last || "waiting"})` },
    );
    return el;
  }

  /** Waits until the page shows `text` somewhere, as a visible element's text. */
  async findText(text, { tag = "*", timeout = 30_000 } = {}) {
    return this.find(
      `//${tag}[contains(normalize-space(.), ${xpathString(text)})][not(.//*[contains(normalize-space(.), ${xpathString(text)})])]`,
      {
        timeout,
      },
    );
  }

  /** A button by its visible text or its accessible name. */
  async button(name, opts) {
    const n = xpathString(name);
    return this.find(`//button[normalize-space(.)=${n} or @aria-label=${n}]`, opts);
  }

  execute(script, args = []) {
    return this.sessionCall("POST", "/execute/sync", { script, args });
  }

  /** Presses keys together (modifiers first) and releases them. */
  async chord(...keys) {
    const down = keys.map((k) => ({ type: "keyDown", value: k }));
    const up = [...keys].reverse().map((k) => ({ type: "keyUp", value: k }));
    await this.sessionCall("POST", "/actions", {
      actions: [{ type: "key", id: "keyboard", actions: [...down, ...up] }],
    });
    await this.sessionCall("DELETE", "/actions");
  }

  /** PNG bytes of the window. */
  async screenshot() {
    return Buffer.from(await this.sessionCall("GET", "/screenshot"), "base64");
  }
}

class Element {
  constructor(driver, id) {
    this.driver = driver;
    this.id = id;
  }
  call(method, path, body) {
    return this.driver.sessionCall(method, `/element/${this.id}${path}`, body);
  }
  click() {
    return this.call("POST", "/click", {});
  }
  type(text) {
    return this.call("POST", "/value", { text });
  }
  clear() {
    return this.call("POST", "/clear", {});
  }
  text() {
    return this.call("GET", "/text");
  }
  attribute(name) {
    return this.call("GET", `/attribute/${name}`);
  }
  selected() {
    return this.call("GET", "/selected");
  }
  displayed() {
    return this.call("GET", "/displayed");
  }
}

/** Polls `check` until it returns something truthy, or throws after `timeout`. */
export async function waitFor(check, { timeout = 30_000, interval = 250, what = "a condition" } = {}) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(
    `timed out after ${timeout / 1000} s waiting for ${what}${lastError ? `: ${lastError.message}` : ""}`,
  );
}

/** An XPath string literal for any text, quotes included. */
export function xpathString(s) {
  if (!s.includes("'")) return `'${s}'`;
  if (!s.includes('"')) return `"${s}"`;
  return `concat(${s
    .split("'")
    .map((part) => `'${part}'`)
    .join(`, "'", `)})`;
}
