import assert from "node:assert";
const src = (await import("node:fs")).readFileSync("server/index.js", "utf8");
const body = src.match(/function limaDateString[\s\S]*?\n}\n\nfunction isExpired[\s\S]*?\n}/)[0];
const { limaDateString, isExpired } = await import(
  "data:text/javascript," + encodeURIComponent(body + "\nexport { limaDateString, isExpired };")
);

// parseValidUntil guarda "2026-10-30" como 2026-10-30T23:59:59.999Z
const deadline = new Date("2026-10-30T23:59:59.999Z");
const at = (iso) => { const real = Date.now; Date.now = () => new Date(iso).getTime();
  const orig = global.Date; // isExpired usa new Date() sin args
  global.Date = class extends orig { constructor(...a) { super(...(a.length ? a : [iso])); } static now() { return new orig(iso).getTime(); } };
  const r = isExpired(deadline); global.Date = orig; Date.now = real; return r; };

assert.strictEqual(isExpired(null), false, "sin fecha = nunca vence");
assert.strictEqual(at("2026-10-30T20:00:00Z"), false, "30 oct 15:00 Lima: sigue vigente"); // el bug viejo: ya habria vencido
assert.strictEqual(at("2026-10-31T04:59:00Z"), false, "30 oct 23:59 Lima: ultimo minuto vigente");
assert.strictEqual(at("2026-10-31T05:01:00Z"), true, "31 oct 00:01 Lima: vencido");
console.log("ok");
