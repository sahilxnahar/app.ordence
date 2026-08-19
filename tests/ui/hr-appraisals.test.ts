import { describe, it, expect } from "vitest";
import { canReadReview, canWriteReview } from "@/lib/hr/visibility";
import type { ViewerRelation } from "@/lib/hr/visibility";

const hr: ViewerRelation = { isSubject: false, isManager: false, isSkipLevel: false, isHr: true };
const subject: ViewerRelation = { isSubject: true, isManager: false, isSkipLevel: false, isHr: false };
const manager: ViewerRelation = { isSubject: false, isManager: true, isSkipLevel: false, isHr: false };
const skipLevel: ViewerRelation = { isSubject: false, isManager: false, isSkipLevel: true, isHr: false };
const peer: ViewerRelation = { isSubject: false, isManager: false, isSkipLevel: false, isHr: false };

describe("Appraisal Visibility (Drafts vs Submitted)", () => {
  it("should not leak draft reviews to other participants", () => {
    // Subject draft should not be visible to manager before submission
    expect(canReadReview("self", manager, { released: false, submitted: false })).toBe(false);
    expect(canReadReview("self", skipLevel, { released: false, submitted: false })).toBe(false);
    
    // Manager draft should not be visible to subject before submission
    expect(canReadReview("manager", subject, { released: false, submitted: false })).toBe(false);
    
    // Skip-level draft should not be visible to manager or subject before submission
    expect(canReadReview("skip_level", manager, { released: false, submitted: false })).toBe(false);
    expect(canReadReview("skip_level", subject, { released: false, submitted: false })).toBe(false);
  });

  it("should allow authors to read their own drafts", () => {
    expect(canReadReview("self", subject, { released: false, submitted: false })).toBe(true);
    expect(canReadReview("manager", manager, { released: false, submitted: false })).toBe(true);
    expect(canReadReview("skip_level", skipLevel, { released: false, submitted: false })).toBe(true);
  });

  it("should allow HR to read all drafts and submitted reviews", () => {
    expect(canReadReview("self", hr, { released: false, submitted: false })).toBe(true);
    expect(canReadReview("manager", hr, { released: false, submitted: false })).toBe(true);
    expect(canReadReview("skip_level", hr, { released: false, submitted: false })).toBe(true);
  });

  it("should show submitted reviews according to rules", () => {
    // Submitted self review is visible to manager and skip-level
    expect(canReadReview("self", manager, { released: false, submitted: true })).toBe(true);
    expect(canReadReview("self", skipLevel, { released: false, submitted: true })).toBe(true);
    
    // Submitted manager review is visible to subject ONLY if released
    expect(canReadReview("manager", subject, { released: false, submitted: true })).toBe(false);
    expect(canReadReview("manager", subject, { released: true, submitted: true })).toBe(true);
    
    // Submitted skip-level review is NEVER visible to manager or subject
    expect(canReadReview("skip_level", manager, { released: false, submitted: true })).toBe(false);
    expect(canReadReview("skip_level", subject, { released: false, submitted: true })).toBe(false);
  });

  it("should prevent peers from seeing anything", () => {
    expect(canReadReview("self", peer, { released: false, submitted: false })).toBe(false);
    expect(canReadReview("manager", peer, { released: false, submitted: false })).toBe(false);
    expect(canReadReview("skip_level", peer, { released: false, submitted: false })).toBe(false);
    
    expect(canReadReview("self", peer, { released: true, submitted: true })).toBe(false);
    expect(canReadReview("manager", peer, { released: true, submitted: true })).toBe(false);
    expect(canReadReview("skip_level", peer, { released: true, submitted: true })).toBe(false);
  });
});
