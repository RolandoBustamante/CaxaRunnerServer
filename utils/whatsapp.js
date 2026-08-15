const fs = require("fs");
const path = require("path");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");

const CLIENT_ID = "caxarunner-main";
const SESSION_DIR = path.resolve(__dirname, "..", ".wwebjs_auth");
const CACHE_DIR = path.resolve(__dirname, "..", ".wwebjs_cache");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const entry = {
  client: null,
  currentQR: null,
  pairingCode: null,
  pairingPhone: null,
  pairingRequestedAt: null,
  pairingError: null,
  initializing: null,
  isReady: false,
  manualLogout: false,
};

if (!process.__caxaRunnerWhatsappErrorGuards) {
  process.__caxaRunnerWhatsappErrorGuards = true;
  const isKnownShutdownError = (error) => {
    const message = String(error?.message || error || "");
    return (
      message.includes("Attempted to use detached Frame") ||
      message.includes("Execution context was destroyed") ||
      message.includes("Protocol error") ||
      message.includes("Target closed") ||
      message.includes("Session closed") ||
      message.includes("EBUSY: resource busy or locked")
    );
  };

  process.on("unhandledRejection", (error) => {
    if (isKnownShutdownError(error)) {
      entry.isReady = false;
      console.warn("WhatsApp ignoro un error transitorio de Chromium:", error?.message || error);
      return;
    }
    throw error;
  });

  process.on("uncaughtException", (error) => {
    if (isKnownShutdownError(error)) {
      entry.isReady = false;
      console.warn("WhatsApp ignoro un error transitorio de Chromium:", error?.message || error);
      return;
    }
    throw error;
  });
}

function normalizePhoneNumber(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.startsWith("51") && digits.length === 11) return digits;
  if (digits.length === 9) return `51${digits}`;
  throw new Error("El numero de telefono no es valido.");
}

function getSessionPath() {
  return path.join(SESSION_DIR, `session-${CLIENT_ID}`);
}

async function waitUntilConnected(maxMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (entry.client && entry.isReady) {
      const ready = await isClientUsable(entry.client);
      if (ready) return true;
      entry.isReady = false;
    }
    if (entry.client && !entry.isReady) {
      const ready = await isClientUsable(entry.client);
      if (ready) {
        entry.isReady = true;
        console.log("WhatsApp listo para enviar.");
        return true;
      }
    }
    await sleep(750);
  }
  throw new Error("Cliente WhatsApp no conectado.");
}

async function isClientUsable(client) {
  if (!client) return false;
  const state = await client.getState().catch(() => null);
  if (state !== "CONNECTED") return false;
  const page = client.pupPage;
  if (!page || page.isClosed?.()) return false;
  return page.evaluate(() => {
    try {
      const collections = window.require?.("WAWebCollections");
      const findChatAction = window.require?.("WAWebFindChatAction");
      const widFactory = window.require?.("WAWebWidFactory");
      return Boolean(
        window.WWebJS &&
        typeof window.WWebJS.getChat === "function" &&
        collections?.Chat &&
        typeof collections.Chat.get === "function" &&
        typeof findChatAction?.findOrCreateLatestChat === "function" &&
        typeof widFactory?.createWid === "function"
      );
    } catch {
      return false;
    }
  }).catch(() => false);
}

async function resolveChatIdsFromNumber(client, raw) {
  const normalized = normalizePhoneNumber(raw);
  let numberId = null;
  try {
    numberId = await client.getNumberId(normalized);
  } catch (error) {
    const message = String(error?.message || error || "");
    if (
      message.includes("Execution context was destroyed") ||
      message.includes("Target closed") ||
      message.includes("Session closed") ||
      message.includes("Protocol error")
    ) {
      throw new Error("No se pudo verificar el numero porque WhatsApp se esta reconectando.");
    }
    throw new Error("No se pudo verificar si el numero tiene WhatsApp.");
  }

  if (!numberId?._serialized) {
    throw new Error(`El numero ${normalized} no tiene WhatsApp o no esta disponible.`);
  }

  const chatIds = [numberId._serialized];
  const phoneChatId = `${normalized}@c.us`;
  if (!chatIds.includes(phoneChatId) && !String(numberId._serialized).endsWith("@lid")) {
    chatIds.push(phoneChatId);
  }
  return chatIds;
}

function configureClient(client) {
  client.removeAllListeners();

  client.on("qr", (qr) => {
    entry.currentQR = qr;
    entry.isReady = false;
    console.log("Nuevo QR WhatsApp generado.");
    try {
      qrcode.generate(qr, { small: true });
    } catch {}
  });

  client.on("code", (code) => {
    entry.pairingCode = code;
    entry.pairingError = null;
    entry.pairingRequestedAt = new Date().toISOString();
    console.log("Codigo de vinculacion WhatsApp generado.");
  });

  client.on("ready", async () => {
    entry.currentQR = null;
    entry.pairingCode = null;
    entry.pairingError = null;
    entry.manualLogout = false;
    await sleep(1200);
    entry.isReady = await isClientUsable(client);
    console.log(entry.isReady ? "WhatsApp listo." : "WhatsApp conectado, esperando carga interna.");
  });

  client.on("authenticated", () => {
    entry.pairingCode = null;
    entry.pairingError = null;
    console.log("Sesion WhatsApp autenticada.");
  });

  client.on("auth_failure", (message) => {
    entry.isReady = false;
    console.error("Error de autenticacion WhatsApp:", message);
  });

  client.on("disconnected", async (reason) => {
    const normalizedReason = String(reason || "").toUpperCase();
    entry.isReady = false;
    entry.currentQR = null;
    entry.pairingCode = null;
    if (normalizedReason === "LOGOUT") entry.manualLogout = true;
    console.error("WhatsApp desconectado:", normalizedReason);

    try {
      await client.destroy();
    } catch {}
    if (entry.client === client) entry.client = null;

    if (entry.manualLogout) return;
    setTimeout(() => initializeClient().catch(() => {}), 2500);
  });
}

async function destroyClient(logout = false) {
  if (!entry.client) return;
  if (logout) entry.manualLogout = true;
  try {
    await entry.client.destroy().catch(() => {});
  } catch {}
  entry.client = null;
  entry.currentQR = null;
  entry.pairingCode = null;
  entry.pairingPhone = null;
  entry.pairingRequestedAt = null;
  entry.pairingError = null;
  entry.isReady = false;
  entry.initializing = null;
}

async function removeSessionFolderSafe(sessionPath, tries = 6) {
  if (!fs.existsSync(sessionPath)) return true;
  let lastError = null;
  for (let index = 0; index < tries; index += 1) {
    try {
      fs.rmSync(sessionPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
      return true;
    } catch (error) {
      lastError = error;
      await sleep(500 + index * 300);
    }
  }
  console.error("No se pudo eliminar la sesion WhatsApp:", lastError?.message || lastError);
  return false;
}

async function initializeClient({ force = false } = {}) {
  if (entry.initializing) return entry.initializing;
  if (entry.client && !force) return entry.client;

  entry.initializing = (async () => {
    if (entry.client && force) await destroyClient();

    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: CLIENT_ID,
        dataPath: SESSION_DIR,
      }),
      puppeteer: {
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      },
    });

    entry.client = client;
    entry.currentQR = null;
    entry.isReady = false;
    configureClient(client);

    try {
      await client.initialize();
      console.log("Cliente WhatsApp inicializado.");
      return client;
    } catch (error) {
      entry.isReady = false;
      if (entry.client === client) entry.client = null;
      await client.destroy().catch(() => {});
      console.error("Error al inicializar WhatsApp:", error?.message || error);
      setTimeout(() => initializeClient().catch(() => {}), 5000);
      throw error;
    } finally {
      entry.initializing = null;
    }
  })();

  return entry.initializing;
}

function normalizePairingError(error) {
  const message = String(error?.message || error || "");
  if (message.includes("rate-overlimit") || message.includes("429")) {
    return "WhatsApp limito los intentos de codigo. Espera unos minutos o usa el QR.";
  }
  if (
    message.includes("Execution context was destroyed") ||
    message.includes("Target closed") ||
    message.includes("Session closed") ||
    message.includes("Protocol error")
  ) {
    return "WhatsApp Web se esta reconectando. Espera unos segundos e intenta otra vez.";
  }
  return message || "No se pudo generar el codigo de vinculacion.";
}

async function waitUntilPairingAvailable(maxMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const page = entry.client?.pupPage;
    if (page && !page.isClosed?.()) {
      const ready = await page.evaluate(() => {
        try {
          return Boolean(window.AuthStore?.PairingCodeLinkUtils?.startAltLinkingFlow);
        } catch {
          return false;
        }
      }).catch(() => false);
      if (ready) return true;
    }
    await sleep(750);
  }
  return false;
}

async function requestPairingCode(rawPhoneNumber) {
  const phoneNumber = normalizePhoneNumber(rawPhoneNumber);
  if (!entry.client) await initializeClient();
  if (entry.initializing) await entry.initializing;

  const state = entry.client ? await entry.client.getState().catch(() => null) : null;
  if (state === "CONNECTED") {
    throw new Error("WhatsApp ya esta conectado.");
  }
  if (!entry.client?.requestPairingCode) {
    throw new Error("Esta version de whatsapp-web.js no soporta codigo de vinculacion.");
  }
  const pairingAvailable = await waitUntilPairingAvailable();
  if (!pairingAvailable) {
    throw new Error("WhatsApp Web aun no cargo la vinculacion por codigo. Intenta nuevamente en unos segundos.");
  }

  entry.pairingPhone = phoneNumber;
  entry.pairingCode = null;
  entry.pairingError = null;
  entry.pairingRequestedAt = new Date().toISOString();

  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const code = await entry.client.requestPairingCode(phoneNumber, true, 180000);
      entry.pairingCode = code;
      entry.pairingError = null;
      entry.pairingRequestedAt = new Date().toISOString();
      return {
        success: true,
        phoneNumber,
        code,
        requestedAt: entry.pairingRequestedAt,
      };
    } catch (error) {
      lastError = error;
      await sleep(1200);
    }
  }

  entry.pairingError = normalizePairingError(lastError);
  throw new Error(entry.pairingError);
}

async function cancelPairingCode() {
  if (entry.client?.cancelPairingCode) {
    await entry.client.cancelPairingCode().catch(() => {});
  }
  entry.pairingCode = null;
  entry.pairingPhone = null;
  entry.pairingRequestedAt = null;
  entry.pairingError = null;
  return { success: true };
}

async function sendMessage({ number, message, filePath, caption }) {
  if (!number) throw new Error("El numero de telefono es obligatorio.");
  if (!message && !filePath) throw new Error("Debe proporcionar un mensaje o archivo.");
  try {
    if (!entry.client) await initializeClient();

    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await waitUntilConnected(attempt === 0 ? 90000 : 30000);

      const chatIds = await resolveChatIdsFromNumber(entry.client, number);
      for (const chatId of chatIds) {
        try {
          if (filePath) {
            const media = MessageMedia.fromFilePath(filePath);
            await entry.client.sendMessage(chatId, media, { caption: caption || message || "", sendSeen: false });
          } else {
            await entry.client.sendMessage(chatId, message, { sendSeen: false });
          }
          return { success: true, message: "Mensaje enviado correctamente." };
        } catch (error) {
          lastError = error;
        }
      }
      entry.isReady = false;
      await sleep(1200);
    }

    throw lastError || new Error("No se pudo resolver el chat.");
  } catch (error) {
    console.error("Error al enviar WhatsApp:", error?.message || error);
    return { success: false, message: "Error al enviar WhatsApp.", error: error?.message || String(error) };
  }
}

async function getWhatsAppStatus() {
  const state = entry.client ? await entry.client.getState().catch(() => null) : null;
  if (state === "CONNECTED") {
    entry.isReady = await isClientUsable(entry.client);
  } else {
    entry.isReady = false;
  }
  return {
    loggedIn: state === "CONNECTED",
    state,
    qr: entry.currentQR,
    pairingCode: entry.pairingCode,
    pairingPhone: entry.pairingPhone,
    pairingRequestedAt: entry.pairingRequestedAt,
    pairingError: entry.pairingError,
    isReady: entry.isReady,
  };
}

async function logoutClient() {
  await destroyClient(true);
  const sessionPath = getSessionPath();
  const deleted = await removeSessionFolderSafe(sessionPath);
  return { sessionPath, deleted };
}

async function restartClient() {
  return initializeClient({ force: true });
}

function getAdminNumbers() {
  return String(process.env.WHATSAPP_ADMIN_NUMBERS || "")
    .split(",")
    .map((number) => number.trim())
    .filter(Boolean);
}

module.exports = {
  CACHE_DIR,
  SESSION_DIR,
  getAdminNumbers,
  getWhatsAppStatus,
  initializeClient,
  logoutClient,
  requestPairingCode,
  cancelPairingCode,
  restartClient,
  sendMessage,
};
