// ===== Настройки подключения к Supabase =====
// Project Settings -> API в панели Supabase.
// anon-ключ публичный, его можно держать в коде. service_role сюда вставлять НЕЛЬЗЯ.
const SUPABASE_URL = "https://vsemnmwlblzkohohbahs.supabase.com;
const SUPABASE_ANON_KEY = "sb_publishable_qkQcW8acOFWv_VNvlH6rIA_E9lpYCpU";

// ===== Расписание зала =====
const OPEN_HOUR = 8;     // первый слот начинается в 08:00
const CLOSE_HOUR = 22;   // последний слот заканчивается в 22:00
const DAYS_AHEAD = 7;    // на сколько дней вперёд можно бронировать
