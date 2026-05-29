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
  const stack = [
    { label: "Runtime", value: about.runtime },
    { label: "Database", value: about.database },
    { label: "Server", value: about.server },
    { label: "Frontend", value: about.frontend },
  ];

  return (
    <section className="about-panel">
      <div className="about-heading">
        <div className="about-icon-wrap">
          <img src="/Assets/brand/isputnik-app-icon.svg" alt="" />
        </div>
        <div className="about-heading-text">
          <h2>{about.name}</h2>
          <p className="about-code-name">Спутник Один</p>
          <span className="about-version-badge">v{about.version}</span>
        </div>
      </div>

      <p className="about-description">{about.description}</p>

      <div className="about-stack">
        {stack.map(({ label, value }) => (
          <div className="about-stack-item" key={label}>
            <span className="about-stack-label">{label}</span>
            <span className="about-stack-value">{value}</span>
          </div>
        ))}
      </div>

      <section className="version-updates" aria-label="Version updates">
        <p className="version-updates-eyebrow">What's new</p>
        <div className="version-timeline">
          {about.versionUpdates.map((update, index) => (
            <article
              className={`version-update${index === 0 ? " version-update-current" : ""}`}
              key={update.version}
            >
              <div className="version-update-dot" aria-hidden="true" />
              <div className="version-update-body">
                <div className="version-update-head">
                  <strong className="version-update-num">v{update.version}</strong>
                  <span className="version-update-label">{update.label}</span>
                </div>
                <ul className="version-update-list">
                  {update.changes.map((change) => <li key={change}>{change}</li>)}
                </ul>
              </div>
            </article>
          ))}
        </div>
      </section>
    </section>
  );
}
