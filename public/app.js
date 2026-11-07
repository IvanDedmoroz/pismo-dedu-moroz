const loginView = document.querySelector("#login-view");
const appView = document.querySelector("#app-view");
const loginError = document.querySelector("#login-error");
const appError = document.querySelector("#app-error");
const appNotice = document.querySelector("#app-notice");
const themeNames = { renaissance: "Леонардо да Винчи", impressionist: "Импрессионисты", lubok: "Сказочный лубок", moscow: "Новый год в Москве" };
let data = null;
let selectedId = "";
let showArchivedWishes = false;
let showArchivedFeedback = false;
let feedbackRows = [];
let currentTab = "list";
let busy = false;
let visitLogged = false;
let auditState = { rows: [], total: 0, page: 1, pages: 1, ipSource: "direct" };

const byId = (id) => document.getElementById(id);
const node = (tag, className = "", text = "") => {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== "") item.textContent = text;
  return item;
};
const avatarNames = ["Дед Мороз", "Снегурочка", "Снеговик", "Олень", "Лисёнок", "Медвежонок", "Сова", "Пингвин", "Зайчик", "Белочка", "Волк", "Кот", "Щенок", "Ёжик", "Лось", "Снегирь", "Тюлень", "Пряничный человечек", "Эльф", "Зимняя фея"];
function makeAvatar(key, fallback = "?") {
  if (!key) return node("span", "avatar-fallback", fallback);
  const image = document.createElement("img"); image.src = `/avatars/${key}.svg`; image.alt = ""; image.loading = "lazy";
  image.onerror = () => { image.remove(); };
  return image;
}
function renderAvatar(target, key, fallback) { target.replaceChildren(makeAvatar(key, fallback)); }
function message(target, text) { target.textContent = text; target.hidden = !text; }
function showLogin(error = "") { loginView.hidden = false; appView.hidden = true; message(loginError, error); }
function showApp() { loginView.hidden = true; appView.hidden = false; message(loginError, ""); }
function applyTheme(theme) {
  if (!themeNames[theme]) theme = "moscow";
  document.body.dataset.theme = theme;
  const art = byId("hero-art");
  if (art) { art.src = `/goat-${theme}.webp`; art.alt = `Красная Огненная Коза — тема «${themeNames[theme]}»`; }
}
function renderThemeSettings() {
  if (!data?.current.isAdmin || !data.theme) return;
  document.querySelectorAll("[data-theme-mode]").forEach((button) => {
    const selected = button.dataset.themeMode === data.theme.mode;
    button.classList.toggle("active", selected); button.setAttribute("aria-pressed", String(selected));
  });
  document.querySelectorAll("[data-theme-choice]").forEach((button) => {
    const selected = button.dataset.themeChoice === data.theme.theme;
    button.classList.toggle("selected", selected); button.setAttribute("aria-pressed", String(selected));
  });
  byId("theme-status").textContent = data.theme.mode === "daily"
    ? `Автоматический режим: оформление меняется раз в сутки по московскому времени. Сегодня — «${themeNames[data.theme.theme]}».`
    : `Сейчас выбрана тема «${themeNames[data.theme.theme]}». Она будет общей для всех участников.`;
}
async function saveTheme(mode, theme = data?.theme?.theme) {
  const result = await api("/api/theme", { method: "POST", body: JSON.stringify({ mode, theme }) });
  data.theme = result.theme; applyTheme(result.theme.theme); renderThemeSettings();
}
function setBusy(value) { busy = value; document.querySelectorAll("button[type=submit]").forEach((b) => b.disabled = value); }
async function api(path, options = {}) {
  const response = await fetch(path, { cache: "no-store", ...options, headers: { ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers || {}) } });
  const result = await response.json().catch(() => ({}));
  if (response.status === 401 && path !== "/api/login") { showLogin(""); throw new Error("Сеанс завершён. Войдите снова."); }
  if (!response.ok) throw new Error(result.error || "Не удалось выполнить запрос.");
  return result;
}
async function load() {
  try {
    data = await api("/api/data");
    applyTheme(data.theme?.theme);
    if (!selectedId || !data.members.some((m) => m.id === selectedId)) selectedId = data.current.id;
    if (!visitLogged) {
      visitLogged = true;
      api("/api/visit", { method: "POST", body: "{}" }).catch(() => {});
    }
    showApp(); render();
  } catch (error) {
    if (error.message !== "Сеанс завершён. Войдите снова.") showLogin("");
  }
}
function activeRule(ownerId, viewerId) {
  return data.access.find((item) => item.owner_id === ownerId && item.viewer_id === viewerId) || { can_view: 0, can_suggest: 0 };
}
function render() {
  if (!data) return;
  renderAvatar(byId("user-avatar"), data.current.avatarKey, (data.current.name || "?").slice(0, 1).toUpperCase());
  byId("user-label").textContent = data.current.name;
  byId("access-tab").hidden = !data.current.isAdmin;
  byId("audit-tab").hidden = !data.current.isAdmin;
  byId("feedback-tab").classList.toggle("active", currentTab === "feedback");
  byId("access-tab").classList.toggle("active", currentTab === "access");
  byId("audit-tab").classList.toggle("active", currentTab === "audit");
  document.querySelector('[data-tab="list"]').classList.toggle("active", currentTab === "list");
  byId("list-panel").hidden = currentTab !== "list";
  byId("feedback-panel").hidden = currentTab !== "feedback";
  byId("access-panel").hidden = currentTab !== "access" || !data.current.isAdmin;
  byId("audit-panel").hidden = currentTab !== "audit" || !data.current.isAdmin;
  if (currentTab === "access" && data.current.isAdmin) { renderMatrix(); renderThemeSettings(); }
  else if (currentTab === "audit" && data.current.isAdmin) loadAudit();
  else if (currentTab === "list") renderWishlist();
  else if (currentTab === "feedback") loadFeedback();
}
function renderWishlist() {
  const own = selectedId === data.current.id;
  const selected = data.members.find((m) => m.id === selectedId);
  const accessible = data.members.filter((m) => m.id === data.current.id || activeRule(m.id, data.current.id).can_view);
  const people = byId("people-row");
  people.replaceChildren();
  accessible.forEach((member) => {
    const chip = node("button", `person-chip ${member.id === selectedId ? "selected" : ""}`);
    chip.type = "button"; chip.dataset.member = member.id;
    const avatar = node("span", "avatar small"); renderAvatar(avatar, member.avatarKey, member.name.slice(0, 1).toUpperCase()); chip.append(avatar);
    chip.append(node("span", "", member.id === data.current.id ? "Мои желания" : member.name));
    chip.append(node("span", "chip-count", String(data.wishes.filter((wish) => wish.ownerId === member.id).length)));
    people.append(chip);
  });
  byId("circle-hint").textContent = accessible.length === 1 ? "Пока здесь только ваш список." : "Выберите, чьи желания посмотреть.";
  byId("add-wish-toggle").hidden = !own;
  byId("wish-form").hidden = own ? byId("wish-form").hidden : true;
  byId("wish-view-toggle").hidden = !own;
  byId("active-wishes-toggle").classList.toggle("active", !showArchivedWishes);
  byId("archived-wishes-toggle").classList.toggle("active", showArchivedWishes);
  byId("archive-count").textContent = String(data.archivedWishes.length);
  byId("wish-title").textContent = own ? (showArchivedWishes ? "Архив желаний" : "Мои желания") : `Желания: ${selected?.name || ""}`;
  const wishes = (showArchivedWishes && own ? data.archivedWishes : data.wishes).filter((wish) => wish.ownerId === selectedId);
  byId("wish-count").textContent = `${wishes.length} ${wishes.length === 1 ? "пожелание" : "пожеланий"}`;
  const grid = byId("wish-grid"); grid.replaceChildren();
  if (!wishes.length) {
    const empty = node("div", "empty-state");
    empty.append(node("span", "", "✧"), node("h3", "", own ? (showArchivedWishes ? "Архив пока пуст" : "Здесь появятся ваши желания") : "Список пока пуст"));
    empty.append(node("p", "", own ? (showArchivedWishes ? "Уберите сюда желания, которые пока не нужны в общем списке." : "Добавьте первую идею — её увидят только вы, пока вы не откроете доступ.") : "У этого участника пока нет желаний."));
    if (own && !showArchivedWishes) { const add = node("button", "text-button", "Добавить первое желание →"); add.type = "button"; add.addEventListener("click", () => { byId("wish-form").hidden = false; }); empty.append(add); }
    grid.append(empty);
  } else wishes.forEach((wish, index) => {
    const card = node("article", "wish-card");
    card.append(node("span", "wish-number", String(index + 1).padStart(2, "0")));
    card.append(node("div", "wish-icon", ["✧", "❄", "✦", "♡"][index % 4]));
    card.append(node("h4", "", wish.title));
    if (wish.note) card.append(node("p", "", wish.note));
    const foot = node("div", "wish-card-foot");
    if (wish.url) { const link = node("a", "", "Посмотреть подарок ↗"); link.href = wish.url; link.target = "_blank"; link.rel = "noopener noreferrer"; foot.append(link); }
    if (own) {
      if (showArchivedWishes) {
        const restore = node("button", "wish-action", "Вернуть в желания"); restore.type = "button"; restore.dataset.restoreWish = wish.id; foot.append(restore);
        const del = node("button", "delete-link", "Удалить навсегда"); del.type = "button"; del.dataset.deleteWish = wish.id; foot.append(del);
      } else {
        const archive = node("button", "wish-action", "В архив"); archive.type = "button"; archive.dataset.archiveWish = wish.id; foot.append(archive);
        const del = node("button", "delete-link", "Удалить"); del.type = "button"; del.dataset.deleteWish = wish.id; foot.append(del);
      }
    }
    const claim = data.giftClaims.find((item) => item.wishId === wish.id) || { count: 0, claimedByMe: false, people: [] };
    if (!showArchivedWishes) {
      const claimBox = node("div", `gift-claims ${own ? "gift-claims-owner" : ""}`);
      const countWord = claim.count % 10 === 1 && claim.count % 100 !== 11 ? "участник" : claim.count % 10 >= 2 && claim.count % 10 <= 4 && (claim.count % 100 < 12 || claim.count % 100 > 14) ? "участника" : "участников";
      const countText = claim.count ? `${claim.count} ${countWord} ${claim.count === 1 ? "готов" : "готовы"} подарить` : "Пока никто не отметил готовность";
      const count = node("span", "gift-claim-count", countText);
      claimBox.append(count);
      if (own) claimBox.append(node("small", "gift-claim-privacy", "Кто именно — видит только организатор."));
      else {
        const pledge = node("button", `wish-action gift-claim-button ${claim.claimedByMe ? "claimed" : ""}`, claim.claimedByMe ? "✓ Вы готовы подарить · отменить" : "♡ Готов(а) подарить");
        pledge.type = "button"; pledge.dataset.claimWish = wish.id; pledge.dataset.unclaimWish = claim.claimedByMe ? wish.id : ""; claimBox.append(pledge);
        claimBox.append(node("small", "gift-claim-privacy", "Участники видят только число отметок."));
      }
      if (data.current.isAdmin && claim.people.length) {
        const names = node("small", "gift-claim-names", `Отметили: ${claim.people.map((person) => person.name).join(", ")}`);
        claimBox.append(names);
      }
      card.append(claimBox);
    }
    card.append(foot); grid.append(card);
  });
  const suggest = !own && !!activeRule(selectedId, data.current.id).can_suggest;
  byId("suggest-form").hidden = !suggest;
  const ideas = data.suggestions.filter((item) => item.ownerId === data.current.id);
  byId("suggestions").hidden = !own || !ideas.length;
  const ideaList = byId("suggestion-list"); ideaList.replaceChildren();
  ideas.forEach((idea) => {
    const row = node("article", "suggestion");
    row.append(node("span", "avatar small", idea.authorName.slice(0, 1).toUpperCase()));
    const text = node("div"); text.append(node("strong", "", idea.authorName), node("p", "", idea.body)); row.append(text, node("span", "suggestion-mark", "✦")); ideaList.append(row);
  });
}
function renderMatrix() {
  const wrap = byId("matrix-wrap"); wrap.replaceChildren();
  const table = node("table", "access-table");
  const layout = data.matrixLayout && typeof data.matrixLayout === "object" ? data.matrixLayout : {};
  const columns = layout.columns || {}; const rowHeights = layout.rows || {};
  const colgroup = node("colgroup");
  const labelCol = node("col"); labelCol.dataset.layoutKey = "label"; labelCol.style.width = `${columns.label || 210}px`; colgroup.append(labelCol);
  data.members.forEach((member) => { const col = node("col"); col.dataset.layoutKey = member.id; col.style.width = `${columns[member.id] || 164}px`; colgroup.append(col); });
  table.append(colgroup);
  const allPairs = [];
  data.members.forEach((viewer) => data.members.forEach((owner) => { if (viewer.id !== owner.id) allPairs.push({ ownerId: owner.id, viewerId: viewer.id }); }));
  const thead = node("thead"); const headRow = node("tr");
  const corner = node("th", "matrix-label-column"); corner.append(node("strong", "", "Кто смотрит ↓ / чей список →"));
  if (allPairs.length) corner.append(bulkAccessControl("Весь доступ", allPairs));
  corner.append(matrixResizeHandle("column", "label", "Изменить ширину названий"));
  headRow.append(corner);
  data.members.forEach((owner) => {
    const th = node("th"); th.append(node("strong", "", owner.name), node("small", "", owner.username));
    const pairs = data.members.filter((viewer) => viewer.id !== owner.id).map((viewer) => ({ ownerId: owner.id, viewerId: viewer.id }));
    if (pairs.length) th.append(bulkAccessControl("Весь столбец", pairs));
    th.append(matrixResizeHandle("column", owner.id, `Изменить ширину столбца ${owner.name}`));
    headRow.append(th);
  });
  thead.append(headRow); table.append(thead);
  const tbody = node("tbody");
  data.members.forEach((viewer) => {
    const row = node("tr"); if (rowHeights[viewer.id]) row.style.height = `${rowHeights[viewer.id]}px`;
    const label = node("th", "matrix-row-label"); label.append(node("strong", "", viewer.name), node("small", "", `${viewer.username}${viewer.is_admin ? " · организатор" : ""}`));
    const pairs = data.members.filter((owner) => owner.id !== viewer.id).map((owner) => ({ ownerId: owner.id, viewerId: viewer.id }));
    if (pairs.length) label.append(bulkAccessControl("Вся строка", pairs));
    label.append(matrixResizeHandle("row", viewer.id, `Изменить высоту строки ${viewer.name}`));
    row.append(label);
    data.members.forEach((owner) => {
      const cell = node("td", owner.id === viewer.id ? "self-cell" : "");
      if (owner.id === viewer.id) cell.append(node("span", "self-label", "свой список"));
      else {
        const rule = activeRule(owner.id, viewer.id); const controls = node("div", "perm-cell");
        controls.append(permission("Видеть", "can_view", !!rule.can_view, owner.id, viewer.id, true));
        controls.append(permission("Предложить", "can_suggest", !!rule.can_suggest, owner.id, viewer.id, !!rule.can_view));
        cell.append(controls);
      }
      row.append(cell);
    });
    tbody.append(row);
  });
  table.append(tbody); wrap.append(table); renderMemberManagement();
}
function matrixResizeHandle(axis, key, label) {
  const handle = node("button", `matrix-resize-handle ${axis === "row" ? "row-resize-handle" : "column-resize-handle"}`);
  handle.type = "button"; handle.title = label; handle.setAttribute("aria-label", label);
  handle.dataset.resizeAxis = axis; handle.dataset.resizeKey = key;
  return handle;
}
async function saveMatrixLayout() {
  try { await api("/api/matrix-layout", { method: "POST", body: JSON.stringify(data.matrixLayout || { columns: {}, rows: {} }) }); }
  catch (error) { message(appError, `Не удалось сохранить размеры матрицы: ${error.message}`); }
}
function bulkAccessControl(text, pairs) {
  const label = node("label", "bulk-access");
  const input = document.createElement("input"); input.type = "checkbox"; input.dataset.bulkAccess = "true"; input.checked = pairs.every(({ ownerId, viewerId }) => !!activeRule(ownerId, viewerId).can_view);
  input.indeterminate = !input.checked && pairs.some(({ ownerId, viewerId }) => !!activeRule(ownerId, viewerId).can_view);
  input.dataset.pairs = JSON.stringify(pairs);
  label.append(input, document.createTextNode(text)); return label;
}
function renderMemberManagement() {
  const list = byId("member-management-list"); list.replaceChildren();
  data.members.filter((member) => !member.is_admin).forEach((member) => {
    const card = node("article", "member-card");
    const heading = node("div", "member-card-heading"); heading.append(node("div", "", ""));
    heading.firstChild.append(node("strong", "", member.name), node("small", "", `Логин: ${member.username}`));
    const form = node("form", "member-password-form"); form.dataset.passwordForm = member.id;
    const label = node("label"); label.append(document.createTextNode("Новый пароль"));
    const input = document.createElement("input"); input.name = "password"; input.type = "password"; input.minLength = 12; input.maxLength = 256; input.required = true; input.autocomplete = "new-password"; input.placeholder = "Не менее 12 символов";
    label.append(input);
    const save = node("button", "button secondary", "Сменить пароль"); save.type = "submit";
    form.append(label, save);
    const remove = node("button", "button danger", "Удалить участника"); remove.type = "button"; remove.dataset.deleteMember = member.id;
    heading.append(form, remove); card.append(heading); list.append(card);
  });
  if (!list.childElementCount) list.append(node("p", "table-hint", "Пока нет участников для управления."));
}
const auditEventNames = {
  site_visit: "Посещение сайта", login_success: "Успешный вход", login_failed: "Неудачный вход", login_blocked: "Заблокированная попытка",
  logout: "Выход", member_created: "Создание участника", password_changed: "Смена пароля", member_deleted: "Удаление участника",
  access_changed: "Изменение прав", access_bulk_changed: "Массовое изменение прав", wish_added: "Добавление желания",
  wish_archived: "Желание в архиве", wish_restored: "Желание восстановлено", wish_deleted: "Удаление желания", suggestion_added: "Идея для подарка", theme_changed: "Смена оформления",
  feedback_added: "Комментарий или предложение", feedback_archived: "Запись в архиве", feedback_restored: "Запись восстановлена",
  gift_claim_added: "Готовность сделать подарок", gift_claim_removed: "Отметка о подарке снята",
  database_backup_requested: "Скачивание резервной копии базы",
  avatar_changed: "Смена аватара",
};
function describeAgent(value) {
  const ua = String(value || "");
  const browser = /YaBrowser\/([\d.]+)/.exec(ua)?.[0] ? "Яндекс Браузер" : /Edg\/([\d.]+)/.test(ua) ? "Microsoft Edge" : /Firefox\/([\d.]+)/.test(ua) ? "Firefox" : /Chrome\/([\d.]+)/.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Браузер не определён";
  const device = /Android/i.test(ua) ? "Android" : /iPhone|iPad|iPod/i.test(ua) ? "iPhone/iPad" : /Windows/i.test(ua) ? "Windows" : /Mac OS/i.test(ua) ? "macOS" : /Linux/i.test(ua) ? "Linux" : "устройство не определено";
  return `${browser} · ${device}`;
}
function auditDetailText(details = {}) {
  const names = { title: "Желание", url: "Ссылка", note: "Примечание", text: "Текст идеи", kind: "Тип", viewer: "Кто получил доступ", canView: "Просмотр", updated: "Изменено пар", before: "Было", after: "Стало", reason: "Причина", pairs: "Участники" };
  const valueText = (value) => {
    if (typeof value === "boolean") return value ? "да" : "нет";
    if (Array.isArray(value)) return value.map((entry) => typeof entry === "object" ? `${entry.viewer || "?"} → ${entry.owner || "?"}` : String(entry)).join(", ");
    if (value && typeof value === "object") return Object.entries(value).map(([key, item]) => `${key === "canView" ? "видеть" : key === "canSuggest" ? "предлагать" : key}: ${valueText(item)}`).join("; ");
    if (value === "invalid_credentials") return "неверный логин или пароль";
    if (value === "rate_limited") return "превышено число попыток входа";
    return String(value ?? "");
  };
  return Object.entries(details).map(([key, value]) => `${names[key] || key}: ${valueText(value)}`).join(" · ") || "—";
}
async function loadAudit(resetPage = false) {
  if (resetPage) auditState.page = 1;
  const form = new FormData(byId("audit-filters"));
  const query = new URLSearchParams({
    q: String(form.get("q") || ""), event: String(form.get("event") || "all"),
    from: String(form.get("from") || ""), to: String(form.get("to") || ""),
    order: String(form.get("order") || "newest"), page: String(auditState.page),
  });
  try {
    auditState = await api(`/api/audit-logs?${query}`);
    renderAudit();
  } catch (error) { message(appError, error.message); }
}
function renderAudit() {
  byId("audit-ip-note").hidden = auditState.ipSource === "proxy";
  const tbody = byId("audit-rows"); tbody.replaceChildren();
  auditState.rows.forEach((entry) => {
    const row = node("tr");
    row.append(node("td", "audit-time", new Date(entry.createdAt).toLocaleString("ru-RU")));
    row.append(node("td", "", auditEventNames[entry.eventType] || entry.eventType));
    const account = entry.displayName ? `${entry.displayName} (@${entry.username})` : entry.username ? `@${entry.username} (не вошёл)` : "—";
    const accountCell = node("td", ""); accountCell.append(node("strong", "audit-account", account));
    if (entry.targetUsername) accountCell.append(node("small", "audit-target", `Участник: ${entry.targetName || ""} (@${entry.targetUsername})`));
    row.append(accountCell, node("td", "audit-ip", entry.ip || "—"));
    const agentCell = node("td", "audit-agent", describeAgent(entry.userAgent)); agentCell.title = entry.userAgent || ""; row.append(agentCell);
    row.append(node("td", "audit-details", auditDetailText(entry.details)));
    tbody.append(row);
  });
  if (!auditState.rows.length) { const row = node("tr"); const cell = node("td", "audit-empty", "Записей по этим условиям нет."); cell.colSpan = 6; row.append(cell); tbody.append(row); }
  const start = auditState.total ? (auditState.page - 1) * 100 + 1 : 0;
  const end = Math.min(auditState.page * 100, auditState.total);
  byId("audit-summary").textContent = `Записи ${start}–${end} из ${auditState.total}. Новые события появляются после обновления списка.`;
  byId("audit-page-label").textContent = `Страница ${auditState.page} из ${auditState.pages}`;
  byId("audit-prev").disabled = auditState.page <= 1;
  byId("audit-next").disabled = auditState.page >= auditState.pages;
}
function permission(label, field, checked, ownerId, viewerId, enabled) {
  const labelNode = node("label");
  const input = document.createElement("input"); input.type = "checkbox"; input.checked = checked; input.disabled = !enabled;
  input.dataset.accessField = field; input.dataset.owner = ownerId; input.dataset.viewer = viewerId;
  labelNode.append(input, document.createTextNode(` ${label}`)); return labelNode;
}

async function loadFeedback() {
  const form = byId("feedback-filters");
  const values = new FormData(form);
  const query = new URLSearchParams({ q: String(values.get("q") || ""), kind: String(values.get("kind") || "all"), order: String(values.get("order") || "newest"), archived: showArchivedFeedback ? "1" : "0" });
  try {
    const result = await api(`/api/feedback?${query}`);
    feedbackRows = result.rows;
    renderFeedback();
  } catch (error) { message(appError, error.message); }
}
function renderFeedback() {
  const list = byId("feedback-list"); list.replaceChildren();
  byId("feedback-form").hidden = showArchivedFeedback;
  const archiveButton = byId("feedback-archive-toggle");
  archiveButton.textContent = showArchivedFeedback ? "← К общим записям" : data.current.isAdmin ? "Архив участников" : "Мой архив";
  archiveButton.classList.toggle("active", showArchivedFeedback);
  byId("feedback-summary").textContent = showArchivedFeedback
    ? `Архивные записи ${data.current.isAdmin ? "всех участников" : "видны только вам"}: ${feedbackRows.length}.`
    : `Общие записи видны всем участникам: ${feedbackRows.length}.`;
  if (!feedbackRows.length) {
    list.append(node("div", "feedback-empty", showArchivedFeedback ? "В архиве пока нет записей." : "Пока никто не оставил комментариев. Будьте первыми!"));
    return;
  }
  feedbackRows.forEach((entry) => {
    const card = node("article", `feedback-card ${entry.archivedAt ? "is-archived" : ""}`);
    const head = node("div", "feedback-card-head");
    head.append(node("span", `feedback-kind ${entry.kind}`, entry.kind === "suggestion" ? "Предложение по улучшению" : "Комментарий"));
    head.append(node("span", "feedback-date", new Date(entry.createdAt).toLocaleString("ru-RU")));
    card.append(head);
    if (entry.title) card.append(node("h3", "feedback-title", entry.title));
    const author = node("div", "feedback-author");
    author.append(node("span", "avatar small", entry.authorName.slice(0, 1).toUpperCase()));
    author.append(node("strong", "", `${entry.authorName}${data.current.isAdmin ? ` · @${entry.authorUsername}` : ""}`));
    card.append(author, node("p", "feedback-body", entry.body));
    if (entry.authorId === data.current.id || data.current.isAdmin) {
      const action = node("button", "wish-action feedback-archive-action", entry.archivedAt ? "Вернуть в общие записи" : "В архив");
      action.type = "button"; action.dataset.feedbackAction = entry.archivedAt ? "restore" : "archive"; action.dataset.feedbackId = entry.id;
      card.append(action);
    }
    list.append(card);
  });
}

document.querySelectorAll("[data-tab]").forEach((button) => button.addEventListener("click", () => { currentTab = button.dataset.tab; render(); }));
byId("audit-filters").addEventListener("submit", (event) => { event.preventDefault(); loadAudit(true); });
byId("audit-reset").addEventListener("click", () => { byId("audit-filters").reset(); loadAudit(true); });
byId("audit-prev").addEventListener("click", () => { if (auditState.page > 1) { auditState.page--; loadAudit(); } });
byId("audit-next").addEventListener("click", () => { if (auditState.page < auditState.pages) { auditState.page++; loadAudit(); } });
byId("feedback-filters").addEventListener("submit", (event) => { event.preventDefault(); loadFeedback(); });
byId("feedback-archive-toggle").addEventListener("click", () => { showArchivedFeedback = !showArchivedFeedback; loadFeedback(); });
byId("feedback-form").addEventListener("submit", async (event) => {
  event.preventDefault(); if (busy) return; setBusy(true); message(appError, "");
  const formElement = event.currentTarget; const form = new FormData(formElement);
  try {
    await api("/api/feedback", { method: "POST", body: JSON.stringify({ kind: form.get("kind"), title: form.get("title"), text: form.get("text") }) });
    formElement.reset(); message(appNotice, "Запись опубликована и теперь видна участникам."); await loadFeedback();
  } catch (error) { message(appError, error.message); }
  finally { setBusy(false); }
});
byId("feedback-list").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-feedback-action]"); if (!button) return;
  try {
    await api(`/api/feedback/${encodeURIComponent(button.dataset.feedbackId)}/${button.dataset.feedbackAction}`, { method: "POST", body: "{}" });
    message(appNotice, button.dataset.feedbackAction === "archive" ? "Запись убрана из общих и перемещена в архив." : "Запись возвращена в общие.");
    await loadFeedback();
  } catch (error) { message(appError, error.message); }
});
byId("matrix-reset").addEventListener("click", async () => {
  if (!data?.current.isAdmin) return;
  data.matrixLayout = { columns: {}, rows: {} };
  renderMatrix();
  await saveMatrixLayout();
  message(appNotice, "Размеры матрицы восстановлены по умолчанию.");
});
let matrixDrag = null;
byId("matrix-wrap").addEventListener("pointerdown", (event) => {
  const handle = event.target.closest("[data-resize-axis]"); if (!handle) return;
  event.preventDefault();
  const axis = handle.dataset.resizeAxis; const key = handle.dataset.resizeKey;
  const element = axis === "column"
    ? byId("matrix-wrap").querySelector(`col[data-layout-key="${CSS.escape(key)}"]`)
    : handle.closest("tr");
  if (!element) return;
  matrixDrag = { axis, key, start: axis === "column" ? event.clientX : event.clientY, size: axis === "column" ? element.getBoundingClientRect().width : element.getBoundingClientRect().height, element, handle };
  handle.setPointerCapture(event.pointerId);
});
document.addEventListener("pointermove", (event) => {
  if (!matrixDrag) return;
  const delta = (matrixDrag.axis === "column" ? event.clientX : event.clientY) - matrixDrag.start;
  const size = Math.round(Math.max(matrixDrag.axis === "column" ? 100 : 54, Math.min(matrixDrag.axis === "column" ? 600 : 400, matrixDrag.size + delta)));
  if (matrixDrag.axis === "column") matrixDrag.element.style.width = `${size}px`;
  else matrixDrag.element.style.height = `${size}px`;
});
document.addEventListener("pointerup", async () => {
  if (!matrixDrag) return;
  const { axis, key, element } = matrixDrag;
  const size = Math.round(axis === "column" ? element.getBoundingClientRect().width : element.getBoundingClientRect().height);
  matrixDrag = null;
  if (!data.matrixLayout || typeof data.matrixLayout !== "object") data.matrixLayout = { columns: {}, rows: {} };
  const bucket = axis === "column" ? "columns" : "rows";
  data.matrixLayout[bucket] ||= {};
  data.matrixLayout[bucket][key] = size;
  await saveMatrixLayout();
});
byId("login-form").addEventListener("submit", async (event) => {
  event.preventDefault(); if (busy) return; setBusy(true); message(loginError, "");
  const formElement = event.currentTarget; const form = new FormData(formElement);
  try {
    await api("/api/login", { method: "POST", body: JSON.stringify({ username: form.get("username"), password: form.get("password") }) });
    formElement.reset(); await load();
  } catch (error) { message(loginError, error.message); }
  finally { setBusy(false); }
});
let pendingAvatarKey = "";
function renderAvatarPicker() {
  const picker = byId("avatar-picker"); picker.replaceChildren();
  avatarNames.forEach((name, index) => {
    const key = `avatar-${String(index + 1).padStart(2, "0")}`;
    const option = node("button", "avatar-option"); option.type = "button"; option.dataset.avatar = key; option.setAttribute("aria-pressed", String(key === pendingAvatarKey)); option.setAttribute("aria-label", name); option.title = name;
    const image = makeAvatar(key); option.append(image, node("span", "avatar-option-name", name)); picker.append(option);
  });
}
byId("user-avatar").addEventListener("click", () => {
  pendingAvatarKey = data?.current.avatarKey || "";
  renderAvatarPicker(); message(byId("avatar-status"), ""); byId("avatar-dialog").showModal();
});
byId("avatar-picker").addEventListener("click", (event) => {
  const option = event.target.closest("[data-avatar]"); if (!option) return;
  pendingAvatarKey = option.dataset.avatar;
  byId("avatar-picker").querySelectorAll("[data-avatar]").forEach((button) => button.setAttribute("aria-pressed", String(button === option)));
});
byId("avatar-cancel").addEventListener("click", () => byId("avatar-dialog").close());
byId("avatar-save").addEventListener("click", async () => {
  const saveButton = byId("avatar-save"); saveButton.disabled = true; message(byId("avatar-status"), "");
  try {
    const result = await api("/api/profile/avatar", { method: "POST", body: JSON.stringify({ avatarKey: pendingAvatarKey }) });
    data.current.avatarKey = result.avatarKey;
    data.members.forEach((member) => { if (member.id === data.current.id) member.avatarKey = result.avatarKey; });
    byId("avatar-dialog").close(); render();
  } catch (error) { message(byId("avatar-status"), error.message); }
  finally { saveButton.disabled = false; }
});
byId("logout-button").addEventListener("click", async () => { try { await api("/api/logout", { method: "POST", body: "{}" }); } finally { data = null; showLogin(""); } });
byId("add-wish-toggle").addEventListener("click", () => { byId("wish-form").hidden = !byId("wish-form").hidden; });
byId("add-member-toggle").addEventListener("click", () => { byId("member-form").hidden = !byId("member-form").hidden; });
document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => { byId(button.dataset.close).hidden = true; }));
byId("people-row").addEventListener("click", (event) => { const button = event.target.closest("[data-member]"); if (button) { selectedId = button.dataset.member; renderWishlist(); } });
byId("active-wishes-toggle").addEventListener("click", () => { showArchivedWishes = false; renderWishlist(); });
byId("archived-wishes-toggle").addEventListener("click", () => { showArchivedWishes = true; renderWishlist(); });
byId("wish-form").addEventListener("submit", async (event) => {
  event.preventDefault(); if (busy) return; setBusy(true); message(appError, "");
  const formElement = event.currentTarget; const form = new FormData(formElement);
  try {
    await api("/api/wishes", { method: "POST", body: JSON.stringify({ title: form.get("title"), url: form.get("url"), note: form.get("note") }) });
    formElement.reset(); formElement.hidden = true; message(appNotice, "Желание добавлено."); await load();
  } catch (error) { message(appError, error.message); }
  finally { setBusy(false); }
});
byId("wish-grid").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-delete-wish], [data-archive-wish], [data-restore-wish], [data-claim-wish]"); if (!button) return;
  if (button.dataset.claimWish) {
    const action = button.dataset.unclaimWish ? "unclaim" : "claim";
    try { await api(`/api/wishes/${encodeURIComponent(button.dataset.claimWish)}/${action}`, { method: "POST", body: "{}" }); await load(); }
    catch (error) { message(appError, error.message); }
    return;
  }
  if (button.dataset.deleteWish && !confirm(showArchivedWishes ? "Удалить желание навсегда? Восстановить его будет нельзя." : "Удалить желание навсегда? Его нельзя будет восстановить.")) return;
  try {
    let notice = "";
    if (button.dataset.archiveWish) { await api(`/api/wishes/${encodeURIComponent(button.dataset.archiveWish)}/archive`, { method: "POST", body: "{}" }); notice = "Желание перемещено в архив. Другие участники его больше не увидят."; }
    else if (button.dataset.restoreWish) { await api(`/api/wishes/${encodeURIComponent(button.dataset.restoreWish)}/restore`, { method: "POST", body: "{}" }); notice = "Желание возвращено в список."; }
    else { await api(`/api/wishes/${encodeURIComponent(button.dataset.deleteWish)}`, { method: "DELETE" }); notice = "Желание удалено."; }
    message(appNotice, notice); await load();
  }
  catch (error) { message(appError, error.message); }
});
byId("member-form").addEventListener("submit", async (event) => {
  event.preventDefault(); if (busy) return; setBusy(true); message(appError, "");
  const formElement = event.currentTarget; const form = new FormData(formElement);
  try {
    await api("/api/members", { method: "POST", body: JSON.stringify({ name: form.get("name"), username: form.get("username"), password: form.get("password") }) });
    formElement.reset(); formElement.hidden = true; message(appNotice, "Аккаунт создан. Передайте участнику логин и пароль."); await load(); currentTab = "access"; render();
  } catch (error) { message(appError, error.message); }
  finally { setBusy(false); }
});
byId("matrix-wrap").addEventListener("change", async (event) => {
  const bulk = event.target.closest("[data-bulk-access]");
  if (bulk) {
    const pairs = JSON.parse(bulk.dataset.pairs || "[]");
    try {
      await api("/api/access/bulk", { method: "POST", body: JSON.stringify({ pairs, canView: bulk.checked }) });
      await load(); currentTab = "access"; render(); message(appNotice, bulk.checked ? "Доступ открыт для выбранных участников и списков." : "Доступ закрыт для выбранных участников и списков.");
    } catch (error) { message(appError, error.message); await load(); currentTab = "access"; render(); }
    return;
  }
  const input = event.target.closest("[data-access-field]"); if (!input) return;
  const rule = activeRule(input.dataset.owner, input.dataset.viewer);
  const canView = input.dataset.accessField === "can_view" ? input.checked : !!rule.can_view;
  const canSuggest = input.dataset.accessField === "can_suggest" ? input.checked : (!!rule.can_suggest && canView);
  try {
    await api("/api/access", { method: "POST", body: JSON.stringify({ ownerId: input.dataset.owner, viewerId: input.dataset.viewer, canView, canSuggest }) });
    await load(); currentTab = "access"; render(); message(appNotice, "Права доступа обновлены.");
  } catch (error) { message(appError, error.message); await load(); currentTab = "access"; render(); }
});
byId("member-management-list").addEventListener("submit", async (event) => {
  const formElement = event.target.closest("[data-password-form]"); if (!formElement) return;
  event.preventDefault(); if (busy) return; setBusy(true); message(appError, "");
  const form = new FormData(formElement);
  try {
    await api(`/api/members/${encodeURIComponent(formElement.dataset.passwordForm)}/password`, { method: "POST", body: JSON.stringify({ password: form.get("password") }) });
    formElement.reset(); message(appNotice, "Пароль изменён. На всех устройствах участнику нужно войти заново.");
  } catch (error) { message(appError, error.message); }
  finally { setBusy(false); }
});
byId("member-management-list").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-delete-member]"); if (!button) return;
  const member = data.members.find((item) => item.id === button.dataset.deleteMember);
  if (!member || !window.confirm(`Удалить участника «${member.name}»? Его желания, идеи, права доступа и активные сеансы будут удалены без возможности восстановления.`)) return;
  try {
    await api(`/api/members/${encodeURIComponent(member.id)}`, { method: "DELETE" });
    message(appNotice, `Участник «${member.name}» и связанные с ним данные удалены.`); await load(); currentTab = "access"; render();
  } catch (error) { message(appError, error.message); }
});
byId("suggest-form").addEventListener("submit", async (event) => {
  event.preventDefault(); if (busy) return; setBusy(true); message(appError, "");
  const formElement = event.currentTarget; const form = new FormData(formElement);
  try {
    await api("/api/suggestions", { method: "POST", body: JSON.stringify({ ownerId: selectedId, text: form.get("text") }) });
    formElement.reset(); message(appNotice, "Идея отправлена.");
  } catch (error) { message(appError, error.message); }
  finally { setBusy(false); }
});

document.querySelectorAll("[data-theme-mode]").forEach((button) => button.addEventListener("click", async () => {
  if (!data?.current.isAdmin) return;
  try { await saveTheme(button.dataset.themeMode); message(appNotice, button.dataset.themeMode === "daily" ? "Включена ежедневная случайная смена темы." : "Включён ручной выбор темы."); }
  catch (error) { message(appError, error.message); }
}));
document.querySelectorAll("[data-theme-choice]").forEach((button) => button.addEventListener("click", async () => {
  if (!data?.current.isAdmin) return;
  try { await saveTheme("manual", button.dataset.themeChoice); message(appNotice, `Выбрана тема «${themeNames[button.dataset.themeChoice]}».`); }
  catch (error) { message(appError, error.message); }
}));

setInterval(async () => {
  if (!data || data.theme?.mode !== "daily") return;
  try {
    const result = await api("/api/theme");
    if (result.theme.theme !== data.theme.theme || result.theme.date !== data.theme.date) {
      data.theme = result.theme; applyTheme(result.theme.theme);
      if (data.current.isAdmin) renderThemeSettings();
    }
  } catch {}
}, 5 * 60 * 1000);

api("/api/theme").then((result) => applyTheme(result.theme?.theme)).catch(() => {});
load();
