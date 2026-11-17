// The control panel's strings are not in the language bundles everyone downloads:
// they load the first time something asks for one of their namespaces (i18n.ts).
import { afterAll, describe, expect, it } from "vitest";
import i18n, { CONTROL_NAMESPACES, setAppLanguage } from "../src/i18n";
import en from "../src/locales/en";
import enControlPanel from "../src/locales/en/control-panel";
import ru from "../src/locales/ru";
import ruControlPanel from "../src/locales/ru/control-panel";

afterAll(async () => {
  await setAppLanguage("en");
});

describe("the control panel's strings", () => {
  it("are left out of the bundles loaded at start, and are all in their own", () => {
    for (const ns of CONTROL_NAMESPACES) {
      expect(Object.keys(en), ns).not.toContain(ns);
      expect(Object.keys(ru), ns).not.toContain(ns);
    }
    expect(Object.keys(enControlPanel).sort()).toEqual([...CONTROL_NAMESPACES].sort());
    expect(Object.keys(ruControlPanel).sort()).toEqual([...CONTROL_NAMESPACES].sort());
  });

  it("come in another language when asked for after switching to it", async () => {
    await setAppLanguage("ru");
    await i18n.loadNamespaces("controlAdmin");
    expect(i18n.hasResourceBundle("ru", "controlAdmin")).toBe(true);
    expect(i18n.t("controlAdmin:opds.title")).toBe("Доступ для читалок");
    // All three arrive together, whichever was asked for.
    expect(i18n.hasResourceBundle("ru", "controlDash")).toBe(true);
    expect(i18n.hasResourceBundle("ru", "control")).toBe(true);
  });

  it("read in English again after switching back", async () => {
    await setAppLanguage("en");
    expect(i18n.t("controlAdmin:opds.title")).toBe("Reader access");
  });
});
