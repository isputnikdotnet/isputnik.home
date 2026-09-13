// Maps — the base map every map in the app draws on, and where it is kept
// (docs/map-approach-proposal.md, phase 1b).
//
// A product feature, so it lives in modules/, not core: it knows what a map
// style is and which provider draws it. The geoip reader stays in core
// (core/geoip.ts) because security and the logs read it too; only where its
// databases live comes from here — the Map data room's Locations folder.
import type { FastifyInstance } from "fastify";
import { setGeoipRoomDirectory } from "../../core/geoip.js";
import { registerMapRoutes } from "./routes.js";
import { adoptLegacyGeoipFolder } from "./locations.js";
import { locationsDir } from "./storage.js";
import { startPlacesBuildWorker } from "./places/job.js";

export async function mapsPlugin(app: FastifyInstance) {
  setGeoipRoomDirectory(locationsDir);
  // Before the server listens, so no sign-in is looked up against a folder that
  // is half moved. A failure leaves the databases where they were, still read
  // from there by nothing — so it is said loudly, and tried again next boot.
  try {
    const adopted = adoptLegacyGeoipFolder();
    if (adopted && adopted.moved.length > 0) {
      app.log.info(`Moved ${adopted.moved.length} location database(s) from ${adopted.from} into ${adopted.to}.`);
    }
    if (adopted && adopted.kept.length > 0) {
      app.log.warn(`Left ${adopted.kept.join(", ")} in ${adopted.from}: a different file of the same name is already in ${adopted.to}.`);
    }
  } catch (err) {
    app.log.warn({ err }, "Could not move the location databases into the Map data room; will try again on the next start.");
  }

  registerMapRoutes(app);
  // Building the place names database runs as a task on the shared job poller;
  // one a restart interrupted is re-queued by its recovery pass.
  const stopPlacesBuildWorker = startPlacesBuildWorker();
  app.addHook("onClose", async () => {
    stopPlacesBuildWorker();
    setGeoipRoomDirectory(null);
  });
}
