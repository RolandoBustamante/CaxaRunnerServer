import assert from "node:assert";
const src = (await import("node:fs")).readFileSync("client/src/components/Registrations.jsx", "utf8");
const body = src.match(/export function splitPaidAmounts[\s\S]*?\n}\n\nfunction roundMoney[\s\S]*?\n}/)[0];
const { splitPaidAmounts } = await import("data:text/javascript," + encodeURIComponent(body));

const precios = new Map([["5K", 65], ["10K", 90], ["21K", 120]]);
const grupo = (...distancias) => distancias.map((distancia) => ({ distancia }));

// dos inscripciones en un solo pago de 155: 90 + 65
assert.deepStrictEqual(splitPaidAmounts(grupo("10K", "5K"), 155, precios).paid, [90, 65]);

// con descuento el reparto es proporcional y suma exacto al pagado
const conDescuento = splitPaidAmounts(grupo("10K", "5K"), 139.5, precios).paid;
assert.deepStrictEqual(conDescuento, [81, 58.5]);
assert.strictEqual(conDescuento.reduce((a, b) => a + b, 0), 139.5);

// tres iguales: el ultimo absorbe el centavo que el redondeo deja suelto
const tercios = splitPaidAmounts(grupo("5K", "5K", "5K"), 100, precios).paid;
assert.deepStrictEqual(tercios, [33.33, 33.33, 33.34]);
assert.strictEqual(tercios.reduce((a, b) => a + b, 0), 100);

// distancia sin precio configurado: no inventa monto
assert.deepStrictEqual(splitPaidAmounts(grupo("42K"), 90, precios), { prices: [null], paid: [null] });

// sin total (inscripcion vieja sin montos) no hay desglose
assert.deepStrictEqual(splitPaidAmounts(grupo("10K"), null, precios).paid, [null]);

console.log("ok");
