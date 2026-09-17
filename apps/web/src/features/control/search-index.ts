import { ALL_TABS, sectionEyebrow, sectionHref, tabLabel } from "./nav";
import { profileHref, type ControlSection } from "../../router";
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
  keywords: string;
}

// Extra search terms for the tab pages themselves — English, then the Russian
// equivalent of the same words, concatenated.
const TAB_KEYWORDS: Partial<Record<ControlSection, string>> = {
  dashboard: "system health cpu memory uptime version node disk free space database sqlite wal size last backup status " +
    "система здоровье состояние процессор память время работы версия диск свободное место база данных размер последняя резервная копия",
  activity: "activity trends charts graphs uploads downloads deletes played read viewed in progress content playback reading " +
    "активность тренды графики диаграммы загрузки скачивания удаления прослушано прочитано просмотрено в процессе воспроизведение чтение",
  libraryStats: "statistics stats numbers counts totals audiobook ebook gallery photos videos top authors narrators formats storage on disk biggest library " +
    "статистика цифры количество всего аудиокнига электронная книга галерея фото видео топ авторы чтецы форматы размер на диске",
  logs: "activity audit trail events sign-in history retention prune clear " +
    "активность аудит журнал события история входов хранение очистка удалить",

  libraries: "add library scan sources folders paths extensions uploads access members wizard rescan " +
    "добавить библиотеку сканирование источники папки пути расширения загрузки доступ участники мастер пересканировать",
  storage: "thumbnails cache path containers approved folders disk location recycle bin trash folder " +
    "миниатюры кэш путь контейнеры разрешённые папки диск расположение корзина папка",
  storageContents: "app storage contents what is in it size on disk parts app files recordings voice notes music movies family tree orphans orphaned files delete other files move folder " +
    "содержимое хранилища приложения размер на диске комнаты файлы приложения записи голосовые заметки музыка фильмы семейное древо сироты осиротевшие файлы удалить другие файлы перенести папку",
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
  signIns: "sign-ins sign-in details login logins analytics drill down dive connection ip address country city user person failed attempts blocked scanner probes guessed names sessions devices displays phones tablets computers signed in until expires registered revoke sign out logout tokens linked tv display " +
    "вход входы подробности аналитика адрес ip страна город пользователь человек неудачные попытки заблокирован сканер зондирование предполагаемые имена сессии устройства экраны телефоны планшеты компьютеры истекает зарегистрирован отозвать выйти выход токены привязанный тв дисплей",
  signInLocations: "map countries towns cities where sign-ins came from geoip home location locations " +
    "карта страны города откуда входили домашнее расположение местоположения",
  securityPolicies:
    "lockout brute force threshold attempts password minimum length complexity sign-in alerts email abuseipdb reputation abuse score threat intelligence read only readonly delete trusted network protect deletions " +
    "блокировка перебор порог попытки пароль минимальная длина сложность оповещения о входе почта репутация угрозы только чтение удаление доверенная сеть защита удалений",
  securityTrusted: "cidr subnet allowlist lan home network exempt whitelist " +
    "подсеть белый список локальная сеть домашняя сеть исключение",
  securityBlocked:
    "banned ip block unblock auto-block ban permanent never expires forever make permanent reputation abuseipdb abuse score check " +
    "заблокированный ip блокировка разблокировать автоблокировка бан навсегда никогда не истекает сделать постоянным репутация проверка",

  tasks: "jobs job scan progress worker queue running queued failed history cancel background work next scheduled " +
    "задания задача задачи сканирование прогресс очередь выполняется история отменить фоновая работа",
  backup: "restore zip archive download snapshot schedule retention export full minimal quick database copy sqlite " +
    "восстановить архив скачать снимок расписание хранение экспорт резервная копия полная минимальная быстрая копия базы",
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
  mapSetup: "maps map caching offline privacy openfreemap tiles basemap set up turn on off limit named places geonames " +
    "geoip location database mmdb dbip maxmind geolite country city sign-in towns upload link remove " +
    "route roads openrouteservice api key directions " +
    "геолокация база расположений страны города входы загрузить удалить маршрут дороги ключ прокладка " +
    "карты кэширование карт офлайн конфиденциальность тайлы подложка мастер настроить включить выключить тёмная подписи язык",
  about: "version credits licences licenses changelog release notes what's new " +
    "версия авторы лицензии список изменений заметки о выпуске что нового"
};

// Every setting entry's title, as the `control:search.settings.*` key suffix
// that names it — a literal union so the template-literal t() call below
// type-checks (docs/i18n-plan.md's namespace-key typing pitfall #4).
type SettingKey =
  | "logRetention" | "systemData" | "appStorage" | "thumbnailStorage" | "backupFolder" | "libraryContainers" | "scanSources"
  | "libraryAccessMembers" | "accountLockout" | "ipAutoBlock" | "passwordPolicy"
  | "newSignInAlerts" | "twoFactorSignIn" | "linkingDevices" | "ipReputation"
  | "deletionProtection" | "addTrustedNetwork" | "scheduledBackups" | "defaultTheme"
  | "smtpServer" | "sendTestEmail" | "twoFactorAlertsDelivery"
  | "shareNotifications" | "recordingsLibrary" | "recipeImport" | "mapRouting"
  | "houseLibrary" | "photoInboxSetup" | "mapCaching" | "namedPlaces" | "locationDatabase";

// Settings that live inside a page. `section` is where they are; search takes
// you to that tab. `anchor` is the id of the card the setting sits in, where the
// page has more than one, so the hit scrolls to it (useAnchorScroll) rather than
// leaving you at the top of a long page to find it again.
const SETTING_ENTRIES: { titleKey: SettingKey; section: ControlSection; keywords: string; anchor?: string }[] = [
  { titleKey: "logRetention", section: "logs", keywords: "keep days delete old activity prune хранение дней удалить старые записи журнала" },
  { titleKey: "systemData", section: "storage", anchor: "system-data", keywords: "system data required folder config database metadata disk space free move системные данные обязательная папка база данных метаданные место на диске перенос" },
  { titleKey: "appStorage", section: "storage", anchor: "app-storage", keywords: "app storage switch on off enable one folder system data custom folder photo inbox app files made in the app renders music map data move in disk space хранилище приложения включить выключить одна папка системные данные своя папка входящие файлы приложения рендеры музыка данные карт перенести место на диске" },
  { titleKey: "thumbnailStorage", section: "storage", anchor: "system-data", keywords: "thumbnails cache folder path move own folder system data миниатюры кэш папка путь отдельная папка системные данные" },
  { titleKey: "backupFolder", section: "storage", anchor: "system-data", keywords: "backups backup folder path another disk same disk move резервные копии папка путь другой диск тот же диск перенос" },
  { titleKey: "libraryContainers", section: "storage", anchor: "storage-containers", keywords: "approved allowed root folders mount разрешённые корневые папки" },
  { titleKey: "scanSources", section: "libraries", keywords: "folder path watch include exclude extensions папка путь включить исключить расширения" },
  { titleKey: "libraryAccessMembers", section: "libraries", keywords: "who can see private share group user кто видит приватная поделиться группа доступ" },
  { titleKey: "accountLockout", section: "securityPolicies", anchor: "lockout", keywords: "failed attempts lock minutes brute force блокировка неудачные попытки минуты перебор" },
  { titleKey: "ipAutoBlock", section: "securityPolicies", anchor: "lockout", keywords: "automatic ban failed window minutes автоблокировка бан окно минуты" },
  { titleKey: "passwordPolicy", section: "securityPolicies", anchor: "password-policy", keywords: "minimum length complexity require strong пароль минимальная длина сложность" },
  { titleKey: "newSignInAlerts", section: "securityPolicies", anchor: "sign-in-alerts", keywords: "email notify unknown network login оповещение почта неизвестная сеть вход" },
  {
    titleKey: "twoFactorSignIn",
    section: "securityPolicies",
    anchor: "two-factor",
    keywords: "mfa 2fa require second factor outside trusted network force totp email code fallback remote двухфакторная проверка вторая ступень код почта резервный"
  },
  {
    titleKey: "linkingDevices",
    section: "securityPolicies",
    anchor: "device-linking",
    keywords: "link a device tv television wall display kiosk qr code scan sign in without password home network only outside remote привязка устройства тв дисплей код вход без пароля"
  },
  {
    titleKey: "ipReputation",
    section: "securityPolicies",
    anchor: "ip-reputation",
    keywords: "abuseipdb api key reputation abuse confidence score escalate permanent known malicious репутация ip ключ api оценка угрозы"
  },
  {
    titleKey: "deletionProtection",
    section: "securityPolicies",
    anchor: "deletion-protection",
    keywords: "allow deletions only trusted networks read only readonly refuse delete away from home stolen credentials защита удалений только доверенные сети только чтение отклонить удаление"
  },
  { titleKey: "addTrustedNetwork", section: "securityTrusted", keywords: "cidr range lan skip lockout добавить доверенную сеть подсеть диапазон" },
  { titleKey: "scheduledBackups", section: "backup", anchor: "scheduled-backups", keywords: "automatic nightly weekly monthly full minimal keep how many retention of each kind автоматическая резервная копия расписание еженедельно ежемесячно полная минимальная хранение" },
  { titleKey: "defaultTheme", section: "appearance", keywords: "new members sign-in screen look тема по умолчанию новые участники экран входа" },
  { titleKey: "smtpServer", section: "email", keywords: "host port username password tls outgoing mail сервер порт имя пользователя пароль исходящая почта" },
  { titleKey: "sendTestEmail", section: "email", keywords: "verify smtp check delivery отправить тестовое письмо проверить доставку" },
  { titleKey: "twoFactorAlertsDelivery", section: "email", keywords: "mfa totp codes alert emails двухфакторные коды оповещения безопасности почта" },
  {
    titleKey: "shareNotifications",
    section: "notifications",
    keywords: "notify members when a photo book album is shared with them turn on enable share notification recipient уведомления поделились фото книга альбом включить получатель"
  },
  {
    titleKey: "mapRouting",
    section: "mapSetup",
    anchor: "road-routes",
    keywords: "route roads driving walking cycling openrouteservice api key directions story map itinerary travel маршрут дороги машина пешком велосипед ключ прокладка карта путешествие"
  },
  {
    titleKey: "mapCaching",
    section: "mapSetup",
    anchor: "offline-maps",
    keywords: "offline maps keep maps on this server cache tiles limit size privacy provider sees where storage map data " +
      "хранить карты на сервере офлайн кэш тайлы конфиденциальность провайдер видит хранилище данные карт"
  },
  {
    titleKey: "namedPlaces",
    section: "mapSetup",
    anchor: "named-places",
    keywords: "named places place names reverse geocoding geonames town city where photo was taken places filter update rebuild " +
      "названия мест обратное геокодирование город где сделан снимок фильтр места обновить пересобрать"
  },
  {
    titleKey: "locationDatabase",
    section: "mapSetup",
    anchor: "sign-in-locations",
    keywords: "sign-in locations geoip database country city mmdb dbip geolite maxmind fetch upload remove " +
      "расположение входов геолокация база страна город скачать загрузить удалить"
  },
  {
    titleKey: "houseLibrary",
    section: "storage",
    anchor: "app-storage",
    keywords: "made in the app house library where files go destination recordings narration family tree uploads slideshow movies rendered saved folder сделано в приложении домашняя библиотека куда попадают файлы записи озвучка семейное древо загрузки фильмы слайд-шоу папка"
  },
  {
    titleKey: "photoInboxSetup",
    section: "storage",
    anchor: "app-storage",
    keywords: "photo inbox set up create new inbox scans holding review drop link storage container folder входящие фото создать настроить сканы разбор ссылка контейнер папка"
  },
  {
    titleKey: "recordingsLibrary",
    section: "storage",
    anchor: "app-storage",
    keywords: "story narration audio recording voice record microphone library destination where recordings saved озвучка история запись аудио голос микрофон библиотека записей куда сохраняются"
  },
  {
    titleKey: "recipeImport",
    section: "storySettings",
    keywords: "recipe import link url fetch page ingredients steps cook cooking food dish allow turn off рецепт импорт ссылка страница ингредиенты шаги готовка блюдо разрешить отключить"
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
      keywords: `${sectionEyebrow(tab.section)} ${TAB_KEYWORDS[tab.section] ?? ""}`
    })),
    ...SETTING_ENTRIES.map((entry, index) => ({
      id: `setting:${index}`,
      title: i18n.t(`control:search.settings.${entry.titleKey}`),
      breadcrumb: breadcrumbFor(entry.section),
      href: entry.anchor ? `${sectionHref(entry.section)}#${entry.anchor}` : sectionHref(entry.section),
      keywords: entry.keywords
    })),
    // Reader tokens left the control panel for Profile (they are each person's
    // own), but an administrator who has always found them here still can.
    {
      id: "profile:readerAccess",
      title: i18n.t("profile.tabs.readerAccess"),
      breadcrumb: i18n.t("nav.profile"),
      href: profileHref("readerAccess"),
      keywords: "opds catalog token koreader thorium moon+ reader ereader e-reader basic auth device create qr " +
        "каталог токен читалка электронная книга устройство создать"
    }
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
