// Genera el sitio del informe: lee la API de Meta, cifra los datos con la clave
// del informe y deja todo en la carpeta site/. Lo ejecuta GitHub Actions con cron.
// Los registros de Actions pueden ser públicos: este script no imprime datos de campañas.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "site");

const LEAD_ACTIONS = ["onsite_conversion.lead_grouped", "leadgen_grouped", "leadgen.other", "lead"];
const VISIT_ACTIONS = ["landing_page_view", "omni_landing_page_view"];
const AUTO_EVENT = /review|first_delivery|learning_stage|billing|funding|charge|receipt|threshold|after_review|di_/i;
const AUTO_ACTOR = /^(meta|facebook|sistema|system)?$/i;
const DAYS_BACK = 21; // días que se pueden elegir en la página
const PREV_DAYS = 7; // días extra para comparar con la semana anterior
const KDF_ITERATIONS = 600000;

const env = (name) => (process.env[name] || "").trim();

function addDays(s, n) {
  const d = new Date(s + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function dateIn(tz, when) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(when);
}
function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

async function readGraph(ctx, url) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${ctx.token}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    const err = new Error((body.error && body.error.message) || `Meta respondió ${res.status}`);
    err.code = (body.error && body.error.code) || res.status;
    throw err;
  }
  return body;
}
function graphUrl(ctx, p, params) {
  const url = new URL(`https://graph.facebook.com/${ctx.version}/${p}`);
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === "") continue;
    url.searchParams.set(k, typeof v === "string" ? v : JSON.stringify(v));
  }
  return url;
}
const gget = (ctx, p, params) => readGraph(ctx, graphUrl(ctx, p, params));

async function gall(ctx, p, params, maxPages = 20) {
  let body = await gget(ctx, p, params);
  let out = [];
  for (let page = 1; ; page++) {
    out = out.concat(body.data || []);
    const next = body.paging && body.paging.next;
    if (!next || page >= maxPages) break;
    const after = body.paging.cursors && body.paging.cursors.after;
    body = after ? await gget(ctx, p, { ...params, after }) : await readGraph(ctx, next);
  }
  return out;
}

// Lee varios objetos por id. Si un lote falla (por ejemplo, un anuncio eliminado), reintenta uno por uno.
async function byIds(ctx, ids, fields) {
  const out = {};
  await Promise.all(
    chunk([...new Set(ids)].filter(Boolean), 40).map(async (batch) => {
      try {
        Object.assign(out, await gget(ctx, "", { ids: batch.join(","), fields }));
      } catch {
        await Promise.all(
          batch.map(async (id) => {
            try {
              out[id] = await gget(ctx, id, { fields });
            } catch {
              /* objeto eliminado o sin acceso: se omite */
            }
          })
        );
      }
    })
  );
  return out;
}

function pickAction(actions, names) {
  if (!Array.isArray(actions)) return 0;
  for (const name of names) {
    const hit = actions.find((a) => a.action_type === name);
    if (hit) return Number(hit.value) || 0;
  }
  return 0;
}
function kindOf(objective) {
  const o = String(objective || "").toUpperCase();
  if (o.includes("LEAD")) return "leads";
  if (o.includes("AWARENESS") || o.includes("REACH")) return "reach";
  if (o.includes("TRAFFIC") || o.includes("CLICK")) return "traffic";
  return "other";
}
function resultOf(kind, row) {
  if (kind === "leads") return pickAction(row.actions, LEAD_ACTIONS);
  if (kind === "reach") return Number(row.reach) || 0;
  if (kind === "traffic") return pickAction(row.actions, VISIT_ACTIONS);
  return 0;
}

// extra_data llega como texto JSON con formas distintas según el evento.
function leaf(value, key) {
  let v = value;
  for (let i = 0; i < 3 && v && typeof v === "object"; i++) {
    v = v[key] !== undefined ? v[key] : v.value !== undefined ? v.value : v.new_value !== undefined ? v.new_value : v.old_value;
  }
  return v === undefined || v === null || typeof v === "object" ? null : v;
}
function activityOf(a) {
  let extra = {};
  try {
    extra = a.extra_data ? JSON.parse(a.extra_data) : {};
  } catch {
    extra = {};
  }
  const type = String(a.event_type || "");
  const oldV = leaf(extra.old_value, "old_value");
  const newV = leaf(extra.new_value, "new_value");
  let badge = "edit";
  let detail = "";
  if (/budget/.test(type)) {
    badge = "budget";
    const o = Number(oldV), n = Number(newV);
    if (Number.isFinite(o) && Number.isFinite(n) && n > 0) detail = `budget:${o / 100}:${n / 100}`;
  } else if (/run_status/.test(type)) {
    const off = /inactiv|paus|off|desactiv|archiv|delet|elimin/i.test(String(newV));
    badge = off ? "off" : "on";
    if (typeof newV === "string") detail = `status:${newV}`;
  } else if (/^create_/.test(type)) {
    badge = "new";
  } else if (/^delete_/.test(type)) {
    badge = "off";
  } else if (/target/.test(type)) {
    badge = "audience";
  }
  return {
    time: a.event_time,
    type,
    label: a.translated_event_type || type.replace(/_/g, " "),
    actor: a.actor_name || "",
    auto: AUTO_ACTOR.test(String(a.actor_name || "").trim()) || AUTO_EVENT.test(type),
    objectType: String(a.object_type || "").toUpperCase(),
    objectId: String(a.object_id || ""),
    objectName: a.object_name || "",
    badge,
    detail,
  };
}

async function collect(ctx, accountId) {
  const act = `act_${accountId}`;
  const warnings = [];
  const soft = (label, promise, fallback) =>
    promise.catch((e) => {
      warnings.push(`${label}: ${e.message}`);
      console.log(`Aviso: no se pudo leer "${label}" (código ${e.code || "?"}). El informe se genera sin esa parte.`);
      return fallback;
    });

  const account = await gget(ctx, act, { fields: "name,currency,timezone_name" });
  const tz = account.timezone_name || "America/Guayaquil";
  const now = new Date();
  const today = env("INFORME_FECHA") || dateIn(tz, now); // INFORME_FECHA solo se usa en pruebas
  const min = addDays(today, -DAYS_BACK);

  const [daily, adRows, rawActs] = await Promise.all([
    gall(ctx, `${act}/insights`, {
      level: "campaign",
      time_increment: "1",
      time_range: { since: addDays(min, -PREV_DAYS), until: today },
      fields: "campaign_id,campaign_name,objective,spend,impressions,reach,actions",
      limit: "500",
    }),
    soft(
      "Anuncios",
      gall(ctx, `${act}/insights`, {
        level: "ad",
        time_increment: "1",
        time_range: { since: min, until: today },
        fields: "ad_id,ad_name,adset_name,campaign_id,spend,reach,actions",
        limit: "500",
      }),
      []
    ),
    soft(
      "Historial de cambios",
      gall(ctx, `${act}/activities`, {
        since: min,
        until: addDays(today, 1),
        fields: "event_time,event_type,translated_event_type,actor_name,object_id,object_name,object_type,extra_data",
        locale: "es_LA",
        limit: "500",
      }),
      []
    ),
  ]);

  const campaignIds = [...new Set(daily.map((r) => r.campaign_id))];
  const activities = rawActs.map(activityOf);
  const human = activities.filter((a) => !a.auto);
  const actChildIds = human.filter((a) => a.objectType !== "CAMPAIGN" && a.objectType !== "ACCOUNT").map((a) => a.objectId);
  const adIds = [...new Set(adRows.map((r) => r.ad_id).concat(human.filter((a) => a.objectType === "AD").map((a) => a.objectId)))];

  const [campaignInfo, adsets, parents, adInfo] = await Promise.all([
    soft("Campañas", byIds(ctx, campaignIds, "name,objective,effective_status,daily_budget"), {}),
    campaignIds.length
      ? soft(
          "Presupuestos",
          gall(ctx, `${act}/adsets`, {
            fields: "campaign_id,daily_budget,effective_status",
            filtering: [{ field: "campaign.id", operator: "IN", value: campaignIds }],
            limit: "500",
          }),
          []
        )
      : [],
    soft("Objetos del historial", byIds(ctx, actChildIds, "campaign_id,name"), {}),
    soft(
      "Piezas",
      byIds(
        ctx,
        adIds,
        "name,effective_status,campaign_id,preview_shareable_link,creative.thumbnail_width(600).thumbnail_height(600){thumbnail_url,image_url,object_type,video_id}"
      ),
      {}
    ),
  ]);

  const budgets = {};
  for (const s of adsets) {
    if (s.effective_status === "ACTIVE" && s.daily_budget) budgets[s.campaign_id] = (budgets[s.campaign_id] || 0) + Number(s.daily_budget) / 100;
  }

  const campaigns = {};
  for (const r of daily) {
    const info = campaignInfo[r.campaign_id] || {};
    const c = (campaigns[r.campaign_id] ||= {
      id: r.campaign_id,
      name: info.name || r.campaign_name,
      kind: kindOf(info.objective || r.objective),
      status: info.effective_status || "",
      budget: info.daily_budget ? Number(info.daily_budget) / 100 : budgets[r.campaign_id] || null,
      daily: {},
    });
    c.daily[r.date_start] = { spend: Number(r.spend) || 0, results: resultOf(c.kind, r) };
  }

  const ads = {};
  for (const id of adIds) {
    const info = adInfo[id] || {};
    const creative = info.creative || {};
    ads[id] = {
      id,
      name: info.name || "",
      status: info.effective_status || "",
      campaignId: info.campaign_id || "",
      thumb: creative.image_url || creative.thumbnail_url || "",
      isVideo: Boolean(creative.video_id) || /VIDEO/i.test(creative.object_type || ""),
      preview: info.preview_shareable_link || "",
      daily: {},
    };
  }
  for (const r of adRows) {
    const a = ads[r.ad_id];
    if (!a) continue;
    a.name ||= r.ad_name || "";
    a.campaignId ||= r.campaign_id || "";
    const kind = campaigns[a.campaignId] ? campaigns[a.campaignId].kind : "other";
    a.daily[r.date_start] = [Number(r.spend) || 0, resultOf(kind, r)];
  }

  for (const a of human) {
    a.campaignId = a.objectType === "CAMPAIGN" ? a.objectId : (parents[a.objectId] && parents[a.objectId].campaign_id) || (adInfo[a.objectId] && adInfo[a.objectId].campaign_id) || "";
    if (a.campaignId && !campaigns[a.campaignId] && a.objectType === "CAMPAIGN") a.campaignName = a.objectName;
  }
  const autoByDate = {};
  for (const a of activities) {
    if (!a.auto || !a.time) continue;
    const d = dateIn(tz, new Date(a.time));
    autoByDate[d] = (autoByDate[d] || 0) + 1;
  }

  return {
    generatedAt: now.toISOString(),
    today,
    timezone: tz,
    account: { name: account.name || "", currency: account.currency || "USD" },
    range: { min, max: today },
    campaigns: Object.values(campaigns),
    activities: human,
    autoByDate,
    ads: Object.values(ads).filter((a) => a.name),
    warnings,
  };
}

// AES-256-GCM con clave derivada por PBKDF2-SHA256. La página lo descifra con Web Crypto.
function encrypt(data, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(password, salt, KDF_ITERATIONS, 32, "sha256");
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const packed = zlib.gzipSync(Buffer.from(JSON.stringify(data), "utf8"));
  const ct = Buffer.concat([cipher.update(packed), cipher.final(), cipher.getAuthTag()]);
  return { v: 1, kdf: "PBKDF2-SHA256", iter: KDF_ITERATIONS, salt: salt.toString("base64"), iv: iv.toString("base64"), ct: ct.toString("base64") };
}

async function main() {
  const token = env("META_ACCESS_TOKEN");
  const accountId = env("META_AD_ACCOUNT_ID").replace(/^act_/, "");
  const password = env("REPORT_PASSWORD");
  if (!token || !accountId || !password) throw new Error("Faltan los secretos META_ACCESS_TOKEN, META_AD_ACCOUNT_ID o REPORT_PASSWORD.");
  if (password.length < 12) throw new Error("REPORT_PASSWORD debe tener al menos 12 caracteres: los datos cifrados quedan en una página pública.");

  const data = await collect({ token, version: env("META_API_VERSION") || "v26.0" }, accountId);

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  fs.copyFileSync(path.join(ROOT, "pagina", "index.html"), path.join(OUT, "index.html"));
  fs.writeFileSync(path.join(OUT, "data.enc.json"), JSON.stringify(encrypt(data, password)));
  fs.writeFileSync(path.join(OUT, "robots.txt"), "User-agent: *\nDisallow: /\n");
  fs.writeFileSync(path.join(OUT, ".nojekyll"), "");

  console.log(`Informe generado: ${data.campaigns.length} campañas, ${data.activities.length} cambios, ${data.ads.length} anuncios, ${data.warnings.length} avisos.`);
}

main().catch((e) => {
  const expired = e.code === 190;
  console.error(expired ? "Error: el token de Meta venció o no es válido. Genera uno nuevo y actualiza el secreto META_ACCESS_TOKEN." : `Error: ${e.message}`);
  process.exit(1);
});
