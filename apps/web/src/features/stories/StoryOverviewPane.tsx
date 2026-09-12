import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, ChevronUp, Settings, Star } from "lucide-react";
import { api } from "../../api";
import type { ActionMenuItem } from "../../shared/ActionMenu";
import { Button } from "../../shared/Button";
import { InlineEdit } from "../../shared/InlineEdit";
import { MessageBox } from "../../shared/MessageBox";
import { SelectField } from "../../shared/SelectField";
import { PeopleCombobox } from "../../shared/PeopleCombobox";
import { SuggestInput } from "../../shared/SuggestInput";
import { StoryCoverBanner } from "./StoryCoverBanner";
import { StoryMap } from "./StoryMap";
import { StoryMarkdown } from "./StoryMarkdown";
import { replaceNavigate, storyEditorHref } from "../../router";
import { chapterLabel, type StoryCollectionSummary, type StoryDetail } from "./types";

// The editor's first page and everything true of the story as a whole. It opens
// as the story's own front page — the cover it opens with, its name, the few
// lines that introduce it, all edited where the words sit — and what never
// shows to a reader sits in one folded card underneath, exactly where a
// chapter keeps its own settings. Those were a second pane once, reachable only
// from a sidebar row next to one labelled "Home"; a story this small has one
// page about itself, not two.
export function StoryOverviewPane({
  story,
  busy,
  onPatch,
  onTags
}: {
  story: StoryDetail;
  busy: boolean;
  onPatch: (fields: Record<string, unknown>) => void;
  onTags: (tags: string[]) => void;
}) {
  const { t } = useTranslation(["common", "stories"]);
  // Folds away like the chapter's own settings card, and opens itself for a
  // story with none of this set yet — there is otherwise no hint that a shelf,
  // a rating and tags belong to it.
  const [settingsOpen, setSettingsOpen] = useState(
    !story.chapterNoun && !story.collectionId && story.rating == null && story.tags.length === 0
  );
  const [chapterNoun, setChapterNoun] = useState(story.chapterNoun ?? "");
  // Recipe facts: offered to every recipe, and kept on any story that has them.
  const showRecipeFacts = story.kind === "recipe" || story.servings != null || story.cookMinutes != null;
  const [servings, setServings] = useState(story.servings ?? "");
  const [cookMinutes, setCookMinutes] = useState(story.cookMinutes != null ? String(story.cookMinutes) : "");
  const [authorName, setAuthorName] = useState(story.authorName ?? "");
  // The names this author has signed with before, their account name first.
  const [bylines, setBylines] = useState<string[]>([]);
  // The vocabulary other stories already use ("Minnesota"), so an author picks
  // an existing tag instead of inventing a near-duplicate. Tags are
  // cross-type, so this asks for the ones stories carry — offering every
  // photo's and every book's tag as well is a list nobody can read.
  const [tagSuggestions, setTagSuggestions] = useState<string[]>([]);
  // Shelves this author may put the story on (plus wherever it already is).
  const [collections, setCollections] = useState<StoryCollectionSummary[]>([]);

  // `chapterNoun` and `authorName` are seeded once: StoryEditorPage renders this
  // pane with key={story.id}, so it is remounted for another story rather than
  // following it. They used to be re-seeded from effects on the story's own
  // fields, and since every patch re-reads the whole story, a reload landing
  // between two keystrokes put the stored value back in the box.

  useEffect(() => {
    api<{ bylines: string[] }>("/api/stories/bylines")
      .then((payload) => setBylines(payload.bylines))
      .catch(() => setBylines([]));
    api<{ tags: { name: string; storyCount: number }[] }>("/api/library/tags")
      .then((payload) => setTagSuggestions(
        payload.tags.filter((tag) => tag.storyCount > 0).map((tag) => tag.name)
      ))
      .catch(() => setTagSuggestions([]));
    api<{ collections: StoryCollectionSummary[] }>("/api/stories/collections")
      .then((payload) => setCollections(payload.collections))
      .catch(() => setCollections([]));
  }, []);

  // A story that shows a book can wear that book's artwork — the first one it
  // shows, which on a review is the book it is about.
  const book = story.chapters
    .flatMap((chapter) => chapter.blocks)
    .find((block) => block.kind === "book" && block.available && block.coverUrl && block.entityId);
  const bookCover: ActionMenuItem[] = book
    ? [{
      key: "book",
      label: t("stories:edit.coverUseBook"),
      icon: <BookOpen size={15} aria-hidden="true" />,
      onSelect: () => onPatch({ coverItemId: book.entityId })
    }]
    : [];

  const pins = story.chapters
    .map((chapter, index) => ({ chapter, index }))
    .filter(({ chapter }) => chapter.placeLat != null && chapter.placeLng != null)
    .map(({ chapter, index }) => ({
      id: chapter.id,
      lat: chapter.placeLat!,
      lng: chapter.placeLng!,
      label: String(index + 1),
      title: chapter.place ?? chapterLabel(story, chapter, index)
    }));

  return (
    <div className="story-edit-pane story-edit-overview">
      <StoryCoverBanner
        coverUrl={story.coverUrl}
        pickerTitle={t("stories:fields.coverPickerTitle")}
        extraActions={bookCover}
        onPick={(asset) => onPatch({ coverItemId: asset.id })}
        onClear={() => onPatch({ coverItemId: null })}
      />

      <h1 className="story-edit-story-title">
        <InlineEdit
          value={story.title}
          ariaLabel={t("stories:fields.title")}
          placeholder={t("stories:fields.titlePlaceholder")}
          maxLength={160}
          // The one field with nothing to fall back on: a story always has a
          // name, so an emptied title keeps the old one.
          onSave={(next) => { if (next) onPatch({ title: next }); }}
        />
      </h1>

      <div className="story-edit-story-subtitle">
        <InlineEdit
          value={story.subtitle ?? ""}
          ariaLabel={t("stories:fields.subtitle")}
          placeholder={t("stories:fields.subtitlePlaceholder")}
          maxLength={300}
          onSave={(next) => onPatch({ subtitle: next || null })}
        />
      </div>

      <div className="story-edit-intro">
        <InlineEdit
          value={story.intro ?? ""}
          ariaLabel={t("stories:fields.intro")}
          placeholder={t("stories:fields.introPlaceholder")}
          maxLength={5000}
          multiline
          rows={6}
          display={story.intro ? <StoryMarkdown source={story.intro} /> : undefined}
          onSave={(next) => onPatch({ intro: next || null })}
        />
      </div>

      {/* The same card, in the same place, as a chapter's own settings: right
          under the words that open the page, holding what has no place in
          them — what this story calls a chapter, how it is filed, what it is
          worth. Nothing here is a second way to set something edited above. */}
      <section
        className={`story-edit-settings story-edit-story-details${settingsOpen ? "" : " is-collapsed"}`}
      >
        <Button
          variant="bare"
          className="story-edit-settings-head"
          onClick={() => setSettingsOpen(!settingsOpen)}
          aria-expanded={settingsOpen}
        >
          <Settings size={16} aria-hidden="true" />
          <span>{t("stories:edit.detailsHeading")}</span>
          <span className="story-edit-settings-chevron" aria-hidden="true">
            <ChevronUp size={16} />
          </span>
        </Button>

        {settingsOpen && (
          <div className="story-edit-settings-body">
            <div className="story-edit-setting story-edit-setting-wide">
              <MessageBox
                tone={story.status === "published" ? "success" : "info"}
                title={story.status === "published"
                  ? t("stories:status.publishedTitle")
                  : t("stories:status.draftTitle")}
              >
                {story.status === "published" ? t("stories:status.publishedBody") : t("stories:status.draftBody")}
              </MessageBox>
            </div>

            {/* Who the story is signed by, shown on its cover and at its end.
                Free text, offered as the names this author has used before with
                their account's name first — a pen name is a choice, not a
                mistake, and a story may be signed by two people or by nobody. */}
            <div className="field story-edit-setting">
              <span>{t("stories:fields.authorName")}</span>
              <SuggestInput
                value={authorName}
                suggestions={bylines}
                placeholder={t("stories:fields.authorNamePlaceholder")}
                maxLength={120}
                ariaLabel={t("stories:fields.authorName")}
                onChange={setAuthorName}
                onCommit={(next) => {
                  const trimmed = next.trim();
                  if (trimmed !== (story.authorName ?? "")) onPatch({ authorName: trimmed || null });
                }}
              />
              <span className="muted">{t("stories:fields.authorNameHint")}</span>
            </div>

            {/* Authored text ("Day", "Stop") rendered "Day 1" — deliberately NOT
                translated, it belongs to this story rather than to the app. */}
            <label className="field story-edit-setting">
              <span>{t("stories:fields.chapterNoun")}</span>
              <input
                value={chapterNoun}
                maxLength={30}
                onChange={(event) => setChapterNoun(event.target.value)}
                onBlur={() => {
                  const next = chapterNoun.trim();
                  if (next !== (story.chapterNoun ?? "")) onPatch({ chapterNoun: next || null });
                }}
                placeholder={t("stories:fields.chapterNounPlaceholder")}
              />
              <span className="muted">{t("stories:fields.chapterNounHint")}</span>
            </label>

            <SelectField
              className="story-edit-setting"
              label={t("stories:collections.pickerLabel")}
              value={story.collectionId ?? ""}
              onChange={(value) => onPatch({ collectionId: value || null })}
              disabled={busy}
              hint={t("stories:collections.pickerHint")}
              options={[
                { value: "", label: t("stories:collections.none") },
                ...collections
                  .filter((collection) => collection.canContribute || collection.id === story.collectionId)
                  .map((collection) => ({ value: collection.id, label: collection.title }))
              ]}
            />

            <div className="field story-edit-setting">
              <span>{t("stories:rating.label")}</span>
              <div className="story-rating-row">
                {[1, 2, 3, 4, 5].map((value) => (
                  <Button
                    variant="bare"
                    key={value}
                    className="story-rating-star"
                    onClick={() => onPatch({ rating: value })}
                    disabled={busy}
                    aria-pressed={story.rating != null && story.rating >= value}
                    aria-label={t("stories:rating.setAria", { count: value })}
                    title={t("stories:rating.setAria", { count: value })}
                  >
                    <Star
                      size={20}
                      aria-hidden="true"
                      fill={story.rating != null && story.rating >= value ? "currentColor" : "none"}
                    />
                  </Button>
                ))}
                {story.rating != null && (
                  <Button variant="text" compact onClick={() => onPatch({ rating: null })} disabled={busy}>
                    {t("stories:rating.clear")}
                  </Button>
                )}
              </div>
              <span className="muted">{t("stories:rating.hint")}</span>
            </div>

            {showRecipeFacts && (
              <>
                <label className="field story-edit-setting">
                  <span>{t("stories:recipe.servingsField")}</span>
                  <input
                    value={servings}
                    maxLength={60}
                    onChange={(event) => setServings(event.target.value)}
                    onBlur={() => {
                      const next = servings.trim();
                      if (next !== (story.servings ?? "")) onPatch({ servings: next || null });
                    }}
                    placeholder={t("stories:recipe.servingsPlaceholder")}
                    disabled={busy}
                  />
                  <span className="muted">{t("stories:recipe.servingsHint")}</span>
                </label>
                <label className="field story-edit-setting">
                  <span>{t("stories:recipe.timeField")}</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={10080}
                    value={cookMinutes}
                    onChange={(event) => setCookMinutes(event.target.value)}
                    onBlur={() => {
                      const n = Number.parseInt(cookMinutes, 10);
                      const next = Number.isFinite(n) && n > 0 ? n : null;
                      if (next !== story.cookMinutes) onPatch({ cookMinutes: next });
                    }}
                    placeholder={t("stories:recipe.timePlaceholder")}
                    disabled={busy}
                  />
                  <span className="muted">{t("stories:recipe.timeHint")}</span>
                </label>
              </>
            )}

            <div className="field story-edit-setting story-edit-setting-wide">
              <span>{t("stories:tags.label")}</span>
              <PeopleCombobox
                value={story.tags}
                onChange={onTags}
                suggestions={tagSuggestions}
                placeholder={t("stories:tags.placeholder")}
                disabled={busy}
              />
              <span className="muted">{t("stories:tags.hint")}</span>
            </div>
          </div>
        )}
      </section>

      {pins.length > 0 && (
        <section className="story-edit-home-map">
          <h2>{t("stories:site.mapHeading")}</h2>
          {/* Replaces, like every other move between panes — see the editor's
              own note on why leaving has to mean leaving. */}
          <StoryMap pins={pins} onOpen={(id) => replaceNavigate(storyEditorHref(story.id, id))} />
        </section>
      )}
    </div>
  );
}
