// Certificado de la Media Maraton de Cajamarca.
// Misma paleta, fondo y tipografia que la tarjeta de bienvenida (ver utils/welcomeCard.js)
// para que el corredor reconozca la pieza como del mismo evento.
const CERT_WIDTH = 1120;
const CERT_HEIGHT = 760;

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Greca escalonada andina en SVG: un patron CSS no sobrevive al render de Playwright.
function grecaDataUri(color = "%23f0be72") {
  return (
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='72' height='72'%3E" +
    "%3Cpath d='M0 72h18V54h18V36h18V18h18V0' fill='none' stroke='" + color + "' stroke-width='9'/%3E" +
    "%3C/svg%3E"
  );
}

// Una sola linea: el nombre cursivo se achica para no salirse de los 860px utiles.
// Anchos medidos en Chrome sobre assets/allura-latin.woff2 (em por caracter, +5% de holgura
// porque Allura kernea mas ancho que la suma de avances). Una MAYUSCULA pesa casi el doble
// que una minuscula: el padron llega en caja alta desde Excel y un solo factor promedio lo desborda.
const ALLURA_EM = { upper: 0.68, lower: 0.39, space: 0.23 };

function nameFontSize(name) {
  const em = [...String(name || "").trim()].reduce((sum, char) => {
    if (char === " ") return sum + ALLURA_EM.space;
    const isUpper = char === char.toUpperCase() && char !== char.toLowerCase();
    return sum + (isUpper ? ALLURA_EM.upper : ALLURA_EM.lower);
  }, 0.5);
  return Math.round(Math.min(88, Math.max(32, 860 / em)));
}

/**
 * Documento completo del certificado (1120x760, A4 apaisado).
 * Recibe los assets ya en data URI: el PDF se renderiza sin red.
 */
function buildMediaCertificateHtmlDocument({
  race,
  certificate,
  eventDate,
  officialTime,
  raceLogoDataUri,
  clubLogoDataUri,
  backgroundDataUri,
  scriptFontDataUri,
}) {
  const isNoTime = Boolean(certificate?.noTime);
  const nombre = String(certificate?.name || "").trim();
  const subtitle = isNoTime
    ? "El comité organizador certifica una llegada validada sin tiempo oficial."
    : "El comité organizador certifica que el corredor(a) concluyó oficialmente la prueba.";
  const summary = isNoTime
    ? `Se certifica la llegada validada a la distancia de <strong>${escapeHtml(certificate.distance)}</strong>, con registro confirmado <strong>sin tiempo oficial</strong>.`
    : `Concluyó oficialmente la distancia de <strong>${escapeHtml(certificate.distance)}</strong>, ocupando el puesto <strong>${escapeHtml(certificate.position)}</strong> en la clasificación general de su distancia, con un tiempo oficial de <strong>${escapeHtml(officialTime)}</strong>.`;

  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <title>Certificado ${escapeHtml(nombre)}</title>
    <style>
      :root {
        --navy: #06253f;
        --neon: #57a9f5;
        --gold: #f0be72;
        --gold-soft: #ffe3ac;
      }
      * { box-sizing: border-box; margin: 0; padding: 0; }
      html, body {
        width: ${CERT_WIDTH}px;
        height: ${CERT_HEIGHT}px;
        overflow: hidden;
        background: var(--navy);
        font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
        color: #ffffff;
      }
      .page { position: relative; width: ${CERT_WIDTH}px; height: ${CERT_HEIGHT}px; overflow: hidden; }
      .bg, .photo-bg, .glow, .vignette { position: absolute; inset: 0; }
      .bg { background: linear-gradient(158deg, #06253f 0%, #0b3f5f 38%, #106a83 72%, #1594a4 100%); }
      /* Panoramica de Santa Apolonia. Si falta el archivo queda el degradado de abajo. */
      .photo-bg {
        background-image: ${backgroundDataUri ? `url("${backgroundDataUri}")` : "none"};
        background-size: cover;
        background-position: 50% 58%;
        /* Aqui no va ningun filter: un filtro CSS obliga a Chromium a rasterizar la pagina
           entera a resolucion de impresion en vez de incrustar el JPEG tal cual. Con
           saturate(0.85) contrast(1.04) el PDF pesaba 6947 KB y el render tardaba 1183ms;
           sin el, 628 KB y 433ms. El ajuste no se notaba: encima va el velo de
           .photo-bg::after al 72-93% de opacidad. */
      }
      /* Velo fuerte y parejo: con la ciudad a plena vista no se leen ni el nombre ni los tiempos. */
      .photo-bg::after {
        content: "";
        position: absolute;
        inset: 0;
        background: linear-gradient(180deg, rgba(5, 24, 44, 0.93) 0%, rgba(6, 34, 54, 0.86) 30%, rgba(4, 30, 47, 0.72) 62%, rgba(5, 28, 43, 0.95) 100%);
      }
      .glow { background: radial-gradient(54% 40% at 50% 38%, rgba(87, 169, 245, 0.2) 0%, rgba(6, 37, 63, 0) 72%); }
      .vignette { background: radial-gradient(120% 80% at 50% 46%, rgba(6, 37, 63, 0) 52%, rgba(4, 24, 41, 0.78) 100%); }
      .greca {
        position: absolute;
        top: 0;
        height: 100%;
        width: 40px;
        opacity: 0.18;
        background-image: url("${grecaDataUri()}");
        background-repeat: repeat-y;
        background-size: 40px 40px;
      }
      .greca-l { left: 14px; }
      .greca-r { right: 14px; transform: scaleX(-1); }
      .frame {
        position: absolute;
        inset: 26px;
        border: 2px solid rgba(240, 190, 114, 0.45);
        border-radius: 6px;
      }

      .content {
        position: relative;
        z-index: 2;
        height: 100%;
        padding: 38px 80px 28px;
        display: flex;
        flex-direction: column;
        align-items: center;
        text-align: center;
      }
      header {
        width: 100%;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 28px;
      }
      header img { object-fit: contain; }
      .race-logo { max-height: 84px; max-width: 280px; }
      .club-logo { max-height: 60px; max-width: 170px; opacity: 0.94; }
      header .rule { flex: 1; height: 2px; background: linear-gradient(90deg, rgba(231, 201, 121, 0), rgba(231, 201, 121, 0.7), rgba(231, 201, 121, 0)); }

      .event { margin-top: auto; font-size: 13px; font-weight: 800; letter-spacing: 0.16em; text-transform: uppercase; color: var(--gold-soft); }
      h1 {
        margin-top: 4px;
        font-family: "Segoe UI Black", "Arial Black", "Segoe UI", sans-serif;
        font-size: 42px;
        font-weight: 900;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        text-shadow: 0 8px 22px rgba(3, 20, 34, 0.55);
      }
      .subtitle { margin-top: 8px; max-width: 760px; font-size: 16px; line-height: 1.4; color: rgba(255, 255, 255, 0.86); }

      /* Allura va incrustada: Playwright renderiza sin red y una cursiva del sistema arruina el nombre. */
      ${scriptFontDataUri ? `@font-face {
        font-family: "Allura";
        font-style: normal;
        font-weight: 400;
        src: url("${scriptFontDataUri}") format("woff2");
      }` : ""}
      .name {
        margin-top: 10px;
        font-family: "Allura", "Segoe Script", cursive;
        font-size: ${nameFontSize(nombre)}px;
        line-height: 1.15;
        white-space: nowrap;
        text-shadow: 0 8px 24px rgba(3, 20, 34, 0.55);
      }
      .name-underline {
        margin: 4px auto 0;
        width: 280px;
        height: 3px;
        border-radius: 999px;
        background: linear-gradient(90deg, rgba(240, 190, 114, 0), var(--gold), rgba(240, 190, 114, 0));
      }
      .summary { margin-top: 14px; max-width: 820px; font-size: 17px; line-height: 1.55; color: rgba(255, 255, 255, 0.92); }
      .summary strong { color: var(--gold-soft); font-weight: 800; }

      .metrics { margin-top: 18px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; width: 820px; }
      .metric {
        padding: 14px 10px;
        border-radius: 8px;
        border: 1px solid rgba(240, 190, 114, 0.38);
        background: rgba(5, 26, 45, 0.55);
      }
      .metric-value { font-size: 32px; font-weight: 900; line-height: 1; white-space: nowrap; }
      .metric-label { margin-top: 9px; font-size: 11px; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; color: var(--gold); }
      .secondary { margin-top: 14px; display: flex; gap: 20px; justify-content: center; font-size: 13px; color: rgba(255, 255, 255, 0.86); }
      .secondary strong { color: var(--gold-soft); }

      footer {
        margin-top: auto;
        width: 100%;
        display: flex;
        justify-content: space-between;
        align-items: flex-end;
        font-size: 12px;
        color: rgba(255, 255, 255, 0.8);
      }
      footer strong { color: #ffffff; }
      @page { size: A4 landscape; margin: 0; }
    </style>
  </head>
  <body>
    <div class="page">
      <div class="bg"></div>
      <div class="photo-bg"></div>
      <div class="glow"></div>
      <div class="vignette"></div>
      <div class="greca greca-l"></div>
      <div class="greca greca-r"></div>
      <div class="frame"></div>

      <div class="content">
        <header>
          ${raceLogoDataUri ? `<img class="race-logo" src="${raceLogoDataUri}" alt="Media Maratón de Cajamarca" />` : "<span></span>"}
          <span class="rule"></span>
          ${clubLogoDataUri ? `<img class="club-logo" src="${clubLogoDataUri}" alt="Cajamarca Runners" />` : "<span></span>"}
        </header>

        <div class="event">${escapeHtml(race?.name || "Resultado oficial")}</div>
        <h1>Certificado de Finisher</h1>
        <p class="subtitle">${subtitle}</p>

        <div class="name">${escapeHtml(nombre)}</div>
        <div class="name-underline"></div>

        <p class="summary">${summary}</p>

        <div class="metrics">
          <div class="metric">
            <div class="metric-value">${escapeHtml(isNoTime ? "ST" : officialTime)}</div>
            <div class="metric-label">${isNoTime ? "Estado" : "Tiempo oficial"}</div>
          </div>
          <div class="metric">
            <div class="metric-value">${escapeHtml(certificate?.position ?? "-")}</div>
            <div class="metric-label">Puesto por distancia</div>
          </div>
          <div class="metric">
            <div class="metric-value">${escapeHtml(certificate?.dorsal ?? "-")}</div>
            <div class="metric-label">Dorsal</div>
          </div>
        </div>

        <div class="secondary">
          <span><strong>Categoría:</strong> ${escapeHtml(certificate?.categoryName ?? "-")}</span>
          <span><strong>Puesto en categoría:</strong> ${escapeHtml(certificate?.categoryPosition ?? "-")}</span>
          <span><strong>Distancia:</strong> ${escapeHtml(certificate?.distance ?? "-")}</span>
        </div>

        <footer>
          <div><strong>Fecha del evento:</strong> ${escapeHtml(eventDate || "-")}</div>
          <div><strong>Código:</strong> ${escapeHtml(certificate?.certificateCode || "-")}</div>
        </footer>
      </div>
    </div>
  </body>
</html>`;
}

module.exports = { buildMediaCertificateHtmlDocument, CERT_WIDTH, CERT_HEIGHT };

// `node utils/mediaCertificate.js` escribe una muestra para abrirla en Chrome y medir el layout.
if (require.main === module) {
  const assert = require("assert");
  const fs = require("fs");
  const path = require("path");

  assert(nameFontSize("Ana Paz") > nameFontSize("Maria Fernanda Bustamante Rojas"));
  assert(nameFontSize("x".repeat(200)) >= 32 && nameFontSize("A") <= 88);
  // El caso que desbordaba: el mismo nombre en caja alta necesita mucho menos cuerpo.
  const mixto = "Karla Yanina Bustamante Becerra";
  assert(nameFontSize(mixto.toUpperCase()) < nameFontSize(mixto) * 0.8);

  const toDataUri = (file, mime) => {
    const full = path.join(__dirname, "..", "assets", file);
    return fs.existsSync(full) ? `data:${mime};base64,${fs.readFileSync(full).toString("base64")}` : null;
  };
  const html = buildMediaCertificateHtmlDocument({
    race: { name: "II Media Maratón de Cajamarca 2026" },
    certificate: {
      name: "María Fernanda Bustamante Rojas",
      dorsal: "1234",
      position: 7,
      distance: "21K",
      categoryName: "Damas 30-39",
      categoryPosition: 2,
      certificateCode: "CR-1-99-1234",
    },
    eventDate: "15 de marzo de 2026",
    officialTime: "01:42:08",
    raceLogoDataUri: toDataUri("mmc-negativo.png", "image/png"),
    clubLogoDataUri: toDataUri("cajamarca-runners-white-logo.png", "image/png"),
    backgroundDataUri: toDataUri("santa-apolonia.jpg", "image/jpeg"),
    scriptFontDataUri: toDataUri("allura-latin.woff2", "font/woff2"),
  });
  assert(!html.includes("<script"), "el certificado no debe inyectar scripts");
  const out = path.join(require("os").tmpdir(), "certificado-media-preview.html");
  fs.writeFileSync(out, html);
  console.log("ok ->", out);
}
