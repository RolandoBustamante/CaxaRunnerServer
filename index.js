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
  { name: "Sub-18", minAge: 0, maxAge: 17 },
  { name: "Open", minAge: 18, maxAge: 39 },
  { name: "Master A", minAge: 40, maxAge: 49 },
  { name: "Master B", minAge: 50, maxAge: 59 },
  { name: "Master C", minAge: 60, maxAge: null },
];
let cachedLogoDataUri = null;

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
  return {
    id: finisher.id,
    dorsal: finisher.dorsal,
    position: finisher.position,
    timestamp: Number(finisher.timestamp),
    elapsedMs: Number(finisher.elapsedMs) / 1000,
    disqualified: finisher.disqualified,
    dqReason: finisher.dqReason ?? null,
    raceId: finisher.raceId,
    isTestData: finisher.isTestData,
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
  return new Date(date).toLocaleDateString("es-PE", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
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

function getLogoDataUri() {
  if (cachedLogoDataUri) return cachedLogoDataUri;

  const logoCandidates = [
    process.env.CERTIFICATE_LOGO_PATH,
    path.join(__dirname, "assets", "crlogo-horizontal.svg"),
    path.join(__dirname, "..", "client", "public", "crlogo-horizontal.svg"),
  ].filter(Boolean);

  const logoPath = logoCandidates.find((candidate) => fs.existsSync(candidate));
  if (!logoPath) {
    const error = new Error("No se encontro el logo del certificado");
    error.statusCode = 500;
    throw error;
  }

  const svg = fs.readFileSync(logoPath, "utf8");
  cachedLogoDataUri = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  return cachedLogoDataUri;
}

function buildCertificateHtmlDocument(race, certificate) {
  const eventDate = formatDateEs(race?.eventDate);
  const logoDataUri = getLogoDataUri();

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
          width: 68%;
          max-width: 720px;
          height: auto;
          opacity: 0.06;
          filter: brightness(0) invert(1);
          transform: rotate(-12deg);
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
          <img src="${logoDataUri}" alt="" />
        </div>
        <div class="content">
          <div class="header">
            <div>
              <img class="logo" src="${logoDataUri}" alt="Cajamarca Runners" />
              <div class="tag">${escapeHtml(race.name || "Resultado oficial")}</div>
            </div>
            <div class="seal">
              <div class="seal-title">Certificado de Finisher</div>
              <div class="seal-sub">Comite organizador</div>
            </div>
          </div>

          <h1 class="title">CERTIFICADO</h1>
          <p class="subtitle">El comite organizador certifica que el corredor(a) concluyo oficialmente la prueba.</p>
          <div class="name">${escapeHtml(certificate.name)}</div>
          <div class="summary">
            Concluyo oficialmente la distancia de <strong>${escapeHtml(certificate.distance)}</strong>,
            ocupando el puesto <strong>${escapeHtml(certificate.position)}</strong> del orden general,
            con un tiempo oficial de <strong>${escapeHtml(formatCertificateTime(certificate.timeMs))}</strong>.
          </div>

          <div class="metrics">
            <div class="metric">
              <div class="metric-value">${escapeHtml(formatCertificateTime(certificate.timeMs))}</div>
              <div class="metric-label">Tiempo oficial</div>
            </div>
            <div class="metric">
              <div class="metric-value">${escapeHtml(certificate.position)}</div>
              <div class="metric-label">Puesto general</div>
            </div>
            <div class="metric">
              <div class="metric-value">${escapeHtml(certificate.dorsal)}</div>
              <div class="metric-label">Dorsal</div>
            </div>
          </div>

          <div class="secondary-meta">
            <span><strong>Puesto por sexo:</strong> ${escapeHtml(certificate.genderPosition ?? "-")}</span>
            <span><strong>Categoria:</strong> ${escapeHtml(certificate.categoryName ?? "-")}</span>
            <span><strong>Puesto en categoria:</strong> ${escapeHtml(certificate.categoryPosition ?? "-")}</span>
          </div>

          <div class="footer">
            <div><strong>Fecha del evento:</strong> ${escapeHtml(eventDate || "-")}</div>
            <div><strong>Codigo de certificado:</strong> ${escapeHtml(certificate.certificateCode || "-")}</div>
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

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeGender(value) {
  return normalizeText(value).toUpperCase();
}

function normalizeDistance(value) {
  return normalizeText(value).toUpperCase();
}

function getAgeCategoryName(age, categories = DEFAULT_CATEGORIES) {
  const parsedAge = Number.parseInt(age, 10);
  if (Number.isNaN(parsedAge)) return null;

  for (const category of categories) {
    if (parsedAge >= category.minAge && (category.maxAge == null || parsedAge <= category.maxAge)) {
      return category.name;
    }
  }

  return null;
}

function getParticipantCategoryMeta(participant, categories = DEFAULT_CATEGORIES) {
  const ageCategoryName = getAgeCategoryName(participant?.edad, categories);
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
    participants.map((participant) => [normalizeText(participant.dorsal), participant])
  );
  const activeFinishers = finishers
    .filter((finisher) => !finisher.disqualified)
    .slice()
    .sort((a, b) => {
      const elapsedDiff = Number(a.elapsedMs) - Number(b.elapsedMs);
      if (elapsedDiff !== 0) return elapsedDiff;
      return Number(a.timestamp) - Number(b.timestamp);
    });

  const genderCounters = new Map();
  const categoryCounters = new Map();
  const standings = new Map();

  activeFinishers.forEach((finisher, index) => {
    const participant = participantMap.get(normalizeText(finisher.dorsal));
    const meta = getParticipantCategoryMeta(participant, categories);
    const genderKey = [meta.distance, meta.gender].filter(Boolean).join("::");
    const categoryKey = meta.categoryKey;

    const genderPosition = genderKey
      ? (genderCounters.get(genderKey) || 0) + 1
      : null;
    const categoryPosition = categoryKey
      ? (categoryCounters.get(categoryKey) || 0) + 1
      : null;

    if (genderKey) genderCounters.set(genderKey, genderPosition);
    if (categoryKey) categoryCounters.set(categoryKey, categoryPosition);

    standings.set(normalizeText(finisher.dorsal), {
      overallPosition: index + 1,
      genderPosition,
      categoryPosition,
      categoryName: meta.ageCategoryName,
    });
  });

  return standings.get(normalizeText(dorsal)) || null;
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
      where: { raceId: race.id },
      orderBy: { position: "asc" },
      take: 10,
    });
    const recentFinishers = await prisma.finisher.findMany({
      where: { raceId: race.id },
      orderBy: { position: "desc" },
      take: 10,
    });
    res.json({
      serverNow: Date.now(),
      ...serializeRace(race),
      finishersCount: await prisma.finisher.count({ where: { raceId: race.id } }),
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
      where: { raceId: race.id },
      orderBy: { position: "asc" },
      take: 10,
    });
    const recentFinishers = await prisma.finisher.findMany({
      where: { raceId: race.id },
      orderBy: { position: "desc" },
      take: 10,
    });

    res.json({
      serverNow: Date.now(),
      ...serializeRace(race),
      finishersCount: await prisma.finisher.count({ where: { raceId: race.id } }),
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
      participants.map((participant) => [String(participant.dorsal || "").trim(), participant])
    );

    res.json({
      race: serializeRace(race),
      results: finishers.map((finisher) => {
        const participant = participantMap.get(String(finisher.dorsal).trim()) || null;
        return {
          id: finisher.id,
          dorsal: finisher.dorsal,
          position: finisher.disqualified ? null : finisher.position,
          timeMs: Number(finisher.elapsedMs),
          disqualified: finisher.disqualified,
          dqReason: finisher.dqReason ?? null,
          name: participant?.nombre || "-",
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
        orderBy: [{ elapsedMs: "asc" }, { timestamp: "asc" }],
      }),
      prisma.participant.findMany({
        where: { raceId: race.id },
      }),
      getRaceCategories(race),
    ]);

    if (!participant) {
      return res.status(403).json({ error: "Documento no valido para este dorsal" });
    }

    if (!finisher || finisher.disqualified) {
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
        position: standings?.overallPosition ?? finisher.position,
        timeMs: Number(finisher.elapsedMs),
        name: participant.nombre,
        distance: participant.distancia,
        genderPosition: standings?.genderPosition ?? null,
        categoryName: standings?.categoryName ?? null,
        categoryPosition: standings?.categoryPosition ?? null,
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
        orderBy: [{ elapsedMs: "asc" }, { timestamp: "asc" }],
      }),
      prisma.participant.findMany({
        where: { raceId: race.id },
      }),
      getRaceCategories(race),
    ]);

    if (!participant) {
      return res.status(403).json({ error: "Documento no valido para este dorsal" });
    }

    if (!finisher || finisher.disqualified) {
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
      position: standings?.overallPosition ?? finisher.position,
      timeMs: Number(finisher.elapsedMs),
      name: participant.nombre,
      distance: participant.distancia,
      genderPosition: standings?.genderPosition ?? null,
      categoryName: standings?.categoryName ?? null,
      categoryPosition: standings?.categoryPosition ?? null,
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

  const { name, slug, eventDate, categories, distances } = req.body;
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
        eventDate: eventDate ? new Date(eventDate) : null,
        categories: categories ?? DEFAULT_CATEGORIES,
        distances: distances ?? null,
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
      data.eventDate = req.body.eventDate ? new Date(req.body.eventDate) : null;
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
    const results = await prisma.$transaction(
      participants.map((participant) =>
        prisma.participant.upsert({
          where: {
            raceId_documento: {
              raceId: race.id,
              documento: String(participant.documento).trim(),
            },
          },
          update: {
            nombre: String(participant.nombre).trim(),
            edad: Number(participant.edad),
            genero: String(participant.genero).trim().toUpperCase(),
            distancia: String(participant.distancia).trim().toUpperCase(),
            ...(participant.dorsal !== undefined && participant.dorsal !== null && String(participant.dorsal).trim() !== ""
              ? { dorsal: String(participant.dorsal).trim() }
              : {}),
          },
          create: {
            raceId: race.id,
            documento: String(participant.documento).trim(),
            nombre: String(participant.nombre).trim(),
            edad: Number(participant.edad),
            genero: String(participant.genero).trim().toUpperCase(),
            distancia: String(participant.distancia).trim().toUpperCase(),
            dorsal:
              participant.dorsal !== undefined &&
              participant.dorsal !== null &&
              String(participant.dorsal).trim() !== ""
                ? String(participant.dorsal).trim()
                : null,
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

app.post("/api/participants/:id/dorsal", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { dorsal } = req.body;
  if (!dorsal) return res.status(400).json({ error: "dorsal requerido" });

  try {
    const race = await resolveRace(req);
    const current = await prisma.participant.findUnique({ where: { id } });
    if (!current || current.raceId !== race.id) {
      return res.status(404).json({ error: "Participante no encontrado" });
    }

    const participant = await prisma.participant.update({
      where: { id },
      data: { dorsal: String(dorsal).trim() },
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
  const { dorsal, timestamp, elapsedMs, reorder } = req.body;
  if (!dorsal) return res.status(400).json({ error: "dorsal requerido" });

  try {
    const race = await resolveRace(req);
    const count = await prisma.finisher.count({ where: { raceId: race.id } });
    await prisma.finisher.create({
      data: {
        raceId: race.id,
        dorsal: String(dorsal).trim(),
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
          data: { position: index + 1 },
        })
      )
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.message || "Error al reordenar" });
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
