#!/usr/bin/env node
/**
 * Sync bot configs from ../../bots/*.json into Firestore /bots/{id}.
 *
 * This is the "deploy" step for bots — run it whenever you add or edit a bot
 * file. The engine (Cloud Function) reads these documents at runtime, so no
 * code redeploy is needed to change a bot's prompt, model, or enabled state.
 *
 * Auth: reuses the Firebase CLI login (run `firebase login` once). No service
 * account key needed. Override with FIREBASE_TOKEN if you prefer.
 *
 * Usage:
 *   npm run bots:deploy            # upsert every bots/*.json
 *   npm run bots:deploy -- mod     # upsert only bots/mod.json
 */
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const PROJECT = "th-96963";
// Public firebase-tools OAuth client (from the firebase-tools source).
const CLIENT_ID =
  "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com";
const CLIENT_SECRET = "j9iVZfS8kkCEFUPaAeJV0sAi";

const here = dirname(fileURLToPath(import.meta.url));
const botsDir = resolve(here, "..", "..", "bots");

async function getAccessToken() {
  let refreshToken = process.env.FIREBASE_TOKEN;
  if (!refreshToken) {
    const cfg = join(homedir(), ".config", "configstore", "firebase-tools.json");
    try {
      refreshToken = JSON.parse(readFileSync(cfg, "utf8"))?.tokens?.refresh_token;
    } catch {
      /* fall through */
    }
  }
  if (!refreshToken) {
    throw new Error(
      "No credentials. Run `firebase login`, or set FIREBASE_TOKEN."
    );
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${await res.text()}`);
  return (await res.json()).access_token;
}

// Convert a plain JSON value to a Firestore REST "Value".
function toValue(v) {
  if (v === null) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number")
    return Number.isInteger(v)
      ? { integerValue: String(v) }
      : { doubleValue: v };
  if (typeof v === "string") return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  if (typeof v === "object")
    return {
      mapValue: {
        fields: Object.fromEntries(
          Object.entries(v).map(([k, x]) => [k, toValue(x)])
        ),
      },
    };
  throw new Error(`unsupported value: ${typeof v}`);
}

const only = process.argv.slice(2);
const files = readdirSync(botsDir)
  .filter((f) => f.endsWith(".json"))
  .filter((f) => only.length === 0 || only.includes(f.replace(/\.json$/, "")));

if (files.length === 0) {
  console.error("No matching bot files in", botsDir);
  process.exit(1);
}

const token = await getAccessToken();
const base = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

for (const file of files) {
  const bot = JSON.parse(readFileSync(join(botsDir, file), "utf8"));
  if (!bot.id) {
    console.error(`✗ ${file}: missing "id"`);
    continue;
  }
  const fields = Object.fromEntries(
    Object.entries(bot).map(([k, v]) => [k, toValue(v)])
  );
  const res = await fetch(`${base}/bots/${encodeURIComponent(bot.id)}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) {
    console.error(`✗ ${bot.id}: ${res.status} ${await res.text()}`);
    process.exitCode = 1;
    continue;
  }
  console.log(`✓ deployed bot "${bot.id}" (${bot.role}, ${bot.model})`);
}

console.log("Done.");
