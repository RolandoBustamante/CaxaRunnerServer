import assert from "node:assert";
const src = (await import("node:fs")).readFileSync("server/index.js", "utf8");
const take = (re) => src.match(re)[0];
const body = [
  take(/function normalizeText[\s\S]*?\n}/),
  take(/function normalizeDorsal[\s\S]*?\n}/),
  take(/function buildSinTiempoRows[\s\S]*?\n}/),
].join("\n");
const { buildSinTiempoRows } = await import(
  "data:text/javascript," + encodeURIComponent(body + "\nexport { buildSinTiempoRows };")
);

const participants = [
  { id: 1, dorsal: "12", nombre: "Ana", distancia: "10K" },   // corrio (el finisher dice "012")
  { id: 2, dorsal: "045", nombre: "Beto", distancia: "21K" }, // no corrio
  { id: 3, dorsal: null, nombre: "Caro", distancia: "10K" },  // inscrito sin dorsal: no sale
  { id: 4, dorsal: "7", nombre: "Dina", distancia: "10K" },   // marcado ST, ya tiene fila
];
const finishers = [{ dorsal: "012" }, { dorsal: "007" }];

const rows = buildSinTiempoRows(participants, finishers, true);
assert.deepStrictEqual(rows.map((row) => row.name), ["Beto"], "solo el inscrito con dorsal que no cruzo meta");
assert.strictEqual(rows[0].noTime, true);
assert.strictEqual(rows[0].position, null);
assert.strictEqual(rows[0].certificateDorsal, null, "sin tiempo no habilita certificado");
assert.strictEqual(rows[0].dorsal, "045");

assert.strictEqual(buildSinTiempoRows(participants, finishers, false)[0].dorsal, null, "respeta showDorsalPublic");
console.log("ok");
