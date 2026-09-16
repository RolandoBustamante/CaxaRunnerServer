const WELCOME_CARD_WIDTH = 1080;
const WELCOME_CARD_HEIGHT = 1350;

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

// El nombre manda en la composicion: entre mas largo, mas chico.
function nameFontSize(name) {
  const length = String(name || "").trim().length;
  if (length <= 14) return 96;
  if (length <= 20) return 80;
  if (length <= 28) return 66;
  return 54;
}

function greetingFor(genero) {
  return String(genero || "").trim().toUpperCase().startsWith("F")
    ? "¡BIENVENIDA!"
    : "¡BIENVENIDO!";
}

// Greca escalonada andina, en SVG porque un patron CSS no sobrevive al render.
function grecaDataUri(color = "%23f6e6b8") {
  return (
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='72' height='72'%3E" +
    "%3Cpath d='M0 72h18V54h18V36h18V18h18V0' fill='none' stroke='" + color + "' stroke-width='9'/%3E" +
    "%3C/svg%3E"
  );
}

/**
 * Documento completo de la tarjeta de bienvenida (1080x1350).
 * El mismo HTML alimenta la vista previa del panel y la captura PNG,
 * asi no hay dos disenos que mantener sincronizados.
 */
function buildWelcomeHtmlDocument({
  race,
  participant,
  photoDataUri,
  raceLogoDataUri,
  clubLogoDataUri,
  eventDateText,
  options = {},
}) {
  const zoom = clamp(options.zoom, 100, 320, 118);
  const focusX = clamp(options.focusX, 0, 100, 50);
  const focusY = clamp(options.focusY, 0, 100, 42);
  const interactive = Boolean(options.interactive);
  // multipart manda todo como texto: "false" tiene que contar como false.
  const showProcedencia = options.showProcedencia == null
    ? true
    : !["false", "0", "no", ""].includes(String(options.showProcedencia).toLowerCase());

  const nombre = String(participant?.nombre || "").trim();
  const distancia = String(participant?.distancia || "").trim();
  const dorsal = String(participant?.dorsal || "").trim();
  const procedencia = String(participant?.procedencia || participant?.club || "").trim();
  const greeting = greetingFor(participant?.genero);
  const raceName = String(race?.name || "").trim();

  const chips = [
    distancia ? `<span class="chip chip-gold">${escapeHtml(distancia)}</span>` : "",
    dorsal ? `<span class="chip">DORSAL ${escapeHtml(dorsal)}</span>` : "",
    procedencia
      ? `<span class="chip" id="chip-procedencia"${showProcedencia ? "" : ' style="display:none"'}>${escapeHtml(procedencia)}</span>`
      : "",
  ].filter(Boolean).join("");

  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <title>Bienvenida ${escapeHtml(nombre)}</title>
    <style>
      :root {
        --navy: #06253f;
        --navy-mid: #0d4a6b;
        --teal: #17a2b8;
        --teal-bright: #2fd6d6;
        --gold: #e7c979;
        --gold-soft: #f6e6b8;
      }
      * { box-sizing: border-box; margin: 0; padding: 0; }
      html, body {
        width: ${WELCOME_CARD_WIDTH}px;
        height: ${WELCOME_CARD_HEIGHT}px;
        overflow: hidden;
        background: #06253f;
      }
      body {
        position: relative;
        font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
        color: #ffffff;
        display: flex;
        flex-direction: column;
        align-items: center;
      }

      /* ---------- fondo ---------- */
      .bg,
      .glow,
      .streaks,
      .vignette { position: absolute; inset: 0; }
      .bg {
        background: linear-gradient(158deg, #06253f 0%, #0b3f5f 38%, #106a83 72%, #1594a4 100%);
      }
      .glow {
        background: radial-gradient(52% 34% at 50% 40%, rgba(64, 232, 226, 0.42) 0%, rgba(64, 232, 226, 0.12) 45%, rgba(6, 37, 63, 0) 72%);
      }
      .streaks {
        background: repeating-linear-gradient(112deg, rgba(255, 255, 255, 0.055) 0 3px, rgba(255, 255, 255, 0) 3px 46px);
      }
      .vignette {
        background: radial-gradient(120% 78% at 50% 44%, rgba(6, 37, 63, 0) 55%, rgba(4, 24, 41, 0.72) 100%);
      }
      .greca {
        position: absolute;
        top: 0;
        height: 100%;
        width: 48px;
        opacity: 0.16;
        background-image: url("${grecaDataUri()}");
        background-repeat: repeat-y;
        background-size: 48px 48px;
      }
      .greca-l { left: 18px; }
      .greca-r { right: 18px; transform: scaleX(-1); }

      /* ---------- cabecera ---------- */
      header {
        position: relative;
        width: 100%;
        padding: 54px 96px 0;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 32px;
      }
      header img { max-height: 104px; max-width: 320px; object-fit: contain; }
      header .rule { flex: 1; height: 2px; background: linear-gradient(90deg, rgba(231, 201, 121, 0), rgba(231, 201, 121, 0.75), rgba(231, 201, 121, 0)); }

      .eyebrow {
        position: relative;
        margin-top: 34px;
        font-size: 25px;
        font-weight: 700;
        letter-spacing: 0.42em;
        text-indent: 0.42em;
        color: var(--gold);
        text-transform: uppercase;
      }
      h1 {
        position: relative;
        margin-top: 6px;
        font-family: "Segoe UI Black", "Arial Black", "Segoe UI", sans-serif;
        font-size: 104px;
        font-style: italic;
        font-weight: 900;
        letter-spacing: -0.035em;
        line-height: 1;
        text-shadow: 0 10px 28px rgba(3, 20, 34, 0.55);
      }

      /* ---------- retrato ---------- */
      .portrait {
        position: relative;
        margin-top: 26px;
        width: 536px;
        height: 536px;
        border-radius: 50%;
        display: grid;
        place-items: center;
        background: conic-gradient(from 212deg, var(--teal-bright) 0%, #0e7490 22%, var(--gold-soft) 46%, var(--gold) 58%, #0e7490 80%, var(--teal-bright) 100%);
      }
      .portrait::before {
        content: "";
        position: absolute;
        inset: 16px;
        border-radius: 50%;
        border: 3px solid rgba(255, 255, 255, 0.35);
      }
      .portrait-inner {
        width: 452px;
        height: 452px;
        border-radius: 50%;
        padding: 9px;
        background: linear-gradient(140deg, var(--gold-soft), var(--gold) 45%, #c9a44f 100%);
      }
      .portrait-inner > div {
        width: 100%;
        height: 100%;
        border-radius: 50%;
        padding: 7px;
        background: #ffffff;
      }
      .photo {
        width: 100%;
        height: 100%;
        border-radius: 50%;
        background-color: #072c49;
        background-repeat: no-repeat;
        background-image: ${photoDataUri ? `url("${photoDataUri}")` : "none"};
        background-size: ${zoom}%;
        background-position: ${focusX}% ${focusY}%;
        ${interactive ? "cursor: grab; touch-action: none;" : ""}
      }

      /* ---------- identidad ---------- */
      .name {
        position: relative;
        margin-top: 30px;
        padding: 0 90px;
        text-align: center;
        font-family: "Segoe UI Black", "Arial Black", "Segoe UI", sans-serif;
        font-weight: 900;
        font-size: ${nameFontSize(nombre)}px;
        line-height: 1.02;
        letter-spacing: -0.025em;
        text-transform: uppercase;
        text-shadow: 0 8px 22px rgba(3, 20, 34, 0.5);
      }
      .name-underline {
        position: relative;
        margin: 18px auto 0;
        width: 190px;
        height: 5px;
        border-radius: 999px;
        background: linear-gradient(90deg, rgba(231, 201, 121, 0), var(--gold), rgba(231, 201, 121, 0));
      }
      .chips {
        position: relative;
        margin-top: 26px;
        display: flex;
        gap: 14px;
        justify-content: center;
        flex-wrap: wrap;
        padding: 0 70px;
      }
      .chip {
        padding: 12px 28px;
        border-radius: 999px;
        border: 2px solid rgba(255, 255, 255, 0.55);
        font-size: 25px;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }
      .chip-gold {
        background: var(--gold);
        border-color: var(--gold);
        color: #06253f;
        font-weight: 900;
      }

      /* ---------- banda inferior ---------- */
      footer {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        padding: 30px 96px 40px;
        background: linear-gradient(180deg, rgba(4, 24, 41, 0) 0%, rgba(4, 24, 41, 0.82) 38%, rgba(4, 24, 41, 0.95) 100%);
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 10px;
        text-align: center;
      }
      .race-name {
        font-size: 34px;
        font-weight: 800;
        letter-spacing: 0.02em;
        color: #ffffff;
      }
      .race-date {
        font-size: 24px;
        font-weight: 700;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        color: var(--gold);
      }
    </style>
  </head>
  <body>
    <div class="bg"></div>
    <div class="glow"></div>
    <div class="streaks"></div>
    <div class="greca greca-l"></div>
    <div class="greca greca-r"></div>
    <div class="vignette"></div>

    <header>
      ${raceLogoDataUri ? `<img src="${raceLogoDataUri}" alt="" />` : "<span></span>"}
      <span class="rule"></span>
      ${clubLogoDataUri ? `<img src="${clubLogoDataUri}" alt="" />` : "<span></span>"}
    </header>

    <div class="eyebrow">Te damos la bienvenida</div>
    <h1>${escapeHtml(greeting)}</h1>

    <div class="portrait">
      <div class="portrait-inner">
        <div><div class="photo" id="photo"></div></div>
      </div>
    </div>

    <div class="name">${escapeHtml(nombre)}</div>
    <div class="name-underline"></div>
    <div class="chips">${chips}</div>

    <footer>
      ${raceName ? `<div class="race-name">${escapeHtml(raceName)}</div>` : ""}
      ${eventDateText ? `<div class="race-date">${escapeHtml(eventDateText)}</div>` : ""}
    </footer>

    ${interactive ? `<script>
      (function () {
        var photo = document.getElementById("photo");
        var state = { zoom: ${zoom}, focusX: ${focusX}, focusY: ${focusY} };
        var drag = null;
        var send = function () {
          photo.style.backgroundSize = state.zoom + "%";
          photo.style.backgroundPosition = state.focusX + "% " + state.focusY + "%";
          parent.postMessage({ type: "welcome-frame", zoom: state.zoom, focusX: state.focusX, focusY: state.focusY }, "*");
        };
        var clamp = function (v) { return Math.min(100, Math.max(0, v)); };
        photo.addEventListener("pointerdown", function (e) {
          drag = { x: e.clientX, y: e.clientY, fx: state.focusX, fy: state.focusY };
          photo.setPointerCapture(e.pointerId);
        });
        photo.addEventListener("pointermove", function (e) {
          if (!drag) return;
          state.focusX = clamp(drag.fx - (e.clientX - drag.x) / 4);
          state.focusY = clamp(drag.fy - (e.clientY - drag.y) / 4);
          send();
        });
        photo.addEventListener("pointerup", function () { drag = null; });
        window.addEventListener("message", function (e) {
          if (!e.data) return;
          if (e.data.type === "welcome-zoom") {
            state.zoom = e.data.zoom;
            send();
          } else if (e.data.type === "welcome-reset") {
            state.zoom = e.data.zoom;
            state.focusX = e.data.focusX;
            state.focusY = e.data.focusY;
            send();
          } else if (e.data.type === "welcome-procedencia") {
            var chip = document.getElementById("chip-procedencia");
            if (chip) chip.style.display = e.data.show ? "" : "none";
          }
        });
      })();
    <\/script>` : ""}
  </body>
</html>`;
}

module.exports = {
  WELCOME_CARD_WIDTH,
  WELCOME_CARD_HEIGHT,
  buildWelcomeHtmlDocument,
};
