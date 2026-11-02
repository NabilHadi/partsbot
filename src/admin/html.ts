/** Tiny server-side HTML helpers for /admin. Everything interpolated goes through `esc` (or is `raw` on purpose). */

export class Raw {
  constructor(readonly html: string) {}
}
export const raw = (html: string) => new Raw(html);

export function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Tagged template: values are escaped unless they are Raw (or arrays of Raw/strings, joined). */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Raw {
  let out = strings[0] ?? "";
  values.forEach((v, i) => {
    out += render(v) + (strings[i + 1] ?? "");
  });
  return new Raw(out);
}

function render(v: unknown): string {
  if (v instanceof Raw) return v.html;
  if (Array.isArray(v)) return v.map(render).join("");
  if (v === null || v === undefined || v === false) return "";
  return esc(v);
}

/** Text that may be Arabic: isolated so it displays correctly inside an LTR English page. */
export const bidi = (text: unknown) => html`<bdi dir="auto">${text}</bdi>`;

const RIYADH = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Riyadh", year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
});
export function riyadhTime(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return `${RIYADH.format(new Date(d))} (Riyadh)`;
}

export interface LayoutOpts {
  title: string;
  nav?: boolean;
  csrf?: string;
  flash?: { kind: "ok" | "error"; text: string } | null;
}

export function layout(opts: LayoutOpts, body: Raw): string {
  const nav = opts.nav
    ? html`<nav><a href="/admin/shops">Shops</a><a href="/admin/app">App status</a><a href="/admin/audit">Audit log</a>
<form method="post" action="/admin/logout" class="inline"><input type="hidden" name="_csrf" value="${opts.csrf}"><button class="link">Log out</button></form></nav>`
    : "";
  const flash = opts.flash ? html`<p class="flash ${opts.flash.kind}">${opts.flash.text}</p>` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(opts.title)} · PartsBot admin</title>
<link rel="stylesheet" href="/admin/admin.css"></head>
<body><header><strong>PartsBot admin</strong>${render(nav)}</header><main><h1>${esc(opts.title)}</h1>${render(flash)}${body.html}</main></body></html>`;
}

export const CSS = `
*{box-sizing:border-box}body{margin:0;font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans Arabic",sans-serif;color:#1d2330;background:#f5f6f8}
header{display:flex;gap:24px;align-items:center;padding:12px 24px;background:#1d2330;color:#fff}
header nav{display:flex;gap:16px;align-items:center;flex:1}header nav a{color:#cfd6e4;text-decoration:none}header nav a:hover{color:#fff}
header nav form{margin-left:auto}
main{max-width:1100px;margin:0 auto;padding:16px 24px 48px}h1{font-size:22px;margin:8px 0 16px}h2{font-size:17px;margin:28px 0 8px}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e1e4ea}th,td{padding:8px 10px;border-bottom:1px solid #eceef2;text-align:left;vertical-align:top}
th{background:#fafbfc;font-weight:600;font-size:13px;color:#566}tr:last-child td{border-bottom:0}
.card{background:#fff;border:1px solid #e1e4ea;border-radius:6px;padding:16px;margin-bottom:16px}
label{display:block;font-weight:600;margin:10px 0 4px}.hint{font-weight:400;color:#667;font-size:13px}
input[type=text],input[type=number],input[type=password],input[type=file],select{width:100%;max-width:420px;padding:7px 9px;border:1px solid #c9ced8;border-radius:4px;font:inherit;background:#fff}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:4px 24px}
button{padding:7px 14px;border:0;border-radius:4px;background:#2457c5;color:#fff;font:inherit;cursor:pointer}button.danger{background:#b3261e}
button.link{background:none;color:#cfd6e4;padding:0}.inline{display:inline}
.err{color:#b3261e;font-size:13px;margin-top:2px}.field.bad input,.field.bad select{border-color:#b3261e}
.flash{padding:10px 12px;border-radius:4px}.flash.ok{background:#e6f4ea}.flash.error{background:#fde7e9}
.badge{display:inline-block;padding:1px 7px;border-radius:9px;font-size:12px;background:#eceef2}.badge.active{background:#e6f4ea}.badge.paused{background:#fff4d6}.badge.closed{background:#fde7e9}
.muted{color:#667}code{font-size:13px}bdi{unicode-bidi:isolate}
`;
