import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { pbkdf2Sync, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const publicRoot = resolve(root, "public");
const dataDir = resolve(root, process.env.DATA_DIR || "data");
const dbPath = resolve(dataDir, process.env.DB_FILE || "wishlist.sqlite");
const port = Number(process.env.PORT || 3000);
const cookieName = "wishlist_session";
const sessionSeconds = 60 * 60 * 24 * 30;
const passwordIterations = 310_000;
const passwordBytes = 32;
const loginFailures = new Map();

if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 16) {
  console.error("ADMIN_PASSWORD is missing or too short. Start the app with the supplied .env file.");
  process.exit(1);
}
mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
db.exec(`
  CREATE TABLE IF NOT EXISTS members (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0,1)),
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS access_rules (
    owner_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    viewer_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    can_view INTEGER NOT NULL DEFAULT 0 CHECK (can_view IN (0,1)),
    can_suggest INTEGER NOT NULL DEFAULT 0 CHECK (can_suggest IN (0,1)),
    PRIMARY KEY (owner_id, viewer_id),
    CHECK (owner_id <> viewer_id),
    CHECK (can_suggest = 0 OR can_view = 1)
  );
  CREATE TABLE IF NOT EXISTS wishes (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    url TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    archived_at TEXT
  );
  CREATE TABLE IF NOT EXISTS suggestions (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    author_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    event_type TEXT NOT NULL,
    username TEXT NOT NULL DEFAULT '',
    display_name TEXT NOT NULL DEFAULT '',
    target_username TEXT NOT NULL DEFAULT '',
    target_name TEXT NOT NULL DEFAULT '',
    ip TEXT NOT NULL DEFAULT '',
    user_agent TEXT NOT NULL DEFAULT '',
    details TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS sessions_member_idx ON sessions(member_id);
  CREATE INDEX IF NOT EXISTS wishes_owner_created_idx ON wishes(owner_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS suggestions_owner_created_idx ON suggestions(owner_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs(created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS audit_logs_username_idx ON audit_logs(username, created_at DESC);
`);

// Add the archive marker to databases created by earlier versions.
const wishColumns = db.prepare("PRAGMA table_info(wishes)").all();
if (!wishColumns.some((column) => column.name === "archived_at")) {
  db.exec("ALTER TABLE wishes ADD COLUMN archived_at TEXT");
}

if (db.prepare("SELECT COUNT(*) AS n FROM members").get().n === 0) {
  const username = (process.env.ADMIN_USERNAME || "admin").trim().toLowerCase();
  const salt = randomBytes(16).toString("hex");
  const hash = hashPassword(process.env.ADMIN_PASSWORD, salt);
  db.prepare("INSERT INTO members (id,name,username,password_salt,password_hash,is_admin,created_at) VALUES (?,?,?,?,?,1,?)")
    .run(randomBytes(16).toString("hex"), "Организатор", username, salt, hash, new Date().toISOString());
  console.log(`Created first administrator account: ${username}`);
}

function hashPassword(password, saltHex) {
  return pbkdf2Sync(password, Buffer.from(saltHex, "hex"), passwordIterations, passwordBytes, "sha256").toString("hex");
}
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function requestIp(req) {
  if (process.env.TRUST_PROXY === "1") {
    const forwarded = req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || req.headers["x-real-ip"];
    const candidate = String(forwarded || "").split(",")[0].trim();
    if (isIP(candidate)) return candidate;
  }
  return req.socket.remoteAddress || "unknown";
}
function audit(req, eventType, actor = null, { username = "", name = "", targetUsername = "", targetName = "", details = {} } = {}) {
  db.prepare(`INSERT INTO audit_logs (created_at,event_type,username,display_name,target_username,target_name,ip,user_agent,details)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    new Date().toISOString(), eventType,
    String(actor?.username || username).slice(0, 80), String(actor?.name || name).slice(0, 80),
    String(targetUsername).slice(0, 80), String(targetName).slice(0, 80), requestIp(req),
    String(req.headers["user-agent"] || "").slice(0, 500), JSON.stringify(details),
  );
}
function send(res, status, data, extra = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...securityHeaders(), ...extra });
  res.end(JSON.stringify(data));
}
function securityHeaders() {
  return {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "same-origin",
    "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  };
}
function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) { reject(new Error("Слишком большой запрос.")); req.destroy(); }
    });
    req.on("end", () => {
      try { resolveBody(body ? JSON.parse(body) : {}); }
      catch { reject(new Error("Некорректный JSON.")); }
    });
    req.on("error", reject);
  });
}
function originIsLocal(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try { return new URL(origin).host === req.headers.host; }
  catch { return false; }
}
function cookieToken(req) {
  const raw = req.headers.cookie || "";
  const part = raw.split(";").map((value) => value.trim()).find((value) => value.startsWith(`${cookieName}=`));
  return part?.slice(cookieName.length + 1) || "";
}
function cookieHeader(req, token, maxAge) {
  const forwardedHttps = process.env.TRUST_PROXY === "1" && req.headers["x-forwarded-proto"] === "https";
  const secure = forwardedHttps || (process.env.TRUST_PROXY !== "1" && req.socket.encrypted) ? "; Secure" : "";
  return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}
function memberFromRequest(req) {
  const token = cookieToken(req);
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  return db.prepare(`SELECT m.id,m.name,m.username,m.is_admin FROM sessions s JOIN members m ON m.id=s.member_id
    WHERE s.token_hash=? AND s.expires_at>?`).get(sha256(token), Math.floor(Date.now() / 1000)) || null;
}
function needSameOrigin(req, res) {
  if (originIsLocal(req)) return true;
  send(res, 403, { error: "Отклонён запрос с другого сайта." });
  return false;
}
function needMember(req, res) {
  const member = memberFromRequest(req);
  if (member) return member;
  send(res, 401, { error: "Сначала войдите в аккаунт." });
  return null;
}
function needAdmin(member, res) {
  if (member.is_admin) return true;
  send(res, 403, { error: "Это действие доступно только организатору." });
  return false;
}
function fail(res, error, status = 400) { send(res, status, { error }); }
function isValidUsername(value) { return /^[a-z0-9._-]{3,32}$/.test(value); }
function memberListFor(member) {
  if (member.is_admin) return db.prepare("SELECT id,name,username,is_admin FROM members ORDER BY name COLLATE NOCASE").all();
  return db.prepare(`SELECT id,name,username,is_admin FROM members WHERE id=? OR id IN
    (SELECT owner_id FROM access_rules WHERE viewer_id=? AND can_view=1) ORDER BY name COLLATE NOCASE`).all(member.id, member.id);
}
function bootstrap(member) {
  const members = memberListFor(member);
  const access = member.is_admin
    ? db.prepare("SELECT owner_id,viewer_id,can_view,can_suggest FROM access_rules").all()
    : db.prepare("SELECT owner_id,viewer_id,can_view,can_suggest FROM access_rules WHERE viewer_id=? OR owner_id=?").all(member.id, member.id);
  const wishes = db.prepare(`SELECT w.id,w.owner_id AS ownerId,w.title,w.url,w.note,w.created_at AS createdAt,m.name AS ownerName
    FROM wishes w JOIN members m ON m.id=w.owner_id
    WHERE w.archived_at IS NULL AND (w.owner_id=? OR EXISTS(SELECT 1 FROM access_rules a WHERE a.owner_id=w.owner_id AND a.viewer_id=? AND a.can_view=1))
    ORDER BY w.created_at DESC`).all(member.id, member.id);
  const archivedWishes = db.prepare(`SELECT id,owner_id AS ownerId,title,url,note,created_at AS createdAt
    FROM wishes WHERE owner_id=? AND archived_at IS NOT NULL ORDER BY archived_at DESC`).all(member.id);
  const suggestions = db.prepare(`SELECT s.id,s.owner_id AS ownerId,s.author_id AS authorId,s.body,s.created_at AS createdAt,
    a.name AS authorName,o.name AS ownerName FROM suggestions s JOIN members a ON a.id=s.author_id JOIN members o ON o.id=s.owner_id
    WHERE s.owner_id=? OR s.author_id=? ORDER BY s.created_at DESC`).all(member.id, member.id);
  return { current: { id: member.id, name: member.name, username: member.username, isAdmin: !!member.is_admin }, members, access, wishes, archivedWishes, suggestions };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  try {
    if (req.method === "GET" && url.pathname === "/api/data") {
      const member = needMember(req, res);
      if (member) send(res, 200, bootstrap(member));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/audit-logs") {
      const member = needMember(req, res); if (!member || !needAdmin(member, res)) return;
      const q = String(url.searchParams.get("q") || "").trim().slice(0, 120);
      const eventType = String(url.searchParams.get("event") || "");
      const from = String(url.searchParams.get("from") || "");
      const to = String(url.searchParams.get("to") || "");
      const order = url.searchParams.get("order") === "oldest" ? "ASC" : "DESC";
      const page = Math.max(1, Math.min(10000, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1));
      const filters = [];
      const params = [];
      if (q) {
        filters.push("(username LIKE ? OR display_name LIKE ? OR target_username LIKE ? OR target_name LIKE ? OR ip LIKE ? OR user_agent LIKE ? OR details LIKE ?)");
        const pattern = `%${q}%`; params.push(pattern, pattern, pattern, pattern, pattern, pattern, pattern);
      }
      if (eventType && eventType !== "all") { filters.push("event_type=?"); params.push(eventType); }
      if (/^\d{4}-\d{2}-\d{2}$/.test(from)) { filters.push("created_at>=?"); params.push(`${from}T00:00:00.000Z`); }
      if (/^\d{4}-\d{2}-\d{2}$/.test(to)) { filters.push("created_at<=?"); params.push(`${to}T23:59:59.999Z`); }
      const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
      const total = db.prepare(`SELECT COUNT(*) AS n FROM audit_logs ${where}`).get(...params).n;
      const rows = db.prepare(`SELECT id,created_at AS createdAt,event_type AS eventType,username,display_name AS displayName,
        target_username AS targetUsername,target_name AS targetName,ip,user_agent AS userAgent,details
        FROM audit_logs ${where} ORDER BY created_at ${order},id ${order} LIMIT 100 OFFSET ?`).all(...params, (page - 1) * 100);
      send(res, 200, { rows: rows.map((row) => ({ ...row, details: JSON.parse(row.details || "{}") })), total, page, pages: Math.max(1, Math.ceil(total / 100)), ipSource: process.env.TRUST_PROXY === "1" ? "proxy" : "direct" });
      return;
    }
    if (req.method === "POST" && !needSameOrigin(req, res)) return;
    if (req.method === "POST" && url.pathname === "/api/visit") {
      const member = needMember(req, res); if (!member) return;
      audit(req, "site_visit", member);
      send(res, 200, { ok: true });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/login") {
      const body = await readBody(req);
      const username = String(body.username || "").trim().toLowerCase();
      const password = String(body.password || "");
      const ip = requestIp(req);
      const now = Date.now();
      const state = loginFailures.get(ip);
      if (state && now - state.start < 15 * 60_000 && state.count >= 8) {
        audit(req, "login_blocked", null, { username, details: { reason: "rate_limited" } });
        return fail(res, "Слишком много попыток. Подождите 15 минут.", 429);
      }
      const account = db.prepare("SELECT id,name,username,is_admin,password_salt,password_hash FROM members WHERE username=? COLLATE NOCASE").get(username);
      const salt = account?.password_salt || "00000000000000000000000000000000";
      const actual = Buffer.from(hashPassword(password.slice(0, 256), salt), "hex");
      const expected = Buffer.from(account?.password_hash || "00".repeat(passwordBytes), "hex");
      const valid = !!account && timingSafeEqual(actual, expected);
      if (!valid) {
        const prior = state && now - state.start < 15 * 60_000 ? state : { start: now, count: 0 };
        loginFailures.set(ip, { start: prior.start, count: prior.count + 1 });
        audit(req, "login_failed", null, { username, details: { reason: "invalid_credentials" } });
        return fail(res, "Неверный логин или пароль.", 401);
      }
      loginFailures.delete(ip);
      db.prepare("DELETE FROM sessions WHERE expires_at<=?").run(Math.floor(now / 1000));
      const token = randomBytes(32).toString("hex");
      db.prepare("INSERT INTO sessions (token_hash,member_id,expires_at,created_at) VALUES (?,?,?,?)")
        .run(sha256(token), account.id, Math.floor(now / 1000) + sessionSeconds, Math.floor(now / 1000));
      audit(req, "login_success", account);
      send(res, 200, { ok: true }, { "set-cookie": cookieHeader(req, token, sessionSeconds) });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/logout") {
      const member = memberFromRequest(req);
      const token = cookieToken(req);
      if (/^[a-f0-9]{64}$/.test(token)) db.prepare("DELETE FROM sessions WHERE token_hash=?").run(sha256(token));
      if (member) audit(req, "logout", member);
      send(res, 200, { ok: true }, { "set-cookie": cookieHeader(req, "", 0) });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/members") {
      const member = needMember(req, res); if (!member || !needAdmin(member, res)) return;
      const body = await readBody(req);
      const name = String(body.name || "").trim().slice(0, 80);
      const username = String(body.username || "").trim().toLowerCase();
      const password = String(body.password || "");
      if (!name || !isValidUsername(username) || password.length < 12 || password.length > 256) return fail(res, "Имя обязательно, логин — 3–32 символа, пароль — не менее 12 символов.");
      const salt = randomBytes(16).toString("hex");
      try {
        const id = randomBytes(16).toString("hex");
        db.prepare("INSERT INTO members (id,name,username,password_salt,password_hash,is_admin,created_at) VALUES (?,?,?,?,?,0,?)")
          .run(id, name, username, salt, hashPassword(password, salt), new Date().toISOString());
        audit(req, "member_created", member, { targetUsername: username, targetName: name });
      } catch (error) {
        if (String(error).includes("UNIQUE")) return fail(res, "Такой логин уже занят.", 409);
        throw error;
      }
      send(res, 201, { ok: true });
      return;
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/members/") && url.pathname.endsWith("/password")) {
      const member = needMember(req, res); if (!member || !needAdmin(member, res)) return;
      const id = decodeURIComponent(url.pathname.slice("/api/members/".length, -"/password".length));
      const target = db.prepare("SELECT id,name,username,is_admin FROM members WHERE id=?").get(id);
      if (!target || target.is_admin) return fail(res, "Пароль этого аккаунта нельзя изменить здесь.", 404);
      const body = await readBody(req);
      const password = String(body.password || "");
      if (password.length < 12 || password.length > 256) return fail(res, "Новый пароль должен содержать от 12 до 256 символов.");
      const salt = randomBytes(16).toString("hex");
      db.prepare("UPDATE members SET password_salt=?,password_hash=? WHERE id=?")
        .run(salt, hashPassword(password, salt), id);
      db.prepare("DELETE FROM sessions WHERE member_id=?").run(id);
      audit(req, "password_changed", member, { targetUsername: target.username, targetName: target.name });
      send(res, 200, { ok: true });
      return;
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/api/members/")) {
      const member = needMember(req, res); if (!member || !needSameOrigin(req, res) || !needAdmin(member, res)) return;
      const id = decodeURIComponent(url.pathname.slice("/api/members/".length));
      const target = db.prepare("SELECT id,name,username,is_admin FROM members WHERE id=?").get(id);
      if (!target) return fail(res, "Участник не найден.", 404);
      if (target.is_admin || target.id === member.id) return fail(res, "Аккаунт организатора удалить нельзя.", 400);
      db.prepare("DELETE FROM members WHERE id=?").run(id);
      audit(req, "member_deleted", member, { targetUsername: target.username, targetName: target.name });
      send(res, 200, { ok: true });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/wishes") {
      const member = needMember(req, res); if (!member) return;
      const body = await readBody(req);
      const title = String(body.title || "").trim().slice(0, 120);
      const note = String(body.note || "").trim().slice(0, 500);
      const rawUrl = String(body.url || "").trim().slice(0, 500);
      if (!title) return fail(res, "Введите название желания.");
      let safeUrl = "";
      if (rawUrl) {
        try {
          const parsed = new URL(rawUrl);
          if (!["http:", "https:"].includes(parsed.protocol)) return fail(res, "Ссылка должна начинаться с http:// или https://.");
          safeUrl = parsed.toString();
        } catch { return fail(res, "Проверьте ссылку на подарок."); }
      }
      db.prepare("INSERT INTO wishes (id,owner_id,title,url,note,created_at) VALUES (?,?,?,?,?,?)")
        .run(randomBytes(16).toString("hex"), member.id, title, safeUrl, note, new Date().toISOString());
      audit(req, "wish_added", member, { details: { title, url: safeUrl, note } });
      send(res, 201, { ok: true });
      return;
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/api/wishes/")) {
      const member = needMember(req, res); if (!member || !needSameOrigin(req, res)) return;
      const id = decodeURIComponent(url.pathname.slice("/api/wishes/".length));
      const wish = db.prepare("SELECT title,url,note FROM wishes WHERE id=? AND owner_id=?").get(id, member.id);
      db.prepare("DELETE FROM wishes WHERE id=? AND owner_id=?").run(id, member.id);
      if (wish) audit(req, "wish_deleted", member, { details: wish });
      send(res, 200, { ok: true });
      return;
    }
    const wishStateMatch = url.pathname.match(/^\/api\/wishes\/([^/]+)\/(archive|restore)$/);
    if (req.method === "POST" && wishStateMatch) {
      const member = needMember(req, res); if (!member || !needSameOrigin(req, res)) return;
      const id = decodeURIComponent(wishStateMatch[1]);
      const action = wishStateMatch[2];
      const wish = db.prepare("SELECT title FROM wishes WHERE id=? AND owner_id=?").get(id, member.id);
      if (!wish) return fail(res, "Желание не найдено.", 404);
      if (action === "archive") {
        db.prepare("UPDATE wishes SET archived_at=? WHERE id=? AND owner_id=?").run(new Date().toISOString(), id, member.id);
        audit(req, "wish_archived", member, { details: { title: wish.title } });
      } else {
        db.prepare("UPDATE wishes SET archived_at=NULL WHERE id=? AND owner_id=?").run(id, member.id);
        audit(req, "wish_restored", member, { details: { title: wish.title } });
      }
      send(res, 200, { ok: true });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/suggestions") {
      const member = needMember(req, res); if (!member) return;
      const body = await readBody(req);
      const ownerId = String(body.ownerId || "");
      const text = String(body.text || "").trim().slice(0, 500);
      const grant = db.prepare("SELECT 1 FROM access_rules WHERE owner_id=? AND viewer_id=? AND can_view=1 AND can_suggest=1").get(ownerId, member.id);
      if (!grant) return fail(res, "Предложения для этого списка не разрешены.", 403);
      if (!text) return fail(res, "Напишите предложение.");
      db.prepare("INSERT INTO suggestions (id,owner_id,author_id,body,created_at) VALUES (?,?,?,?,?)")
        .run(randomBytes(16).toString("hex"), ownerId, member.id, text, new Date().toISOString());
      const owner = db.prepare("SELECT name,username FROM members WHERE id=?").get(ownerId);
      audit(req, "suggestion_added", member, { targetUsername: owner?.username, targetName: owner?.name, details: { text } });
      send(res, 201, { ok: true });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/access") {
      const member = needMember(req, res); if (!member || !needAdmin(member, res)) return;
      const body = await readBody(req);
      const ownerId = String(body.ownerId || "");
      const viewerId = String(body.viewerId || "");
      const canView = body.canView === true;
      const canSuggest = body.canSuggest === true && canView;
      if (!ownerId || !viewerId || ownerId === viewerId) return fail(res, "Неверно выбрана пара участников.");
      const prior = db.prepare("SELECT can_view,can_suggest FROM access_rules WHERE owner_id=? AND viewer_id=?").get(ownerId, viewerId) || { can_view: 0, can_suggest: 0 };
      const owner = db.prepare("SELECT name,username FROM members WHERE id=?").get(ownerId);
      const viewer = db.prepare("SELECT name,username FROM members WHERE id=?").get(viewerId);
      db.prepare(`INSERT INTO access_rules (owner_id,viewer_id,can_view,can_suggest) VALUES (?,?,?,?)
        ON CONFLICT(owner_id,viewer_id) DO UPDATE SET can_view=excluded.can_view,can_suggest=excluded.can_suggest`)
        .run(ownerId, viewerId, Number(canView), Number(canSuggest));
      audit(req, "access_changed", member, { targetUsername: owner?.username, targetName: owner?.name, details: {
        viewer: viewer?.username || viewerId, before: { canView: !!prior.can_view, canSuggest: !!prior.can_suggest }, after: { canView, canSuggest },
      } });
      send(res, 200, { ok: true });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/access/bulk") {
      const member = needMember(req, res); if (!member || !needAdmin(member, res)) return;
      const body = await readBody(req);
      if (!Array.isArray(body.pairs) || body.pairs.length > 1000 || typeof body.canView !== "boolean") return fail(res, "Некорректный набор прав доступа.");
      const memberIds = new Set(db.prepare("SELECT id FROM members").all().map((row) => row.id));
      const memberInfo = new Map(db.prepare("SELECT id,name,username FROM members").all().map((row) => [row.id, row]));
      const pairs = new Map();
      for (const pair of body.pairs) {
        const ownerId = String(pair?.ownerId || "");
        const viewerId = String(pair?.viewerId || "");
        if (!ownerId || !viewerId || ownerId === viewerId || !memberIds.has(ownerId) || !memberIds.has(viewerId)) return fail(res, "В наборе есть неверная пара участников.");
        pairs.set(`${ownerId}:${viewerId}`, { ownerId, viewerId });
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        const update = db.prepare(`INSERT INTO access_rules (owner_id,viewer_id,can_view,can_suggest) VALUES (?,?,?,0)
          ON CONFLICT(owner_id,viewer_id) DO UPDATE SET
            can_suggest=CASE WHEN excluded.can_view=1 THEN access_rules.can_suggest ELSE 0 END,
            can_view=excluded.can_view`);
        for (const { ownerId, viewerId } of pairs.values()) update.run(ownerId, viewerId, Number(body.canView));
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      audit(req, "access_bulk_changed", member, { details: {
        canView: body.canView,
        updated: pairs.size,
        pairs: Array.from(pairs.values(), ({ ownerId, viewerId }) => ({ owner: memberInfo.get(ownerId)?.username, viewer: memberInfo.get(viewerId)?.username })),
      } });
      send(res, 200, { ok: true, updated: pairs.size });
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") { send(res, 404, { error: "Не найдено." }); return; }
    const relative = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const file = resolve(publicRoot, `.${relative}`);
    if (!file.startsWith(publicRoot + sep) && file !== resolve(publicRoot, "index.html")) { send(res, 404, { error: "Не найдено." }); return; }
    if (!existsSync(file) || !statSync(file).isFile()) { send(res, 404, { error: "Не найдено." }); return; }
    const mime = ({ ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" })[extname(file)] || "application/octet-stream";
    res.writeHead(200, { "content-type": mime, "cache-control": "no-store", ...securityHeaders() });
    res.end(req.method === "HEAD" ? undefined : readFileSync(file));
  } catch (error) {
    console.error("Request failed:", error?.message || "unknown error");
    if (!res.headersSent) send(res, 500, { error: "Внутренняя ошибка сервера." });
    else res.end();
  }
});

server.listen(port, "0.0.0.0", () => console.log(`Письмо Деду Морозу доступно на http://localhost:${port}`));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { db.close(); server.close(() => process.exit(0)); });
