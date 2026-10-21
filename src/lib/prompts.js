import { resolvePracticeFixedPages, getLangLabels, localSourceLangCode } from "./planUtils.js";
import { getWorkingDatesInRange } from "./ukrainianHolidays.js";
import { CJK_CHARS_PER_WORD } from "./wordCount.js";

// ── Стильові профілі: додатковий шар "голосу" поверх спільного styleBlockDefault
// (довжина речень, частка пасиву, ритм абзаців, підмножина дозволених зв'язок),
// щоб різні розділи роботи звучали трохи по-різному, а не одним голосом — див.
// коментар над buildAntiDetectionSYS нижче. Профіль обирається детерміновано з
// sec.id/sec.type через getStyleProfileForSection, ніде не зберігається.
const STYLE_VOICE_PROFILES = {
  A: `VOICE VARIANT: Keep sentences short and direct, mostly 8-14 words. Use active voice almost exclusively; passive constructions are a rare exception, at most one per subsection. Favor compact paragraphs of 3-5 sentences, with only occasional longer ones. Open subsections with a direct claim or a concrete fact/figure more often than with a hook or example. When a transition word is needed, prefer this pool: "зокрема", "до того ж", "натомість", "усе ж", "поряд з цим". Keep the tone plain and businesslike, with no metaphors.`,
  B: `VOICE VARIANT: Favor longer sentences with subordinate clauses, roughly 16-24 words. Allow passive constructions more freely, up to about 15% of sentences in the subsection, especially for analytical framing ("було встановлено, що..."). Alternate sharply between short paragraphs (2-3 sentences) and long ones (6-8 sentences). Open subsections with a definition or a comparison more often than with an example. When a transition word is needed, prefer this pool: "з огляду на це", "попри це", "з іншого боку", "з урахуванням цього", "у зв'язку з цим".`,
  C: `VOICE VARIANT: Use sentences of medium length, roughly 12-18 words, predominantly active voice. Allow at most one simple metaphor or comparison per subsection. Favor opening subsections with a concrete example or a short case description. Keep paragraphs fairly even in size, 4-6 sentences. When a transition word is needed, prefer this pool: "згодом", "надалі", "паралельно з цим", "тим часом", "водночас".`,
  D: `VOICE VARIANT: Use sentences of medium-to-longer length, roughly 14-20 words. Passive voice is more frequent than usual, up to about 20% of sentences, matching a more traditionally academic register. Soften categorical statements more than usual. Open subsections with a direct claim or a hook, alternating between the two. When a transition word is needed, prefer this pool: "відповідно до цього", "за таких умов", "на цій основі", "з цієї причини".`,
  E: `VOICE VARIANT: Use sentences of medium length, roughly 12-18 words, with passive voice as a rare exception, at most one per subsection. Favor a reflective, synthesizing register appropriate for drawing conclusions, without leaning on summary clichés. Keep paragraphs even in size, 4-5 sentences. Open with a direct claim or a concrete result more often than with a hook. When a transition word is needed, prefer this pool: "спираючись на це", "з огляду на здобуті результати", "на цій підставі", "з такої позиції".`,
};

const CHAPTER_STYLE_PROFILES = ["A", "B", "C"];

// Вступ (D) і висновки (E) мають власні профілі поза ротацією розділів (A/B/C),
// тому жоден стик "останній розділ → висновки" не може випадково повторити той
// самий голос підряд, скільки б розділів не було в роботі (2, 3, 4...).
export function getStyleProfileForSection(sec) {
  if (!sec) return null;
  if (sec.type === "intro") return "D";
  if (sec.type === "conclusions") return "E";
  const chapterKey = sec.chapterNum || (sec.id || "").split(".")[0];
  const chapterNum = parseInt(chapterKey, 10);
  if (!Number.isFinite(chapterNum) || chapterNum < 1) return null;
  return CHAPTER_STYLE_PROFILES[(chapterNum - 1) % CHAPTER_STYLE_PROFILES.length];
}

// Речення з українським пулом перехідних слів у STYLE_VOICE_PROFILES — прибирається для
// робіт іншою мовою (у пулах немає крапок, тож речення закінчується першою ж крапкою).
const VOICE_POOL_SENTENCE_RE = / When a transition word is needed, prefer this pool: [^.]*\./;

// Правило ротації перехідних слів. Для української — з прикладами українських слів (без
// змін); для інших мов приклади не підставляємо, щоб вони не потрапили в текст як є.
function transitionRotationRule(isUkrainian, lang, scope) {
  return isUkrainian
    ? `TRANSITION ROTATION: when a paragraph needs an explicit transition word, rotate among a wide pool instead of defaulting to a small handful — e.g. "водночас", "натомість", "тим часом", "паралельно з цим", "на противагу цьому", "з іншого боку", "поряд з цим", "усе ж", "проте", "втім". Never use the same transition word to open more than 2 paragraphs within one ${scope}, and never in two consecutive paragraphs — this applies especially to "водночас", "разом з тим" and "проте", which tend to become the new overused default once the more obvious connectors above are forbidden.`
    : `TRANSITION ROTATION: when a paragraph needs an explicit transition word, rotate among a wide pool of natural ${lang} transitions instead of defaulting to a small handful. Never use the same transition word to open more than 2 paragraphs within one ${scope}, and never in two consecutive paragraphs.`;
}

// Мова роботи поза таблицею getLangLabels ("other"): не забороняємо жодну абетку наперед
// (мова може бути й кириличною), але вимагаємо її власне письмо й прибираємо українські
// імена з тексту так само, як для інших іноземних мов.
function otherLangScriptRule(lang) {
  return `Write entirely in ${lang}, in its standard script. Do not mix with Ukrainian, Russian, or any other language. Do NOT copy Ukrainian-language names or terms from the source materials into the body text: replace researcher or author names with impersonal academic phrasing and render terms in ${lang}. EXCEPTION: citation markers [N] or (Author, year).`;
}

// Перша особа в есе для неукраїнської роботи: у польській/чеській/словацькій минулий час, а в
// іспанській/французькій/італійській прикметники й дієприкметники теж позначають рід автора
// (zrozumiałem/zrozumiałam, estoy convencido/convencida) — заборона та сама, що й для
// української, лише без українських прикладів. Мова поза таблицею — умовно ("If …").
// dynamic — мова з набору ШІ: чи позначає вона рід, відомо з набору, тож правило визначене.
function essayFirstPersonRule(lang, langCode, genderedFirstPerson, dynamic = false) {
  if (!genderedFirstPerson) return `First person is required; ${lang} does not mark the writer's grammatical gender in first-person forms, so ordinary first-person forms are fine.`;
  const ban = `all such gendered first-person forms are STRICTLY FORBIDDEN, also in short replies to opponents. Use ungendered first-person phrasing instead (present-tense verbs of opinion and "in my opinion"-type expressions in ${lang}), rotate among several of them, and never use the same one more than twice in the entire text.`;
  return langCode === "other" && !dynamic
    ? `First person is required. If ${lang} marks the writer's grammatical gender in some first-person forms (past-tense verbs, predicate adjectives or participles), then, since the writer's gender is unknown, ${ban}`
    : `First person is required, but in ${lang} some first-person forms mark the writer's grammatical gender (past-tense verbs, predicate adjectives or participles with masculine vs feminine endings) — since the writer's gender is unknown, ${ban}`;
}

// Пошукові фрази МОВОЮ РОБОТИ для генераторів тез (поряд з enPhrases) — лише для неукраїнської
// й неанглійської роботи (localSourceLangCode); для української й англійської обидві функції
// повертають "" і промпт лишається незмінним. scope — "підрозділу" / "розділу".
export function localPhrasesStep(lang, scope = "підрозділу") {
  return localSourceLangCode(lang)
    ? `\n\nКРОК 4. Додай 3 пошукові фрази МОВОЮ РОБОТИ (${lang}) для ${scope} загалом (академічний стиль, ширші за тезу) — для пошуку в наукових базах цією мовою.`
    : "";
}
export function localPhrasesJsonField(lang) {
  return localSourceLangCode(lang) ? `, "localPhrases": масив з 3 фраз мовою роботи` : "";
}
// Те саме поле для пакетних промптів, що відповідають об'єктом "ідентифікатор → масив" (unit — "розділу"/"підрозділу")
export function localPhrasesJsonFieldBatch(lang, unit = "розділу") {
  return localSourceLangCode(lang)
    ? `\n- "localPhrases": об'єкт, ключ = ідентифікатор ${unit} з квадратних дужок, значення = масив з 3 фраз мовою роботи (рядки)`
    : "";
}

// Набір мовних підписів для мови роботи поза таблицею getLangLabels (langProfile.js). Відповідь
// перевіряє кодом sanitizeLangProfile (planUtils.js): чого бракує — береться англійське.
export function buildLangProfilePrompt(language) {
  return `Мова академічної роботи: "${language}". Склади для неї набір стандартних підписів і параметрів, як їх прийнято писати в курсових/дипломних роботах цією мовою (у країні, де нею пишуть такі роботи).

Поверни ТІЛЬКИ JSON такої форми (значення нижче — англійський зразок, заміни їх відповідниками мовою "${language}"):
{
  "iso": "en",
  "wordCode": "en-US",
  "latinScript": true,
  "intro": "INTRODUCTION",
  "conclusions": "CONCLUSIONS",
  "sources": "REFERENCES",
  "toc": "TABLE OF CONTENTS",
  "chapterPattern": "CHAPTER {n}",
  "chapterTitles": ["THEORETICAL FOUNDATIONS", "ANALYSIS AND PRACTICAL PART", "RECOMMENDATIONS AND PROPOSALS"],
  "chapterConclusion": "Conclusions to Chapter {n}",
  "subsWord": "subsection",
  "tableWord": "Table",
  "figWord": "Fig.",
  "tableRef": "shown in Table",
  "figRef": "shown in Fig.",
  "pageAbbrev": "p.",
  "appendixWord": "APPENDICES",
  "appendixSingular": "APPENDIX",
  "appendixLetters": ["A", "B", "C"],
  "introLabels": {"actuality": "Relevance of the topic.", "goal": "The purpose of the study –", "tasks": "Research objectives:", "object": "Object of study –", "subject": "Subject of study –", "methods": "Research methods:", "novelty": "Scientific novelty –", "practical": "Practical significance:", "approbation": "Approbation of results –", "structure": "Structure of the work:", "theoryBasis": "The theoretical basis is"},
  "defaultIntroComponents": ["relevance of the topic", "purpose of the study", "research objectives", "object of study", "subject of study", "research methods", "practical significance", "structure of the work"],
  "quotes": ["“", "”"],
  "supervisorLabel": "Scientific supervisor",
  "abstractWord": "Abstract",
  "keywordsWord": "Keywords",
  "authorPlaceholder": "[Author's name]",
  "universityPlaceholder": "[University]",
  "udc": "UDC",
  "empiricalChapter": "EMPIRICAL RESEARCH",
  "drawingWord": "Drawing",
  "listingWord": "Listing",
  "sourceCodeTitle": "Program source code",
  "genderedFirstPerson": false,
  "searchLocale": {"hl": "en", "gl": "us"}
}

Правила:
- iso — двобуквений код мови ISO 639-1; wordCode — код мови для перевірки правопису Word (мова-КРАЇНА, напр. "ro-RO", "hu-HU"); searchLocale — мова (hl) і двобуквений код країни (gl) для пошуку Google.
- latinScript — true, якщо мова пишеться латиницею.
- chapterPattern — заголовок розділу з номером, номер позначено {n}, у тому порядку, як прийнято цією мовою (напр. "CAPITOLUL {n}" або "{n}. FEJEZET"); великими літерами, як заголовки. chapterConclusion — "висновки до розділу" з номером {n}.
- intro/conclusions/sources/toc/appendixWord/appendixSingular/chapterTitles/empiricalChapter — великими літерами, як заголовки в роботі; решта — звичайним регістром, як у зразку.
- appendixLetters — лише якщо мова НЕ латинична: 15-25 великих літер її абетки, якими нумерують додатки; для латиничної мови — латинські A, B, C…
- quotes — пара типографських лапок цієї мови (відкривна, закривна).
- genderedFirstPerson — true, якщо в цій мові форми першої особи (дієслова минулого часу чи прикметники/дієприкметники) показують рід автора, як в українській ("я зрозумів/зрозуміла").
- Нічого не пропускай і не додавай інших полів.`;
}

// Обсяг у промптах задано "словами" (sec.pages × 230), а в китайському тексті слів, розділених
// пробілами, немає — та сама пропорція, якою countWords рахує ієрогліфи (wordCount.js).
const CHINESE_LENGTH_NOTE = `\nLength targets in the instructions are given in "words" (слів): for Chinese text count about ${CJK_CHARS_PER_WORD} Chinese characters (汉字) as one word, e.g. 400 words ≈ ${Math.round(400 * CJK_CHARS_PER_WORD)} characters.`;

export function buildSYS(lang = "Українська", methodInfo = null, workType = null, styleProfile = null) {
  const { code: langCode, tableWord, figWord, tableRef, figRef, forbiddenWords, sources: sourcesLabel } = _lc(lang);
  const isEnglish = langCode === "en";
  const isChinese = langCode === "zh";
  const isUkrainian = langCode === "uk";

  const langLine = isEnglish
    ? `Language: Write ONLY in English. All content, headings, and text must be in English.`
    : `Language of the work: ONLY ${lang}. All text, headings, and content — exclusively in this language. Do NOT mix with any other language.`;

  const scriptRule = isUkrainian
    ? `STRICTLY FORBIDDEN to use Latin-script words, terms, or names in the text. Transliterate foreign researcher names into Ukrainian (e.g., "Джон Дьюї"). Replace foreign terms with Ukrainian equivalents. EXCEPTION: citations in format [N] or (Author, year) may contain Latin if the author is foreign — keep author names in original script. Source context passed as [N]... — Latin there is allowed, do NOT transliterate it.`
    : isChinese
    ? `所有正文必须使用中文。引用格式[N]或(作者,年份)中的外文作者姓名保持原文。${CHINESE_LENGTH_NOTE}`
    : langCode === "other"
    ? otherLangScriptRule(lang)
    : `Write entirely in ${lang}. Do not mix with Ukrainian, Russian, or any other language. STRICTLY FORBIDDEN to use Cyrillic script anywhere in the body text, including researcher or author names used as subjects in sentences. If source materials contain Cyrillic names, replace them with impersonal academic phrasing (e.g. "research indicates" instead of "Калюжна argues"). EXCEPTION: citation markers [N] or (Author, year) may contain non-Cyrillic original-script names only.`;

  const mTableFormat = methodInfo?.formatting?.tableFormat;
  const mFigureFormat = methodInfo?.formatting?.figureFormat;

  const tableCapExample = `${tableWord} X.Y – Title`;
  const figCapExample = `${figWord} X.Y – Title`;

  const tableRules = mTableFormat
    ? `TABLES — mandatory rules (per methodology):
1. Number tables within each section: ${tableWord} X.Y (X = section number, Y = table number within section).
2. Caption format per methodology: ${mTableFormat}. Place caption on a separate line immediately before the first table row (|).
3. The text before the table MUST contain a sentence referencing it, e.g.: "${tableRef} X.Y".
STRICTLY FORBIDDEN: table without caption. Every table MUST have a "${tableWord} X.Y – Name" line immediately before it.`
    : `TABLES — mandatory rules:
1. Place caption on a separate line immediately before the first table row (|): ${tableWord} X.Y – Table name (X = section number, Y = table number within section).
2. The text before the table MUST contain a sentence referencing it, e.g.: "${tableRef} X.Y". Without this reference the table must not appear.
STRICTLY FORBIDDEN: table without caption. Every table MUST have a "${tableCapExample}" line immediately before it.`;

  const plantUmlRule = `When a structural/UML diagram is needed (class diagram, sequence diagram, use case diagram, or a simple process/activity flowchart — anything describing structure, relationships, or flow rather than numeric data): output a fenced code block labeled "plantuml" containing valid PlantUML syntax (starting with @startuml, ending with @enduml), then place the figure caption immediately below the closing fence (no hint line — this diagram is rendered automatically).`;

  // Приклад роботи, наданий клієнтом, реально містив рисунки/схеми (buildExampleWorkReadingPrompt →
  // hasFigures) — без цього AI регулярно вирішує, що "рисунок не потрібен", і робота лишається зовсім
  // без ілюстрацій, хоча зразок для цієї ж теми/спеціальності їх явно очікує. Те саме для звітів з
  // практики, де сама методичка прямим текстом називає конкретні обов'язкові схеми (requiredFigures,
  // buildMethodologyReadingPrompt) — напр. "структура управління (схема)", "технологічна схема
  // виробництва".
  const requiredFiguresList = Array.isArray(methodInfo?.requiredFigures) ? methodInfo.requiredFigures.filter(Boolean) : [];
  const mandatoryFigureNote = methodInfo?.hasFigures
    ? `MANDATORY: the reference example provided for this topic contains figures/diagrams — this work MUST include comparable figures too, it is NOT optional here. Each of the main chapters (1, 2, 3...) must include at least one figure (a data chart, a plantuml diagram, or — only if neither fits — a placeholder for a manually sourced illustration), placed where it naturally fits the content, per the rules below.\n`
    : requiredFiguresList.length
    ? `MANDATORY: the methodology explicitly requires these specific diagrams/schemes to appear in the report — do NOT skip them: ${requiredFiguresList.join("; ")}. Place each where it fits the corresponding content, per the rules below.\n`
    : "";

  const figureRules = mandatoryFigureNote + (mFigureFormat
    ? `FIGURES — mandatory rules (per methodology):
1. Number figures within each section: ${figWord} X.Y (X = section number, Y = figure number within section).
2. When a diagram, chart, or graph with underlying numeric data is needed: create a markdown data table with the values to be plotted (do NOT add a "${tableWord}" caption above it; first column = category labels, other columns = numeric series with a clear header name), then place the figure caption BELOW the table (format per methodology: ${mFigureFormat}) — the chart image is generated and inserted automatically, no hint line needed.
3. ${plantUmlRule}
4. For conceptual figures that fit neither case above — insert a standalone placeholder: ${figWord} X.Y – Figure name (caption below, no data table, no hint line, no code block).
5. The text before the figure MUST contain a sentence referencing it, e.g.: "${figRef} X.Y".
STRICTLY FORBIDDEN: show the same data as both a "${tableWord}" and a diagram. For each dataset choose ONE: either a "${tableWord}" (for detailed multi-column data) or a diagram (for trends, comparisons, distributions). Tables and diagrams in the same section MUST show different data.`
    : `FIGURES — mandatory rules:
1. When a diagram, chart, or graph with underlying numeric data is needed in a section: do NOT insert a standalone placeholder. Instead:
   a. Write a sentence in the text referencing the figure, e.g.: "${figRef} X.Y demonstrates..."
   b. Create a markdown data table with the values to be plotted (do NOT add a "${tableWord}" caption above it; first column = category labels, other columns = numeric series with a clear header name).
   c. On a new line immediately after the table, place the figure caption: ${figWord} X.Y – Figure name — the chart image is generated and inserted automatically, no hint line needed.
2. ${plantUmlRule}
3. For conceptual figures that fit neither case above — insert a standalone placeholder: ${figWord} X.Y – Figure name (no data table, no hint line, no code block).
4. The text before any figure MUST contain a sentence referencing it, e.g.: "${figRef} X.Y". Without this reference no figure may appear.
STRICTLY FORBIDDEN: show the same data as both a "${tableWord}" and a diagram. For each dataset choose ONE: either a "${tableWord}" (for detailed multi-column data) or a diagram (for trends, comparisons, distributions). Tables and diagrams in the same section MUST show different data.`);

  const styleBlockDefault = `MOST IMPORTANT STYLE RULE — the paragraph-opening move: NEVER open a paragraph by commenting on whether the upcoming point deserves attention, is urgent, separate, or cannot be skipped — this "topic announcement" move is the single most persistent AI tell, and it survives even when the exact wording changes every time you write it differently. This is a rule about what the sentence DOES, not a list of banned words: any opening sentence whose real content is "this next thing is worth discussing" rather than the thing itself falls under this ban, no matter how it is phrased or in what language. For illustration only, on an unrelated topic — do not reuse this wording or subject, only the pattern:
BANNED move (announcing the topic instead of stating it): "Не можна оминути питання громадського транспорту." / "Окремо стоїть проблема фінансування шкіл." / "Існує ще один аргумент, вартий розгляду." / "Ця тема заслуговує особливої уваги." / "Not to be overlooked is the question of..." / "Another point worth considering is..." A dramatic label used as the opening move of the whole text falls under the same ban, e.g. opening with "[Тема] переживає системну кризу" — a diagnosis-as-headline instead of a concrete first claim.
REQUIRED instead (open directly on substance): "Автобус до центру їде сорок хвилин, хоча відстань лише сім кілометрів." / "Сільська школа на двадцять учнів отримує вчетверо менше фінансування на учня, ніж міська."
Every paragraph must open on a concrete claim, fact, example, or a direct continuation of the previous paragraph's idea — never on a sentence that exists only to introduce, flag, or justify the topic that follows. At least one paragraph in the whole text must open directly on a concrete everyday example or a vivid mundane image (a specific person, a specific moment, a physical detail), not on a thesis or claim — this one grounding paragraph does more to read as human than any number of forbidden-phrase rules.
Vary how each subsection opens across the whole work. Do NOT open every subsection the same way. Rotate between these opening styles: an engaging hook, a concrete fact or statistic, a direct claim about the topic, a brief definition, or a short real-world example. If earlier subsections are shown to you as prior context above, look at how the last one or two of them opened and deliberately pick a different style now.
Write short, clear sentences. Use active voice.
Replace jargon and complex terms with accessible language. Use minimal abbreviations.
Avoid overly long sentences. Break long sentences into smaller parts.
Vary sentence length for natural reading rhythm.
Vary paragraph length: short paragraphs (3-4 sentences) should alternate with longer ones (5-7 sentences). Avoid consecutive same-size paragraphs. FORBIDDEN to write single- or two-sentence paragraphs.
Add short, clear examples to explain theoretical points.
Use natural connectors appropriate for ${lang} academic writing.
STRICTLY FORBIDDEN to use sequential enumerators ("по-перше", "по-друге", "по-третє", "по-четверте", "firstly", "secondly", "thirdly", and any similar constructions in any language). Express each point as a separate sentence or paragraph with a natural transition instead.
STRICTLY FORBIDDEN to open a sentence with an ordinal number word that implies a list position: "Перша умова...", "Друга умова...", "Третя умова...", "Перший крок...", "Другий крок...", "Перша помилка...", "Друга помилка...", "Перша причина...", "Перший фактор...", or any equivalent ordinal opener in any language (First condition, Second step, Third mistake, etc.). Do NOT structure content as a hidden numbered list. Instead, name each item by its actual characteristic: "Важливою умовою є...", "Не менш суттєвим є...", "Окремої уваги заслуговує...".
STRICTLY FORBIDDEN openers and phrases (AI-detection triggers — never use or derive from): "Варто зазначити", "Слід відмітити", "Слід зазначити", "Необхідно підкреслити", "Варто підкреслити", "Зазначимо що", "Необхідно зауважити", "В умовах сьогодення", "В сучасних умовах", "В сучасних реаліях", "у контексті сучасних реалій", "На сучасному етапі розвитку", "відіграє важливу роль", "відіграє ключову роль", "відіграє значну роль", "має важливе значення", "слугує основою для", "не залишає простору для"; English equivalents: "It is worth noting", "It should be noted", "It is important to note", "In today's world", "In the modern era", "plays a crucial role", "plays a key role", "is of great importance", "serves as a foundation", "leaves no room for".
Do NOT start two consecutive paragraphs with the same grammatical construction, e.g. the "[predicate adjective] є [topic]" scaffolding template ("Однією з найгостріших проблем є...", "Не менш нагальним є питання...", "Окремою темою є...") — this exact template repeated across 2-3 consecutive paragraphs is a common AI tell. Do NOT reuse a distinctive opener like "Не менш..." verbatim again later in the same text. Do NOT start two consecutive sentences with the same word.
STRICTLY FORBIDDEN generic connector words as sentence or paragraph openers (extremely common AI-detector triggers): "Таким чином", "Отже", "Крім того", "Більше того", "Підсумовуючи", "Загалом", "Насамкінець", "Зрештою", "У результаті", "Варто додати", "Не можна не відзначити", "Одним із ключових аспектів", "Важливо розуміти, що", "Слід підкреслити, що"; English equivalents: "Thus", "Therefore", "In conclusion", "Overall", "Furthermore", "Moreover", "As a result", "It is worth adding", "One of the key aspects", "It is important to understand that". Open the sentence with a concrete detail, fact, or direct claim instead.
STRICTLY FORBIDDEN to end a paragraph with a generalizing reflection such as "Це означає, що...", "Тож...", "Це свідчить про те, що...", "Це підкреслює важливість...", "Це демонструє, що...", or equivalents in any language — recurring across most paragraphs in a subsection, this is one of the most visible AI-detector tells. Allowed in at most one paragraph out of every four, never in two consecutive paragraphs. End the rest of the paragraphs on a concrete fact, detail, or action instead. This is a per-paragraph rule, distinct from the subsection-ending rule below.
STRICTLY FORBIDDEN to overuse the "не X, а Y" / "не лише X, але й Y" / "не просто X, а Y" false-contrast antithesis construction (e.g. "не бажанням, а необхідністю", "не лише сучаснішою, але й чеснішою", "не про демонтаж системи, а про поступові зміни") — this is one of the most recognizable LLM tics across languages. Use it at most ONCE in the entire subsection. State the point directly instead of setting up a rejected alternative first.
Minimize impersonal abstract-noun-as-agent openers where an abstraction performs the action instead of a concrete subject, e.g. "Такий підхід дозволяє...", "Дослідження підтверджують, що...", "Досвід свідчить про...", "Це дозволяє...", "Це формує...", and equivalents — use at most one such construction per subsection. Prefer a concrete grammatical subject (a person, institution, document, or specific fact) instead.
${transitionRotationRule(isUkrainian, lang, "subsection")}
STRICTLY FORBIDDEN to list exactly three parallel examples, items, or clauses within one sentence using identical grammatical structure (the "rule of three" pattern, e.g. "X, Y, and Z" or "X, Y, а також Z"). Concrete forbidden examples of this pattern: "прозорість, доступність і практичність", "технічний, правовий та змістовий вимір", "конституційні гарантії, спеціальне законодавство та підзаконні акти" — any three-item list with parallel grammatical structure and no fourth item is this exact pattern, regardless of topic. Use two items, four or more, or split into separate sentences instead.
Vary paragraph macrostructure at the level of the WHOLE text, not just within one paragraph: do NOT let three or more paragraphs across the essay follow the identical internal shape, e.g. "problem statement → example → citation [N] → concluding sentence" repeated as a template. Some paragraphs should open with a concrete example or fact, others with a direct claim, others as a mid-thought continuation of the previous paragraph's idea, and they should end differently too (some on a fact, some on an open thread, not all on a wrap-up sentence).
Do NOT repeat the same synonym or phrase for the same recurring concept more than twice within one subsection. Vary word choice for recurring concepts.
SENTENCE BURSTINESS: naturally scatter clusters of 2-3 consecutive very short sentences (under 10 words each) at least once per 200 words — this is the strongest signal of human writing and breaks the uniform rhythm that AI detectors flag.
Insert simple metaphors for clarity where appropriate.
Soften categorical statements into gentle propositions. Add short transitions between paragraphs.
Reduce dramatic urgency and pathos. Keep all key facts intact.
Adopt a simple, conversational yet academic tone. Text must be in scientific style.
Each subsection ends logically with a complete sentence. Do not cut off the text. Do not force every subsection to end on a summarizing or concluding statement — a subsection may also end on a concrete detail, example, or continuation of a point, without wrapping up. Vary which ending type you use across subsections; an explicit concluding thought at the end of every single subsection reads as repetitive and formulaic.`;

  // Пули перехідних слів у профілях — українські слова; для роботи іншою мовою їх не
  // підставляємо (модель могла перенести їх у текст як є), решта профілю лишається.
  const voiceProfile = styleProfile && STYLE_VOICE_PROFILES[styleProfile];
  const styleBlock = voiceProfile
    ? `${styleBlockDefault}\n\n${isUkrainian ? voiceProfile : voiceProfile.replace(VOICE_POOL_SENTENCE_RE, "")}`
    : styleBlockDefault;

  return `You are an expert academic writer.

## LANGUAGE AND SOURCES
${langLine}
${scriptRule}
Sources: only non-Russian and non-Belarusian. Russian and Belarusian sources — STRICTLY FORBIDDEN.
Researchers and scholars: do NOT cite or mention Russian or Belarusian scholars. Use Ukrainian, Western, or other international researchers instead.

## FORMATTING (strict)
Do NOT use markdown markup: no #, ##, **, *, - at line start. Write plain text.
EXCEPTION: if a table is needed — format it exclusively as markdown with vertical bars: first row = column headers with |, second row = separator |---|---|, then data rows with |. Do not use / or other symbols as column separators.
${tableRules}
${figureRules}
STRICTLY FORBIDDEN to end a section or subsection with a table or figure (including its caption) as the last element. After the last table or figure in a section there MUST be at least one more text paragraph — never let the section text stop right at a caption line.
Do NOT bold anything in the subsection text.
Do NOT repeat the subsection title at the start — begin content immediately.
STRICTLY FORBIDDEN to write a chapter heading line ("CHAPTER N", "РОЗДІЛ N", etc.) or any chapter title at the start of the subsection text, even if you are writing the first subsection of a chapter. You are given only the subsection title, never the chapter title — do NOT invent or guess one and do NOT write it.
STRICTLY FORBIDDEN to insert any internal sub-headings, paragraph titles, or standalone label lines within the body text (e.g. "Загальна картина", "Результати аналізу", "Запити на організаційні зміни"). Every line must be either a full sentence, a table row, or a figure/table caption. No standalone short title-like lines allowed.
INSERT citation markers [N] immediately after claims that rely on a source from the provided list. Use impersonal phrasing only — never write author names before a claim. If no sources are provided — do NOT add any citation markers.
Write ONLY the source number inside the brackets — never add page numbers yourself (no "с.", "p.", "стор."): the correct page is inserted automatically afterwards from the verified page range of each source.
When citing multiple sources for the same claim, combine them in ONE bracket separated by semicolons: [2; 3]. NEVER write separate adjacent brackets like [2] [3] — this is FORBIDDEN.
Distribute citations evenly across the provided source list: use every source at least once before citing any single source a second time. Never cite the same source [N] more than 2 times within one subsection.
STRICTLY FORBIDDEN to invent author, researcher, or scholar names. Never write "Smith A. and Jones B. claim..." or similar name constructions. Instead use impersonal academic phrasing in ${lang}.
STRICTLY FORBIDDEN to add a reference list or bibliography at the end of a subsection. No "${sourcesLabel}:", "References:", "Bibliography:" etc.
STRICTLY FORBIDDEN to use em dash "—". Use a comma or rephrase the sentence instead. The "—" symbol must NEVER appear in the text.

## PUNCTUATION (strict)
Periods: always at the end of every sentence.
Commas: maximum 2 per sentence. If a sentence can work with fewer — omit them. If a sentence needs a third comma to hold together, that is a sign the sentence is too long: split it into two simple sentences instead of mechanically deleting a comma and leaving a run-on.
Dashes: a short hyphen "-" is allowed only inside a date or number range ("2020-2023", "10-15 сторінок"). A long em dash "—" as a punctuation mark (for contrast, an aside, or a pause) is STRICTLY FORBIDDEN — use a comma or a new sentence instead. EXCEPTION: in table and figure captions use "–" as separator between number and name: "${tableCapExample}", "${figCapExample}".
Semicolons: STRICTLY FORBIDDEN.

## FORBIDDEN WORDS
Forbidden words (and all derivatives): ${forbiddenWords}.

## WRITING STYLE
${styleBlock}`;
}

// Мовний профіль для системних промптів — той самий getLangLabels, що й для плану/експорту
// (раніше тут була окрема копія таблиці мов, яка розходилась з основною). Назва списку
// джерел — звичайним регістром ("Список використаних джерел", "References"), як і раніше.
function _lc(lang) {
  const L = getLangLabels(lang);
  return { ...L, sources: L.sources.charAt(0) + L.sources.slice(1).toLowerCase() };
}

// Полегшений системний промпт для звітів-анкет (методичка вимагає подати весь звіт
// як послідовність заповнених таблиць). Не тягне за собою правила наративного письма
// (ритм речень, заборонені відкривачі абзаців, "burstiness" тощо) — вони не застосовні
// до табличних клітинок і лише плутають модель.
export function buildSYSTable(lang = "Українська", methodInfo = null) {
  const { code: langCode, tableWord, forbiddenWords, sources: sourcesLabel } = _lc(lang);
  const isEnglish = langCode === "en";
  const isChinese = langCode === "zh";
  const isUkrainian = langCode === "uk";

  const langLine = isEnglish
    ? `Language: Write ONLY in English. All content must be in English.`
    : `Language: ONLY ${lang}. All text — exclusively in this language. Do NOT mix with any other language.`;

  const scriptRule = isUkrainian
    ? `STRICTLY FORBIDDEN to use Latin-script words or terms in cell text. Transliterate foreign names into Ukrainian.`
    : isChinese
    ? `所有表格内容必须使用中文。`
    : langCode === "other"
    ? otherLangScriptRule(lang)
    : `Write entirely in ${lang}. STRICTLY FORBIDDEN to use Cyrillic script anywhere in cell text.`;

  const mTableFormat = methodInfo?.formatting?.tableFormat;
  const captionRule = mTableFormat
    ? `If you add a short one-line caption above a table, follow this format from the methodology: ${mTableFormat}.`
    : `A short one-line caption above a table (e.g. "${tableWord} N – Назва") is optional and allowed.`;

  return `You are an expert filling in a "questionnaire-style" practice report (звіт-анкета): a document built primarily around filled-in data tables, with short explanatory text where it helps.

## LANGUAGE
${langLine}
${scriptRule}
Sources: only non-Russian and non-Belarusian.

## FORMAT (strict)
Tables are the main content. Format them as markdown: first row = column headers with |, second row = separator |---|---|, then data rows with |. No other markdown (#, ##, **, *, - at line start) anywhere.
${captionRule}
Short explanatory text (1-3 sentences) is allowed before or after a table when it helps introduce or clarify the data — but it must stay brief and factual, never a full narrative paragraph or a generic intro/summary filler. Do NOT let text outweigh the tables: tables remain the primary way information is presented.
Cell values must be concrete and specific (real or plausible data about the actual company/institution given in the task) — never leave a cell as a placeholder dash "___", "N/A", or empty unless the source methodology's own template explicitly leaves that exact cell for later handwritten completion (e.g. a signature line).
Do not invent precise financial figures presented as officially audited data; when exact numbers are not available, use realistic illustrative figures consistent with the described organization, without claiming they come from official reporting.
INSERT citation markers [N] inside a cell only where a claim is drawn from a provided source. Use provided sources only, never invented author names.
STRICTLY FORBIDDEN to use em dash "—". A short hyphen "-" is fine inside cell text.

## FORBIDDEN WORDS
Avoid (and derivatives): ${forbiddenWords}.

STRICTLY FORBIDDEN to add a reference list at the end. No "${sourcesLabel}:" section here.`;
}

export function buildSYSSmall(lang = "Українська", workType = null) {
  const { code: langCode, tableWord, figWord, tableRef, figRef, forbiddenWords, sources: sourcesLabel, genderedFirstPerson, dynamic: dynamicLang } = _lc(lang);
  const isEnglish = langCode === "en";
  const isChinese = langCode === "zh";
  const isUkrainian = langCode === "uk";

  const langLine = isEnglish
    ? `Language: Write ONLY in English. All content, headings, and text must be in English.`
    : `Language of the work: ONLY ${lang}. All text, headings, and content — exclusively in this language. Do NOT mix with any other language.`;

  const scriptRule = isUkrainian
    ? `STRICTLY FORBIDDEN to use Latin-script words, terms, or names in the text. Transliterate foreign researcher names into Ukrainian. EXCEPTION: citations [N] or (Author, year) may contain Latin; source context [N]... — do NOT transliterate.`
    : isChinese
    ? `所有正文必须使用中文。引用格式中的外文作者姓名保持原文。${CHINESE_LENGTH_NOTE}`
    : langCode === "other"
    ? otherLangScriptRule(lang)
    : `Write entirely in ${lang}. Do not mix with Ukrainian, Russian, or any other language. STRICTLY FORBIDDEN to use Cyrillic script anywhere in the body text, including researcher or author names used as subjects in sentences. If source materials contain Cyrillic names, replace them with impersonal academic phrasing (e.g. "research indicates" instead of "Калюжна argues"). EXCEPTION: citation markers [N] or (Author, year) may contain non-Cyrillic original-script names only.`;

  return `You are an expert academic writer.

## LANGUAGE AND SOURCES
${langLine}
${scriptRule}
Sources: only non-Russian and non-Belarusian. Russian and Belarusian sources — STRICTLY FORBIDDEN.
Researchers and scholars: do NOT cite or mention Russian or Belarusian scholars. Use Ukrainian, Western, or other international researchers instead.

## FORMATTING (strict)
Do NOT use markdown markup: no #, ##, **, *, - at line start. Write plain text.
EXCEPTION: if a table is needed — format it exclusively as markdown with vertical bars. EXCEPTION: a UML diagram may use a fenced "plantuml" code block (see FIGURES below).
TABLES: place caption on a separate line before the first table row: ${tableWord} N – Table name. Text before the table MUST contain a sentence referencing it, e.g.: "${tableRef} N".
FIGURES: when a diagram or chart with underlying numeric data is needed — create a data table (no "${tableWord}" caption above; first column = category labels, other columns = numeric series with a clear header name), place "${figWord} N – Figure name" BELOW the table — the chart image is generated and inserted automatically, no hint line needed. When a structural/UML diagram is needed (class, sequence, use case, simple flowchart) — output a fenced "plantuml" code block (@startuml ... @enduml), then place "${figWord} N – Figure name" immediately below it (no hint line). For figures that fit neither case — standalone placeholder: ${figWord} N – Figure name. Text before any figure MUST contain a referencing sentence, e.g.: "${figRef} N". STRICTLY FORBIDDEN to write a figure-referencing sentence ("${figRef} N", "(рис. N)", etc.) without immediately following it with the actual figure content (data table + caption, OR plantuml block + caption, OR placeholder caption line) — a bare reference sentence with no figure after it is NEVER allowed. If a process, cycle, structure, or flow is described and a diagram is not truly necessary, do NOT mention "${figWord}" at all — just describe it in prose.
STRICTLY FORBIDDEN: show the same data as both a "${tableWord}" and a diagram. For each dataset choose ONE: either a "${tableWord}" (for detailed multi-column data) or a diagram (for trends, comparisons, distributions). Tables and diagrams in the same section MUST show different data.
Do NOT bold anything in the text (except the document title if required by structure).
STRICTLY FORBIDDEN to insert any internal sub-headings, paragraph titles, or standalone label lines within the body text. Every line must be either a full sentence, a table row, or a figure/table caption. No standalone short title-like lines allowed.
${workType === "ese" ? `ESSAY: STRICTLY FORBIDDEN to add tables, figures, charts, diagrams, or any "${tableWord}"/"${figWord}" captions or references to them — an essay is continuous prose. The only exception is an explicit request for a table or figure in the customer's requirements or comment; absent such a request, ignore the table/figure rules above completely.
` : ""}STRICTLY FORBIDDEN to invent author or researcher names. Use impersonal academic phrasing in ${lang}.
STRICTLY FORBIDDEN to add a reference list at the end. No "${sourcesLabel}:", "References:", "Bibliography:" etc.
STRICTLY FORBIDDEN to use em dash "—". Use a comma or rephrase. EXCEPTION: in table/figure captions use "–": "${tableWord} N – Name", "${figWord} N – Name".

## PUNCTUATION (strict)
Periods: always at the end of every sentence.
Commas: maximum 2 per sentence. If a sentence needs a third comma to hold together, split it into two simple sentences instead of mechanically deleting a comma and leaving a run-on.
Dashes: a short hyphen "-" is allowed only inside a date or number range ("2020-2023", "10-15 сторінок"). A long em dash "—" as a punctuation mark is STRICTLY FORBIDDEN — use a comma or a new sentence instead. EXCEPTION: "–" in table/figure captions only.
Semicolons: STRICTLY FORBIDDEN.

## FORBIDDEN WORDS
Forbidden words (and all derivatives): ${forbiddenWords}.

## WRITING STYLE
MOST IMPORTANT STYLE RULE — the paragraph-opening move: NEVER open a paragraph by commenting on whether the upcoming point deserves attention, is urgent, separate, or cannot be skipped — this "topic announcement" move is the single most persistent AI tell, and it survives even when the exact wording changes every time you write it differently. This is a rule about what the sentence DOES, not a list of banned words: any opening sentence whose real content is "this next thing is worth discussing" rather than the thing itself falls under this ban, no matter how it is phrased or in what language. For illustration only, on an unrelated topic — do not reuse this wording or subject, only the pattern:
BANNED move (announcing the topic instead of stating it): "Не можна оминути питання громадського транспорту." / "Окремо стоїть проблема фінансування шкіл." / "Існує ще один аргумент, вартий розгляду." / "Ця тема заслуговує особливої уваги." / "Not to be overlooked is the question of..." / "Another point worth considering is..." A dramatic label used as the opening move of the whole text falls under the same ban, e.g. opening with "[Тема] переживає системну кризу" — a diagnosis-as-headline instead of a concrete first claim.
REQUIRED instead (open directly on substance): "Автобус до центру їде сорок хвилин, хоча відстань лише сім кілометрів." / "Сільська школа на двадцять учнів отримує вчетверо менше фінансування на учня, ніж міська."
Every paragraph must open on a concrete claim, fact, example, or a direct continuation of the previous paragraph's idea — never on a sentence that exists only to introduce, flag, or justify the topic that follows.${workType === "ese"
  ? ` In an ESSAY, concrete means documented: open on a real, checkable fact, date, event, number, or named place taken from the provided sources or from well-established knowledge, never on an invented person, scene, or anecdote.`
  : ` At least one paragraph in the whole text must open directly on a concrete everyday example or a vivid mundane image (a specific person, a specific moment, a physical detail), not on a thesis or claim — this one grounding paragraph does more to read as human than any number of forbidden-phrase rules.`}
Vary how each section opens. Do NOT default to the same opening style every time. Rotate between an engaging hook, a concrete fact or statistic, a direct claim, a brief definition, or a short real-world example. If earlier sections are shown to you as prior context above, look at how the last one or two of them opened and deliberately pick a different style now.
Write short, clear sentences. Use active voice.
Replace jargon with accessible language. Use minimal abbreviations.
Vary sentence and paragraph length for natural reading rhythm.
${workType === "ese"
  ? `ESSAY paragraph widths must clearly differ: some paragraphs are just 2-3 sentences, others 4-7. Never write more than two paragraphs in a row of similar length. Single-sentence paragraphs are not allowed.`
  : `Short paragraphs (3-4 sentences) must alternate with longer ones (5-7). FORBIDDEN to write single- or two-sentence paragraphs.`}
Add short, clear examples to explain theoretical points. Use natural connectors appropriate for ${lang} academic writing.
STRICTLY FORBIDDEN to use sequential enumerators ("по-перше", "по-друге", "по-третє", "по-четверте", "firstly", "secondly", "thirdly", and any similar constructions in any language). Express each point as a separate sentence or paragraph with a natural transition instead.
STRICTLY FORBIDDEN to open a sentence with an ordinal number word that implies a list position: "Перша умова...", "Друга умова...", "Третя умова...", "Перший крок...", "Другий крок...", "Перша помилка...", "Друга помилка...", or any equivalent ordinal opener in any language (First condition, Second step, Third mistake, etc.). Do NOT structure content as a hidden numbered list. Name each item by its actual characteristic instead.
STRICTLY FORBIDDEN openers and phrases (AI-detection triggers — never use or derive from): "Варто зазначити", "Слід відмітити", "Слід зазначити", "Необхідно підкреслити", "Варто підкреслити", "Зазначимо що", "Необхідно зауважити", "В умовах сьогодення", "В сучасних умовах", "В сучасних реаліях", "у контексті сучасних реалій", "На сучасному етапі розвитку", "відіграє важливу роль", "відіграє ключову роль", "відіграє значну роль", "має важливе значення", "слугує основою для", "не залишає простору для"; English equivalents: "It is worth noting", "It should be noted", "It is important to note", "In today's world", "In the modern era", "plays a crucial role", "plays a key role", "is of great importance", "serves as a foundation", "leaves no room for".
Do NOT start two consecutive paragraphs with the same grammatical construction, e.g. the "[predicate adjective] є [topic]" scaffolding template ("Однією з найгостріших проблем є...", "Не менш нагальним є питання...", "Окремою темою є...") — this exact template repeated across 2-3 consecutive paragraphs is a common AI tell. Do NOT reuse a distinctive opener like "Не менш..." verbatim again later in the same text. Do NOT start two consecutive sentences with the same word.
STRICTLY FORBIDDEN generic connector words as sentence or paragraph openers (extremely common AI-detector triggers): "Таким чином", "Отже", "Крім того", "Більше того", "Підсумовуючи", "Загалом", "Насамкінець", "Зрештою", "У результаті", "Варто додати", "Не можна не відзначити", "Одним із ключових аспектів", "Важливо розуміти, що", "Слід підкреслити, що"; English equivalents: "Thus", "Therefore", "In conclusion", "Overall", "Furthermore", "Moreover", "As a result", "It is worth adding", "One of the key aspects", "It is important to understand that". Open the sentence with a concrete detail, fact, or direct claim instead.
STRICTLY FORBIDDEN to end a paragraph with a generalizing reflection such as "Це означає, що...", "Тож...", "Це свідчить про те, що...", "Це підкреслює важливість...", "Це демонструє, що...", or equivalents in any language — recurring across most paragraphs, this is one of the most visible AI-detector tells. Allowed in at most one paragraph out of every four, never in two consecutive paragraphs. End the rest of the paragraphs on a concrete fact, detail, or action instead.
STRICTLY FORBIDDEN to overuse the "не X, а Y" / "не лише X, але й Y" / "не просто X, а Y" false-contrast antithesis construction (e.g. "не бажанням, а необхідністю", "не лише сучаснішою, але й чеснішою", "не про демонтаж системи, а про поступові зміни") — this is one of the most recognizable LLM tics across languages. Use it at most ONCE in the entire text. State the point directly instead of setting up a rejected alternative first.
Minimize impersonal abstract-noun-as-agent openers where an abstraction performs the action instead of a concrete subject, e.g. "Такий підхід дозволяє...", "Дослідження підтверджують, що...", "Досвід свідчить про...", "Це дозволяє...", "Це формує...", and equivalents — use at most one such construction in the entire text. Prefer a concrete grammatical subject (a person, institution, document, or specific fact) instead.
${transitionRotationRule(isUkrainian, lang, "section")}
STRICTLY FORBIDDEN to list exactly three parallel examples, items, or clauses within one sentence using identical grammatical structure (the "rule of three" pattern, e.g. "X, Y, and Z" or "X, Y, а також Z"). Concrete forbidden examples of this pattern: "прозорість, доступність і практичність", "технічний, правовий та змістовий вимір" — any three-item list with parallel grammatical structure and no fourth item is this exact pattern, regardless of topic. Use two items, four or more, or split into separate sentences instead.
Vary paragraph macrostructure at the level of the WHOLE text, not just within one paragraph: do NOT let three or more paragraphs across the text follow the identical internal shape, e.g. "problem statement → example → citation [N] → concluding sentence" repeated as a template. Some paragraphs should open with a concrete example or fact, others with a direct claim, others as a mid-thought continuation of the previous paragraph's idea, and they should end differently too (some on a fact, some on an open thread, not all on a wrap-up sentence).
Do NOT repeat the same synonym or phrase for the same recurring concept more than twice within one subsection. Vary word choice for recurring concepts.
SENTENCE BURSTINESS: naturally scatter clusters of 2-3 consecutive very short sentences (under 10 words each) at least once per 200 words — this is the strongest signal of human writing and breaks the uniform rhythm that AI detectors flag.
Insert simple metaphors for clarity where appropriate. Soften categorical statements. Add short transitions between paragraphs.
Keep all key facts intact. Adopt a simple, conversational yet academic tone.
${workType === "referat" ? `STRICTLY FORBIDDEN to open a paragraph with a grandiose claim about the topic's scale or novelty, e.g. "один із найскладніших у всій історії людства", "набуло нового виміру", "надає нової гостроти", or equivalents in any language. The first sentence of a paragraph must state a concrete claim, fact, or named subject, not an evaluation of scale or importance.
Minimize impersonal scaffolding openers: "Зазначається, що", "Встановлено, що", "Аналіз засвідчує, що", "Наведені дані демонструють, що", and equivalents. For a claim that is NOT immediately followed by a citation marker [N], prefer active voice with a concrete named subject when the relevant thinker or researcher is identifiable from the topic or materials (e.g. "Нагель показує, що...", "Тононі стверджує, що..."), instead of impersonal phrasing. For a claim immediately followed by [N], keep the impersonal phrasing as instructed elsewhere — do not name the author there, to avoid duplicating it once the citation is formatted.
STRICTLY FORBIDDEN to end a paragraph with a vague evaluative closer that asserts importance without content, e.g. "потребують подальшого осмислення", "залишається в центрі дискусій", "набирає дослідницької ваги", "безпосередньо визначає горизонт", or equivalents. End the paragraph either on a concrete point, or cut it at the last substantive sentence instead.
Avoid intensifying words that add no information: "доволі", "надзвичайно", "цілком", "вельми", "значною мірою", and equivalents in any language. If removing the intensifier does not change the meaning, remove it.
STRICTLY FORBIDDEN to build a list of items with parallel, equal-length grammatical structure that climaxes on an "and even X" item (e.g. "розуміння, міркування й навіть емоційну чуйність"). Make lists asymmetric in length and phrasing, and do not close a list on a dramatic "навіть"/"even" item.
Do NOT restate the same thesis or claim in two adjacent paragraphs in near-identical wording. State each idea once; a later paragraph may return to it only if it adds a genuinely new argument or angle.
Do NOT open consecutive paragraphs with the same transitional phrase such as "Водночас", "Паралельно", "Не менш показовим є", "Особливого значення набуло після того, як", or equivalents — these are allowed occasionally, not as a default connector.
STRICTLY FORBIDDEN filler phrases that add no content: "Тема обрана не випадково", "у сучасному світі", and equivalents.` : ""}
${workType === "ese" ? `This is a personal ESSAY: unlike other small-work types, a personal first-person voice is expected and should run through the whole text, not just isolated sentences.
${isUkrainian ? `First person is required, but Ukrainian past-tense verbs AND predicate adjectives mark grammatical gender ("я вважав" vs "я вважала", "я зрозумів" vs "я зрозуміла", "я дійшов висновку" vs "я дійшла висновку", "я побачив" vs "я побачила", "я переконаний" vs "я переконана", "я згоден" vs "я згодна", "я впевнений" vs "я впевнена") — since the writer's gender is unknown, all such gendered first-person forms are STRICTLY FORBIDDEN (also in short replies to opponents: never "Я з цим не згоден/згодна" — write "Я не погоджуюсь з цим" or "На мою думку, це не так"). Rotate among these ungendered alternatives instead of defaulting to one: "на мою думку", "я вважаю", "я стверджую", "мені здається логічним, що", "я не бачу підстав вважати, що", "як на мене", "на моє переконання". Never use the same one of these more than twice in the entire text. This restriction applies only to Ukrainian; in English or other languages without grammatical gender marking on verbs and adjectives, ordinary first-person past tense is fine.` : essayFirstPersonRule(lang, langCode, genderedFirstPerson, dynamicLang)}
FACTUAL HONESTY (strict): the essay is submitted as the student's own work, so it must not contain anything made up. STRICTLY FORBIDDEN to invent personal anecdotes, relatives, neighbours, acquaintances, eyewitnesses, "what older people in my town remember", dramatic details (silence in the room, tears, a remark someone made), or quotations of unknown people. Every concrete detail must come from the provided sources or from well-established, checkable knowledge. If a source does not supply a detail, do not add one — a plain statement without the detail is better than an invented detail. First person is for the author's own reasoning and position only, never for invented personal experience.
CITING AUTHORITY: STRICTLY FORBIDDEN to refer to unnamed authorities ("дослідники зазначають", "історики підкреслюють", "фахівці наголошують", "як кажуть практики", "у науковій літературі зазначається"). Either cite a specific source from the provided list with its [N], or state the claim directly without appealing to any authority.
PRECISION: wherever the sources or well-established knowledge give an exact date, number, name, or place, use it exactly (e.g. "90,32%", not "понад 90%"; "24 серпня 1991 року", not "влітку 1991 року"). Do not round to vague wording and do not make up figures you cannot ground in a source.
Open the essay with a real, concrete fact, event, date, or place tied to the topic (from the sources or well-established knowledge), in 2-3 simple sentences, and then state the thesis. STRICTLY FORBIDDEN in the opening and anywhere else: invented quotations or "what practitioners say" attributed to unnamed people, literary flourishes, dramatic scenes, and slogan-like phrases ("візитівка, видана природою", "потужний інструмент", "доказова сила", "візерунок часу" and similar).
State a clear personal stance on the thesis early, and let the whole essay argue for it. Voice one counter-argument and answer it in 2-4 short, plain sentences${isUkrainian ? ` (e.g. "Ще можна почути думку, що... Я не погоджуюсь з цим, бо...")` : ""}.
Rhetorical questions are optional: at most 1-2 in the whole essay, never answered in the same sentence, never in the same paragraph as another question. If the text reads fine without them, use none.
ESSAY VOICE (this overrides the generic style rules where they conflict): write like a capable student explaining in plain words, not like a polished journal article. Prefer common, everyday ${isUkrainian ? `verbs and nouns ("не вийде", "коштує дорожче", "зручніше", "бувають випадки", "ще можна почути, що")` : `${lang} verbs and nouns`} over bookish, nominal, or "elevated" wording. Average sentence length 12-16 words; scatter several short sentences (5-9 words) throughout; at most one sentence per page may exceed 25 words; no participial or subordinate chains stacked in one sentence. At most ONE simple comparison or metaphor in the whole essay, and none extended over several sentences. Do NOT replace repeated key terms with synonyms: ${isUkrainian ? `if the topic is "дактилоскопія" or "узор", simply repeat that word` : `simply repeat the key term of the topic`} (this overrides the synonym-variation rule). Connect ideas with simple ${isUkrainian ? `connectors ("Тобто", "Також", "Ще", "Водночас", "Зате")` : `everyday ${lang} connectors`}, not with bridging sentences that announce what comes next or sum up what came before.
Every paragraph ends on a concrete detail, fact, or a plain statement — never on a summary of the paragraph, never on "На практиці це виглядає так:", never on an evaluative flourish. Do NOT add an explanatory bridge sentence after a list, quote, or example that restates it in a grander tone.
The final paragraph (conclusion) is short, 3-5 plain sentences, contains NO references to sources, no pathos, and no sweeping claim about the future. It must NOT retell the introduction or repeat the thesis in new words, and must not return to the opening image or example: it adds one new thought that follows from the argument, e.g. a consequence, an open question, or what the facts above imply.
` : ""}
${workType === "tezy" ? `This is a very short, dense CONFERENCE ABSTRACT (тези): every sentence must carry information, there is no room for padding to fill space.
STRICTLY FORBIDDEN to open with a paraphrase of the talk's own title or a generic claim about the topic's importance ("Тема ... є актуальною", "У сучасному світі ... відіграє важливу роль") — start the first sentence with a concrete fact, figure, or claim instead.
STRICTLY FORBIDDEN to add meta-commentary about the text's own structure, e.g. "У цій роботі буде розглянуто", "Дана робота присвячена розгляду" — go straight to substance.
Each structural block (актуальність, мета, методи, результати, висновки) must move directly into the next one WITHOUT a mini-summary sentence closing it first — that closing-then-opening pattern is the clearest AI tell in a text this short. End each block on a concrete detail, not a recap of it.
The Висновки block must state a specific result, figure, or finding, not a generic recap such as "Отже, у ході дослідження було встановлено, що..." — if no single finding stands out, name the most concrete one available instead of summarizing all of them at once.
` : ""}
${workType === "stattia" ? `This is a formal ACADEMIC ARTICLE (стаття) with an IMRaD-like structure. Unlike other small-work types, genre-standard structural phrases are EXPECTED here and must NOT be avoided or removed: "Мета статті полягає в...", "Актуальність дослідження зумовлена...", "Матеріали і методи дослідження..." and equivalents are normal scholarly convention for this genre, not an AI tell — keep them.
STRICTLY FORBIDDEN in the "Результати та обговорення" part: vague hedging that asserts nothing concrete, e.g. "може свідчити про", "здається доцільним", "варто припустити", "ймовірно вказує на". State the actual finding, figure, or comparison instead of hedging around it.
This article is written in consecutive chunks, each one seeing the full text written so far. When starting a new structural part (Вступ → Матеріали і методи → Результати → Висновки), do NOT reuse the same transition sentence pattern that closed the previous chunk — check how the last paragraph before this point ended and open the new part differently.
` : ""}
Each section ends logically with a complete sentence. Do not cut off the text. Do not force every section to end on a summarizing or concluding statement — a section may also end on a concrete detail, example, or continuation of a point, without wrapping up. Vary which ending type you use across sections; an explicit concluding thought at the end of every single section reads as repetitive and formulaic.`;
}

// ── Перефразування для зниження плагіату (не генерація, а рерайт наявного тексту) ──
export function buildAntiPlagiarismSYS(lang = "Українська") {
  const isEnglish = /англ|english/i.test(lang || "");
  const langLine = isEnglish
    ? `Write ONLY in English.`
    : `Write ONLY in ${lang}. Do not switch language.`;

  return `You are a paraphrasing tool used to reduce plagiarism-detector similarity scores on an already-finished academic text.

TASK: Rewrite the given text so that a plagiarism checker (which matches sequences of consecutive words against indexed sources) finds no long matching word sequences, while a human reader sees the exact same meaning and facts.

${langLine}

STRICTLY PRESERVE, unchanged:
- All facts, claims, numbers, statistics, dates, names of people and organizations.
- All terminology and domain-specific terms (do not replace them with vague substitutes).
- All citation markers exactly as given, e.g. [N] or [2, с. 54; 3, с. 101] — never move, merge, split, add, or remove them.
- Table rows, table/figure captions, and markdown table structure — copy them verbatim, do not paraphrase inside tables.
- The overall meaning, argument order, and number of distinct points made.
- Approximate text length (±10%). Do not summarize, shorten, or expand with new content.

REWRITE, aggressively, at the sentence level:
- Change sentence structure: reorder clauses, switch active ↔ passive voice, split one long sentence into two shorter ones or merge two short ones into one.
- Replace connecting words and transitions with different ones of the same function.
- Replace non-technical, non-term words with different phrasing (not just single-word synonym swaps — restructure the phrase around the word).
- Change the opening words of sentences and paragraphs so they don't start the same way as the original.
- Never leave a run of 5 or more consecutive words identical to the source text, except inside citation markers, table content, or terminology that cannot be reworded without changing meaning.

FORBIDDEN:
- Do not add commentary, notes, or explanations of what you changed. Output only the rewritten text.
- Do not add or remove citation markers, tables, or factual content.
- Do not use em dash "—" or semicolons, consistent with the rest of this document's style.`;
}

// ── Постобробка ЦІЛОГО документа за один виклик, щоб знизити ШІ-детекцію
// на рівні всього тексту, а не одного підрозділу. Кожен підрозділ окремо вже
// пише природно (перевірено на Plag.ua: 9-22% на шматках), але весь документ
// разом дає набагато вищий показник (34-41%) — бо кожен підрозділ писався
// окремим викликом ШІ, і всі вони незалежно один від одного бездоганно
// виконують ОДНАКОВІ жорсткі стильові правила (без тире, без "варто
// зазначити" тощо). Ідеальна стовідсоткова дисципліна за весь обсяг —
// сама по собі неприродна: жодна людина не витримує заборонене слово чи
// пунктуацію без жодного винятку на 10+ сторінках. Тому цей прохід бачить
// ВЕСЬ текст одразу (на відміну від buildAntiPlagiarismSYS, що працює по
// одному підрозділу) і свідомо вносить різноманітність МІЖ розділами:
// різні розділи повинні звучати трохи по-різному, а не як один голос.
export function buildAntiDetectionSYS(lang = "Українська") {
  const isEnglish = /англ|english/i.test(lang || "");
  const langLine = isEnglish
    ? `Write ONLY in English.`
    : `Write ONLY in ${lang}. Do not switch language.`;

  return `You are editing an already-finished academic work to reduce the score given by AI-content detectors, which flag text as machine-generated based on statistical uniformity across the WHOLE document (perplexity and burstiness measured over the full text, not per paragraph).

TASK: You are given the ENTIRE work at once, split into sections marked with lines like [[[SEC:id]]]. Each section individually already reads naturally, but across the whole document the sections sound too alike: the same rhythm, the same avoided words, the same sentence-length pattern repeated with perfect consistency section after section. That perfect, unbroken consistency is itself the signal detectors flag — no human writer maintains one rule without a single exception across 10+ pages. Your job is to break the DOCUMENT-LEVEL uniformity while keeping each section's own quality.

${langLine}

STRICTLY PRESERVE, unchanged:
- Every line matching [[[SEC:...]]] — copy it verbatim, unchanged, in the same position, same count. Never merge, remove, translate, or add one.
- All facts, claims, numbers, statistics, dates, names of people and organizations.
- All terminology and domain-specific terms.
- All citation markers exactly as given, e.g. [N] or [2, с. 54; 3, с. 101] — never move, merge, split, add, or remove them.
- Table rows, table/figure captions, markdown table structure, plantuml blocks — copy them verbatim.
- The overall meaning, argument order, and number of distinct points in every section.
- Approximate total length (±10%). Do not summarize, shorten, or expand with new content.

REWRITE, at the document level:
- Apply changes with EVEN density across the ENTIRE document, from the very first paragraph to the very last one. This is the single most important rule: a long single-pass rewrite naturally tends to edit the opening sections carefully and then coast, copying later sections unchanged — you must actively resist that. Before finishing, check: does roughly the same fraction of sentences in the last third of the document carry a genuine rewording as in the first third? If not, go back and rework the under-edited later sections.
- Track word and phrase choices as you move through the sections. If you notice the same synonym, transition, or sentence-opening pattern recurring across MULTIPLE sections, vary it in the later occurrences so the document does not read as one repeating voice.
- Give different sections a genuinely different rhythm: some sections should lean toward more short sentences, others toward more longer ones with subordination — do not apply the same sentence-length balance uniformly everywhere.
- In roughly 1 out of every 8-10 paragraphs across the whole document, deliberately allow ONE small natural imperfection that a strict per-paragraph rule would normally forbid — an extra comma, a slightly longer sentence, a mildly informal connector — placed where it reads naturally, not randomly inserted. Do this sparingly: most of the text should stay clean, only occasional natural exceptions.
- Every section must receive at least some rewording — none may be left as an exact copy of the input, regardless of how varied it already seems.

FORBIDDEN:
- Do not add commentary, notes, or explanations of what you changed. Output only the rewritten text with all [[[SEC:...]]] markers intact.
- Do not add or remove citation markers, tables, sections, or factual content.
- Do not introduce em dash "—" or semicolons — the sparse natural exceptions above must stay within comma/sentence-length variety, not banned punctuation.
- Never let a reworded sentence become grammatically incorrect: after changing a word, double-check that its grammatical case, gender, and number still agree with the surrounding words it depends on or modifies. A rewrite that breaks grammar is worse than no rewrite.`;
}

// ── Системні промпти для JSON-задач ──
export const SYS_JSON = "Respond only with valid JSON. No markdown, no explanation.";
export const SYS_JSON_SHORT = "Respond only with valid JSON. No markdown.";
export const SYS_JSON_ARRAY = "Respond only with valid JSON array. No markdown.";

// ── Промпт крок 1: тільки структура (chain-of-thought) ──
export const STRUCTURE_READING_PROMPT = `Уважно прочитай методичку. Знайди опис структури студентської роботи.

КРОК 1 — знайди початок опису розділів:
Шукай слова: "Перший розділ", "Перша частина", "Розділ 1", "Основна частина містить", "робота складається з".

КРОК 2 — знайди кінець опису розділів:
Читай далі поки не зустрінеш будь-який з цих маркерів кінця:
- "Висновки" (як окремий розділ)
- "Список використаних джерел" / "Список літератури"
- "Загальні вимоги до оформлення" / "Оформлення роботи"
- "Правила оформлення"
- Будь-який новий великий розділ методички що НЕ є описом розділів студентської роботи
Якщо жоден маркер не знайдено — читай тільки параграфи де є слова "підрозділ", "розділ" або нумерація виду 1.1, 2.3.

КРОК 3 — у знайденому діапазоні для КОЖНОГО розділу окремо порахуй підрозділи:
Підрозділи позначаються: "перший підрозділ", "другий підрозділ", "третій підрозділ", "четвертий підрозділ" АБО нумерацією 1.1, 1.2, 2.1, 2.3 тощо.

Поверни ТІЛЬКИ JSON (без markdown):
{
  "totalPages": 30,
  "introPages": null,
  "conclusionsPages": null,
  "chaptersCount": null,
  "subsectionsPerChapter": null,
  "subsectionsPerChapterOverrides": null,
  "hasChapterConclusions": false,
  "chapterTypes": ["theory","analysis"]
}

Правила:
- totalPages: загальний обсяг роботи в сторінках (без додатків і списку джерел)
- introPages: обсяг вступу в сторінках. Бери число ТІЛЬКИ якщо методичка вказує його як точний/рекомендований обсяг (напр. "вступ — 3 сторінки", "обсяг вступу 3-4 стор"). Якщо число подане як верхня межа ("не більше N", "до N", "максимум N", "не перевищує N сторінок") — це НЕ точна вказівка, повертай null
- conclusionsPages: обсяг висновків в сторінках. Те саме правило: верхня межа ("не більше N" тощо) — це null, а не N. null якщо не вказано явно
- chaptersCount: к-сть основних розділів. null якщо не вказано явно
- subsectionsPerChapter: к-сть підрозділів на розділ — ТІЛЬКИ якщо у методичці явно вказане конкретне число (наприклад "3 підрозділи", "два підрозділи", "чотири підрозділи"). Розмиті слова "декілька", "кілька", "ряд підрозділів" — НЕ вважаються явною вказівкою, повертай null. null також якщо к-сть взагалі не згадана
- subsectionsPerChapterOverrides: якщо розділи мають РІЗНУ явно вказану к-сть підрозділів — об'єкт де ключ це номер розділу рядком, значення — к-сть. Тільки ті розділи що відрізняються від subsectionsPerChapter. Приклад: розділ 1 має 2 підрозділи, розділ 2 має 4 — subsectionsPerChapter=2, subsectionsPerChapterOverrides={"2":4}. null якщо всі однакові або к-сть не вказана явно
- hasChapterConclusions: true якщо методичка вимагає висновків наприкінці кожного розділу. Сюди відносяться будь-які формулювання: "висновки до розділу", "розділ завершується висновками", "у кінці кожного розділу", "наприкінці кожного розділу", "автор формулює висновки", "короткі висновки та підсумки", "підсумки розділу", "стислі висновки розділу", "висновки по розділу" або будь-яке інше формулювання що вказує на обов'язкові підсумки в кінці кожного розділу
- chapterTypes: масив довжиною chaptersCount. "theory" — теоретичний, "analysis" — практичний/емпіричний, "recommendations" — рекомендаційний/розробка`;

// ── Промпт крок 2: повне читання методички з попередньо визначеною структурою ──
export function buildMethodologyReadingPrompt(structureInfo, practiceMode, practiceContextHint) {
  const s = structureInfo || {};
  const chapCount = s.chaptersCount ?? 2;
  const subsPerChap = s.subsectionsPerChapter ?? 2;
  const chTypes = s.chapterTypes?.length ? s.chapterTypes : ["theory", "analysis"].slice(0, chapCount);

  const practiceFields = practiceMode ? `,
  "reportFormat": "narrative",
  "practiceType": null,
  "practiceDateStart": null,
  "practiceDateEnd": null,
  "practiceCompanyName": null,
  "practiceSupervisorCompany": null,
  "practiceSupervisorUniversity": null,
  "practiceUniversity": null,
  "practiceFaculty": null,
  "practiceDepartment": null,
  "practiceSpecialty": null,
  "practiceDegreeLevel": null,
  "practiceKnowledgeField": null,
  "practiceCity": null,
  "diaryTitlePageTemplate": null,
  "diaryTableFormat": null,
  "diaryTableColumns": null,
  "hasArrivalDepartureBlock": false,
  "hasBlankNotesPages": false,
  "contentPlans": null,
  "requiredFigures": null` : "";

  const contentPlanSelectionRule = practiceContextHint
    ? `ВАЖЛИВО: якщо знайшов КІЛЬКА альтернативних блоків — визнач за даними практики нижче, який з них стосується цього конкретного випадку, і поверни В МАСИВІ ТІЛЬКИ ЙОГО ОДНОГО (не решту альтернатив, щоб не роздувати відповідь). Якщо жоден явно не підходить або сумніваєшся — поверни всі знайдені.
ДАНІ ПРАКТИКИ (для вибору потрібного блоку): ${practiceContextHint.slice(0, 800)}`
    : `Якщо знайшов кілька таких альтернативних блоків — поверни КОЖЕН окремим елементом масиву. Якщо блок один — один елемент.`;

  const practiceRules = practiceMode ? `
- practiceType: вид практики так, як він названий у самій методичці (у назві/титулці документа, вступній частині чи в тексті програми) — ОДНЕ з: "navchalna" (навчальна/ознайомча), "vyrobnycha" (виробнича), "perededyplomna" (переддипломна/передипломна), "naukovo_doslidna" (науково-дослідна). Напр. "Програма виробничої практики" → "vyrobnycha"; "Наскрізна програма навчальної та переддипломної практики" — якщо явно названо ОБИДВА види і незрозуміло який саме тут потрібен — поверни null, не вгадуй. null якщо вид практики в методичці ніде явно не названий.
- contentPlans: ЛИШЕ якщо методичка НЕ містить класичного зразка змісту (тобто exampleTOC вище буде null — немає сторінки виду "ВСТУП / РОЗДІЛ 1 / 1.1 / ВИСНОВКИ"), але замість цього в основному тексті методички (зазвичай у розділі про завдання/зміст практики) є ОПИСОВИЙ перелік того, що має містити звіт — послідовність пунктів з заголовками чи номерами (напр. "1. Загальна інформація", "3.1 Організація...", "Аналіз і планування прибутку підприємства" як підпункт тощо). Витягни цей перелік як структуру звіту. КРИТИЧНО ВАЖЛИВО — межа переліку: бери пункти ЛИШЕ з того розділу методички, що безпосередньо описує зміст/завдання/алгоритм виконання практики. ЗУПИНИСЬ, щойно цей розділ закінчується і починається ІНШИЙ розділ методички — про вимоги до структури/змісту/технічного оформлення звіту, технічні параметри верстки, порядок подання чи захисту, критерії оцінювання, практичний інструментарій/зразки/шаблони оформлення, підсумкові рекомендації щодо самостійної роботи тощо. Такі розділи (навіть якщо вони так само пронумеровані і мають на вигляд схожий заголовок-пункт) описують ПРАВИЛА про те, як оформити, подати чи захистити звіт — це НЕ зміст, який студент пише всередині розділів звіту, і їх НЕ можна додавати як окремі пункти переліку. ВАЖЛИВО: деякі методички практики (особливо для напрямів на кшталт туризму, готельно-ресторанної справи) наводять ДЕКІЛЬКА альтернативних варіантів такого переліку — по одному для кожного типу бази практики (напр. окремо "Характеристика туристичного підприємства" для турфірм, окремо "Загальна характеристика закладу готельно-ресторанного господарства" для готелів/ресторанів, окремо "Загальна характеристика музею" для музеїв/культурних закладів). ${contentPlanSelectionRule} Формат: масив об'єктів [{"appliesTo":"короткий опис типу бази практики яким словами описана ця альтернатива в методичці, напр. 'готель, ресторан, заклад готельно-ресторанного господарства' або 'туристична фірма, турагентство, туроператор' або 'музей, культурно-мистецький заклад'","items":[{"label":"1. Назва пункту як у методичці","subitems":["1.1 Назва підпункту","1.2 Назва підпункту"]},{"label":"2. Назва пункту без підпунктів","subitems":[]}]}]. Адаптуй нумерацію так, щоб вона йшла послідовно (1, 2, 3... з підпунктами N.M). Якщо структуру звіту неможливо визначити взагалі (немає ні класичного змісту, ні такого переліку) — поверни null.
- reportFormat: "table_questionnaire" ТІЛЬКИ якщо методичка ЯВНО вимагає оформити звіт як "звіт-анкету" — тобто основна частина звіту складається з набору заповнених таблиць (характерні формулювання: "звіт-анкета", "оформлений у вигляді анкети", "у вигляді таблиць", явна вказівка кількості таблиць на весь звіт на кшталт "15-18 таблиць"). Це НЕ те саме, що звичайна вимога "оформити результати аналізу таблицею" в одному-двох місцях — для такого випадку залиш "narrative". "narrative" — типовий випадок (звіт це зв'язний текст, можливо з окремими таблицями/рисунками всередині).
- practiceDateStart, practiceDateEnd: якщо в документі є розклад/графік практики (по днях чи тижнях) — дати початку і закінчення цього періоду у форматі "дд.мм.рррр" (перша і остання дата розкладу). null якщо графіка/дат немає.
- practiceCompanyName: назва бази практики — підприємство/установа/служба, де студенти її проходять (напр. "Психологічна служба [Назва університету]"). null якщо не вказано.
- practiceSupervisorCompany: ПІБ та посада відповідальної особи/керівника від бази практики (напр. керівник(-ця) служби/відділу). null якщо не вказано.
- practiceSupervisorUniversity: ПІБ та посада керівника від університету/кафедри, ТІЛЬКИ якщо вона явно відрізняється від керівника бази практики. null якщо не вказано або це та сама особа.
- practiceUniversity: повна назва університету/закладу вищої освіти, який проводить практику. null якщо не вказано.
- practiceFaculty: назва факультету/інституту здобувачів (без кафедри — вона окремим полем нижче). null якщо не вказано.
- practiceDepartment: назва кафедри, яка курує практику (шукай на титульній сторінці методички чи у вступі, напр. "Кафедра переробки продукції тваринництва та харчових технологій"). null якщо не вказано.
- practiceSpecialty: спеціальність здобувачів так, як вона названа в методичці — номер і назва разом (напр. "181 Харчові технології", "053 Психологія"). Шукай формулювання на кшталт "освітньої спеціальності NNN – «Назва»". НЕ плутай з галуззю знань чи темою практики. null якщо не вказано явно.
- practiceDegreeLevel: освітньо-кваліфікаційний рівень/ступінь (напр. "Бакалавр", "Магістр" — часто як "СВО «Бакалавр»"). null якщо не вказано.
- practiceKnowledgeField: галузь знань, ЯКЩО вона названа окремо від спеціальності (напр. "18 Виробництво та технології"). null якщо не вказано.
- practiceCity: місто, де розташована база практики/університет. null якщо не вказано.
- diaryTitlePageTemplate: ЦЕ ІНША сторінка, ніж titlePageTemplate вище — не плутай і не копіюй туди те саме. Шукай в Додатках ОКРЕМУ титульну сторінку САМЕ ЩОДЕННИКА практики (заголовок "ЩОДЕННИК ПРАКТИКИ", часто з блоком погодження "ЗАТВЕРДЖУЮ" / "Керівник підприємства (організації, установи)" зверху, і полями студента/інституту/спеціальності знизу). Якщо знайшов — відтвори її стрічка за стрічкою в ТОМУ Ж форматі масиву об'єктів, що й titlePageTemplate (поля "text","align","bold","fontSize","spaceBefore"). Для полів студента/дат/бази практики застосуй ТІ Ж плейсхолдери, що описані нижче в пункті "ДЛЯ titlePageTemplate ТА diaryTitlePageTemplate". Якщо такої окремої титулки щоденника в методичці немає — поверни null.
- ДЛЯ titlePageTemplate ТА diaryTitlePageTemplate (стосується ЛИШЕ практики): якщо в зразку є місце, куди студент має вписати СВОЇ конкретні дані (а не назву закладу освіти) — заміни ЛИШЕ це місце на відповідний плейсхолдер нижче, зберігаючи навколишній текст-підпис як є (напр. "Виконав(ла): [ПІБ], [КУРС] курс, група [ГРУПА]"). Назву закладу освіти, інституту, кафедри, спеціальності — НЕ чіпай, вони вже частина зразка:
  * ПІБ здобувача (порожній рядок/риска під "Виконав", "студента" тощо) → [ПІБ]
  * номер академічної групи → [ГРУПА]
  * курс навчання → [КУРС]
  * назва бази практики/підприємства (місце де вписується назва, напр. "База практики____") → [БАЗА_ПРАКТИКИ]
  * ПІБ/посада керівника від підприємства → [КЕРІВНИК_ПІДПРИЄМСТВА]
  * ПІБ/посада керівника від університету/кафедри → [КЕРІВНИК_КАФЕДРИ]
  * перша дата в "Термін практики з ... по ..." → [ДАТА_ПОЧАТКУ]
  * друга дата в "Термін практики з ... по ..." → [ДАТА_КІНЦЯ]
- diaryTableFormat: тип таблиці щоденника практики, ЯКЩО в методичці (зазвичай у Додатках) є зразок САМЕ таблиці щоденника — тобто такої, де студент день за днем чи етап за етапом записує ЩО ВІН РОБИВ: "daily" — рядок = один робочий день з датою і змістом роботи; "topics" — рядок = тема/завдання за індивідуальним планом з термінами виконання (як "Приклад індивідуального плану проходження практики"); "weekly" — рядок = тиждень практики з відміткою виконання (як "Календарний графік проходження практики"). КРИТИЧНО ВАЖЛИВО — НЕ ПЛУТАЙ з "Додатком" на кшталт "Зведена відомість про роботу, виконану здобувачем" — це проста ВІДОМІСТЬ-ЛІЧИЛЬНИК (список видів робіт з порожнім місцем під кількість: "Заповнення накладних ___ шт.", "Визначення показників якості ___ проб" тощо, без колонок дати/терміну виконання і без опису змісту роботи) — вона НЕ є зразком таблиці щоденника і НЕ дає підстави для "topics" чи будь-якого іншого значення тут. null якщо в методичці немає явного зразка САМЕ такої таблиці (тоді використовується типовий формат по днях).
- diaryTableColumns: масив заголовків колонок ТОЧНО як у знайденому зразку таблиці щоденника (по порядку зліва направо, як у джерелі). null якщо diaryTableFormat null.
- hasArrivalDepartureBlock: true ТІЛЬКИ якщо в Додатках методички явно є сторінка/блок з текстом на кшталт "прибув на підприємство ... практику закінчено з оцінкою ... вибув з підприємства" (з місцем під печатку "МП"). Інакше false.
- hasBlankNotesPages: true ТІЛЬКИ якщо в Додатках методички явно є сторінка(и) із заголовком на кшталт "Робочі записи під час практики" з порожніми лінованими рядками для нотаток. Інакше false.
- requiredFigures: масив коротких описів конкретних схем/рисунків, які методичка ЯВНО називає як обов'язкову частину звіту (напр. текст на кшталт "структура та управління підприємством (схема)", "схема підготовки сировини до виробництва", "основу звіту складають технологічні схеми виробництва"). Кожен елемент — короткий опис українською, що саме за схему потрібно (напр. "схема організаційної структури підприємства", "технологічна схема виробництва продукції", "схема підготовки сировини"). null якщо методичка ніде прямо не вимагає схем/рисунків у звіті.` : "";

  const structureLock = structureInfo
    ? `СТРУКТУРА РОБОТИ ВИЗНАЧЕНА НА ПОПЕРЕДНЬОМУ КРОЦІ — ВИКОРИСТАЙ ЦІ ЗНАЧЕННЯ ТОЧНО, НЕ ЗМІНЮЙ:
chaptersCount: ${s.chaptersCount ?? 'null'}
subsectionsPerChapter: ${s.subsectionsPerChapter ?? 'null'}
subsectionsPerChapterOverrides: ${s.subsectionsPerChapterOverrides ? JSON.stringify(s.subsectionsPerChapterOverrides) : 'null'}
hasChapterConclusions: ${s.hasChapterConclusions}
chapterTypes: ${JSON.stringify(chTypes)}
totalPages: ${s.totalPages ?? 'null'}
introPages: ${s.introPages ?? 'null'}
conclusionsPages: ${s.conclusionsPages ?? 'null'}

`
    : '';

  return `${structureLock}Уважно прочитай методичку і витягни оформлювальну та вимогову інформацію (форматування, джерела, зміст розділів, титульна сторінка тощо).

Поверни ТІЛЬКИ JSON (без markdown, без коментарів):
{
  "totalPages": ${s.totalPages ?? 30},
  "introPages": ${s.introPages ?? 'null'},
  "conclusionsPages": ${s.conclusionsPages ?? 'null'},
  "chaptersCount": ${s.chaptersCount ?? 2},
  "subsectionsPerChapter": ${s.subsectionsPerChapter ?? 2},
  "hasChapterConclusions": ${s.hasChapterConclusions ?? false},
  "chapterTypes": ${JSON.stringify(chTypes)},
  "exampleTOC": "ВСТУП\\nРОЗДІЛ 1. Назва\\n1.1 Підрозділ\\n1.2 Підрозділ\\nРОЗДІЛ 2. Назва\\n2.1 Підрозділ\\n2.2 Підрозділ\\nВИСНОВКИ\\nСПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ",
  "annotationExample": null,
  "introComponents": null,
  "introStructureHasChapterDetail": false,
  "theoryRequirements": "огляд літератури, теоретичні засади, закінчується висновком про необхідність дослідження",
  "analysisRequirements": "результати власних досліджень, лінгвістичне обґрунтування",
  "chapterConclusionRequirements": "коротка суть результатів, до 1 сторінки",
  "conclusionsRequirements": "пронумерований список конкретних результатів, без загальних формулювань",
  "sourcesMinCount": null,
  "sourcesStyle": "ДСТУ 8302:2015",
  "sourcesOrder": "alphabetical",
  "sourcesGrouping": "спочатку українські, потім англійські/польські/чеські, наприкінці східною мовою",
  "citationStyle": "(Автор, рік) або (Автор, рік, с. 25)",
  "sourcesFormatRules": "Джерела розміщуються в алфавітному порядку за прізвищем автора або назвою документа. Законодавчі та підзаконні акти подаються у хронологічному порядку. Бібліографічний опис складається відповідно до чинних стандартів.",
  "formatting": {
    "font": "Times New Roman",
    "fontSize": 14,
    "lineSpacing": 1.5,
    "margins": {"left": 20, "right": 10, "top": 20, "bottom": 20},
    "indent": 1.25,
    "pageNumbers": "правий верхній кут, арабські цифри",
    "chapterHeading": "великими літерами, по центру, напівжирний, РОЗДІЛ 1 з нового рядка потім назва",
    "subsectionHeading": "малі літери (перша велика), з абзацного відступу, по ширині, після номера крапка напр. 2.3.",
    "tableFormat": "Таблиця 1.2 у правому верхньому куті, назва жирним по центру після номера",
    "tableNumberRight": true,
    "tableTitleBold": true,
    "tableTitleCenter": true,
    "tableHeaderBold": false,
    "figureFormat": "Рис. 1.2 під ілюстрацією, нумерація в межах розділу",
    "noLongDash": true,
    "codeFont": "Courier New",
    "codeFontSize": 10,
    "codeLineSpacing": 1.0
  },
  "requiredSections": ["титульний аркуш", "зміст", "вступ", "основна частина", "висновки", "список використаних джерел"],
  "optionalSections": ["перелік умовних позначень", "анотація іноземною мовою", "додатки"],
  "otherRequirements": "виклад від першої особи множини (ми вважаємо) або безособові конструкції",
  "recommendedSources": "Список рекомендованих джерел з методички: конкретні автори, видання, підручники, журнали. null якщо не вказано",
  "titlePageTemplate": [{"text":"МІНІСТЕРСТВО ОСВІТИ І НАУКИ УКРАЇНИ","align":"center","bold":true,"spaceBefore":0},{"text":"Назва університету","align":"center","bold":true,"spaceBefore":0},{"text":"Кафедра назва","align":"center","bold":false,"spaceBefore":60},{"text":"","align":"center","bold":false,"spaceBefore":0},{"text":"КУРСОВА РОБОТА","align":"center","bold":true,"fontSize":16,"spaceBefore":200},{"text":"на тему:","align":"center","bold":false,"spaceBefore":0},{"text":"[ТЕМА]","align":"center","bold":true,"spaceBefore":0},{"text":"","align":"center","bold":false,"spaceBefore":0},{"text":"Виконав(ла): студент(ка) групи","align":"right","bold":false,"spaceBefore":200},{"text":"Прізвище Ім’я По-батькові","align":"right","bold":false,"spaceBefore":0},{"text":"","align":"center","bold":false,"spaceBefore":0},{"text":"Науковий керівник:","align":"right","bold":false,"spaceBefore":0},{"text":"Посада, ПІБ","align":"right","bold":false,"spaceBefore":0},{"text":"","align":"center","bold":false,"spaceBefore":0},{"text":"Місто – [РІК]","align":"center","bold":false,"spaceBefore":400}],
  "taskSheetTemplate": null,
  "calendarPlanTable": null,
  "requiredTables": null,
  "requiredFormulas": null,
  "requiresEnterpriseProfile": false${practiceFields}
}

Правила:
- totalPages: загальний обсяг роботи в сторінках (число, не рахуючи додатки і список джерел)
- introPages: обсяг вступу в сторінках. Бери число ТІЛЬКИ якщо це точний/рекомендований обсяг (напр. "вступ — 3 сторінки"). Якщо число подане як верхня межа ("не більше N", "до N", "максимум N", "не перевищує N сторінок") — повертай null, а не N
- conclusionsPages: обсяг висновків в сторінках. Те саме правило щодо верхньої межі. null якщо не вказано явно
- chaptersCount, subsectionsPerChapter, hasChapterConclusions, chapterTypes, totalPages, introPages, conclusionsPages: ці поля ВЖЕ ВИЗНАЧЕНІ на попередньому кроці — використай значення з заголовку цього промпту БЕЗ ЗМІН
- introComponents: перевір які з наведених елементів явно згадані у тексті методички у розділі про вступ. Поверни ТІЛЬКИ ті що реально є — у вигляді масиву їх канонічних назв. Якщо елемент не згадано — не включай. Якщо методичка взагалі не описує структуру вступу — поверни null. НЕ копіюй приклад JSON. Список елементів для перевірки (канонічна назва → можливі варіанти у тексті):
  * "актуальність теми" → "актуальність теми", "актуальність проблеми", "актуальність дослідження", "актуальність"
  * "мета дослідження" → "мета дослідження", "мета роботи", "мета курсової"
  * "завдання дослідження" → "завдання дослідження", "завдання роботи", "основні завдання"
  * "об'єкт дослідження" → "об'єкт дослідження", "об'єкт роботи", "об'єкт"
  * "предмет дослідження" → "предмет дослідження", "предмет роботи", "предмет"
  * "методи дослідження" → "методи дослідження", "методи роботи", "методи", "методологія"
  * "практичне значення дослідження" → "практичне значення дослідження", "практичне значення", "практична значущість", "практична цінність", "практичне значення результатів"
  * "наукова новизна" → "наукова новизна", "наукова новизна дослідження", "наукова новизна роботи"
  * "структура роботи" → "структура роботи", "структура дослідження", "структура курсової"
  * "теоретико-методологічна основа" → "теоретична основа", "методологічна основа", "теоретико-методологічна основа", "теоретичні засади"
  * "матеріал дослідження" → "матеріал дослідження", "база дослідження", "емпірична база", "вибірка"
  * "апробація результатів" → "апробація", "апробація результатів", "апробація результатів дослідження"
  * "гіпотеза дослідження" → "гіпотеза", "гіпотеза дослідження", "робоча гіпотеза"
- introStructureHasChapterDetail: подивись САМЕ на речення/абзац "структура роботи" (якщо такий пункт описаний у методичці чи наведений у зразку вступу). true — ЛИШЕ якщо це речення явно вимагає або ілюструє окремий короткий опис ЗМІСТУ КОЖНОГО розділу (наприклад: "у першому розділі розглядається..., у другому розділі проаналізовано..."). false — якщо там лише загальна фраза на кшталт "робота складається зі вступу, N розділів, висновків та списку використаних джерел" без розкриття змісту розділів, АБО якщо пункт "структура роботи" в методичці/зразку взагалі відсутній
- sourcesStyle: "APA", "ДСТУ 8302:2015", "MLA" або інший — точно як у методичці. null якщо стиль явно не вказано (НЕ вигадуй і НЕ припускай)
- sourcesOrder: "alphabetical" або "citation_order"
- sourcesGrouping: якщо є правила групування джерел за мовами — вкажи
- citationStyle: як оформляти посилання в тексті (в дужках, у виносках тощо)
- sourcesFormatRules: якщо в методичці є конкретні вимоги до оформлення/порядку списку джерел (порядок розміщення, особливості для нормативних актів, вимоги до бібліографічного опису тощо) — скопіюй їх точно одним рядком. null якщо таких вимог немає окрім стилю
- recommendedSources: якщо в методичці є список рекомендованої літератури або конкретні автори/видання для використання — перелічи їх одним рядком через крапку з комою. null якщо таких рекомендацій немає
- titlePageTemplate: якщо в методичці є зразок титульної сторінки — відтвори її структуру як масив JSON-об’єктів з полями: "text" (рядок тексту), "align" ("center"|"left"|"right"), "bold" (true/false — визнач за зразком: назви міністерства/університету/тип роботи/назва теми зазвичай жирні), "fontSize" (розмір у pt — вкажи лише якщо рядок явно більший/менший за основний текст 14pt; найчастіше null), "spaceBefore" (відступ перед рядком у twips: 0 для щільних блоків, 200-240 для відступу між блоками, 400-800 для помітного відступу). Уважно подивись, ДЕ САМЕ на сторінці зразка найбільший візуальний проміжок — він не завжди перед "Місто – [РІК]": буває перед блоком "Виконав", буває перед іншим блоком, а буває й кілька приблизно однаково великих проміжків одразу в різних місцях. Постав великий spaceBefore (1200-3200, залежно від того, наскільки він великий відносно решти сторінки) САМЕ ТАМ, де він є у зразку, а не за шаблоном "завжди перед містом-роком". Якщо найбільший проміжок дійсно перед "Місто – [РІК]" — онов туди; якщо перед іншим блоком (чи в кількох місцях) — туди. ВАЖЛИВО: оригінал зразка в методичці вміщується на ОДНІЙ сторінці — не завищуй відступи "про запас", інакше при рендері титулка займе дві сторінки. Порожній рядок між блоками — {"text":"","align":"center","bold":false,"spaceBefore":0}.
- УВАГА при пошуку зразка для titlePageTemplate: НЕ бери титульну/обкладинкову сторінку САМОЇ методички/робочої програми практики (де написано "ЗАТВЕРДЖУЮ" з підписом Голови Вченої ради/ректора, який затверджує програму практики як навчальний документ, або заголовок виду "ОК X.XX ПРОГРАМА ... ПРАКТИКИ", "РОБОЧА ПРОГРАМА", "ГАЛУЗЬ ЗНАНЬ ... СПЕЦІАЛЬНІСТЬ ... КВАЛІФІКАЦІЯ") — це titlepage самого документа-методички, а НЕ шаблон, який студент має заповнити. Шукай саме зразок, призначений для ЗАПОВНЕННЯ СТУДЕНТОМ (є місце для ПІБ здобувача, групи, теми/практики, керівника) — зазвичай він у Додатках з підписом "Зразок оформлення титульного аркуша" або подібним. Якщо такого зразка немає — поверни null, НЕ підставляй замість нього обкладинку методички. Де має бути тема роботи (будь-який плейсхолдер: "(найменування теми)", "(назва теми)", "______" тощо) — ОБОВ’ЯЗКОВО заміни на [ТЕМА]. Де має бути рік — ОБОВ’ЯЗКОВО заміни на [РІК] (НЕ пиши конкретний рік і НЕ розбивай рік на кілька рядків). Рядок "Місто – рік" або "Місто, рік" ЗАВЖДИ має бути ОДНИМ рядком: {"text":"Київ – [РІК]","align":"center","bold":false,"spaceBefore":400}. Вирівнювання визнач за зразком: типово центр, але блоки "Виконав", "Науковий керівник", "Допущено" тощо — right або left залежно від зразка. Якщо зразка немає — поверни null (НЕ вигадуй). КРИТИЧНО ВАЖЛИВО: значення titlePageTemplate у прикладі JSON-схеми вище ("МІНІСТЕРСТВО ОСВІТИ...", "КУРСОВА РОБОТА", "Виконав(ла): студент(ка) групи" тощо) — це лише ілюстрація формату полів, а НЕ типовий результат і не запасний варіант. НІКОЛИ не копіюй цей приклад дослівно чи частково, навіть якщо він виглядає правдоподібно для цього типу роботи. Якщо в самій методичці немає власного зразка титулки — результат ОБОВ'ЯЗКОВО null, без жодного винятку
- КРИТИЧНО ВАЖЛИВО: деякі методички наводять у Додатках НЕ порожній бланк із рисками "___", а вже ЗАПОВНЕНИЙ приклад титулки — з конкретним ПІБ студента, конкретною темою, конкретним факультетом/кафедрою, конкретним керівником, а ЧАСТО Й конкретним освітнім ступенем, спеціальністю та номером групи (реальні на вигляд, але це чужі дані з прикладу, не дані клієнта). У ЖОДНОМУ разі не копіюй ці конкретні значення дослівно — це призведе до того, що в роботі клієнта з'явиться титулка з іменем, ступенем чи спеціальністю зовсім іншої людини (напр. "бакалавр" замість фактичної магістерської роботи клієнта). ОБОВ'ЯЗКОВО заміни на узагальнені токени, так само як тему й рік: ПІБ студента → [ПІБ], назву факультету/інституту → [ФАКУЛЬТЕТ], назву кафедри → [КАФЕДРА], ПІБ і посаду наукового керівника → [КЕРІВНИК], освітній ступінь/ОКР (напр. "на здобуття освітнього ступеня «бакалавр»", "на здобуття ступеня магістра") → [ОКР], спеціальність разом із кодом (напр. "спеціальності 014 «Середня освіта»") → [СПЕЦІАЛЬНІСТЬ], номер академічної групи → [ГРУПА], курс навчання (якщо є) → [КУРС]. Це стосується як порожніх бланків (де й так стоять риски), так і повністю заповнених прикладів (де стоїть конкретне ім'я на кшталт "Іванов І. І.", назва кафедри на кшталт "Кафедра фізики" чи ступінь на кшталт "бакалавр") — в усіх випадках результат має містити токен, а не чиєсь чуже ім'я, ступінь, спеціальність чи номер групи
- taskSheetTemplate: ${practiceMode
    ? `шукай в Додатках методички ЗРАЗОК окремої сторінки "ЗАВДАННЯ на проходження практики" / "ЗАВДАННЯ ТА РЕЗУЛЬТАТИ ПРОХОДЖЕННЯ ПРАКТИКИ" (термін практики, база практики, керівник від підприємства, керівник від університету, зміст завдання, дата видачі, підписи). КРИТИЧНО ВАЖЛИВО — це ІНШИЙ документ, ніж "ЗАВДАННЯ на курсову/кваліфікаційну/дипломну роботу": та сторінка стосується написання самої випускної роботи (консультанти з розділів, наказ університету про затвердження теми) і НЕ підходить для звіту з практики, навіть якщо в методичці вона теж є і згадує ту саму тему — НЕ бери її сюди. Якщо знайшов правильний зразок — відтвори структуру ТОЧНО ЯК titlePageTemplate вище (масив об'єктів "text","align","bold","fontSize","spaceBefore"), із ТИМИ Ж замінами персональних даних зразка на токени: ПІБ студента → [ПІБ], тему → [ТЕМА], факультет/інститут → [ФАКУЛЬТЕТ], кафедру → [КАФЕДРА], ПІБ і посаду керівника → [КЕРІВНИК], рік → [РІК], номер групи → [ГРУПА], курс → [КУРС]; конкретні дати й номери наказів зі зразка — заміни на порожні риски "______". Якщо зразка САМЕ сторінки завдання на практику в методичці немає (навіть якщо є зразок завдання на кваліфікаційну роботу) — поверни null`
    : `шукай в Додатках методички ЗРАЗОК окремої сторінки "ЗАВДАННЯ на курсову роботу" / "ЗАВДАННЯ на кваліфікаційну роботу" / "ЗАВДАННЯ на дипломну роботу" (тема, вихідні дані, зміст розрахунково-пояснювальної записки чи перелік питань що розробити, дата видачі завдання, підписи студента й керівника). Якщо знайшов — відтвори структуру ТОЧНО ЯК titlePageTemplate вище (масив об'єктів "text","align","bold","fontSize","spaceBefore"), із ТИМИ Ж замінами персональних даних зразка на токени: ПІБ студента → [ПІБ], тему → [ТЕМА], факультет/інститут → [ФАКУЛЬТЕТ], кафедру → [КАФЕДРА], ПІБ і посаду керівника → [КЕРІВНИК], рік → [РІК], номер групи → [ГРУПА], курс → [КУРС]; конкретні дати й номери наказів зі зразка — заміни на порожні риски "______". Якщо зразка такої сторінки в методичці немає — поверни null`}
- calendarPlanTable: ${practiceMode
    ? `шукай в Додатках методички ЗРАЗОК таблиці "КАЛЕНДАРНИЙ ПЛАН" виконання САМЕ ПРАКТИКИ (колонки типу "№ з/п", "Етапи проходження практики", "Термін виконання", "Примітка") — НЕ календарний план написання кваліфікаційної/курсової роботи (етапи типу "виконання теоретичної частини", "оформлення пояснювальної записки" — це інший документ, не підходить). Якщо знайшов правильний зразок — відтвори колонки й типові етапи ПРАКТИКИ як markdown-таблицю ОДНИМ рядком з переносами \n (заголовок колонок, розділювач "|---|---|...", рядки етапів); конкретні дати/строки зразка заміни на "______". Якщо зразка САМЕ календарного плану практики немає — поверни null`
    : `шукай в Додатках методички ЗРАЗОК таблиці "КАЛЕНДАРНИЙ ПЛАН" виконання роботи (колонки типу "№ з/п", "Назва етапів курсової/кваліфікаційної роботи", "Строк виконання етапів", "Примітка"). Якщо знайшов — відтвори колонки й типові етапи як markdown-таблицю ОДНИМ рядком з переносами \n (заголовок колонок, розділювач "|---|---|...", рядки етапів); конкретні дати/строки зразка заміни на "______". Якщо зразка такої таблиці немає — поверни null`}
- formatting: всі деталі оформлення — шрифт, розміри, поля, відступи, нумерація.
- formatting.tableNumberRight/tableTitleBold/tableTitleCenter: визнач ЗА ФАКТИЧНИМ ВИГЛЯДОМ ЗРАЗКА ТАБЛИЦІ в методичці (текстовий приклад або зображення сторінки з заголовком виду «Таблиця Х.Х ...»), А НЕ за загальним текстовим описом вимог. Дивись, як насправді оформлено заголовок у цьому зразку: жирний текст → tableTitleBold true, звичайне накреслення → false; заголовок по центру → tableTitleCenter true, звичайний абзац (навіть з відступом першого рядка, як у більшості методичок) → false; номер таблиці окремим рядком у правому верхньому куті → tableNumberRight true, номер і назва в одному рядку зліва → false. Якщо зразка таблиці в методичці немає і текст ніде явно не описує ці вимоги — усі три поля false. НЕ бери значення з прикладу JSON-схеми нижче за замовчуванням — він лише ілюструє формат полів, а не типовий результат
- formatting.tableHeaderBold: чи є ШАПКА (перший рядок з назвами колонок) таблиці жирною — визнач ЛИШЕ за фактичним виглядом зразка таблиці в методичці (текст або зображення сторінки з реальною таблицею, не приклад JSON-схеми). Якщо в зразку текст у клітинках першого рядка таблиці виділено жирним — true; якщо звичайне накреслення, або зразка таблиці немає взагалі — false. Це ОКРЕМА ознака від tableTitleBold (який стосується підпису "Таблиця Х.Х ..." над таблицею, а не самої шапки всередині таблиці)
- formatting.codeFont/codeFontSize/codeLineSpacing: вимоги до оформлення лістингів програмного коду (шрифт, розмір, інтервал). Якщо методичка явно вказує інші значення — використай їх; якщо не вказано — залиш дефолт "Courier New" / 10 / 1.0
- exampleTOC: ДРУГОРЯДНЕ поле. Шукай ТІЛЬКИ в Додатках розділ зі словами "зразок змісту", "зразок оформлення змісту", "приклад змісту" — це лише приклад оформлення. КАТЕГОРИЧНО ІГНОРУЙ: (1) "ЗМІСТ" на початку методички; (2) пункти виду "1. Загальні вимоги...", "2. Оформлення..." — це розділи методички. Якщо знайшов справжній зразок (містить ВСТУП, РОЗДІЛ 1, 1.1, ВИСНОВКИ) — скопіюй рядки. Якщо не знайшов — поверни null
- annotationExample: шукай в методичці (в т.ч. в Додатках) зразок або вимоги до розділу-анотації — В ДЕЯКИХ МЕТОДИЧКАХ ЦЕЙ РОЗДІЛ НАЗИВАЄТЬСЯ "РЕФЕРАТ" замість "АНОТАЦІЯ" (це та сама сторінка перед змістом з коротким викладом суті роботи, обсягом, ключовими словами — НЕ окремий вид роботи). Шукай ОБИДВА варіанти: слова "зразок анотації"/"зразок реферату", "приклад анотації"/"приклад реферату", "анотація повинна містити"/"реферат повинен містити", "структура анотації"/"структура реферату", а також будь-який розділ методички що починається зі слова "РЕФЕРАТ" і описує/ілюструє обсяг роботи, кількість джерел/додатків, ключові слова. Якщо знайшов — скопіюй текст зразка або опис вимог до його структури одним блоком, ОБОВ'ЯЗКОВО зберігаючи оригінальний заголовок розділу як він є в методичці ("АНОТАЦІЯ" або "РЕФЕРАТ") та переноси рядків через \\n. Якщо методичка взагалі не згадує ні анотацію, ні реферат у цьому значенні — поверни null
- requiredTables: шукай таблиці які СТУДЕНТ МАЄ ЗАПОВНИТИ у своїй роботі (не таблиці всередині самої методички з критеріями/шкалами). Якщо знайшов — поверни масив об’єктів: [{"name":"назва таблиці","structure":"markdown рядок заголовків таблиці з плейсхолдерами наприклад |Показник|Рік 1|Рік 2|","section":"analysis або recommendations — в якому типі розділу має з’явитись","instructions":"що саме заповнювати в цю таблицю"}]. null якщо таких таблиць немає.
- requiredFormulas: шукай формули/розрахунки які студент має виконати у роботі. Поверни масив: [{"name":"назва показника","formula":"формула у вигляді plain text, наприклад β = Σ(kij × pi) / (m × n)","variables":"опис кожної змінної через крапку з комою","interpretation":"шкала інтерпретації результату якщо є в методичці","section":"analysis або recommendations"}]. null якщо формул немає.
- requiresEnterpriseProfile: true ТІЛЬКИ якщо методичка ЯВНО вимагає, щоб практична/аналітична частина роботи спиралась на КОНКРЕТНЕ досліджуване підприємство/організацію/установу (а не абстрактну теорію) — незалежно від того, як сформульована тема. Ознаки (будь-якої однієї достатньо): (1) шаблон титульної сторінки чи бланка завдання містить поле на кшталт "(на матеріалах ______)", "(назва підприємства)", "база дослідження ____"; (2) текст методички прямо описує, що один із розділів/підрозділів має містити загальну характеристику досліджуваного підприємства (назва, форма власності, історія створення, статутний фонд, організаційна структура тощо) — особливо якщо сказано, що це стосується "незалежно від теми дослідження"; (3) приклад структуризації курсової/дипломної роботи в додатках методички має назву на кшталт "... на прикладі ПАТ/ТОВ «Назва»" або підрозділ "Загальна характеристика [підприємства/організації]". false якщо методичка описує суто теоретичне дослідження без практичної частини на базі конкретного об'єкта, або згадує підприємство лише як приклад для ілюстрації, а не як обов'язкову базу дослідження.${practiceRules}`;
}

// Слова-маркери прикладу-заглушки titlePageTemplate зі схеми вище (рядок з "titlePageTemplate":
// у buildMethodologyReadingPrompt). Словесна заборона копіювати цей приклад у самому промпті не
// стовідсоткова — модель іноді все одно повертає його дослівно замість null, коли в методичці
// немає власної титулки. Це кодова, детермінована страховка: якщо в результаті трапляються
// хоча б 2 з цих фраз, це напевно скопійований приклад, а не реальний зразок з методички, і
// поле треба обнулити, щоб спрацював резервний варіант (зразок структури / дефолтна титулка).
const SCHEMA_PLACEHOLDER_TITLEPAGE_MARKERS = ["Кафедра назва", "Прізвище Ім’я По-батькові", "Посада, ПІБ", "студент(ка) групи"];
export function isSchemaPlaceholderTitlePage(titlePageTemplate) {
  if (!Array.isArray(titlePageTemplate) || !titlePageTemplate.length) return false;
  const joined = titlePageTemplate.map(l => l?.text || "").join(" | ");
  return SCHEMA_PLACEHOLDER_TITLEPAGE_MARKERS.filter(m => joined.includes(m)).length >= 2;
}

// ── Промпт: читання ГОТОВОЇ ЧУЖОЇ РОБОТИ як зразка структури й оформлення ──
// На відміну від buildMethodologyReadingPrompt це не документ з ОПИСОВИМИ вимогами
// ("вступ повинен містити..."), а вже завершена студентська робота: структуру й
// оформлення треба зчитувати з фактичного вигляду документа (реальний зміст,
// реальна титулка, реальні таблиці й список джерел), а не з тексту-вимог.
// Кількість розділів/підрозділів з exampleTOC рахується потім кодом
// (deriveStructureFromExampleTOC у planUtils.js), а не окремим AI-викликом.
export function buildExampleWorkReadingPrompt() {
  return `Це ГОТОВА ЗАВЕРШЕНА студентська робота (курсова/дипломна тощо), а НЕ методичка з вимогами. У ній немає речень на кшталт "вступ повинен містити..." — натомість є реальний зміст, реальна титулка, реальні таблиці й реальний список джерел.

ТВОЄ ЗАВДАННЯ: скопіювати ЛИШЕ структуру й оформлення цієї роботи (кількість розділів і підрозділів, вигляд титулки, форматування тексту/таблиць/рисунків, стиль оформлення джерел). КАТЕГОРИЧНО ЗАБОРОНЕНО переносити тему, факти, речення, дані, назви розділів чи будь-який змістовний текст цієї роботи в результат — вона буде використана для ІНШОЇ теми, і будь-який скопійований контент і зміст стане плагіатом і помилкою.

Поверни ТІЛЬКИ JSON (без markdown, без коментарів):
{
  "exampleTOC": "ВСТУП\\nРОЗДІЛ 1. Назва як у роботі\\n1.1 Підрозділ\\n1.2 Підрозділ\\nВИСНОВКИ ДО РОЗДІЛУ 1\\nРОЗДІЛ 2. Назва як у роботі\\n2.1 Підрозділ\\n2.2 Підрозділ\\nВИСНОВКИ\\nСПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ",
  "introComponents": null,
  "introStructureHasChapterDetail": false,
  "titlePageTemplate": null,
  "taskSheetTemplate": null,
  "calendarPlanTable": null,
  "hasFigures": false,
  "formatting": {
    "font": "Times New Roman",
    "fontSize": 14,
    "lineSpacing": 1.5,
    "margins": {"left": 20, "right": 10, "top": 20, "bottom": 20},
    "indent": 1.25,
    "pageNumbers": "правий верхній кут, арабські цифри",
    "chapterHeading": "великими літерами, по центру, напівжирний",
    "subsectionHeading": "малі літери (перша велика), з абзацного відступу, по ширині",
    "tableFormat": "Таблиця 1.2 у правому верхньому куті, назва жирним по центру після номера",
    "tableNumberRight": true,
    "tableTitleBold": true,
    "tableTitleCenter": true,
    "tableHeaderBold": false,
    "figureFormat": "Рис. 1.2 під ілюстрацією, нумерація в межах розділу",
    "noLongDash": true,
    "codeFont": "Courier New",
    "codeFontSize": 10,
    "codeLineSpacing": 1.0
  },
  "sourcesStyle": null,
  "sourcesOrder": "alphabetical",
  "sourcesGrouping": null,
  "citationStyle": null,
  "sourcesFormatRules": null
}

Правила:
- exampleTOC: знайди сторінку "ЗМІСТ" на початку роботи (тут, на відміну від методички, її НЕ можна ігнорувати — це і є потрібний зразок) і скопіюй її дослівно рядок за рядком: ВСТУП, кожен "РОЗДІЛ N. Назва", кожен підрозділ "N.M Назва", "ВИСНОВКИ ДО РОЗДІЛУ N" (якщо є в змісті — окремим рядком), ВИСНОВКИ, СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ. Якщо сторінки "Зміст" немає — відтвори ту саму структуру за фактичними заголовками розділів/підрозділів у тілі роботи. Якщо структуру взагалі неможливо визначити — поверни null
- introComponents: перевір, які підзаголовки реально є всередині Вступу цієї роботи (актуальність теми, мета дослідження, завдання дослідження, об'єкт дослідження, предмет дослідження, методи дослідження, структура роботи, наукова новизна, практичне значення, гіпотеза тощо — канонічні назви ті самі, що для методички). Поверни масив канонічних назв тих, що реально присутні як підзаголовки. null якщо Вступ не структурований підзаголовками
- introStructureHasChapterDetail: подивись САМЕ на речення/абзац "структура роботи" всередині Вступу цього зразка (якщо такий пункт там є). true — ЛИШЕ якщо це речення реально розкриває зміст КОЖНОГО розділу окремо (наприклад: "у першому розділі розглядається..., у другому розділі проаналізовано..."). false — якщо це лише загальна фраза на кшталт "робота складається зі вступу, N розділів, висновків та списку використаних джерел" без розкриття змісту розділів, АБО якщо пункту "структура роботи" у Вступі зразка взагалі немає
- titlePageTemplate: відтвори титульну сторінку РЕАЛЬНОГО зразка як масив JSON-об'єктів з полями "text","align"("center"|"left"|"right"),"bold","fontSize"(лише якщо явно більший/менший за 14pt, інакше null),"spaceBefore"(twips: 0 для щільних блоків, 200-240 між блоками, 400-800 для помітного відступу, і ВИНЯТКОВО 2400-3200 лише для ОДНОГО найбільшого відступу перед рядком "Місто – рік", щоб цей рядок був прибитий до низу сторінки). КРИТИЧНО ВАЖЛИВО: це РЕАЛЬНА заповнена титулка з конкретним ПІБ студента, конкретною темою, конкретним факультетом/кафедрою, конкретним керівником — це чужі дані, їх НІКОЛИ не можна копіювати дослівно. Обов'язково заміни: ПІБ студента → [ПІБ], тему роботи → [ТЕМА], рік → [РІК] (одним рядком, не розбивай), назву факультету/інституту → [ФАКУЛЬТЕТ], назву кафедри → [КАФЕДРА], ПІБ і посаду наукового керівника → [КЕРІВНИК]. Назву міністерства й університету НЕ чіпай (вони спільні, не персональні дані). Якщо на титулці немає реальних персональних даних (порожній бланк із рисками) — просто постав ті самі токени на місце рисок. Якщо титульної сторінки в документі немає — поверни null
- taskSheetTemplate: шукай одразу ПІСЛЯ титульної сторінки окрему сторінку "ЗАВДАННЯ на курсову роботу" / "ЗАВДАННЯ на кваліфікаційну роботу" / "ЗАВДАННЯ на дипломну роботу" тощо (типово містить: тему, вихідні дані, зміст розрахунково-пояснювальної записки чи перелік питань що розробити, дату видачі завдання, підписи студента й керівника). Якщо знайшов — відтвори ЇЇ структуру ТОЧНО ЯК titlePageTemplate вище: масив JSON-об'єктів з тими самими полями "text","align","bold","fontSize","spaceBefore". Це теж РЕАЛЬНА сторінка чужої роботи — застосуй ТІ Ж заміни персональних даних, що й для titlePageTemplate: ПІБ студента → [ПІБ], тему → [ТЕМА], факультет/інститут → [ФАКУЛЬТЕТ], кафедру → [КАФЕДРА], ПІБ і посаду керівника → [КЕРІВНИК], рік → [РІК], номер групи → [ГРУПА], курс → [КУРС]. Конкретні дати (видачі завдання, подання роботи) і номери наказів чужої роботи — заміни на порожні риски "______", НЕ копіюй їх. Якщо на цій сторінці є перелік конкретних пунктів плану/розділів чужої роботи (напр. "зміст розрахунково-пояснювальної записки") — заміни цей перелік на узагальнений рядок "[ЗМІСТ РОБОТИ]" замість дослівного копіювання чужих формулювань. Якщо такої сторінки в роботі немає — поверни null
- calendarPlanTable: шукай сторінку/таблицю "КАЛЕНДАРНИЙ ПЛАН" виконання роботи (зазвичай колонки на кшталт "№ з/п", "Назва етапів курсової/кваліфікаційної роботи", "Строк виконання етапів", "Примітка"). Якщо знайшов — відтвори колонки й типові ЗАГАЛЬНОАКАДЕМІЧНІ етапи виконання роботи (вибір і затвердження теми, складання плану, опрацювання літературних джерел, написання розділів, оформлення роботи, захист тощо — це загальний процес виконання, а не зміст чужого дослідження, тому відтворювати можна) як markdown-таблицю ОДНИМ рядком з переносами \n: заголовок колонок, розділювач "|---|---|...", далі рядки етапів. Конкретні дати чи строки чужої роботи в колонці строків заміни на "______". Якщо такої таблиці немає — поверни null
- hasFigures: true ЯКЩО в роботі реально присутні змістовні ілюстрації — блок-схеми, діаграми, графіки з даними, скріншоти інтерфейсу, креслення тощо (підписані "Рис. N" або аналогічно). false якщо рисунків у роботі немає взагалі, або є лише декоративні елементи без стосунку до змісту (логотип, орнамент на титулці тощо)
- formatting: визнач ЗА ФАКТИЧНИМ ВИГЛЯДОМ сторінок роботи — шрифт, розмір, поля, міжрядковий інтервал, відступ абзацу, як оформлені заголовки розділів/підрозділів. tableNumberRight/tableTitleBold/tableTitleCenter/tableHeaderBold — визнач за фактичним виглядом РЕАЛЬНИХ таблиць у роботі (є вони чи ні, як оформлений підпис і шапка). Якщо в роботі взагалі немає таблиць — постав всі чотири false. figureFormat — за фактичним виглядом підписів під реальними рисунками, якщо вони є
- sourcesStyle: визнач за фактичним оформленням записів у "СПИСКУ ВИКОРИСТАНИХ ДЖЕРЕЛ" — "ДСТУ 8302:2015", "APA", "MLA" або інший, наскільки можна визначити з вигляду записів. null якщо список джерел відсутній або стиль визначити неможливо
- sourcesOrder: "alphabetical" якщо джерела йдуть за алфавітом прізвищ, "citation_order" якщо в порядку появи посилань у тексті (нумерація [1],[2]...)
- sourcesGrouping: якщо джерела явно згруповані блоками за мовою (спочатку кириличні, потім латиницею тощо) — опиши це одним рядком. null якщо групування немає
- citationStyle: як оформлені посилання в тексті цієї роботи — наприклад "(Автор, рік)" або "[1]" з підписами внизу/списком в кінці. null якщо визначити неможливо
- sourcesFormatRules: null (не додумуй — це поле для явних текстових вимог, яких у готовій роботі немає)
- КАТЕГОРИЧНО НЕ повертай (і не вигадуй) totalPages, introPages, conclusionsPages, sourcesMinCount, theoryRequirements, analysisRequirements, conclusionsRequirements, chapterConclusionRequirements, otherRequirements, recommendedSources, requiredTables, requiredFormulas, annotationExample — цих полів немає в результаті взагалі, не додавай їх у JSON`;
}

// ── Промпт: оформлення й джерела з методички для малих робіт (тези/стаття/есе/реферат) ──
// Спрощена версія buildMethodologyReadingPrompt — без розділів/титулки/додатків,
// яких у малих роботах немає; той самий формат formatting.*, щоб рендер докс
// (exportSimpleDocx) міг використати ту саму логіку, що й великі роботи.
export function buildSmallWorkFormattingPrompt() {
  return `Уважно прочитай методичку/вимоги. Витягни ЛИШЕ інформацію про оформлення та джерела — структуру розділів НЕ шукай, її тут немає.

Поверни ТІЛЬКИ JSON (без markdown):
{
  "sourcesStyle": null,
  "sourcesOrder": "alphabetical",
  "sourcesGrouping": null,
  "citationStyle": null,
  "sourcesFormatRules": null,
  "recommendedSources": null,
  "annotationExample": null,
  "needsAnnotation": false,
  "formatting": {
    "font": null,
    "fontSize": null,
    "lineSpacing": null,
    "margins": {"left": null, "right": null, "top": null, "bottom": null},
    "indent": null,
    "tableFormat": null,
    "tableNumberRight": false,
    "tableTitleBold": false,
    "tableTitleCenter": false,
    "tableHeaderBold": false,
    "figureFormat": null,
    "noLongDash": false
  }
}

Правила:
- sourcesStyle: "APA", "ДСТУ 8302:2015", "MLA" або інший — точно як у методичці. null якщо стиль явно не вказано
- sourcesOrder: "alphabetical" або "citation_order". Якщо не вказано явно — "alphabetical"
- sourcesGrouping: якщо є правила групування джерел за мовами (спочатку українські, потім іноземні тощо) — вкажи одним рядком. null якщо немає
- citationStyle: як оформляти посилання в тексті (напр. "[N]", "[N, с. 25]", "(Автор, рік)", виноски). null якщо не вказано явно
- sourcesFormatRules: конкретні вимоги до оформлення/порядку списку джерел (нормативні акти окремо, порядок розміщення тощо), одним рядком. null якщо таких вимог немає окрім стилю
- recommendedSources: список рекомендованої літератури або конкретних авторів/видань з методички, одним рядком через крапку з комою. null якщо таких рекомендацій немає
- annotationExample: якщо в методичці є зразок або явні вимоги до анотації (обсяг, мови, структура блоків) — скопіюй текст зразка/опис одним блоком. null якщо анотація не згадується
- needsAnnotation: true, якщо методичка згадує анотацію та/або ключові слова як обов'язковий структурний елемент роботи — навіть просто пунктом переліку структури без окремого зразка тексту (напр. "✓ Анотація та ключові слова" у списку структури). false, якщо анотація ніде не згадується
- formatting.font/fontSize/lineSpacing/indent: базові параметри оформлення тексту, ТІЛЬКИ якщо вказані явно в методичці. null якщо не вказано (НЕ підставляй дефолти "про всяк випадок")
- formatting.margins: поля сторінки в мм, ТІЛЬКИ якщо вказані явно. null для кожного поля, якщо не вказано
- formatting.tableNumberRight/tableTitleBold/tableTitleCenter: визнач ЗА ФАКТИЧНИМ ВИГЛЯДОМ ЗРАЗКА ТАБЛИЦІ в методичці (текстовий приклад чи зображення сторінки із заголовком виду «Таблиця Х»), А НЕ за загальним текстовим описом вимог. Жирний текст назви таблиці → tableTitleBold true, звичайне накреслення → false. Назва по центру окремим рядком → tableTitleCenter true, звичайний абзац з відступом → false. Номер таблиці окремим рядком у правому куті → tableNumberRight true, номер і назва в одному рядку зліва → false. Якщо зразка таблиці в методичці немає — усі три false
- formatting.tableHeaderBold: чи є ШАПКА (перший рядок з назвами колонок) таблиці жирною — визнач ЛИШЕ за фактичним виглядом зразка таблиці в методичці. Жирний текст у клітинках першого рядка → true; звичайне накреслення або відсутність зразка → false. Окрема ознака від tableTitleBold (той стосується підпису "Таблиця Х" над таблицею, а не шапки всередині неї)
- formatting.tableFormat: короткий опис оформлення таблиці одним реченням, лише якщо є зразок. null якщо немає
- formatting.figureFormat: короткий опис оформлення підпису рисунка (жирний/курсив/звичайний шрифт, де саме номер) одним реченням за зразком. null якщо немає
- formatting.noLongDash: true ТІЛЬКИ якщо методичка явно забороняє тире "—"/"–" в тексті роботи. Інакше false`;
}

// ── Промпт для генерації анотації (укр + англ) для магістерських/бакалаврських робіт ──
export function buildAnnotationPrompt(info, methodInfo, statsText, introText, conclusionsText) {
  const exampleBlock = methodInfo?.annotationExample
    ? `ЗРАЗОК/ВИМОГИ ДО АНОТАЦІЇ З МЕТОДИЧКИ (відтвори структуру, порядок блоків і стиль формулювань зразка, але з власним змістом цієї роботи; якщо зразок називає цей розділ "РЕФЕРАТ" — використай саме цей заголовок українською, а не "АНОТАЦІЯ"):\n${methodInfo.annotationExample}\n\n`
    : `СТАНДАРТНА СТРУКТУРА (методичка не містить зразка анотації — використай цей формат):
АНОТАЦІЯ

Тема роботи: «[тема]»

Кваліфікаційна робота на здобуття освітнього ступеня [магістра/бакалавра] за спеціальністю «[спеціальність]».

[Робота складається зі вступу, N розділів, висновків, списку використаних джерел (M найменувань)[, K додатків]. Загальний обсяг роботи – P сторінок.] — встав ці факти без змін

[Короткий виклад суті роботи: актуальність теми, мета й завдання дослідження, використані методи, основні результати — 100-150 слів]

Ключові слова: [5-8 термінів через кому].

`;

  return `Напиши анотацію до кваліфікаційної роботи на тему «${info?.topic || ""}» (${info?.type || "кваліфікаційна робота"}) — ДВОМА МОВАМИ: українською та англійською.

${exampleBlock}ФАКТИ ДЛЯ ВСТАВКИ (цифри й факти бери ТІЛЬКИ звідси, нічого не вигадуй і не змінюй):
${statsText}

ВСТУП РОБОТИ (для розуміння суті дослідження):
${(introText || "").slice(0, 3000)}

ВИСНОВКИ РОБОТИ (для розуміння результатів):
${(conclusionsText || "").slice(0, 3000)}

Поверни ТІЛЬКИ JSON (без markdown):
{"uk": "повний текст анотації українською, включно з заголовком (АНОТАЦІЯ або РЕФЕРАТ — залежно від зразка методички), фактами і ключовими словами, як суцільний текст з переносами рядків через \\n", "en": "full English ABSTRACT text (heading ABSTRACT — завжди ABSTRACT, незалежно від того чи укр. заголовок АНОТАЦІЯ чи РЕФЕРАТ), mirroring the same structure, facts translated, English keywords, as plain text with \\n line breaks"}

Правила:
- Текст анотації — суцільний, без markdown-розмітки (без **, без #, без списків).
- Виклад суті роботи: 100-150 слів, по суті, без води і загальних фраз.
- Ключові слова: 5-8 термінів з теми роботи.
- Англійська версія — природна академічна англійська, не дослівний переклад українського тексту. Заголовок англійської версії — завжди "ABSTRACT".
- НЕ вигадуй назву закладу освіти, ПІБ студента чи керівника — їх в анотації не вказуй.
- Тире (будь-які: коротке, довге, "—") — СУВОРО ЗАБОРОНЕНІ. Замінюй комою або перебудовуй речення.
- Кома: максимум 1 на речення. Крапка з комою — заборонена.`;
}

// ── Промпт для генерації анотації (укр) для реферату — простіша структура, без
// рамки "кваліфікаційна робота на здобуття ступеня", без вимоги другої мови ──
export function buildReferatAnnotationPrompt(info, methodInfo, statsText, introText) {
  const exampleBlock = methodInfo?.annotationExample
    ? `ЗРАЗОК/ВИМОГИ ДО АНОТАЦІЇ З МЕТОДИЧКИ (відтвори структуру, порядок блоків і стиль формулювань зразка, але з власним змістом цієї роботи):\n${methodInfo.annotationExample}\n\n`
    : `СТАНДАРТНА СТРУКТУРА (методичка не містить зразка анотації — використай цей формат):
АНОТАЦІЯ

[Короткий виклад суті реферату: тема, мета, основні розглянуті питання — 100-150 слів]

Ключові слова: [5-8 термінів через кому].

`;

  return `Напиши анотацію та ключові слова до реферату на тему «${info?.topic || ""}» з дисципліни «${info?.subject || ""}».

${exampleBlock}ФАКТИ ДЛЯ ВСТАВКИ (цифри й факти бери ТІЛЬКИ звідси, нічого не вигадуй і не змінюй):
${statsText}

ВСТУП РЕФЕРАТУ (для розуміння суті роботи):
${(introText || "").slice(0, 3000)}

Поверни ТІЛЬКИ JSON (без markdown):
{"uk": "повний текст анотації, включно з заголовком АНОТАЦІЯ, викладом суті і ключовими словами, як суцільний текст з переносами рядків через \\n"}

Правила:
- Текст анотації — суцільний, без markdown-розмітки (без **, без #, без списків).
- Виклад суті: 100-150 слів, по суті, без води і загальних фраз.
- Ключові слова: 5-8 термінів з теми реферату.
- НЕ вигадуй назву закладу освіти, ПІБ студента чи керівника — їх в анотації не вказуй.
- Тире (будь-які: коротке, довге, "—") — СУВОРО ЗАБОРОНЕНІ. Замінюй комою або перебудовуй речення.
- Кома: максимум 1 на речення. Крапка з комою — заборонена.`;
}

// ── Точкове редагування вже згенерованої анотації за коментарем користувача ──
export function buildAnnotationRegenPrompt(currentUk, currentEn, comment) {
  return `Ось поточний варіант анотації до кваліфікаційної роботи (двома мовами).

АНОТАЦІЯ (УКР):
${currentUk}

ABSTRACT (ENG):
${currentEn}

КОМЕНТАР/ВИМОГИ ДО ПРАВОК: ${comment}

Перепиши анотацію відповідно до коментаря, зберігаючи структуру (заголовок, факти про роботу, виклад суті, ключові слова) і узгодженість між мовами. Те, чого коментар не стосується, залиш по суті без змін.

Тире (будь-які: коротке, довге, "—") — СУВОРО ЗАБОРОНЕНІ, замінюй комою або перебудовуй речення. Кома: максимум 1 на речення. Крапка з комою — заборонена.

Поверни ТІЛЬКИ JSON (без markdown):
{"uk": "повний оновлений текст анотації українською з переносами рядків через \\n", "en": "full updated English ABSTRACT text with \\n line breaks"}`;
}

// ── Промпт для аналізу шаблону замовлення ──
export function buildTemplateAnalysisPrompt(tplText, comment) {
  return `Проаналізуй шаблон замовлення.\n\nШАБЛОН:\n${tplText}\n${comment ? "\nКОМЕНТАР: " + comment : ""}\n\nПоверни ТІЛЬКИ JSON (без markdown):\n{"type":"","pages":"","topic":"","subject":"","direction":"","uniqueness":"","language":"Українська","deadline":"","orderNumber":"","extras":"","methodNotes":"","sourceCount":"30-40","course":null,"practiceType":null,"university":"","faculty":"","department":"","studentName":"","studentGroup":"","supervisorUniversity":"","city":""}\n\nПравила:\n- course: номер курсу (1, 2, 3, 4) якщо вказано в шаблоні (поле "курс"). null якщо не вказано або тип роботи не курсова.\n- practiceType: якщо це замовлення на практику — вид практики, ОДНЕ з: "navchalna" (навчальна/ознайомча), "vyrobnycha" (виробнича), "perededyplomna" (переддипломна/передипломна), "naukovo_doslidna" (науково-дослідна). Визначай з будь-якого явного згадування в шаблоні — не лише в полі "Тип", а й у темі, тематиці/предметі чи коментарі (напр. тема "Проходження виробничої практики..." → "vyrobnycha"; "науково-дослідна практика" → "naukovo_doslidna", навіть якщо поруч згадана "переддипломна" як етап навчання — вид практики тут "naukovo_doslidna"). null якщо це не практика або вид ніде явно не вказаний — НЕ вгадуй за курсом.\n- university: повна назва закладу вищої освіти клієнта (напр. "Національний університет ...", "КНУ ім. Т. Шевченка"). "" якщо в шаблоні чи коментарі не вказано явно — НЕ вигадуй і не бери з методички.\n- faculty: назва факультету/інституту клієнта. "" якщо не вказано явно в шаблоні чи коментарі.\n- department: назва кафедри клієнта. "" якщо не вказано явно.\n- studentName: ПІБ студента-клієнта (не виконавця). "" якщо не вказано явно.\n- studentGroup: ТІЛЬКИ номер/шифр академічної групи клієнта, БЕЗ курсу (напр. "ФБС-31" або "1") — курс іде окремим полем "course", не дублюй його тут. "" якщо не вказано явно.\n- supervisorUniversity: ПІБ і посада/науковий ступінь наукового керівника клієнта (напр. "доц. Іваненко І.І." або "к.пед.н., доцент Петренко П.П."). "" якщо не вказано явно.\n- city: місто закладу освіти клієнта (для рядка "Місто – Рік" на титулці). "" якщо не вказано явно.\n- direction: галузь/напрям підготовки або спеціальність, ЯК У ТЕКСТІ, повним словосполученням (напр. "051 Економіка підприємства", "Психологія"), а не обірваним словом. "" якщо не вказано явно.\n- language: мова, якою МАЄ БУТИ НАПИСАНА робота. Якщо в шаблоні чи коментарі явно вказано мову роботи (напр. "мова: англійська") — бери саме це значення. Якщо явної вказівки немає — визнач мову за фактичною мовою, якою написана ТЕМА роботи (напр. тема польською → "Польська", тема англійською → "Англійська", тема українською → "Українська"). Значення "Українська" за замовчуванням використовуй ТІЛЬКИ якщо ні явної вказівки, ні мову теми визначити не вдалося.\n- Для всіх полів вище: бери значення ТІЛЬКИ якщо воно явно присутнє в тексті шаблону або коментарі клієнта. Якщо не вказано — порожній рядок "" (для practiceType/course — null), а не здогадка чи значення з методички.`;
}

// ── Промпт для аналізу коментаря клієнта ──
export function buildCommentAnalysisPrompt({ topic, comment, photoCount }) {
  const hasPhotos = photoCount > 0;
  return `Проаналізуй${hasPhotos ? " фото та" : ""} коментар клієнта до академічної роботи на тему "${topic || ""}". Витягни конкретні підказки для виконавця.${comment?.trim() ? `\nКОМЕНТАР КЛІЄНТА:\n${comment}` : ""}${hasPhotos ? `\n\nФОТО: ${photoCount} зображень.` : ""}

Поверни ТІЛЬКИ JSON (без markdown):
{"planHints":"підказки для СТРУКТУРИ ПЛАНУ: к-сть розділів, назви розділів, висновки до розділів тощо. null якщо немає","textStructureHints":"підказки для СТРУКТУРИ ТЕКСТУ: що має бути у вступі чи висновках, вимоги до обсягів розділів у сторінках, особливі акценти. null якщо немає","writingHints":"підказки для СТИЛЮ ТА ЗМІСТУ написання: термінологія, підходи, що підкреслити, на що звернути увагу. null якщо немає","sourcesHints":"підказки для ДЖЕРЕЛ ТА ОФОРМЛЕННЯ: к-сть джерел, мова джерел, стиль цитування, конкретні автори або видання. null якщо немає","researchDesign":"ВАЖЛИВО: якщо в коментарі є будь-які ознаки емпіричного дослідження (анкетування, опитування, тестування, методика, вибірка, групи учасників, порівняння груп) — ОБОВ’ЯЗКОВО заміни цей рядок на JSON-обʼєкт (не рядок): {\"instrumentType\":\"questionnaire або psycho_scale або fitness_test або pedagogical_experiment або mixed\",\"groups\":[{\"name\":\"назва групи\",\"minN\":30,\"criteria\":\"критерії або null\"}],\"biographicalFields\":[\"ПІБ\",\"вік\",\"стаж\"],\"comparisonRequired\":true,\"statisticalMinN\":30}. instrumentType: questionnaire — анкета/опитування, psycho_scale — психологічна методика/шкала, fitness_test — фізичні тести/нормативи, pedagogical_experiment — педагогічний експеримент, mixed — кілька методів. groups — масив груп з кількістю та критеріями. biographicalFields — поля біографічного блоку якщо згадані. Якщо ознак дослідження немає — null","practicalApproach":"визнач тип практичної частини для педагогічних та гуманітарних робіт ТІЛЬКИ з теми роботи: questionnaire (тема вказує на анкетування, опитування, ставлення або мотивацію учасників), textbook_analysis (тема вказує на аналіз підручників або навчальних посібників), lesson_observation (тема вказує на аналіз або спостереження уроків, методику проведення уроків), materials_development (тема вказує на розробку вправ, план-конспект, дидактичні матеріали або систему завдань). null якщо тип не визначається або якщо тема не педагогічна","practicalApproachDetails":"якщо визначено practicalApproach: для textbook_analysis — які підручники і за якими критеріями якщо зазначено; для lesson_observation — скільки уроків і який клас якщо зазначено; для materials_development — що саме розробляється і для якого класу якщо зазначено. null якщо немає деталей або practicalApproach є questionnaire або null","photoTOC":"якщо на фото є готовий план/зміст роботи (рядки виду Chapter 1 / Розділ 1, 1.1, 1.2, Introduction тощо) — скопіюй його текст дослівно. Якщо плану на фото немає — null","formattingHints":{"margins":{"left":"ліве поле мм або null","right":"праве поле мм або null","top":"верхнє поле мм або null","bottom":"нижнє поле мм або null"}}}`;
}

// ── Промпт для опису ілюстрацій клієнта ──
export function buildIllustrationsPrompt({ topic, illustrations, planSections = [], lang = "Українська" }) {
  const captionLines = illustrations.map((ill, i) =>
    `Рис. ${i + 1}: ${ill.caption?.trim() || "(без підпису)"}`
  ).join("\n");
  const sectionsBlock = planSections.length
    ? `\nПЛАН РОБОТИ (підрозділи):\n${planSections.map(s => `${s.id}: ${s.label}`).join("\n")}\n`
    : "";
  return `Ти аналізуєш ілюстрації для академічної роботи на тему "${topic || ""}".

ІЛЮСТРАЦІЇ (${illustrations.length} шт.):
${captionLines}
${sectionsBlock}
ЗАВДАННЯ: для кожної ілюстрації:
1. Напиши академічний опис (2-3 речення, мова: ${lang}) — що зображено, яка наукова цінність для роботи
2. Визнач id підрозділу плану куди найбільше підходить (напр. "1.2" або "2.3"). Якщо плану немає — вкажи номер глави (напр. "2")

Поверни ТІЛЬКИ JSON масив (без markdown):
[{"figureNum":1,"description":"...","suggestedSection":"1.2"}, ...]`;
}

// ── Промпт для опису реальних креслень клієнта (для заземлення тексту, НЕ для вставки в текст) ──
export function buildDrawingsDescriptionPrompt({ topic, drawings = [], lang = "Українська" }) {
  const nameLines = drawings.map((d, i) => `${i + 1}: ${d.name}`).join("\n");
  return `Ти аналізуєш реальні технічні креслення клієнта для академічної/технічної роботи на тему "${topic || ""}".

КРЕСЛЕННЯ (${drawings.length} шт.):
${nameLines}

ЗАВДАННЯ: для кожного креслення дай суто технічний опис (мова: ${lang}) того, що РЕАЛЬНО видно на зображенні — розміри, назви вузлів/деталей, матеріали, допуски, позначення в штампі, якщо вони читаються. НЕ вигадуй функціонал, технологію чи параметри, яких на кресленні немає і які не випливають напряму з видимого. Якщо якась деталь нечитабельна — так і напиши, що вона нерозбірлива, замість здогадки.

Поверни ТІЛЬКИ JSON масив (без markdown), у тому самому порядку, що й список креслень вище:
[{"name":"назва файлу","description":"..."}, ...]`;
}

// ── Промпт для опису ілюстрацій із PDF ──
export function buildIllustrationsPdfPrompt({ topic, planSections = [], lang = "Українська" }) {
  const sectionsBlock = planSections.length
    ? `\nПЛАН РОБОТИ (підрозділи):\n${planSections.map(s => `${s.id}: ${s.label}`).join("\n")}\n`
    : "";
  return `Ти аналізуєш PDF-документ із ілюстраціями для академічної роботи на тему "${topic || ""}".
${sectionsBlock}
ЗАВДАННЯ: знайди всі ілюстрації (графіки, схеми, діаграми, таблиці, фото, рисунки). Для кожної:
1. Присвій порядковий номер figureNum (1, 2, 3...)
2. Напиши академічний опис (2–3 речення, мова: ${lang}) — що зображено, яка наукова цінність для роботи
3. Витягни підпис якщо він є у документі, або null
4. Визнач id підрозділу плану куди найбільше підходить (напр. "1.2" або "2.3"). Якщо плану немає — вкажи номер глави (напр. "2")

Поверни ТІЛЬКИ JSON масив (без markdown):
[{"figureNum":1,"description":"...","caption":"підпис або null","suggestedSection":"1.2"}, ...]`;
}

// ── Промпт для розподілу джерел клієнта (з client_materials) по підрозділах плану ──
export function buildClientSourcesDistributionPrompt({ topic, materialsText, planSections = [], lang = "Українська" }) {
  const sectionsBlock = planSections.map(s => `${s.id}: ${s.label}`).join("\n");
  return `Ти аналізуєш матеріали, надані клієнтом для академічної роботи на тему "${topic || ""}", і шукаєш серед них ДЖЕРЕЛА — бібліографічні посилання, наукові статті, книги, URL на публікації. НЕ плутай з даними дослідження, таблицями, вимогами чи іншим контентом, який лише треба процитувати чи використати як факти.

ПЛАН РОБОТИ (підрозділи):
${sectionsBlock}

МАТЕРІАЛИ КЛІЄНТА:
${materialsText}

ЗАВДАННЯ: знайди в матеріалах вище КОЖЕН окремий запис, що є посиланням на джерело (автор+назва+рік, DOI, URL на статтю/книгу тощо). Для кожного поверни:
1. "raw" — точний текст цього джерела, як він є в матеріалах (без змін і без додавання нічого від себе).
2. "sectionId" — id підрозділу з плану вище, якому це джерело найбільше підходить за змістом. Якщо жоден підрозділ явно не підходить — null.
3. "snippet" — одне речення (мова: ${lang}) про те, чому це джерело релевантне обраному підрозділу або що в ньому корисного.

Якщо в матеріалах немає жодного реального джерела (лише дані, вимоги, план тощо) — поверни порожній масив.

Поверни ТІЛЬКИ JSON масив (без markdown):
[{"raw":"...","sectionId":"1.2","snippet":"..."}, ...]`;
}

// ── Промпт для аналізу матеріалів клієнта ──
export function buildClientMaterialsAnalysisPrompt({ topic, materialsText }) {
  return `Ти аналізуєш матеріали клієнта для академічної роботи на тему "${topic || ""}".
Нижче — текст документів або дані дослідження, надані клієнтом.

МАТЕРІАЛИ КЛІЄНТА:
${materialsText}

Твоє завдання — структурувати ці матеріали так, щоб виконавець міг точно використати їх при написанні кожного розділу.
ВАЖЛИВО: всі числа, відсотки, дати, назви, власні імена — зберігай ДОСЛІВНО, без округлення і переформулювання. Особливо уважно з одиницями часу — не плутай хвилини й години. Якщо ПІБ (напр. підписанта документа) видно і в друкованому вигляді, і на нечіткому рукописному підписі/печатці — бери саме друкований варіант як надійніший; якщо десь у джерелі це ПІБ вже прочитане — використовуй скрізь ОДНАКОВЕ написання, не вигадуй нових варіантів.

Поверни ТІЛЬКИ JSON (без markdown):
{"rawText":"повний текст матеріалів клієнта — скопіюй дослівно, до 20000 символів. Якщо довший — скопіюй найважливіші частини зберігаючи всі цифри і таблиці","keyFacts":["конкретний факт або цифра 1 — дослівно","конкретний факт або цифра 2 — дослівно"],"tablesMd":"якщо є таблиці з даними — відтвори їх точно у markdown (| col | col |). null якщо таблиць немає","sectionHints":"загальна підказка: для яких розділів роботи ці матеріали найбільш корисні (1-2 речення). null якщо незрозуміло"}`;
}

// ── Промпт для виправлення одного розділу за правками ──
export function buildCorrectionRewritePrompt({ section, originalText, issue, suggestion, info, methodInfo, lang, structureList, existingCitationNumbers, extraGroundingBlock, hasClientIllustrations, allowedNewCitation, availableSourcesList }) {
  const isEnglish = /англ|english/i.test(lang || "");
  const langLine = isEnglish
    ? "Write ONLY in English."
    : `Мова відповіді: ТІЛЬКИ ${lang || "українська"}.`;

  const methodContext = methodInfo
    ? `\nВИМОГИ МЕТОДИЧКИ: ${[methodInfo.theoryRequirements, methodInfo.analysisRequirements, methodInfo.otherRequirements].filter(Boolean).join(". ")}`
    : "";

  const structureBlock = structureList?.length
    ? `\nСТРУКТУРА ВСІЄЇ РОБОТИ (для контексту, щоб не повторювати те, що вже є в інших розділах):\n${structureList.map(l => `- ${l}`).join("\n")}\n`
    : "";

  // Специфічні вимоги для розділів із жорсткою обов'язковою структурою —
  // без цього виправлення генерика ламає формат, який задавала основна генерація.
  let typeNote = "";
  if (section.type === "intro") {
    typeNote = "\nЦе ВСТУП — обов'язково збережи всі його стандартні структурні елементи (актуальність теми, мета, завдання дослідження, об'єкт, предмет, методи дослідження, практичне значення, структура роботи) в тому ж порядку й кількості, навіть якщо виправляєш лише частину. Не перетворюй вступ на суцільний текст без цієї структури.";
  } else if (section.type === "conclusions" || section.type === "chapter_conclusion") {
    typeNote = "\nЦе ВИСНОВКИ — збережи структуру по одному абзацу на кожен пункт (завдання дослідження чи підрозділ), без нумерації та без посилань [N]. Не змінюй загальну кількість абзаців без потреби.";
  } else if (section.type === "sources") {
    typeNote = `\nЦе СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ — КАТЕГОРИЧНО ЗАБОРОНЕНО змінювати нумерацію, порядок чи кількість джерел. Виправляй ЛИШЕ те, про що сказано в зауваженні (форматування, стиль оформлення, розділові знаки в бібліографічному описі). Кожен рядок має лишитись з тим самим номером на початку.${methodInfo?.sourcesFormatRules ? `\nВимоги методички до оформлення джерел: ${methodInfo.sourcesFormatRules}` : ""}${methodInfo?.citationStyle ? `\nСтиль цитування: ${methodInfo.citationStyle}` : ""}`;
  }

  // Наявний список джерел роботи — дозволяє моделі цитувати РЕАЛЬНЕ вже існуюче
  // джерело під його справжнім номером (навіть якщо в цьому конкретному розділі
  // воно раніше не згадувалось), замість вигадувати нове чи вимагати від
  // користувача нового введення. Список — це вже готовий, перевірений текст.
  const sourcesListBlock = availableSourcesList?.length
    ? `\nСПИСОК ДЖЕРЕЛ РОБОТИ (уже наявні й перевірені — можеш посилатись на будь-яке з них під його реальним номером нижче, якщо це доречно для виправлення):\n${availableSourcesList.map(s => `[${s.number}] ${s.text}`).join("\n")}\n`
    : "";

  // Незалежно від стилю цитування ([N], виноски %%FNn%%, (Автор, Рік) для APA/MLA) —
  // заборона вигадувати цитування діє завжди, а не лише коли регулярка знайшла [N].
  // Якщо переданий список джерел роботи — дозволено цитувати БУДЬ-ЯКЕ з нього (це не
  // "нове" посилання, воно вже реально існує в списку літератури), інакше — суворо
  // ніяких нових цитувань, як і раніше.
  const citationGuard = availableSourcesList?.length
    ? `\nЦИТУВАННЯ: можеш процитувати БУДЬ-ЯКЕ джерело зі списку "СПИСОК ДЖЕРЕЛ РОБОТИ" вище під його реальним номером — це вже наявні, перевірені джерела, навіть якщо саме в цьому розділі вони раніше не згадувались. КАТЕГОРИЧНО ЗАБОРОНЕНО вигадувати номер чи посилання, якого немає в цьому списку. Не встав цитату силоміць — якщо жодне з наявних джерел реально не стосується того, що додаєш, пиши без цитування, а не вигадуй нове.${existingCitationNumbers?.length ? ` У самому тексті розділу вже є посилання: ${existingCitationNumbers.map(n => `[${n}]`).join(", ")} — їх так само можеш залишити, перенести разом із реченням чи видалити разом із реченням, яке прибираєш.` : ""}`
    : `\nЦИТУВАННЯ: категорично заборонено додавати НОВІ посилання чи цитування джерел у будь-якому форматі ([N], (Автор, Рік), виноски), яких не було в оригінальному тексті цього розділу — вони не існують у списку літератури і зламають документ.${existingCitationNumbers?.length ? ` У тексті вже є посилання: ${existingCitationNumbers.map(n => `[${n}]`).join(", ")} — саме ці номери й лишаються, нових не вигадуй.` : ""} Наявні посилання можеш залишити на місці, перенести разом із реченням до якого вони належать, або видалити разом із реченням, яке ти прибираєш. Якщо для підтвердження тези бракує джерела — сформулюй без цитування, а не вигадуй нове.${allowedNewCitation ? `\nВИНЯТОК: щойно додано нове джерело в список літератури — дозволено вставити РІВНО ОДНЕ нове посилання ${allowedNewCitation.marker || `[${allowedNewCitation.number}]`} на джерело «${allowedNewCitation.sourceText}». Встав його ТОЧНО в такому вигляді (не заміняй на інший формат) ОДИН раз, одразу після речення в тексті розділу, яке найбільше стосується змісту цього джерела (якщо жодне наявне речення явно не підходить — додай одне нове коротке речення з цим посиланням, органічно вписане в текст). Жодних інших нових посилань, крім ${allowedNewCitation.marker || `[${allowedNewCitation.number}]`}, додавати не можна.` : ""}`;

  const illustrationsGuard = hasClientIllustrations
    ? "\nІЛЮСТРАЦІЇ КЛІЄНТА: оригінальний текст містить рядки-маркери вставки ілюстрацій клієнта у форматі [КЛІЄНТ-ІЛЮСТРАЦІЯ:N] — ОБОВ'ЯЗКОВО збережи КОЖЕН такий рядок ТОЧНО без змін (включно з номером N), на тому самому місці відносно підпису рисунка, навіть якщо переписуєш решту тексту навколо."
    : "";

  return `${langLine}
Ти виправляєш розділ академічної роботи відповідно до зауважень викладача.

ТЕМА РОБОТИ: "${info?.topic || ""}"
НАПРЯМ: "${info?.direction || ""}", ПРЕДМЕТ: "${info?.subject || ""}", ТИП: "${info?.type || ""}"${methodContext}${extraGroundingBlock || ""}
${structureBlock}${sourcesListBlock}
РОЗДІЛ: "${section.label}"${typeNote}${illustrationsGuard}

ОРИГІНАЛЬНИЙ ТЕКСТ РОЗДІЛУ:
${originalText}

ЗАУВАЖЕННЯ ВИКЛАДАЧА ДО ЦЬОГО РОЗДІЛУ:
Проблема: ${issue}
Що виправити: ${suggestion}
${citationGuard}
ВАЖЛИВО:
- Тема, напрям і загальний зміст роботи НЕ змінюються — тільки виправляй зазначені проблеми
- Збережи структуру та обсяг розділу — приблизно стільки ж слів, скільки в оригіналі
- Виправ конкретно те про що написано в зауваженні
- Поверни ТІЛЬКИ текст розділу без жодних пояснень`;
}

// ── Точкова вставка джерел, призначених підрозділу, але не процитованих під час
// генерації (один виклик на весь набір для підрозділу, а не рядок за рядком і не
// переписування підрозділу цілком — ШІ лише вказує, до якого наявного речення
// прив'язати позначку джерела, за схемою original/replacement із
// buildAnnotationCorrectionBatchPrompt). ──
export function buildCitationInsertPrompt({ sectionText, insertions, lang }) {
  const isEnglish = /англ|english/i.test(lang || "");
  const langLine = isEnglish ? "Write ONLY in English." : `Мова відповіді: ТІЛЬКИ ${lang || "українська"}.`;
  const itemsBlock = insertions.map((ins, i) => {
    const ctxLines = [
      ins.thesis ? `   Шукалось під тезу: "${ins.thesis}"` : "",
      ins.abstract ? `   Зміст джерела: "${ins.abstract.slice(0, 300)}"` : "",
    ].filter(Boolean).join("\n");
    return `${i}. Джерело: "${ins.sourceText}"\n   Позначка для вставки (перенести ДОСЛІВНО як є): ${ins.marker}${ctxLines ? "\n" + ctxLines : ""}`;
  }).join("\n");
  return `${langLine}
Нижче — текст підрозділу академічної роботи. Для кожного джерела зі списку визнач, чи є в тексті РЕЧЕННЯ, зміст якого це джерело справді підтверджує (спирайся на "Зміст джерела" і "Шукалось під тезу", якщо вказані — назва статті сама по собі часто оманлива). Якщо так — встав туди його позначку.

ТЕКСТ ПІДРОЗДІЛУ:
${sectionText}

ДЖЕРЕЛА ДЛЯ ВСТАВКИ:
${itemsBlock}

Поверни JSON-масив, РІВНО по одному об'єкту на кожне джерело зі списку вище, у тому самому порядку — "index" відповідає його номеру (0, 1, 2...):
[{"index":0,"match":true,"original":"дослівна цитата ОДНОГО речення з ТЕКСТУ ПІДРОЗДІЛУ вище, зміст якого це джерело підтверджує","replacement":"те саме речення з доданою позначкою джерела в кінці (перед крапкою)"}]

Правила:
- "match": true — лише якщо джерело ЗМІСТОВНО підтверджує конкретне речення (той самий предмет, не просто той самий загальний напрям); інакше "match": false
- НЕ підв'язуй джерело до речення тільки тому, що воно "по темі" — якщо предмет джерела інший (інший вид травми, інший орган, інше дослідження тощо), чесне "match": false краще за хибну прив'язку
- Якщо "match": false — постав "original": null, "replacement": null
- "original" — дослівна цитата рівно одного речення з тексту підрозділу, без жодних змін
- "replacement" — це САМЕ речення з доданою позначкою джерела наприкінці; більше нічого в ньому не змінюй
- Позначку встав ТОЧНО в тому вигляді, як вказано у "Позначка для вставки" — не переформатовуй і не скорочуй її
- Різні джерела мають вказувати на РІЗНІ речення, якщо в тексті є хоч трохи вибору
- Якщо "original" чи "replacement" містять символ лапок " — обов'язково екрануй його зворотним слешем всередині JSON-рядка
- Поверни ТІЛЬКИ JSON-масив (без markdown і пояснень), рівно ${insertions.length} об'єктів`;
}

// ── Точкова добудова рисунка для речення, яке вже посилається на "Рис. X.Y", але
// сам рисунок (plantuml-блок/таблиця) відсутній у тексті — findDanglingFigureRefs
// (planUtils.js) ловить це кодом, ця функція формує точковий запит на добудову,
// без переписування всього підрозділу (той самий підхід, що й buildCitationInsertPrompt). ──
export function buildFigureInsertPrompt({ sectionText, dangling, lang }) {
  const isEnglish = /англ|english/i.test(lang || "");
  const langLine = isEnglish ? "Write ONLY in English." : `Мова відповіді: ТІЛЬКИ ${lang || "українська"}.`;
  const itemsBlock = dangling.map((d, i) => `${i}. Речення: "${d.sentence}" (посилається на Рис. ${d.number})`).join("\n");
  return `${langLine}
Нижче — текст підрозділу академічної роботи. У ньому є речення, які посилаються на рисунок/схему за номером, але сам рисунок у тексті відсутній (він так і не був намальований). Для кожного такого речення створи PlantUML-діаграму (клас, послідовність, use case, або проста схема процесу/структури — залежно від контексту речення й підрозділу), яка відповідає тому, про що йдеться в реченні.

ТЕКСТ ПІДРОЗДІЛУ:
${sectionText}

РЕЧЕННЯ БЕЗ РИСУНКА:
${itemsBlock}

Поверни JSON-масив, РІВНО по одному об'єкту на кожне речення зі списку вище, у тому самому порядку — "index" відповідає його номеру (0, 1, 2...):
[{"index":0,"feasible":true,"plantuml":"@startuml\\n...\\n@enduml","caption":"Рис. X.Y – короткий підпис"}]

Правила:
- "plantuml" — валідний PlantUML-код (рядок з екранованими переносами \\n), що починається з @startuml і закінчується @enduml, БЕЗ code fence (без потрійних лапок)
- "feasible": false, якщо для цього речення діаграму побудувати неможливо чи недоречно (наприклад, йдеться про фотографію обладнання, а не про структуру/процес) — тоді "plantuml" і "caption" постав null
- "caption" — короткий підпис рисунка з ТИМ САМИМ номером, що вказано в реченні
- Поверни ТІЛЬКИ JSON-масив (без markdown і пояснень), рівно ${dangling.length} об'єктів`;
}

// ── Вигадати назви розділів/підрозділів, яких БРАКУЄ в готовій частині роботи клієнта (продовження) ──
export function buildContinuationPlanPrompt({ topic, subject, type, lang, existingChapterTitles, newChapters, otherRequirements }) {
  const chaptersBlock = newChapters
    .map(c => `Розділ ${c.num}: рівно ${c.subsCount} підрозділ(и/ів)${c.forcedType ? `, тип "${c.forcedType}" (обов'язково саме такий, не змінюй)` : ""}`)
    .join("\n");
  return `Для ${type} на тему "${topic}" (галузь: ${subject}) вже написано розділ(и): ${existingChapterTitles.join("; ") || "немає"}.
Придумай назви для розділів, яких ще бракує, не повторюючи вже написане. Розділ може стояти як ПІСЛЯ готових (логічно продовжує їх), так і ПЕРЕД ними (напр. теоретичний розділ 1 до готового аналітичного розділу 2) — тоді він має логічно підводити до готового.
Мова роботи: ${lang || "Українська"} — усі назви цією мовою.
${otherRequirements ? `\nВИМОГИ МЕТОДИЧКИ (обов'язково врахувати): ${otherRequirements}\n` : ""}
ПОТРІБНО СТВОРИТИ:
${chaptersBlock}

Поверни ТІЛЬКИ JSON без markdown:
{"chapters":[{"num":2,"title":"РОЗДІЛ 2. НАЗВА","type":"analysis","subsections":["2.1 Назва підрозділу","2.2 Назва підрозділу"]}]}

Правила:
- type: "theory" (теоретичний), "analysis" (аналітичний/практичний) або "recommendations" (рекомендаційний) — якщо вище вказано обов'язковий тип для розділу, постав саме його
- Кількість підрозділів у кожному розділі — точно як вказано вище
- Назви підрозділів мають починатися з номера (наприклад "2.1 ...")`;
}

// ── Витягнути РЕАЛЬНУ структуру (заголовки розділів/підрозділів) з готової частини роботи клієнта, а не вигадувати нову ──
export function buildExtractStructurePrompt({ documentText }) {
  return `Розбий наданий текст академічної роботи на розділи й підрозділи ЗА ЗАГОЛОВКАМИ, ЯКІ РЕАЛЬНО Є В ЦЬОМУ ТЕКСТІ. Не вигадуй нову структуру і не перейменовуй заголовки — використовуй їх точно так, як написано в тексті.

ТЕКСТ РОБОТИ:
${documentText}

Поверни результат у ТАКОМУ текстовому форматі (без JSON, без markdown-блоків) — один блок на кожен знайдений розділ або підрозділ, у тому порядку, в якому вони йдуть у тексті:

@@@SECTION id="1.1" title="1.1 Точна назва підрозділу з тексту" chapterTitle="РОЗДІЛ 1. ТОЧНА НАЗВА РОЗДІЛУ З ТЕКСТУ" type="theory"@@@
повний текст цього підрозділу (без самого заголовка), з уніфікованими [N] замість цитувань, без скорочень
@@@SOURCES@@@
Джерело 1 — повний бібліографічний опис
@@@END@@@

Правила визначення id і типу:
- Підрозділи нумеруй за їх реальними номерами з тексту (1.1, 1.2, 2.1 тощо). Якщо в тексті вони не пронумеровані явно — нумеруй послідовно в межах розділу, до якого вони належать
- Вступ: id="intro", title="Вступ" (або відповідник мовою тексту), type="intro"
- Загальні висновки роботи (в самому кінці, не до окремого розділу): id="conclusions", type="conclusions"
- Проміжні висновки до розділу N (якщо є в кінці розділу): id="N.conclusions", type="chapter_conclusion"
- Список використаних джерел у кінці документа: id="sources", type="sources" — увесь список постав як текст цього блоку, SOURCES залиш порожнім
- type підрозділів основної частини: "theory" (теоретичний), "analysis" (аналітичний/практичний) або "recommendations" (рекомендаційний) — за змістом
- chapterTitle однаковий для всіх підрозділів одного розділу — точна назва розділу з тексту, включно з "РОЗДІЛ N." якщо так написано
- Якщо в розділі немає підрозділів з окремими заголовками, а є суцільний текст — постав title як стислу назву (2-6 слів) за змістом цього фрагмента

Правила по джерелах (тільки для підрозділів, не для блоку "sources"):
- Знайди джерела, на які посилається текст (у будь-якому форматі), у порядку появи в тексті підрозділу. Знайди повний бібліографічний опис у списку літератури в кінці документа, якщо він є
- Перепиши позначки цитувань у тексті в уніфікований формат [N], де N — порядковий номер джерела в SOURCES цього підрозділу (перше за появою — [1] і т.д., повторні цитування того самого джерела — той самий номер). Решту тексту НЕ змінюй
- Якщо в підрозділі немає цитувань — залиш SOURCES порожнім
- Не вигадуй джерела, яких немає в тексті чи списку літератури

Включай ВЕСЬ текст кожного підрозділу без скорочень. Не додавай нічого поза цими блоками (без пояснень, без markdown).`;
}

// ── Правки клієнта до ще не написаного плану роботи (структурні операції, а не текст) ──
export function buildClientPlanEditsPrompt({ sections, editsText }) {
  const mainSecs = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
  const groups = [];
  const groupByTitle = {};
  mainSecs.forEach(s => {
    const cn = s.id.split(".")[0];
    if (!groupByTitle[cn]) { groupByTitle[cn] = { chapterId: cn, title: s.sectionTitle, subs: [] }; groups.push(groupByTitle[cn]); }
    groupByTitle[cn].subs.push(s);
  });
  const intro = sections.find(s => s.type === "intro");
  const conclusions = sections.find(s => s.type === "conclusions");
  const sourcesSec = sections.find(s => s.type === "sources");

  const planLines = [];
  if (intro) planLines.push(`intro — ${intro.label} (${intro.pages} стор.)`);
  groups.forEach(g => {
    planLines.push(`розділ ${g.chapterId} — ${g.title}`);
    g.subs.forEach(s => planLines.push(`  ${s.id} — ${s.label} (${s.pages} стор.)`));
  });
  if (conclusions) planLines.push(`conclusions — ${conclusions.label} (${conclusions.pages} стор.)`);
  if (sourcesSec) planLines.push(`sources — ${sourcesSec.label}`);

  return `Ти перетворюєш правки клієнта до плану академічної роботи на список конкретних структурних операцій.

ПОТОЧНИЙ ПЛАН (id — назва (обсяг)):
${planLines.join("\n")}

ПРАВКИ КЛІЄНТА (вільний текст, може стосуватись кількох пунктів плану одразу):
${editsText}

Поверни ТІЛЬКИ JSON масив (без markdown), де кожен елемент — одна операція одного з видів:
- {"op":"rename","id":"1.2","newLabel":"нова назва БЕЗ номера"} — перейменувати підрозділ; id:"intro"/"conclusions"/"sources" — перейменувати вступ/висновки/список джерел
- {"op":"rename_chapter","chapterId":"1","newTitle":"нова назва розділу БЕЗ префіксу «РОЗДІЛ N.»"}
- {"op":"resize","id":"1.2","newPages":5} — новий обсяг у сторінках (id може бути й "intro"/"conclusions")
- {"op":"add_subsection","chapterId":"2","label":"назва нового підрозділу БЕЗ номера","pages":4,"afterId":"2.1"} — afterId необов'язковий, без нього підрозділ додається в кінець розділу
- {"op":"add_chapter","title":"назва нового розділу","subsections":[{"label":"назва підрозділу","pages":4}]} — subsections необов'язковий, без нього буде 3 підрозділи-заглушки
- {"op":"remove","id":"2.3"} — видалити підрозділ (НІКОЛИ не використовуй remove для "intro"/"conclusions"/"sources")

Правила:
- Використовуй ЛИШЕ id/chapterId, що реально є в плані вище
- Одна правка клієнта може дати кілька операцій
- Якщо правка неоднозначна, суперечлива або не стосується структури плану (наприклад, стосується змісту чи стилю самого тексту, якого ще нема) — пропусти її, не вигадуй
- Якщо в правках клієнта взагалі немає структурних змін — поверни порожній масив []
- Повертай ТІЛЬКИ JSON масив`;
}

// ── Правки менеджера з CRM до плану: ШІ бачить старий план і коментар та повертає ПОВНИЙ
// оновлений план текстом (на відміну від buildClientPlanEditsPrompt, що дає список операцій).
// Розбір тексту й збереження сторінок робить код (rebuildPlanFromText у planUtils). ──
export function buildPlanRewritePrompt({ topic, language, planText, comment }) {
  return `Ти редагуєш план академічної роботи за коментарем менеджера.

ТЕМА РОБОТИ: ${topic || "(не вказано)"}
МОВА РОБОТИ: ${language || "Українська"}

ПОТОЧНИЙ ПЛАН (у квадратних дужках [N стор.] — обсяг підрозділу в сторінках):
${planText}

КОМЕНТАР МЕНЕДЖЕРА (що треба змінити в плані):
${comment}

Завдання: внеси в план УСІ правки з коментаря й поверни ПОВНИЙ оновлений план.

Правила:
- Змінюй лише те, про що йдеться в коментарі. Решту пунктів лиши слово в слово, з тими самими обсягами.
- Формат лиши таким самим, як у поточному плані: "Вступ", рядки розділів ("РОЗДІЛ N. НАЗВА"), під ними підрозділи з відступом ("N.N Назва [N стор.]"), за наявності "Висновки до розділу N", далі "Висновки" і "Список використаних джерел".
- Нумерація розділів і підрозділів послідовна, без пропусків і повторів — після додавання, видалення чи переміщення перенумеруй.
- Для нових підрозділів став розумний обсяг у [N стор.] (зазвичай 3–5), обсяг змінюй лише якщо про це йдеться в коментарі. Загальну суму сторінок вирівняє код — про неї не турбуйся.
- Назви нових і змінених пунктів — мовою роботи, у стилі наявних, відповідно до теми. Нічого не вигадуй поза коментарем.
- Якщо коментар неоднозначний — обери найрозумніше тлумачення й внеси його: план має змінитись.
- Поверни ТІЛЬКИ текст плану: без пояснень, без markdown, без блоків коду.`;
}

// ── Аналіз правок для власного файлу (повний текст документа) ──
export function buildFileCorrectionsAnalysisPrompt({ documentText, correctionsText }) {
  return `Ти аналізуєш зауваження викладача до академічної роботи.

ТЕКСТ РОБОТИ:
${documentText}

ЗАУВАЖЕННЯ ВИКЛАДАЧА:
${correctionsText}

На основі зауважень визнач конкретні завдання для виправлення.
Поверни ТІЛЬКИ JSON масив (без markdown):
[{"id":"task_1","location":"назва частини/розділу де проблема","issue":"коротко що не так (1-2 речення)","suggestion":"конкретно що треба зробити (1-2 речення)","sourcesAction":"restructure — ЛИШЕ якщо зауваження про список джерел, інакше не додавай це поле"}]

Правила:
- Кожне зауваження = окремий елемент масиву
- location: назва розділу, «Вступ», «Висновки», «Список літератури» або «Весь текст»
- Якщо зауваження загальне — розбий на конкретні підзавдання. ВИНЯТОК: якщо зауваження просить переробити чи адаптувати ВСЮ роботу під інший контекст (напр. "переробити під ЗДО, а не школу") — НЕ розбивай його: поверни ОДИН елемент з location "Весь текст" і suggestion, що дослівно повторює зауваження
- Постав "sourcesAction":"restructure" ЛИШЕ якщо зауваження явно просить додати конкретне(і) нове(і) джерело(а) або видалити конкретне(і) джерело(а) зі списку літератури (не для форматування/стилю джерел — там це поле не потрібне)
- Повертай ТІЛЬКИ JSON`;
}

// ── Визначення конкретних змін у списку джерел (що видалити / що додати) ──
export function buildSourcesRestructureAnalysisPrompt({ currentSourcesText, issue, suggestion }) {
  return `Ти аналізуєш зауваження викладача щодо списку використаних джерел академічної роботи.

ПОТОЧНИЙ СПИСОК ДЖЕРЕЛ (пронумерований):
${currentSourcesText}

ЗАУВАЖЕННЯ ЩОДО ЦЬОГО РОЗДІЛУ:
Проблема: ${issue}
Що зробити: ${suggestion}

Визнач:
1. "remove" — номери джерел зі списку вище, які треба ВИДАЛИТИ (масив чисел). Лише ті, що явно чи однозначно випливають із зауваження (застарілі, некоректні, зайві, дублікати тощо).
2. "add" — НОВІ джерела для додавання. Кожен елемент — рядок сирого бібліографічного опису ТОЧНО як він поданий у зауваженні (автор, назва, рік, видавництво, URL тощо — усе, що є). НЕ форматуй за стилем, НЕ вигадуй дані, яких немає. Якщо зауваження просить "додати ще джерел" без конкретного бібліографічного опису — залиш "add" порожнім масивом, бо вигадувати джерело заборонено.

Поверни ТІЛЬКИ JSON (без markdown):
{"remove":[номери чисел, може бути порожній масив],"add":["сирий опис нового джерела 1", "..."]}`;
}

// ── Визначення анкерного речення, після якого вставити цитування нового джерела —
// для "Правки до файлу" немає структури sections, тож замість "обери розділ" просимо
// ШІ вказати ДОСЛІВНИЙ фрагмент тексту роботи, після якого органічно лягає цитата. ──
export function buildSourcePlacementInTextPrompt({ documentText, newSourceText, citationMarker }) {
  return `У цій академічній роботі щойно додано нове джерело до списку літератури:
${newSourceText}

ПОВНИЙ ТЕКСТ РОБОТИ:
${documentText}

Знайди речення в тексті роботи (окрім самого списку джерел), яке найбільше стосується змісту цього джерела, і після якого органічно лягає посилання ${citationMarker}.

Поверни ТІЛЬКИ JSON (без markdown):
{"anchor":"дослівна цитата останніх кількох слів речення, після якого треба вставити посилання — скопіюй точно з тексту вище","found":true}
Якщо жодне речення реально не стосується цього джерела — поверни {"anchor":null,"found":false}, НЕ вигадуй штучний анкер.`;
}

// ── Виправлення виділених або прокоментованих фрагментів за один виклик (Варіант А) ──
// Батч замість одного запиту на кожен фрагмент — повний текст роботи надсилається
// РАЗ на групу завдань, а не окремо для кожного, що й дає основну економію токенів.
// ШІ сам повертає "original" (як і для ручних зауважень нижче), а не програма
// заднім числом шукає task.annotatedText у тексті: так ШІ, бачачи ПОВНИЙ текст
// роботи, сам обирає точний і, головне, НАЙВУЖЧИЙ фрагмент для заміни (окреме
// речення, а не цілий абзац) — це і рятує від помилкового зіставлення з
// однаковим фрагментом, що трапляється в роботі кілька разів, і не захоплює
// зайвий сусідній текст, який могла позначити інша правка.
export function buildAnnotationCorrectionBatchPrompt({ documentText, tasks }) {
  const tasksBlock = tasks.map((t, i) => {
    const instrLine = t.instruction || "Виправте або перепишіть виділений фрагмент, зберігаючи стиль і мову оригіналу.";
    return `--- Завдання ${i} ---
ВИДІЛЕНИЙ ФРАГМЕНТ: "${t.annotatedText}"
${t.context && t.context !== t.annotatedText ? `КОНТЕКСТ (абзац): "${t.context}"` : ""}
ІНСТРУКЦІЯ: ${instrLine}${t.extraContext || ""}`;
  }).join("\n\n");

  return `Ти виправляєш кілька фрагментів академічної роботи за один прохід.

ПОВНИЙ ТЕКСТ РОБОТИ:
${documentText}

ЗАВДАННЯ (кожне — окремий виділений фрагмент; обробляй незалежно, вони не пов'язані одне з одним):
${tasksBlock}

Для КОЖНОГО завдання виділений фрагмент буває двох типів — спершу визнач, який це випадок:
1. Це сам проблемний текст роботи (стиль, помилка, незрозуміла фраза) — виправ безпосередньо його.
2. Це репліка чи питання рецензента/керівника ПРО сусідній текст (наприклад "Що це за нереальні сторінки?", "Ти читаєш що тобі генерує ШІ?", "тут потрібне джерело" тощо) — тоді справжня проблема НЕ в самій репліці, а в тексті поруч із нею (часто прямо перед). Визнач, на що саме вказує репліка, виправ САМЕ той фрагмент і прибери репліку рецензента з тексту.

Якщо для якогось завдання бракує даних, яких ти не можеш ні знати, ні перевірити (наприклад, яка насправді сторінка джерела, чи існує факт, який номер правильний) — НЕ вигадуй значення і не залишай текст без змін мовчки для цього завдання. Постав для нього статус needs_review з коротким поясненням.

Поверни ТІЛЬКИ JSON-масив (без markdown), РІВНО по одному об'єкту на кожне завдання зі списку вище, у тому самому порядку — "index" відповідає номеру завдання (0, 1, 2...):
[{"index":0,"status":"fixed","original":"точна дослівна цитата з ПОВНОГО ТЕКСТУ РОБОТИ вище, яку треба замінити","replacement":"виправлений варіант ЛИШЕ цього original-фрагмента"}]
Для needs_review: {"index":1,"status":"needs_review","note":"коротко, чому неможливо виправити автоматично"}

Правила:
- "original" зазвичай дорівнює "ВИДІЛЕНИЙ ФРАГМЕНТ" завдання, але якщо репліка рецензента чи нотатка вказує на СУСІДНІЙ текст (випадок 2 вище) — "original" має бути саме тим сусіднім текстом, а не самою реплікою
- "original" бери НАЙВУЖЧИМ, який реально потрібен для виправлення (речення чи кілька слів, а не весь абзац чи весь контекст), щоб не зачепити сусідній текст, який може стосуватись іншого завдання
- Якщо виділений фрагмент підлягає повному видаленню (наприклад це лише репліка рецензента без окремого дефекту поруч) — "original" = сам цей фрагмент, "replacement" пустий рядок
- Завдання незалежні одне від одного — заміни різних завдань НЕ повинні перетинатись фрагментами
- "original" — дослівна цитата, без змін
- Якщо "original" чи "replacement" містять символ лапок " — обов'язково екрануй його зворотним слешем всередині JSON-рядка, інакше весь масив не розпарситься
- НЕ повертай весь документ і нічого поза JSON-масивом`;
}

// ── Промпти для звіту з практики ──

// Обирає найбільш підхожий варіант описового плану звіту (methodInfo.contentPlans), коли методичка
// наводить кілька альтернатив залежно від типу бази практики (напр. турфірма / готель-ресторан / музей) —
// зіставляє слова опису кожного варіанта ("appliesTo") з реальними даними практики (місце, текст завдання).
function pickContentPlan(plans, info) {
  if (!Array.isArray(plans) || !plans.length) return null;
  if (plans.length === 1) return plans[0];
  const hay = `${info.companyName || ""} ${info.practiceText || ""} ${info.direction || ""} ${info.subject || ""}`.toLowerCase();
  let best = null, bestScore = 0;
  for (const p of plans) {
    const words = String(p.appliesTo || "").toLowerCase().split(/[^а-яіїєґa-z0-9]+/i).filter(w => w.length > 3);
    const score = words.reduce((s, w) => s + (hay.includes(w) ? 1 : 0), 0);
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return best || plans[0];
}

// Перетворює обраний contentPlan у текст у форматі "зразка змісту" (як exampleTOC), щоб його можна
// було подати в той самий сценарій генерації плану, що й для методичок з класичним ВСТУП/РОЗДІЛ/1.1.
function contentPlanToToc(plan) {
  if (!plan?.items?.length) return "";
  return plan.items.map(it => {
    const subLines = (it.subitems || []).filter(Boolean).join("\n");
    return subLines ? `${it.label}\n${subLines}` : it.label;
  }).join("\n");
}

export function buildPracticePlanPrompt(info, methodInfo, structureExampleText, deptGuidanceText) {
  const { practiceText = "", practiceCategory = "economy", pages = 30, practiceGuidance } = info;
  const total = parseInt(pages) || 30;
  const { introPages, conclPages } = resolvePracticeFixedPages(practiceText, deptGuidanceText);
  const main = total - introPages - conclPages;

  // Шаблони структури по категоріях
  const templates = {
    economy: [
      { id: "ch1", label: "1. Загальна характеристика підприємства", w: 0.18 },
      { id: "ch2", label: "2. Аналіз основних напрямів діяльності підприємства", w: 0.18 },
      { id: "ch3", label: "3. Виконані завдання під час практики", w: 0.28 },
      { id: "ch4", label: "4. Індивідуальне завдання", w: 0.25 },
    ],
    pedagogy: [
      { id: "ch1", label: "1. Характеристика навчального закладу", w: 0.15 },
      { id: "ch2", label: "2. Аналіз навчально-виховного процесу", w: 0.20 },
      { id: "ch3", label: "3. Проведені уроки та виховні заходи", w: 0.28 },
      { id: "ch4", label: "4. Позакласна та виховна робота", w: 0.15 },
      { id: "ch5", label: "5. Індивідуальне завдання", w: 0.11 },
    ],
    law: [
      { id: "ch1", label: "1. Характеристика установи та її правового статусу", w: 0.18 },
      { id: "ch2", label: "2. Аналіз нормативно-правової бази діяльності установи", w: 0.20 },
      { id: "ch3", label: "3. Практична юридична діяльність", w: 0.25 },
      { id: "ch4", label: "4. Складені документи та правові висновки", w: 0.15 },
      { id: "ch5", label: "5. Індивідуальне завдання", w: 0.11 },
    ],
    it: [
      { id: "ch1", label: "1. Характеристика підприємства та ІТ-інфраструктури", w: 0.15 },
      { id: "ch2", label: "2. Аналіз технологічного стеку та архітектури", w: 0.18 },
      { id: "ch3", label: "3. Виконані технічні завдання", w: 0.30 },
      { id: "ch4", label: "4. Індивідуальне завдання", w: 0.26 },
    ],
    medicine: [
      { id: "ch1", label: "1. Характеристика клінічної бази практики", w: 0.15 },
      { id: "ch2", label: "2. Організація лікувально-профілактичної роботи", w: 0.20 },
      { id: "ch3", label: "3. Виконані маніпуляції та клінічна діяльність", w: 0.30 },
      { id: "ch4", label: "4. Індивідуальне завдання", w: 0.24 },
    ],
    psychology: [
      { id: "ch1", label: "1. Характеристика бази практики та психологічної служби", w: 0.15 },
      { id: "ch2", label: "2. Аналіз психологічного супроводу в організації", w: 0.18 },
      { id: "ch3", label: "3. Психодіагностична робота (методики, результати)", w: 0.28 },
      { id: "ch4", label: "4. Корекційна та консультативна діяльність", w: 0.18 },
      { id: "ch5", label: "5. Індивідуальне завдання", w: 0.10 },
    ],
    other: [
      { id: "ch1", label: "1. Загальна характеристика бази практики", w: 0.18 },
      { id: "ch2", label: "2. Аналіз основної діяльності організації", w: 0.20 },
      { id: "ch3", label: "3. Виконані завдання під час практики", w: 0.30 },
      { id: "ch4", label: "4. Індивідуальне завдання", w: 0.21 },
    ],
  };

  const tmpl = templates[practiceCategory] || templates.other;
  const mainSecs = tmpl.map(s => ({ ...s, pages: Math.max(3, Math.round(main * s.w)) }));

  const sectionsJson = [
    `  {"id":"intro","label":"Вступ","pages":${introPages}}`,
    ...mainSecs.map(s => `  {"id":"${s.id}","label":"${s.label}","pages":${s.pages}}`),
    `  {"id":"conclusions","label":"Висновки","pages":${conclPages}}`,
    `  {"id":"sources","label":"Список використаних джерел","pages":0}`,
  ].join(",\n");

  const guidanceBlock = practiceGuidance
    ? `\n\nОРІЄНТИР ЗА НАПРЯМОМ ТА ВИДОМ ПРАКТИКИ:
Мета практики: ${practiceGuidance.purpose}
Що має містити основна частина звіту: ${practiceGuidance.reportContent}
Особливість: ${practiceGuidance.feature}`
    : "";

  const deptGuidanceBlock = deptGuidanceText?.trim()
    ? `\n\nДОДАТКОВІ ВИМОГИ КАФЕДРИ до структури й обсягу звіту (враховуй лише вимоги до змісту/обсягу реальних розділів; ігноруй дедлайни, критерії оцінювання та інші процедурні деталі). Якщо тут є перелік пунктів звіту (напр. "1) Титульна сторінка, 2) Зміст, 3) Щоденник практики...") — це НЕ готовий план розділів, а чек-лист складу документа: титульна сторінка, зміст, щоденник і список джерел вже є окремими фіксованими елементами звіту поза цим масивом розділів і НЕ повинні ставати власними елементами "sections" (їм не потрібні джерела чи текст-переказ). У масив "sections" перетворюй ЛИШЕ пункти, що описують змістовні розділи (аналіз, виконані завдання, індивідуальне завдання тощо):\n${deptGuidanceText.trim().slice(0, 9000)}`
    : "";

  // Якщо в методичці є власний зразок змісту з підрозділами (1.1, 1.2 ...) —
  // будуємо структуру за ним замість плоского шаблону по категорії.
  // Зразок готового звіту від клієнта (якщо завантажений) має пріоритет над зразком з методички.
  let toc = methodInfo?.exampleTOC || "";
  // Зразок готового звіту рахуємо джерелом підрозділів лише якщо в його тексті справді
  // є нумеровані підрозділи (1.1, 1.2 ...) — інакше (суцільна розповідь без заголовків)
  // немає реальної структури, яку можна відтворити, і треба падати на плоский шаблон
  // за категорією, а НЕ на contentPlans з методички (structureExampleText все одно
  // блокує цей фолбек нижче — приклад завжди пріоритетніший за методичку).
  // ВАЖЛИВО: проста /\d+\.\d+/ хибно ловить і дати на кшталт "25.08.2024" (підпис під
  // сканом) чи "17.08.2026" — тому вимагаємо, щоб після "N.N" не йшла ще одна ".цифра"
  // (третій компонент дати) і щоб далі був пробіл і буква (реальна назва підрозділу).
  const TOC_SUBSECTION_RE = /^\s*\d{1,2}\.\d{1,2}(?!\.\d)\.?\s+\p{L}/mu;
  let hasSubsections = TOC_SUBSECTION_RE.test(structureExampleText || "") || TOC_SUBSECTION_RE.test(toc);
  // Немає класичного зразка змісту, але методичка описала зміст звіту переліком пунктів
  // (contentPlans, витягнутих на кроці читання методички) — використовуємо найбільш підхожий варіант.
  if (!hasSubsections && !structureExampleText && methodInfo?.contentPlans?.length) {
    const chosenPlan = pickContentPlan(methodInfo.contentPlans, info);
    const planToc = contentPlanToToc(chosenPlan);
    if (planToc) { toc = planToc; hasSubsections = true; }
  }
  const sampleBlock = structureExampleText
    ? `ЗРАЗОК ГОТОВОГО ЗВІТУ (візьми з нього реальну структуру розділів і підрозділів — кількість, порядок, рівень деталізації; це повний текст зразка, орієнтуйся лише на заголовки та поділ на частини):\n${structureExampleText}`
    : `ЗРАЗОК ПЛАНУ З МЕТОДИЧКИ (відтвори ЦЮ структуру розділів і підрозділів — кількість, порядок і рівень вкладеності, адаптувавши лише назви під конкретне підприємство/установу та тип практики):\n${toc}`;

  if (hasSubsections) {
    return `Склади структуру звіту з практики за зразком плану.
Загальний обсяг: ${total} сторінок.

ДАНІ ПРАКТИКИ:
${practiceText}
${guidanceBlock}${deptGuidanceBlock}

${sampleBlock}

Поверни ТІЛЬКИ JSON (без markdown):
{"sections":[
  {"id":"intro","label":"Вступ","pages":${introPages}},
  {"id":"1.1","label":"1.1 Назва підрозділу","sectionTitle":"Розділ 1. Назва розділу","pages":5},
  {"id":"1.2","label":"1.2 Назва підрозділу","sectionTitle":"Розділ 1. Назва розділу","pages":5},
  {"id":"2.1","label":"2.1 Назва підрозділу","sectionTitle":"Розділ 2. Назва розділу","pages":6},
  {"id":"conclusions","label":"Висновки","pages":${conclPages}},
  {"id":"sources","label":"Список використаних джерел","pages":0}
]}
(значення "pages" у прикладі для підрозділів 1.1/1.2/2.1 вище — лише ілюстрація формату; для "intro" і "conclusions" завжди бери ТОЧНО числа, вказані в цьому прикладі, — ${introPages} і ${conclPages} відповідно, не змінюй і не перераховуй їх)

Правила:
- Кожен підрозділ зі зразка — окремий елемент масиву з id виду "N.M" (номер розділу.номер підрозділу за порядком у зразку)
- Назви розділів і підрозділів пиши як у реченні (велика літера лише на початку, решта — малими; НЕ великими літерами)
- "sectionTitle" — повна назва розділу з номером (напр. "Розділ 1. Характеристика бази практики"), ОДНАКОВА для всіх підрозділів одного розділу
- "label" — номер і назва підрозділу (напр. "1.1 Загальна характеристика підприємства (бази практики)")
- Якщо якийсь розділ зі зразка не має підрозділів — додай один елемент з id рівним номеру розділу (напр. "3", без крапки) і без "sectionTitle"
- pages розподіли пропорційно між усіма підрозділами/розділами так, щоб їх сума дорівнювала ${main}
- intro: РІВНО ${introPages} стор., conclusions: РІВНО ${conclPages} стор. — фіксовані значення, не "залишок" і не пропорція
- id "intro"/"conclusions"/"sources" залишати незмінними; для решти використовуй нумерацію зі зразка`;
  }

  if (structureExampleText) {
    // Зразок є, але БЕЗ підрозділів (суцільний виклад думок, без заголовків, без
    // окремого вступу/висновків/списку джерел) — не підставляємо замість нього ні
    // вигаданий плоский шаблон за категорією, ні штучний поділ на вступ/висновки:
    // весь звіт лишається одним цілим блоком, як і сам зразок.
    return `Склади структуру звіту з практики за зразком.
Зразок написаний СУЦІЛЬНИМ текстом від початку до кінця — без розділів, без окремого вступу чи висновків, без списку джерел. Повтори цей формат.

ЗРАЗОК ГОТОВОГО ЗВІТУ:
${structureExampleText.slice(0, 20000)}

Поверни ТІЛЬКИ цей JSON без змін:
{"sections":[
  {"id":"main","label":"Звіт","pages":${total}}
]}`;
  }

  return `Склади структуру звіту з практики.
Загальний обсяг: ${total} сторінок.

ДАНІ ПРАКТИКИ:
${practiceText}
${guidanceBlock}${deptGuidanceBlock}

Поверни ТІЛЬКИ JSON (без markdown):
{"sections":[
${sectionsJson}
]}

Адаптуй назви розділів до конкретного підприємства/установи та типу практики. id залишати незмінними.`;
}

// Правила проти найпомітніших ознак ШІ у суцільному звіті практики (isFreeformMain нижче).
// Винесено окремо, бо їх треба передавати ЩЕ РАЗ у enforceWordCount(): той робить окремий
// виклик моделі для дописування бракуючих слів з абсолютно іншим промптом ("допиши ще N
// слів"), який про ці правила нічого не знає — а саме дописаний "про запас" хвіст найчастіше
// й містить шаблонні відкриття/кінцівки, бо це перше, до чого модель скочується без нагадування.
export const FREEFORM_PARAGRAPH_RULES = `СТРУКТУРА АБЗАЦІВ: НЕ завершуй кожен абзац узагальнюючою рефлексією на кшталт "це дало змогу зрозуміти, що...", "спостереження за цим дало змогу побачити, що...", "розуміння цього є необхідним, оскільки...", "це не є абстрактним, адже..." — така фраза наприкінці МАЙЖЕ КОЖНОГО абзацу є найпомітнішою ознакою ШІ-тексту для детекторів. Дозволено ЛИШЕ в останньому абзаці всього тексту. Усі інші абзаци завершуй конкретним фактом, дією чи деталлю без узагальнення. Вислови "дало змогу", "дало можливість" — не більше одного разу на весь текст.
ВІДКРИТТЯ АБЗАЦІВ: НЕ починай абзаци шаблоном "Під час практики...", "Протягом практики..." + дієслово на кшталт "було здійснено ознайомлення", "відбулось ознайомлення", "здійснювалось ознайомлення", "стало ознайомлення" — цей шаблон дозволено використати ЛИШЕ ОДИН РАЗ на весь текст, для решти абзаців обери інший початок: назви конкретну дію студента, факт, дату чи документ без часової прив'язки-кліше на початку речення.
BURSTINESS: щонайменше у 2-3 різних місцях тексту постав підряд 2-3 короткі речення (до 8 слів кожне) — так, ніби це різка, розмовна репліка серед довшого академічного викладу. Приклад: "Помилки тут коштують дорого. Це зрозуміло одразу. Керівник це підкреслював неодноразово." Без цих коротких речень текст читається занадто рівномірно і легко впізнається як згенерований ШІ.`;

export function buildPracticeWritingPrompt(sec, info, methodInfo, clientMaterialsSummary, citInputs, abstractsMap, establishedFacts, deptGuidanceText) {
  const {
    practiceText = "", language = "Українська", practiceGuidance,
    companyName, supervisorCompany, supervisorUniversity, individualTask,
    dateStart, dateEnd, statsPeriod, studentName,
  } = info;

  const isIntro = sec.id === "intro";
  const isConclusions = sec.id === "conclusions";
  const isFreeformMain = sec.id === "main" && !sec.sectionTitle;
  const isIndividualTask = /індивідуальн.*завданн/i.test(sec.label || "");
  // Офіційний документ від підприємства ("Довідка з підприємства", "Довідка про проходження
  // практики" тощо) — методички часто вимагають його як обов'язковий додаток, але це не
  // звичайний наративний розділ звіту: інша структура (реквізити, підпис, печатка) й інша
  // "точка зору" (текст від імені підприємства, а не особиста розповідь практиканта).
  const isReference = /^довідк|додаток.*довідк|довідк.*з\s*підприєм|довідк.*про\s*проходженн/i.test((sec.label || "").trim());

  const hint = isIntro
    ? `Вступ: мета та завдання практики, місце проходження, керівники. Обсяг не більше ${sec.pages || 2} сторінок.`
    : isConclusions
    ? `Висновки: підсумки практики, що виконано, набуті компетентності, рекомендації. Обсяг не більше ${sec.pages || 2} сторінок.`
    : isFreeformMain
    ? `Це ВЕСЬ звіт цілим текстом (без поділу на вступ, розділи чи висновки) — послідовно розкрий мету й місце проходження практики, базу практики (структура, чисельність, напрями діяльності), види робіт та завдання, до яких долучався практикант, і завершити підсумком здобутого досвіду. Суцільний текст від початку до кінця, без підзаголовків усередині.
ОБСЯГ: приблизно ${Math.round((sec.pages || 5) * 230)} слів (${sec.pages || 5} стор.). Розподіли виклад рівномірно на весь цей обсяг — не пиши підсумковий абзац ("за підсумками", "загалом", "отже" тощо), поки не розкрито ВСЕ перелічене вище на потрібну довжину. Підсумок здобутого досвіду має з'явитися ОДИН РАЗ, останнім абзацом усього тексту.
${FREEFORM_PARAGRAPH_RULES}`
    : "";

  const methodReq = methodInfo
    ? [methodInfo.theoryRequirements, methodInfo.analysisRequirements, methodInfo.otherRequirements].filter(Boolean).join(". ")
    : "";

  const secCitLines = (citInputs?.[sec.id] || "").split("\n").map(l => l.trim()).filter(Boolean);
  const sourcesBlock = secCitLines.length
    ? `\nДЖЕРЕЛА для цього розділу (${secCitLines.length} шт.) — спирайся на них при написанні, вставляй посилання [N] після відповідних тверджень:\n${secCitLines.map((l, i) => {
      const snippet = abstractsMap?.[l];
      return snippet ? `[${i + 1}] ${l}\n    Зміст: ${snippet}` : `[${i + 1}] ${l}`;
    }).join("\n")}\n`
    : "";
  const citNote = secCitLines.length
    ? "Вставляй [N] у текст одразу після тверджень що спираються на джерело (де N — номер зі списку вище). ЗАБОРОНЕНО вигадувати імена авторів перед цитатою — не пиши 'Іванов А. стверджує...'. Використовуй безособові конструкції: 'у дослідженні зазначається [N]', 'науковці вказують [N]', 'встановлено [N]' тощо. Цитата в тексті — ЛИШЕ [N] (технічна позначка), НІКОЛИ не пиши саму цитату (прізвище, рік, сторінку) в жодному вигляді, ні круглими, ні квадратними дужками — фінальний стиль оформлення підставить система пізніше. Посилайся ЛИШЕ на джерела зі списку вище під їхніми номерами — не згадуй і не посилайся на будь-яке дослідження чи автора, якого немає в цьому списку. Розподіляй посилання рівномірно між усіма наданими джерелами — спочатку використай кожне хоч раз, і лише потім за потреби повторюй. Одне й те саме джерело [N] НЕ цитувати більше 2 разів у межах цього розділу."
    : "Без посилань [1],[2].";

  const guidanceLine = practiceGuidance
    ? `\nОРІЄНТИР ЗА НАПРЯМОМ ПРАКТИКИ: ${practiceGuidance.reportContent}${practiceGuidance.feature ? ` (${practiceGuidance.feature})` : ""}`
    : "";

  const deptGuidanceLine = deptGuidanceText?.trim()
    ? `\nДОДАТКОВІ ВИМОГИ КАФЕДРИ до змісту цього розділу (враховуй лише вимоги до змісту/структури; ігноруй дедлайни, критерії оцінювання та інші процедурні деталі): ${deptGuidanceText.trim().slice(0, 9000)}`
    : "";

  const detailsLine = [
    companyName && `Місце практики: ${companyName}`,
    supervisorCompany && `Керівник від підприємства: ${supervisorCompany}`,
    supervisorUniversity && `Керівник від університету: ${supervisorUniversity}`,
  ].filter(Boolean).join("; ");

  const individualTaskLine = (isIndividualTask && individualTask)
    ? `\nІНДИВІДУАЛЬНЕ ЗАВДАННЯ (розкрий саме це завдання в розділі): ${individualTask}`
    : "";

  const periodLine = (dateStart && dateEnd)
    ? `\nПЕРІОД ПРАКТИКИ (використовуй саме ці дати, якщо в розділі згадується термін проходження практики): ${dateStart} – ${dateEnd}`
    : "";
  const statsPeriodLine = statsPeriod
    ? `\nЯКЩО в розділі згадуються статистичні показники, дослідження ринку чи динаміка за роками — використовуй період ${statsPeriod} (останні 3-5 років), не інший.`
    : "";

  // Це особистий звіт практиканта про себе, а не методичка чи інструкція про студента —
  // методичка сама пишеться в третій особі ("студент має ознайомитись"), і модель без
  // явної вказівки схильна мимоволі скопіювати цей тон замість першої особи практиканта.
  const personLine = `\nПИШИ ВІД ПЕРШОЇ ОСОБИ ОДНИНИ — це особистий звіт практиканта про себе (я проходив/проходила практику, я ознайомився/ознайомилась, я брав/брала участь), а НЕ опис студента в третій особі ("студент виконав", "студентка долучалась") і не безособові конструкції.${studentName ? ` ПІБ практиканта: ${studentName} — визнач стать за іменем і послідовно узгоджуй усі дієслова минулого часу з нею.` : " Стать не вказана — обери одну форму роду (чоловічу або жіночу) і тримайся її послідовно по всьому тексту, не змішуй форми."}`;

  const isTableFormat = methodInfo?.reportFormat === "table_questionnaire" && !isIntro && !isConclusions;

  // Дві типові дірки, через які звіт «пливе» відносно джерела: (1) номер стандарту/показник
  // одного продукту чи процесу підставляють для сусіднього, схожого — типово сировина й похідний
  // продукт мають РІЗНІ ДСТУ, а модель бачить лише один номер в матеріалах і використовує його
  // для обох; (2) коли точних цифр за роками/показниками в матеріалах немає, замість чесного
  // "даних немає" зʼявляється правдоподібна, але вигадана точна статистика — на захисті це
  // перше, що ловлять. "Правдоподібні дані" в ФОРМАТ-блоці таблиць нижче лишаються дозволені
  // для побутових деталей звіту-анкети — це саме про точні, ніби-джерельні цифри й номери.
  const factsFidelityLine = `\nТОЧНІСТЬ ФАКТІВ: якщо в матеріалах клієнта чи вже зафіксованих фактах є номер стандарту (ДСТУ/ГОСТ/ТУ), код документа/журналу чи показник з одиницею виміру — використовуй їх ТОЧНО, без округлення, заміни одиниці (хв ≠ год) чи перенесення значення з одного продукту/процесу на інший (сировина і похідний з неї продукт зазвичай регулюються РІЗНИМИ стандартами — не став один номер для обох).
Якщо для показника в динаміці за роками (дохід, прибуток, рентабельність, собівартість тощо) відомий ЛИШЕ ОДИН-ДВА орієнтири (напр. цільовий показник з індивідуального завдання чи методички), а решта значень за роками НЕВІДОМА — дозволено побудувати реалістичний узгоджений ряд значень за роками, що плавно проходить через ці відомі орієнтири (без різких стрибків), АЛЕ в тексті чи підписі таблиці ОБОВ'ЯЗКОВО познач такий ряд як орієнтовний/розрахунковий (словами "орієнтовно", "за оцінкою", "розрахунково" тощо) — НІКОЛИ не подавай ці цифри як факт із фінансової звітності підприємства, якої студент фактично не отримував.
Якщо жодного орієнтиру немає взагалі — не вигадуй псевдоточну статистику по роках; опиши узагальнено без конкретних цифр або познач, що дані потрібно уточнити на підприємстві.`;

  const repetitionLine = `\nБЕЗ ПОВТОРІВ: не повторюй дослівно (чи майже дослівно) одну й ту саму фразу, конструкцію або спосіб подачі цифри в різних місцях тексту. Якщо доводиться повернутись до вже згаданого факту, показника чи ідеї — переформулюй її іншими словами, не копіюй попереднє речення.`;

  let instruction;
  if (isReference) {
    // Офіційний документ ВІД ІМЕНІ підприємства, а не наративна розповідь практиканта —
    // структура фіксована (реквізити, текст-підтвердження, підпис/печатка), тому свій,
    // окремий промт замість загального "Напиши розділ...".
    instruction = `Склади офіційний документ "${sec.label}" для звіту з практики. Мова: ${language}.

ДАНІ ПРАКТИКИ:
${practiceText}
${detailsLine ? `\n${detailsLine}` : ""}${periodLine}

ФОРМАТ: це ОФІЦІЙНИЙ ДОКУМЕНТ від бази практики (довідка/лист-підтвердження проходження практики), а НЕ звичайний наративний розділ звіту — пиши ВІД ІМЕНІ підприємства, а не від першої особи практиканта. Типова структура: назва підприємства зверху; заголовок "ДОВІДКА" по центру; текст на кшталт "Видана [ПІБ студента], студенту(ці) [курс] курсу групи [група] [назва університету], про те, що він(вона) проходив(ла) практику на базі ${companyName || "підприємства"} у період з ${dateStart || "______"} по ${dateEnd || "______"}"; короткий перелік напрямів роботи практиканта (1-2 речення); завершується місцем під підпис: "Керівник практики від підприємства ______________________ (підпис) ______________________ (ПІБ)", рядком "М. П." і датою.
Не вигадуй код ЄДРПОУ, номер наказу чи інші офіційні реквізити, яких немає в ДАНИХ ПРАКТИКИ — залиш під них риску "______", якщо значення невідоме.
Обсяг: коротко, до ${sec.pages || 1} стор. Без markdown-заголовків (#, ##).`;
  } else if (isTableFormat) {
    // Звіт-анкета: розділ = одна або кілька заповнених таблиць, з коротким пояснювальним текстом за потреби.
    const labelWords = (sec.label || "").toLowerCase().split(/[^а-яіїєґa-z0-9]+/i).filter(w => w.length > 3);
    const matchingTables = (methodInfo?.requiredTables || []).filter(t => {
      const hay = `${t.name || ""} ${t.section || ""}`.toLowerCase();
      return labelWords.some(w => hay.includes(w));
    });
    const tablesHint = matchingTables.length
      ? `\nЗРАЗКИ ТАБЛИЦЬ З МЕТОДИЧКИ, що стосуються цього пункту (використай ЯК ЗРАЗОК структури колонок, заповни реальними даними — не копіюй заглушки):\n${matchingTables.map(t => `— ${t.name}${t.structure ? `\n  ${t.structure}` : ""}${t.instructions ? `\n  (${t.instructions})` : ""}`).join("\n")}`
      : "";

    instruction = `Склади пункт "${sec.label}" звіту-анкети з практики. Мова: ${language}.

ДАНІ ПРАКТИКИ:
${practiceText}
${detailsLine ? `\n${detailsLine}` : ""}${individualTaskLine}${periodLine}${statsPeriodLine}${personLine}
${methodReq ? `\nВИМОГИ МЕТОДИЧКИ: ${methodReq}` : ""}${deptGuidanceLine}${tablesHint}${sourcesBlock}${guidanceLine}

ФОРМАТ: ця методичка вимагає звіт-анкету — основний зміст пункту подай як одну або кілька markdown-таблиць (вертикальні риски). Якщо для розкриття пункту природно потрібно кілька таблиць (напр. окремо по рокам, або окремо структура/показники) — став їх послідовно.
Короткий пояснювальний текст (1-3 речення) до або після таблиці дозволений, якщо він допомагає ввести чи прокоментувати дані (напр. коротко пояснити методику розрахунку чи узагальнити висновок з таблиці) — але це не має перетворюватись на суцільний опис: таблиці лишаються основним способом подачі інформації, текст — лише короткий супровід.
Значення в клітинках мають бути конкретними: реальні чи правдоподібні дані про базу практики (${companyName || "підприємство"}), НЕ порожні риски "___" і НЕ плейсхолдери — так, ніби це вже заповнений студентом звіт.
Обсяг: ${matchingTables.length ? "стільки рядків, скільки в зразку" : "5-10 рядків на таблицю"}, загалом орієнтовно ${sec.pages} стор. ${citNote}
Не повторюй назву розділу як окремий рядок тексту (лише як підпис таблиці, якщо доречно).${factsFidelityLine}${repetitionLine}`;
  } else {
    instruction = `Напиши розділ "${sec.label}" звіту з практики. Мова: ${language}.

ДАНІ ПРАКТИКИ:
${practiceText}
${detailsLine ? `\n${detailsLine}` : ""}${individualTaskLine}${periodLine}${statsPeriodLine}${personLine}
${hint ? `\nОСОБЛИВОСТІ РОЗДІЛУ: ${hint}` : ""}
${methodReq ? `\nВИМОГИ МЕТОДИЧКИ: ${methodReq}` : ""}${deptGuidanceLine}${sourcesBlock}${guidanceLine}

Обсяг: приблизно ${sec.pages * 230} слів (~${sec.pages} стор.). ${citNote}
Без markdown заголовків (#, ##). Не повторюй назву розділу на початку тексту.${factsFidelityLine}${repetitionLine}`;
  }

  if (clientMaterialsSummary?.rawText) {
    instruction += `\n\nМАТЕРІАЛИ КЛІЄНТА (використовуй ці дані — не вигадуй, не замінюй, не округлюй; переписуй одиницю виміру ТОЧНО як у джерелі — ХВИЛИНИ і ГОДИНИ це РІЗНІ величини, "1 раз на 2 тижні" і "1 раз на 2 години" це РІЗНІ речі, не заміняй одне на інше):\n${clientMaterialsSummary.rawText.slice(0, 80000)}`;
  }
  // Числові факти (%, °C тощо) й коди документів/журналів (ВЛ-06 тощо), вже зафіксовані —
  // ЧАСТИНА взята прямо з оригінальних матеріалів клієнта (найвищий пріоритет джерела правди),
  // частина з інших написаних розділів цього ж звіту. Без цього кожен розділ не лише вигадує
  // власне значення показника (25% в одному розділі, 28% в іншому), а й "спотворену раз —
  // спотворену всюди" версію: досить одному розділу переплутати хвилини й години або одну
  // літеру в коді журналу, і решта розділів слухняно повторять ту саму помилку.
  if (establishedFacts?.length) {
    instruction += `\n\nВЖЕ ЗАФІКСОВАНІ ЦИФРИ Й КОДИ — якщо згадуєш той самий показник, документ чи журнал, використовуй ТОЧНО ЦІ значення: ту саму одиницю виміру (хв ≠ год) і те саме написання коду літера-в-літеру (напр. "ВЛ-06", а НЕ "ВА-06" чи "БЛ-06"). Якщо цей список суперечить твоєму припущенню — довіряй списку, не вигадуй свій варіант:\n${establishedFacts.slice(0, 40).map(f => `— ${f}`).join("\n")}`;
  }
  return instruction;
}

// ── Титулка із зразка структури звіту (коли методичка своєї не дала) ──
// "Зразок структури звіту" — це реальна ЗАВЕРШЕНА робота іншого студента (не методичка з
// вимогами), і дуже часто містить справжню заповнену титулку, тоді як методичка практики
// (робоча програма/вказівки) її може не мати взагалі. buildMethodologyReadingPrompt дивиться
// ЛИШЕ методичку, тож така титулка інакше просто губиться. Текст уже витягнутий
// (ExampleFileZone), тому це текстовий промпт, а не документ.
export function buildStructureExampleTitlePagePrompt(exampleText) {
  return `Нижче — уривок реальної завершеної роботи іншого студента (звіт з практики), а НЕ методичка з вимогами.

ТЕКСТ ЗРАЗКА:
${exampleText.slice(0, 6000)}

ТВОЄ ЗАВДАННЯ: знайти титульну сторінку цієї роботи (університет, тип роботи, тема, ПІБ студента/групи/курсу, керівник, місто-рік) і повернути ТІЛЬКИ JSON:
{"titlePageTemplate": [{"text":"...","align":"center"|"left"|"right","bold":true|false,"fontSize":null,"spaceBefore":0}] або null}

Правила:
- Це РЕАЛЬНА титулка чужої роботи з конкретним ПІБ, темою, факультетом/кафедрою, керівником — це чужі дані, їх НІКОЛИ не можна копіювати дослівно. Обов'язково заміни: ПІБ студента → [ПІБ], тему роботи → [ТЕМА], рік → [РІК] (одним рядком, не розбивай), назву факультету/інституту → [ФАКУЛЬТЕТ], назву кафедри → [КАФЕДРА], ПІБ і посаду керівника → [КЕРІВНИК], номер групи → [ГРУПА], курс → [КУРС]. Назву міністерства й університету не чіпай (вони спільні, не персональні дані).
- Тип роботи (ЗВІТ, КУРСОВА РОБОТА тощо) залиш ТОЧНО як у зразку — це не персональні дані.
- "align": "center" типово; блоки "Виконав(ла)", "Керівник" тощо — зазвичай right, якщо в зразку вони притиснуті праворуч.
- "spaceBefore" — відступ перед рядком у twips (0 для щільних блоків, 200-240 між блоками, 400-800 для помітного відступу). Подивись, ДЕ САМЕ у зразку найбільший візуальний проміжок — не завжди перед "Місто – [РІК]", буває перед блоком "Виконав" чи іншим блоком, а буває й кілька великих проміжків одразу. Постав туди, де він реально є, 1200-3200 (залежно від розміру відносно решти сторінки). Порожній рядок між блоками — {"text":"","align":"center","bold":false,"spaceBefore":0}.
- Якщо в наданому уривку титульної сторінки немає (напр. текст починається одразу зі змісту чи основної частини) — поверни {"titlePageTemplate": null}. НЕ вигадуй і не підставляй жодного прикладу за замовчуванням.`;
}

// ── Окремий файл «Титульна сторінка» з CRM (фото, PDF або текст із DOCX) — зразок чи бланк титулки ──
export function buildTitlePageFilePrompt() {
  return `Вище — окремо наданий клієнтом зразок або бланк ТИТУЛЬНОЇ СТОРІНКИ (фото, PDF або текст). Це не методичка і не вся робота — лише титулка.

ТВОЄ ЗАВДАННЯ: відтворити її структуру рядок за рядком і повернути ТІЛЬКИ JSON (без markdown):
{"titlePageTemplate": [{"text":"...","align":"center"|"left"|"right","bold":true|false,"fontSize":null,"spaceBefore":0}] або null}

Правила:
- Якщо це РЕАЛЬНА титулка чужої роботи з конкретним ПІБ, темою, факультетом, кафедрою, керівником — ці дані НЕ копіюй: замість них став токени [ПІБ], [ГРУПА], [КУРС], [ФАКУЛЬТЕТ], [КАФЕДРА], [КЕРІВНИК], [ТЕМА], [РІК], [СПЕЦІАЛЬНІСТЬ]. Якщо це порожній бланк із рисками "___" — теж став токени на місці рисок.
- Назву університету, міста, тип роботи (КУРСОВА РОБОТА, ЗВІТ тощо), назви рядків ("Виконав(ла):", "Керівник:", "з дисципліни") залиш ТОЧНО як у зразку — це не персональні дані.
- "align": "center" типово; блоки "Виконав(ла)", "Керівник" — right, якщо у зразку вони притиснуті праворуч; "bold" — як у зразку.
- "spaceBefore" — відступ перед рядком у twips (0 для щільних блоків, 200-240 між блоками, 400-800 для помітного відступу). Подивись, де саме найбільший проміжок (зазвичай між шапкою університету і назвою роботи, та перед блоком "місто — рік"), і постав відступи так, щоб титулка займала одну сторінку.
- Якщо у файлі титульної сторінки немає — поверни {"titlePageTemplate": null}.`;
}

// ── Структурний аналіз завантаженого зразка щоденника практики (офіційний бланк) ──
// На відміну від методички (яка читається як живий PDF-документ через buildMethodologyReadingPrompt),
// зразок щоденника вже витягнутий у чистий текст (ExampleFileZone) — тому це текстовий промпт,
// що аналізує ГОТОВИЙ ТЕКСТ, а не документ. Мета — визначити РЕАЛЬНУ структуру офіційного бланка
// (скільки в ньому розділів, які саме), щоб генерація й експорт щоденника її повторили, а не
// вигадували спрощену структуру "таблиця + два відгуки".
export function buildDiaryTemplateAnalysisPrompt(diaryExampleText) {
  return `Уважно проаналізуй наведений нижче текст зразка щоденника практики (це може бути офіційний бланк форми з порожніми полями для заповнення, АБО вже заповнений приклад — байдуже, аналізуй лише СТРУКТУРУ: які розділи присутні).

ТЕКСТ ЗРАЗКА ЩОДЕННИКА:
${diaryExampleText.slice(0, 40000)}

Поверни ТІЛЬКИ JSON (без markdown):
{
  "diaryTitlePageTemplate": null,
  "diaryTableFormat": null,
  "diaryTableColumns": null,
  "hasArrivalDepartureBlock": false,
  "hasBlankNotesPages": false,
  "hasCalendarGraphSection": false,
  "calendarGraphWeeksCount": null,
  "hasSupervisorSignatureBlock": false,
  "hasInspectorReviewSection": false,
  "hasGradeFields": false,
  "departmentNameForConclusion": null,
  "additionalInstructions": null
}

Правила для кожного поля:
- diaryTitlePageTemplate: якщо в тексті є титульна сторінка САМЕ щоденника (заголовок "ЩОДЕННИК ПРАКТИКИ", зазвичай з полями студента/інституту/кафедри/ОКР/спеціальності знизу і, можливо, блоком погодження "ЗАТВЕРДЖУЮ" зверху) — відтвори її рядок за рядком як масив об'єктів {"text":"...","align":"left|center|right","bold":true|false,"fontSize":14,"spaceBefore":0}. Місця, куди студент вписує СВОЇ дані, заміни на плейсхолдери: ПІБ здобувача → [ПІБ], номер академічної групи → [ГРУПА], курс навчання → [КУРС], назва інституту/факультету → [ФАКУЛЬТЕТ], назва кафедри → [КАФЕДРА], ОКР/ступінь → [ОКР], спеціальність → [СПЕЦІАЛЬНІСТЬ], галузь знань → [ГАЛУЗЬ_ЗНАНЬ], вид і назва практики → [ВИД_ПРАКТИКИ]. Текст навколо (написи-підказки на кшталт "(прізвище, ім'я, по батькові)", назву закладу освіти якщо вона вже надрукована в бланку) залиш як є. null якщо титульної сторінки щоденника в тексті немає.
- diaryTableFormat: "daily" — якщо основна таблиця щоденника по РОБОЧИХ ДНЯХ (рядок = один день з датою). "topics" — якщо рядок = тема/етап роботи з термінами виконання (як "індивідуальний план"). "weekly" — якщо рядок = тиждень практики. null якщо жодної такої таблиці в тексті немає (напр. є тільки календарний графік і ліновані сторінки — це НЕ те саме, дивись hasCalendarGraphSection і hasBlankNotesPages нижче).
- diaryTableColumns: масив заголовків колонок ТОЧНО як у знайденій основній таблиці (по порядку зліва направо). null якщо diaryTableFormat null.
- hasArrivalDepartureBlock: true ТІЛЬКИ якщо є блок на кшталт "Прибув на підприємство... Вибув з підприємства..." з місцем під печатку (МП) і дату. Інакше false.
- hasBlankNotesPages: true ТІЛЬКИ якщо є окрема сторінка(и) із заголовком на кшталт "Робочі записи під час практики", де під заголовком просто ПОРОЖНІ ліновані рядки без жодної таблиці з колонками. Якщо це вже таблиця з колонками (дата/зміст роботи) — це НЕ hasBlankNotesPages, а diaryTableFormat="daily" вище. Інакше false.
- hasCalendarGraphSection: true ТІЛЬКИ якщо є ОКРЕМА від щоденних записів таблиця "Календарний графік проходження практики" — рядок = назва роботи/етапу, колонки = тижні практики (з відмітками про виконання), яка йде РАЗОМ з (а не замість) робочих записів/основної таблиці. Інакше false.
- calendarGraphWeeksCount: кількість тижневих колонок у календарному графіку, якщо hasCalendarGraphSection true (напр. 4, 6). null якщо hasCalendarGraphSection false або кількість не видно.
- hasSupervisorSignatureBlock: true якщо одразу після календарного графіка (чи після основної таблиці) є окремий блок підписів "Керівники практики: від кафедри .../ від підприємства ..." (без відгуку по суті — просто підписи). Інакше false.
- hasInspectorReviewSection: true ТІЛЬКИ якщо є ОКРЕМИЙ розділ на кшталт "Відгук осіб, які перевіряли проходження практики" — відмінний від відгуку керівника від підприємства і від висновку керівника від кафедри. Інакше false.
- hasGradeFields: true ТІЛЬКИ якщо у розділі "Висновок керівника практики" (чи аналогічному) є поля оцінювання: дата складання заліку та/або оцінка за національною шкалою/кількість балів/шкала ECTS. Інакше false.
- departmentNameForConclusion: якщо в тексті десь прямо вказана назва кафедри разом із закладом освіти для підпису керівника практики (напр. "від кафедри ОПЦБ «Криворізький національний університет»") — витягни цей фрагмент дослівно для використання в заголовку розділу "Висновок керівника практики від [...]". null якщо не вказано.
- additionalInstructions: якщо в тексті є будь-які вказівки, доручення чи зауваження керівника практики/кафедри, що НЕ є частиною самої таблиці записів чи стандартних розділів бланку (наприклад: "додатково виконати...", "доопрацювати...", окремі приписки чи абзаци з конкретними завданнями поза графіком) — витягни їх дослівно одним текстом. null якщо в тексті немає нічого, крім стандартної структури щоденника.

Якщо в наданому тексті взагалі не видно жодної чіткої структури щоденника (напр. це нерозбірливий фрагмент без заголовків розділів) — постав всі boolean-поля false, а решту null, замість вигадування.`;
}

export function buildPracticeDiaryPrompt(info, diaryExampleText, methodInfo, deptGuidanceText, diaryTemplateInfo, clientMaterialsText, reportSections, reportText) {
  const {
    practiceText = "", language = "Українська", practiceGuidance,
    companyName, individualTask, dateStart, dateEnd, statsPeriod,
  } = info;
  const taskGuidance = practiceGuidance?.diaryTasks
    ? `\nТипові завдання для цього напряму та виду практики (орієнтуйся на них): ${practiceGuidance.diaryTasks}`
    : "";
  const periodLine = (dateStart && dateEnd)
    ? `\nПЕРІОД ПРАКТИКИ (використовуй саме ці дати): ${dateStart} – ${dateEnd}`
    : "";
  const statsPeriodLine = statsPeriod
    ? `\nЯКЩО в записах згадуєш аналіз даних/звітності підприємства за роками — використовуй період ${statsPeriod}, не інший.`
    : "";
  const detailsLine = [
    companyName && `Місце практики: ${companyName}`,
    individualTask && `Індивідуальне завдання: ${individualTask}`,
  ].filter(Boolean).join("; ");
  const sampleBlock = diaryExampleText
    ? `\n\nЗРАЗОК ЩОДЕННИКА (орієнтуйся на цей формат записів, структуру таблиці і рівень деталізації, адаптувавши зміст під дані практики нижче):\n${diaryExampleText}`
    : "";
  const deptGuidanceLine = deptGuidanceText?.trim()
    ? `\nДОДАТКОВІ ВИМОГИ КАФЕДРИ до щоденника (враховуй лише вимоги до змісту записів; ігноруй дедлайни, критерії оцінювання та інші процедурні деталі): ${deptGuidanceText.trim().slice(0, 9000)}`
    : "";
  // Матеріали клієнта (напр. окремі оголошення викладача з конкретними завданнями) раніше сюди
  // взагалі не потрапляли — щоденник бачив лише practiceText, тому будь-яке завдання, надіслане
  // окремим файлом чи вставлене в поле "Матеріали клієнта", а не в основний текст практики,
  // мовчки губилося.
  const clientMaterialsLine = clientMaterialsText?.trim()
    ? `\n\nМАТЕРІАЛИ КЛІЄНТА (оголошення, завдання, листування — КОЖЕН пункт/завдання звідси, що стосується роботи студента під час практики, має явно з'явитися як окремий запис у щоденнику; не пропускай жодного пункту):\n${clientMaterialsText.trim().slice(0, 20000)}`
    : "";
  // Додаткові вказівки, знайдені при структурному аналізі зразка щоденника (поза самою таблицею —
  // напр. приписка керівника "додатково зробити Х"). Без цього блоку sampleBlock нижче подавав
  // такий текст лише як приклад "формату й рівня деталізації", і модель могла його проігнорувати
  // як контент, що не стосується задачі.
  const diaryAdditionalInstructionsLine = diaryTemplateInfo?.additionalInstructions?.trim()
    ? `\n\nДОДАТКОВІ ВКАЗІВКИ, ЗНАЙДЕНІ В ЗАВАНТАЖЕНОМУ ЩОДЕННИКУ (поза стандартною структурою бланку — КОЖЕН пункт має явно з'явитися як окремий запис у згенерованому щоденнику; не пропускай жодного): ${diaryTemplateInfo.additionalInstructions.trim().slice(0, 5000)}`
    : "";
  // Структура звіту (якщо вже сформована на попередньому кроці) — щоб щоденник не «жив своїм
  // життям» окремо від звіту: кожен розділ, який студент фактично писатиме, має мати відповідний
  // день чи запис у щоденнику, що це підтверджує.
  const reportSectionsLine = reportSections?.length
    ? `\n\nСТРУКТУРА ЗВІТУ (уже визначена окремо) — переконайся, що для КОЖНОГО з цих пунктів є хоча б один відповідний запис у щоденнику, який показує, що студент над ним працював:\n${reportSections.map(s => `— ${s.label || s}`).join("\n")}`
    : "";
  // Уже написаний текст звіту — щоб щоденник не вигадував свої власні цифри, назви сировини,
  // обладнання чи процесів там, де звіт уже описав їх конкретно (напр. концентрація в одному
  // розділі і трубопровідна сировина в іншому мають лишатись тими самими фактами в щоденнику).
  const reportTextLine = reportText?.trim()
    ? `\n\nТЕКСТ ЗВІТУ (уже написаний) — це джерело фактів для щоденника. Якщо в щоденнику згадуєш ті самі показники, сировину, обладнання чи процеси, що й тут, використовуй ТІ Ж САМІ конкретні значення й назви — ту саму одиницю виміру (хв ≠ год, "1 раз на 2 тижні" ≠ "1 раз на 2 години") і те саме написання кодів документів/журналів літера-в-літеру (напр. "ВЛ-06", а НЕ "ВА-06" чи "БЛ-06") — не вигадуй інші:\n${reportText.trim().slice(0, 15000)}`
    : "";

  // Пріоритет формату таблиці: СТРУКТУРНИЙ аналіз завантаженого зразка (найнадійніший — колонки
  // визначені окремим проходом, а не вгадуються тут наосліп із сирого тексту) > формат, розпізнаний
  // з методички > вгадування прямо з сирого тексту зразка (фолбек, якщо структурний аналіз не дав
  // diaryTableFormat) > типовий по днях.
  const templateFormat = diaryTemplateInfo?.diaryTableFormat || null;
  const templateColumns = templateFormat && diaryTemplateInfo?.diaryTableColumns?.length ? diaryTemplateInfo.diaryTableColumns : null;
  const methodFormat = !diaryExampleText ? methodInfo?.diaryTableFormat : null;
  const methodColumns = methodFormat && methodInfo?.diaryTableColumns?.length ? methodInfo.diaryTableColumns : null;

  // Точний перелік робочих дат (без суботи/неділі та державних свят України) рахуємо кодом —
  // раніше це доручалося ШІ ("склади по робочих днях, визнач дати сам"), і воно іноді помилково
  // ставило записи на вихідні чи свята (напр. 24 серпня). Коли період відомий — ШІ лише заповнює
  // зміст по вже готових датах, а не рахує дні тижня/свята самостійно.
  const workingDates = (dateStart && dateEnd) ? getWorkingDatesInRange(dateStart, dateEnd) : [];
  const workingDatesInstruction = workingDates.length
    ? `Використай РІВНО ці дати — по одному рядку на кожну, у цьому самому порядку, без жодних інших дат (вихідні дні та державні свята України вже виключено кодом, нічого не додавай і не пропускай від себе):
${workingDates.join(", ")}`
    : `Склади таблицю по робочих днях (понеділок–п'ятниця) у межах вказаних дат${periodLine ? "" : " (визнач дати з тексту вище)"}. Кожен день — окремий рядок. Не став записи на суботу, неділю чи державні свята України.`;

  let dayInstruction;
  let tableInstruction;
  if (templateFormat === "topics") {
    const cols = templateColumns || ["Завдання за планом", "Термін виконання", "Фактичне виконання", "Підписи керівника та керівника від кафедри"];
    dayInstruction = `Зразок щоденника вимагає формат "індивідуальний план за темами завдань", а НЕ по календарних днях. Склади рядки за темами/етапами роботи практики в логічному порядку виконання (кожен рядок — окрема тема чи етап).`;
    tableInstruction = `Поверни ТІЛЬКИ markdown-таблицю з колонками: ${cols.map(c => `"${c}"`).join(", ")}. Колонки термінів/підписів залиш порожніми (заповнюються вручну після проходження практики).`;
  } else if (templateFormat === "weekly") {
    const cols = templateColumns || ["Назви (теми) робіт", "Тиждень 1", "Тиждень 2", "Тиждень 3", "Тиждень 4", "Оцінка", "Відмітки про виконання"];
    dayInstruction = `Зразок щоденника вимагає формат "календарний графік по тижнях", а НЕ по календарних днях. Склади рядки за темами/видами робіт практики.`;
    tableInstruction = `Поверни ТІЛЬКИ markdown-таблицю з колонками: ${cols.map(c => `"${c}"`).join(", ")}. Тижневі колонки та колонки оцінки/відміток залиш порожніми (заповнюються вручну).`;
  } else if (templateFormat === "daily" && templateColumns) {
    dayInstruction = `${workingDatesInstruction}
Зміст роботи має бути конкретним і відповідати профілю підприємства та типу практики.
В останні 2-3 дні включи: оформлення звіту, перевірку документів.`;
    tableInstruction = `Поверни ТІЛЬКИ markdown-таблицю з колонками: ${templateColumns.map(c => `"${c}"`).join(", ")} — це ТОЧНІ колонки зі зразка щоденника, не змінюй їх.`;
  } else if (diaryExampleText) {
    dayInstruction = `${workingDatesInstruction}
Зміст роботи має бути конкретним і відповідати профілю підприємства та типу практики.
В останні 2-3 дні включи: оформлення звіту, перевірку документів.`;
    tableInstruction = "Поверни ТІЛЬКИ markdown-таблицю з ТИМИ Ж стовпцями (назви, кількість і порядок), що й у ЗРАЗКУ ЩОДЕННИКА вище. Не додавай, не забирай і не перейменовуй стовпці зразка.";
  } else if (methodFormat === "topics") {
    const cols = methodColumns || ["Завдання за планом", "Термін виконання", "Фактичне виконання", "Підписи керівника та керівника від кафедри"];
    dayInstruction = `Методичка вимагає щоденник у форматі "індивідуальний план за темами завдань", а НЕ по календарних днях. Склади рядки за темами/етапами роботи практики в логічному порядку виконання (кожен рядок — окрема тема чи етап).`;
    tableInstruction = `Поверни ТІЛЬКИ markdown-таблицю з колонками: ${cols.map(c => `"${c}"`).join(", ")}. Колонки термінів/підписів залиш порожніми (заповнюються вручну після проходження практики).`;
  } else if (methodFormat === "weekly") {
    const cols = methodColumns || ["Назви (теми) робіт", "Тиждень 1", "Тиждень 2", "Тиждень 3", "Тиждень 4", "Оцінка", "Відмітки про виконання"];
    dayInstruction = `Методичка вимагає щоденник у форматі "календарний графік по тижнях", а НЕ по календарних днях. Склади рядки за темами/видами робіт практики.`;
    tableInstruction = `Поверни ТІЛЬКИ markdown-таблицю з колонками: ${cols.map(c => `"${c}"`).join(", ")}. Тижневі колонки та колонки оцінки/відміток залиш порожніми (заповнюються вручну).`;
  } else {
    dayInstruction = `${workingDatesInstruction}
Зміст роботи має бути конкретним і відповідати профілю підприємства та типу практики.
В останні 2-3 дні включи: оформлення звіту, перевірку документів.`;
    tableInstruction = `Поверни ТІЛЬКИ markdown-таблицю:
| Дата | Зміст виконаної роботи | Підпис керівника |
|------|------------------------|-----------------|
| дд.мм.рррр | ... | |`;
  }

  // Календарний графік (форма Н-6.03) — ОКРЕМА таблиця по тижнях, яка в бланку щоденника йде
  // ДОДАТКОВО до основної таблиці записів (не замінює її). Просимо повернути її окремим блоком за
  // явним маркером-роздільником, щоб код (не ШІ) потім детерміновано відокремив цю таблицю від
  // основного тексту щоденника при експорті — замість вгадування меж таблиці по заголовках.
  const weeksCountForGraph = Math.max(1, Math.min(12, diaryTemplateInfo?.calendarGraphWeeksCount || 6));
  const calendarGraphInstruction = diaryTemplateInfo?.hasCalendarGraphSection
    ? `\n\nДОДАТКОВО, ПІСЛЯ основної таблиці, виведи ще один блок — календарний графік проходження практики по тижнях. Формат СУВОРО такий:
1) окремий рядок ТОЧНО "%%CALENDAR_GRAPH%%" (більше нічого на цьому рядку);
2) одразу під ним markdown-таблиця з колонками: "Назви робіт", ${Array.from({ length: weeksCountForGraph }, (_, i) => `"Тиждень ${i + 1}"`).join(", ")}, "Відмітки про виконання".
Рядки таблиці — узагальнені теми/види робіт практики (5-10 рядків, НЕ по днях, а по темах, що логічно й послідовно охоплюють весь період практики). У клітинці того тижня (тижнів), коли ця робота фактично виконувалась, вкажи конкретні дати в межах періоду практики (напр. "12.03–14.03" або "12.03, 14.03"); в інших тижневих клітинках цього ж рядка залиш клітинку порожньою (просто не пиши нічого між "|"). Дати вказуй ЛИШЕ робочі дні — ніколи суботу, неділю чи державні свята України (напр. 24 серпня). У колонці "Відмітки про виконання" для кожного рядка постав "Виконано".`
    : "";

  return `Склади щоденник практики у вигляді таблиці на основі наданих даних.
Мова: ${language}.

ДАНІ ПРАКТИКИ:
${practiceText}
${periodLine}${statsPeriodLine}
${detailsLine ? `\n${detailsLine}` : ""}
${taskGuidance}${deptGuidanceLine}${clientMaterialsLine}${diaryAdditionalInstructionsLine}${reportSectionsLine}${reportTextLine}
${sampleBlock}

${dayInstruction}

${tableInstruction}${calendarGraphInstruction}`;
}

export function buildPracticeDetailsPrompt(practiceText, comment) {
  return `Проаналізуй дані про практику нижче і витягни конкретні деталі.

ТЕКСТ:
${practiceText}
${comment ? `\nДОДАТКОВІ МАТЕРІАЛИ КЛІЄНТА:\n${comment}` : ""}

Поверни ТІЛЬКИ JSON (без markdown):
{"companyName":"","supervisorCompany":"","supervisorUniversity":"","individualTask":"","dateStart":"","dateEnd":"","sourceCount":null,"studentName":"","studentGroup":"","university":"","faculty":"","department":"","specialty":"","degreeLevel":"","knowledgeField":"","city":""}

Правила:
- department: назва кафедри, яка курує практику. "" якщо не вказано явно.
- specialty: спеціальність студента так, як вона названа в тексті — номер і назва разом (напр. "263 Цивільна безпека"). "" якщо не вказано явно.
- degreeLevel: освітньо-кваліфікаційний рівень/ступінь (напр. "Бакалавр", "Магістр"). "" якщо не вказано явно.
- knowledgeField: галузь знань, ЯКЩО названа окремо від спеціальності (напр. "26 Цивільна безпека"). "" якщо не вказано явно.
- companyName: назва підприємства/установи/закладу, де проходить практика. "" якщо не вказано.
- supervisorCompany: ПІБ та посада керівника ВІД ПІДПРИЄМСТВА/БАЗИ ПРАКТИКИ — це працівник саме цього підприємства (наприклад завідувач лабораторії, начальник цеху, інженер-технолог), знайдений у документах підприємства (карта контролю, наказ, відгук від бази практики). НІКОЛИ не бери сюди завідувача кафедри, декана, проректора чи іншу посаду університету/факультету, навіть якщо поруч із їхнім ПІБ трапляється слово "керівник" (напр. вони "затверджують програму практики" як представники університету — це supervisorUniversity, а не supervisorCompany). Якщо в тексті явно не вказано ПІБ саме працівника підприємства — "" (не підставляй сюди університетську посаду за замовчуванням).
- supervisorUniversity: ПІБ та посада керівника від університету/кафедри (може збігатися із завідувачем кафедри, що затверджує програму практики). "" якщо не вказано.
- individualTask: текст індивідуального завдання, якщо воно наведене як текст (не плутай із темою роботи). "" якщо не вказано.
- dateStart, dateEnd: дати початку і закінчення практики у форматі "дд.мм.рррр". "" якщо не вказано.
- sourceCount: кількість джерел літератури, ЯКЩО явно вказана в тексті або коментарі (наприклад "джерел: 20-25", "не менше 15 джерел", "список літератури 25 позицій"). Рядок як у тексті (наприклад "20-25" або "15"). null якщо явно не вказано — НЕ вигадуй і не став дефолтне значення.
- studentName: ПІБ студента, який проходить практику. "" якщо не вказано.
- studentGroup: ТІЛЬКИ номер/шифр групи студента, БЕЗ курсу (наприклад "ФБС-31" або "1") — курс визначається окремо, не дублюй його тут. "" якщо не вказано.
- university: повна назва університету/закладу вищої освіти для титульної сторінки. "" якщо не вказано.
- faculty: назва факультету або кафедри. "" якщо не вказано.
- city: місто для титульної сторінки (напр. "Київ"). "" якщо не вказано.`;
}

// ── Застосування одного виправлення до фрагменту тексту файлу ──
// ── Виправлення кількох зауважень викладача за один виклик (Варіант Б) ──
export function buildFileApplyCorrectionBatchPrompt({ documentText, tasks }) {
  const tasksBlock = tasks.map((t, i) => `--- Завдання ${i} ---
ЧАСТИНА ЯКА ПОТРЕБУЄ ВИПРАВЛЕННЯ: "${t.location}"
ПРОБЛЕМА: ${t.issue}
ЩО ВИПРАВИТИ: ${t.suggestion}${t.extraContext || ""}`).join("\n\n");

  return `Ти виправляєш кілька частин академічної роботи відповідно до зауважень викладача, за один прохід.

ПОВНИЙ ТЕКСТ РОБОТИ:
${documentText}

ЗАВДАННЯ (кожне — окреме зауваження; обробляй незалежно, вони не пов'язані одне з одним):
${tasksBlock}

Для кожного завдання знайди у тексті роботи фрагмент, який потребує виправлення, і виправ його.

Якщо для якогось завдання бракує даних, яких ти не можеш ні знати, ні перевірити (наприклад точний факт, дата, сторінка джерела, номер) — НЕ вигадуй значення. Постав для нього статус needs_review з коротким поясненням.

Поверни ТІЛЬКИ JSON-масив (без markdown), РІВНО по одному об'єкту на кожне завдання зі списку вище, у тому самому порядку — "index" відповідає номеру завдання (0, 1, 2...):
[{"index":0,"status":"fixed","original":"точний фрагмент з ПОТОЧНОГО тексту роботи який треба замінити (від кількох речень до кількох абзаців), без змін","replacement":"виправлений варіант цього фрагменту"}]
Для needs_review замість "original"/"replacement": {"index":1,"status":"needs_review","note":"коротко, чому неможливо виправити автоматично"}

Правила:
- "original" — дослівна цитата з тексту роботи вище, без змін
- "replacement" — виправлений варіант, зберігаючи стиль і мову оригіналу
- Завдання незалежні одне від одного — заміни різних завдань не повинні перетинатись фрагментами
- Якщо "original" чи "replacement" містять символ лапок " — обов'язково екрануй його зворотним слешем всередині JSON-рядка, інакше весь масив не розпарситься
- НЕ повертай весь документ і нічого поза JSON-масивом`;
}

// ── Зауваження, що стосується ВСЬОГО документа (напр. "так має бути по всій
// роботі"), а не лише одного позначеного місця — один виклик ШІ на весь текст
// роботи, що сам знаходить КОЖНЕ відповідне місце й повертає список замін,
// за тим самим принципом, що вже працює для перебудови списку джерел. ──
export function buildDocumentWideCorrectionPrompt({ documentText, task }) {
  const noteText = task.instruction || task.noteText || [task.issue, task.suggestion].filter(Boolean).join(" ");
  return `Ти виправляєш академічну роботу за зауваженням керівника, яке явно стосується ВСЬОГО документа, а не лише одного місця (наприклад "так має бути по всій роботі", "виправ це скрізь").

ПОВНИЙ ТЕКСТ РОБОТИ:
${documentText}

ЗАУВАЖЕННЯ КЕРІВНИКА (стосується КОЖНОГО відповідного місця в тексті, не тільки одного):
${noteText}
${task.annotatedText ? `\nКОНКРЕТНЕ МІСЦЕ, ДЕ ЗАУВАЖЕННЯ БУЛО ЗАЛИШЕНО (для прикладу, але не єдине, яке треба виправити): "${task.annotatedText}"` : ""}

Знайди в тексті роботи УСІ місця, які підпадають під це зауваження, і виправ кожне з них послідовно й однаково.

Поверни ТІЛЬКИ JSON-масив (без markdown) — по одному об'єкту на КОЖНЕ знайдене місце:
[{"original":"точна дослівна цитата з тексту роботи вище, яку треба замінити","replacement":"виправлений варіант цього місця"}]

Правила:
- "original" — дослівна цитата з тексту роботи, без змін
- Заміни різних елементів масиву НЕ повинні перетинатись фрагментами
- Якщо для якогось конкретного місця незрозуміло, чи воно справді підпадає під зауваження — краще пропустити його, ніж змінити помилково
- Якщо відповідних місць у тексті не знайдено взагалі — поверни порожній масив []
- Якщо "original" чи "replacement" містять символ лапок " — обов'язково екрануй його зворотним слешем всередині JSON-рядка, інакше весь масив не розпарситься
- НЕ повертай весь документ і нічого поза JSON-масивом`;
}

// ── Адаптація ВСІЄЇ роботи під інший контекст (напр. "переробити під ЗДО, а не
// школу"): кодовий цикл по абзацах, а не пошук окремих фрагментів. ──
export function buildAdaptationStemsPrompt({ instruction }) {
  return `Керівник просить переробити академічну роботу під інший контекст:
"${instruction}"

Визнач, які слова й терміни СТАРОГО контексту (того, що треба прибрати) можуть траплятись у тексті. Поверни їхні КОРЕНІ (без закінчень, малими літерами, 3–8 символів кожен), щоб код міг знайти всі згадки regex-ом. Приклад для "під ЗДО, а не школу": ["школ","учн","клас","урок","вчител","шкільн"]. Не включай слова нового контексту й надто загальні корені.

Поверни ТІЛЬКИ JSON: {"stems":["...","..."]}`;
}

export function buildAdaptationChunkPrompt({ instruction, paragraphs, recheckStems = null }) {
  const list = paragraphs.map(p => `[${p.i}]${p.inTable ? " (комірка таблиці)" : ""} ${p.text}`).join("\n");
  return `Ти переробляєш академічну роботу за вказівкою керівника, яка стосується ВСІЄЇ роботи:
"${instruction}"

Нижче — пронумеровані абзаци (номер у квадратних дужках — лише мітка, не частина тексту). Для КОЖНОГО абзацу вирішуй окремо: чи є в ньому щось, що прив'язане до старого контексту (слова, приклади, ситуації, ролі, терміни, описані практики, порівняння) і що треба переробити під новий. Якщо так — перепиши абзац повністю під новий контекст: не лише заміни слова, а й приклади, ситуації, методи і термінологію, щоб текст читався так, ніби від початку писався для нового контексту.${recheckStems ? `\nУ цих абзацах ще трапляються слова старого контексту (${recheckStems.join(", ")}). Виправ їх, якщо вони стосуються старого контексту. Якщо вживання доречне (назва закону чи джерела, пряма цитата, свідоме порівняння з іншим рівнем освіти) — абзац не повертай.` : ""}

АБЗАЦИ:
${list}

Поверни ТІЛЬКИ JSON-масив (без markdown) — лише для абзаців, які ти змінив:
[{"i":номер,"text":"новий текст абзацу"}]
Якщо змінювати нічого не треба — поверни [].

Правила:
- "text" — ОДИН абзац: без переносів рядків, без markdown (без **, #, | тощо), без нумерації, якої не було
- Комірки таблиці перероби як звичайний текст комірки, не додавай ні розділювачів "|", ні заголовків
- Збережи мову, науковий стиль, логіку викладу й приблизний обсяг абзацу (±20%)
- Посилання на джерела [N], [N, с. X] лиши БЕЗ ЗМІН і в тих самих місцях; не вигадуй нових посилань і фактів
- Не змінюй абзаци, яких зміна не стосується; назви законів, документів, джерел і власні назви не перекручуй
- Якщо "text" містить лапки " — екрануй їх зворотним слешем у JSON
- НЕ повертай нічого поза JSON-масивом`;
}
