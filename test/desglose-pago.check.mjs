import assert from "node:assert";
const src = (await import("node:fs")).readFileSync("client/src/components/Registrations.jsx", "utf8");
const body = src.match(/export function splitPaidAmounts[\s\S]*?\n}\n\nfunction roundMoney[\s\S]*?\n}/)[0];
const { splitPaidAmounts } = await import("data:text/javascript," + encodeURIComponent(body));

const precios = new Map([["5K", 40], ["10K", 70], ["21K", 85]]);
const grupo = (...distancias) => distancias.map((distancia) => ({ distancia }));

// dos inscritos en un solo pago de 155: 85 + 70
assert.deepStrictEqual(splitPaidAmounts(grupo("21K", "10K"), 155, precios, 155).paid, [85, 70]);

// con descuento el reparto es proporcional y suma exacto al pagado
const conDescuento = splitPaidAmounts(grupo("21K", "10K"), 139.5, precios, 155);
assert.deepStrictEqual(conDescuento.paid, [76.5, 63]);
assert.strictEqual(conDescuento.paid.reduce((a, b) => a + b, 0), 139.5);
assert.strictEqual(conDescuento.descuadre, null, "el descuento se compara contra el subtotal");

// tres iguales: el ultimo absorbe el centavo que el redondeo deja suelto
const tercios = splitPaidAmounts(grupo("5K", "5K", "5K"), 100, precios, 100).paid;
assert.deepStrictEqual(tercios, [33.33, 33.33, 33.34]);
assert.strictEqual(tercios.reduce((a, b) => a + b, 0), 100);

// caso real INS-6-MSUPYRFK: dos 10K cobrados 155 cuando la lista dice 140
const raro = splitPaidAmounts(grupo("10K", "10K"), 155, precios, 155);
assert.strictEqual(raro.descuadre, 15, "queda marcado para revisar");
assert.strictEqual(raro.paid.reduce((a, b) => a + b, 0), 155, "el balance sigue cuadrando con la plata");

// distancia sin precio configurado: no inventa monto
assert.deepStrictEqual(splitPaidAmounts(grupo("42K"), 90, precios), { prices: [null], paid: [null], descuadre: null });

// sin total (inscripcion vieja sin montos) no hay desglose
assert.deepStrictEqual(splitPaidAmounts(grupo("10K"), null, precios).paid, [null]);

console.log("ok");
