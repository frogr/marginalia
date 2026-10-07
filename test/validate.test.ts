import { describe, expect, it } from "vitest";
import { checkQuote, normalize, normalizeWithMap, quotePieces, validateAnswer } from "../src/answer/validate.js";

const P1 =
  "“Whenever you feel like criticizing anyone,” he told me, “just remember that all the people in this world haven’t had the advantages that you’ve had.”\n\nHe didn’t say any more—but we’ve always been unusually communicative.";
const P2 = "It was on a dreary night of November that I beheld the accomplishment of my toils.";
const passages = new Map([
  ["gatsby:0:0", P1],
  ["frank:5:0", P2],
]);

describe("normalize", () => {
  it("evens out quotes, dashes, whitespace, underscores and case", () => {
    expect(normalize("“Hello”—said  _she_,\n‘twice’")).toBe("\"hello\"-said she, 'twice'");
    expect(normalize("one -- two — three")).toBe("one-two-three");
  });

  it("maps every normalized character back to the original", () => {
    const s = "A  “b”\n\nc—d";
    const { text, map } = normalizeWithMap(s);
    expect(text).toBe('a "b" c-d');
    expect(map.map((i) => s[i]).join("")).toBe("A “b”\nc—d");
  });
});

describe("quotePieces", () => {
  it("splits on ellipses and trims edge punctuation", () => {
    expect(quotePieces("“Whenever you feel... just remember…that all the people.”")).toEqual([
      "whenever you feel",
      "just remember",
      "that all the people",
    ]);
    expect(quotePieces("one two [...] three four")).toEqual(["one two", "three four"]);
  });
});

describe("checkQuote", () => {
  it("verifies an exact quote and returns its offsets in the original text", () => {
    const r = checkQuote("just remember that all the people in this world", "gatsby:0:0", passages);
    expect(r.verified).toBe(true);
    const p = r.pieces[0];
    expect(P1.slice(p.start, p.end)).toBe("just remember that all the people in this world");
  });

  it("accepts straight quotes, double spaces and other dash styles", () => {
    const r = checkQuote('He didn\'t say any  more -- but we\'ve always', "gatsby:0:0", passages);
    expect(r.verified).toBe(true);
  });

  it("verifies quotes across a paragraph break", () => {
    expect(checkQuote("advantages that you’ve had.” He didn’t say any more", "gatsby:0:0", passages).verified).toBe(true);
  });

  it("verifies each piece of an ellipsis quote, in order", () => {
    const ok = checkQuote("Whenever you feel like criticizing anyone ... the advantages that you’ve had", "gatsby:0:0", passages);
    expect(ok.verified).toBe(true);
    expect(ok.pieces).toHaveLength(2);
    const swapped = checkQuote("the advantages that you’ve had ... Whenever you feel like criticizing anyone", "gatsby:0:0", passages);
    expect(swapped).toMatchObject({ verified: false, reason: "out_of_order" });
  });

  it("rejects a quote with one changed word", () => {
    const r = checkQuote("just remember that all the people in this town", "gatsby:0:0", passages);
    expect(r).toMatchObject({ verified: false, reason: "not_found" });
  });

  it("rejects an invented piece hidden behind an ellipsis", () => {
    const r = checkQuote("Whenever you feel like criticizing anyone ... be kind to strangers", "gatsby:0:0", passages);
    expect(r.verified).toBe(false);
    expect(r.pieces.map((p) => p.found)).toEqual([true, false]);
  });

  it("rejects a real quote that cites the wrong passage, and says where it is", () => {
    const r = checkQuote("a dreary night of November", "gatsby:0:0", passages);
    expect(r).toMatchObject({ verified: false, reason: "not_found", foundIn: "frank:5:0" });
  });

  it("rejects a citation to a passage that was not retrieved", () => {
    expect(checkQuote("a dreary night of November", "other:1:1", passages).reason).toBe("passage_not_retrieved");
  });

  it("rejects quotes too short to mean anything", () => {
    expect(checkQuote("the", "gatsby:0:0", passages).reason).toBe("too_short");
    expect(checkQuote("he told ... me", "gatsby:0:0", passages).reason).toBe("too_short");
    expect(checkQuote(" ... ", "gatsby:0:0", passages).reason).toBe("empty");
  });
});

describe("validateAnswer", () => {
  it("counts verified quotes and uncited claims", () => {
    const v = validateAnswer(
      [
        { text: "His father told him not to judge.", citations: [{ passageId: "gatsby:0:0", quote: "Whenever you feel like criticizing anyone" }] },
        { text: "Victor finished in November.", citations: [{ passageId: "frank:5:0", quote: "a dreary night in November" }] },
        { text: "An uncited claim.", citations: [] },
      ],
      passages,
    );
    expect(v).toMatchObject({ verified: 1, total: 2, uncited: 1 });
  });
});
