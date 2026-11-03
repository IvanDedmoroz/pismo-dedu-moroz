const loginView = document.querySelector("#login-view");
const appView = document.querySelector("#app-view");
const loginError = document.querySelector("#login-error");
const appError = document.querySelector("#app-error");
const appNotice = document.querySelector("#app-notice");
let data = null;
let selectedId = "";
let currentTab = "list";
let busy = false;

const byId = (id) => document.getElementById(id);
const node = (tag, className = "", text = "") => {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== "") item.textContent = text;
  return item;
};
function message(target, text) { target.textContent = text; target.hidden = !text; }
function showLogin(error = "") { loginView.hidden = false; appView.hidden = true; message(loginError, error); }
function showApp() { loginView.hidden = true; appView.hidden = false; message(loginError, ""); }
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
    if (!selectedId || !data.members.some((m) => m.id === selectedId)) selectedId = data.current.id;
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
  byId("user-avatar").textContent = (data.current.name || "?").slice(0, 1).toUpperCase();
  byId("user-label").textContent = data.current.name;
  byId("access-tab").hidden = !data.current.isAdmin;
  byId("access-tab").classList.toggle("active", currentTab === "access");
  document.querySelector('[data-tab="list"]').classList.toggle("active", currentTab === "list");
  byId("list-panel").hidden = currentTab !== "list";
  byId("access-panel").hidden = currentTab !== "access" || !data.current.isAdmin;
  if (currentTab === "access" && data.current.isAdmin) renderMatrix();
  else renderWishlist();
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
    chip.append(node("span", "avatar small", member.name.slice(0, 1).toUpperCase()));
    chip.append(node("span", "", member.id === data.current.id ? "Мои желания" : member.name));
    chip.append(node("span", "chip-count", String(data.wishes.filter((wish) => wish.ownerId === member.id).length)));
    people.append(chip);
  });
  byId("circle-hint").textContent = accessible.length === 1 ? "Пока здесь только ваш список." : "Выберите, чьи желания посмотреть.";
  byId("add-wish-toggle").hidden = !own;
  byId("wish-form").hidden = own ? byId("wish-form").hidden : true;
  byId("wish-title").textContent = own ? "Мои желания" : `Желания: ${selected?.name || ""}`;
  const wishes = data.wishes.filter((wish) => wish.ownerId === selectedId);
  byId("wish-count").textContent = `${wishes.length} ${wishes.length === 1 ? "пожелание" : "пожеланий"}`;
  const grid = byId("wish-grid"); grid.replaceChildren();
  if (!wishes.length) {
    const empty = node("div", "empty-state");
    empty.append(node("span", "", "✧"), node("h3", "", own ? "Здесь появятся ваши желания" : "Список пока пуст"));
    empty.append(node("p", "", own ? "Добавьте первую идею — её увидят только вы, пока не откроете доступ." : "У этого участника пока нет желаний."));
    if (own) { const add = node("button", "text-button", "Добавить первое желание →"); add.type = "button"; add.addEventListener("click", () => { byId("wish-form").hidden = false; }); empty.append(add); }
    grid.append(empty);
  } else wishes.forEach((wish, index) => {
    const card = node("article", "wish-card");
    card.append(node("span", "wish-number", String(index + 1).padStart(2, "0")));
    card.append(node("div", "wish-icon", ["✧", "❄", "✦", "♡"][index % 4]));
    card.append(node("h4", "", wish.title));
    if (wish.note) card.append(node("p", "", wish.note));
    const foot = node("div", "wish-card-foot");
    if (wish.url) { const link = node("a", "", "Посмотреть подарок ↗"); link.href = wish.url; link.target = "_blank"; link.rel = "noopener noreferrer"; foot.append(link); }
    if (own) { const del = node("button", "delete-link", "Удалить"); del.type = "button"; del.dataset.deleteWish = wish.id; foot.append(del); }
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
  const thead = node("thead"); const headRow = node("tr"); headRow.append(node("th", "", "Кто смотрит ↓ / чей список →"));
  data.members.forEach((owner) => { const th = node("th"); th.append(node("strong", "", owner.name), node("small", "", owner.username)); headRow.append(th); });
  thead.append(headRow); table.append(thead);
  const tbody = node("tbody");
  data.members.forEach((viewer) => {
    const row = node("tr"); const label = node("th"); label.append(node("strong", "", viewer.name), node("small", "", `${viewer.username}${viewer.is_admin ? " · организатор" : ""}`)); row.append(label);
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
  table.append(tbody); wrap.append(table);
}
function permission(label, field, checked, ownerId, viewerId, enabled) {
  const labelNode = node("label");
  const input = document.createElement("input"); input.type = "checkbox"; input.checked = checked; input.disabled = !enabled;
  input.dataset.accessField = field; input.dataset.owner = ownerId; input.dataset.viewer = viewerId;
  labelNode.append(input, document.createTextNode(` ${label}`)); return labelNode;
}

document.querySelectorAll("[data-tab]").forEach((button) => button.addEventListener("click", () => { currentTab = button.dataset.tab; render(); }));
byId("login-form").addEventListener("submit", async (event) => {
  event.preventDefault(); if (busy) return; setBusy(true); message(loginError, "");
  const formElement = event.currentTarget; const form = new FormData(formElement);
  try {
    await api("/api/login", { method: "POST", body: JSON.stringify({ username: form.get("username"), password: form.get("password") }) });
    formElement.reset(); await load();
  } catch (error) { message(loginError, error.message); }
  finally { setBusy(false); }
});
byId("logout-button").addEventListener("click", async () => { try { await api("/api/logout", { method: "POST", body: "{}" }); } finally { data = null; showLogin(""); } });
byId("add-wish-toggle").addEventListener("click", () => { byId("wish-form").hidden = !byId("wish-form").hidden; });
byId("add-member-toggle").addEventListener("click", () => { byId("member-form").hidden = !byId("member-form").hidden; });
document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => { byId(button.dataset.close).hidden = true; }));
byId("people-row").addEventListener("click", (event) => { const button = event.target.closest("[data-member]"); if (button) { selectedId = button.dataset.member; renderWishlist(); } });
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
  const button = event.target.closest("[data-delete-wish]"); if (!button) return;
  try { await api(`/api/wishes/${encodeURIComponent(button.dataset.deleteWish)}`, { method: "DELETE" }); message(appNotice, "Желание удалено."); await load(); }
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
  const input = event.target.closest("[data-access-field]"); if (!input) return;
  const rule = activeRule(input.dataset.owner, input.dataset.viewer);
  const canView = input.dataset.accessField === "can_view" ? input.checked : !!rule.can_view;
  const canSuggest = input.dataset.accessField === "can_suggest" ? input.checked : (!!rule.can_suggest && canView);
  try {
    await api("/api/access", { method: "POST", body: JSON.stringify({ ownerId: input.dataset.owner, viewerId: input.dataset.viewer, canView, canSuggest }) });
    await load(); currentTab = "access"; render(); message(appNotice, "Права доступа обновлены.");
  } catch (error) { message(appError, error.message); await load(); currentTab = "access"; render(); }
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

load();
