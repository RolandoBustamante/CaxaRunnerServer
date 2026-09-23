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

// "de", "del", "la"... van pegados al apellido que siguen, si no "de la Cruz" se parte mal.
const NAME_PARTICLES = new Set(["de", "del", "la", "las", "los", "da", "di", "dos", "y"]);

function nameTokens(name) {
  const tokens = [];
  let pending = "";
  for (const word of String(name || "").trim().split(/\s+/).filter(Boolean)) {
    if (NAME_PARTICLES.has(word.toLowerCase())) {
      pending = pending ? `${pending} ${word}` : word;
      continue;
    }
    tokens.push(pending ? `${pending} ${word}` : word);
    pending = "";
  }
  if (pending) tokens.push(pending);
  return tokens;
}

/**
 * Primer nombre + primer apellido, para que quepa en una sola linea.
 * Convencion peruana: nombres + apellido paterno + apellido materno.
 * 3 piezas = 1 nombre + 2 apellidos; 4 o mas = 2 nombres + 2 apellidos.
 */
function shortName(name) {
  const tokens = nameTokens(name);
  if (tokens.length <= 2) return tokens.join(" ");
  if (tokens.length === 3) return `${tokens[0]} ${tokens[1]}`;
  return `${tokens[0]} ${tokens[2]}`;
}

// Una sola linea: el tamano se calcula para que el texto no se salga de los 900px utiles.
// Factor 0.70em por caracter, medido sobre Arial Black en mayusculas.
function nameFontSize(name) {
  const length = Math.max(1, String(name || "").trim().length);
  return Math.round(Math.min(96, Math.max(30, 900 / (length * 0.7))));
}

function greetingFor(genero) {
  return String(genero || "").trim().toUpperCase().startsWith("F")
    ? "¡BIENVENIDA!"
    : "¡BIENVENIDO!";
}

// Greca escalonada andina, en SVG porque un patron CSS no sobrevive al render.
function grecaDataUri(color = "%23ffe3ac") {
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
  backgroundDataUri,
  scriptFontDataUri,
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

  const nombre = shortName(participant?.nombre);
  const distancia = String(participant?.distancia || "").trim();
  const procedencia = String(participant?.procedencia || participant?.club || "").trim();
  const greeting = greetingFor(participant?.genero);
  const raceName = String(race?.name || "").trim();

  const chips = [
    distancia ? `<span class="chip chip-gold">${escapeHtml(distancia)}</span>` : "",
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
        /* Muestreados de la panoramica: el neon de la cruz y el alumbrado de la ciudad. */
        --neon: #57a9f5;
        --neon-deep: #1d5c9e;
        --gold: #f0be72;
        --gold-soft: #ffe3ac;
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
      .vignette { position: absolute; inset: 0; }
      .bg {
        background: linear-gradient(158deg, #06253f 0%, #0b3f5f 38%, #106a83 72%, #1594a4 100%);
      }
      /* Panoramica de Santa Apolonia. Si falta el archivo queda el degradado de abajo. */
      .photo-bg {
        position: absolute;
        inset: 0;
        background-image: ${backgroundDataUri ? `url("${backgroundDataUri}")` : "none"};
        background-size: cover;
        background-position: 40% 50%;
        filter: saturate(0.88) contrast(1.05);
      }
      /* Oscurecer arriba y abajo: sin esto el nombre y la fecha no se leen sobre la ciudad. */
      .photo-bg::after {
        content: "";
        position: absolute;
        inset: 0;
        background:
          linear-gradient(180deg, rgba(5, 24, 44, 0.88) 0%, rgba(6, 34, 54, 0.8) 18%, rgba(4, 30, 47, 0.42) 34%, rgba(3, 30, 48, 0.5) 62%, rgba(5, 28, 43, 0.93) 82%, #061c30 100%),
          linear-gradient(90deg, rgba(3, 28, 49, 0.35), transparent 48%, rgba(4, 30, 48, 0.24));
      }
      .glow {
        background: radial-gradient(52% 34% at 50% 40%, rgba(87, 169, 245, ${backgroundDataUri ? "0.18" : "0.42"}) 0%, rgba(87, 169, 245, 0.09) 45%, rgba(6, 37, 63, 0) 72%);
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
        padding: 32px 72px 0;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 32px;
      }
      header img { max-height: 140px; max-width: 380px; object-fit: contain; }
      header .rule { flex: 1; height: 2px; background: linear-gradient(90deg, rgba(231, 201, 121, 0), rgba(231, 201, 121, 0.75), rgba(231, 201, 121, 0)); }

      h1 {
        position: relative;
        margin-top: 16px;
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
        margin-top: 16px;
        width: 536px;
        height: 536px;
        border-radius: 50%;
        display: grid;
        place-items: center;
        background: conic-gradient(from 212deg, var(--neon) 0%, var(--neon-deep) 21%, var(--gold-soft) 46%, var(--gold) 59%, var(--neon-deep) 79%, var(--neon) 100%);
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
        background: linear-gradient(140deg, var(--gold-soft), var(--gold) 45%, #b8862f 100%);
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
        margin-top: 22px;
        padding: 0 90px;
        text-align: center;
        font-family: "Segoe UI Black", "Arial Black", "Segoe UI", sans-serif;
        font-weight: 900;
        font-size: ${nameFontSize(nombre)}px;
        line-height: 1.02;
        white-space: nowrap;
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
        background: linear-gradient(90deg, rgba(240, 190, 114, 0), var(--gold), rgba(240, 190, 114, 0));
      }
      .chips {
        position: relative;
        margin-top: 16px;
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

      /* Allura va incrustada: Playwright renderiza sin red y una cursiva del sistema arruina el sello. */
      ${scriptFontDataUri ? `@font-face {
        font-family: "Allura";
        font-style: normal;
        font-weight: 400;
        src: url("${scriptFontDataUri}") format("woff2");
      }` : ""}
      /* Una sola linea centrada: la frase es larga y no entra en la columna lateral sin pisar el retrato. */
      .slogan {
        position: relative;
        transform: rotate(-2deg);
        text-align: center;
        filter: drop-shadow(0 4px 7px rgba(5, 29, 48, 0.66));
      }
      .slogan span {
        display: block;
        font-family: "Allura", "Segoe Script", cursive;
        font-size: 46px;
        line-height: 1.02;
        font-weight: 400;
        letter-spacing: 0.015em;
        white-space: nowrap;
        color: #ffffff;
        text-shadow: 0 0 15px rgba(255, 255, 255, 0.3);
      }
      .slogan::after {
        content: "";
        display: block;
        width: 240px;
        height: 4px;
        margin: 9px auto 0;
        border-radius: 100%;
        background: linear-gradient(90deg, transparent, #ffdc8c 35%, #efd28b 70%, transparent);
        box-shadow: 0 0 13px rgba(255, 218, 135, 0.32);
      }

      /* ---------- banda inferior ---------- */
      footer {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        padding: 22px 60px 36px;
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
    <div class="photo-bg"></div>
    <div class="glow"></div>
    <div class="greca greca-l"></div>
    <div class="greca greca-r"></div>
    <div class="vignette"></div>

    <header>
      ${raceLogoDataUri ? `<img src="${raceLogoDataUri}" alt="" />` : "<span></span>"}
      <span class="rule"></span>
      ${clubLogoDataUri ? `<img src="${clubLogoDataUri}" alt="" />` : "<span></span>"}
    </header>

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
      <div class="slogan"><span>¡Juntos corremos,</span><span>juntos hacemos historia!</span></div>
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
          } else if (e.data.type === "welcome-nudge") {
            // Mover la foto: mismo signo que arrastrar (derecha = la foto va a la derecha).
            state.focusX = clamp(state.focusX - e.data.dx);
            state.focusY = clamp(state.focusY - e.data.dy);
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
  shortName,
};
