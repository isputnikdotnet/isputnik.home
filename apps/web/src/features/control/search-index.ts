import { ALL_TABS, sectionEyebrow, sectionHref, tabLabel } from "./nav";
import type { ControlSection } from "../../router";
// Plain module-level data, not a component — see nav.ts's note on the same pattern.
import i18n from "../../i18n";

// What the control-panel search can find. Two kinds of entry:
//
//   * one per tab, generated from CONTROL_GROUPS — so every page is reachable
//     by its own name without anyone maintaining a second list;
//   * named settings that live *inside* a page (SMTP host, lockout threshold,
//     thumbnail path…). These are the reason search exists: they used to be
//     three levels down with no way to find them but to remember where they were.
//
// `keywords` carries the words someone would actually type — the old name of a
// thing, the acronym, the unit — not a restatement of the title. They are plain,
// UNTRANSLATED match tokens (never shown on screen) rather than i18next keys:
// each entry below is a fixed English list PLUS a fixed Russian list, concatenated
// once here, so typing either language finds the setting regardless of which
// language the UI is currently displayed in.
//
// `title`/`breadcrumb`/`href`, unlike `keywords`, DO reach the screen and must
// stay in the active language — they're built by getControlSearchEntries() below
// rather than frozen at module load, so a language switch is picked up instead
// of freezing whatever was active at import time (see docs/i18n-plan.md's
// namespace-key typing pitfall about module-level lookups needing to be
// functions, not consts, to stay reactive).

export interface ControlSearchEntry {
  /** Stable id, so React keys survive re-filtering. */
  id: string;
  title: string;
  /** Shown under the title: "Settings › Email". */
  breadcrumb: string;
  href: string;
  section: ControlSection;
  keywords: string;
}

// Extra search terms for the tab pages themselves — English, then the Russian
// equivalent of the same words, concatenated.
const TAB_KEYWORDS: Partial<Record<ControlSection, string>> = {
  // Sign-ins' own terms are folded in here: it is the Dashboard's opening view,
  // so a search for "revoke session" or "blocked scanner" has to land on it.
  dashboard: "sign-ins sign-in details login analytics drill down dive connection ip address country city user person failed attempts blocked scanner probes guessed names sessions devices displays phones tablets computers signed in until expires registered revoke sign out logout tokens linked tv display " +
    "system health cpu memory uptime version disk free space database sqlite activity trends charts graphs logins uploads downloads deletes played read viewed in progress playback reading libraries statistics stats numbers counts totals audiobook ebook gallery top authors narrators formats storage " +
    "вход входы подробности аналитика адрес ip страна город пользователь человек неудачные попытки заблокирован сканер зондирование предполагаемые имена сессии устройства экраны телефоны планшеты компьютеры истекает зарегистрирован отозвать выйти выход токены привязанный тв дисплей " +
    "система здоровье процессор память время работы версия диск свободное место база данных активность тренды графики диаграммы входы загрузки скачивания удаления прослушано прочитано просмотрено в процессе воспроизведение чтение библиотеки статистика цифры количество всего аудиокнига электронная книга галерея топ авторы чтецы форматы хранилище",
  logs: "activity audit trail events sign-in history retention prune clear " +
    "активность аудит журнал события история входов хранение очистка удалить",

  libraries: "add library scan sources folders paths extensions uploads access members wizard rescan " +
    "добавить библиотеку сканирование источники папки пути расширения загрузки доступ участники мастер пересканировать",
  storage: "thumbnails cache path containers approved folders disk location recycle bin trash folder " +
    "миниатюры кэш путь контейнеры разрешённые папки диск расположение корзина папка",
  categories: "genres genre keywords mapping icons images taxonomy " +
    "жанры жанр ключевые слова сопоставление значки изображения таксономия",
  tags: "labels rename merge taxonomy " +
    "метки переименовать объединить таксономия",

  users: "accounts people roles admin member password reset disable remove remote device link window allow outside away travel " +
    "аккаунты люди роли администратор участник пароль сброс отключить удалить удалённо привязка устройства окно разрешить снаружи вдали путешествие",
  groups: "shared access group membership permissions " +
    "общий доступ группа членство разрешения",
  invites: "invite signup sign-up registration link token new account " +
    "приглашение регистрация ссылка токен новый аккаунт",

  security: "posture summary proxy hops addresses trust client ip mode overview " +
    "состояние сводка прокси хопы адреса доверие клиент ip режим обзор",
  securityPolicies:
    "lockout brute force threshold attempts password minimum length complexity sign-in alerts email abuseipdb reputation abuse score threat intelligence read only readonly delete trusted network protect deletions " +
    "блокировка перебор порог попытки пароль минимальная длина сложность оповещения о входе почта репутация угрозы только чтение удаление доверенная сеть защита удалений",
  securityTrusted: "cidr subnet allowlist lan home network exempt whitelist " +
    "подсеть белый список локальная сеть домашняя сеть исключение",
  securityBlocked:
    "banned ip block unblock auto-block ban permanent never expires forever make permanent reputation abuseipdb abuse score check " +
    "заблокированный ip блокировка разблокировать автоблокировка бан навсегда никогда не истекает сделать постоянным репутация проверка",

  backup: "restore zip archive download snapshot schedule retention export " +
    "восстановить архив скачать снимок расписание хранение экспорт резервная копия",
  scheduledJobs: "cron schedule nightly automatic recurring timer " +
    "расписание ночное автоматическое повторяющееся таймер задания",
  recycleBin: "trash deleted restore purge retention undelete how long keep days cleanup expiry location folder path custom bin " +
    "корзина удалено восстановить очистить хранение сколько дней очистка истечение расположение папка путь",
  quotes: "quotes quote of the day import pack json wikiquote widget home card sayings " +
    "categories delete import undo bulk famous family",
  missingPhotos: "gallery missing gone offline broken files photos videos " +
    "галерея пропавшие исчезли недоступно повреждённые файлы фото видео утерянные",
  // Short labels now that they are views of Duplicates, so the words someone would
  // actually type have to be here — "duplicate photos" is no longer in the title.
  duplicateCleanup: "duplicate cleanup job wizard clean up duplicates saved job resume come back later owner one at a time keep clean folder rules review delete copies reclaim space scan libraries duplicate photos duplicate folders copies identical phash near-identical free space imported twice same folder twice keep photos in preferred folder already stored elsewhere contained copied into itself overlapping shared some photos partial copy " +
    "дубликаты очистка задание мастер продолжить позже владелец по одному правила папок проверка удалить копии освободить место сканирование библиотеки дубликаты фото дубликаты папок одинаковые почти одинаковые свободное место импортировано дважды",

  appearance: "theme default look colours colors dark light branding " +
    "тема по умолчанию вид цвета тёмная светлая брендинг",
  email: "smtp mail relay server port tls starttls password sender from test " +
    "почта сервер порт пароль отправитель тест письмо",
  notifications: "notify email alerts members shared with me sharing switch on off opt in " +
    "уведомления почта оповещения участники поделились со мной включить выключить",
  readerAccess: "opds catalog token koreader thorium moon+ reader ereader e-reader basic auth device " +
    "каталог токен читалка электронная книга устройство",
  about: "version credits licences licenses changelog release notes what's new " +
    "версия авторы лицензии список изменений заметки о выпуске что нового"
};

// Every setting entry's title, as the `control:search.settings.*` key suffix
// that names it — a literal union so the template-literal t() call below
// type-checks (docs/i18n-plan.md's namespace-key typing pitfall #4).
type SettingKey =
  | "systemHealth" | "libraryStatistics" | "tasks" | "activity" | "locationsMap"
  | "logRetention" | "thumbnailStorage" | "libraryContainers" | "scanSources"
  | "libraryAccessMembers" | "accountLockout" | "ipAutoBlock" | "passwordPolicy"
  | "newSignInAlerts" | "twoFactorSignIn" | "linkingDevices" | "ipReputation"
  | "deletionProtection" | "addTrustedNetwork" | "scheduledBackups" | "defaultTheme"
  | "smtpServer" | "sendTestEmail" | "opdsReaderTokens" | "twoFactorAlertsDelivery"
  | "shareNotifications" | "recordingsLibrary" | "mapRouting";

// Settings that live inside a page. `section` is where they are; search takes
// you to that tab and the setting is on it.
// `query` lands inside a page that keeps views in its query string (the
// Dashboard's tabs), so a search hit opens the right view, not the page's first.
const SETTING_ENTRIES: { titleKey: SettingKey; section: ControlSection; keywords: string; query?: string }[] = [
  { titleKey: "systemHealth", section: "dashboard", query: "view=system", keywords: "sqlite wal database size bytes memory uptime free disk space version node last backup здоровье системы база данных размер память диск версия" },
  { titleKey: "libraryStatistics", section: "dashboard", query: "view=libraries", keywords: "statistics stats numbers counts totals audiobook ebook gallery photos videos top authors narrators formats storage on disk biggest library статистика библиотек количество авторы чтецы форматы" },
  { titleKey: "tasks", section: "dashboard", query: "view=tasks", keywords: "jobs job scan progress worker queue running queued failed history cancel background work next scheduled задания задача сканирование прогресс очередь выполняется история отменить" },
  { titleKey: "activity", section: "dashboard", query: "view=activity", keywords: "uploads downloads deletes played read viewed in progress content activity playback reading charts активность загрузки скачивания удаления прослушано прочитано просмотрено" },
  { titleKey: "locationsMap", section: "dashboard", query: "view=locations", keywords: "map countries towns cities where sign-ins came from geoip home location карта страны города откуда входили домашнее расположение" },
  { titleKey: "logRetention", section: "logs", keywords: "keep days delete old activity prune хранение дней удалить старые записи журнала" },
  { titleKey: "thumbnailStorage", section: "storage", keywords: "thumbnails cache folder path move миниатюры кэш папка путь" },
  { titleKey: "libraryContainers", section: "storage", keywords: "approved allowed root folders mount разрешённые корневые папки" },
  { titleKey: "scanSources", section: "libraries", keywords: "folder path watch include exclude extensions папка путь включить исключить расширения" },
  { titleKey: "libraryAccessMembers", section: "libraries", keywords: "who can see private share group user кто видит приватная поделиться группа доступ" },
  { titleKey: "accountLockout", section: "securityPolicies", keywords: "failed attempts lock minutes brute force блокировка неудачные попытки минуты перебор" },
  { titleKey: "ipAutoBlock", section: "securityPolicies", keywords: "automatic ban failed window minutes автоблокировка бан окно минуты" },
  { titleKey: "passwordPolicy", section: "securityPolicies", keywords: "minimum length complexity require strong пароль минимальная длина сложность" },
  { titleKey: "newSignInAlerts", section: "securityPolicies", keywords: "email notify unknown network login оповещение почта неизвестная сеть вход" },
  {
    titleKey: "twoFactorSignIn",
    section: "securityPolicies",
    keywords: "mfa 2fa require second factor outside trusted network force totp email code fallback remote двухфакторная проверка вторая ступень код почта резервный"
  },
  {
    titleKey: "linkingDevices",
    section: "securityPolicies",
    keywords: "link a device tv television wall display kiosk qr code scan sign in without password home network only outside remote привязка устройства тв дисплей код вход без пароля"
  },
  {
    titleKey: "ipReputation",
    section: "securityPolicies",
    keywords: "abuseipdb api key reputation abuse confidence score escalate permanent known malicious репутация ip ключ api оценка угрозы"
  },
  {
    titleKey: "deletionProtection",
    section: "securityPolicies",
    keywords: "allow deletions only trusted networks read only readonly refuse delete away from home stolen credentials защита удалений только доверенные сети только чтение отклонить удаление"
  },
  { titleKey: "addTrustedNetwork", section: "securityTrusted", keywords: "cidr range lan skip lockout добавить доверенную сеть подсеть диапазон" },
  { titleKey: "scheduledBackups", section: "backup", keywords: "automatic nightly keep how many retention автоматическая резервная копия расписание хранение" },
  { titleKey: "defaultTheme", section: "appearance", keywords: "new members sign-in screen look тема по умолчанию новые участники экран входа" },
  { titleKey: "smtpServer", section: "email", keywords: "host port username password tls outgoing mail сервер порт имя пользователя пароль исходящая почта" },
  { titleKey: "sendTestEmail", section: "email", keywords: "verify smtp check delivery отправить тестовое письмо проверить доставку" },
  { titleKey: "opdsReaderTokens", section: "readerAccess", keywords: "create token catalog link qr device создать токен каталог ссылка устройство" },
  { titleKey: "twoFactorAlertsDelivery", section: "email", keywords: "mfa totp codes alert emails двухфакторные коды оповещения безопасности почта" },
  {
    titleKey: "shareNotifications",
    section: "notifications",
    keywords: "notify members when a photo book album is shared with them turn on enable share notification recipient уведомления поделились фото книга альбом включить получатель"
  },
  {
    titleKey: "mapRouting",
    section: "maps",
    keywords: "route roads driving walking cycling openrouteservice api key directions story map itinerary travel маршрут дороги машина пешком велосипед ключ прокладка карта путешествие"
  },
  {
    titleKey: "recordingsLibrary",
    section: "storySettings",
    keywords: "story narration audio recording voice record microphone library destination where recordings saved озвучка история запись аудио голос микрофон библиотека записей куда сохраняются"
  }
];

function breadcrumbFor(section: ControlSection): string {
  return `${sectionEyebrow(section)} › ${tabLabel(section)}`;
}

// Built on demand rather than once at import time, so title/breadcrumb always
// reflect the language active when a caller asks — see the file header note.
export function getControlSearchEntries(): ControlSearchEntry[] {
  return [
    ...ALL_TABS.map((tab) => ({
      id: `tab:${tab.section}`,
      title: tabLabel(tab.section),
      breadcrumb: sectionEyebrow(tab.section),
      href: sectionHref(tab.section),
      section: tab.section,
      keywords: `${sectionEyebrow(tab.section)} ${TAB_KEYWORDS[tab.section] ?? ""}`
    })),
    ...SETTING_ENTRIES.map((entry, index) => ({
      id: `setting:${index}`,
      title: i18n.t(`control:search.settings.${entry.titleKey}`),
      breadcrumb: breadcrumbFor(entry.section),
      href: entry.query ? `${sectionHref(entry.section)}?${entry.query}` : sectionHref(entry.section),
      section: entry.section,
      keywords: entry.keywords
    }))
  ];
}

// Ranked substring match over title then keywords. Deliberately not fuzzy: with
// ~40 entries, typo-tolerance buys little and mostly surfaces confusing results.
// Multi-word queries must match every word somewhere, so "email test" works.
export function searchControlPanel(query: string): ControlSearchEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const scored: { entry: ControlSearchEntry; score: number }[] = [];

  for (const entry of getControlSearchEntries()) {
    const title = entry.title.toLowerCase();
    const haystack = `${title} ${entry.breadcrumb.toLowerCase()} ${entry.keywords.toLowerCase()}`;
    if (!words.every((word) => haystack.includes(word))) continue;

    // Prefer a title hit over a keyword-only hit, and a prefix over a mid-word one.
    let score = 0;
    for (const word of words) {
      if (title.startsWith(word)) score += 3;
      else if (title.includes(word)) score += 2;
      else score += 1;
    }
    scored.push({ entry, score });
  }

  return scored
    .sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title))
    .map((hit) => hit.entry);
}
