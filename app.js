// =====================================================================
//  Бронирование спортивного зала: основная логика
//  Разделы файла:
//   1. Состояние и подключение к Supabase
//   2. Вспомогательные функции
//   3. Отрисовка страниц (view)
//   4. Действия пользователя (бронь, отмена, отзывы, вход)
//   5. Загрузка данных и запуск
// =====================================================================


// ---------------------------------------------------------------------
// 1. Состояние и подключение к Supabase
// ---------------------------------------------------------------------
const db = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const state = {
  lang: localStorage.getItem("lang") || "ru",  // текущий язык
  tab: "book",        // текущая вкладка: book | mine | reviews | mod
  dayOffset: 0,       // выбранный день (0 = сегодня)
  authMode: "in",     // форма входа: in | up
  rating: 5,          // выбранная оценка в форме отзыва
  ready: false,       // загрузилась ли информация о сессии

  userId: null,       // id вошедшего пользователя
  profile: null,      // { name, phone, role }
  isModerator: false,

  bookings: [],       // [{ date, hour, userId, name, phone }]
  reviews: []         // [{ id, userId, name, text, stars, createdAt }]
};

let realtimeChannel = null;


// ---------------------------------------------------------------------
// 2. Вспомогательные функции
// ---------------------------------------------------------------------
const $ = (selector) => document.querySelector(selector);

// Перевод по ключу на текущий язык
const t = (key) => TEXTS[state.lang][key] || key;

// Защита от внедрения HTML (XSS): все пользовательские тексты проходят через неё
function esc(value) {
  const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(value ?? "").replace(/[&<>"']/g, (ch) => map[ch]);
}

const pad = (n) => String(n).padStart(2, "0");

// Дата -> "2026-11-19"
function dateKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Дата через N дней от сегодня (время 00:00)
function dateInDays(n) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return d;
}

// Начало слота как объект Date
function slotStart(date, hour) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d, hour);
}

// Слот уже закончился?
function isPast(date, hour) {
  return slotStart(date, hour).getTime() + 3600 * 1000 <= Date.now();
}

// Красивая подпись слота: "19.11.2026, 18:00–19:00"
function slotLabel(date, hour) {
  const d = slotStart(date, hour);
  return `${d.getDate()}.${pad(d.getMonth() + 1)}.${d.getFullYear()}, ` +
         `${pad(hour)}:00–${pad(hour + 1)}:00`;
}

function findBooking(date, hour) {
  return state.bookings.find((b) => b.date === date && b.hour === hour);
}

function showToast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("on");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => el.classList.remove("on"), 2600);
}

function setLanguage(lang) {
  state.lang = lang;
  localStorage.setItem("lang", lang);
  document.documentElement.lang = lang;
  render();
}


// ---------------------------------------------------------------------
// 3. Отрисовка страниц
// ---------------------------------------------------------------------

// Шапка: кнопки языка и меню вкладок
function renderHeader() {
  $("#lang").innerHTML = Object.keys(LANG_LABELS)
    .map((l) => `<button data-lang="${l}" class="${l === state.lang ? "on" : ""}">${LANG_LABELS[l]}</button>`)
    .join("");

  const tabs = [["book", t("book")], ["mine", t("mine")], ["reviews", t("reviews")]];
  if (state.isModerator) tabs.push(["mod", t("mod")]);   // вкладка только для модераторов

  let html = tabs
    .map(([id, label]) => `<button data-tab="${id}" class="${state.tab === id ? "on" : ""}">${label}</button>`)
    .join("");
  if (state.userId) html += `<button data-action="logout">${t("logout")}</button>`;

  $("#nav").innerHTML = html;
}

// Главная функция: выбирает, какую страницу показать
function render() {
  renderHeader();
  const app = $("#app");

  if (!state.ready) { app.innerHTML = `<div class="empty">…</div>`; return; }
  if (!state.userId) { app.innerHTML = viewAuth(); return; }

  if (state.tab === "book") app.innerHTML = viewBooking();
  else if (state.tab === "mine") app.innerHTML = viewMyBookings();
  else if (state.tab === "reviews") app.innerHTML = viewReviews();
  else if (state.tab === "mod") app.innerHTML = state.isModerator ? viewModeration() : `<div class="card empty">${t("noAccess")}</div>`;
}

// --- Вход / регистрация ---
function viewAuth() {
  const isSignup = state.authMode === "up";
  return `
    <h2>${t("title")}</h2>
    <p class="sub">${t("sub")}</p>
    <div class="card auth-card">
      <h2>${isSignup ? t("signup") : t("login")}</h2>
      ${isSignup ? `
        <label>${t("name")}</label>
        <input id="authName" maxlength="60">
        <label>${t("phone")}</label>
        <input id="authPhone" type="tel" maxlength="20">` : ""}
      <label>${t("email")}</label>
      <input id="authEmail" type="email" autocomplete="email">
      <label>${t("pass")}</label>
      <input id="authPassword" type="password" autocomplete="${isSignup ? "new-password" : "current-password"}">
      <button class="btn accent" data-action="${isSignup ? "signup" : "signin"}">
        ${isSignup ? t("signup") : t("login")}
      </button>
      <p>
        <button class="btn ghost small" data-mode="${isSignup ? "in" : "up"}">
          ${isSignup ? t("hasAccount") : t("noAccount")}
        </button>
      </p>
    </div>`;
}

// --- Бронирование: выбор дня и сетка слотов ---
function viewBooking() {
  const days = [];
  for (let i = 0; i < DAYS_AHEAD; i++) {
    const d = dateInDays(i);
    days.push(`
      <button class="day ${i === state.dayOffset ? "on" : ""}" data-day="${i}">
        <small>${WEEKDAYS[state.lang][d.getDay()]}</small>
        <b>${d.getDate()}.${pad(d.getMonth() + 1)}</b>
      </button>`);
  }

  const date = dateKey(dateInDays(state.dayOffset));
  const slots = [];
  for (let hour = OPEN_HOUR; hour < CLOSE_HOUR; hour++) {
    slots.push(slotButton(date, hour));
  }

  return `
    <h2>${t("title")}</h2>
    <p class="sub">${t("hello")}, ${esc(state.profile?.name)}. ${t("sub")}</p>
    <div class="days">${days.join("")}</div>
    <div class="slots">${slots.join("")}</div>`;
}

// Кнопка одного слота: прошедший / моя бронь / занят / свободен
function slotButton(date, hour) {
  const label = `${pad(hour)}:00–${pad(hour + 1)}:00`;
  const booking = findBooking(date, hour);

  if (isPast(date, hour)) {
    return `<button class="slot busy" disabled><b>${label}</b><small>${t("past")}</small></button>`;
  }
  if (booking && booking.userId === state.userId) {
    return `<button class="slot mine" data-cancel="${date}|${hour}"><b>${label}</b><small>${t("yours")} · ${t("cancel")}</small></button>`;
  }
  if (booking) {
    return `<button class="slot busy" disabled><b>${label}</b><small>${t("taken")}</small></button>`;
  }
  return `<button class="slot" data-book="${date}|${hour}"><b>${label}</b><small>${t("free")}</small></button>`;
}

// --- История моих бронирований ---
function viewMyBookings() {
  const mine = state.bookings
    .filter((b) => b.userId === state.userId)
    .sort((a, b) => slotStart(b.date, b.hour) - slotStart(a.date, a.hour));

  const rows = mine.map((b) => {
    const past = isPast(b.date, b.hour);
    return `
      <div class="row">
        <div>
          <b>${slotLabel(b.date, b.hour)}</b>
          <div class="meta"><span class="tag ${past ? "past" : ""}">${past ? t("done") : t("upcoming")}</span></div>
        </div>
        ${past ? "" : `<button class="btn ghost small" data-cancel="${b.date}|${b.hour}">${t("cancel")}</button>`}
      </div>`;
  }).join("");

  return `
    <h2>${t("history")}</h2>
    <p class="sub">&nbsp;</p>
    <div class="card">${rows || `<div class="empty">${t("empty")}</div>`}</div>`;
}

// --- Отзывы ---
function viewReviews() {
  const starButtons = [1, 2, 3, 4, 5]
    .map((n) => `<button data-star="${n}">${n <= state.rating ? "★" : "☆"}</button>`)
    .join("");

  const list = state.reviews.map((r) => {
    const canDelete = state.isModerator || r.userId === state.userId;
    const date = new Date(r.createdAt).toLocaleDateString(LOCALES[state.lang]);
    return `
      <div class="row">
        <div>
          <b>${esc(r.name)}</b> <span class="stars">${"★".repeat(r.stars)}${"☆".repeat(5 - r.stars)}</span>
          <div>${esc(r.text)}</div>
          <div class="meta">${date}</div>
        </div>
        ${canDelete ? `<button class="btn ghost small" data-delete-review="${r.id}">${t("delete")}</button>` : ""}
      </div>`;
  }).join("");

  return `
    <h2>${t("reviews")}</h2>
    <p class="sub">&nbsp;</p>
    <div class="card">
      <b>${t("leaveReview")}</b>
      <div class="stars star-input">${starButtons}</div>
      <textarea id="reviewText" rows="3" maxlength="500" placeholder="${t("reviewText")}"></textarea>
      <button class="btn accent" data-action="review">${t("send")}</button>
    </div>
    <div class="card">${list || `<div class="empty">${t("empty")}</div>`}</div>`;
}

// --- Модерация: все предстоящие брони ---
function viewModeration() {
  const upcoming = state.bookings
    .filter((b) => !isPast(b.date, b.hour))
    .sort((a, b) => slotStart(a.date, a.hour) - slotStart(b.date, b.hour));

  const rows = upcoming.map((b) => `
    <div class="row">
      <div>
        <b>${slotLabel(b.date, b.hour)}</b>
        <div class="meta">${esc(b.name)} · ${esc(b.phone)}</div>
      </div>
      <button class="btn ghost small" data-cancel="${b.date}|${b.hour}">${t("cancel")}</button>
    </div>`).join("");

  return `
    <h2>${t("mod")}</h2>
    <p class="sub">${t("modInfo")}</p>
    <div class="card">${rows || `<div class="empty">${t("empty")}</div>`}</div>`;
}


// ---------------------------------------------------------------------
// 4. Действия пользователя
// ---------------------------------------------------------------------

// Забронировать слот. Двойную бронь блокирует база (unique на дату+час).
async function bookSlot(date, hour) {
  const { error } = await db.from("bookings").insert({
    slot_date: date,
    hour: hour,
    user_id: state.userId
  });

  if (error) {
    // 23505 = нарушение уникальности: кто-то успел раньше
    showToast(error.code === "23505" ? t("busy") : t("error"));
  } else {
    showToast(t("booked"));
  }
  await loadData();
}

// Отменить бронь. Чужую отменить нельзя: это проверяет и код, и правила БД (RLS).
async function cancelBooking(date, hour) {
  const booking = findBooking(date, hour);
  if (!booking) return;
  if (booking.userId !== state.userId && !state.isModerator) return;
  if (!confirm(t("cancelQuestion"))) return;

  const { error } = await db.from("bookings").delete().eq("slot_date", date).eq("hour", hour);
  showToast(error ? t("error") : t("canceled"));
  await loadData();
}

async function sendReview() {
  const text = $("#reviewText").value.trim();
  if (!text) return;

  const { error } = await db.from("reviews").insert({
    user_id: state.userId,
    name: state.profile.name,
    text: text,
    stars: state.rating
  });

  if (error) { showToast(t("error")); return; }
  showToast(t("thanks"));
  state.rating = 5;
  await loadData();
}

async function deleteReview(id) {
  const { error } = await db.from("reviews").delete().eq("id", id);
  if (error) showToast(t("error"));
  await loadData();
}

async function signIn() {
  const { error } = await db.auth.signInWithPassword({
    email: $("#authEmail").value.trim(),
    password: $("#authPassword").value
  });
  if (error) showToast(t("badLogin"));
}

async function signUp() {
  const name = $("#authName").value.trim();
  const phone = $("#authPhone").value.trim();
  const email = $("#authEmail").value.trim();
  const password = $("#authPassword").value;
  if (!name || !phone || !email || password.length < 6) return;

  // name и phone попадут в профиль через триггер в базе (см. schema.sql)
  const { data, error } = await db.auth.signUp({
    email,
    password,
    options: { data: { name, phone } }
  });

  if (error) showToast(error.message);
  else if (!data.session) showToast(t("confirmEmail"));   // включено подтверждение почты
}

// Один обработчик кликов на всю страницу (делегирование событий)
document.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  const d = button.dataset;

  if (d.lang) setLanguage(d.lang);
  else if (d.tab) { state.tab = d.tab; render(); }
  else if (d.day) { state.dayOffset = Number(d.day); render(); }
  else if (d.mode) { state.authMode = d.mode; render(); }
  else if (d.book) { const [date, hour] = d.book.split("|"); bookSlot(date, Number(hour)); }
  else if (d.cancel) { const [date, hour] = d.cancel.split("|"); cancelBooking(date, Number(hour)); }
  else if (d.star) {
    const text = $("#reviewText").value;      // сохраняем уже набранный текст
    state.rating = Number(d.star);
    render();
    $("#reviewText").value = text;
  }
  else if (d.deleteReview) deleteReview(d.deleteReview);
  else if (d.action === "signin") signIn();
  else if (d.action === "signup") signUp();
  else if (d.action === "logout") db.auth.signOut();
  else if (d.action === "review") sendReview();
});


// ---------------------------------------------------------------------
// 5. Загрузка данных и запуск
// ---------------------------------------------------------------------

// Загружаем брони и отзывы из базы
async function loadData() {
  // profiles(name, phone) вернёт данные только для своих броней или если вы модератор (RLS)
  const bookingsResult = await db
    .from("bookings")
    .select("slot_date, hour, user_id, profiles(name, phone)");

  state.bookings = (bookingsResult.data || []).map((row) => ({
    date: row.slot_date,
    hour: row.hour,
    userId: row.user_id,
    name: row.profiles?.name || "",
    phone: row.profiles?.phone || ""
  }));

  const reviewsResult = await db
    .from("reviews")
    .select("*")
    .order("created_at", { ascending: false });

  state.reviews = (reviewsResult.data || []).map((row) => ({
    id: row.id,
    userId: row.user_id,
    name: row.name,
    text: row.text,
    stars: row.stars,
    createdAt: row.created_at
  }));

  render();
}

// Вызывается при входе и выходе пользователя
async function onSessionChange(session) {
  if (realtimeChannel) {
    db.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }

  // Пользователь вышел: очищаем состояние
  if (!session) {
    Object.assign(state, { userId: null, profile: null, isModerator: false, bookings: [], reviews: [], ready: true });
    render();
    return;
  }

  state.userId = session.user.id;

  const { data: profile } = await db
    .from("profiles")
    .select("name, phone, role")
    .eq("id", state.userId)
    .single();

  state.profile = profile;
  state.isModerator = profile?.role === "moderator";
  await loadData();
  state.ready = true;
  render();

  // Realtime: слоты обновляются у всех без перезагрузки страницы
  realtimeChannel = db
    .channel("live")
    .on("postgres_changes", { event: "*", schema: "public", table: "bookings" }, loadData)
    .on("postgres_changes", { event: "*", schema: "public", table: "reviews" }, loadData)
    .subscribe();
}

// Старт
document.documentElement.lang = state.lang;
render();

db.auth.onAuthStateChange((event, session) => {
  if (event === "TOKEN_REFRESHED" || event === "USER_UPDATED") return;
  setTimeout(() => onSessionChange(session), 0);   // setTimeout, чтобы не блокировать Supabase
});
