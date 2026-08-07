// The setup guide's one piece of state: whether the first administrator has been
// offered it yet. Everything the guide writes goes through the endpoints its Control
// panel pages already use — this flag is the only thing it owns.
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { onboardingPending, completeOnboarding } from "../src/core/setup.js";
import { resetDb, makeUser } from "./helpers/seed.js";

beforeEach(() => {
  resetDb();
  makeUser("u1", "admin");
  makeUser("u2", "admin");
});

describe("the setup guide's flag", () => {
  it("is pending on a fresh install", () => {
    expect(onboardingPending()).toBe(true);
  });

  it("stops being pending once the guide is finished or skipped", () => {
    completeOnboarding("u1");
    expect(onboardingPending()).toBe(false);
  });

  // Skipping has to be as final as finishing. An admin who wants to look around first
  // and is asked again on every sign-in has been given a nag, not a guide.
  it("stays done for the next administrator too", () => {
    completeOnboarding("u1");
    expect(onboardingPending()).toBe(false);

    // A second admin joining later has nothing to set up — storage, mail and the
    // default theme are install-wide and someone has already answered them.
    completeOnboarding("u2");
    expect(onboardingPending()).toBe(false);
  });

  it("records who closed it, for the activity trail", () => {
    completeOnboarding("u2");
    const row = db.prepare("SELECT updated_by, value FROM app_settings WHERE key = 'onboarding_completed_at'")
      .get() as { updated_by: string; value: string };
    expect(row.updated_by).toBe("u2");
    expect(row.value).not.toBe("");
  });
});
