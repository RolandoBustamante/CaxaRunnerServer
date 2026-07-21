require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const { PrismaClient } = require("./generated/prisma");
const requireAuth = require("./middleware/auth");
const authRouter = require("./routes/auth");

const prisma = new PrismaClient();
const app = express();

const DEFAULT_RACE_SLUG = "carrera-actual";
const DEFAULT_CATEGORIES = [
  { name: "Sub-18", minAge: 0, maxAge: 17, distance: null, gender: null },
  { name: "Open", minAge: 18, maxAge: 39, distance: null, gender: null },
  { name: "Master A", minAge: 40, maxAge: 49, distance: null, gender: null },
  { name: "Master B", minAge: 50, maxAge: 59, distance: null, gender: null },
  { name: "Master C", minAge: 60, maxAge: null, distance: null, gender: null },
];
const NO_TIME_REASON = "__NO_TIME__";
const CERTIFICATE_TEMPLATES = new Set(["classic", "trail"]);
const DEFAULT_CERTIFICATE_TEMPLATE = "classic";
let cachedLogoDataUri = null;
let cachedWatermarkDataUri = null;
let cachedTrailLogoDataUri = null;
let cachedTrailCajamarcaLogoDataUri = null;

function normalizeCertificateTemplate(value) {
  const template = String(value || DEFAULT_CERTIFICATE_TEMPLATE).trim().toLowerCase();
  return CERTIFICATE_TEMPLATES.has(template) ? template : DEFAULT_CERTIFICATE_TEMPLATE;
}

app.use(cors());
app.use(express.json());

app.use("/api/auth", authRouter);

function slugify(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function normalizeDistances(value) {
  if (!Array.isArray(value)) return null;
  const distances = [
    ...new Set(
      value
        .map((distance) => String(distance || "").trim().toUpperCase())
        .filter(Boolean)
    ),
  ];
  return distances.length > 0 ? distances : null;
}

async function ensureDefaultRace() {
  return prisma.race.upsert({
    where: { slug: DEFAULT_RACE_SLUG },
    update: {},
    create: {
      slug: DEFAULT_RACE_SLUG,
      name: "Carrera actual",
      status: "DRAFT",
    },
  });
}

async function resolveRaceBySlug(slug) {
  if (!slug || !String(slug).trim()) {
    const error = new Error("slug requerido");
    error.statusCode = 400;
    throw error;
  }

  const race = await prisma.race.findUnique({
    where: { slug: String(slug).trim() },
  });

  if (!race) {
    const error = new Error("Carrera no encontrada");
    error.statusCode = 404;
    throw error;
  }

  return race;
}

async function resolveRace(req, { allowBody = true } = {}) {
  const bodyRaceId = allowBody ? req.body?.raceId : undefined;
  const rawRaceId = req.params?.raceId ?? req.query?.raceId ?? bodyRaceId;

  if (rawRaceId != null && rawRaceId !== "") {
    const raceId = parseInt(rawRaceId, 10);
    if (Number.isNaN(raceId)) {
      const error = new Error("raceId invalido");
      error.statusCode = 400;
      throw error;
    }

    const race = await prisma.race.findUnique({ where: { id: raceId } });
    if (!race) {
      const error = new Error("Carrera no encontrada");
      error.statusCode = 404;
      throw error;
    }
    if (req.user && req.user.role !== "MASTER") {
      const assignment = await prisma.raceUser.findUnique({
        where: {
          userId_raceId: {
            userId: req.user.id,
            raceId: race.id,
          },
        },
      });
      if (!assignment) {
        const error = new Error("Sin acceso a esta carrera");
        error.statusCode = 403;
        throw error;
      }
    }

    return race;
  }

  const race = await ensureDefaultRace();
  if (req.user && req.user.role !== "MASTER") {
    const assignment = await prisma.raceUser.findUnique({
      where: {
        userId_raceId: {
          userId: req.user.id,
          raceId: race.id,
        },
      },
    });
    if (!assignment) {
      const error = new Error("Sin carreras asignadas");
      error.statusCode = 403;
      throw error;
    }
  }
  return race;
}

async function getRaceCategories(race) {
  if (race?.categories) return race.categories;
  const row = await prisma.config.findUnique({ where: { key: "categories" } });
  return row ? JSON.parse(row.value) : DEFAULT_CATEGORIES;
}

function serializeRace(race) {
  return {
    id: race.id,
    slug: race.slug,
    name: race.name,
    eventDate: race.eventDate,
    publicNotice: race.publicNotice ?? null,
    certificatesEnabled: race.certificatesEnabled,
    showDorsalPublic: race.showDorsalPublic,
    certificateTemplate: normalizeCertificateTemplate(race.certificateTemplate),
    status: race.status,
    isOfficial: race.isOfficial,
    raceStarted: race.started,
    raceClosed: race.closed,
    raceStartTime: race.startTime ? Number(race.startTime) : null,
    raceEndTime: race.endTime ? Number(race.endTime) : null,
    categories: race.categories ?? null,
    distances: race.distances ?? null,
  };
}

function serializeFinisher(finisher) {
  const noTime = finisher.disqualified && finisher.dqReason === NO_TIME_REASON;
  return {
    id: finisher.id,
    dorsal: finisher.dorsal,
    position: finisher.position,
    timestamp: Number(finisher.timestamp),
    elapsedMs: Number(finisher.elapsedMs) / 1000,
    disqualified: finisher.disqualified && !noTime,
    dqReason: noTime ? null : finisher.dqReason ?? null,
    noTime,
    noTimeReason: noTime ? "Sin tiempo" : null,
    raceId: finisher.raceId,
    isTestData: finisher.isTestData,
  };
}

function advanceCompetitionRank(state, sourcePosition) {
  const next = state || { seen: 0, lastSourcePosition: null, currentRank: 0 };
  next.seen += 1;

  if (next.lastSourcePosition !== sourcePosition) {
    next.currentRank = next.seen;
    next.lastSourcePosition = sourcePosition;
  }

  return {
    state: next,
    rank: next.currentRank,
  };
}

function isNoTimeFinisher(finisher) {
  return Boolean(finisher?.disqualified && finisher?.dqReason === NO_TIME_REASON);
}

function visibleResultsWhere(raceId) {
  return {
    raceId,
    OR: [
      { dqReason: null },
      { dqReason: { not: NO_TIME_REASON } },
    ],
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDateEs(date) {
  if (!date) return "";
  const normalized = normalizeCalendarDate(date);
  return normalized.toLocaleDateString("es-PE", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

function normalizeCalendarDate(value) {
  if (!value) return null;
  const source = value instanceof Date ? value.toISOString() : String(value);
  const match = source.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return new Date(value);
  const [, year, month, day] = match;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 12, 0, 0));
}

function parseEventDate(value) {
  if (!value) return null;
  return normalizeCalendarDate(value);
}

function formatCertificateTime(elapsedMs) {
  if (elapsedMs == null || Number.isNaN(elapsedMs)) return "--:--:--.--";
  const totalCentis = Math.floor(Number(elapsedMs) / 10);
  const hours = Math.floor(totalCentis / 360000);
  const minutes = Math.floor((totalCentis % 360000) / 6000);
  const secs = Math.floor((totalCentis % 6000) / 100);
  const centis = totalCentis % 100;

  const hh = String(hours).padStart(2, "0");
  const mm = String(minutes).padStart(2, "0");
  const ss = String(secs).padStart(2, "0");
  const cc = String(centis).padStart(2, "0");

  return `${hh}:${mm}:${ss}.${cc}`;
}

function getCertificateFileName(certificate) {
  const safeName = String(certificate.name || "finisher")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return `certificado-${safeName || "finisher"}-${String(certificate.dorsal || "").toLowerCase()}.pdf`;
}

function getCertificateImageFileName(certificate) {
  const safeName = String(certificate.name || "finisher")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return `certificado-${safeName || "finisher"}-${String(certificate.dorsal || "").toLowerCase()}.png`;
}

function fileToDataUri(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = ext === ".svg"
    ? "image/svg+xml"
    : ext === ".png"
      ? "image/png"
      : ext === ".jpg" || ext === ".jpeg"
        ? "image/jpeg"
        : "application/octet-stream";
  const fileBuffer = fs.readFileSync(filePath);
  return `data:${mimeType};base64,${fileBuffer.toString("base64")}`;
}

function resolveExistingAsset(candidates, errorMessage) {
  const assetPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!assetPath) {
    const error = new Error(errorMessage);
    error.statusCode = 500;
    throw error;
  }
  return assetPath;
}

function getLogoDataUri() {
  if (cachedLogoDataUri) return cachedLogoDataUri;

  const logoPath = resolveExistingAsset([
    process.env.CERTIFICATE_LOGO_PATH,
    path.join(__dirname, "assets", "crlogo-horizontal.svg"),
    path.join(__dirname, "..", "client", "public", "crlogo-horizontal.svg"),
  ].filter(Boolean), "No se encontro el logo del certificado");

  cachedLogoDataUri = fileToDataUri(logoPath);
  return cachedLogoDataUri;
}

function getWatermarkDataUri() {
  if (cachedWatermarkDataUri) return cachedWatermarkDataUri;

  const watermarkPath = resolveExistingAsset([
    path.join(__dirname, "assets", "Cajamarcar Runners Logo sin fondo-01.png"),
    path.join(__dirname, "..", "client", "public", "Cajamarcar Runners Logo sin fondo-01.png"),
    process.env.CERTIFICATE_WATERMARK_PATH,
    process.env.CERTIFICATE_LOGO_PATH,
    path.join(__dirname, "assets", "crlogo-horizontal.svg"),
    path.join(__dirname, "..", "client", "public", "crlogo-horizontal.svg"),
  ].filter(Boolean), "No se encontro la marca de agua del certificado");

  cachedWatermarkDataUri = fileToDataUri(watermarkPath);
  return cachedWatermarkDataUri;
}

function getTrailLogoDataUri() {
  if (cachedTrailLogoDataUri) return cachedTrailLogoDataUri;

  const logoPath = resolveExistingAsset([
    process.env.CERTIFICATE_TRAIL_LOGO_PATH,
    path.join(__dirname, "assets", "granja-porcon-trail-logo.png"),
  ].filter(Boolean), "No se encontro el logo trail del certificado");

  cachedTrailLogoDataUri = fileToDataUri(logoPath);
  return cachedTrailLogoDataUri;
}

function getTrailCajamarcaLogoDataUri() {
  if (cachedTrailCajamarcaLogoDataUri) return cachedTrailCajamarcaLogoDataUri;

  const logoPath = resolveExistingAsset([
    process.env.CERTIFICATE_TRAIL_CAJAMARCA_LOGO_PATH,
    path.join(__dirname, "assets", "cajamarca-runners-white-logo.png"),
  ].filter(Boolean), "No se encontro el logo Cajamarca Runners trail");

  cachedTrailCajamarcaLogoDataUri = fileToDataUri(logoPath);
  return cachedTrailCajamarcaLogoDataUri;
}

function buildTrailCertificateHtmlDocument(race, certificate) {
  const eventDate = formatDateEs(race?.eventDate);
  const trailLogoDataUri = getTrailLogoDataUri();
  const crLogoDataUri = getTrailCajamarcaLogoDataUri();
  const isNoTimeCertificate = Boolean(certificate?.noTime);
  const officialTime = formatCertificateTime(certificate.timeMs);
  const subtitle = isNoTimeCertificate
    ? "El comité organizador certifica una llegada validada sin tiempo oficial."
    : "El comité organizador certifica que el corredor(a) concluyó oficialmente la prueba.";
  const summary = isNoTimeCertificate
    ? `Se certifica la llegada validada a la distancia de <strong>${escapeHtml(certificate.distance)}</strong>, con registro confirmado <strong>sin tiempo oficial</strong>.`
    : `Concluyó oficialmente la distancia de <strong>${escapeHtml(certificate.distance)}</strong>, ocupando el puesto <strong>${escapeHtml(certificate.position)}</strong> en la clasificación general de su distancia, con un tiempo oficial de <strong>${escapeHtml(officialTime)}</strong>.`;
  const timeLabel = isNoTimeCertificate ? "Estado" : "Tiempo oficial";
  const timeValue = isNoTimeCertificate ? "ST" : officialTime;

  return `<!doctype html>
  <html lang="es">
    <head>
      <meta charset="utf-8" />
      <title>Certificado ${escapeHtml(certificate.name)}</title>
      <style>
        * { box-sizing: border-box; }
        html, body {
          margin: 0;
          width: 100%;
          height: 100%;
          font-family: Arial, Helvetica, sans-serif;
          background: #ffffff;
        }
        body {
          display: flex;
          align-items: stretch;
          justify-content: stretch;
        }
        .page {
          width: 1120px;
          height: 760px;
          margin: 0 auto;
          position: relative;
          overflow: hidden;
          color: #f7fff4;
          background:
            radial-gradient(circle at 18% 10%, rgba(188, 216, 82, 0.3), transparent 26%),
            linear-gradient(180deg, #014353 0%, #00615b 44%, #3d7a28 72%, #c57a00 100%);
        }
        .map-lines {
          position: absolute;
          inset: 0;
          opacity: 0.16;
          background-image:
            repeating-radial-gradient(ellipse at 30% 30%, transparent 0 16px, rgba(255,255,255,0.45) 17px 18px),
            repeating-radial-gradient(ellipse at 70% 65%, transparent 0 22px, rgba(255,255,255,0.24) 23px 24px);
          mix-blend-mode: screen;
        }
        .trail-watermark {
          position: absolute;
          left: 50%;
          top: 51%;
          width: 420px;
          max-width: 42%;
          height: auto;
          transform: translate(-50%, -50%);
          opacity: 0.08;
          filter: drop-shadow(0 20px 28px rgba(0,0,0,0.18));
          z-index: 1;
          pointer-events: none;
        }
        .pines {
          position: absolute;
          left: 0;
          right: 0;
          bottom: 0;
          height: 178px;
          background:
            linear-gradient(135deg, transparent 0 36%, rgba(0, 54, 45, 0.86) 36% 46%, transparent 46%) 0 44px / 86px 122px repeat-x,
            linear-gradient(45deg, transparent 0 36%, rgba(0, 42, 36, 0.72) 36% 46%, transparent 46%) 34px 64px / 96px 114px repeat-x,
            linear-gradient(180deg, rgba(0, 48, 39, 0) 0%, rgba(0, 39, 33, 0.78) 62%, rgba(0, 33, 29, 0.95) 100%);
        }
        .ridge {
          position: absolute;
          left: -80px;
          right: -80px;
          bottom: 130px;
          height: 128px;
          background: linear-gradient(135deg, transparent 0 48%, rgba(10, 70, 54, 0.55) 49%, rgba(10, 70, 54, 0.55) 56%, transparent 57%);
          opacity: 0.65;
        }
        .content {
          position: relative;
          z-index: 2;
          min-height: 760px;
          padding: 34px 54px 28px;
          display: flex;
          flex-direction: column;
        }
        .header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 28px;
        }
        .cr-logo {
          position: absolute;
          right: 82px;
          top: 70px;
          width: 124px;
          height: auto;
          opacity: 0.94;
          filter: drop-shadow(0 8px 14px rgba(0,0,0,0.26));
          z-index: 3;
        }
        .event-pill {
          display: inline-block;
          max-width: 620px;
          padding: 10px 15px;
          border: 1px solid rgba(255,255,255,0.28);
          background: rgba(0, 40, 36, 0.28);
          border-radius: 999px;
          color: rgba(255,255,255,0.92);
          font-size: 13px;
          font-weight: 800;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }
        .title {
          margin: 46px 0 0;
          text-align: center;
          font-size: 58px;
          line-height: 1;
          font-weight: 1000;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          text-shadow: 0 8px 20px rgba(0,0,0,0.28);
        }
        .subtitle {
          max-width: 760px;
          margin: 16px auto 0;
          text-align: center;
          color: rgba(255,255,255,0.88);
          font-family: Georgia, "Times New Roman", serif;
          font-size: 21px;
          line-height: 1.45;
          font-weight: 500;
        }
        .name {
          margin: 30px auto 16px;
          max-width: 920px;
          text-align: center;
          color: #ffffff;
          font-family: Georgia, "Times New Roman", serif;
          font-size: 50px;
          line-height: 1.08;
          font-weight: 700;
          text-transform: none;
        }
        .summary {
          max-width: 830px;
          margin: 0 auto;
          text-align: center;
          color: rgba(255,255,255,0.92);
          font-family: Georgia, "Times New Roman", serif;
          font-size: 22px;
          line-height: 1.62;
          font-weight: 500;
        }
        .summary strong {
          color: #ffd36a;
          font-weight: 1000;
        }
        .metrics {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 18px;
          margin: 28px auto 0;
          width: 860px;
        }
        .metric {
          min-height: 94px;
          border-radius: 7px;
          padding: 18px 14px;
          text-align: center;
          background: rgba(0, 36, 32, 0.36);
          border: 1px solid rgba(255,255,255,0.2);
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.14);
        }
        .metric-value {
          color: #ffffff;
          font-size: 34px;
          line-height: 1;
          font-weight: 1000;
          white-space: nowrap;
        }
        .metric-label {
          margin-top: 12px;
          color: #cfe7c7;
          font-size: 12px;
          font-weight: 900;
          letter-spacing: 0.12em;
          text-transform: uppercase;
        }
        .secondary-meta {
          margin: 16px auto 0;
          display: flex;
          justify-content: center;
          gap: 18px;
          color: rgba(255,255,255,0.86);
          font-size: 14px;
          font-weight: 700;
        }
        .secondary-meta strong {
          color: #ffd36a;
        }
        .footer {
          margin-top: auto;
          display: flex;
          justify-content: space-between;
          align-items: end;
          gap: 20px;
          color: rgba(255,255,255,0.82);
          font-size: 14px;
          font-weight: 700;
        }
        .footer strong {
          color: #ffffff;
        }
        @page {
          size: A4 landscape;
          margin: 0;
        }
      </style>
    </head>
    <body>
      <div class="page">
        <div class="map-lines"></div>
        <img class="trail-watermark" src="${trailLogoDataUri}" alt="" />
        <div class="ridge"></div>
        <div class="pines"></div>
        <div class="content">
          <div class="header">
            <div>
              <div class="event-pill">${escapeHtml(race.name || "Resultado oficial")}</div>
            </div>
            <img class="cr-logo" src="${crLogoDataUri}" alt="Cajamarca Runners" />
          </div>

          <h1 class="title">CERTIFICADO</h1>
          <p class="subtitle">${subtitle}</p>
          <div class="name">${escapeHtml(certificate.name)}</div>
          <div class="summary">${summary}</div>

          <div class="metrics">
            <div class="metric">
              <div class="metric-value">${escapeHtml(timeValue)}</div>
              <div class="metric-label">${timeLabel}</div>
            </div>
            <div class="metric">
              <div class="metric-value">${escapeHtml(certificate.position ?? "-")}</div>
              <div class="metric-label">Puesto por distancia</div>
            </div>
            <div class="metric">
              <div class="metric-value">${escapeHtml(certificate.dorsal)}</div>
              <div class="metric-label">Dorsal</div>
            </div>
          </div>

          <div class="secondary-meta">
            <span><strong>Categoría:</strong> ${escapeHtml(certificate.categoryName ?? "-")}</span>
            <span><strong>Puesto en categoría:</strong> ${escapeHtml(certificate.categoryPosition ?? "-")}</span>
            <span><strong>Distancia:</strong> ${escapeHtml(certificate.distance ?? "-")}</span>
          </div>

          <div class="footer">
            <div><strong>Fecha del evento:</strong> ${escapeHtml(eventDate || "-")}</div>
            <div><strong>Código:</strong> ${escapeHtml(certificate.certificateCode || "-")}</div>
          </div>
        </div>
      </div>
    </body>
  </html>`;
}

function buildCertificateHtmlDocument(race, certificate) {
  if (normalizeCertificateTemplate(race?.certificateTemplate) === "trail") {
    return buildTrailCertificateHtmlDocument(race, certificate);
  }

  const eventDate = formatDateEs(race?.eventDate);
  const logoDataUri = getLogoDataUri();
  const watermarkDataUri = getWatermarkDataUri();
  const isNoTimeCertificate = Boolean(certificate?.noTime);
  const subtitle = isNoTimeCertificate
    ? "El comité organizador certifica una llegada validada sin tiempo oficial."
    : "El comité organizador certifica que el corredor(a) concluyó oficialmente la prueba.";
  const summary = isNoTimeCertificate
    ? `Se certifica la llegada validada a la distancia de <strong>${escapeHtml(certificate.distance)}</strong>, con registro confirmado <strong>sin tiempo oficial</strong>.`
    : `Concluyó oficialmente la distancia de <strong>${escapeHtml(certificate.distance)}</strong>,
            ocupando el puesto <strong>${escapeHtml(certificate.position)}</strong> en la clasificación general de su distancia,
            con un tiempo oficial de <strong>${escapeHtml(formatCertificateTime(certificate.timeMs))}</strong>.`;
  const metrics = isNoTimeCertificate
    ? `
          <div class="metrics">
            <div class="metric">
              <div class="metric-value">${escapeHtml(certificate.distance)}</div>
              <div class="metric-label">Distancia</div>
            </div>
            <div class="metric">
              <div class="metric-value">ST</div>
              <div class="metric-label">Estado</div>
            </div>
            <div class="metric">
              <div class="metric-value">${escapeHtml(certificate.dorsal)}</div>
              <div class="metric-label">Dorsal</div>
            </div>
          </div>`
    : `
          <div class="metrics">
            <div class="metric">
              <div class="metric-value">${escapeHtml(formatCertificateTime(certificate.timeMs))}</div>
              <div class="metric-label">Tiempo oficial</div>
            </div>
            <div class="metric">
              <div class="metric-value">${escapeHtml(certificate.position)}</div>
              <div class="metric-label">Puesto general por distancia</div>
            </div>
            <div class="metric">
              <div class="metric-value">${escapeHtml(certificate.dorsal)}</div>
              <div class="metric-label">Dorsal</div>
            </div>
          </div>`;
  const secondaryMeta = isNoTimeCertificate
    ? `
          <div class="secondary-meta">
            <span><strong>Estado:</strong> Sin tiempo oficial</span>
            <span><strong>Registro:</strong> Llegada validada</span>
          </div>`
    : `
          <div class="secondary-meta">
            <span><strong>Puesto por género:</strong> ${escapeHtml(certificate.genderPosition ?? "-")}</span>
            <span><strong>Categoría:</strong> ${escapeHtml(certificate.categoryName ?? "-")}</span>
            <span><strong>Puesto en categoría:</strong> ${escapeHtml(certificate.categoryPosition ?? "-")}</span>
          </div>`;

  return `<!doctype html>
  <html lang="es">
    <head>
      <meta charset="utf-8" />
      <title>Certificado ${escapeHtml(certificate.name)}</title>
      <style>
        :root {
          --blue-deep: #0a2340;
          --blue-main: #103a67;
          --white: #ffffff;
          --gold: #e7c979;
          --line: rgba(255, 255, 255, 0.24);
        }
        * { box-sizing: border-box; }
        html, body {
          margin: 0;
          width: 100%;
          height: 100%;
          font-family: Georgia, "Times New Roman", serif;
          background: #ffffff;
        }
        body {
          display: flex;
          align-items: stretch;
          justify-content: stretch;
        }
        .page {
          width: 1120px;
          min-height: 760px;
          margin: 0 auto;
          background:
            radial-gradient(circle at top left, rgba(231, 201, 121, 0.12), transparent 30%),
            radial-gradient(circle at bottom right, rgba(255, 255, 255, 0.06), transparent 26%),
            linear-gradient(135deg, var(--blue-main) 0%, var(--blue-deep) 100%);
          color: var(--white);
          border: 18px solid rgba(255, 255, 255, 0.9);
          padding: 46px 58px;
          position: relative;
          overflow: hidden;
        }
        .page:before {
          content: "";
          position: absolute;
          inset: 14px;
          border: 2px solid var(--line);
          pointer-events: none;
        }
        .page:after {
          content: "";
          position: absolute;
          right: -120px;
          top: 120px;
          width: 420px;
          height: 420px;
          border-radius: 50%;
          background: radial-gradient(circle, rgba(255, 255, 255, 0.08), transparent 65%);
        }
        .watermark {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          pointer-events: none;
          z-index: 1;
        }
        .watermark img {
          width: 58%;
          max-width: 640px;
          height: auto;
          opacity: 0.08;
          filter: none;
          transform: none;
        }
        .content {
          position: relative;
          z-index: 2;
        }
        .header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 24px;
        }
        .logo {
          display: block;
          height: 54px;
          width: auto;
          filter: brightness(0) invert(1);
        }
        .tag {
          display: inline-block;
          margin-top: 14px;
          background: rgba(255, 255, 255, 0.12);
          color: var(--white);
          padding: 11px 16px;
          border-radius: 999px;
          font: 700 14px/1 Arial, sans-serif;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }
        .seal {
          text-align: right;
        }
        .seal-title {
          color: var(--gold);
          font: 800 14px/1 Arial, sans-serif;
          letter-spacing: 0.12em;
          text-transform: uppercase;
        }
        .seal-sub {
          margin-top: 8px;
          color: rgba(255, 255, 255, 0.75);
          font: 500 13px/1 Arial, sans-serif;
        }
        .title {
          margin: 48px 0 8px;
          text-align: center;
          font-size: 52px;
          letter-spacing: 0.12em;
          color: var(--white);
        }
        .subtitle {
          margin: 0;
          text-align: center;
          color: rgba(255, 255, 255, 0.82);
          font: 500 18px/1.7 Arial, sans-serif;
        }
        .name {
          margin: 42px 0 18px;
          text-align: center;
          font-size: 46px;
          font-weight: 700;
          color: var(--white);
          text-transform: uppercase;
        }
        .summary {
          max-width: 900px;
          margin: 0 auto;
          text-align: center;
          color: rgba(255, 255, 255, 0.92);
          font: 500 21px/1.75 Arial, sans-serif;
        }
        .summary strong {
          color: var(--gold);
        }
        .metrics {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 18px;
          margin-top: 46px;
        }
        .metric {
          background: rgba(255, 255, 255, 0.08);
          border: 1px solid rgba(255, 255, 255, 0.14);
          border-radius: 22px;
          padding: 16px 14px 14px;
          text-align: center;
        }
        .metric-value {
          color: var(--white);
          font: 800 36px/1 Arial, sans-serif;
          white-space: nowrap;
          letter-spacing: 0.02em;
        }
        .metric:first-child .metric-value {
          font-size: 32px;
        }
        .metric-label {
          margin-top: 8px;
          color: rgba(255, 255, 255, 0.82);
          font: 800 12px/1 Arial, sans-serif;
          letter-spacing: 0.1em;
          text-transform: uppercase;
        }
        .secondary-meta {
          margin-top: 20px;
          display: flex;
          justify-content: center;
          gap: 24px;
          flex-wrap: wrap;
          color: rgba(255, 255, 255, 0.82);
          font: 500 15px/1.6 Arial, sans-serif;
        }
        .secondary-meta strong {
          color: var(--gold);
          font-weight: 800;
        }
        .footer {
          margin-top: 58px;
          display: flex;
          justify-content: space-between;
          align-items: end;
          gap: 20px;
          color: rgba(255, 255, 255, 0.78);
          font: 500 16px/1.6 Arial, sans-serif;
        }
        .footer strong {
          color: var(--white);
        }
        @page {
          size: A4 landscape;
          margin: 0;
        }
      </style>
    </head>
    <body>
      <div class="page">
        <div class="watermark">
          <img src="${watermarkDataUri}" alt="" />
        </div>
        <div class="content">
          <div class="header">
            <div>
              <img class="logo" src="${logoDataUri}" alt="Cajamarca Runners" />
              <div class="tag">${escapeHtml(race.name || "Resultado oficial")}</div>
            </div>
            <div class="seal">
              <div class="seal-title">Certificado de Finisher</div>
              <div class="seal-sub">Comité organizador</div>
            </div>
          </div>

          <h1 class="title">CERTIFICADO</h1>
          <p class="subtitle">${subtitle}</p>
          <div class="name">${escapeHtml(certificate.name)}</div>
          <div class="summary">${summary}</div>

${metrics}

${secondaryMeta}

          <div class="footer">
            <div><strong>Fecha del evento:</strong> ${escapeHtml(eventDate || "-")}</div>
            <div><strong>Código de certificado:</strong> ${escapeHtml(certificate.certificateCode || "-")}</div>
          </div>
        </div>
      </div>
    </body>
  </html>`;
}

async function renderCertificatePdf(race, certificate) {
  let playwright;
  try {
    playwright = require("playwright");
  } catch {
    const error = new Error("Playwright no esta instalado en el servidor");
    error.statusCode = 500;
    throw error;
  }

  const launchOptions = {
    headless: true,
  };
  if (process.env.PDF_BROWSER_PATH) {
    launchOptions.executablePath = process.env.PDF_BROWSER_PATH;
  }

  let browser;
  try {
    browser = await playwright.chromium.launch(launchOptions);
    const page = await browser.newPage({
      viewport: { width: 1120, height: 760 },
      deviceScaleFactor: 1,
    });
    await page.setContent(buildCertificateHtmlDocument(race, certificate), {
      waitUntil: "load",
    });
    await page.emulateMedia({ media: "print" });
    return await page.pdf({
      format: "A4",
      landscape: true,
      printBackground: true,
      margin: {
        top: "0",
        right: "0",
        bottom: "0",
        left: "0",
      },
      preferCSSPageSize: true,
    });
  } catch (cause) {
    const error = new Error("No se pudo generar el PDF con Playwright");
    error.statusCode = 500;
    error.cause = cause;
    throw error;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

async function renderCertificateImage(race, certificate) {
  let playwright;
  try {
    playwright = require("playwright");
  } catch {
    const error = new Error("Playwright no esta instalado en el servidor");
    error.statusCode = 500;
    throw error;
  }

  const launchOptions = {
    headless: true,
  };
  if (process.env.PDF_BROWSER_PATH) {
    launchOptions.executablePath = process.env.PDF_BROWSER_PATH;
  }

  let browser;
  try {
    browser = await playwright.chromium.launch(launchOptions);
    const page = await browser.newPage({
      viewport: { width: 1120, height: 760 },
      deviceScaleFactor: 1,
    });
    await page.setContent(buildCertificateHtmlDocument(race, certificate), {
      waitUntil: "load",
    });
    return await page.screenshot({
      type: "png",
      fullPage: false,
      omitBackground: false,
    });
  } catch (cause) {
    const error = new Error("No se pudo generar la imagen del certificado");
    error.statusCode = 500;
    error.cause = cause;
    throw error;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeDorsal(value) {
  const dorsal = normalizeText(value).replace(/\.0$/, "");
  if (!dorsal) return "";
  return /^\d+$/.test(dorsal) && dorsal.length < 3 ? dorsal.padStart(3, "0") : dorsal;
}

function normalizeGender(value) {
  return normalizeText(value).toUpperCase();
}

function normalizeDistance(value) {
  return normalizeText(value).toUpperCase();
}

function normalizeCategoryRule(category) {
  return {
    ...category,
    distance: normalizeDistance(category?.distance),
    gender: normalizeGender(category?.gender),
  };
}

function getAgeCategoryName(age, distance, gender, categories = DEFAULT_CATEGORIES) {
  const parsedAge = Number.parseInt(age, 10);
  if (Number.isNaN(parsedAge)) return null;

  const normalizedDistance = normalizeDistance(distance);
  const normalizedGender = normalizeGender(gender);

  for (const category of categories.map(normalizeCategoryRule)) {
    const distanceMatches = !category.distance || category.distance === normalizedDistance;
    const genderMatches = !category.gender || category.gender === normalizedGender;
    const ageMatches = parsedAge >= category.minAge && (category.maxAge == null || parsedAge <= category.maxAge);

    if (distanceMatches && genderMatches && ageMatches) {
      return category.name;
    }
  }

  return null;
}

function getParticipantCategoryMeta(participant, categories = DEFAULT_CATEGORIES) {
  const ageCategoryName = getAgeCategoryName(
    participant?.edad,
    participant?.distancia,
    participant?.genero,
    categories
  );
  return {
    distance: normalizeDistance(participant?.distancia),
    gender: normalizeGender(participant?.genero),
    ageCategoryName,
    categoryKey: [normalizeDistance(participant?.distancia), normalizeGender(participant?.genero), ageCategoryName]
      .filter(Boolean)
      .join("::"),
  };
}

function buildCertificateContext({ finishers, participants, categories, dorsal }) {
  const participantMap = new Map(
    participants.map((participant) => [normalizeDorsal(participant.dorsal), participant])
  );
  const activeFinishers = finishers
    .filter((finisher) => !finisher.disqualified && !isNoTimeFinisher(finisher))
    .slice()
    .sort((a, b) => {
      const positionDiff = Number(a.position || 0) - Number(b.position || 0);
      if (positionDiff !== 0) return positionDiff;
      const elapsedDiff = Number(a.elapsedMs || 0) - Number(b.elapsedMs || 0);
      if (elapsedDiff !== 0) return elapsedDiff;
      return Number(a.timestamp || 0) - Number(b.timestamp || 0);
    });

  const distanceCounters = new Map();
  const genderCounters = new Map();
  const categoryCounters = new Map();
  const awardCategoryCounters = new Map();
  const standings = new Map();

  activeFinishers.forEach((finisher, index) => {
    const participant = participantMap.get(normalizeDorsal(finisher.dorsal));
    const meta = getParticipantCategoryMeta(participant, categories);
    const distanceKey = meta.distance || null;
    const genderKey = [meta.distance, meta.gender].filter(Boolean).join("::");
    const categoryKey = meta.categoryKey;
    const sourcePosition = Number(finisher.position || index + 1);
    const distanceRankResult = distanceKey
      ? advanceCompetitionRank(distanceCounters.get(distanceKey), sourcePosition)
      : null;
    const genderRankResult = genderKey
      ? advanceCompetitionRank(genderCounters.get(genderKey), sourcePosition)
      : null;
    const categoryRankResult = categoryKey
      ? advanceCompetitionRank(categoryCounters.get(categoryKey), sourcePosition)
      : null;
    const distanceOverallPosition = distanceRankResult?.rank ?? null;
    const genderPosition = genderRankResult?.rank ?? null;
    const officialCategoryPosition = categoryRankResult?.rank ?? null;
    const isAbsoluteWinner = genderPosition != null && genderPosition <= 3;
    const awardCategoryRankResult = categoryKey && !isAbsoluteWinner
      ? advanceCompetitionRank(awardCategoryCounters.get(categoryKey), sourcePosition)
      : null;
    const awardCategoryPosition = awardCategoryRankResult?.rank ?? null;

    if (distanceKey) distanceCounters.set(distanceKey, distanceRankResult.state);
    if (genderKey) genderCounters.set(genderKey, genderRankResult.state);
    if (categoryKey) categoryCounters.set(categoryKey, categoryRankResult.state);
    if (categoryKey && awardCategoryRankResult) {
      awardCategoryCounters.set(categoryKey, awardCategoryRankResult.state);
    }

    standings.set(normalizeDorsal(finisher.dorsal), {
      overallPosition: index + 1,
      distanceOverallPosition: distanceOverallPosition ?? index + 1,
      genderPosition,
      categoryPosition: awardCategoryPosition ?? officialCategoryPosition,
      officialCategoryPosition,
      categoryName: meta.ageCategoryName,
      isAbsoluteWinner,
    });
  });

  return standings.get(normalizeDorsal(dorsal)) || null;
}

async function getRacePayload(race) {
  const [participants, finishers, categories] = await Promise.all([
    prisma.participant.findMany({
      where: { raceId: race.id },
      orderBy: { nombre: "asc" },
    }),
    prisma.finisher.findMany({
      where: { raceId: race.id },
      orderBy: { position: "asc" },
    }),
    getRaceCategories(race),
  ]);

  return {
    serverNow: Date.now(),
    ...serializeRace(race),
    participants,
    finishers: finishers.map(serializeFinisher),
    categories,
  };
}

app.get("/api/public", async (req, res) => {
  try {
    const race = await resolveRace(req, { allowBody: false });
    const finishers = await prisma.finisher.findMany({
      where: visibleResultsWhere(race.id),
      orderBy: { position: "asc" },
      take: 10,
    });
    const recentFinishers = await prisma.finisher.findMany({
      where: visibleResultsWhere(race.id),
      orderBy: { position: "desc" },
      take: 10,
    });
    res.json({
      serverNow: Date.now(),
      ...serializeRace(race),
      finishersCount: await prisma.finisher.count({ where: visibleResultsWhere(race.id) }),
      topFinishers: finishers.map(serializeFinisher),
      recentFinishers: recentFinishers.map(serializeFinisher),
    });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.message || "Error" });
  }
});

app.get("/api/public/:slug", async (req, res) => {
  try {
    const race = await resolveRaceBySlug(req.params.slug);
    const topFinishers = await prisma.finisher.findMany({
      where: visibleResultsWhere(race.id),
      orderBy: { position: "asc" },
      take: 10,
    });
    const recentFinishers = await prisma.finisher.findMany({
      where: visibleResultsWhere(race.id),
      orderBy: { position: "desc" },
      take: 10,
    });

    res.json({
      serverNow: Date.now(),
      ...serializeRace(race),
      finishersCount: await prisma.finisher.count({ where: visibleResultsWhere(race.id) }),
      topFinishers: topFinishers.map(serializeFinisher),
      recentFinishers: recentFinishers.map(serializeFinisher),
    });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.message || "Error" });
  }
});

app.get("/api/public/:slug/results", async (req, res) => {
  try {
    const race = await resolveRaceBySlug(req.params.slug);
    if (!race.isOfficial) {
      return res.status(403).json({ error: "Resultados publicos no disponibles aun" });
    }

    const [finishers, participants] = await Promise.all([
      prisma.finisher.findMany({
        where: { raceId: race.id },
        orderBy: [{ disqualified: "asc" }, { position: "asc" }],
      }),
      prisma.participant.findMany({
        where: { raceId: race.id },
        orderBy: { nombre: "asc" },
      }),
    ]);

    const participantMap = new Map(
      participants.map((participant) => [normalizeDorsal(participant.dorsal), participant])
    );

    res.json({
      race: serializeRace(race),
      results: finishers.map((finisher) => {
        const participant = participantMap.get(normalizeDorsal(finisher.dorsal)) || null;
        return {
          id: finisher.id,
          dorsal: race.showDorsalPublic ? finisher.dorsal : null,
          certificateDorsal: race.certificatesEnabled ? finisher.dorsal : null,
          position: finisher.disqualified ? null : finisher.position,
          timeMs: Number(finisher.elapsedMs) / 1000,
          disqualified: finisher.disqualified && !isNoTimeFinisher(finisher),
          dqReason: isNoTimeFinisher(finisher) ? null : finisher.dqReason ?? null,
          noTime: isNoTimeFinisher(finisher),
          name: participant?.nombre || "-",
          distance: participant?.distancia || null,
        };
      }),
    });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.message || "Error" });
  }
});

app.post("/api/public/:slug/certificate", async (req, res) => {
  const dorsal = String(req.body?.dorsal || "").trim();
  const documento = String(req.body?.documento || "").trim();

  if (!dorsal || !documento) {
    return res.status(400).json({ error: "dorsal y documento requeridos" });
  }

  try {
    const race = await resolveRaceBySlug(req.params.slug);
    if (!race.certificatesEnabled) {
      return res.status(403).json({ error: "Certificados no disponibles para esta carrera" });
    }
    if (!race.isOfficial) {
      return res.status(403).json({ error: "Los certificados aun no estan disponibles" });
    }

    const [participant, finisher, finishers, participants, categories] = await Promise.all([
      prisma.participant.findFirst({
        where: {
          raceId: race.id,
          dorsal,
          documento,
        },
      }),
      prisma.finisher.findUnique({
        where: {
          raceId_dorsal: {
            raceId: race.id,
            dorsal,
          },
        },
      }),
      prisma.finisher.findMany({
        where: { raceId: race.id },
        orderBy: { position: "asc" },
      }),
      prisma.participant.findMany({
        where: { raceId: race.id },
      }),
      getRaceCategories(race),
    ]);

    if (!participant) {
      return res.status(403).json({ error: "Documento no valido para este dorsal" });
    }

    if (!finisher || (finisher.disqualified && !isNoTimeFinisher(finisher))) {
      return res.status(404).json({ error: "No hay certificado disponible para este dorsal" });
    }

    const standings = buildCertificateContext({
      finishers,
      participants,
      categories,
      dorsal,
    });
    const certificateCode = `CR-${race.id}-${finisher.id}-${normalizeText(finisher.dorsal)}`;

    res.json({
      race: serializeRace(race),
      certificate: {
        dorsal: finisher.dorsal,
        position: standings?.distanceOverallPosition ?? standings?.overallPosition ?? finisher.position,
        timeMs: Number(finisher.elapsedMs) / 1000,
        name: participant.nombre,
        distance: participant.distancia,
        genderPosition: standings?.genderPosition ?? null,
        categoryName: standings?.categoryName ?? null,
        categoryPosition: standings?.categoryPosition ?? null,
        noTime: isNoTimeFinisher(finisher),
        certificateCode,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.message || "Error" });
  }
});

app.post("/api/public/:slug/certificate/pdf", async (req, res) => {
  const dorsal = String(req.body?.dorsal || "").trim();
  const documento = String(req.body?.documento || "").trim();

  if (!dorsal || !documento) {
    return res.status(400).json({ error: "dorsal y documento requeridos" });
  }

  try {
    const race = await resolveRaceBySlug(req.params.slug);
    if (!race.certificatesEnabled) {
      return res.status(403).json({ error: "Certificados no disponibles para esta carrera" });
    }
    if (!race.isOfficial) {
      return res.status(403).json({ error: "Los certificados aun no estan disponibles" });
    }

    const [participant, finisher, finishers, participants, categories] = await Promise.all([
      prisma.participant.findFirst({
        where: {
          raceId: race.id,
          dorsal,
          documento,
        },
      }),
      prisma.finisher.findUnique({
        where: {
          raceId_dorsal: {
            raceId: race.id,
            dorsal,
          },
        },
      }),
      prisma.finisher.findMany({
        where: { raceId: race.id },
        orderBy: { position: "asc" },
      }),
      prisma.participant.findMany({
        where: { raceId: race.id },
      }),
      getRaceCategories(race),
    ]);

    if (!participant) {
      return res.status(403).json({ error: "Documento no valido para este dorsal" });
    }

    if (!finisher || (finisher.disqualified && !isNoTimeFinisher(finisher))) {
      return res.status(404).json({ error: "No hay certificado disponible para este dorsal" });
    }

    const standings = buildCertificateContext({
      finishers,
      participants,
      categories,
      dorsal,
    });
    const certificate = {
      dorsal: finisher.dorsal,
      position: standings?.distanceOverallPosition ?? standings?.overallPosition ?? finisher.position,
      timeMs: Number(finisher.elapsedMs) / 1000,
      name: participant.nombre,
      distance: participant.distancia,
      genderPosition: standings?.genderPosition ?? null,
      categoryName: standings?.categoryName ?? null,
      categoryPosition: standings?.categoryPosition ?? null,
      noTime: isNoTimeFinisher(finisher),
      certificateCode: `CR-${race.id}-${finisher.id}-${normalizeText(finisher.dorsal)}`,
    };

    const pdfBuffer = await renderCertificatePdf(race, certificate);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${getCertificateFileName(certificate)}"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.message || "Error al generar certificado PDF" });
  }
});

app.post("/api/public/:slug/certificate/image", async (req, res) => {
  const dorsal = String(req.body?.dorsal || "").trim();
  const documento = String(req.body?.documento || "").trim();

  if (!dorsal || !documento) {
    return res.status(400).json({ error: "dorsal y documento requeridos" });
  }

  try {
    const race = await resolveRaceBySlug(req.params.slug);
    if (!race.certificatesEnabled) {
      return res.status(403).json({ error: "Certificados no disponibles para esta carrera" });
    }
    if (!race.isOfficial) {
      return res.status(403).json({ error: "Los certificados aun no estan disponibles" });
    }

    const [participant, finisher, finishers, participants, categories] = await Promise.all([
      prisma.participant.findFirst({
        where: {
          raceId: race.id,
          dorsal,
          documento,
        },
      }),
      prisma.finisher.findUnique({
        where: {
          raceId_dorsal: {
            raceId: race.id,
            dorsal,
          },
        },
      }),
      prisma.finisher.findMany({
        where: { raceId: race.id },
        orderBy: { position: "asc" },
      }),
      prisma.participant.findMany({
        where: { raceId: race.id },
      }),
      getRaceCategories(race),
    ]);

    if (!participant) {
      return res.status(403).json({ error: "Documento no valido para este dorsal" });
    }

    if (!finisher || (finisher.disqualified && !isNoTimeFinisher(finisher))) {
      return res.status(404).json({ error: "No hay certificado disponible para este dorsal" });
    }

    const standings = buildCertificateContext({
      finishers,
      participants,
      categories,
      dorsal,
    });
    const certificate = {
      dorsal: finisher.dorsal,
      position: standings?.distanceOverallPosition ?? standings?.overallPosition ?? finisher.position,
      timeMs: Number(finisher.elapsedMs) / 1000,
      name: participant.nombre,
      distance: participant.distancia,
      genderPosition: standings?.genderPosition ?? null,
      categoryName: standings?.categoryName ?? null,
      categoryPosition: standings?.categoryPosition ?? null,
      noTime: isNoTimeFinisher(finisher),
      certificateCode: `CR-${race.id}-${finisher.id}-${normalizeText(finisher.dorsal)}`,
    };

    const imageBuffer = await renderCertificateImage(race, certificate);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Disposition", `attachment; filename="${getCertificateImageFileName(certificate)}"`);
    res.send(imageBuffer);
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.message || "Error al generar imagen del certificado" });
  }
});

app.use("/api", requireAuth);

app.get("/api/races", async (req, res) => {
  try {
    await ensureDefaultRace();
    const races = req.user.role === "MASTER"
      ? await prisma.race.findMany({ orderBy: [{ createdAt: "desc" }, { id: "desc" }] })
      : await prisma.race.findMany({
          where: {
            userAssignments: {
              some: { userId: req.user.id },
            },
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        });
    res.json(races.map(serializeRace));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al listar carreras" });
  }
});

app.post("/api/races", async (req, res) => {
  if (req.user.role !== "MASTER") {
    return res.status(403).json({ error: "Sin permisos" });
  }

  const { name, slug, eventDate, categories, distances, publicNotice, certificatesEnabled, showDorsalPublic, certificateTemplate } = req.body;
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: "name requerido" });
  }

  try {
    const baseSlug = slugify(slug || name) || `carrera-${Date.now()}`;
    let finalSlug = baseSlug;
    let suffix = 1;
    while (await prisma.race.findUnique({ where: { slug: finalSlug } })) {
      finalSlug = `${baseSlug}-${suffix++}`;
    }

    const race = await prisma.race.create({
      data: {
        name: String(name).trim(),
        slug: finalSlug,
        eventDate: parseEventDate(eventDate),
        publicNotice: publicNotice == null ? null : String(publicNotice).trim() || null,
        certificatesEnabled: certificatesEnabled !== false,
        showDorsalPublic: showDorsalPublic !== false,
        certificateTemplate: normalizeCertificateTemplate(certificateTemplate),
        categories: categories ?? DEFAULT_CATEGORIES,
        distances: normalizeDistances(distances),
        status: "DRAFT",
      },
    });

    await prisma.raceUser.create({
      data: { userId: req.user.id, raceId: race.id },
    });

    res.json(serializeRace(race));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al crear carrera" });
  }
});

app.get("/api/races/:raceId", async (req, res) => {
  try {
    const race = await resolveRace(req, { allowBody: false });
    res.json(await getRacePayload(race));
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.message || "Error al obtener carrera" });
  }
});

app.get("/api/race", async (req, res) => {
  try {
    const race = await resolveRace(req, { allowBody: false });
    res.json(await getRacePayload(race));
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.message || "Error al obtener estado de la carrera" });
  }
});

app.post("/api/race/start", async (req, res) => {
  try {
    const race = await resolveRace(req);
    const now = BigInt(Date.now());
    await prisma.$transaction([
      prisma.race.update({
        where: { id: race.id },
        data: {
          started: true,
          closed: false,
          startTime: now,
          endTime: null,
          status: race.isOfficial ? "OFFICIAL" : "TESTING",
        },
      }),
      prisma.finisher.deleteMany({ where: { raceId: race.id } }),
    ]);
    res.json({ success: true, startTime: Number(now), raceId: race.id });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.message || "Error al iniciar la carrera" });
  }
});

app.post("/api/race/close", async (req, res) => {
  try {
    const race = await resolveRace(req);
    const now = BigInt(Date.now());
    await prisma.race.update({
      where: { id: race.id },
      data: { closed: true, endTime: now },
    });
    res.json({ success: true, raceId: race.id });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.message || "Error al cerrar la carrera" });
  }
});

app.post("/api/race/reset-results", async (req, res) => {
  try {
    const race = await resolveRace(req);
    await prisma.$transaction([
      prisma.finisher.deleteMany({ where: { raceId: race.id } }),
      prisma.race.update({
        where: { id: race.id },
        data: { started: false, closed: false, startTime: null, endTime: null, status: "DRAFT" },
      }),
    ]);
    res.json({ success: true, raceId: race.id });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.message || "Error al limpiar resultados" });
  }
});

app.post("/api/race/reset", async (req, res) => {
  try {
    const race = await resolveRace(req);
    await prisma.$transaction([
      prisma.finisher.deleteMany({ where: { raceId: race.id } }),
      prisma.participant.deleteMany({ where: { raceId: race.id } }),
      prisma.race.update({
        where: { id: race.id },
        data: { started: false, closed: false, startTime: null, endTime: null, status: "DRAFT" },
      }),
    ]);
    res.json({ success: true, raceId: race.id });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.message || "Error al resetear la carrera" });
  }
});

app.post("/api/races/:raceId/mark-official", async (req, res) => {
  if (req.user.role !== "MASTER") {
    return res.status(403).json({ error: "Sin permisos" });
  }
  try {
    const race = await resolveRace(req);
    const updated = await prisma.race.update({
      where: { id: race.id },
      data: { isOfficial: true, status: "OFFICIAL" },
    });
    res.json({ success: true, race: serializeRace(updated) });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.message || "Error al marcar oficial" });
  }
});

app.put("/api/races/:raceId", async (req, res) => {
  if (req.user.role !== "MASTER") {
    return res.status(403).json({ error: "Sin permisos" });
  }

  try {
    const race = await resolveRace(req);
    const data = {};

    if (req.body?.name != null) {
      const name = String(req.body.name).trim();
      if (!name) {
        return res.status(400).json({ error: "name invalido" });
      }
      data.name = name;
    }

    if (Object.prototype.hasOwnProperty.call(req.body || {}, "eventDate")) {
      data.eventDate = parseEventDate(req.body.eventDate);
    }

    if (Object.prototype.hasOwnProperty.call(req.body || {}, "publicNotice")) {
      data.publicNotice = req.body.publicNotice == null
        ? null
        : String(req.body.publicNotice).trim() || null;
    }

    if (Object.prototype.hasOwnProperty.call(req.body || {}, "distances")) {
      data.distances = normalizeDistances(req.body.distances);
    }

    if (Object.prototype.hasOwnProperty.call(req.body || {}, "certificatesEnabled")) {
      data.certificatesEnabled = Boolean(req.body.certificatesEnabled);
    }

    if (Object.prototype.hasOwnProperty.call(req.body || {}, "showDorsalPublic")) {
      data.showDorsalPublic = Boolean(req.body.showDorsalPublic);
    }

    if (Object.prototype.hasOwnProperty.call(req.body || {}, "certificateTemplate")) {
      data.certificateTemplate = normalizeCertificateTemplate(req.body.certificateTemplate);
    }

    const updated = await prisma.race.update({
      where: { id: race.id },
      data,
    });

    res.json({ success: true, race: serializeRace(updated) });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.message || "Error al actualizar carrera" });
  }
});

app.post("/api/participants", async (req, res) => {
  const { participants, raceId } = req.body;
  if (!Array.isArray(participants) || participants.length === 0) {
    return res.status(400).json({ error: "participants debe ser un array no vacio" });
  }

  try {
    const race = await resolveRace({ ...req, body: { raceId } });
    const normalizedParticipants = participants.map((participant, index) => ({
      row: index + 1,
      documento: String(participant.documento ?? "").trim(),
      nombre: String(participant.nombre ?? "").trim(),
      edad: Number(participant.edad),
      genero: String(participant.genero ?? "").trim().toUpperCase(),
      distancia: String(participant.distancia ?? "").trim().toUpperCase(),
      dorsal:
        participant.dorsal !== undefined &&
        participant.dorsal !== null &&
        String(participant.dorsal).trim() !== ""
          ? normalizeDorsal(participant.dorsal)
          : null,
    }));
    const participantErrors = [];
    const dorsalRows = new Map();
    normalizedParticipants.forEach((participant) => {
      if (!participant.documento) participantErrors.push(`Fila ${participant.row}: documento vacio`);
      if (!participant.nombre) participantErrors.push(`Fila ${participant.row}: nombre vacio`);
      if (!Number.isFinite(participant.edad) || participant.edad <= 0) participantErrors.push(`Fila ${participant.row}: edad invalida`);
      if (!["M", "F"].includes(participant.genero)) participantErrors.push(`Fila ${participant.row}: genero invalido`);
      if (!participant.distancia) participantErrors.push(`Fila ${participant.row}: distancia vacia`);
      if (!participant.dorsal) return;
      if (!dorsalRows.has(participant.dorsal)) dorsalRows.set(participant.dorsal, []);
      dorsalRows.get(participant.dorsal).push(participant.row);
    });
    dorsalRows.forEach((rows, dorsal) => {
      if (rows.length > 1) {
        participantErrors.push(`Dorsal ${dorsal} repetido en filas ${rows.join(", ")}`);
      }
    });
    if (participantErrors.length > 0) {
      return res.status(400).json({ error: participantErrors.join(". ") });
    }

    const incomingDocuments = normalizedParticipants.map((participant) => participant.documento);
    const incomingDorsals = normalizedParticipants.map((participant) => participant.dorsal).filter(Boolean);
    const existingDorsals = incomingDorsals.length > 0
      ? await prisma.participant.findMany({
          where: {
            raceId: race.id,
            dorsal: { in: incomingDorsals },
            documento: { notIn: incomingDocuments },
          },
          select: { documento: true, nombre: true, dorsal: true },
        })
      : [];
    if (existingDorsals.length > 0) {
      const conflicts = existingDorsals
        .map((participant) => `dorsal ${participant.dorsal} ya asignado a ${participant.nombre} (${participant.documento})`)
        .join("; ");
      return res.status(409).json({ error: conflicts });
    }

    const results = await prisma.$transaction(
      normalizedParticipants.map((participant) =>
        prisma.participant.upsert({
          where: {
            raceId_documento: {
              raceId: race.id,
              documento: participant.documento,
            },
          },
          update: {
            nombre: participant.nombre,
            edad: participant.edad,
            genero: participant.genero,
            distancia: participant.distancia,
            ...(participant.dorsal ? { dorsal: participant.dorsal } : {}),
          },
          create: {
            raceId: race.id,
            documento: participant.documento,
            nombre: participant.nombre,
            edad: participant.edad,
            genero: participant.genero,
            distancia: participant.distancia,
            dorsal: participant.dorsal,
          },
        })
      )
    );

    const distances = [
      ...new Set(
        participants
          .map((participant) => String(participant.distancia || "").trim().toUpperCase())
          .filter(Boolean)
      ),
    ];

    if (distances.length > 0) {
      await prisma.race.update({
        where: { id: race.id },
        data: { distances },
      });
    }

    res.json({ success: true, count: results.length, raceId: race.id });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.message || "Error al guardar participantes" });
  }
});

app.post("/api/participants/dorsals", async (req, res) => {
  const { assignments, raceId } = req.body;
  if (!Array.isArray(assignments) || assignments.length === 0) {
    return res.status(400).json({ error: "assignments debe ser un array no vacio" });
  }

  try {
    const race = await resolveRace({ ...req, body: { raceId } });
    const normalizedAssignments = assignments.map((item, index) => ({
      row: index + 2,
      documento: String(item?.documento || "").trim(),
      dorsal: normalizeDorsal(item?.dorsal),
    }));

    const invalid = normalizedAssignments.filter((item) => !item.documento || !item.dorsal);
    const seenDocuments = new Set();
    const duplicatesInFile = [];
    for (const item of normalizedAssignments) {
      const key = item.documento;
      if (!key) continue;
      if (seenDocuments.has(key)) {
        duplicatesInFile.push(item);
      } else {
        seenDocuments.add(key);
      }
    }

    if (invalid.length > 0 || duplicatesInFile.length > 0) {
      return res.status(400).json({
        error: "El archivo tiene filas invalidas o documentos repetidos",
        invalidRows: invalid,
        duplicateDocuments: duplicatesInFile.map((item) => item.documento),
      });
    }

    const participants = await prisma.participant.findMany({
      where: {
        raceId: race.id,
        documento: { in: normalizedAssignments.map((item) => item.documento) },
      },
      select: { id: true, documento: true, dorsal: true },
    });

    const participantByDocument = new Map(
      participants.map((participant) => [String(participant.documento).trim(), participant])
    );

    const updated = [];
    const notFound = [];
    const conflicts = [];

    for (const item of normalizedAssignments) {
      const participant = participantByDocument.get(item.documento);
      if (!participant) {
        notFound.push(item);
        continue;
      }

      try {
        const updatedParticipant = await prisma.participant.update({
          where: { id: participant.id },
          data: { dorsal: item.dorsal },
          select: { id: true, documento: true, dorsal: true, nombre: true },
        });
        updated.push(updatedParticipant);
      } catch (err) {
        if (err.code === "P2002") {
          conflicts.push(item);
          continue;
        }
        throw err;
      }
    }

    res.json({
      success: true,
      raceId: race.id,
      updatedCount: updated.length,
      notFoundCount: notFound.length,
      conflictCount: conflicts.length,
      updated,
      notFound,
      conflicts,
    });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.message || "Error al actualizar dorsales" });
  }
});

app.get("/api/participants/search", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.json([]);

  try {
    const race = await resolveRace(req, { allowBody: false });
    const results = await prisma.participant.findMany({
      where: {
        raceId: race.id,
        OR: [
          { documento: { contains: q, mode: "insensitive" } },
          { nombre: { contains: q, mode: "insensitive" } },
        ],
      },
      orderBy: { nombre: "asc" },
      take: 20,
    });
    res.json(results);
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.message || "Error al buscar participante" });
  }
});

app.put("/api/participants/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: "id invalido" });

  const documento = String(req.body?.documento ?? "").trim();
  const nombre = String(req.body?.nombre ?? "").trim();
  const edad = Number(req.body?.edad);
  const genero = String(req.body?.genero ?? "").trim().toUpperCase();
  const distancia = String(req.body?.distancia ?? "").trim().toUpperCase();
  const dorsalRaw = req.body?.dorsal;
  const dorsal = dorsalRaw == null || String(dorsalRaw).trim() === ""
    ? null
    : normalizeDorsal(dorsalRaw);

  if (!documento) return res.status(400).json({ error: "documento requerido" });
  if (!nombre) return res.status(400).json({ error: "nombre requerido" });
  if (!Number.isFinite(edad) || edad <= 0) return res.status(400).json({ error: "edad invalida" });
  if (!["M", "F"].includes(genero)) return res.status(400).json({ error: "genero invalido" });
  if (!distancia) return res.status(400).json({ error: "distancia requerida" });

  try {
    const race = await resolveRace(req);
    const current = await prisma.participant.findUnique({ where: { id } });
    if (!current || current.raceId !== race.id) {
      return res.status(404).json({ error: "Participante no encontrado" });
    }

    const participant = await prisma.participant.update({
      where: { id },
      data: {
        documento,
        nombre,
        edad,
        genero,
        distancia,
        dorsal,
      },
    });
    res.json({ success: true, participant });
  } catch (err) {
    if (err.code === "P2002") {
      const target = Array.isArray(err.meta?.target) ? err.meta.target.join(", ") : "";
      if (target.includes("documento")) {
        return res.status(409).json({ error: "Este documento ya pertenece a otro participante" });
      }
      if (target.includes("dorsal")) {
        return res.status(409).json({ error: "Este dorsal ya esta asignado a otro participante" });
      }
      return res.status(409).json({ error: "Documento o dorsal duplicado" });
    }
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.message || "Error al actualizar participante" });
  }
});

app.post("/api/participants/:id/dorsal", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const dorsal = normalizeDorsal(req.body?.dorsal);
  if (!dorsal) return res.status(400).json({ error: "dorsal requerido" });

  try {
    const race = await resolveRace(req);
    const current = await prisma.participant.findUnique({ where: { id } });
    if (!current || current.raceId !== race.id) {
      return res.status(404).json({ error: "Participante no encontrado" });
    }

    const participant = await prisma.participant.update({
      where: { id },
      data: { dorsal },
    });
    res.json({ success: true, participant });
  } catch (err) {
    if (err.code === "P2002") {
      return res.status(409).json({ error: "Este dorsal ya esta asignado a otro participante" });
    }
    console.error(err);
    res.status(500).json({ error: "Error al asignar dorsal" });
  }
});

app.post("/api/participants/:id/kit", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const race = await resolveRace(req);
    const current = await prisma.participant.findUnique({ where: { id } });
    if (!current || current.raceId !== race.id) {
      return res.status(404).json({ error: "Participante no encontrado" });
    }

    const participant = await prisma.participant.update({
      where: { id },
      data: { kitEntregado: !current.kitEntregado },
    });
    res.json({ success: true, participant });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al actualizar kit" });
  }
});

app.post("/api/participants/:id/carta", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const race = await resolveRace(req);
    const current = await prisma.participant.findUnique({ where: { id } });
    if (!current || current.raceId !== race.id) {
      return res.status(404).json({ error: "Participante no encontrado" });
    }

    const participant = await prisma.participant.update({
      where: { id },
      data: { cartaFirmada: !current.cartaFirmada },
    });
    res.json({ success: true, participant });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al actualizar carta" });
  }
});

app.post("/api/finishers", async (req, res) => {
  const { timestamp, elapsedMs, reorder } = req.body;
  const dorsal = normalizeDorsal(req.body?.dorsal);
  if (!dorsal) return res.status(400).json({ error: "dorsal requerido" });

  try {
    const race = await resolveRace(req);
    const count = await prisma.finisher.count({ where: { raceId: race.id } });
    await prisma.finisher.create({
      data: {
        raceId: race.id,
        dorsal,
        position: count + 1,
        timestamp: BigInt(timestamp ?? Date.now()),
        elapsedMs: BigInt(Math.round((elapsedMs ?? 0) * 1000)),
      },
    });

    if (reorder) {
      const all = await prisma.finisher.findMany({
        where: { raceId: race.id },
        orderBy: { elapsedMs: "asc" },
      });
      await prisma.$transaction(
        all.map((finisher, index) =>
          prisma.finisher.update({
            where: { id: finisher.id },
            data: { position: index + 1 },
          })
        )
      );
    }

    res.json({ success: true, raceId: race.id });
  } catch (err) {
    if (err.code === "P2002") {
      return res.status(409).json({ error: "Este dorsal ya fue registrado" });
    }
    console.error(err);
    res.status(500).json({ error: "Error al registrar finisher" });
  }
});

app.post("/api/finishers/import", async (req, res) => {
  const { finishers, raceId, replace } = req.body || {};
  if (!Array.isArray(finishers) || finishers.length === 0) {
    return res.status(400).json({ error: "finishers debe ser un array no vacio" });
  }

  const normalized = [];
  const seen = new Set();
  const errors = [];

  finishers.forEach((finisher, index) => {
    const dorsal = normalizeDorsal(finisher?.dorsal);
    const elapsedMs = Number(finisher?.elapsedMs);
    const position = Number.parseInt(finisher?.position, 10);
    const rowErrors = [];

    if (!dorsal) rowErrors.push("Dorsal vacio");
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) rowErrors.push("Tiempo invalido");
    if (finisher?.position != null && (!Number.isInteger(position) || position <= 0)) {
      rowErrors.push("Puesto invalido");
    }
    if (dorsal && seen.has(dorsal)) rowErrors.push("Dorsal repetido");
    if (dorsal) seen.add(dorsal);

    if (rowErrors.length > 0) {
      errors.push({ row: index + 1, errors: rowErrors });
      return;
    }

    normalized.push({
      dorsal,
      elapsedMs,
      position: Number.isInteger(position) && position > 0 ? position : null,
    });
  });

  if (errors.length > 0) {
    return res.status(400).json({ error: "Archivo invalido", details: errors });
  }

  try {
    const race = await resolveRace({ ...req, body: { raceId } });
    const existing = await prisma.finisher.findMany({
      where: { raceId: race.id },
      select: { dorsal: true },
    });
    const existingDorsals = new Set(existing.map((finisher) => normalizeDorsal(finisher.dorsal)));
    const ordered = normalized
      .slice()
      .sort((a, b) => {
        if (a.position != null && b.position != null) return a.position - b.position;
        if (a.position != null) return -1;
        if (b.position != null) return 1;
        return a.elapsedMs - b.elapsedMs;
      })
      .map((finisher, index) => ({
        ...finisher,
        position: finisher.position ?? index + 1,
      }));

    await prisma.$transaction(async (tx) => {
      if (replace) {
        await tx.finisher.deleteMany({ where: { raceId: race.id } });
      }

      for (const finisher of ordered) {
        const timestamp = race.startTime
          ? Number(race.startTime) + finisher.elapsedMs
          : Date.now() + finisher.position;
        await tx.finisher.upsert({
          where: {
            raceId_dorsal: {
              raceId: race.id,
              dorsal: finisher.dorsal,
            },
          },
          update: {
            position: finisher.position,
            timestamp: BigInt(Math.round(timestamp)),
            elapsedMs: BigInt(Math.round(finisher.elapsedMs * 1000)),
            disqualified: false,
            dqReason: null,
          },
          create: {
            raceId: race.id,
            dorsal: finisher.dorsal,
            position: finisher.position,
            timestamp: BigInt(Math.round(timestamp)),
            elapsedMs: BigInt(Math.round(finisher.elapsedMs * 1000)),
          },
        });
      }
    });

    const updatedCount = replace
      ? 0
      : ordered.filter((finisher) => existingDorsals.has(finisher.dorsal)).length;
    const createdCount = replace ? ordered.length : ordered.length - updatedCount;

    res.json({
      success: true,
      raceId: race.id,
      importedCount: ordered.length,
      updatedCount,
      createdCount,
      replaced: Boolean(replace),
    });
  } catch (err) {
    if (err.code === "P2002") {
      return res.status(409).json({ error: "Hay dorsales duplicados en resultados" });
    }
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.message || "Error al importar resultados" });
  }
});

app.delete("/api/finishers/:dorsal", async (req, res) => {
  const { dorsal } = req.params;
  try {
    const race = await resolveRace(req, { allowBody: false });
    const existing = await prisma.finisher.findUnique({
      where: { raceId_dorsal: { raceId: race.id, dorsal } },
    });
    if (!existing) {
      return res.status(404).json({ error: "Finisher no encontrado" });
    }

    await prisma.finisher.delete({ where: { id: existing.id } });

    const remaining = await prisma.finisher.findMany({
      where: { raceId: race.id },
      orderBy: { position: "asc" },
    });
    await prisma.$transaction(
      remaining.map((finisher, index) =>
        prisma.finisher.update({
          where: { id: finisher.id },
          data: { position: index + 1 },
        })
      )
    );

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.message || "Error al eliminar finisher" });
  }
});

app.put("/api/finishers/:dorsal/time", async (req, res) => {
  const { dorsal } = req.params;
  const { elapsedMs, raceStartTime } = req.body;
  if (elapsedMs == null) return res.status(400).json({ error: "elapsedMs requerido" });

  try {
    const race = await resolveRace(req);
    const existing = await prisma.finisher.findUnique({
      where: { raceId_dorsal: { raceId: race.id, dorsal } },
    });
    if (!existing) {
      return res.status(404).json({ error: "Finisher no encontrado" });
    }

    const data = { elapsedMs: BigInt(Math.round(elapsedMs * 1000)) };
    if (raceStartTime != null) {
      data.timestamp = BigInt(Math.round(raceStartTime + elapsedMs));
    }

    await prisma.finisher.update({ where: { id: existing.id }, data });

    const all = await prisma.finisher.findMany({
      where: { raceId: race.id },
      orderBy: { elapsedMs: "asc" },
    });
    await prisma.$transaction(
      all.map((finisher, index) =>
        prisma.finisher.update({
          where: { id: finisher.id },
          data: { position: index + 1 },
        })
      )
    );

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.message || "Error al actualizar tiempo" });
  }
});

app.post("/api/finishers/:dorsal/disqualify", async (req, res) => {
  const { dorsal } = req.params;
  const { disqualified, reason } = req.body;
  try {
    const race = await resolveRace(req);
    const existing = await prisma.finisher.findUnique({
      where: { raceId_dorsal: { raceId: race.id, dorsal } },
    });
    if (!existing) {
      return res.status(404).json({ error: "Finisher no encontrado" });
    }

    const finisher = await prisma.finisher.update({
      where: { id: existing.id },
      data: {
        disqualified: Boolean(disqualified),
        dqReason: disqualified ? (reason?.trim() || null) : null,
      },
    });
    res.json({ success: true, finisher: serializeFinisher(finisher) });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.message || "Error al actualizar descalificacion" });
  }
});

app.post("/api/finishers/:dorsal/no-time", async (req, res) => {
  const { dorsal } = req.params;
  const { noTime } = req.body || {};

  try {
    const race = await resolveRace(req);
    const existing = await prisma.finisher.findUnique({
      where: { raceId_dorsal: { raceId: race.id, dorsal } },
    });
    if (!existing) {
      return res.status(404).json({ error: "Finisher no encontrado" });
    }

    const finisher = await prisma.finisher.update({
      where: { id: existing.id },
      data: noTime
        ? { disqualified: true, dqReason: NO_TIME_REASON }
        : { disqualified: false, dqReason: null },
    });
    res.json({ success: true, finisher: serializeFinisher(finisher) });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.message || "Error al actualizar estado sin tiempo" });
  }
});

app.put("/api/finishers/reorder", async (req, res) => {
  const { finishers } = req.body;
  if (!Array.isArray(finishers)) {
    return res.status(400).json({ error: "finishers debe ser un array" });
  }

  try {
    const race = await resolveRace(req);
    await prisma.$transaction(
      finishers.map((finisher, index) =>
        prisma.finisher.update({
          where: {
            raceId_dorsal: {
              raceId: race.id,
              dorsal: String(finisher.dorsal).trim(),
            },
          },
          data: {
            position: Number.isInteger(Number(finisher?.position)) && Number(finisher.position) > 0
              ? Number(finisher.position)
              : index + 1,
          },
        })
      )
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.message || "Error al reordenar" });
  }
});

app.put("/api/finishers/:dorsal/position", async (req, res) => {
  const { dorsal } = req.params;
  const parsedPosition = Number.parseInt(req.body?.position, 10);
  if (!Number.isInteger(parsedPosition) || parsedPosition <= 0) {
    return res.status(400).json({ error: "position invalido" });
  }

  try {
    const race = await resolveRace(req);
    const existing = await prisma.finisher.findUnique({
      where: { raceId_dorsal: { raceId: race.id, dorsal } },
    });
    if (!existing) {
      return res.status(404).json({ error: "Finisher no encontrado" });
    }

    const finisher = await prisma.finisher.update({
      where: { id: existing.id },
      data: { position: parsedPosition },
    });

    res.json({ success: true, finisher: serializeFinisher(finisher) });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.message || "Error al actualizar puesto" });
  }
});

app.get("/api/config/categories", async (req, res) => {
  try {
    const race = await resolveRace(req, { allowBody: false });
    res.json({ categories: await getRaceCategories(race), raceId: race.id });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.message || "Error al obtener categorias" });
  }
});

app.put("/api/config/categories", async (req, res) => {
  if (req.user.role !== "MASTER") {
    return res.status(403).json({ error: "Sin permisos" });
  }

  const { categories } = req.body;
  if (!Array.isArray(categories) || categories.length === 0) {
    return res.status(400).json({ error: "categories debe ser un array no vacio" });
  }

  try {
    const race = await resolveRace(req);
    await prisma.$transaction([
      prisma.race.update({
        where: { id: race.id },
        data: { categories },
      }),
      prisma.config.upsert({
        where: { key: "categories" },
        update: { value: JSON.stringify(categories) },
        create: { key: "categories", value: JSON.stringify(categories) },
      }),
    ]);
    res.json({ success: true, raceId: race.id });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.message || "Error al guardar categorias" });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`RaceTimer server running on http://localhost:${PORT}`);
});

