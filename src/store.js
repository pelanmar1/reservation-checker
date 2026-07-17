const fs = require("fs/promises");
const path = require("path");

const STORE_PATH = process.env.WATCH_CONFIG_PATH || path.join(process.cwd(), "data", "watch-config.json");

async function ensureStoreDir() {
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
}

async function readStore() {
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeStore(data) {
  await ensureStoreDir();
  await fs.writeFile(STORE_PATH, JSON.stringify(data, null, 2), "utf8");
}

async function getWatchConfig() {
  return await readStore();
}

async function saveWatchConfig(input) {
  const existing = (await readStore()) || {};
  const next = {
    ...existing,
    ...input,
    updatedAt: new Date().toISOString(),
  };
  await writeStore(next);
  return next;
}

async function updateWatchMetadata(patch) {
  const existing = (await readStore()) || {};
  const next = {
    ...existing,
    ...patch,
    updatedAt: existing.updatedAt || new Date().toISOString(),
  };
  await writeStore(next);
  return next;
}

module.exports = {
  STORE_PATH,
  getWatchConfig,
  saveWatchConfig,
  updateWatchMetadata,
};
