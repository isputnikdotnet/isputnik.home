import { useTranslation } from "react-i18next";
import { UserRound } from "lucide-react";
import { followRoute } from "../../router";
import { personHref, type VideoCredit, type VideoCrewJob, type VideoPersonSummary } from "./types";

// Cast and crew (docs/video-people-plan.md): the round faces on a title's page and
// in search, each a link to the person's page. The engine gives them from the
// .nfo first, TMDB's credits after.

const JOB_ORDER: VideoCrewJob[] = ["creator", "director", "writer", "composer"];

/** One face: the person's picture (or a placeholder), their name, a line under it. */
export function PersonCard({ id, name, photo, sub }: { id: string; name: string; photo: string | null; sub?: string | null }) {
  const href = personHref(id);
  return (
    <a className="video-person" href={href} onClick={(event) => followRoute(event, href)}>
      <span className="video-person-photo" aria-hidden="true">
        {photo ? <img src={photo} alt="" loading="lazy" /> : <UserRound size={34} />}
      </span>
      <strong>{name}</strong>
      {sub && <small className="muted">{sub}</small>}
    </a>
  );
}

/** A title's crew in one line, by job: Director: …  ·  Writer: …  ·  Music: … */
export function CrewLine({ crew }: { crew: VideoCredit[] }) {
  const { t } = useTranslation();
  const byJob = JOB_ORDER
    .map((job) => ({ job, people: crew.filter((credit) => credit.role === job) }))
    .filter((entry) => entry.people.length > 0);
  if (byJob.length === 0) return null;
  return (
    <p className="video-crew">
      {byJob.map(({ job, people }, at) => (
        <span key={job}>
          {at > 0 && <span className="video-crew-sep" aria-hidden="true"> · </span>}
          <span className="muted">{t(`video.people.job.${job}`, { count: people.length })}: </span>
          {people.map((person, index) => {
            const href = personHref(person.id);
            return (
              <span key={person.id}>
                {index > 0 && ", "}
                <a href={href} onClick={(event) => followRoute(event, href)}>{person.name}</a>
              </span>
            );
          })}
        </span>
      ))}
    </p>
  );
}

/** The cast, in billing order, scrolled sideways. */
export function CastRow({ cast }: { cast: VideoCredit[] }) {
  const { t } = useTranslation();
  if (cast.length === 0) return null;
  return (
    <section className="video-cast" aria-labelledby="video-cast-title">
      <h2 id="video-cast-title">{t("video.people.cast")}</h2>
      <ul className="video-people-row">
        {cast.map((credit) => (
          <li key={credit.id}>
            <PersonCard id={credit.id} name={credit.name} photo={credit.photo} sub={credit.role} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** People a search found, before the titles. */
export function PeopleResults({ people }: { people: VideoPersonSummary[] }) {
  const { t } = useTranslation();
  if (people.length === 0) return null;
  return (
    <section className="video-cast" aria-labelledby="video-people-found">
      <h2 id="video-people-found">{t("video.people.found")}</h2>
      <ul className="video-people-row">
        {people.map((person) => (
          <li key={person.id}>
            <PersonCard id={person.id} name={person.name} photo={person.photo} sub={t("video.people.titleCount", { count: person.titles })} />
          </li>
        ))}
      </ul>
    </section>
  );
}
