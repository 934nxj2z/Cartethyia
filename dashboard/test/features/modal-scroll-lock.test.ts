import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { acquireBodyScrollLock } from "../../src/hooks/use-modal-focus";

test("overlapping modal scroll locks restore body overflow after the last release", () => {
  const window = new Window();
  const body = window.document.body;
  body.style.overflow = "clip";

  const releaseFirst = acquireBodyScrollLock(body);
  const releaseSecond = acquireBodyScrollLock(body);
  expect(body.style.overflow).toBe("hidden");

  releaseFirst();
  expect(body.style.overflow).toBe("hidden");

  releaseSecond();
  expect(body.style.overflow).toBe("clip");

  releaseSecond();
  expect(body.style.overflow).toBe("clip");
});
