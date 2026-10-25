
import {
  describe,
  it,
  expect,
} from "vitest";

import {
  buildVerdictTwiml,
} from "../src/telephony/callActions.js";

const protectedNumber = "+19253917004";

describe("Twilio call actions", () => {
  it("forwards GREEN calls to the protected number", () => {
    const xml = buildVerdictTwiml(
      "GREEN",
      protectedNumber
    );

    expect(xml).toContain("<Dial>");
    expect(xml).toContain(protectedNumber);
    expect(xml).toContain("Connecting you now");
    expect(xml).not.toContain("<Hangup");
  });

  it("does not forward YELLOW calls", () => {
    const xml = buildVerdictTwiml(
      "YELLOW",
      protectedNumber
    );

    expect(xml).toContain("<Hangup");
    expect(xml).not.toContain("<Dial>");
    expect(xml).not.toContain(protectedNumber);
  });

  it("does not forward RED calls", () => {
    const xml = buildVerdictTwiml(
      "RED",
      protectedNumber
    );

    expect(xml).toContain("<Hangup");
    expect(xml).not.toContain("<Dial>");
    expect(xml).not.toContain(protectedNumber);
  });

  it("rejects an invalid forwarding number", () => {
    expect(() =>
      buildVerdictTwiml("GREEN", "9253917004")
    ).toThrow(
      "PROTECTED_PHONE_NUMBER must use E.164 format."
    );
  });

  it("does not dial when no protected number is provided", () => {
    const xml = buildVerdictTwiml("GREEN");

    expect(xml).toContain("<Hangup");
    expect(xml).not.toContain("<Dial>");
  });
});
