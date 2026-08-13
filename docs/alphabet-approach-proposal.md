# Alphabet Approach Proposal

## Goal

Provide a simple, scalable way to browse authors by alphabet while minimizing manual administration.

## Recommended Approach

Use **automatic script/alphabet detection by default**, with a **manual override** available for administrators.

The system should detect the writing system used in the author's displayed name rather than trying to determine the author's spoken or native language.

Examples:

- `Stephen King` → Latin
- `Лев Толстой` → Cyrillic
- `Γιάννης Ρίτσος` → Greek
- `村上春樹` → Japanese

## Why Script Detection

Language detection is not reliable enough for author names alone.

For example:

- English, French, German, Spanish, Polish, and many other languages use the Latin script.
- A short author name may not contain enough information to identify a language accurately.
- Script detection is deterministic and can be based on Unicode characters.

Therefore:

> Author name → Detect Unicode script → Assign alphabet

## User Interface

Only alphabets that are enabled and relevant should appear.

Example:

`English | Русский | 日本語 | ⚙`

When an alphabet is selected, show only that alphabet's letters.

### English

`All  A B C D E F G H I J K L M N O P Q R S T U V W X Y Z #`

### Russian

`Все  А Б В Г Д Е Ё Ж З И Й К Л М Н О П Р С Т У Ф Х Ц Ч Ш Щ Ъ Ы Ь Э Ю Я #`

The `#` group should contain authors whose names begin with:

- Numbers
- Symbols
- Unsupported characters
- Characters that do not map cleanly to the selected alphabet

## Alphabet Configuration

The alphabet toolbar should include a **configuration button**.

The configuration page should allow administrators to:

- Enable or disable alphabets
- Change alphabet display order
- Rename the display label
- Configure alphabet characters
- Set the default alphabet
- Manually assign an author to a different alphabet
- Reset an author back to automatic detection

## Author Data Model

Suggested fields:

```ts
type Author = {
  id: string;
  name: string;

  detectedScript?: string;
  alphabetId?: string;
  alphabetOverrideId?: string | null;

  sortName?: string;
};
```

Example:

```ts
{
  name: "Лев Толстой",
  detectedScript: "cyrillic",
  alphabetId: "russian",
  alphabetOverrideId: null
}
```

The effective alphabet should be:

```ts
effectiveAlphabet =
  author.alphabetOverrideId ??
  author.alphabetId;
```

## Latin Script Handling

Latin script should be treated separately from language.

Internally:

```text
latin
```

The UI may display this as:

```text
English
```

if that is more user-friendly for the initial implementation.

Later, the application can support additional Latin-based alphabet definitions such as:

- English
- French
- German
- Spanish
- Polish

without changing the underlying detection system.

## Sorting

Each alphabet configuration should define its own character order.

For example, Russian sorting must understand that:

```text
Е < Ё < Ж
```

rather than relying only on generic ASCII sorting.

Use locale-aware sorting where possible:

```ts
new Intl.Collator(locale)
```

Examples:

```ts
new Intl.Collator("en");
new Intl.Collator("ru");
```

## Import and Scan Behavior

When a new author is created or imported:

1. Read the author display name.
2. Detect the Unicode script.
3. Map the script to an enabled alphabet.
4. Generate/update the sorting value.
5. Allow an administrator to override the result if necessary.

Existing authors can be processed automatically during a migration.

## Mixed-Script Names

If an author name contains multiple scripts, use the first meaningful alphabetic character or the dominant script.

Example:

```text
Лев Tolstoy
```

Possible result:

```text
Cyrillic
```

Administrators can override unusual cases.

## Search

Alphabet filtering should not restrict search.

For example, searching:

```text
Dostoevsky
```

should be able to find:

```text
Фёдор Достоевский
```

if alternate names or transliterations are stored.

Future fields may include:

```ts
alternateNames?: string[];
transliterations?: string[];
```

## Recommended Initial Implementation

Start with:

1. Latin / English
2. Cyrillic / Russian
3. `#` fallback
4. Automatic Unicode script detection
5. Manual override
6. Alphabet configuration screen
7. Locale-aware sorting

Additional alphabets can be added later without changing the core architecture.

## Summary

The preferred model is:

**Automatic detection first, manual configuration only when needed.**

This provides:

- Minimal administration
- Consistent author organization
- Good multilingual support
- Easy future expansion
- Administrator control for exceptions
