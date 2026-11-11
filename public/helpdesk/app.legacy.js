/* Сборка для старых браузеров (Firefox 52). Не редактировать: собирается из public/helpdesk/app.js — clients/helpdesk-legacy */
(() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropSymbols = Object.getOwnPropertySymbols;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __propIsEnum = Object.prototype.propertyIsEnumerable;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __spreadValues = (a, b) => {
    for (var prop in b || (b = {}))
      if (__hasOwnProp.call(b, prop))
        __defNormalProp(a, prop, b[prop]);
    if (__getOwnPropSymbols)
      for (var prop of __getOwnPropSymbols(b)) {
        if (__propIsEnum.call(b, prop))
          __defNormalProp(a, prop, b[prop]);
      }
    return a;
  };

  // polyfills.js
  if (window.__helpdeskOutdated) throw new Error("browser outdated");
  if (!Object.fromEntries) {
    Object.fromEntries = function(entries) {
      var o = {};
      Array.from(entries, function(e) {
        o[e[0]] = e[1];
      });
      return o;
    };
  }
  if (!Element.prototype.replaceChildren) {
    Element.prototype.replaceChildren = function() {
      while (this.firstChild) this.removeChild(this.firstChild);
      this.append.apply(this, arguments);
    };
  }
  (function() {
    var l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = "/shared/legacy.css";
    document.head.appendChild(l);
    document.documentElement.className += " legacy";
  })();

  // ../../public/shared/ui.js
  function h(tag, ...args) {
    const m = tag.match(/^([a-z0-9]+)?((?:[.#][\w-]+)*)$/i);
    const el = document.createElement(m[1] || "div");
    for (const part of (m[2] || "").match(/[.#][\w-]+/g) || []) {
      if (part[0] === ".") el.classList.add(part.slice(1));
      else el.id = part.slice(1);
    }
    for (const a of args) add(el, a);
    if ("_value" in el) {
      el.value = el._value;
      delete el._value;
    }
    return el;
  }
  function add(el, a) {
    if (a == null || a === false) return;
    if (Array.isArray(a)) {
      a.forEach((x) => add(el, x));
      return;
    }
    if (a instanceof Node) {
      el.append(a);
      return;
    }
    if (typeof a === "object") {
      for (const [k, v] of Object.entries(a)) {
        if (v == null || v === false) continue;
        if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === "style" && typeof v === "object") {
          for (const [sk, sv] of Object.entries(v)) {
            if (sk.startsWith("--")) el.style.setProperty(sk, sv);
            else el.style[sk] = sv;
          }
        } else if (k === "class") el.className += " " + v;
        else if (k === "html") el.innerHTML = v;
        else if (k === "value") el._value = v;
        else if (k in el && typeof v !== "string") el[k] = v;
        else el.setAttribute(k, v === true ? "" : v);
      }
      return;
    }
    el.append(String(a));
  }
  var clear = (el, ...children) => {
    el.replaceChildren();
    children.forEach((c) => add(el, c));
    return el;
  };
  function makeApi(base, { onUnauthorized, csrf = "portal" } = {}) {
    async function call(method, url, body) {
      const opt = { method, headers: { "X-Requested-With": csrf }, credentials: "same-origin" };
      if (body instanceof FormData) opt.body = body;
      else if (body !== void 0) {
        opt.headers["Content-Type"] = "application/json";
        opt.body = JSON.stringify(body);
      }
      const res = await fetch(url.startsWith("/") && !url.startsWith(base) ? base + url : url, opt);
      const ct = res.headers.get("content-type") || "";
      const data = ct.includes("application/json") ? await res.json() : null;
      if (res.status === 401 && onUnauthorized) onUnauthorized(data);
      if (!res.ok) {
        const e = new Error(data && data.error || `\u041E\u0448\u0438\u0431\u043A\u0430 ${res.status}`);
        e.status = res.status;
        e.data = data;
        throw e;
      }
      return data;
    }
    return {
      get: (u) => call("GET", u),
      post: (u, b) => call("POST", u, b != null ? b : {}),
      put: (u, b) => call("PUT", u, b != null ? b : {}),
      patch: (u, b) => call("PATCH", u, b != null ? b : {}),
      del: (u) => call("DELETE", u)
    };
  }
  function toast(text, type = "ok", title) {
    let box = document.getElementById("flags");
    if (!box) {
      box = h("div#flags.flags");
      document.body.append(box);
    }
    const el = h(
      "div.flag." + type,
      h("div.ic", type === "ok" ? "\u2713" : type === "err" ? "!" : "i"),
      h("div", title || type === "err" ? h("div.t", title || "\u041E\u0448\u0438\u0431\u043A\u0430") : null, h("div", text))
    );
    box.append(el);
    el.addEventListener("click", () => el.remove());
    setTimeout(() => el.remove(), type === "err" ? 7e3 : 4e3);
  }
  async function run(fn, btn) {
    if (btn) btn.disabled = true;
    try {
      return await fn();
    } catch (e) {
      toast(e.message || String(e), "err");
      return void 0;
    } finally {
      if (btn) btn.disabled = false;
    }
  }
  var fmtDate = (v) => v ? new Date(v).toLocaleDateString("ru-RU") : "";
  var fmtDateTime = (v) => v ? new Date(v).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }) : "";
  function fmtSize(b) {
    if (b < 1024) return `${b} \u0411`;
    if (b < 1024 * 1024) return `${Math.round(b / 1024)} \u041A\u0411`;
    return `${(b / 1024 / 1024).toFixed(1)} \u041C\u0411`;
  }
  function relTime(v) {
    if (!v) return "";
    const diff = (Date.now() - new Date(v).getTime()) / 1e3;
    if (diff < 60) return "\u0442\u043E\u043B\u044C\u043A\u043E \u0447\u0442\u043E";
    if (diff < 3600) return `${Math.floor(diff / 60)} \u043C\u0438\u043D \u043D\u0430\u0437\u0430\u0434`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} \u0447 \u043D\u0430\u0437\u0430\u0434`;
    if (diff < 7 * 86400) return `${Math.floor(diff / 86400)} \u0434\u043D \u043D\u0430\u0437\u0430\u0434`;
    return fmtDate(v);
  }
  var AV_COLORS = ["#0052CC", "#00875A", "#FF5630", "#6554C0", "#00A3BF", "#FF8B00", "#36B37E", "#5243AA"];
  function avatar(name, size = "") {
    const n = String(name || "?");
    let sum = 0;
    for (const ch of n) sum += ch.charCodeAt(0);
    const ini = n.split(/[\s.]+/).filter(Boolean).slice(0, 2).map((s) => s[0]).join("").toUpperCase();
    return h("span.avatar" + (size ? "." + size : ""), { style: { background: AV_COLORS[sum % AV_COLORS.length] }, title: n }, ini || "?");
  }
  var statusPill = (name, color) => h("span.pill", { style: { background: color + "26", color: shade(color) } }, name);
  function shade(hex) {
    const n = parseInt(String(hex).slice(1), 16);
    if (Number.isNaN(n)) return hex;
    const f = (v) => Math.round(v * 0.75).toString(16).padStart(2, "0");
    return "#" + f(n >> 16 & 255) + f(n >> 8 & 255) + f(n & 255);
  }
  function parseHash() {
    const raw = location.hash.replace(/^#/, "") || "/";
    const [path, qs] = raw.split("?");
    return { path, parts: path.split("/").filter(Boolean), params: new URLSearchParams(qs || "") };
  }
  function topbar(o) {
    const menuEl = h("div.popover.hidden");
    const closeMenu = () => menuEl.classList.add("hidden");
    document.addEventListener("click", (e) => {
      if (!menuEl.contains(e.target)) closeMenu();
    });
    const fill = () => clear(
      menuEl,
      h("div.menu-head", o.userName + (o.userSub ? " \xB7 " + o.userSub : "")),
      (o.menu || []).map((it) => {
        if (it === "-") return h("div.menu-sep");
        if (it.head) return h("div.menu-head", it.head);
        return it.href ? h("a.menu-item" + (it.danger ? ".danger" : ""), { href: it.href, target: it.target }, it.label) : h("button.menu-item" + (it.danger ? ".danger" : ""), { type: "button", onclick: () => {
          closeMenu();
          it.onClick();
        } }, it.label);
      })
    );
    const av = avatar(o.userName);
    av.addEventListener("click", (e) => {
      e.stopPropagation();
      fill();
      menuEl.classList.toggle("hidden");
    });
    return h(
      "header.topbar",
      o.onBurger ? h("button.btn.subtle.icon.burger", { onclick: o.onBurger, title: "\u041C\u0435\u043D\u044E" }, "\u2630") : null,
      h(
        "a.brand",
        { href: o.brandHref || "/", title: "\u0413\u043B\u0430\u0432\u043D\u0430\u044F \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0430 \u043F\u043E\u0440\u0442\u0430\u043B\u0430" },
        h("span.brand-logo" + (o.logo === "hd" ? ".hd" : ""), o.logo === "hd" ? "?" : "IT"),
        h("span", o.brandText || "\u041F\u043E\u0440\u0442\u0430\u043B")
      ),
      o.section ? h("a.brand", { href: o.sectionHref || "#/", style: { marginLeft: "-12px" } }, h("span.sep", "/"), h("span", o.section)) : null,
      h(
        "nav.topnav.row",
        { style: { gap: "2px" } },
        (o.nav || []).map(([k, href, label]) => h("a" + (k === o.active ? ".active" : ""), { href }, label))
      ),
      (o.actions || []).length ? h("span.row", { style: { marginLeft: "8px" } }, o.actions) : null,
      h("span.spacer"),
      h("span.user-name", o.userName),
      h("span.user-wrap", av, menuEl)
    );
  }

  // ../../public/shared/thread.js
  var isImage = (f) => /^image\/(png|jpe?g|gif|webp|bmp)$/i.test(f.mime_type);
  function fileList(files, urlFor) {
    if (!files.length) return null;
    return h("div.files", files.map((f) => h(
      "a.file",
      { href: urlFor(f), target: "_blank", rel: "noopener", title: f.filename },
      isImage(f) ? h("img", { src: urlFor(f), alt: "" }) : "\u{1F4CE}",
      h("span", f.filename),
      h("span.muted.small", fmtSize(f.size)),
      f.is_internal ? h("span.lozenge.yellow", "\u0432\u043D\u0443\u0442\u0440.") : null
    )));
  }
  function thread(comments, attachments, { urlFor, isMine = (c) => c.mine }) {
    if (!comments.length) return h("p.muted", "\u041A\u043E\u043C\u043C\u0435\u043D\u0442\u0430\u0440\u0438\u0435\u0432 \u043F\u043E\u043A\u0430 \u043D\u0435\u0442");
    return h("div.thread", comments.map((c) => {
      const files = attachments.filter((a) => a.comment_id === c.id);
      return h(
        "div.msg" + (isMine(c) ? ".mine" : "") + (c.is_internal ? ".internal" : ""),
        avatar(c.author || "?", "sm"),
        h(
          "div.msg-body",
          h(
            "div.msg-head",
            h("strong", c.author || "\u2014"),
            h("span", { title: fmtDateTime(c.created_at) }, relTime(c.created_at)),
            c.is_internal ? h("span.lozenge.yellow", "\u0432\u043D\u0443\u0442\u0440\u0435\u043D\u043D\u0438\u0439 \u2014 \u0437\u0430\u044F\u0432\u0438\u0442\u0435\u043B\u044C \u043D\u0435 \u0432\u0438\u0434\u0438\u0442") : null
          ),
          h("div.msg-text", c.body),
          fileList(files, urlFor)
        )
      );
    }));
  }
  function fileInput() {
    const input = h("input", { type: "file", multiple: true });
    const note = h("span.muted.small", "\u0434\u043E 5 \u0444\u0430\u0439\u043B\u043E\u0432, \u043D\u0435 \u0431\u043E\u043B\u044C\u0448\u0435 10 \u041C\u0411 \u043A\u0430\u0436\u0434\u044B\u0439");
    const el = h("label.file-input", h("span", "\u{1F4CE} \u0424\u0430\u0439\u043B\u044B:"), input, note);
    return { el, input, files: () => [...input.files], reset: () => {
      input.value = "";
    } };
  }
  var ACTION = {
    created: () => "\u0441\u043E\u0437\u0434\u0430\u043B(\u0430) \u0437\u0430\u044F\u0432\u043A\u0443",
    status: (d) => ["\u0441\u0442\u0430\u0442\u0443\u0441: ", h("b", d.from || "\u2014"), " \u2192 ", h("b", d.to || "\u2014")],
    assignee: (d) => d.to ? ["\u0438\u0441\u043F\u043E\u043B\u043D\u0438\u0442\u0435\u043B\u044C: ", h("b", d.to)] : ["\u0441\u043D\u044F\u0442 \u0438\u0441\u043F\u043E\u043B\u043D\u0438\u0442\u0435\u043B\u044C ", h("b", d.from || "")],
    due: (d) => d.to ? ["\u0441\u0440\u043E\u043A: ", h("b", fmtDateTime(d.to))] : "\u0441\u0440\u043E\u043A \u0441\u043D\u044F\u0442",
    priority: (d) => ["\u043F\u0440\u0438\u043E\u0440\u0438\u0442\u0435\u0442: ", h("b", d.to)],
    category: (d) => ["\u0432\u0438\u0434 \u043F\u0440\u043E\u0431\u043B\u0435\u043C\u044B: ", h("b", d.to || "\u2014")],
    device: (d) => d.added ? `\u043F\u0440\u0438\u0432\u044F\u0437\u0430\u043D\u0430 \u0442\u0435\u0445\u043D\u0438\u043A\u0430 ${d.added}` : d.removed ? `\u043E\u0442\u0432\u044F\u0437\u0430\u043D\u0430 \u0442\u0435\u0445\u043D\u0438\u043A\u0430 ${d.removed}` : d.to ? "\u043F\u0440\u0438\u0432\u044F\u0437\u0430\u043D\u0430 \u0442\u0435\u0445\u043D\u0438\u043A\u0430 \u0438\u0437 \u0438\u043D\u0432\u0435\u043D\u0442\u0430\u0440\u044F" : "\u043E\u0442\u0432\u044F\u0437\u0430\u043D\u0430 \u0442\u0435\u0445\u043D\u0438\u043A\u0430"
  };
  function historyList(items) {
    if (!items.length) return null;
    return h("ul.history", items.map((x) => h(
      "li",
      h("span", { title: fmtDateTime(x.created_at) }, fmtDateTime(x.created_at)),
      " \xB7 ",
      x.author ? [h("b", x.author), " "] : null,
      (ACTION[x.action] || (() => x.action))(x.details || {})
    )));
  }

  // ../../public/helpdesk/app.js
  var api = makeApi("/api", { csrf: "helpdesk", onUnauthorized: () => {
    if (me) {
      me = null;
      location.hash = "#/login";
    }
  } });
  var fileUrl = (f) => "/api/attachments/" + f.id;
  var app = document.getElementById("app");
  var me = null;
  var cfg = null;
  var statuses = [];
  async function boot() {
    cfg = await api.get("/config");
    try {
      me = await api.get("/me");
    } catch (e) {
      me = null;
    }
    window.addEventListener("hashchange", route);
    route();
  }
  var PUBLIC = ["login", "register", "verify", "forgot", "pending"];
  var departmentsCache = null;
  var loadDepartments = () => {
    if (!departmentsCache) departmentsCache = api.get("/departments").then((d) => d.departments).catch(() => {
      departmentsCache = null;
      return [];
    });
    return departmentsCache;
  };
  var normText = (s) => String(s || "").toLowerCase().replace(/ё/g, "\u0435").replace(/\s+/g, " ").trim();
  function departmentPicker(cur) {
    const input = h("input", { type: "text", value: cur.department || "", autocomplete: "off", placeholder: "\u041D\u0430\u0447\u043D\u0438\u0442\u0435 \u0432\u0432\u043E\u0434\u0438\u0442\u044C: \u043D\u0430\u0437\u0432\u0430\u043D\u0438\u0435, \u043F\u043E\u043B\u043D\u043E\u0435 \u0438\u043B\u0438 \u043A\u043E\u0440\u043E\u0442\u043A\u043E\u0435" });
    const list = h("div.dp-list.hidden");
    const note = h("div.hint");
    let id = cur.department_id || null;
    let items = [];
    let shown = [];
    let active = -1;
    let open = false;
    const updateNote = () => {
      note.textContent = id ? "\u041E\u0442\u0434\u0435\u043B \u0432\u044B\u0431\u0440\u0430\u043D \u0438\u0437 \u0441\u043F\u0438\u0441\u043A\u0430" : input.value.trim() && items.length ? "\u041E\u0442\u0434\u0435\u043B \u043D\u0435 \u0432\u044B\u0431\u0440\u0430\u043D \u0438\u0437 \u0441\u043F\u0438\u0441\u043A\u0430 \u2014 \u0431\u0443\u0434\u0435\u0442 \u0441\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u043E, \u043A\u0430\u043A \u043D\u0430\u043F\u0438\u0441\u0430\u043D\u043E" : "";
      note.className = "hint" + (id ? " dp-ok" : "");
    };
    const pick = (d) => {
      id = d.id;
      input.value = d.name;
      open = false;
      draw();
      updateNote();
    };
    function draw() {
      const q = normText(input.value);
      shown = items.filter((d) => !q || [d.name, d.full_name, d.short_name].some((x) => normText(x).indexOf(q) !== -1)).slice(0, 60);
      if (active >= shown.length) active = shown.length - 1;
      clear(list, shown.length ? shown.map((d, i) => h(
        "div.dp-item" + (i === active ? ".active" : ""),
        {
          onmousedown: (e) => {
            e.preventDefault();
            pick(d);
          }
        },
        h("div", h("b", d.name), d.short_name ? h("span.muted", " \xB7 " + d.short_name) : null),
        d.full_name ? h("div.small.muted", d.full_name) : null
      )) : h("div.dp-empty", items.length ? "\u0422\u0430\u043A\u043E\u0433\u043E \u043E\u0442\u0434\u0435\u043B\u0430 \u043D\u0435\u0442 \u0432 \u0441\u043F\u0438\u0441\u043A\u0435 \u2014 \u043C\u043E\u0436\u043D\u043E \u043E\u0441\u0442\u0430\u0432\u0438\u0442\u044C \u0441\u0432\u043E\u0451 \u043D\u0430\u0437\u0432\u0430\u043D\u0438\u0435" : "\u0421\u043F\u0438\u0441\u043E\u043A \u043E\u0442\u0434\u0435\u043B\u043E\u0432 \u043F\u0443\u0441\u0442 \u2014 \u043D\u0430\u043F\u0438\u0448\u0438\u0442\u0435 \u043D\u0430\u0437\u0432\u0430\u043D\u0438\u0435"));
      if (open && (items.length || q)) list.classList.remove("hidden");
      else list.classList.add("hidden");
    }
    input.addEventListener("input", () => {
      id = null;
      open = true;
      active = -1;
      draw();
      updateNote();
    });
    input.addEventListener("focus", () => {
      open = true;
      draw();
    });
    input.addEventListener("blur", () => {
      open = false;
      draw();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "Down") {
        e.preventDefault();
        open = true;
        active = Math.min(shown.length - 1, active + 1);
        draw();
      } else if (e.key === "ArrowUp" || e.key === "Up") {
        e.preventDefault();
        active = Math.max(0, active - 1);
        draw();
      } else if (e.key === "Enter" && open && shown[active]) {
        e.preventDefault();
        pick(shown[active]);
      } else if (e.key === "Escape" || e.key === "Esc") {
        open = false;
        draw();
      }
    });
    loadDepartments().then((d) => {
      items = d;
      draw();
      updateNote();
    });
    return {
      el: h("div.dp", input, list),
      note,
      value: () => ({ department: input.value.trim(), department_id: id })
    };
  }
  async function route() {
    const { parts, params } = parseHash();
    const page = parts[0] || "";
    window.scrollTo(0, 0);
    if (!me && !PUBLIC.includes(page)) {
      location.hash = "#/login";
      return;
    }
    if (me && PUBLIC.includes(page)) {
      location.hash = "#/";
      return;
    }
    try {
      if (page === "login") renderLogin();
      else if (page === "register") renderRegister();
      else if (page === "verify") renderVerify(params.get("email") || "");
      else if (page === "forgot") renderForgot();
      else if (page === "pending") renderPending();
      else if (page === "new") await renderNew();
      else if (page === "tickets" && parts[1]) await renderTicket(Number(parts[1]));
      else if (page === "profile") renderProfile();
      else await renderList(params.get("state") || "open");
    } catch (e) {
      shell(h("div.empty-state", "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044C: " + e.message));
    }
  }
  function shell(...content) {
    const nav = [["", "#/", "\u041C\u043E\u0438 \u0437\u0430\u044F\u0432\u043A\u0438"], ["new", "#/new", "\u041D\u043E\u0432\u0430\u044F \u0437\u0430\u044F\u0432\u043A\u0430"], ["profile", "#/profile", "\u041F\u0440\u043E\u0444\u0438\u043B\u044C"]];
    const cur = parseHash().parts[0] || "";
    clear(
      app,
      topbar({
        brandText: "HelpDesk",
        brandHref: "#/",
        logo: "hd",
        nav,
        active: cur === "tickets" ? "" : cur,
        actions: cur === "new" ? [] : [h("a.btn.primary", { href: "#/new" }, "+ \u041D\u043E\u0432\u0430\u044F \u0437\u0430\u044F\u0432\u043A\u0430")],
        userName: me.full_name,
        userSub: me.department || me.email,
        menu: [{ label: "\u041F\u0440\u043E\u0444\u0438\u043B\u044C", href: "#/profile" }, "-", { label: "\u0412\u044B\u0439\u0442\u0438", onClick: logout }]
      }),
      h("div.layout", h("main.main.full", h("div.page", content)))
    );
  }
  function authPage(title, ...content) {
    clear(app, h(
      "div.login-page",
      h("div.login-brand", h("span.brand-logo.hd", "?"), "HelpDesk"),
      h(
        "div.login-card",
        { style: title === "\u0420\u0435\u0433\u0438\u0441\u0442\u0440\u0430\u0446\u0438\u044F" ? { width: "560px" } : {} },
        h("h1", title),
        content
      )
    ));
    setTimeout(() => {
      var _a;
      return (_a = app.querySelector("input")) == null ? void 0 : _a.focus();
    }, 30);
  }
  async function logout() {
    await api.post("/logout").catch(() => {
    });
    me = null;
    location.hash = "#/login";
  }
  var errBox = () => h("div.error-box.hidden");
  var showErr = (box, e) => {
    box.textContent = e.message;
    box.classList.remove("hidden");
  };
  function renderLogin() {
    const email = h("input", { type: "email", autocomplete: "username", required: true, placeholder: cfg.domains[0] ? "ivanov@" + cfg.domains[0] : "" });
    const pass = h("input", { type: "password", autocomplete: "current-password", required: true });
    const err = errBox();
    const btn = h("button.btn.primary", { type: "submit" }, "\u0412\u043E\u0439\u0442\u0438");
    authPage(
      "\u0412\u0445\u043E\u0434",
      h(
        "form.stack",
        {
          onsubmit: async (e) => {
            var _a;
            e.preventDefault();
            btn.disabled = true;
            err.classList.add("hidden");
            try {
              await api.post("/login", { email: email.value, password: pass.value });
              me = await api.get("/me");
              location.hash = "#/";
            } catch (ex) {
              if (((_a = ex.data) == null ? void 0 : _a.next) === "verify") {
                location.hash = "#/verify?email=" + encodeURIComponent(ex.data.email);
                return;
              }
              showErr(err, ex);
            } finally {
              btn.disabled = false;
            }
          }
        },
        err,
        h("label.field", h("span", "\u0420\u0430\u0431\u043E\u0447\u0438\u0439 e-mail"), email),
        h("label.field", h("span", "\u041F\u0430\u0440\u043E\u043B\u044C"), pass),
        btn,
        h(
          "div.row.wrap",
          { style: { justifyContent: "space-between" } },
          h("a", { href: "#/register" }, "\u0420\u0435\u0433\u0438\u0441\u0442\u0440\u0430\u0446\u0438\u044F"),
          h("a", { href: "#/forgot" }, "\u0417\u0430\u0431\u044B\u043B\u0438 \u043F\u0430\u0440\u043E\u043B\u044C?")
        )
      )
    );
  }
  function renderRegister() {
    const f = {
      email: h("input", { type: "email", required: true, autocomplete: "email", placeholder: cfg.domains[0] ? "ivanov@" + cfg.domains[0] : "ivanov@company.local" }),
      full_name: h("input", { type: "text", required: true, autocomplete: "name", placeholder: "\u0418\u0432\u0430\u043D\u043E\u0432 \u0418\u0432\u0430\u043D \u0418\u0432\u0430\u043D\u043E\u0432\u0438\u0447" }),
      position: h("input", { type: "text", placeholder: "\u0411\u0443\u0445\u0433\u0430\u043B\u0442\u0435\u0440" }),
      room: h("input", { type: "text", placeholder: "\u041A\u0430\u0431. 101" }),
      phone: h("input", { type: "tel", placeholder: "\u0432\u043D\u0443\u0442\u0440. 123" }),
      password: h("input", { type: "password", required: true, minlength: 8, autocomplete: "new-password" })
    };
    const pass2 = h("input", { type: "password", required: true, autocomplete: "new-password" });
    const dept = departmentPicker({});
    const err = errBox();
    const btn = h("button.btn.primary", { type: "submit" }, "\u0417\u0430\u0440\u0435\u0433\u0438\u0441\u0442\u0440\u0438\u0440\u043E\u0432\u0430\u0442\u044C\u0441\u044F");
    authPage(
      "\u0420\u0435\u0433\u0438\u0441\u0442\u0440\u0430\u0446\u0438\u044F",
      h(
        "form.stack",
        {
          onsubmit: async (e) => {
            e.preventDefault();
            err.classList.add("hidden");
            if (f.password.value !== pass2.value) {
              showErr(err, new Error("\u041F\u0430\u0440\u043E\u043B\u0438 \u043D\u0435 \u0441\u043E\u0432\u043F\u0430\u0434\u0430\u044E\u0442"));
              return;
            }
            btn.disabled = true;
            try {
              const body = dept.value();
              Object.keys(f).forEach((k) => {
                body[k] = f[k].value;
              });
              const res = await api.post("/register", body);
              if (res.next === "verify") location.hash = "#/verify?email=" + encodeURIComponent(res.email);
              else if (res.next === "approval") location.hash = "#/pending";
              else {
                me = await api.get("/me");
                toast("\u0414\u043E\u0431\u0440\u043E \u043F\u043E\u0436\u0430\u043B\u043E\u0432\u0430\u0442\u044C!");
                location.hash = "#/new";
              }
            } catch (ex) {
              showErr(err, ex);
            } finally {
              btn.disabled = false;
            }
          }
        },
        err,
        cfg.domains.length ? h("div.info-box.small", "\u0420\u0435\u0433\u0438\u0441\u0442\u0440\u0430\u0446\u0438\u044F \u043F\u043E \u0440\u0430\u0431\u043E\u0447\u0435\u0439 \u043F\u043E\u0447\u0442\u0435: ", cfg.domains.map((d) => "@" + d).join(", ")) : null,
        h("label.field", h("span", "\u0420\u0430\u0431\u043E\u0447\u0438\u0439 e-mail *"), f.email),
        h("label.field", h("span", "\u0424\u0418\u041E *"), f.full_name),
        h("div.field", h("span.field-label", "\u041E\u0442\u0434\u0435\u043B"), dept.el, dept.note),
        h(
          "div.form-grid",
          h("label.field", h("span", "\u0414\u043E\u043B\u0436\u043D\u043E\u0441\u0442\u044C"), f.position),
          h("label.field", h("span", "\u041A\u0430\u0431\u0438\u043D\u0435\u0442"), f.room),
          h("label.field", h("span", "\u0422\u0435\u043B\u0435\u0444\u043E\u043D"), f.phone),
          h("label.field", h("span", "\u041F\u0430\u0440\u043E\u043B\u044C * (\u043E\u0442 8 \u0441\u0438\u043C\u0432\u043E\u043B\u043E\u0432)"), f.password),
          h("label.field", h("span", "\u041F\u043E\u0432\u0442\u043E\u0440\u0438\u0442\u0435 \u043F\u0430\u0440\u043E\u043B\u044C *"), pass2)
        ),
        cfg.mailEnabled ? h("p.hint", "\u041D\u0430 \u043F\u043E\u0447\u0442\u0443 \u043F\u0440\u0438\u0434\u0451\u0442 \u043A\u043E\u0434 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u044F.") : null,
        cfg.requireApproval ? h("p.hint", "\u041F\u043E\u0441\u043B\u0435 \u0440\u0435\u0433\u0438\u0441\u0442\u0440\u0430\u0446\u0438\u0438 \u0441\u043B\u0443\u0436\u0431\u0430 \u0418\u0422 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u0442 \u0432\u0430\u0448\u0443 \u0443\u0447\u0451\u0442\u043D\u0443\u044E \u0437\u0430\u043F\u0438\u0441\u044C.") : null,
        btn,
        h("div", "\u0423\u0436\u0435 \u0437\u0430\u0440\u0435\u0433\u0438\u0441\u0442\u0440\u0438\u0440\u043E\u0432\u0430\u043D\u044B? ", h("a", { href: "#/login" }, "\u0412\u043E\u0439\u0442\u0438"))
      )
    );
  }
  function renderVerify(email) {
    const code = h("input.code-input", { type: "text", inputmode: "numeric", maxlength: 6, autocomplete: "one-time-code", required: true });
    const err = errBox();
    const btn = h("button.btn.primary", { type: "submit" }, "\u041F\u043E\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u0442\u044C");
    authPage(
      "\u041F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u0435 e-mail",
      h(
        "form.stack",
        {
          onsubmit: async (e) => {
            e.preventDefault();
            btn.disabled = true;
            err.classList.add("hidden");
            try {
              const res = await api.post("/verify", { email, code: code.value });
              if (res.next === "approval") {
                location.hash = "#/pending";
                return;
              }
              me = await api.get("/me");
              toast("\u041F\u043E\u0447\u0442\u0430 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0430");
              location.hash = "#/new";
            } catch (ex) {
              showErr(err, ex);
            } finally {
              btn.disabled = false;
            }
          }
        },
        err,
        h("p", "\u041C\u044B \u043E\u0442\u043F\u0440\u0430\u0432\u0438\u043B\u0438 6-\u0437\u043D\u0430\u0447\u043D\u044B\u0439 \u043A\u043E\u0434 \u043D\u0430 ", h("strong", email), ". \u0412\u0432\u0435\u0434\u0438\u0442\u0435 \u0435\u0433\u043E \u043D\u0438\u0436\u0435."),
        code,
        btn,
        h("button.btn.subtle", { type: "button", onclick: (e) => run(async () => {
          await api.post("/resend", { email });
          toast("\u041A\u043E\u0434 \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D \u0435\u0449\u0451 \u0440\u0430\u0437");
        }, e.currentTarget) }, "\u041E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u044C \u043A\u043E\u0434 \u0435\u0449\u0451 \u0440\u0430\u0437")
      )
    );
  }
  function renderPending() {
    authPage(
      "\u0420\u0435\u0433\u0438\u0441\u0442\u0440\u0430\u0446\u0438\u044F \u043F\u0440\u0438\u043D\u044F\u0442\u0430",
      h(
        "div.stack",
        h("div.ok-box", "\u0421\u043F\u0430\u0441\u0438\u0431\u043E! \u0412\u0430\u0448\u0430 \u0443\u0447\u0451\u0442\u043D\u0430\u044F \u0437\u0430\u043F\u0438\u0441\u044C \u0436\u0434\u0451\u0442 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u044F \u0441\u043B\u0443\u0436\u0431\u043E\u0439 \u0418\u0422."),
        h("p.muted", "\u041A\u043E\u0433\u0434\u0430 \u0435\u0451 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0434\u044F\u0442, \u0432\u044B \u0441\u043C\u043E\u0436\u0435\u0442\u0435 \u0432\u043E\u0439\u0442\u0438 \u0441 \u0443\u043A\u0430\u0437\u0430\u043D\u043D\u044B\u043C\u0438 e-mail \u0438 \u043F\u0430\u0440\u043E\u043B\u0435\u043C."),
        h("a.btn", { href: "#/login" }, "\u041A\u043E \u0432\u0445\u043E\u0434\u0443")
      )
    );
  }
  function renderForgot() {
    if (!cfg.mailEnabled) {
      authPage("\u0412\u043E\u0441\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D\u0438\u0435 \u043F\u0430\u0440\u043E\u043B\u044F", h(
        "div.stack",
        h("div.info-box", "\u0427\u0442\u043E\u0431\u044B \u0441\u043C\u0435\u043D\u0438\u0442\u044C \u043F\u0430\u0440\u043E\u043B\u044C, \u043E\u0431\u0440\u0430\u0442\u0438\u0442\u0435\u0441\u044C \u0432 \u0441\u043B\u0443\u0436\u0431\u0443 \u0418\u0422 \u2014 \u0432\u0430\u043C \u0443\u0441\u0442\u0430\u043D\u043E\u0432\u044F\u0442 \u043D\u043E\u0432\u044B\u0439."),
        h("a.btn", { href: "#/login" }, "\u041A\u043E \u0432\u0445\u043E\u0434\u0443")
      ));
      return;
    }
    const email = h("input", { type: "email", required: true });
    const code = h("input.code-input", { type: "text", inputmode: "numeric", maxlength: 6 });
    const pass = h("input", { type: "password", minlength: 8, autocomplete: "new-password" });
    const step2 = h("div.stack.hidden", h("label.field", h("span", "\u041A\u043E\u0434 \u0438\u0437 \u043F\u0438\u0441\u044C\u043C\u0430"), code), h("label.field", h("span", "\u041D\u043E\u0432\u044B\u0439 \u043F\u0430\u0440\u043E\u043B\u044C (\u043E\u0442 8 \u0441\u0438\u043C\u0432\u043E\u043B\u043E\u0432)"), pass));
    const err = errBox();
    const btn = h("button.btn.primary", { type: "submit" }, "\u041F\u043E\u043B\u0443\u0447\u0438\u0442\u044C \u043A\u043E\u0434");
    let sent = false;
    authPage(
      "\u0412\u043E\u0441\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D\u0438\u0435 \u043F\u0430\u0440\u043E\u043B\u044F",
      h("form.stack", {
        onsubmit: async (e) => {
          e.preventDefault();
          btn.disabled = true;
          err.classList.add("hidden");
          try {
            if (!sent) {
              await api.post("/forgot", { email: email.value });
              sent = true;
              step2.classList.remove("hidden");
              btn.textContent = "\u0421\u043C\u0435\u043D\u0438\u0442\u044C \u043F\u0430\u0440\u043E\u043B\u044C";
              email.disabled = true;
              toast("\u0415\u0441\u043B\u0438 \u0430\u0434\u0440\u0435\u0441 \u0437\u0430\u0440\u0435\u0433\u0438\u0441\u0442\u0440\u0438\u0440\u043E\u0432\u0430\u043D, \u043D\u0430 \u043D\u0435\u0433\u043E \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D \u043A\u043E\u0434");
            } else {
              await api.post("/reset", { email: email.value, code: code.value, password: pass.value });
              toast("\u041F\u0430\u0440\u043E\u043B\u044C \u0438\u0437\u043C\u0435\u043D\u0451\u043D. \u0412\u043E\u0439\u0434\u0438\u0442\u0435 \u0441 \u043D\u043E\u0432\u044B\u043C \u043F\u0430\u0440\u043E\u043B\u0435\u043C");
              location.hash = "#/login";
            }
          } catch (ex) {
            showErr(err, ex);
          } finally {
            btn.disabled = false;
          }
        }
      }, err, h("label.field", h("span", "\u0420\u0430\u0431\u043E\u0447\u0438\u0439 e-mail"), email), step2, btn, h("a", { href: "#/login" }, "\u041A\u043E \u0432\u0445\u043E\u0434\u0443"))
    );
  }
  async function renderList(state) {
    const [tickets] = await Promise.all([api.get("/tickets?state=" + state)]);
    const tabs = [["open", "\u041E\u0442\u043A\u0440\u044B\u0442\u044B\u0435"], ["closed", "\u0417\u0430\u043A\u0440\u044B\u0442\u044B\u0435"], ["all", "\u0412\u0441\u0435"]];
    shell(
      h("div.page-head", h("h1", "\u041C\u043E\u0438 \u0437\u0430\u044F\u0432\u043A\u0438"), h("span.badge", String(tickets.length))),
      cfg.welcome ? h("p.muted", { style: { margin: "-8px 0 16px" } }, cfg.welcome) : null,
      h("div.tabs", tabs.map(([k, l]) => h("a.tab" + (k === state ? ".active" : ""), { href: "#/?state=" + k }, l))),
      tickets.length ? tickets.map((t) => h(
        "a.tcard",
        { href: "#/tickets/" + t.id },
        h(
          "div.tcard-top",
          h("span.ticket-key", "#" + t.id),
          statusPill(t.status_name, t.status_color),
          t.is_overdue ? h("span.lozenge.red", "\u0441\u0440\u043E\u043A \u043F\u0440\u043E\u0448\u0451\u043B") : null
        ),
        h("div.tcard-title", t.title),
        h(
          "div.tcard-meta",
          h("span", (t.category_icon || "") + " " + (t.category_name || "\u0411\u0435\u0437 \u0432\u0438\u0434\u0430")),
          h("span", "\u0421\u043E\u0437\u0434\u0430\u043D\u0430 ", fmtDateTime(t.created_at)),
          h("span", "\u0418\u0441\u043F\u043E\u043B\u043D\u0438\u0442\u0435\u043B\u044C: ", t.assignee_name || "\u0435\u0449\u0451 \u043D\u0435 \u043D\u0430\u0437\u043D\u0430\u0447\u0435\u043D"),
          t.due_at ? h("span", "\u0421\u0440\u043E\u043A: ", fmtDateTime(t.due_at)) : null,
          h("span", "\u041E\u0431\u043D\u043E\u0432\u043B\u0435\u043D\u0430 ", relTime(t.updated_at))
        )
      )) : h("div.empty-state", state === "open" ? "\u041E\u0442\u043A\u0440\u044B\u0442\u044B\u0445 \u0437\u0430\u044F\u0432\u043E\u043A \u043D\u0435\u0442. " : "\u0417\u0430\u044F\u0432\u043E\u043A \u043D\u0435\u0442. ", h("a", { href: "#/new" }, "\u0421\u043E\u0437\u0434\u0430\u0442\u044C \u0437\u0430\u044F\u0432\u043A\u0443"))
    );
  }
  async function renderNew() {
    const cats = await api.get("/categories");
    let catId = null;
    const catBtns = cats.map((c) => {
      const b = h("button.cat-opt", {
        type: "button",
        onclick: () => {
          catId = c.id;
          catBtns.forEach((x) => x.classList.toggle("on", x === b));
          if (!title.value) title.focus();
        }
      }, h("span.ic", c.icon), h("div", h("div.t", c.name), c.description ? h("div.d", c.description) : null));
      return b;
    });
    const title = h("input", { type: "text", maxlength: 200, required: true, placeholder: "\u041D\u0430\u043F\u0440\u0438\u043C\u0435\u0440: \u043D\u0435 \u043F\u0435\u0447\u0430\u0442\u0430\u0435\u0442 \u043F\u0440\u0438\u043D\u0442\u0435\u0440 \u0432 \u0431\u0443\u0445\u0433\u0430\u043B\u0442\u0435\u0440\u0438\u0438" });
    const desc = h("textarea", { rows: 6, placeholder: "\u0427\u0442\u043E \u043F\u0440\u043E\u0438\u0437\u043E\u0448\u043B\u043E, \u043A\u043E\u0433\u0434\u0430, \u043A\u0430\u043A\u0438\u0435 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u044F \u043E\u0431 \u043E\u0448\u0438\u0431\u043A\u0435 \u0432\u0438\u0434\u0438\u0442\u0435, \u0447\u0442\u043E \u0443\u0436\u0435 \u043F\u0440\u043E\u0431\u043E\u0432\u0430\u043B\u0438 \u0441\u0434\u0435\u043B\u0430\u0442\u044C" });
    const location_ = h("input", { type: "text", value: me.room || "", placeholder: "\u041A\u0430\u0431\u0438\u043D\u0435\u0442 / \u0440\u0430\u0431\u043E\u0447\u0435\u0435 \u043C\u0435\u0441\u0442\u043E" });
    const prio = h("select", Object.entries(cfg.priorities).map(([k, l]) => h("option", { value: k }, l)));
    prio.value = "normal";
    const files = fileInput();
    const err = errBox();
    const btn = h("button.btn.primary", { type: "submit" }, "\u041E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u044C \u0437\u0430\u044F\u0432\u043A\u0443");
    shell(h(
      "div.page.narrow",
      { style: { padding: 0 } },
      h("h1", { style: { marginBottom: "16px" } }, "\u041D\u043E\u0432\u0430\u044F \u0437\u0430\u044F\u0432\u043A\u0430"),
      h(
        "form.panel.stack",
        {
          onsubmit: async (e) => {
            e.preventDefault();
            err.classList.add("hidden");
            if (cats.length && !catId) {
              showErr(err, new Error("\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435, \u0447\u0442\u043E \u0441\u043B\u0443\u0447\u0438\u043B\u043E\u0441\u044C"));
              window.scrollTo(0, 0);
              return;
            }
            btn.disabled = true;
            try {
              const fd = new FormData();
              if (catId) fd.append("category_id", catId);
              fd.append("title", title.value);
              fd.append("description", desc.value);
              fd.append("location", location_.value);
              fd.append("priority", prio.value);
              files.files().forEach((f) => fd.append("files", f));
              const { id } = await api.post("/tickets", fd);
              toast(`\u0417\u0430\u044F\u0432\u043A\u0430 #${id} \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u0430`);
              location.hash = "#/tickets/" + id;
            } catch (ex) {
              showErr(err, ex);
            } finally {
              btn.disabled = false;
            }
          }
        },
        err,
        cats.length ? [h("div.field", h("span", "\u0427\u0442\u043E \u0441\u043B\u0443\u0447\u0438\u043B\u043E\u0441\u044C? *")), h("div.cat-grid", catBtns)] : null,
        h("label.field", h("span", "\u0422\u0435\u043C\u0430 *"), title),
        h("label.field", h("span", "\u041F\u043E\u0434\u0440\u043E\u0431\u043D\u043E\u0435 \u043E\u043F\u0438\u0441\u0430\u043D\u0438\u0435"), desc),
        h(
          "div.form-grid",
          h("label.field", h("span", "\u0413\u0434\u0435 \u043D\u0430\u0445\u043E\u0434\u0438\u0442\u0441\u044F (\u043A\u0430\u0431\u0438\u043D\u0435\u0442, \u0440\u0430\u0431\u043E\u0447\u0435\u0435 \u043C\u0435\u0441\u0442\u043E)"), location_),
          h("label.field", h("span", "\u0421\u0440\u043E\u0447\u043D\u043E\u0441\u0442\u044C"), prio, h("span.hint", "\u0421\u0440\u043E\u043A \u0432\u044B\u043F\u043E\u043B\u043D\u0435\u043D\u0438\u044F \u043D\u0430\u0437\u043D\u0430\u0447\u0438\u0442 \u0441\u043B\u0443\u0436\u0431\u0430 \u0418\u0422"))
        ),
        files.el,
        h("p.hint", "\u041F\u0440\u0438\u043B\u043E\u0436\u0438\u0442\u0435 \u0444\u043E\u0442\u043E \u0438\u043B\u0438 \u0441\u043A\u0440\u0438\u043D\u0448\u043E\u0442 \u043E\u0448\u0438\u0431\u043A\u0438 \u2014 \u0442\u0430\u043A \u043F\u0440\u043E\u0431\u043B\u0435\u043C\u0443 \u0440\u0435\u0448\u0430\u0442 \u0431\u044B\u0441\u0442\u0440\u0435\u0435."),
        h("div.row", btn, h("a.btn.subtle", { href: "#/" }, "\u041E\u0442\u043C\u0435\u043D\u0430"))
      )
    ));
  }
  async function renderTicket(id) {
    const [t, sts] = await Promise.all([api.get("/tickets/" + id), statuses.length ? statuses : api.get("/statuses")]);
    statuses = sts;
    const body = h("textarea", { placeholder: t.is_closed ? "\u0417\u0430\u044F\u0432\u043A\u0430 \u0437\u0430\u043A\u0440\u044B\u0442\u0430. \u0415\u0441\u043B\u0438 \u043F\u0440\u043E\u0431\u043B\u0435\u043C\u0430 \u043E\u0441\u0442\u0430\u043B\u0430\u0441\u044C \u2014 \u043D\u0430\u043F\u0438\u0448\u0438\u0442\u0435, \u0441\u043B\u0443\u0436\u0431\u0430 \u0418\u0422 \u0443\u0432\u0438\u0434\u0438\u0442 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435." : "\u0423\u0442\u043E\u0447\u043D\u0435\u043D\u0438\u0435, \u043E\u0442\u0432\u0435\u0442 \u043D\u0430 \u0432\u043E\u043F\u0440\u043E\u0441 \u0441\u043B\u0443\u0436\u0431\u044B \u0418\u0422\u2026" });
    const files = fileInput();
    const send = h("button.btn.primary", {
      onclick: () => run(async () => {
        const fd = new FormData();
        fd.append("body", body.value);
        files.files().forEach((f) => fd.append("files", f));
        await api.post(`/tickets/${id}/comments`, fd);
        toast("\u0421\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435 \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u043E");
        renderTicket(id);
      }, send)
    }, "\u041E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u044C");
    const open = statuses.filter((s) => !s.is_closed);
    const curIdx = open.findIndex((s) => s.name === t.status_name);
    const steps = [
      ...open.map((s, i) => ({ label: s.name, done: t.is_closed || i < curIdx, cur: !t.is_closed && i === curIdx })),
      { label: t.is_closed ? t.status_name : "\u0417\u0430\u043A\u0440\u044B\u0442\u0430", done: false, cur: t.is_closed }
    ];
    const topFiles = t.attachments.filter((a) => !a.comment_id);
    shell(h(
      "div.issue",
      h(
        "div.stack",
        h("div", h("a", { href: "#/" }, "\u2190 \u041C\u043E\u0438 \u0437\u0430\u044F\u0432\u043A\u0438")),
        h(
          "div.panel",
          h(
            "div.row.wrap",
            h("span.ticket-key", "\u0417\u0430\u044F\u0432\u043A\u0430 #" + t.id),
            statusPill(t.status_name, t.status_color),
            t.is_overdue ? h("span.lozenge.red", "\u0441\u0440\u043E\u043A \u043F\u0440\u043E\u0448\u0451\u043B") : null
          ),
          h("h1", { style: { marginTop: "8px" } }, t.title),
          h("div.pstep-line", steps.map((s) => h("div.pstep" + (s.done ? ".done" : "") + (s.cur ? ".cur" : ""), s.label))),
          h("div.ticket-desc", t.description || h("span.muted", "\u0411\u0435\u0437 \u043E\u043F\u0438\u0441\u0430\u043D\u0438\u044F")),
          fileList(topFiles, fileUrl)
        ),
        h(
          "div.panel",
          h("h3", "\u041F\u0435\u0440\u0435\u043F\u0438\u0441\u043A\u0430 \u0441\u043E \u0441\u043B\u0443\u0436\u0431\u043E\u0439 \u0418\u0422"),
          thread(t.comments, t.attachments, { urlFor: fileUrl }),
          h("div.reply", body, files.el, h("div.row", h("span.spacer"), send))
        )
      ),
      h(
        "div.side-panel",
        h(
          "div.panel",
          h(
            "dl.kv",
            h("dt", "\u0421\u0442\u0430\u0442\u0443\u0441"),
            h("dd", statusPill(t.status_name, t.status_color)),
            h("dt", "\u0412\u0438\u0434 \u043F\u0440\u043E\u0431\u043B\u0435\u043C\u044B"),
            h("dd", (t.category_icon || "") + " " + (t.category_name || "\u2014")),
            h("dt", "\u0421\u0440\u043E\u0447\u043D\u043E\u0441\u0442\u044C"),
            h("dd", cfg.priorities[t.priority]),
            h("dt", "\u0418\u0441\u043F\u043E\u043B\u043D\u0438\u0442\u0435\u043B\u044C"),
            h("dd", t.assignee_name || h("span.muted", "\u0435\u0449\u0451 \u043D\u0435 \u043D\u0430\u0437\u043D\u0430\u0447\u0435\u043D")),
            h("dt", "\u0421\u0440\u043E\u043A \u0432\u044B\u043F\u043E\u043B\u043D\u0435\u043D\u0438\u044F"),
            h("dd" + (t.is_overdue ? ".overdue" : ""), t.due_at ? fmtDateTime(t.due_at) : h("span.muted", "\u043D\u0430\u0437\u043D\u0430\u0447\u0438\u0442 \u0441\u043B\u0443\u0436\u0431\u0430 \u0418\u0422")),
            h("dt", "\u041C\u0435\u0441\u0442\u043E"),
            h("dd", t.location || "\u2014"),
            h("dt", "\u0421\u043E\u0437\u0434\u0430\u043D\u0430"),
            h("dd", fmtDateTime(t.created_at)),
            t.closed_at ? [h("dt", "\u0417\u0430\u043A\u0440\u044B\u0442\u0430"), h("dd", fmtDateTime(t.closed_at))] : null
          )
        ),
        t.history.length ? h("div.panel", h("h3", "\u0425\u043E\u0434 \u0432\u044B\u043F\u043E\u043B\u043D\u0435\u043D\u0438\u044F"), historyList(t.history)) : null
      )
    ));
  }
  function renderProfile() {
    const f = {};
    const field = (k, label, type = "text") => {
      f[k] = h("input", { type, value: me[k] || "" });
      return h("label.field", h("span", label), f[k]);
    };
    const dept = departmentPicker(me);
    const save = h("button.btn.primary", {
      onclick: () => run(async () => {
        const body = dept.value();
        Object.keys(f).forEach((k) => {
          body[k] = f[k].value;
        });
        me = __spreadValues(__spreadValues({}, me), await api.patch("/me", body));
        toast("\u041F\u0440\u043E\u0444\u0438\u043B\u044C \u0441\u043E\u0445\u0440\u0430\u043D\u0451\u043D");
        renderProfile();
      }, save)
    }, "\u0421\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C");
    const cur = h("input", { type: "password", autocomplete: "current-password" });
    const next = h("input", { type: "password", autocomplete: "new-password" });
    const next2 = h("input", { type: "password", autocomplete: "new-password" });
    const savePw = h("button.btn", {
      onclick: () => run(async () => {
        if (next.value !== next2.value) throw new Error("\u041F\u0430\u0440\u043E\u043B\u0438 \u043D\u0435 \u0441\u043E\u0432\u043F\u0430\u0434\u0430\u044E\u0442");
        await api.post("/me/password", { current: cur.value, next: next.value });
        cur.value = next.value = next2.value = "";
        toast("\u041F\u0430\u0440\u043E\u043B\u044C \u0438\u0437\u043C\u0435\u043D\u0451\u043D");
      }, savePw)
    }, "\u0421\u043C\u0435\u043D\u0438\u0442\u044C \u043F\u0430\u0440\u043E\u043B\u044C");
    shell(h(
      "div.page.narrow.stack",
      { style: { padding: 0 } },
      h("h1", "\u041F\u0440\u043E\u0444\u0438\u043B\u044C"),
      h(
        "div.panel.stack",
        h("div.muted", "E-mail: ", h("strong", me.email)),
        field("full_name", "\u0424\u0418\u041E"),
        h("div.field", h("span.field-label", "\u041E\u0442\u0434\u0435\u043B"), dept.el, dept.note),
        h("div.form-grid", field("position", "\u0414\u043E\u043B\u0436\u043D\u043E\u0441\u0442\u044C"), field("room", "\u041A\u0430\u0431\u0438\u043D\u0435\u0442"), field("phone", "\u0422\u0435\u043B\u0435\u0444\u043E\u043D", "tel")),
        h("div", save)
      ),
      h(
        "div.panel.stack",
        h("h3", "\u0421\u043C\u0435\u043D\u0430 \u043F\u0430\u0440\u043E\u043B\u044F"),
        h("label.field", h("span", "\u0422\u0435\u043A\u0443\u0449\u0438\u0439 \u043F\u0430\u0440\u043E\u043B\u044C"), cur),
        h("div.form-grid", h("label.field", h("span", "\u041D\u043E\u0432\u044B\u0439 \u043F\u0430\u0440\u043E\u043B\u044C (\u043E\u0442 8 \u0441\u0438\u043C\u0432\u043E\u043B\u043E\u0432)"), next), h("label.field", h("span", "\u041F\u043E\u0432\u0442\u043E\u0440\u0438\u0442\u0435"), next2)),
        h("div", savePw)
      )
    ));
  }
  boot().catch((e) => {
    app.textContent = "\u041E\u0448\u0438\u0431\u043A\u0430 \u0437\u0430\u0433\u0440\u0443\u0437\u043A\u0438: " + e.message;
  });
})();
