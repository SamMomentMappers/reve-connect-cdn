/*! Rêve Connect v1: "Rent it through Rêve" for partner product pages.
 *
 * Install on a partner product page (one tag):
 *   <script src="https://<host>/reve-connect.js" data-partner="eddy" defer></script>
 * Optional: data-config="<url of partner config>", data-product-handle="<handle>" (themes whose
 * product URLs are not /products/<handle>), and a <div data-reve-connect></div> placeholder where the
 * button should go (otherwise it goes after the partner's add-to-cart form).
 *
 * Flow: button -> panel (size, length, arrival date from Rêve's live calendar) -> Supercycle
 * /intents (exact cart inputs) -> Shopify Storefront API cart on Rêve -> Rêve checkout in a new tab.
 * Every Rêve endpoint used here answers cross-origin (Access-Control-Allow-Origin: *).
 * Contract for the config: contracts/partner-config.v1.schema.json.
 */
(function (root, factory) {
  var core = factory();
  var isNode = typeof module === "object" && module.exports;
  if (isNode) module.exports = core;
  else root.ReveConnect = core;
  if (!isNode && typeof document !== "undefined") core.boot(document.currentScript);
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var SCHEMA = "reve-connect/partner-config/1";
  var VERSION = "1.0.0";

  // ---------------------------------------------------------------- pure helpers (unit-tested)

  function productHandleFromPath(pathname) {
    var m = /\/products\/([^/?#]+)/.exec(pathname || "");
    return m ? decodeURIComponent(m[1]).toLowerCase() : null;
  }

  function parseIso(iso) {
    var p = iso.split("-");
    return Date.UTC(+p[0], +p[1] - 1, +p[2]);
  }

  function toIso(ms) {
    return new Date(ms).toISOString().slice(0, 10);
  }

  function addDays(iso, n) {
    return toIso(parseIso(iso) + n * 86400000);
  }

  /* A start date works when Rêve's calendar shows a free unit on every day from arrival to the
   * send-back day. Supercycle's occupancy map already pads each booking with its shipping days. */
  function isBookable(occupancy, startIso, nights) {
    if (!occupancy) return false;
    for (var i = 0; i <= nights; i++) {
      var v = occupancy[addDays(startIso, i)];
      if (!(typeof v === "number" && v >= 1)) return false;
    }
    return true;
  }

  function bookableStarts(occupancy, nights) {
    var out = [];
    Object.keys(occupancy || {}).sort().forEach(function (d) {
      if (isBookable(occupancy, d, nights)) out.push(d);
    });
    return out;
  }

  /* Monday-first weeks for a month: [[iso|null x7], ...]. */
  function monthGrid(year, month) {
    var first = Date.UTC(year, month, 1);
    var lead = (new Date(first).getUTCDay() + 6) % 7;
    var days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    var cells = [];
    for (var i = 0; i < lead; i++) cells.push(null);
    for (var d = 1; d <= days; d++) cells.push(toIso(Date.UTC(year, month, d)));
    while (cells.length % 7) cells.push(null);
    var weeks = [];
    for (var w = 0; w < cells.length; w += 7) weeks.push(cells.slice(w, w + 7));
    return weeks;
  }

  function unitForPartnerVariant(product, partnerVariantId) {
    if (!product || partnerVariantId == null) return -1;
    var id = Number(partnerVariantId);
    for (var i = 0; i < product.units.length; i++) {
      if (product.units[i].partner_variant_ids.indexOf(id) !== -1) return i;
    }
    return -1;
  }

  function fromPrice(product) {
    var min = null;
    product.units.forEach(function (u) {
      u.periods.forEach(function (p) {
        if (min === null || p.price_cents < min) min = p.price_cents;
      });
    });
    return min;
  }

  function formatMoney(cents) {
    var whole = cents % 100 === 0;
    return "$" + (cents / 100).toLocaleString("en-US", {
      minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2
    });
  }

  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  function formatDay(iso) {
    var d = new Date(parseIso(iso));
    return DAYS[d.getUTCDay()] + ", " + MONTHS[d.getUTCMonth()] + " " + d.getUTCDate();
  }

  /* Supercycle's visible line properties read like "20 Nov 26". */
  function formatPropDate(iso) {
    var d = new Date(parseIso(iso));
    return d.getUTCDate() + " " + MONTHS[d.getUTCMonth()] + " " + String(d.getUTCFullYear()).slice(2);
  }

  function intentBody(unit, period, startIso) {
    return { variantId: unit.variant_id, option: { globalId: period.global_id, params: { rental_start: startIso } } };
  }

  /* /intents returns form-style keys ("properties[_cycle]", "selling_plan"); split them. */
  function splitIntent(attributes) {
    var props = {}, sellingPlan = null;
    Object.keys(attributes || {}).forEach(function (k) {
      var m = /^properties\[(.+)\]$/.exec(k);
      if (m) props[m[1]] = String(attributes[k]);
      else if (k === "selling_plan") sellingPlan = Number(attributes[k]);
    });
    return { properties: props, sellingPlan: sellingPlan };
  }

  function visibleProperties(startIso, nights) {
    return { "Start date": formatPropDate(startIso), "End date": formatPropDate(addDays(startIso, nights)) };
  }

  /* Storefront API CartInput for one rental line, tagged with the partner for reporting. */
  function cartInput(opts) {
    var intent = splitIntent(opts.intentAttributes);
    if (!intent.sellingPlan || !intent.properties._cycle) {
      throw new Error("intent is missing selling_plan or _cycle");
    }
    var props = Object.assign({}, intent.properties, visibleProperties(opts.startIso, opts.period.nights),
      { _reve_partner: opts.partnerId });
    var lineAttrs = Object.keys(props).map(function (k) { return { key: k, value: props[k] }; });
    return {
      lines: [{
        merchandiseId: "gid://shopify/ProductVariant/" + opts.unit.variant_id,
        quantity: 1,
        sellingPlanId: "gid://shopify/SellingPlan/" + intent.sellingPlan,
        attributes: lineAttrs
      }],
      attributes: [
        { key: "_reve_partner", value: opts.partnerId },
        { key: "_reve_partner_product", value: opts.partnerHandle },
        { key: "_reve_connect", value: VERSION }
      ]
    };
  }

  /* Fallback path: the same inputs Supercycle puts on Rêve's own product form, posted to /cart/add. */
  function cartFormFields(opts) {
    var intent = splitIntent(opts.intentAttributes);
    var fields = { id: String(opts.unit.variant_id), quantity: "1", selling_plan: String(intent.sellingPlan), return_to: "/checkout" };
    var props = Object.assign({}, intent.properties, visibleProperties(opts.startIso, opts.period.nights),
      { _reve_partner: opts.partnerId });
    Object.keys(props).forEach(function (k) { fields["properties[" + k + "]"] = props[k]; });
    return fields;
  }

  var CART_CREATE = "mutation ReveConnectCart($input: CartInput!) { cartCreate(input: $input) { " +
    "cart { id checkoutUrl cost { totalAmount { amount currencyCode } } } " +
    "userErrors { field message code } warnings { code message } } }";

  /* Stable 0..1 bucket per visitor for the optional holdout (cannibalisation test). */
  function bucket(seed) {
    var h = 2166136261;
    for (var i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
    return ((h >>> 0) % 10000) / 10000;
  }

  /* Partner rule: hide the button when buying costs less than `ratio` x the cheapest rental
   * (deep-sale pages, where "rent from $50" next to "buy for $98" makes no sense). */
  function worthRenting(buyCents, rentCents, ratio) {
    if (!ratio || !(buyCents > 0) || !(rentCents > 0)) return true;
    return buyCents >= ratio * rentCents;
  }

  function validConfig(cfg) {
    return !!(cfg && cfg.schema === SCHEMA && cfg.partner && cfg.reve && cfg.products);
  }

  // ---------------------------------------------------------------- browser side

  function emit(name, detail) {
    try {
      if (window.Shopify && window.Shopify.analytics && typeof window.Shopify.analytics.publish === "function") {
        window.Shopify.analytics.publish(name, detail);
      }
    } catch (e) { /* analytics must never break the page */ }
    try { window.dispatchEvent(new CustomEvent("reve-connect:" + name.replace(/^reve_connect_/, ""), { detail: detail })); } catch (e) { }
  }

  function visitorSeed() {
    try {
      var k = "reve_connect_vid", v = localStorage.getItem(k);
      if (!v) { v = Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem(k, v); }
      return v;
    } catch (e) { return "anon"; }
  }

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v === false || v == null) return;
      if (k === "text") n.textContent = v;
      else if (k.slice(0, 2) === "on") n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : v);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return n;
  }

  function readPartnerVariant(form) {
    var input = form && form.querySelector("input[name='id']:not([disabled]), select[name='id']");
    if (input && input.value) return input.value;
    var q = /[?&]variant=(\d+)/.exec(location.search);
    return q ? q[1] : null;
  }

  function findForm(cfg) {
    var sel = cfg.partner.mount_after;
    var form = sel ? document.querySelector(sel) : null;
    if (!form) {
      var forms = document.querySelectorAll("form[action*='/cart/add']");
      for (var i = 0; i < forms.length; i++) if (forms[i].querySelector("[type='submit']")) { form = forms[i]; break; }
    }
    return form;
  }

  var CSS_BUTTON = [
    ":host{display:block;margin:14px 0 0;font:inherit;color:inherit;-webkit-font-smoothing:antialiased}",
    ".rc{--ink:#2b2326;--rose:#83545f;--blush:#f3e3e3;--sage:#98b3a6;--cream:#f4f0ec;",
    "  --serif:'Cormorant Garamond',Cormorant,'Iowan Old Style','Palatino Linotype',Palatino,Georgia,serif}",
    ".eyebrow{display:block;font-size:11px;letter-spacing:.24em;text-transform:uppercase;opacity:.72;margin:0 0 8px}",
    "button.cta{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:14px;width:100%;cursor:pointer;",
    "  padding:12px 16px;background:var(--blush);color:var(--ink);border:1px solid rgba(131,84,95,.22);",
    "  transition:background .2s ease,border-color .2s ease,transform .2s ease}",
    "button.cta:hover{background:#efd9da;border-color:rgba(131,84,95,.45)}",
    "button.cta:active{transform:translateY(1px)}",
    "button.cta:focus-visible{outline:2px solid var(--rose);outline-offset:3px}",
    ".mark{font-family:var(--serif);font-size:22px;letter-spacing:.18em;line-height:1;color:var(--rose);font-weight:500}",
    ".price{margin-left:auto;font-size:13px;letter-spacing:.02em;text-align:right;line-height:1.35}",
    ".price b{font-weight:600}",
    ".arrow{font-size:18px;color:var(--rose);transition:transform .25s ease}",
    "button.cta:hover .arrow{transform:translateX(3px)}",
    ".note{margin:8px 0 0;font-size:12px;opacity:.7}",
    "@media (prefers-reduced-motion:reduce){*{transition:none!important}}"
  ].join("\n");

  var CSS_PANEL = [
    ":host{all:initial}",
    ".rc{--ink:#2b2326;--muted:#7b6e71;--rose:#83545f;--rose2:#af838e;--blush:#f3e3e3;--sage:#98b3a6;",
    "  --cream:#f4f0ec;--line:rgba(43,35,38,.12);",
    "  --serif:'Cormorant Garamond',Cormorant,'Iowan Old Style','Palatino Linotype',Palatino,Georgia,serif;",
    "  font-family:var(--font,inherit);color:var(--ink);font-size:14px;line-height:1.45;-webkit-font-smoothing:antialiased}",
    ".scrim{position:fixed;inset:0;background:rgba(32,24,27,.38);opacity:0;transition:opacity .28s ease;z-index:2147483000;pointer-events:none}",
    ".open .scrim{pointer-events:auto}",
    ".sheet{position:fixed;top:0;right:0;height:100%;width:440px;max-width:100%;background:var(--cream);z-index:2147483001;",
    "  box-shadow:-24px 0 60px rgba(32,24,27,.18);transform:translateX(102%);transition:transform .32s cubic-bezier(.2,.8,.2,1);",
    "  display:flex;flex-direction:column;outline:none}",
    ".open .scrim{opacity:1}.open .sheet{transform:none}",
    // phones: pinned to both edges, never 100vw (a partner page that overflows sideways widens the
    // fixed containing block past 100vw and a vw-sized sheet would hang off the right edge)
    "@media (max-width:640px){.sheet{top:auto;bottom:0;left:0;right:0;width:auto;height:auto;max-height:92vh;transform:translateY(102%);",
    "  border-radius:14px 14px 0 0;box-shadow:0 -18px 50px rgba(32,24,27,.2)}}",
    ".head{padding:22px 24px 14px;border-bottom:1px solid var(--line);position:relative}",
    ".kicker{font-size:11px;letter-spacing:.24em;text-transform:uppercase;color:var(--muted)}",
    "h2{font-family:var(--serif);font-weight:500;font-size:30px;line-height:1.05;margin:6px 0 6px;letter-spacing:.01em}",
    "h2 em{font-style:normal;color:var(--rose);letter-spacing:.14em}",
    ".lede{margin:0;color:var(--muted);font-size:13px;max-width:42ch;padding-right:28px}",
    ".x{all:unset;position:absolute;top:16px;right:16px;width:36px;height:36px;display:grid;place-items:center;cursor:pointer;",
    "  border-radius:50%;font-size:20px;color:var(--ink)}",
    ".x:hover{background:rgba(43,35,38,.06)}.x:focus-visible{outline:2px solid var(--rose)}",
    ".body{padding:18px 24px 8px;overflow:auto;flex:1}",
    ".piece{display:flex;gap:14px;align-items:center;padding:0 0 16px;border-bottom:1px solid var(--line);margin-bottom:16px}",
    ".piece img{width:64px;height:85px;object-fit:cover;background:#e9e1db}",
    ".piece .t{font-family:var(--serif);font-size:19px;line-height:1.15}",
    ".piece .s{color:var(--muted);font-size:12px;margin-top:3px}",
    ".sec{margin:0 0 18px}",
    ".enter .sec{animation:rise .45s both}",
    ".enter .sec:nth-child(4){animation-delay:.05s}.enter .sec:nth-child(5){animation-delay:.1s}",
    "@keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}",
    ".lbl{font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:var(--muted);margin:0 0 8px;display:flex;justify-content:space-between}",
    ".chips{display:flex;flex-wrap:wrap;gap:8px}",
    ".chip{all:unset;box-sizing:border-box;cursor:pointer;padding:9px 14px;border:1px solid var(--line);background:#fbf9f7;",
    "  font-size:13px;min-width:46px;text-align:center;transition:border-color .15s,background .15s}",
    ".chip:hover{border-color:var(--rose2)}.chip:focus-visible{outline:2px solid var(--rose);outline-offset:2px}",
    ".chip[aria-pressed=true]{background:var(--ink);color:var(--cream);border-color:var(--ink)}",
    ".chip small{display:block;font-size:11px;opacity:.75;margin-top:1px}",
    ".hint{font-size:12px;color:var(--muted);margin:8px 0 0}",
    ".cal{border:1px solid var(--line);background:#fbf9f7;padding:12px 12px 8px}",
    ".calh{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}",
    ".calh b{font-family:var(--serif);font-weight:500;font-size:19px}",
    ".nav{all:unset;cursor:pointer;width:32px;height:32px;display:grid;place-items:center;border-radius:50%}",
    ".nav:hover{background:rgba(43,35,38,.06)}.nav[disabled]{opacity:.25;cursor:default;background:none}",
    ".nav:focus-visible{outline:2px solid var(--rose)}",
    ".grid{display:grid;grid-template-columns:repeat(7,1fr);gap:2px 0}",
    ".dow{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);text-align:center;padding:4px 0}",
    ".day{all:unset;box-sizing:border-box;height:38px;display:grid;place-items:center;font-size:13px;cursor:pointer;position:relative}",
    ".day[disabled]{color:rgba(43,35,38,.28);cursor:default;text-decoration:line-through;text-decoration-color:rgba(43,35,38,.18)}",
    ".day:not([disabled]):hover span{background:rgba(152,179,166,.35)}",
    ".day span{width:34px;height:34px;display:grid;place-items:center;border-radius:50%;position:relative;z-index:1}",
    ".day.inrange{background:rgba(152,179,166,.28)}",
    ".day.first{background:linear-gradient(90deg,transparent 50%,rgba(152,179,166,.28) 50%)}",
    ".day.last{background:linear-gradient(90deg,rgba(152,179,166,.28) 50%,transparent 50%)}",
    ".day.first span{background:var(--ink);color:var(--cream)}",
    ".day.last span{background:var(--sage);color:var(--ink)}",
    ".day:focus-visible span{outline:2px solid var(--rose)}",
    ".legend{display:flex;gap:14px;font-size:11px;color:var(--muted);margin-top:8px}",
    ".legend i{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px;vertical-align:-1px}",
    ".sum{border-top:1px solid var(--line);padding-top:14px;display:grid;grid-template-columns:1fr auto;gap:6px 12px;font-size:13px}",
    ".sum .k{color:var(--muted)}.sum .v{text-align:right}",
    ".sum .tot{font-family:var(--serif);font-size:24px;line-height:1}",
    ".foot{padding:14px 24px 20px;border-top:1px solid var(--line);background:var(--cream)}",
    ".go{all:unset;box-sizing:border-box;display:flex;justify-content:center;align-items:center;gap:10px;width:100%;cursor:pointer;",
    "  padding:15px 18px;background:var(--rose);color:#fff;font-size:13px;letter-spacing:.16em;text-transform:uppercase;",
    "  transition:background .2s,opacity .2s}",
    ".go:hover{background:#6f4550}.go:focus-visible{outline:2px solid var(--ink);outline-offset:3px}",
    ".go[disabled]{opacity:.38;cursor:default;background:var(--rose)}",
    ".fine{font-size:11.5px;color:var(--muted);text-align:center;margin:10px 0 0}",
    ".err{background:#fbe9e7;color:#7a2e22;padding:10px 12px;font-size:12.5px;margin:0 0 12px}",
    ".skel{height:250px;display:grid;place-items:center;color:var(--muted);font-size:12px}",
    "@media (prefers-reduced-motion:reduce){.sheet,.scrim{transition:none}.enter .sec{animation:none}}"
  ].join("\n");

  function Widget(cfg, handle, product, form) {
    this.cfg = cfg; this.handle = handle; this.product = product; this.form = form;
    this.unit = 0; this.period = 0; this.start = null; this.month = null;
    this.timelines = {}; this.error = null; this.busy = false; this.lastFocus = null;
  }

  Widget.prototype.reve = function (path) { return this.cfg.reve.storefront.replace(/\/$/, "") + path; };

  Widget.prototype.syncUnitFromPage = function () {
    var i = unitForPartnerVariant(this.product, readPartnerVariant(this.form));
    this.partnerSizeMatched = i !== -1;
    if (i !== -1 && i !== this.unit) { this.unit = i; this.start = null; this.month = null; }
  };

  Widget.prototype.mountButton = function () {
    var self = this, p = this.product;
    var placeholder = document.querySelector("[data-reve-connect]");
    var host = placeholder || el("div", { "data-reve-connect-host": "" });
    if (!placeholder) this.form.insertAdjacentElement("afterend", host);
    var shadow = host.attachShadow({ mode: "open" });
    var free = p.fixed_fees.every(function (f) { return f.price_cents === 0; });
    var lengths = p.units[0].periods.map(function (x) { return x.days; }).join(", ").replace(/, (\d+)$/, " or $1");
    shadow.appendChild(el("style", { text: CSS_BUTTON }));
    shadow.appendChild(el("div", { class: "rc" }, [
      el("span", { class: "eyebrow", text: "Rent this item through" }),
      el("button", { class: "cta", type: "button", "aria-haspopup": "dialog", onclick: function () { self.open(); } }, [
        el("span", { class: "mark", text: "RÊVE" }),
        el("span", { class: "arrow", "aria-hidden": "true", text: "→" }),
        el("span", { class: "price" }, [el("b", { text: "from " + formatMoney(fromPrice(p)) }), el("br"), lengths + " days"])
      ]),
      free ? el("p", { class: "note", text: "Shipping and cleaning included. Rêve handles the return." }) : null
    ]));
    emit("reve_connect_view", { partner: this.cfg.partner.id, product: this.handle });
  };

  Widget.prototype.mountPanel = function () {
    var self = this;
    var host = el("div", { "data-reve-connect-panel": "" });
    document.body.appendChild(host);
    this.root = host.attachShadow({ mode: "open" });
    this.root.appendChild(el("style", { text: CSS_PANEL }));
    var bodyFont = getComputedStyle(document.body).fontFamily;
    this.wrap = el("div", { class: "rc", style: "--font:" + bodyFont });
    this.root.appendChild(this.wrap);
    this.wrap.addEventListener("keydown", function (e) {
      if (e.key === "Escape") self.close();
      if (e.key === "Tab") self.trapTab(e);
    });
  };

  Widget.prototype.trapTab = function (e) {
    var f = this.root.querySelectorAll("button:not([disabled])");
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1], active = this.root.activeElement;
    if (e.shiftKey && active === first) { last.focus(); e.preventDefault(); }
    else if (!e.shiftKey && active === last) { first.focus(); e.preventDefault(); }
  };

  Widget.prototype.open = function () {
    if (!this.root) this.mountPanel();
    this.isOpen = true;
    this.lastFocus = document.activeElement;
    this.syncUnitFromPage();
    this.error = null;
    this.prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    this.render();
    var self = this;
    this.wrap.classList.add("enter");
    clearTimeout(this.enterTimer);
    this.enterTimer = setTimeout(function () { self.wrap.classList.remove("enter"); }, 700);
    requestAnimationFrame(function () { self.wrap.classList.add("open"); var s = self.root.querySelector(".sheet"); if (s) s.focus(); });
    this.loadTimeline();
    emit("reve_connect_open", { partner: this.cfg.partner.id, product: this.handle });
  };

  Widget.prototype.close = function () {
    if (!this.wrap || !this.isOpen) return;
    this.isOpen = false;
    this.wrap.classList.remove("open");
    document.documentElement.style.overflow = this.prevOverflow || "";
    var self = this;
    setTimeout(function () { if (!self.wrap.classList.contains("open")) self.wrap.innerHTML = ""; }, 340);
    if (this.lastFocus && this.lastFocus.focus) this.lastFocus.focus();
  };

  Widget.prototype.current = function () {
    var u = this.product.units[this.unit];
    return { unit: u, period: u.periods[Math.min(this.period, u.periods.length - 1)] };
  };

  Widget.prototype.loadTimeline = function () {
    var self = this, vid = this.current().unit.variant_id;
    if (this.timelines[vid] && !this.timelines[vid].failed) return;
    this.timelines[vid] = { loading: true };
    fetch(this.reve(this.cfg.reve.proxy_path + "/availability_timelines?variant_shopify_id=" + vid))
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (t) { self.timelines[vid] = { occupancy: t.occupancy || {} }; })
      .catch(function () { self.timelines[vid] = { failed: true }; })
      .then(function () { self.render(); });
  };

  Widget.prototype.render = function () {
    if (!this.isOpen) return;
    var self = this, p = this.product, cur = this.current(), u = cur.unit, per = cur.period;
    var tl = this.timelines[u.variant_id] || { loading: true };
    var starts = tl.occupancy ? bookableStarts(tl.occupancy, per.nights) : [];
    if (this.start && starts.indexOf(this.start) === -1) this.start = null;
    if (!this.month && starts.length) this.month = starts[0].slice(0, 7);

    var sizeChips = p.units.map(function (unit, i) {
      return el("button", { class: "chip", type: "button", "data-k": "u" + i, "aria-pressed": String(i === self.unit),
        onclick: function () { self.unit = i; self.start = null; self.month = null; self.loadTimeline(); self.render(); } }, [unit.size]);
    });
    var sizeHint = !this.partnerSizeMatched
      ? el("p", { class: "hint", text: "Rêve has this piece in " + p.units.map(function (x) { return x.size; }).join(" and ") + "." })
      : null;
    var lengthChips = u.periods.map(function (pp, i) {
      return el("button", { class: "chip", type: "button", "data-k": "p" + i, "aria-pressed": String(i === self.period),
        onclick: function () { self.period = i; self.render(); } }, [pp.label, el("small", { text: formatMoney(pp.price_cents) })]);
    });

    var cal;
    if (tl.loading) cal = el("div", { class: "cal skel", text: "Checking Rêve's calendar…" });
    else if (tl.failed) cal = el("div", { class: "cal skel", text: "Couldn't load Rêve's calendar. Close and try again." });
    else if (!starts.length) cal = el("div", { class: "cal skel", text: "This size is booked for the next few months." });
    else cal = this.calendar(starts, per.nights);

    var summary = null;
    if (this.start) {
      var end = addDays(this.start, per.nights);
      var free = p.fixed_fees.every(function (f) { return f.price_cents === 0; });
      var fees = p.fixed_fees.reduce(function (a, f) { return a + f.price_cents; }, 0);
      summary = el("div", { class: "sum sec" }, [
        el("span", { class: "k", text: "Arrives by" }), el("span", { class: "v", text: formatDay(this.start) }),
        el("span", { class: "k", text: "Send it back" }), el("span", { class: "v", text: formatDay(end) }),
        el("span", { class: "k", text: per.label + " rental" }), el("span", { class: "v", text: formatMoney(per.price_cents) }),
        el("span", { class: "k", text: free ? "Shipping and cleaning" : "Fees" }), el("span", { class: "v", text: free ? "Included" : formatMoney(fees) }),
        el("span", { class: "k", text: "Total" }), el("span", { class: "v tot", text: formatMoney(per.price_cents + fees) })
      ]);
    }

    var sheet = el("div", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-labelledby": "rc-title", tabindex: "-1" }, [
      el("div", { class: "head" }, [
        el("div", { class: "kicker", text: this.cfg.partner.name + " × Rêve" }),
        el("h2", { id: "rc-title" }, ["Rent it through ", el("em", { text: "RÊVE" })]),
        el("p", { class: "lede", text: "Rêve ships it to you, picks it up and has it cleaned. You check out on rentwithreve.com." }),
        el("button", { class: "x", type: "button", "data-k": "x", "aria-label": "Close", onclick: function () { self.close(); } }, ["×"])
      ]),
      el("div", { class: "body" }, [
        this.error ? el("div", { class: "err", role: "alert", text: this.error }) : null,
        el("div", { class: "piece" }, [
          p.image ? el("img", { src: p.image + (p.image.indexOf("?") === -1 ? "?" : "&") + "width=160", alt: "", loading: "lazy" }) : null,
          el("div", {}, [el("div", { class: "t", text: p.title }), el("div", { class: "s", text: "Rêve's piece, size " + u.size })])
        ]),
        el("div", { class: "sec" }, [el("div", { class: "lbl" }, [el("span", { text: "Size" })]), el("div", { class: "chips" }, sizeChips), sizeHint]),
        el("div", { class: "sec" }, [el("div", { class: "lbl" }, [el("span", { text: "How long" })]), el("div", { class: "chips" }, lengthChips)]),
        el("div", { class: "sec" }, [el("div", { class: "lbl" }, [el("span", { text: "Arrives by" }), el("span", { text: per.label })]), cal]),
        summary
      ]),
      el("div", { class: "foot" }, [
        el("button", { class: "go", type: "button", "data-k": "go", disabled: !this.start || this.busy, onclick: function () { self.checkout(); } },
          [this.busy ? "Opening Rêve checkout…" : "Continue to checkout", el("span", { "aria-hidden": "true", text: "↗" })]),
        el("p", { class: "fine", text: "Opens rentwithreve.com in a new tab. " + this.cfg.partner.name + " gets credit for your rental." })
      ])
    ]);
    var scrim = el("div", { class: "scrim", onclick: function () { self.close(); } });
    var wasOpen = this.wrap.classList.contains("open");
    var focusedKey = this.root.activeElement && this.root.activeElement.getAttribute("data-k");
    this.wrap.innerHTML = "";
    this.wrap.appendChild(scrim);
    this.wrap.appendChild(sheet);
    if (wasOpen) {
      var again = focusedKey && this.root.querySelector("[data-k='" + focusedKey + "']");
      (again || sheet).focus({ preventScroll: true });
    }
  };

  Widget.prototype.calendar = function (starts, nights) {
    var self = this, ok = {};
    starts.forEach(function (d) { ok[d] = true; });
    var first = starts[0].slice(0, 7), lastMonth = starts[starts.length - 1].slice(0, 7);
    var ym = this.month || first, y = +ym.slice(0, 4), m = +ym.slice(5, 7) - 1;
    var end = this.start ? addDays(this.start, nights) : null;
    function shift(delta) {
      var d = new Date(Date.UTC(y, m + delta, 1));
      self.month = toIso(d.getTime()).slice(0, 7); self.render();
    }
    var cells = [];
    ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].forEach(function (d) { cells.push(el("div", { class: "dow", text: d })); });
    monthGrid(y, m).forEach(function (week) {
      week.forEach(function (iso) {
        if (!iso) { cells.push(el("div")); return; }
        var cls = ["day"];
        if (self.start && iso >= self.start && iso <= end) cls.push(iso === self.start ? "first" : iso === end ? "last" : "inrange");
        var day = +iso.slice(8);
        cells.push(el("button", { class: cls.join(" "), type: "button", "data-k": "d" + iso, disabled: !ok[iso],
          "aria-label": formatDay(iso) + (ok[iso] ? "" : ", unavailable"), "aria-pressed": String(iso === self.start),
          onclick: function () { self.start = iso; self.error = null; self.render(); } }, [el("span", { text: String(day) })]));
      });
    });
    return el("div", { class: "cal" }, [
      el("div", { class: "calh" }, [
        el("button", { class: "nav", type: "button", "aria-label": "Previous month", "data-k": "prev", disabled: ym <= first, onclick: function () { shift(-1); } }, ["‹"]),
        el("b", { text: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][m] + " " + y }),
        el("button", { class: "nav", type: "button", "aria-label": "Next month", "data-k": "next", disabled: ym >= lastMonth, onclick: function () { shift(1); } }, ["›"])
      ]),
      el("div", { class: "grid" }, cells),
      el("div", { class: "legend" }, [
        el("span", {}, [el("i", { style: "background:#2b2326" }), "Arrives"]),
        el("span", {}, [el("i", { style: "background:#98b3a6" }), "Send back"])
      ])
    ]);
  };

  Widget.prototype.checkout = function () {
    var self = this, cur = this.current(), cfg = this.cfg, start = this.start;
    if (!start || this.busy) return;
    var tab = window.open("", "_blank");
    if (tab) {
      try { tab.document.title = "Rêve checkout"; tab.document.body.innerHTML = "<p style='font:15px Georgia,serif;margin:40vh auto;text-align:center;color:#83545f'>Taking you to Rêve checkout…</p>"; } catch (e) { }
    }
    this.busy = true; this.error = null; this.render();
    var detail = { partner: cfg.partner.id, product: this.handle, reve_variant: cur.unit.variant_id, start: start, days: cur.period.days };
    emit("reve_connect_checkout_start", detail);

    function fail(msg) {
      if (tab) try { tab.close(); } catch (e) { }
      self.busy = false; self.error = msg; self.render();
      emit("reve_connect_error", Object.assign({ message: msg }, detail));
    }
    fetch(this.reve(cfg.reve.proxy_path + "/intents"), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(intentBody(cur.unit, cur.period, start))
    }).then(function (r) { if (!r.ok) throw new Error("intents HTTP " + r.status); return r.json(); })
      .then(function (intent) {
        if (!(intent.available_item_count >= 1)) {
          delete self.timelines[cur.unit.variant_id];
          self.start = null; self.loadTimeline();
          throw new Error("taken");
        }
        var opts = { intentAttributes: intent.attributes, unit: cur.unit, period: cur.period, startIso: start, partnerId: cfg.partner.id, partnerHandle: self.handle };
        return self.createCart(opts).then(function (url) { return { url: url, opts: opts }; });
      })
      .then(function (res) {
        emit("reve_connect_checkout", detail);
        self.busy = false; self.render();
        if (res.url) { if (tab) tab.location.href = res.url; else location.href = res.url; }
        else self.postCartForm(res.opts, tab);
      })
      .catch(function (e) {
        fail(e && e.message === "taken" ? "Those dates were just booked. Pick another arrival date." : "Couldn't reach Rêve checkout. Please try again.");
      });
  };

  /* -> checkoutUrl, or null when the Storefront API path is unavailable (caller falls back to the form). */
  Widget.prototype.createCart = function (opts) {
    var r = this.cfg.reve;
    return fetch(this.reve("/api/" + r.storefront_api_version + "/graphql.json"), {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query: CART_CREATE, variables: { input: cartInput(opts) } })
    }).then(function (res) { return res.ok ? res.json() : null; })
      .then(function (body) {
        var c = body && body.data && body.data.cartCreate;
        if (!c || !c.cart || (c.userErrors && c.userErrors.length)) return null;
        return c.cart.checkoutUrl;
      }).catch(function () { return null; });
  };

  Widget.prototype.postCartForm = function (opts, tab) {
    var name = "reve_checkout_" + Date.now();
    if (tab) tab.name = name;
    var form = el("form", { method: "POST", action: this.reve("/cart/add"), target: tab ? name : "_self", style: "display:none" });
    var fields = cartFormFields(opts);
    Object.keys(fields).forEach(function (k) { form.appendChild(el("input", { type: "hidden", name: k, value: fields[k] })); });
    document.body.appendChild(form);
    form.submit();
    setTimeout(function () { form.remove(); }, 1000);
  };

  function boot(script) {
    if (!script || typeof fetch !== "function") return;
    var partner = script.getAttribute("data-partner");
    var handle = (script.getAttribute("data-product-handle") || "").toLowerCase() || productHandleFromPath(location.pathname);
    if (!partner || !handle) return;
    var url = script.getAttribute("data-config") || new URL("partners/" + partner + ".json", script.src).href;
    function start() {
      var loaded = null;
      fetch(url).then(function (r) { return r.ok ? r.json() : null; }).then(function (cfg) {
        if (!validConfig(cfg)) return null;
        loaded = cfg;
        var product = cfg.products[handle];
        if (!product) return null;
        if (cfg.partner.holdout_share > 0 && bucket(visitorSeed() + ":" + cfg.partner.id) < cfg.partner.holdout_share) {
          emit("reve_connect_holdout", { partner: cfg.partner.id, product: handle });
          return null;
        }
        var ratio = cfg.partner.min_buy_to_rent;
        if (!ratio) return product;
        return fetch("/products/" + handle + ".js").then(function (r) { return r.ok ? r.json() : null; }).then(function (pj) {
          var prices = pj ? pj.variants.filter(function (v) { return v.available; }).map(function (v) { return v.price; }) : [];
          var buy = prices.length ? Math.min.apply(null, prices) : 0;
          if (worthRenting(buy, fromPrice(product), ratio)) return product;
          emit("reve_connect_suppressed", { partner: cfg.partner.id, product: handle, buy_cents: buy });
          return null;
        }, function () { return product; });
      }).then(function (product) {
        if (!product) return;
        var cfg = loaded;
        var form = findForm(cfg);
        if (!form && !document.querySelector("[data-reve-connect]")) return;
        var w = new Widget(cfg, handle, product, form);
        w.syncUnitFromPage();
        w.mountButton();
        if (form) setInterval(function () { if (!w.wrap || !w.wrap.classList.contains("open")) w.syncUnitFromPage(); }, 600);
        window.ReveConnect.instance = w;
      }).catch(function () { /* never break the partner page */ });
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
    else start();
  }

  return {
    VERSION: VERSION, SCHEMA: SCHEMA, CART_CREATE: CART_CREATE,
    productHandleFromPath: productHandleFromPath, addDays: addDays, isBookable: isBookable,
    bookableStarts: bookableStarts, monthGrid: monthGrid, unitForPartnerVariant: unitForPartnerVariant,
    fromPrice: fromPrice, formatMoney: formatMoney, formatDay: formatDay, formatPropDate: formatPropDate,
    intentBody: intentBody, splitIntent: splitIntent, cartInput: cartInput, cartFormFields: cartFormFields,
    bucket: bucket, worthRenting: worthRenting, validConfig: validConfig, boot: boot
  };
});
