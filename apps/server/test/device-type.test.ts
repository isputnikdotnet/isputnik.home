// What the Devices page counts by. Deliberately shallow — a household wants
// "two displays, three phones", not a user-agent parser — so these pin the few
// distinctions that have to hold, including the one that is easy to get wrong:
// an Android tablet and an Android phone differ only by the word "Mobile".
import { describe, expect, it } from "vitest";
import { deviceType } from "../src/core/device-link.js";

const AGENTS = {
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  ipad: "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/604.1",
  androidPhone: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36",
  androidTablet: "Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  linux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
};

describe("deviceType", () => {
  it("calls a linked session a display, whatever it says it is", () => {
    expect(deviceType(AGENTS.windows, "device")).toBe("display");
    expect(deviceType(null, "device")).toBe("display");
  });

  it("tells a phone from a tablet", () => {
    expect(deviceType(AGENTS.iphone)).toBe("phone");
    expect(deviceType(AGENTS.androidPhone)).toBe("phone");
    expect(deviceType(AGENTS.ipad)).toBe("tablet");
    // The Android tablet's only tell is the missing "Mobile".
    expect(deviceType(AGENTS.androidTablet)).toBe("tablet");
  });

  it("groups the desktop platforms as computers", () => {
    expect(deviceType(AGENTS.windows)).toBe("computer");
    expect(deviceType(AGENTS.mac)).toBe("computer");
    expect(deviceType(AGENTS.linux)).toBe("computer");
  });

  it("says unknown rather than guessing", () => {
    expect(deviceType(null)).toBe("unknown");
    expect(deviceType("")).toBe("unknown");
    expect(deviceType("curl/8.4.0")).toBe("unknown");
  });
});
