// Державні свята України (неробочі дні) — стаття 73 КЗпП України.
// Великдень і Трійця — рухомі, обчислюються за пасхалією (православний Великдень,
// формула Мьоуса для юліанської Пасхи + переведення в григоріанський календар).

function getOrthodoxEaster(year) {
  const a = year % 4;
  const b = year % 7;
  const c = year % 19;
  const d = (19 * c + 15) % 30;
  const e = (2 * a + 4 * b - d + 34) % 7;
  const month = Math.floor((d + e + 114) / 31); // юліанський місяць (3=березень, 4=квітень)
  const day = ((d + e + 114) % 31) + 1;
  const julianDate = new Date(Date.UTC(year, month - 1, day));
  // юліанський → григоріанський календар: +13 днів (чинно для 1900–2099)
  julianDate.setUTCDate(julianDate.getUTCDate() + 13);
  return julianDate;
}

function getFixedHolidays(year) {
  return [
    [1, 1],   // Новий рік
    [3, 8],   // Міжнародний жіночий день
    [5, 1],   // День праці
    [5, 9],   // День перемоги над нацизмом у Другій світовій війні 1939–1945 років
    [6, 28],  // День Конституції України
    [8, 24],  // День незалежності України
    [10, 14], // День захисників і захисниць України
    [12, 25], // Різдво Христове
  ].map(([m, d]) => new Date(Date.UTC(year, m - 1, d)));
}

function getMovableHolidays(year) {
  const easter = getOrthodoxEaster(year);
  const trinity = new Date(easter);
  trinity.setUTCDate(trinity.getUTCDate() + 49); // Трійця = Великдень + 49 днів
  return [easter, trinity];
}

function isSameUtcDate(a, b) {
  return a.getUTCFullYear() === b.getUTCFullYear()
    && a.getUTCMonth() === b.getUTCMonth()
    && a.getUTCDate() === b.getUTCDate();
}

export function isUkrainianPublicHoliday(date) {
  const year = date.getUTCFullYear();
  const holidays = [...getFixedHolidays(year), ...getMovableHolidays(year)];
  return holidays.some(h => isSameUtcDate(h, date));
}

export function isWorkingDay(date) {
  const day = date.getUTCDay(); // 0 = неділя, 6 = субота
  if (day === 0 || day === 6) return false;
  return !isUkrainianPublicHoliday(date);
}

export function parseDdMmYyyy(str) {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec((str || "").trim());
  if (!m) return null;
  const [, d, mo, y] = m;
  return new Date(Date.UTC(+y, +mo - 1, +d));
}

function formatDdMmYyyy(date) {
  const d = String(date.getUTCDate()).padStart(2, "0");
  const mo = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${d}.${mo}.${date.getUTCFullYear()}`;
}

// Повертає масив дат "дд.мм.рррр" у межах [dateStart, dateEnd] включно — лише робочі дні
// (без суботи/неділі та без державних свят України). Порожній масив, якщо дати не розпізнано
// або період некоректний.
export function getWorkingDatesInRange(dateStartStr, dateEndStr) {
  const start = parseDdMmYyyy(dateStartStr);
  const end = parseDdMmYyyy(dateEndStr);
  if (!start || !end || start > end) return [];
  const result = [];
  const cur = new Date(start);
  while (cur <= end) {
    if (isWorkingDay(cur)) result.push(formatDdMmYyyy(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return result;
}
