export interface AboutInfo {
  name: string;
  version: string;
  description: string;
  runtime: string;
  database: string;
  server: string;
  frontend: string;
  versionUpdates: {
    version: string;
    label: string;
    changes: string[];
  }[];
}

export function AboutDetails({ about }: { about: AboutInfo }) {
  return (
    <section className="about-panel">
      <div className="about-heading">
        <img src="/Assets/brand/isputnik-app-icon.svg" alt="" />
        <div>
          <h2>{about.name}</h2>
          <span>Version {about.version}</span>
        </div>
      </div>
      <p>{about.description}</p>
      <dl className="about-details">
        <div><dt>Frontend</dt><dd>{about.frontend}</dd></div>
        <div><dt>Server</dt><dd>{about.server}</dd></div>
        <div><dt>Runtime</dt><dd>{about.runtime}</dd></div>
        <div><dt>Database</dt><dd>{about.database}</dd></div>
      </dl>
      <section className="version-updates" aria-label="Version updates">
        <h2>Version updates</h2>
        {about.versionUpdates.map((update) => (
          <article className="version-update" key={update.version}>
            <div>
              <strong>Version {update.version}</strong>
              <span>{update.label}</span>
            </div>
            <ul>
              {update.changes.map((change) => <li key={change}>{change}</li>)}
            </ul>
          </article>
        ))}
      </section>
    </section>
  );
}
